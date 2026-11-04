from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qsl, urlencode
from zoneinfo import ZoneInfo

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.config import Settings
from app.models import Order, Payment
from app.services.errors import DomainError
from app.services.payments.http import HttpTransport, UrllibHttpTransport
from app.services.payments.providers import (
    CheckoutResult,
    PaymentNotification,
    QueryResult,
    RefundResult,
)


def _cent_amount(value: object) -> int:
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise DomainError("Alipay amount is invalid", status_code=502) from exc
    cents = decimal * 100
    if cents != cents.to_integral_value() or cents < 0:
        raise DomainError("Alipay amount is invalid", status_code=502)
    return int(cents)


_UNSAFE_SUBJECT_CHARACTERS = re.compile(r"[/=&]+")


class AlipayWebPaymentProvider:
    name = "alipay"

    def __init__(
        self,
        settings: Settings,
        *,
        transport: HttpTransport | None = None,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.settings = settings
        self.transport = transport or UrllibHttpTransport()
        self.sleeper = sleeper
        self.private_key = self._private_key(settings.alipay_private_pkcs_key or "")
        self.public_key = self._public_key(settings.alipay_alipay_public_key or "")

    @staticmethod
    def _private_key(value: str) -> rsa.RSAPrivateKey:
        try:
            if "-----BEGIN" in value:
                key = serialization.load_pem_private_key(value.encode(), password=None)
            else:
                key = serialization.load_der_private_key(
                    base64.b64decode("".join(value.split()), validate=True),
                    password=None,
                )
        except (ValueError, binascii.Error) as exc:
            raise DomainError("Alipay application private key is invalid", status_code=503) from exc
        if not isinstance(key, rsa.RSAPrivateKey):
            raise DomainError("Alipay application private key must be RSA", status_code=503)
        return key

    @staticmethod
    def _public_key(value: str) -> rsa.RSAPublicKey:
        try:
            if "-----BEGIN" in value:
                key = serialization.load_pem_public_key(value.encode())
            else:
                key = serialization.load_der_public_key(
                    base64.b64decode("".join(value.split()), validate=True)
                )
        except (ValueError, binascii.Error) as exc:
            raise DomainError("Alipay public key is invalid", status_code=503) from exc
        if not isinstance(key, rsa.RSAPublicKey):
            raise DomainError("Alipay public key must be RSA", status_code=503)
        return key

    def _sign(self, content: str) -> str:
        return base64.b64encode(
            self.private_key.sign(content.encode(), padding.PKCS1v15(), hashes.SHA256())
        ).decode()

    def _verify(self, content: str, signature: str) -> None:
        try:
            self.public_key.verify(
                base64.b64decode(signature, validate=True),
                content.encode(),
                padding.PKCS1v15(),
                hashes.SHA256(),
            )
        except (InvalidSignature, ValueError) as exc:
            raise DomainError("Alipay signature is invalid", status_code=401) from exc

    @staticmethod
    def _signed_response_content(raw: str, response_key: str) -> str:
        marker = json.dumps(response_key, ensure_ascii=False)
        marker_index = raw.find(marker)
        if marker_index < 0:
            raise DomainError("Alipay response is missing payload", status_code=502)
        start = raw.find("{", raw.find(":", marker_index) + 1)
        if start < 0:
            raise DomainError("Alipay response is invalid", status_code=502)
        depth = 0
        in_string = False
        escaped = False
        for index in range(start, len(raw)):
            char = raw[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return raw[start : index + 1]
        raise DomainError("Alipay response is invalid", status_code=502)

    def _signed_params(
        self,
        method: str,
        biz_content: dict[str, object],
        *,
        include_notify_url: bool = False,
    ) -> dict[str, str]:
        params = {
            "app_id": self.settings.alipay_app_id or "",
            "method": method,
            "format": "JSON",
            "charset": "utf-8",
            "sign_type": "RSA2",
            "timestamp": datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S"),
            "version": "1.0",
            "biz_content": json.dumps(
                biz_content, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            ),
        }
        if include_notify_url:
            params["notify_url"] = self.settings.alipay_notify_url or ""
        content = "&".join(f"{key}={params[key]}" for key in sorted(params))
        params["sign"] = self._sign(content)
        return params

    def _call(
        self,
        method: str,
        biz_content: dict[str, object],
        *,
        allowed_sub_codes: frozenset[str] = frozenset(),
        network_retries: int = 0,
    ) -> dict[str, object]:
        params = self._signed_params(method, biz_content)
        for attempt in range(network_retries + 1):
            try:
                response = self.transport.request(
                    "POST",
                    self.settings.alipay_gateway_url,
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
                        "Accept": "application/json",
                        "User-Agent": "license-center/1.1",
                    },
                    body=urlencode(params).encode(),
                )
                break
            except DomainError as exc:
                if exc.status_code != 503 or attempt >= network_retries:
                    raise
                self.sleeper(0.15 * (2**attempt))
        if not 200 <= response.status_code < 300:
            raise DomainError("Alipay request failed", status_code=502)
        try:
            raw = response.body.decode("utf-8")
            envelope = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DomainError("Alipay returned invalid data", status_code=502) from exc
        response_key = method.replace(".", "_") + "_response"
        signed_content = self._signed_response_content(raw, response_key)
        signature = envelope.get("sign")
        if not isinstance(signature, str):
            raise DomainError("Alipay response signature is missing", status_code=502)
        self._verify(signed_content, signature)
        result = json.loads(signed_content)
        if result.get("code") != "10000":
            if str(result.get("sub_code") or "") in allowed_sub_codes:
                return result
            raise DomainError("Alipay rejected the request", status_code=502)
        return result

    @staticmethod
    def _amount(amount_cent: int) -> str:
        return f"{Decimal(amount_cent) / Decimal(100):.2f}"

    @staticmethod
    def _subject(value: object) -> str:
        compact = " ".join(str(value or "").split())
        compact = " ".join(_UNSAFE_SUBJECT_CHARACTERS.sub(" ", compact).split())
        return (compact or "软件积分套餐")[:256]

    @staticmethod
    def _time_expire(value: datetime) -> str:
        aware = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
        return aware.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")

    def create_checkout(self, order: Order) -> CheckoutResult:
        params = self._signed_params(
            "alipay.trade.page.pay",
            {
                "out_trade_no": order.order_no,
                "total_amount": self._amount(order.amount_cent),
                "subject": self._subject(order.plan_name_snapshot),
                "product_code": "FAST_INSTANT_TRADE_PAY",
                # Computer website pay supports an embedded cashier mode.  The
                # checkout page rendered by Alipay owns the payment QR code;
                # clients must embed this signed page instead of encoding the
                # long gateway URL into a second, non-payment QR code.
                "qr_pay_mode": "4",
                "qrcode_width": 196,
                "time_expire": self._time_expire(order.expires_at),
            },
            include_notify_url=True,
        )
        separator = "&" if "?" in self.settings.alipay_gateway_url else "?"
        checkout_url = f"{self.settings.alipay_gateway_url}{separator}{urlencode(params)}"
        return CheckoutResult(
            provider_payment_no=order.order_no,
            code_url=checkout_url,
            qr_code_url=None,
            safe_payload={
                "checkout_type": "embedded_web_cashier",
                "checkout_url": checkout_url,
            },
        )

    def query(self, order: Order, payment: Payment) -> QueryResult:
        del payment
        result = self._call(
            "alipay.trade.query",
            {"out_trade_no": order.order_no},
            allowed_sub_codes=frozenset({"ACQ.TRADE_NOT_EXIST"}),
            network_retries=2,
        )
        if result.get("code") != "10000":
            return QueryResult(status="pending")
        status = str(result.get("trade_status", ""))
        if status not in {"TRADE_SUCCESS", "TRADE_FINISHED"}:
            return QueryResult(status="pending")
        if result.get("out_trade_no") != order.order_no:
            raise DomainError("Alipay query order does not match", status_code=409)
        for field, expected in (
            ("app_id", self.settings.alipay_app_id),
            ("seller_id", self.settings.alipay_seller_id),
        ):
            if field in result and result[field] != expected:
                raise DomainError("Alipay query merchant does not match", status_code=409)
        amount_cent = _cent_amount(result.get("total_amount"))
        if amount_cent != order.amount_cent or order.currency != "CNY":
            raise DomainError("Alipay query amount or currency does not match", status_code=409)
        trade_no = str(result.get("trade_no") or order.order_no)
        return QueryResult(
            status="succeeded",
            event_id=f"query:{trade_no}",
            provider_payment_no=trade_no,
            amount_cent=amount_cent,
            currency="CNY",
        )

    def refund(
        self, order: Order, payment: Payment, amount_cent: int, refund_no: str
    ) -> RefundResult:
        del payment
        result = self._call(
            "alipay.trade.refund",
            {
                "out_trade_no": order.order_no,
                "refund_amount": self._amount(amount_cent),
                "out_request_no": refund_no,
            },
        )
        provider_refund_no = str(result.get("trade_no") or refund_no)
        if str(result.get("fund_change", "N")) == "Y":
            return RefundResult(
                status="succeeded",
                provider_refund_no=provider_refund_no,
            )
        # Alipay returns fund_change=N for an idempotent replay after the money was
        # already refunded. Query the same out_request_no before changing local state.
        query = self._call(
            "alipay.trade.fastpay.refund.query",
            {
                "out_trade_no": order.order_no,
                "out_request_no": refund_no,
            },
            network_retries=2,
        )
        if query.get("out_trade_no") not in {None, order.order_no}:
            raise DomainError("Alipay refund query order does not match", status_code=409)
        if query.get("out_request_no") not in {None, refund_no}:
            raise DomainError("Alipay refund query request does not match", status_code=409)
        for field, expected in (
            ("app_id", self.settings.alipay_app_id),
            ("seller_id", self.settings.alipay_seller_id),
        ):
            if field in query and query[field] != expected:
                raise DomainError("Alipay refund query merchant does not match", status_code=409)
        status = str(query.get("refund_status", "")).upper()
        # Official refund-query responses have no top-level success flag: code=10000
        # means the query ran, and the presence of refund data means the refund exists.
        if query.get("refund_amount") is not None or status == "REFUND_SUCCESS":
            refund_amount = _cent_amount(query.get("refund_amount"))
            if refund_amount != amount_cent or order.currency != "CNY":
                raise DomainError(
                    "Alipay refund query amount or currency does not match",
                    status_code=409,
                )
            if (
                query.get("total_amount") is not None
                and _cent_amount(query.get("total_amount")) != order.amount_cent
            ):
                raise DomainError(
                    "Alipay refund query original amount does not match",
                    status_code=409,
                )
            return RefundResult(
                status="succeeded",
                provider_refund_no=str(query.get("trade_no") or provider_refund_no),
            )
        if status in {"REFUND_CLOSED", "REFUND_FAILED", "REFUND_FAIL"}:
            return RefundResult(
                status="failed",
                provider_refund_no=str(query.get("trade_no") or provider_refund_no),
            )
        return RefundResult(
            status="pending",
            provider_refund_no=str(query.get("trade_no") or provider_refund_no),
        )

    def parse_notification(self, headers: Mapping[str, str], body: bytes) -> PaymentNotification:
        del headers
        try:
            pairs = parse_qsl(body.decode("utf-8"), keep_blank_values=True)
        except UnicodeDecodeError as exc:
            raise DomainError("Alipay callback encoding is invalid", status_code=400) from exc
        params = dict(pairs)
        signature = params.pop("sign", None)
        params.pop("sign_type", None)
        if not signature:
            raise DomainError("Alipay callback signature is missing", status_code=401)
        content = "&".join(f"{key}={params[key]}" for key in sorted(params))
        self._verify(content, signature)
        if params.get("app_id") != self.settings.alipay_app_id:
            raise DomainError("Alipay callback app does not match", status_code=409)
        if (
            self.settings.alipay_seller_id
            and params.get("seller_id") != self.settings.alipay_seller_id
        ):
            raise DomainError("Alipay callback seller does not match", status_code=409)
        order_no = params.get("out_trade_no")
        trade_no = params.get("trade_no")
        trade_status = params.get("trade_status", "")
        if not order_no or not trade_no:
            raise DomainError("Alipay callback transaction is invalid", status_code=400)
        event_id = params.get("notify_id") or f"{trade_no}:{trade_status}"
        return PaymentNotification(
            order_no=order_no,
            event_id=event_id,
            provider_payment_no=trade_no,
            status=(
                "succeeded" if trade_status in {"TRADE_SUCCESS", "TRADE_FINISHED"} else "pending"
            ),
            amount_cent=_cent_amount(params.get("total_amount")),
            currency="CNY",
            payload_fingerprint=hashlib.sha256(body).hexdigest(),
        )

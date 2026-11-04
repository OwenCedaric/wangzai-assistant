from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from collections.abc import Mapping
from urllib.parse import quote, urlencode

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import Settings
from app.models import Order, Payment
from app.models.base import as_utc
from app.services.errors import DomainError
from app.services.payments.http import HttpTransport, UrllibHttpTransport
from app.services.payments.providers import (
    CheckoutResult,
    PaymentNotification,
    QueryResult,
    RefundNotification,
    RefundResult,
)


class WechatNativePaymentProvider:
    name = "wechat"

    def __init__(self, settings: Settings, *, transport: HttpTransport | None = None) -> None:
        self.settings = settings
        self.transport = transport or UrllibHttpTransport()
        self.private_key = self._load_private_key(settings.wechat_private_key or "")
        self.platform_key, self.platform_serial = self._load_platform_key(
            settings.wechat_platform_certificate or ""
        )

    @staticmethod
    def _load_private_key(value: str) -> rsa.RSAPrivateKey:
        try:
            key = serialization.load_pem_private_key(value.encode(), password=None)
        except ValueError as exc:
            raise DomainError("WeChat merchant private key is invalid", status_code=503) from exc
        if not isinstance(key, rsa.RSAPrivateKey):
            raise DomainError("WeChat merchant private key must be RSA", status_code=503)
        return key

    @staticmethod
    def _load_platform_key(value: str) -> tuple[rsa.RSAPublicKey, str | None]:
        data = value.encode()
        try:
            certificate = x509.load_pem_x509_certificate(data)
            key = certificate.public_key()
            serial = format(certificate.serial_number, "X")
        except ValueError:
            try:
                key = serialization.load_pem_public_key(data)
                serial = None
            except ValueError as exc:
                raise DomainError(
                    "WeChat platform certificate is invalid", status_code=503
                ) from exc
        if not isinstance(key, rsa.RSAPublicKey):
            raise DomainError("WeChat platform key must be RSA", status_code=503)
        return key, serial

    def _authorization(self, method: str, path_query: str, body: str) -> str:
        timestamp = str(int(time.time()))
        nonce = secrets.token_hex(16)
        message = f"{method}\n{path_query}\n{timestamp}\n{nonce}\n{body}\n".encode()
        signature = base64.b64encode(
            self.private_key.sign(message, padding.PKCS1v15(), hashes.SHA256())
        ).decode()
        return (
            "WECHATPAY2-SHA256-RSA2048 "
            f'mchid="{self.settings.wechat_mch_id}",'
            f'nonce_str="{nonce}",timestamp="{timestamp}",'
            f'serial_no="{self.settings.wechat_merchant_serial_no}",'
            f'signature="{signature}"'
        )

    def _request(
        self, method: str, path: str, payload: dict[str, object] | None = None
    ) -> dict[str, object]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) if payload else ""
        url = f"{self.settings.wechat_api_base_url.rstrip('/')}{path}"
        response = self.transport.request(
            method,
            url,
            headers={
                "Authorization": self._authorization(method, path, body),
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "license-center/1.1",
            },
            body=body.encode() if body else None,
        )
        if not 200 <= response.status_code < 300:
            raise DomainError("WeChat payment request failed", status_code=502)
        self._verify_signature(response.headers, response.body)
        try:
            result = json.loads(response.body)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise DomainError("WeChat payment returned invalid data", status_code=502) from exc
        if not isinstance(result, dict):
            raise DomainError("WeChat payment returned invalid data", status_code=502)
        return result

    def _verify_signature(self, headers: Mapping[str, str], body: bytes) -> None:
        normalized = {key.lower(): value for key, value in headers.items()}
        timestamp = normalized.get("wechatpay-timestamp", "")
        nonce = normalized.get("wechatpay-nonce", "")
        signature = normalized.get("wechatpay-signature", "")
        serial = normalized.get("wechatpay-serial", "").upper()
        try:
            timestamp_int = int(timestamp)
        except ValueError as exc:
            raise DomainError("WeChat signature timestamp is invalid", status_code=502) from exc
        if abs(int(time.time()) - timestamp_int) > 300:
            raise DomainError("WeChat signature is outside replay window", status_code=502)
        if self.platform_serial and serial != self.platform_serial:
            raise DomainError("WeChat certificate serial does not match", status_code=502)
        message = timestamp.encode() + b"\n" + nonce.encode() + b"\n" + body + b"\n"
        try:
            self.platform_key.verify(
                base64.b64decode(signature, validate=True),
                message,
                padding.PKCS1v15(),
                hashes.SHA256(),
            )
        except (InvalidSignature, ValueError) as exc:
            raise DomainError("WeChat signature is invalid", status_code=502) from exc

    def _decrypt_resource(self, body: bytes) -> dict[str, object]:
        try:
            envelope = json.loads(body)
            resource = envelope["resource"]
            ciphertext = base64.b64decode(resource["ciphertext"], validate=True)
            key = (self.settings.wechat_api_v3_key or "").encode()
            plaintext = AESGCM(key).decrypt(
                str(resource["nonce"]).encode(),
                ciphertext,
                str(resource.get("associated_data") or "").encode(),
            )
            result = json.loads(plaintext)
        except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise DomainError("WeChat callback resource is invalid", status_code=400) from exc
        if not isinstance(result, dict):
            raise DomainError("WeChat callback resource is invalid", status_code=400)
        return result

    def create_checkout(self, order: Order) -> CheckoutResult:
        expires_at = as_utc(order.expires_at)
        result = self._request(
            "POST",
            "/v3/pay/transactions/native",
            {
                "appid": self.settings.wechat_app_id,
                "mchid": self.settings.wechat_mch_id,
                "description": order.plan_name_snapshot[:127],
                "out_trade_no": order.order_no,
                "notify_url": self.settings.wechat_notify_url,
                "time_expire": expires_at.isoformat(timespec="seconds").replace("+00:00", "Z"),
                "amount": {"total": order.amount_cent, "currency": order.currency},
            },
        )
        code_url = result.get("code_url")
        if not isinstance(code_url, str) or not code_url:
            raise DomainError("WeChat payment did not return code_url", status_code=502)
        return CheckoutResult(
            provider_payment_no=order.order_no,
            code_url=code_url,
            qr_code_url=code_url,
            safe_payload={"code_url": code_url},
        )

    def query(self, order: Order, payment: Payment) -> QueryResult:
        del payment
        query = urlencode({"mchid": self.settings.wechat_mch_id})
        path = f"/v3/pay/transactions/out-trade-no/{quote(order.order_no)}?{query}"
        result = self._request("GET", path)
        state = str(result.get("trade_state", ""))
        if state != "SUCCESS":
            return QueryResult(status="pending")
        if result.get("out_trade_no") != order.order_no:
            raise DomainError("WeChat query order does not match", status_code=409)
        for field, expected in (
            ("mchid", self.settings.wechat_mch_id),
            ("appid", self.settings.wechat_app_id),
        ):
            if field in result and result[field] != expected:
                raise DomainError("WeChat query merchant does not match", status_code=409)
        amount = result.get("amount") if isinstance(result.get("amount"), dict) else {}
        total = amount.get("total") if isinstance(amount, dict) else None
        currency = amount.get("currency") if isinstance(amount, dict) else None
        transaction_id = result.get("transaction_id")
        if not isinstance(total, int) or not isinstance(currency, str):
            raise DomainError("WeChat query amount is invalid", status_code=502)
        if total != order.amount_cent or currency != order.currency:
            raise DomainError("WeChat query amount or currency does not match", status_code=409)
        provider_no = str(transaction_id or order.order_no)
        return QueryResult(
            status="succeeded",
            event_id=f"query:{provider_no}",
            provider_payment_no=provider_no,
            amount_cent=total,
            currency=currency,
        )

    def refund(
        self, order: Order, payment: Payment, amount_cent: int, refund_no: str
    ) -> RefundResult:
        payload: dict[str, object] = {
            "out_trade_no": order.order_no,
            "out_refund_no": refund_no,
            "amount": {
                "refund": amount_cent,
                "total": payment.amount_cent,
                "currency": payment.currency,
            },
        }
        if self.settings.wechat_refund_notify_url:
            payload["notify_url"] = self.settings.wechat_refund_notify_url
        result = self._request("POST", "/v3/refund/domestic/refunds", payload)
        status = str(result.get("status", ""))
        refund_id = result.get("refund_id") or refund_no
        if status == "SUCCESS":
            normalized = "succeeded"
        elif status in {"PROCESSING", "ABNORMAL"}:
            normalized = "pending"
        else:
            normalized = "failed"
        return RefundResult(status=normalized, provider_refund_no=str(refund_id))

    def parse_notification(self, headers: Mapping[str, str], body: bytes) -> PaymentNotification:
        try:
            self._verify_signature(headers, body)
        except DomainError as exc:
            raise DomainError("WeChat callback signature is invalid", status_code=401) from exc
        transaction = self._decrypt_resource(body)
        if (
            transaction.get("mchid") != self.settings.wechat_mch_id
            or transaction.get("appid") != self.settings.wechat_app_id
        ):
            raise DomainError("WeChat callback merchant does not match", status_code=409)
        amount = transaction.get("amount")
        if not isinstance(amount, dict):
            raise DomainError("WeChat callback amount is invalid", status_code=400)
        total = amount.get("total")
        currency = amount.get("currency")
        order_no = transaction.get("out_trade_no")
        transaction_id = transaction.get("transaction_id")
        if not all((isinstance(total, int), isinstance(currency, str), order_no, transaction_id)):
            raise DomainError("WeChat callback transaction is invalid", status_code=400)
        return PaymentNotification(
            order_no=str(order_no),
            event_id=f"{transaction_id}:{transaction.get('trade_state', '')}",
            provider_payment_no=str(transaction_id),
            status=("succeeded" if transaction.get("trade_state") == "SUCCESS" else "pending"),
            amount_cent=total,
            currency=currency,
            payload_fingerprint=hashlib.sha256(body).hexdigest(),
        )

    def parse_refund_notification(
        self, headers: Mapping[str, str], body: bytes
    ) -> RefundNotification:
        try:
            self._verify_signature(headers, body)
        except DomainError as exc:
            raise DomainError(
                "WeChat refund callback signature is invalid", status_code=401
            ) from exc
        refund = self._decrypt_resource(body)
        if refund.get("mchid") != self.settings.wechat_mch_id:
            raise DomainError("WeChat refund merchant does not match", status_code=409)
        amount = refund.get("amount")
        if not isinstance(amount, dict):
            raise DomainError("WeChat refund amount is invalid", status_code=400)
        refund_amount = amount.get("refund")
        total_amount = amount.get("total")
        currency = amount.get("currency") or "CNY"
        order_no = refund.get("out_trade_no")
        refund_no = refund.get("out_refund_no")
        refund_id = refund.get("refund_id") or refund.get("out_refund_no")
        status = str(refund.get("refund_status", ""))
        if not all(
            (
                isinstance(refund_amount, int),
                isinstance(total_amount, int),
                isinstance(currency, str),
                order_no,
                refund_no,
                refund_id,
            )
        ):
            raise DomainError("WeChat refund transaction is invalid", status_code=400)
        return RefundNotification(
            order_no=str(order_no),
            refund_no=str(refund_no),
            event_id=f"refund:{refund_id}:{status}",
            provider_refund_no=str(refund_id),
            status=(
                "succeeded"
                if status == "SUCCESS"
                else "pending"
                if status == "PROCESSING"
                else "failed"
            ),
            refund_amount_cent=refund_amount,
            total_amount_cent=total_amount,
            currency=currency,
            payload_fingerprint=hashlib.sha256(body).hexdigest(),
        )

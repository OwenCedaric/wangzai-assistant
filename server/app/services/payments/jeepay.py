from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from urllib.parse import parse_qsl

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

_PAYMENT_WAY_CODES = {
    "alipay": {"ALI_QR", "ALI_PC"},
    "wechat": {"WX_NATIVE"},
}


def _string_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def jeepay_signature(params: Mapping[str, object], api_key: str) -> str:
    """Build the exact MD5 signature required by Jeepay's merchant API."""
    items = sorted(
        (
            (key, _string_value(value))
            for key, value in params.items()
            if key != "sign" and value is not None and _string_value(value) != ""
        ),
        key=lambda item: item[0].casefold(),
    )
    content = "&".join(f"{key}={value}" for key, value in items)
    signed = f"{content}&key={api_key}" if content else f"key={api_key}"
    # Jeepay's public merchant protocol is fixed to MD5. The connection itself
    # must use HTTPS in staging/production; compare_digest is used below.
    return hashlib.md5(signed.encode("utf-8"), usedforsecurity=False).hexdigest().upper()


def _require_string(data: Mapping[str, object], field: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value:
        raise DomainError(f"Jeepay response is missing {field}", status_code=502)
    return value


def _require_integer(data: Mapping[str, object], field: str) -> int:
    value = data.get(field)
    if isinstance(value, bool):
        raise DomainError(f"Jeepay response has invalid {field}", status_code=502)
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise DomainError(f"Jeepay response has invalid {field}", status_code=502) from exc


def _callback_params(body: bytes) -> dict[str, str]:
    if len(body) > 64 * 1024:
        raise DomainError("Jeepay callback is too large", status_code=413)
    try:
        pairs = parse_qsl(body.decode("utf-8"), keep_blank_values=True, strict_parsing=True)
    except (UnicodeDecodeError, ValueError) as exc:
        raise DomainError("Jeepay callback encoding is invalid", status_code=400) from exc
    params: dict[str, str] = {}
    for key, value in pairs:
        if key in params:
            raise DomainError("Jeepay callback contains duplicate fields", status_code=400)
        params[key] = value
    return params


def _verify_callback(
    settings: Settings,
    headers: Mapping[str, str],
    body: bytes,
    *,
    require_request_time: bool = True,
) -> dict[str, str]:
    content_type = next(
        (value for key, value in headers.items() if key.lower() == "content-type"),
        "",
    )
    if content_type and not content_type.lower().startswith(
        "application/x-www-form-urlencoded"
    ):
        raise DomainError("Jeepay callback content type is invalid", status_code=415)
    params = _callback_params(body)
    signature = params.pop("sign", "")
    if not signature or len(signature) != 32:
        raise DomainError("Jeepay callback signature is missing", status_code=401)
    expected = jeepay_signature(params, settings.jeepay_api_key or "")
    if not hmac.compare_digest(signature.upper(), expected):
        raise DomainError("Jeepay callback signature is invalid", status_code=401)
    if params.get("mchNo") != settings.jeepay_mch_no:
        raise DomainError("Jeepay callback merchant does not match", status_code=409)
    if params.get("appId") != settings.jeepay_app_id:
        raise DomainError("Jeepay callback application does not match", status_code=409)
    request_time_value = params.get("reqTime", "")
    if request_time_value:
        try:
            request_time = int(request_time_value)
        except ValueError as exc:
            raise DomainError("Jeepay callback timestamp is invalid", status_code=401) from exc
        request_seconds = (
            request_time / 1000 if request_time >= 100_000_000_000 else request_time
        )
        if abs(time.time() - request_seconds) > settings.jeepay_callback_max_age_seconds:
            raise DomainError("Jeepay callback is outside the replay window", status_code=401)
    elif require_request_time:
        raise DomainError("Jeepay callback timestamp is invalid", status_code=401)
    return params


def _callback_provider(settings: Settings, params: Mapping[str, str]) -> str:
    provider = params.get("extParam", "")
    if provider not in _PAYMENT_WAY_CODES:
        raise DomainError("Jeepay callback channel is invalid", status_code=409)
    way_code = params.get("wayCode")
    interface_code = params.get("ifCode")
    expected_way_code = (
        settings.jeepay_alipay_way_code
        if provider == "alipay"
        else settings.jeepay_wechat_way_code
    )
    expected_interface = "alipay" if provider == "alipay" else "wxpay"
    if way_code != expected_way_code or interface_code != expected_interface:
        raise DomainError("Jeepay callback payment channel does not match", status_code=409)
    return provider


def parse_jeepay_payment_notification(
    settings: Settings,
    headers: Mapping[str, str],
    body: bytes,
) -> tuple[str, PaymentNotification]:
    params = _verify_callback(settings, headers, body)
    provider = _callback_provider(settings, params)
    order_no = params.get("mchOrderNo", "")
    payment_no = params.get("payOrderId", "")
    if not order_no or not payment_no:
        raise DomainError("Jeepay callback transaction is invalid", status_code=400)
    amount_cent = _require_integer(params, "amount")
    state = _require_integer(params, "state")
    currency = params.get("currency", "").upper()
    if amount_cent < 0 or currency != "CNY":
        raise DomainError("Jeepay callback amount or currency is invalid", status_code=409)
    return provider, PaymentNotification(
        order_no=order_no,
        event_id=f"jeepay:payment:{payment_no}:{state}",
        provider_payment_no=payment_no,
        status="succeeded" if state == 2 else "pending",
        amount_cent=amount_cent,
        currency=currency,
        payload_fingerprint=hashlib.sha256(body).hexdigest(),
    )


def parse_jeepay_refund_notification(
    settings: Settings,
    headers: Mapping[str, str],
    body: bytes,
) -> tuple[str, RefundNotification]:
    # Jeepay's official refund callback schema does not contain reqTime or
    # mchOrderNo. Signature and merchant/application checks are still mandatory;
    # refund_no and payOrderId are reconciled with the local locked ledger below.
    params = _verify_callback(
        settings,
        headers,
        body,
        require_request_time=False,
    )
    provider = params.get("extParam", "")
    if provider not in _PAYMENT_WAY_CODES:
        raise DomainError("Jeepay refund callback channel is invalid", status_code=409)
    order_no = params.get("mchOrderNo") or None
    refund_no = params.get("mchRefundNo", "")
    payment_no = params.get("payOrderId", "")
    provider_refund_no = params.get("refundOrderId", "")
    if not all((refund_no, payment_no, provider_refund_no)):
        raise DomainError("Jeepay refund callback transaction is invalid", status_code=400)
    refund_amount = _require_integer(params, "refundAmount")
    total_amount = _require_integer(params, "payAmount")
    state = _require_integer(params, "state")
    currency = params.get("currency", "").upper()
    if refund_amount <= 0 or total_amount <= 0 or currency != "CNY":
        raise DomainError("Jeepay refund callback amount or currency is invalid", status_code=409)
    status = "succeeded" if state == 2 else "failed" if state in {3, 4} else "pending"
    return provider, RefundNotification(
        order_no=order_no,
        refund_no=refund_no,
        event_id=f"jeepay:refund:{provider_refund_no}:{state}",
        provider_refund_no=provider_refund_no,
        status=status,
        refund_amount_cent=refund_amount,
        total_amount_cent=total_amount,
        currency=currency,
        payload_fingerprint=hashlib.sha256(body).hexdigest(),
        provider_payment_no=payment_no,
    )


class JeepayPaymentProvider:
    def __init__(
        self,
        settings: Settings,
        name: str,
        *,
        transport: HttpTransport | None = None,
    ) -> None:
        if name not in _PAYMENT_WAY_CODES:
            raise DomainError("Jeepay payment channel is unsupported", status_code=503)
        self.settings = settings
        self.name = name
        self.transport = transport or UrllibHttpTransport()
        self.way_code = (
            settings.jeepay_alipay_way_code
            if name == "alipay"
            else settings.jeepay_wechat_way_code
        )

    def _request(self, path: str, values: dict[str, object]) -> dict[str, object]:
        payload = {
            "mchNo": self.settings.jeepay_mch_no or "",
            "appId": self.settings.jeepay_app_id or "",
            "reqTime": int(time.time() * 1000),
            "version": "1.0",
            "signType": "MD5",
            **values,
        }
        payload["sign"] = jeepay_signature(payload, self.settings.jeepay_api_key or "")
        response = self.transport.request(
            "POST",
            f"{self.settings.jeepay_api_base_url.rstrip('/')}{path}",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json;charset=utf-8",
                "User-Agent": "license-center/1.1",
            },
            body=json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8"),
        )
        if not 200 <= response.status_code < 300:
            raise DomainError("Jeepay request failed", status_code=502)
        try:
            envelope = json.loads(response.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DomainError("Jeepay returned invalid data", status_code=502) from exc
        if not isinstance(envelope, dict) or envelope.get("code") != 0:
            raise DomainError("Jeepay rejected the request", status_code=502)
        data = envelope.get("data")
        signature = envelope.get("sign")
        if not isinstance(data, dict) or not isinstance(signature, str):
            raise DomainError("Jeepay response signature is missing", status_code=502)
        expected = jeepay_signature(data, self.settings.jeepay_api_key or "")
        if not hmac.compare_digest(signature.upper(), expected):
            raise DomainError("Jeepay response signature is invalid", status_code=502)
        return data

    def _validate_order_result(self, data: Mapping[str, object], order: Order) -> None:
        if data.get("mchNo") not in {None, self.settings.jeepay_mch_no}:
            raise DomainError("Jeepay response merchant does not match", status_code=409)
        if data.get("appId") not in {None, self.settings.jeepay_app_id}:
            raise DomainError("Jeepay response application does not match", status_code=409)
        if data.get("mchOrderNo") != order.order_no:
            raise DomainError("Jeepay response order does not match", status_code=409)
        if data.get("wayCode") not in {None, self.way_code}:
            raise DomainError("Jeepay response channel does not match", status_code=409)

    def create_checkout(self, order: Order) -> CheckoutResult:
        if order.currency != "CNY":
            raise DomainError("Jeepay only supports CNY orders", status_code=409)
        remaining = int((as_utc(order.expires_at) - datetime.now(UTC)).total_seconds())
        if remaining < 1:
            raise DomainError("Order has expired", status_code=409)
        pay_data_type = "payUrl" if self.way_code == "ALI_PC" else "codeUrl"
        data = self._request(
            "/api/pay/unifiedOrder",
            {
                "mchOrderNo": order.order_no,
                "wayCode": self.way_code,
                "amount": order.amount_cent,
                "currency": "cny",
                "clientIp": self.settings.jeepay_client_ip,
                "subject": order.plan_name_snapshot[:64],
                "body": order.plan_name_snapshot[:256],
                "notifyUrl": self.settings.jeepay_notify_url or "",
                "expiredTime": min(remaining, 7200),
                "channelExtra": json.dumps(
                    {"payDataType": pay_data_type},
                    separators=(",", ":"),
                ),
                "extParam": self.name,
                "divisionMode": 0,
            },
        )
        self._validate_order_result(data, order)
        payment_no = _require_string(data, "payOrderId")
        pay_data = _require_string(data, "payData")
        if data.get("payDataType") != pay_data_type:
            raise DomainError("Jeepay returned an unexpected checkout type", status_code=502)
        return CheckoutResult(
            provider_payment_no=payment_no,
            code_url=pay_data,
            qr_code_url=pay_data if pay_data_type == "codeUrl" else None,
            safe_payload={"gateway": "jeepay", "pay_data_type": pay_data_type},
        )

    def query(self, order: Order, payment: Payment) -> QueryResult:
        del payment
        data = self._request("/api/pay/query", {"mchOrderNo": order.order_no})
        self._validate_order_result(data, order)
        state = _require_integer(data, "state")
        if state != 2:
            return QueryResult(status="pending")
        amount_cent = _require_integer(data, "amount")
        currency = _require_string(data, "currency").upper()
        if amount_cent != order.amount_cent or currency != order.currency:
            raise DomainError("Jeepay query amount or currency does not match", status_code=409)
        payment_no = _require_string(data, "payOrderId")
        return QueryResult(
            status="succeeded",
            event_id=f"jeepay:query:{payment_no}:2",
            provider_payment_no=payment_no,
            amount_cent=amount_cent,
            currency=currency,
        )

    def refund(
        self,
        order: Order,
        payment: Payment,
        amount_cent: int,
        refund_no: str,
    ) -> RefundResult:
        data = self._request(
            "/api/refund/refundOrder",
            {
                "payOrderId": payment.provider_payment_no or "",
                "mchOrderNo": order.order_no,
                "mchRefundNo": refund_no,
                "refundAmount": amount_cent,
                "currency": "cny",
                "refundReason": "用户退款",
                "clientIp": self.settings.jeepay_client_ip,
                "notifyUrl": self.settings.jeepay_refund_notify_url or "",
                "extParam": self.name,
            },
        )
        if data.get("mchRefundNo") != refund_no:
            raise DomainError("Jeepay refund order does not match", status_code=409)
        state = _require_integer(data, "state")
        provider_refund_no = _require_string(data, "refundOrderId")
        return RefundResult(
            status="succeeded" if state == 2 else "failed" if state in {3, 4} else "pending",
            provider_refund_no=provider_refund_no,
        )

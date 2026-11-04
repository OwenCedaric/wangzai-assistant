from __future__ import annotations

import json
import time
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import pytest

from app.config import Settings
from app.models import Order, Payment
from app.services.errors import DomainError
from app.services.payments.http import HttpResponse
from app.services.payments.jeepay import (
    JeepayPaymentProvider,
    jeepay_signature,
    parse_jeepay_payment_notification,
    parse_jeepay_refund_notification,
)
from app.services.payments.providers import build_payment_provider, provider_configuration


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "payment_gateway_mode": "jeepay",
        "jeepay_enabled": True,
        "jeepay_alipay_enabled": True,
        "jeepay_wechat_enabled": True,
        "jeepay_api_base_url": "http://127.0.0.1:9216",
        "jeepay_mch_no": "M202608050001",
        "jeepay_app_id": "jeepay-app-20260805",
        "jeepay_api_key": "0123456789abcdef0123456789abcdef",
        "jeepay_notify_url": "https://license.example/api/payments/jeepay/notify",
        "jeepay_refund_notify_url": (
            "https://license.example/api/payments/jeepay/refund-notify"
        ),
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def _order() -> Order:
    return Order(
        id=1,
        order_no="LC202608050000001234",
        user_id=1,
        project_id=1,
        plan_id=1,
        plan_name_snapshot="积分套餐",
        amount_cent=1990,
        currency="CNY",
        commission_rate_bps=0,
        commission_amount_cent=0,
        status="paying",
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )


def _payment(provider: str) -> Payment:
    return Payment(
        id=1,
        order_id=1,
        provider=provider,
        provider_payment_no="P202608050001",
        amount_cent=1990,
        currency="CNY",
        status="pending",
    )


class QueueTransport:
    def __init__(
        self,
        api_key: str,
        responses: list[dict[str, object]],
        *,
        invalid_signature: bool = False,
    ) -> None:
        self.api_key = api_key
        self.responses = responses
        self.invalid_signature = invalid_signature
        self.requests: list[tuple[str, str, Mapping[str, str], bytes | None]] = []

    def request(self, method, url, *, headers, body, timeout=10):
        del timeout
        self.requests.append((method, url, headers, body))
        data = self.responses.pop(0)
        signature = jeepay_signature(data, self.api_key)
        if self.invalid_signature:
            signature = "0" * 32
        envelope = {"code": 0, "msg": "SUCCESS", "data": data, "sign": signature}
        return HttpResponse(200, {}, json.dumps(envelope).encode())


def _callback_body(settings: Settings, values: dict[str, object]) -> bytes:
    params = {
        "mchNo": settings.jeepay_mch_no or "",
        "appId": settings.jeepay_app_id or "",
        "reqTime": int(time.time() * 1000),
        **values,
    }
    params["sign"] = jeepay_signature(params, settings.jeepay_api_key or "")
    return urlencode(params).encode()


def _payment_callback_values(provider: str = "alipay") -> dict[str, object]:
    return {
        "mchOrderNo": _order().order_no,
        "payOrderId": "P202608050001",
        "ifCode": "alipay" if provider == "alipay" else "wxpay",
        "wayCode": "ALI_QR" if provider == "alipay" else "WX_NATIVE",
        "amount": 1990,
        "currency": "cny",
        "state": 2,
        "extParam": provider,
    }


def test_jeepay_signature_matches_documented_canonical_form() -> None:
    params = {"b": 2, "empty": "", "a": "一", "sign": "ignored"}
    expected = __import__("hashlib").md5(
        "a=一&b=2&key=secret".encode(), usedforsecurity=False
    ).hexdigest().upper()
    assert jeepay_signature(params, "secret") == expected


def test_jeepay_provider_configuration_is_fail_closed() -> None:
    settings = _settings(jeepay_enabled=False)
    assert provider_configuration(settings, "wechat") == (
        False,
        False,
        "Jeepay gateway, merchant application, or payment channel is not configured",
    )
    with pytest.raises(DomainError, match="not configured"):
        build_payment_provider(settings, "wechat")


@pytest.mark.parametrize(
    ("provider_name", "override"),
    [
        ("alipay", {"jeepay_alipay_enabled": False}),
        ("wechat", {"jeepay_wechat_enabled": False}),
    ],
)
def test_jeepay_channels_are_enabled_independently(
    provider_name: str,
    override: dict[str, object],
) -> None:
    settings = _settings(**override)
    assert provider_configuration(settings, provider_name)[0:2] == (False, False)
    with pytest.raises(DomainError, match="not configured"):
        build_payment_provider(settings, provider_name)


@pytest.mark.parametrize("provider_name", ["wechat", "alipay"])
def test_build_provider_preserves_public_channel_name(provider_name: str) -> None:
    provider = build_payment_provider(_settings(), provider_name)
    assert isinstance(provider, JeepayPaymentProvider)
    assert provider.name == provider_name


def test_checkout_query_and_refund_use_signed_jeepay_requests() -> None:
    settings = _settings()
    responses = [
        {
            "mchOrderNo": _order().order_no,
            "payOrderId": "P202608050001",
            "orderState": 0,
            "payDataType": "codeUrl",
            "payData": "https://qr.example/alipay/1",
        },
        {
            "mchNo": settings.jeepay_mch_no,
            "appId": settings.jeepay_app_id,
            "mchOrderNo": _order().order_no,
            "payOrderId": "P202608050001",
            "ifCode": "alipay",
            "wayCode": "ALI_QR",
            "amount": 1990,
            "currency": "cny",
            "state": 2,
        },
        {
            "mchRefundNo": "RF202608050000001234",
            "refundOrderId": "R202608050001",
            "state": 1,
        },
    ]
    transport = QueueTransport(settings.jeepay_api_key or "", responses)
    provider = JeepayPaymentProvider(settings, "alipay", transport=transport)

    checkout = provider.create_checkout(_order())
    assert checkout.provider_payment_no == "P202608050001"
    assert checkout.qr_code_url == "https://qr.example/alipay/1"
    request_body = json.loads(transport.requests[0][3] or b"{}")
    request_sign = request_body.pop("sign")
    assert request_sign == jeepay_signature(request_body, settings.jeepay_api_key or "")
    assert request_body["extParam"] == "alipay"
    assert "0123456789abcdef" not in json.dumps(request_body)

    query = provider.query(_order(), _payment("alipay"))
    assert query.status == "succeeded"
    assert query.amount_cent == 1990
    assert query.currency == "CNY"

    refund = provider.refund(
        _order(),
        _payment("alipay"),
        1990,
        "RF202608050000001234",
    )
    assert refund.status == "pending"
    assert refund.provider_refund_no == "R202608050001"
    refund_body = json.loads(transport.requests[2][3] or b"{}")
    assert refund_body["notifyUrl"].endswith("/api/payments/jeepay/refund-notify")
    assert refund_body["extParam"] == "alipay"


def test_query_rejects_tampered_signed_response() -> None:
    settings = _settings()
    transport = QueueTransport(
        settings.jeepay_api_key or "",
        [{"mchOrderNo": _order().order_no, "state": 1}],
        invalid_signature=True,
    )
    provider = JeepayPaymentProvider(settings, "alipay", transport=transport)
    with pytest.raises(DomainError, match="signature is invalid"):
        provider.query(_order(), _payment("alipay"))


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("mchNo", "M-OTHER", "merchant"),
        ("appId", "APP-OTHER", "application"),
        ("mchOrderNo", "LC-OTHER", "order"),
        ("wayCode", "WX_NATIVE", "channel"),
        ("amount", 1, "amount or currency"),
        ("currency", "usd", "amount or currency"),
    ],
)
def test_query_rejects_signed_but_mismatched_identity_or_amount(
    field: str,
    value: object,
    message: str,
) -> None:
    settings = _settings()
    data: dict[str, object] = {
        "mchNo": settings.jeepay_mch_no or "",
        "appId": settings.jeepay_app_id or "",
        "mchOrderNo": _order().order_no,
        "payOrderId": "P202608050001",
        "wayCode": "ALI_QR",
        "amount": 1990,
        "currency": "cny",
        "state": 2,
    }
    data[field] = value
    provider = JeepayPaymentProvider(
        settings,
        "alipay",
        transport=QueueTransport(settings.jeepay_api_key or "", [data]),
    )
    with pytest.raises(DomainError, match=message):
        provider.query(_order(), _payment("alipay"))


@pytest.mark.parametrize("provider_name", ["wechat", "alipay"])
def test_signed_payment_callback_maps_to_public_provider(provider_name: str) -> None:
    settings = _settings()
    body = _callback_body(settings, _payment_callback_values(provider_name))
    provider, notification = parse_jeepay_payment_notification(
        settings,
        {"Content-Type": "application/x-www-form-urlencoded;charset=utf-8"},
        body,
    )
    assert provider == provider_name
    assert notification.order_no == _order().order_no
    assert notification.status == "succeeded"
    assert notification.amount_cent == 1990
    assert notification.currency == "CNY"


def test_signed_refund_callback_is_parsed_without_trusting_client_channel() -> None:
    settings = _settings()
    params: dict[str, object] = {
        "mchNo": settings.jeepay_mch_no or "",
        "appId": settings.jeepay_app_id or "",
        "mchRefundNo": "RF202608050000001234",
        "payOrderId": "P202608050001",
        "refundOrderId": "R202608050001",
        "payAmount": 1990,
        "refundAmount": 1990,
        "currency": "cny",
        "state": 2,
        "extParam": "wechat",
    }
    params["sign"] = jeepay_signature(params, settings.jeepay_api_key or "")
    body = urlencode(params).encode()
    provider, notification = parse_jeepay_refund_notification(settings, {}, body)
    assert provider == "wechat"
    assert notification.order_no is None
    assert notification.provider_payment_no == "P202608050001"
    assert notification.status == "succeeded"
    assert notification.refund_amount_cent == 1990
    assert notification.total_amount_cent == 1990

    params["reqTime"] = int((time.time() - 3600) * 1000)
    params["sign"] = jeepay_signature(params, settings.jeepay_api_key or "")
    with pytest.raises(DomainError, match="replay window"):
        parse_jeepay_refund_notification(settings, {}, urlencode(params).encode())


@pytest.mark.parametrize("mutation_index", range(100))
def test_one_hundred_tampered_callbacks_are_rejected(mutation_index: int) -> None:
    settings = _settings()
    original = _payment_callback_values()
    body = _callback_body(settings, original)
    encoded = bytearray(body)
    # Change one byte before the signature field while keeping the original
    # signature. Every mutation must fail closed, including repeated positions.
    sign_marker = body.index(b"&sign=")
    position = mutation_index % sign_marker
    encoded[position] = 65 if encoded[position] != 65 else 66
    with pytest.raises(DomainError):
        parse_jeepay_payment_notification(settings, {}, bytes(encoded))


def test_callback_rejects_duplicate_fields_old_timestamp_and_wrong_content_type() -> None:
    settings = _settings()
    body = _callback_body(settings, _payment_callback_values())
    with pytest.raises(DomainError, match="duplicate"):
        parse_jeepay_payment_notification(settings, {}, b"state=2&" + body)

    old = _payment_callback_values()
    params = {
        "mchNo": settings.jeepay_mch_no or "",
        "appId": settings.jeepay_app_id or "",
        "reqTime": int((time.time() - 3600) * 1000),
        **old,
    }
    params["sign"] = jeepay_signature(params, settings.jeepay_api_key or "")
    with pytest.raises(DomainError, match="replay window"):
        parse_jeepay_payment_notification(settings, {}, urlencode(params).encode())

    with pytest.raises(DomainError, match="content type"):
        parse_jeepay_payment_notification(
            settings,
            {"content-type": "application/json"},
            body,
        )

from __future__ import annotations

import base64
import json
import time
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import Settings
from app.models import Order, Payment
from app.services.errors import DomainError
from app.services.payments.alipay import AlipayWebPaymentProvider
from app.services.payments.http import HttpResponse
from app.services.payments.providers import build_payment_provider
from app.services.payments.wechat import WechatNativePaymentProvider


def _private_pem(key: rsa.RSAPrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def _private_pkcs1_base64(key: rsa.RSAPrivateKey) -> str:
    return base64.b64encode(
        key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    ).decode()


def _public_pem(key: rsa.RSAPrivateKey) -> str:
    return (
        key.public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )


def _public_der_base64(key: rsa.RSAPrivateKey) -> str:
    return base64.b64encode(
        key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    ).decode()


def _isolated_alipay_settings(**values: object) -> Settings:
    """Keep developer machine payment secret files out of provider unit tests."""
    return Settings(
        alipay_app_id_file=None,
        alipay_private_pkcs_key_file=None,
        alipay_alipay_public_key_file=None,
        alipay_private_key_file=None,
        alipay_public_key_file=None,
        **values,
    )


def _order() -> Order:
    return Order(
        id=1,
        order_no="LC202607110000001234",
        user_id=1,
        project_id=1,
        plan_id=1,
        plan_name_snapshot="专业版",
        amount_cent=29900,
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
        provider_payment_no="provider-order",
        amount_cent=29900,
        currency="CNY",
        status="pending",
    )


class QueueTransport:
    def __init__(self, bodies: list[dict[str, object]], signer: rsa.RSAPrivateKey) -> None:
        self.bodies = bodies
        self.signer = signer
        self.requests: list[tuple[str, str, Mapping[str, str], bytes | None]] = []

    def request(self, method, url, *, headers, body, timeout=10):
        del timeout
        self.requests.append((method, url, headers, body))
        response_body = json.dumps(self.bodies.pop(0)).encode()
        timestamp = str(int(time.time()))
        nonce = "response-nonce"
        message = timestamp.encode() + b"\n" + nonce.encode() + b"\n" + response_body + b"\n"
        signature = base64.b64encode(
            self.signer.sign(message, padding.PKCS1v15(), hashes.SHA256())
        ).decode()
        return HttpResponse(
            200,
            {
                "Wechatpay-Timestamp": timestamp,
                "Wechatpay-Nonce": nonce,
                "Wechatpay-Signature": signature,
                "Wechatpay-Serial": "unused-with-public-key",
            },
            response_body,
        )


def test_wechat_native_checkout_query_refund_and_signed_callback() -> None:
    merchant_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    platform_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    api_key = "0123456789abcdef0123456789abcdef"
    settings = Settings(
        wechat_mch_id="1900000109",
        wechat_app_id="wx-test-app",
        wechat_merchant_serial_no="ABC123",
        wechat_api_v3_key=api_key,
        wechat_private_key=_private_pem(merchant_key),
        wechat_platform_certificate=_public_pem(platform_key),
        wechat_notify_url="https://license.example/payments/wechat/notify",
        wechat_refund_notify_url="https://license.example/payments/wechat/refund-notify",
    )
    transport = QueueTransport(
        [
            {"code_url": "weixin://wxpay/bizpayurl?pr=test"},
            {
                "trade_state": "SUCCESS",
                "transaction_id": "420000001",
                "out_trade_no": _order().order_no,
                "mchid": settings.wechat_mch_id,
                "appid": settings.wechat_app_id,
                "amount": {"total": 29900, "currency": "CNY"},
            },
            {"status": "SUCCESS", "refund_id": "503000001"},
        ],
        platform_key,
    )
    provider = WechatNativePaymentProvider(settings, transport=transport)
    order = _order()
    payment = _payment("wechat")

    checkout = provider.create_checkout(order)
    assert checkout.code_url.startswith("weixin://")
    method, _, headers, raw_body = transport.requests[0]
    assert method == "POST"
    assert headers["Authorization"].startswith("WECHATPAY2-SHA256-RSA2048")
    assert json.loads(raw_body)["amount"] == {"total": 29900, "currency": "CNY"}

    queried = provider.query(order, payment)
    assert queried.status == "succeeded"
    assert queried.provider_payment_no == "420000001"
    assert queried.amount_cent == 29900
    refund_no = "RF202607110000000001"
    refunded = provider.refund(order, payment, 29900, refund_no)
    assert refunded.status == "succeeded"
    assert json.loads(transport.requests[2][3])["out_refund_no"] == refund_no

    transaction = {
        "mchid": settings.wechat_mch_id,
        "appid": settings.wechat_app_id,
        "out_trade_no": order.order_no,
        "transaction_id": "420000001",
        "trade_state": "SUCCESS",
        "amount": {"total": 29900, "currency": "CNY"},
    }
    resource_nonce = "notify-nonce"
    associated = "transaction"
    ciphertext = AESGCM(api_key.encode()).encrypt(
        resource_nonce.encode(),
        json.dumps(transaction, separators=(",", ":")).encode(),
        associated.encode(),
    )
    body = json.dumps(
        {
            "id": "event-id",
            "resource": {
                "ciphertext": base64.b64encode(ciphertext).decode(),
                "nonce": resource_nonce,
                "associated_data": associated,
            },
        },
        separators=(",", ":"),
    ).encode()
    timestamp = str(int(time.time()))
    nonce = "header-nonce"
    message = timestamp.encode() + b"\n" + nonce.encode() + b"\n" + body + b"\n"
    signature = base64.b64encode(
        platform_key.sign(message, padding.PKCS1v15(), hashes.SHA256())
    ).decode()
    notification = provider.parse_notification(
        {
            "Wechatpay-Timestamp": timestamp,
            "Wechatpay-Nonce": nonce,
            "Wechatpay-Signature": signature,
            "Wechatpay-Serial": "unused-with-public-key",
        },
        body,
    )
    assert notification.status == "succeeded"
    assert notification.order_no == order.order_no
    assert notification.amount_cent == 29900

    refund_resource = {
        "mchid": settings.wechat_mch_id,
        "out_trade_no": order.order_no,
        "out_refund_no": refund_no,
        "refund_id": "503000001",
        "refund_status": "SUCCESS",
        "amount": {"total": 29900, "refund": 29900, "currency": "CNY"},
    }
    refund_nonce = "refund-notify-nonce"
    refund_ciphertext = AESGCM(api_key.encode()).encrypt(
        refund_nonce.encode(),
        json.dumps(refund_resource, separators=(",", ":")).encode(),
        associated.encode(),
    )
    refund_body = json.dumps(
        {
            "resource": {
                "ciphertext": base64.b64encode(refund_ciphertext).decode(),
                "nonce": refund_nonce,
                "associated_data": associated,
            }
        },
        separators=(",", ":"),
    ).encode()
    refund_message = timestamp.encode() + b"\n" + nonce.encode() + b"\n" + refund_body + b"\n"
    refund_signature = base64.b64encode(
        platform_key.sign(refund_message, padding.PKCS1v15(), hashes.SHA256())
    ).decode()
    refund_notification = provider.parse_refund_notification(
        {
            "Wechatpay-Timestamp": timestamp,
            "Wechatpay-Nonce": nonce,
            "Wechatpay-Signature": refund_signature,
            "Wechatpay-Serial": "unused-with-public-key",
        },
        refund_body,
    )
    assert refund_notification.status == "succeeded"
    assert refund_notification.refund_no == refund_no
    assert refund_notification.refund_amount_cent == 29900
    with pytest.raises(DomainError, match="signature"):
        provider.parse_notification(
            {
                "Wechatpay-Timestamp": timestamp,
                "Wechatpay-Nonce": nonce,
                "Wechatpay-Signature": base64.b64encode(b"bad").decode(),
                "Wechatpay-Serial": "unused",
            },
            body,
        )


@pytest.mark.parametrize(
    "override, message",
    [
        ({"out_trade_no": "LC-WRONG-ORDER"}, "order does not match"),
        ({"mchid": "wrong-merchant"}, "merchant does not match"),
        ({"appid": "wrong-app"}, "merchant does not match"),
        ({"amount": {"total": 1, "currency": "CNY"}}, "amount or currency"),
    ],
)
def test_wechat_signed_query_rejects_mismatched_transaction(
    override: dict[str, object], message: str
) -> None:
    merchant_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    platform_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = Settings(
        wechat_mch_id="1900000109",
        wechat_app_id="wx-test-app",
        wechat_merchant_serial_no="ABC123",
        wechat_api_v3_key="0123456789abcdef0123456789abcdef",
        wechat_private_key=_private_pem(merchant_key),
        wechat_platform_certificate=_public_pem(platform_key),
        wechat_notify_url="https://license.example/payments/wechat/notify",
        wechat_refund_notify_url="https://license.example/payments/wechat/refund-notify",
    )
    order = _order()
    query_result: dict[str, object] = {
        "trade_state": "SUCCESS",
        "transaction_id": "420000001",
        "out_trade_no": order.order_no,
        "mchid": settings.wechat_mch_id,
        "appid": settings.wechat_app_id,
        "amount": {"total": order.amount_cent, "currency": order.currency},
    }
    query_result.update(override)
    provider = WechatNativePaymentProvider(
        settings, transport=QueueTransport([query_result], platform_key)
    )

    with pytest.raises(DomainError, match=message):
        provider.query(order, _payment("wechat"))


class AlipayTransport:
    def __init__(
        self,
        app_public: rsa.RSAPublicKey,
        alipay_private: rsa.RSAPrivateKey,
        *,
        query_overrides: dict[str, object] | None = None,
        refund_fund_change: str = "Y",
        refund_query_overrides: dict[str, object] | None = None,
    ) -> None:
        self.app_public = app_public
        self.alipay_private = alipay_private
        self.query_overrides = query_overrides or {}
        self.refund_fund_change = refund_fund_change
        self.refund_query_overrides = refund_query_overrides or {}
        self.seen_methods: list[str] = []
        self.seen_biz_content: list[dict[str, object]] = []

    def request(self, method, url, *, headers, body, timeout=10):
        del url, headers, timeout
        assert method == "POST"
        params = {key: values[0] for key, values in parse_qs(body.decode()).items()}
        signature = base64.b64decode(params.pop("sign"), validate=True)
        content = "&".join(f"{key}={params[key]}" for key in sorted(params))
        self.app_public.verify(signature, content.encode(), padding.PKCS1v15(), hashes.SHA256())
        api_method = params["method"]
        self.seen_methods.append(api_method)
        self.seen_biz_content.append(json.loads(params["biz_content"]))
        if api_method == "alipay.trade.query":
            result = {
                "code": "10000",
                "trade_status": "TRADE_SUCCESS",
                "trade_no": "20260711001",
                "out_trade_no": _order().order_no,
                "app_id": "202600000000001",
                "seller_id": "208800000000001",
                "total_amount": "299.00",
            }
            result.update(self.query_overrides)
        elif api_method == "alipay.trade.refund":
            result = {
                "code": "10000",
                "fund_change": self.refund_fund_change,
                "trade_no": "20260711001",
            }
        else:
            assert api_method == "alipay.trade.fastpay.refund.query"
            result = {
                "code": "10000",
                "trade_no": "20260711001",
                "out_trade_no": _order().order_no,
                "out_request_no": "RF202607110000000002",
                "refund_amount": "299.00",
                "total_amount": "299.00",
            }
            result.update(self.refund_query_overrides)
        response_key = api_method.replace(".", "_") + "_response"
        signed_content = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        response_signature = base64.b64encode(
            self.alipay_private.sign(signed_content.encode(), padding.PKCS1v15(), hashes.SHA256())
        ).decode()
        raw = f'{{"{response_key}":{signed_content},"sign":"{response_signature}"}}'
        return HttpResponse(200, {}, raw.encode())


class UnavailableThenAlipayTransport:
    def __init__(self, inner: AlipayTransport, failures: int) -> None:
        self.inner = inner
        self.failures = failures
        self.attempts = 0

    def request(self, method, url, *, headers, body, timeout=10):
        self.attempts += 1
        if self.attempts <= self.failures:
            raise DomainError("Payment provider is unavailable", status_code=503)
        return self.inner.request(
            method,
            url,
            headers=headers,
            body=body,
            timeout=timeout,
        )


def _assert_alipay_web_checkout(
    checkout_url: str,
    app_public_key: rsa.RSAPublicKey,
    *,
    order_no: str,
    amount: str = "299.00",
) -> dict[str, object]:
    parsed = urlsplit(checkout_url)
    assert parsed.scheme == "https"
    params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
    signature = base64.b64decode(params.pop("sign"), validate=True)
    content = "&".join(f"{key}={params[key]}" for key in sorted(params))
    app_public_key.verify(signature, content.encode(), padding.PKCS1v15(), hashes.SHA256())
    assert params["method"] == "alipay.trade.page.pay"
    assert params["notify_url"] == "https://license.example/payments/alipay/notify"
    biz_content = json.loads(params["biz_content"])
    assert biz_content["out_trade_no"] == order_no
    assert biz_content["total_amount"] == amount
    assert biz_content["product_code"] == "FAST_INSTANT_TRADE_PAY"
    assert biz_content["qr_pay_mode"] == "4"
    assert biz_content["qrcode_width"] == 196
    assert biz_content["time_expire"]
    return biz_content


def test_alipay_web_checkout_query_refund_and_callback_verification() -> None:
    app_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    alipay_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = _isolated_alipay_settings(
        alipay_app_id="202600000000001",
        alipay_seller_id="208800000000001",
        alipay_private_key=_private_pem(app_key),
        alipay_public_key=_public_pem(alipay_key),
        alipay_notify_url="https://license.example/payments/alipay/notify",
    )
    transport = AlipayTransport(app_key.public_key(), alipay_key)
    provider = AlipayWebPaymentProvider(settings, transport=transport)
    order = _order()
    payment = _payment("alipay")
    checkout = provider.create_checkout(order)
    assert checkout.qr_code_url is None
    assert checkout.code_url
    _assert_alipay_web_checkout(
        checkout.code_url,
        app_key.public_key(),
        order_no=order.order_no,
    )
    query = provider.query(order, payment)
    assert query.status == "succeeded"
    assert query.amount_cent == 29900
    refund_no = "RF202607110000000002"
    assert provider.refund(order, payment, 29900, refund_no).status == "succeeded"
    assert transport.seen_biz_content[-1]["out_request_no"] == refund_no

    params = {
        "notify_id": "notify-001",
        "app_id": settings.alipay_app_id,
        "seller_id": settings.alipay_seller_id,
        "out_trade_no": order.order_no,
        "trade_no": "20260711001",
        "trade_status": "TRADE_SUCCESS",
        "total_amount": "299.00",
    }
    content = "&".join(f"{key}={params[key]}" for key in sorted(params))
    params["sign_type"] = "RSA2"
    params["sign"] = base64.b64encode(
        alipay_key.sign(content.encode(), padding.PKCS1v15(), hashes.SHA256())
    ).decode()
    notification = provider.parse_notification({}, urlencode(params).encode())
    assert notification.order_no == order.order_no
    assert notification.amount_cent == 29900


def test_alipay_web_checkout_builds_128_unique_signed_requests() -> None:
    app_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    alipay_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = _isolated_alipay_settings(
        alipay_app_id="202600000000001",
        alipay_seller_id="208800000000001",
        alipay_private_pkcs_key=_private_pem(app_key),
        alipay_alipay_public_key=_public_pem(alipay_key),
        alipay_notify_url="https://license.example/payments/alipay/notify",
    )
    provider = AlipayWebPaymentProvider(settings)
    seen_order_numbers: set[str] = set()

    for index in range(128):
        order = _order()
        order.order_no = f"LC20260805{index:012d}"
        order.plan_name_snapshot = f"积分/套餐={index}&稳定性测试"
        checkout = provider.create_checkout(order)

        assert checkout.code_url
        biz_content = _assert_alipay_web_checkout(
            checkout.code_url,
            app_key.public_key(),
            order_no=order.order_no,
        )
        assert not {"/", "=", "&"}.intersection(str(biz_content["subject"]))
        seen_order_numbers.add(str(biz_content["out_trade_no"]))

    assert len(seen_order_numbers) == 128


def test_alipay_accepts_official_raw_non_java_key_formats() -> None:
    app_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    alipay_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = _isolated_alipay_settings(
        alipay_app_id="202600000000001",
        alipay_private_pkcs_key=_private_pkcs1_base64(app_key),
        alipay_alipay_public_key=_public_der_base64(alipay_key),
        alipay_notify_url="https://license.example/payments/alipay/notify",
    )

    provider = AlipayWebPaymentProvider(settings)
    checkout = provider.create_checkout(_order())

    assert checkout.code_url
    _assert_alipay_web_checkout(
        checkout.code_url,
        app_key.public_key(),
        order_no=_order().order_no,
    )


def test_alipay_query_treats_not_yet_created_page_trade_as_pending() -> None:
    app_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    alipay_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = _isolated_alipay_settings(
        alipay_app_id="202600000000001",
        alipay_private_pkcs_key=_private_pem(app_key),
        alipay_alipay_public_key=_public_pem(alipay_key),
        alipay_notify_url="https://license.example/payments/alipay/notify",
    )
    provider = AlipayWebPaymentProvider(
        settings,
        transport=AlipayTransport(
            app_key.public_key(),
            alipay_key,
            query_overrides={
                "code": "40004",
                "sub_code": "ACQ.TRADE_NOT_EXIST",
                "trade_status": "",
            },
        ),
    )

    assert provider.query(_order(), _payment("alipay")).status == "pending"


def test_alipay_query_retries_only_transient_network_failures() -> None:
    app_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    alipay_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = _isolated_alipay_settings(
        alipay_app_id="202600000000001",
        alipay_seller_id="208800000000001",
        alipay_private_pkcs_key=_private_pem(app_key),
        alipay_alipay_public_key=_public_pem(alipay_key),
        alipay_notify_url="https://license.example/payments/alipay/notify",
    )
    transport = UnavailableThenAlipayTransport(
        AlipayTransport(app_key.public_key(), alipay_key),
        failures=2,
    )
    delays: list[float] = []
    provider = AlipayWebPaymentProvider(settings, transport=transport, sleeper=delays.append)

    assert provider.query(_order(), _payment("alipay")).status == "succeeded"
    assert transport.attempts == 3
    assert delays == [0.15, 0.3]


def test_alipay_refund_mutation_is_never_retried_automatically() -> None:
    app_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    alipay_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = _isolated_alipay_settings(
        alipay_app_id="202600000000001",
        alipay_private_pkcs_key=_private_pem(app_key),
        alipay_alipay_public_key=_public_pem(alipay_key),
        alipay_notify_url="https://license.example/payments/alipay/notify",
    )
    transport = UnavailableThenAlipayTransport(
        AlipayTransport(app_key.public_key(), alipay_key),
        failures=1,
    )
    delays: list[float] = []
    provider = AlipayWebPaymentProvider(settings, transport=transport, sleeper=delays.append)

    with pytest.raises(DomainError, match="unavailable"):
        provider.refund(_order(), _payment("alipay"), 29900, "RF202608050001")

    assert transport.attempts == 1
    assert delays == []


def test_alipay_idempotent_refund_replay_queries_original_result() -> None:
    app_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    alipay_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = _isolated_alipay_settings(
        alipay_app_id="202600000000001",
        alipay_seller_id="208800000000001",
        alipay_private_key=_private_pem(app_key),
        alipay_public_key=_public_pem(alipay_key),
        alipay_notify_url="https://license.example/payments/alipay/notify",
    )
    transport = AlipayTransport(
        app_key.public_key(),
        alipay_key,
        refund_fund_change="N",
    )
    provider = AlipayWebPaymentProvider(settings, transport=transport)
    refund_no = "RF202607110000000002"

    result = provider.refund(_order(), _payment("alipay"), 29900, refund_no)

    assert result.status == "succeeded"
    assert transport.seen_methods == [
        "alipay.trade.refund",
        "alipay.trade.fastpay.refund.query",
    ]
    assert transport.seen_biz_content[-1] == {
        "out_trade_no": _order().order_no,
        "out_request_no": refund_no,
    }


@pytest.mark.parametrize(
    "override, message",
    [
        ({"out_trade_no": "LC-WRONG-ORDER"}, "order does not match"),
        ({"app_id": "wrong-app"}, "merchant does not match"),
        ({"seller_id": "wrong-seller"}, "merchant does not match"),
        ({"total_amount": "1.00"}, "amount or currency"),
    ],
)
def test_alipay_signed_query_rejects_mismatched_transaction(
    override: dict[str, object], message: str
) -> None:
    app_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    alipay_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = _isolated_alipay_settings(
        alipay_app_id="202600000000001",
        alipay_seller_id="208800000000001",
        alipay_private_key=_private_pem(app_key),
        alipay_public_key=_public_pem(alipay_key),
        alipay_notify_url="https://license.example/payments/alipay/notify",
    )
    provider = AlipayWebPaymentProvider(
        settings,
        transport=AlipayTransport(app_key.public_key(), alipay_key, query_overrides=override),
    )

    with pytest.raises(DomainError, match=message):
        provider.query(_order(), _payment("alipay"))


def test_payment_provider_without_credentials_fails_closed() -> None:
    with pytest.raises(DomainError, match="missing"):
        build_payment_provider(Settings(), "wechat")

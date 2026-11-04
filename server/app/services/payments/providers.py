from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from app.config import Settings
from app.models import Order, Payment
from app.services.errors import DomainError
from app.services.payments.http import HttpTransport


@dataclass(frozen=True, slots=True)
class CheckoutResult:
    provider_payment_no: str
    code_url: str | None
    qr_code_url: str | None
    safe_payload: dict[str, object]


@dataclass(frozen=True, slots=True)
class QueryResult:
    status: str
    event_id: str | None = None
    provider_payment_no: str | None = None
    amount_cent: int | None = None
    currency: str | None = None


@dataclass(frozen=True, slots=True)
class RefundResult:
    status: str
    provider_refund_no: str | None


@dataclass(frozen=True, slots=True)
class PaymentNotification:
    order_no: str
    event_id: str
    provider_payment_no: str
    status: str
    amount_cent: int
    currency: str
    payload_fingerprint: str


@dataclass(frozen=True, slots=True)
class RefundNotification:
    order_no: str | None
    refund_no: str
    event_id: str
    provider_refund_no: str
    status: str
    refund_amount_cent: int
    total_amount_cent: int
    currency: str
    payload_fingerprint: str
    provider_payment_no: str | None = None


class PaymentProvider(Protocol):
    name: str

    def create_checkout(self, order: Order) -> CheckoutResult: ...
    def query(self, order: Order, payment: Payment) -> QueryResult: ...
    def refund(
        self, order: Order, payment: Payment, amount_cent: int, refund_no: str
    ) -> RefundResult: ...


class CallbackPaymentProvider(PaymentProvider, Protocol):
    def parse_notification(
        self, headers: Mapping[str, str], body: bytes
    ) -> PaymentNotification: ...


class DevelopmentPaymentProvider:
    name = "development"

    def create_checkout(self, order: Order) -> CheckoutResult:
        url = f"development://pay/{order.order_no}"
        return CheckoutResult(
            provider_payment_no=f"DEV-{order.order_no}",
            code_url=url,
            qr_code_url=url,
            safe_payload={"code_url": url},
        )

    def query(self, order: Order, payment: Payment) -> QueryResult:
        del order
        return QueryResult(status="succeeded" if payment.status == "succeeded" else "pending")

    def refund(
        self, order: Order, payment: Payment, amount_cent: int, refund_no: str
    ) -> RefundResult:
        del payment, amount_cent
        return RefundResult(status="succeeded", provider_refund_no=f"DEV-{refund_no}")


def provider_configuration(settings: Settings, name: str) -> tuple[bool, bool, str | None]:
    if name == "development":
        enabled = settings.payment_development_enabled and settings.app_env in {
            "development",
            "test",
        }
        return enabled, enabled, None if enabled else "disabled outside development/test"
    if name in {"wechat", "alipay"} and settings.payment_gateway_mode == "jeepay":
        channel_enabled = (
            settings.jeepay_alipay_enabled if name == "alipay" else settings.jeepay_wechat_enabled
        )
        configured = (
            all(
                (
                    settings.jeepay_enabled,
                    channel_enabled,
                    settings.jeepay_api_base_url,
                    settings.jeepay_mch_no,
                    settings.jeepay_app_id,
                    settings.jeepay_api_key,
                    settings.jeepay_notify_url,
                    settings.jeepay_refund_notify_url,
                )
            )
            and len(settings.jeepay_api_key or "") >= 16
        )
        return (
            bool(configured),
            bool(configured),
            None
            if configured
            else "Jeepay gateway, merchant application, or payment channel is not configured",
        )
    if name == "wechat":
        configured = all(
            (
                settings.wechat_mch_id,
                settings.wechat_app_id,
                settings.wechat_merchant_serial_no,
                settings.wechat_api_v3_key,
                settings.wechat_private_key,
                settings.wechat_platform_certificate,
                settings.wechat_notify_url,
                settings.wechat_refund_notify_url,
            )
        )
    elif name == "alipay":
        configured = all(
            (
                settings.alipay_app_id,
                settings.alipay_private_pkcs_key,
                settings.alipay_alipay_public_key,
                settings.alipay_notify_url,
            )
        )
    else:
        return False, False, "unsupported provider"
    return (
        bool(configured),
        bool(configured),
        (None if configured else "credentials, certificate, or notify URL are missing"),
    )


def build_payment_provider(
    settings: Settings,
    name: str,
    *,
    transport: HttpTransport | None = None,
) -> PaymentProvider:
    configured, enabled, reason = provider_configuration(settings, name)
    if name == "development" and enabled:
        return DevelopmentPaymentProvider()
    if not configured or not enabled:
        raise DomainError(reason or "Payment provider is unavailable", status_code=503)
    if name in {"wechat", "alipay"} and settings.payment_gateway_mode == "jeepay":
        from app.services.payments.jeepay import JeepayPaymentProvider

        return JeepayPaymentProvider(settings, name, transport=transport)
    if name == "wechat":
        from app.services.payments.wechat import WechatNativePaymentProvider

        return WechatNativePaymentProvider(settings, transport=transport)
    if name == "alipay":
        from app.services.payments.alipay import AlipayWebPaymentProvider

        return AlipayWebPaymentProvider(settings, transport=transport)
    raise DomainError("Payment provider is unavailable", status_code=503)

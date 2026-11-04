from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import require_user_token
from app.database.session import get_db
from app.models import ActivationCode, Order, OrderFulfillment, Payment, User
from app.schemas.commerce import (
    DevelopmentCompleteRequest,
    FulfillmentRead,
    PaymentCallbackResult,
)
from app.services.errors import DomainError
from app.services.order_service import process_payment_success
from app.services.payments.jeepay import (
    parse_jeepay_payment_notification,
    parse_jeepay_refund_notification,
)
from app.services.payments.providers import build_payment_provider
from app.services.refund_service import process_refund_notification

router = APIRouter(prefix="/payments", tags=["payments"])
development_router = APIRouter(prefix="/api/payments", tags=["development-payments"])


def _callback_response(
    db: Session,
    order: Order,
    code: str | None,
    idempotent: bool,
) -> PaymentCallbackResult:
    fulfillment = db.scalar(select(OrderFulfillment).where(OrderFulfillment.order_id == order.id))
    activation = (
        db.get(ActivationCode, fulfillment.activation_code_id)
        if fulfillment and fulfillment.activation_code_id
        else None
    )
    fulfillment_read = (
        FulfillmentRead(
            status=fulfillment.status,
            activation_code=code,
            activation_code_prefix=activation.code_prefix if activation else None,
            points_credited=fulfillment.points_credited,
            point_balance_after=fulfillment.point_balance_after,
            fulfilled_at=fulfillment.fulfilled_at,
        )
        if fulfillment
        else None
    )
    return PaymentCallbackResult(
        order_no=order.order_no,
        status=order.status,
        idempotent=idempotent,
        activation_code=code,
        fulfillment=fulfillment_read,
    )


@development_router.post("/development/{order_no}/complete", response_model=PaymentCallbackResult)
def complete_development_payment(
    order_no: str,
    request: Request,
    payload: DevelopmentCompleteRequest | None = None,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> PaymentCallbackResult:
    settings = request.app.state.settings
    if settings.app_env not in {"development", "test"} or not settings.payment_development_enabled:
        raise DomainError("Development payment is disabled", status_code=404)
    order = db.scalar(select(Order).where(Order.order_no == order_no))
    if order is None or order.user_id != user.id:
        raise DomainError("Order not found", status_code=404)
    payment = db.scalar(
        select(Payment).where(Payment.order_id == order.id, Payment.provider == "development")
    )
    if payment is None:
        raise DomainError("Development payment was not initialized", status_code=409)
    event_id = payload.event_id if payload and payload.event_id else f"dev:{order_no}:paid"
    order, code, idempotent = process_payment_success(
        db,
        settings,
        provider="development",
        order_no=order_no,
        event_id=event_id,
        amount_cent=payment.amount_cent,
        currency=payment.currency,
        payload_fingerprint=f"development:{event_id}:{order_no}",
    )
    return _callback_response(db, order, code, idempotent)


async def _process_external_callback(provider_name: str, request: Request, db: Session) -> None:
    provider = build_payment_provider(request.app.state.settings, provider_name)
    parser = getattr(provider, "parse_notification", None)
    if parser is None:
        raise DomainError("Payment callback adapter is unavailable", status_code=503)
    body = await request.body()
    notification = parser(request.headers, body)
    if notification.status != "succeeded":
        return
    process_payment_success(
        db,
        request.app.state.settings,
        provider=provider_name,
        order_no=notification.order_no,
        event_id=notification.event_id,
        amount_cent=notification.amount_cent,
        currency=notification.currency,
        payload_fingerprint=notification.payload_fingerprint,
        provider_payment_no=notification.provider_payment_no,
    )


@router.post("/wechat/notify", include_in_schema=True)
async def wechat_notify(request: Request, db: Session = Depends(get_db)) -> JSONResponse:
    await _process_external_callback("wechat", request, db)
    return JSONResponse({"code": "SUCCESS", "message": "成功"})


@router.post("/wechat/refund-notify", include_in_schema=True)
async def wechat_refund_notify(request: Request, db: Session = Depends(get_db)) -> JSONResponse:
    provider = build_payment_provider(request.app.state.settings, "wechat")
    parser = getattr(provider, "parse_refund_notification", None)
    if parser is None:
        raise DomainError("Refund callback adapter is unavailable", status_code=503)
    body = await request.body()
    notification = parser(request.headers, body)
    process_refund_notification(db, provider="wechat", notification=notification)
    return JSONResponse({"code": "SUCCESS", "message": "成功"})


@router.post("/alipay/notify", include_in_schema=True)
async def alipay_notify(request: Request, db: Session = Depends(get_db)) -> PlainTextResponse:
    # Raw callback bodies are verified in memory, then discarded without logging.
    await _process_external_callback("alipay", request, db)
    return PlainTextResponse("success")


def _ensure_jeepay_callback_enabled(request: Request) -> None:
    settings = request.app.state.settings
    if settings.payment_gateway_mode != "jeepay" or not settings.jeepay_enabled:
        raise DomainError("Jeepay callback adapter is unavailable", status_code=503)
    if not all((settings.jeepay_mch_no, settings.jeepay_app_id, settings.jeepay_api_key)):
        raise DomainError("Jeepay callback adapter is unavailable", status_code=503)


@router.post("/jeepay/notify", include_in_schema=True)
async def jeepay_notify(request: Request, db: Session = Depends(get_db)) -> PlainTextResponse:
    _ensure_jeepay_callback_enabled(request)
    body = await request.body()
    provider_name, notification = parse_jeepay_payment_notification(
        request.app.state.settings,
        request.headers,
        body,
    )
    # Also checks that the inferred public channel is enabled. The desktop and
    # order ledger continue to use only "wechat" or "alipay" as provider names.
    build_payment_provider(request.app.state.settings, provider_name)
    if notification.status == "succeeded":
        process_payment_success(
            db,
            request.app.state.settings,
            provider=provider_name,
            order_no=notification.order_no,
            event_id=notification.event_id,
            amount_cent=notification.amount_cent,
            currency=notification.currency,
            payload_fingerprint=notification.payload_fingerprint,
            provider_payment_no=notification.provider_payment_no,
        )
    return PlainTextResponse("success")


@router.post("/jeepay/refund-notify", include_in_schema=True)
async def jeepay_refund_notify(
    request: Request,
    db: Session = Depends(get_db),
) -> PlainTextResponse:
    _ensure_jeepay_callback_enabled(request)
    body = await request.body()
    provider_name, notification = parse_jeepay_refund_notification(
        request.app.state.settings,
        request.headers,
        body,
    )
    build_payment_provider(request.app.state.settings, provider_name)
    process_refund_notification(db, provider=provider_name, notification=notification)
    return PlainTextResponse("success")

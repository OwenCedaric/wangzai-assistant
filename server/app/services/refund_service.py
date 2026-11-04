from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    ActivationCode,
    CommissionRecord,
    License,
    Order,
    Payment,
    PaymentEvent,
    Plan,
    Refund,
)
from app.services.errors import DomainError
from app.services.payments.providers import (
    RefundNotification,
    RefundResult,
    build_payment_provider,
)
from app.services.point_service import (
    finalize_order_points_refund,
    reserve_order_points_refund,
    restore_order_points_refund,
)


def _new_refund_no() -> str:
    return f"RF{datetime.now(UTC):%Y%m%d%H%M%S}{secrets.token_hex(5).upper()}"


def _set_provider_refund_no(refund: Refund, provider_refund_no: str | None) -> None:
    if (
        refund.provider_refund_no
        and provider_refund_no
        and refund.provider_refund_no != provider_refund_no
    ):
        raise DomainError("Provider refund number does not match", status_code=409)
    if provider_refund_no:
        refund.provider_refund_no = provider_refund_no


def _suspend_unused_activation(db: Session, order_id: int) -> None:
    activation = db.scalar(
        select(ActivationCode).where(ActivationCode.order_id == order_id).with_for_update()
    )
    if activation is not None and activation.status == "unused":
        activation.status = "disabled"


def _restore_unused_activation(db: Session, order_id: int) -> None:
    activation = db.scalar(
        select(ActivationCode).where(ActivationCode.order_id == order_id).with_for_update()
    )
    if (
        activation is not None
        and activation.status == "disabled"
        and activation.activated_license_id is None
    ):
        activation.status = "unused"


def _point_order(db: Session, order: Order) -> bool:
    plan = db.get(Plan, order.plan_id)
    if plan is None:
        raise DomainError("Order plan is unavailable", status_code=409)
    return plan.plan_kind == "points"


def _apply_refund_success(
    db: Session,
    order: Order,
    payment: Payment,
    refund: Refund,
    now: datetime,
    provider_refund_no: str | None,
) -> None:
    _set_provider_refund_no(refund, provider_refund_no)
    if refund.status == "succeeded":
        if order.status != "refunded" or payment.status != "refunded":
            raise DomainError("Refund state is inconsistent", status_code=409)
        return
    if refund.status != "pending" or order.status != "refunding":
        raise DomainError("Order is not awaiting a refund", status_code=409)
    refund.status = "succeeded"
    refund.processed_at = now
    payment.status = "refunded"
    order.status = "refunded"
    order.refunded_at = now
    if _point_order(db, order):
        finalize_order_points_refund(db, order)
    else:
        activation = db.scalar(
            select(ActivationCode).where(ActivationCode.order_id == order.id).with_for_update()
        )
        if activation is not None:
            if activation.status == "unused":
                activation.status = "disabled"
            elif activation.activated_license_id:
                license_record = db.get(License, activation.activated_license_id)
                if license_record is not None:
                    license_record.status = "disabled"
                    license_record.offline_until = None
    commission = db.scalar(
        select(CommissionRecord).where(CommissionRecord.order_id == order.id).with_for_update()
    )
    if commission is not None and commission.status != "reversed":
        commission.status = "reversed"
        commission.reversed_at = now


def _apply_refund_failure(
    db: Session,
    order: Order,
    refund: Refund,
    now: datetime,
    provider_refund_no: str | None,
) -> None:
    _set_provider_refund_no(refund, provider_refund_no)
    if refund.status == "failed":
        return
    if refund.status != "pending" or order.status != "refunding":
        raise DomainError("Order is not awaiting a refund", status_code=409)
    refund.status = "failed"
    refund.processed_at = now
    order.status = "fulfilled" if order.fulfilled_at else "paid"
    if _point_order(db, order):
        restore_order_points_refund(db, order)
    else:
        _restore_unused_activation(db, order.id)


def _prepare_refund_intent(
    db: Session, order_id: int, amount_cent: int | None, reason: str
) -> tuple[Order, Payment, Refund]:
    order = db.scalar(select(Order).where(Order.id == order_id).with_for_update())
    if order is None:
        raise DomainError("Order not found", status_code=404)
    pending = db.scalar(
        select(Refund)
        .where(Refund.order_id == order.id, Refund.status == "pending")
        .order_by(Refund.created_at.desc())
        .with_for_update()
    )
    if pending is not None:
        if order.status != "refunding":
            raise DomainError("Refund state is inconsistent", status_code=409)
        if amount_cent is not None and amount_cent != pending.amount_cent:
            raise DomainError("Pending refund amount does not match", status_code=409)
        payment = db.scalar(
            select(Payment).where(Payment.id == pending.payment_id).with_for_update()
        )
        if payment is None or payment.status != "succeeded":
            raise DomainError("Pending refund payment is unavailable", status_code=409)
        db.commit()
        return order, payment, pending
    if order.status not in {"paid", "fulfilled"}:
        raise DomainError("Order is not refundable", status_code=409)
    amount = amount_cent if amount_cent is not None else order.amount_cent
    if amount != order.amount_cent:
        raise DomainError("Only a full refund is supported in v1.1", status_code=422)
    payment = db.scalar(
        select(Payment)
        .where(Payment.order_id == order.id, Payment.status == "succeeded")
        .with_for_update()
    )
    if payment is None:
        raise DomainError("Successful payment not found", status_code=409)
    order.status = "refunding"
    refund = Refund(
        refund_no=_new_refund_no(),
        order_id=order.id,
        payment_id=payment.id,
        amount_cent=amount,
        reason=reason,
        status="pending",
    )
    db.add(refund)
    if _point_order(db, order):
        reserve_order_points_refund(db, order)
    else:
        _suspend_unused_activation(db, order.id)
    db.flush()
    db.commit()
    db.refresh(refund)
    return order, payment, refund


def _record_refund_result(db: Session, refund_id: int, result: RefundResult) -> Refund:
    snapshot = db.get(Refund, refund_id)
    if snapshot is None:
        raise DomainError("Refund intent not found", status_code=409)
    order = db.scalar(select(Order).where(Order.id == snapshot.order_id).with_for_update())
    refund = db.scalar(select(Refund).where(Refund.id == refund_id).with_for_update())
    if order is None or refund is None:
        raise DomainError("Refund intent not found", status_code=409)
    payment = db.scalar(select(Payment).where(Payment.id == refund.payment_id).with_for_update())
    if payment is None:
        raise DomainError("Refund payment not found", status_code=409)
    if refund.status == "succeeded":
        _set_provider_refund_no(refund, result.provider_refund_no)
        db.commit()
        db.refresh(refund)
        return refund
    if refund.status == "failed":
        _set_provider_refund_no(refund, result.provider_refund_no)
        db.commit()
        raise DomainError("Refund failed", status_code=409)
    now = datetime.now(UTC)
    if result.status == "succeeded":
        _apply_refund_success(db, order, payment, refund, now, result.provider_refund_no)
    elif result.status == "failed":
        _apply_refund_failure(db, order, refund, now, result.provider_refund_no)
    elif result.status == "pending":
        _set_provider_refund_no(refund, result.provider_refund_no)
    else:
        raise DomainError("Refund provider returned an invalid status", status_code=502)
    db.commit()
    db.refresh(refund)
    if result.status == "failed":
        raise DomainError("Refund failed", status_code=409)
    return refund


def request_refund(
    db: Session,
    settings: Settings,
    order_id: int,
    amount_cent: int | None,
    reason: str,
) -> Refund:
    order, payment, refund = _prepare_refund_intent(db, order_id, amount_cent, reason)
    result = build_payment_provider(settings, payment.provider).refund(
        order,
        payment,
        refund.amount_cent,
        refund.refund_no,
    )
    return _record_refund_result(db, refund.id, result)


def process_refund_notification(
    db: Session,
    *,
    provider: str,
    notification: RefundNotification,
) -> bool:
    if notification.order_no:
        order = db.scalar(
            select(Order).where(Order.order_no == notification.order_no).with_for_update()
        )
    else:
        # Some signed providers identify a refund by the merchant refund number
        # and provider payment number, without echoing the merchant order number.
        # Use the immutable refund row only as a lookup hint, then preserve the
        # normal lock order: Order -> Refund -> Payment.
        order_id = db.scalar(
            select(Refund.order_id).where(Refund.refund_no == notification.refund_no)
        )
        order = (
            db.scalar(select(Order).where(Order.id == order_id).with_for_update())
            if order_id is not None
            else None
        )
    if order is None:
        raise DomainError("Refund order not found", status_code=404)
    if (
        notification.refund_amount_cent != order.amount_cent
        or notification.total_amount_cent != order.amount_cent
        or notification.currency != order.currency
    ):
        raise DomainError("Refund amount or currency mismatch", status_code=409)
    refund = db.scalar(
        select(Refund)
        .where(
            Refund.order_id == order.id,
            Refund.refund_no == notification.refund_no,
        )
        .with_for_update()
    )
    if refund is None:
        raise DomainError("Pending refund not found", status_code=409)
    payment = db.scalar(
        select(Payment)
        .where(Payment.id == refund.payment_id, Payment.provider == provider)
        .with_for_update()
    )
    if payment is None:
        raise DomainError("Pending refund not found", status_code=409)
    if (
        notification.provider_payment_no
        and payment.provider_payment_no != notification.provider_payment_no
    ):
        raise DomainError("Refund payment transaction mismatch", status_code=409)
    _set_provider_refund_no(refund, notification.provider_refund_no)
    if notification.status == "pending":
        if refund.status == "pending":
            db.commit()
            return False
        db.commit()
        return True
    existing = db.scalar(
        select(PaymentEvent).where(
            PaymentEvent.provider == provider,
            PaymentEvent.event_id == notification.event_id,
        )
    )
    if existing is not None:
        if existing.order_id != order.id:
            raise DomainError("Refund event belongs to another order", status_code=409)
        db.commit()
        return True
    now = datetime.now(UTC)
    event = PaymentEvent(
        provider=provider,
        event_id=notification.event_id,
        order_id=order.id,
        payment_id=payment.id,
        event_type=("refund_succeeded" if notification.status == "succeeded" else "refund_failed"),
        amount_cent=notification.refund_amount_cent,
        currency=notification.currency,
        payload_hash=hashlib.sha256(notification.payload_fingerprint.encode()).hexdigest(),
        status="processed",
        processed_at=now,
    )
    try:
        with db.begin_nested():
            db.add(event)
            db.flush()
    except IntegrityError as exc:
        existing = db.scalar(
            select(PaymentEvent).where(
                PaymentEvent.provider == provider,
                PaymentEvent.event_id == notification.event_id,
            )
        )
        if existing is None or existing.order_id != order.id:
            raise DomainError("Refund event conflicts with another order", status_code=409) from exc
        return True
    if notification.status == "succeeded":
        _apply_refund_success(
            db,
            order,
            payment,
            refund,
            now,
            notification.provider_refund_no,
        )
    else:
        _apply_refund_failure(
            db,
            order,
            refund,
            now,
            notification.provider_refund_no,
        )
    db.commit()
    return False

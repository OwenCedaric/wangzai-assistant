from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from app.config import Settings
from app.licensing.shop_card_policy import (
    LICENSE_ROLE_LEGACY,
    STANDARD_SHOP_CARD_ROLES,
)
from app.models import (
    ActivationCode,
    CardBatch,
    CommissionRecord,
    CommissionRule,
    Order,
    OrderFulfillment,
    Payment,
    PaymentEvent,
    Plan,
    Product,
    User,
    UserProjectAttribution,
)
from app.models.base import as_utc
from app.schemas.commerce import OrderCreate
from app.services.card_service import (
    encrypt_card_code,
    hash_card_code,
    order_card_code,
)
from app.services.errors import DomainError
from app.services.payments.providers import build_payment_provider
from app.services.point_service import credit_order_points

_ALLOWED_TRANSITIONS = {
    "pending": {"paying", "closed"},
    "paying": {"paid", "closed", "payment_failed"},
    "payment_failed": {"paying", "closed"},
    "paid": {"fulfilled", "refunding"},
    "fulfilled": {"refunding"},
    "refunding": {"refunded", "fulfilled"},
    # A verified provider success may arrive after the local expiry reaper has
    # closed an order. Money received must still be credited to the exact owner.
    "closed": {"paying"},
    "refunded": set(),
}


def transition_order(order: Order, target: str) -> None:
    if target == order.status:
        return
    if target not in _ALLOWED_TRANSITIONS.get(order.status, set()):
        raise DomainError(
            f"Order cannot transition from {order.status} to {target}", status_code=409
        )
    order.status = target


def close_expired_orders(
    db: Session,
    settings: Settings,
    *,
    now: datetime | None = None,
    limit: int = 100,
) -> int:
    """Reconcile and close expired unpaid orders without losing late payments."""
    current = now or datetime.now(UTC)
    order_ids = db.scalars(
        select(Order.id)
        .where(
            Order.status.in_({"pending", "paying", "payment_failed"}),
            Order.expires_at <= current,
        )
        .order_by(Order.expires_at, Order.id)
        .limit(limit)
    ).all()
    closed = 0
    for order_id in order_ids:
        order = db.scalar(select(Order).where(Order.id == order_id).with_for_update())
        if order is None or order.status not in {"pending", "paying", "payment_failed"}:
            continue
        if order.payment_provider:
            try:
                query_payment(db, settings, order, now=current)
            except Exception:
                # A transient provider outage must not turn an uncertain payment
                # into a closed order. The next reaper pass will reconcile again.
                db.rollback()
                continue
        elif as_utc(order.expires_at) <= current:
            transition_order(order, "closed")
            order.closed_at = current
            db.commit()
        if order.status == "closed":
            closed += 1
    return closed


def _new_order_no() -> str:
    return f"LC{datetime.now(UTC):%Y%m%d%H%M%S}{secrets.token_hex(5).upper()}"


def _plan_for_store(db: Session, plan_id: int) -> Plan | None:
    return db.scalar(
        select(Plan)
        .where(Plan.id == plan_id)
        .options(
            joinedload(Plan.product).joinedload(Product.project),
            selectinload(Plan.permissions),
        )
    )


def _commission_rate(
    db: Session, attribution: UserProjectAttribution | None, project_id: int, plan_id: int
) -> int:
    if attribution is None or attribution.agent_id is None:
        return 0
    rules = db.scalars(
        select(CommissionRule)
        .where(
            CommissionRule.agent_id == attribution.agent_id,
            CommissionRule.status == "active",
            or_(CommissionRule.project_id == project_id, CommissionRule.project_id.is_(None)),
            or_(CommissionRule.plan_id == plan_id, CommissionRule.plan_id.is_(None)),
        )
        .order_by(
            CommissionRule.plan_id.is_(None),
            CommissionRule.project_id.is_(None),
            CommissionRule.id.desc(),
        )
    ).all()
    return rules[0].rate_bps if rules else attribution.agent.default_commission_rate_bps


def create_order(
    db: Session,
    settings: Settings,
    user: User,
    payload: OrderCreate,
) -> Order:
    if payload.idempotency_key:
        existing = db.scalar(
            select(Order).where(
                Order.user_id == user.id,
                Order.idempotency_key == payload.idempotency_key,
            )
        )
        if existing is not None:
            if existing.plan_id != payload.plan_id or existing.project.code != payload.project_code:
                raise DomainError("Idempotency key was used for another order", status_code=409)
            return existing
    plan = _plan_for_store(db, payload.plan_id)
    if plan is None or plan.product.project.code != payload.project_code:
        raise DomainError("Plan not found", status_code=404)
    project = plan.product.project
    if (
        project.status != "active"
        or plan.product.status != "active"
        or plan.status != "active"
        or not plan.online_sale_enabled
        or plan.sale_price_cent <= 0
    ):
        raise DomainError("Plan is not available for online sale", status_code=409)
    if plan.plan_kind == "points" and plan.points_amount <= 0:
        raise DomainError("Point package is not available for online sale", status_code=409)
    if plan.plan_kind not in {"license", "points"}:
        raise DomainError("Plan type is not supported", status_code=409)
    if plan.plan_kind == "license" and plan.license_role not in STANDARD_SHOP_CARD_ROLES:
        message = (
            "Legacy license plans are not available for new orders"
            if plan.license_role == LICENSE_ROLE_LEGACY
            else "The first-shop introductory card cannot be purchased from an existing account"
        )
        raise DomainError(message, status_code=409)
    attribution = db.scalar(
        select(UserProjectAttribution)
        .where(
            UserProjectAttribution.user_id == user.id,
            UserProjectAttribution.project_id == project.id,
            UserProjectAttribution.status == "active",
        )
        .with_for_update()
    )
    if attribution is None:
        raise DomainError("Verify the phone for this project before ordering", status_code=409)
    if payload.idempotency_key:
        # The attribution row serializes order creation for this user/project.
        # Recheck after acquiring it so concurrent identical requests return one order.
        existing = db.scalar(
            select(Order).where(
                Order.user_id == user.id,
                Order.idempotency_key == payload.idempotency_key,
            )
        )
        if existing is not None:
            if existing.plan_id != payload.plan_id or existing.project_id != project.id:
                raise DomainError("Idempotency key was used for another order", status_code=409)
            return existing
    rate_bps = _commission_rate(db, attribution, project.id, plan.id)
    commission_cent = plan.sale_price_cent * rate_bps // 10_000
    order = Order(
        order_no=_new_order_no(),
        idempotency_key=payload.idempotency_key,
        user_id=user.id,
        project_id=project.id,
        plan_id=plan.id,
        agent_id=attribution.agent_id,
        channel_id=attribution.channel_id,
        plan_name_snapshot=plan.name,
        amount_cent=plan.sale_price_cent,
        currency="CNY",
        commission_rate_bps=rate_bps,
        commission_amount_cent=commission_cent,
        status="pending",
        expires_at=datetime.now(UTC) + timedelta(minutes=settings.order_expiry_minutes),
    )
    if payload.idempotency_key:
        try:
            with db.begin_nested():
                db.add(order)
                db.flush()
        except IntegrityError as exc:
            existing = db.scalar(
                select(Order).where(
                    Order.user_id == user.id,
                    Order.idempotency_key == payload.idempotency_key,
                )
            )
            if existing is None:
                raise DomainError("Order creation conflicted; retry", status_code=409) from exc
            if existing.plan_id != payload.plan_id or existing.project_id != project.id:
                raise DomainError(
                    "Idempotency key was used for another order", status_code=409
                ) from exc
            return existing
    else:
        db.add(order)
        db.flush()
    return order


def create_payment_checkout(
    db: Session,
    settings: Settings,
    user: User,
    order_id: int,
    provider_name: str | None,
) -> tuple[Order, Payment, str | None, str | None]:
    order = db.scalar(select(Order).where(Order.id == order_id).with_for_update())
    if order is None or order.user_id != user.id:
        raise DomainError("Order not found", status_code=404)
    now = datetime.now(UTC)
    if as_utc(order.expires_at) <= now and order.status in {
        "pending",
        "paying",
        "payment_failed",
    }:
        transition_order(order, "closed")
        order.closed_at = now
        db.commit()
        raise DomainError("Order has expired", status_code=409)
    if order.status not in {"pending", "paying", "payment_failed"}:
        raise DomainError("Order is not payable", status_code=409)
    name = provider_name or settings.payment_default_provider
    if order.payment_provider and order.payment_provider != name:
        raise DomainError("Order already uses another payment provider", status_code=409)
    existing = db.scalar(
        select(Payment).where(Payment.order_id == order.id, Payment.provider == name)
    )
    if existing is not None:
        payload = existing.checkout_payload or {}
        return order, existing, payload.get("code_url"), payload.get("qr_code_url")
    provider = build_payment_provider(settings, name)
    result = provider.create_checkout(order)
    payment = Payment(
        order_id=order.id,
        provider=name,
        provider_payment_no=result.provider_payment_no,
        amount_cent=order.amount_cent,
        currency=order.currency,
        status="pending",
        checkout_payload={
            **result.safe_payload,
            "code_url": result.code_url,
            "qr_code_url": result.qr_code_url,
        },
    )
    db.add(payment)
    transition_order(order, "paying")
    order.payment_provider = name
    order.provider_payment_no = result.provider_payment_no
    db.flush()
    return order, payment, result.code_url, result.qr_code_url


def _commission_fulfillment(
    db: Session,
    settings: Settings,
    order: Order,
    now: datetime,
) -> None:
    if order.agent_id is None or order.commission_amount_cent <= 0:
        return
    existing_commission = db.scalar(
        select(CommissionRecord).where(CommissionRecord.order_id == order.id)
    )
    if existing_commission is None:
        db.add(
            CommissionRecord(
                agent_id=order.agent_id,
                order_id=order.id,
                rate_bps=order.commission_rate_bps,
                base_amount_cent=order.amount_cent,
                commission_amount_cent=order.commission_amount_cent,
                status="pending",
                available_at=now + timedelta(days=settings.commission_hold_days),
            )
        )


def _fulfilled_code(settings: Settings, order: Order, plan: Plan | None = None) -> str | None:
    resolved_plan = plan or order.plan
    if order.status != "fulfilled" or resolved_plan.plan_kind != "license":
        return None
    return order_card_code(settings, order.order_no)


def _fulfill_order(
    db: Session,
    settings: Settings,
    order: Order,
    now: datetime,
) -> str | None:
    fulfillment = db.scalar(
        select(OrderFulfillment).where(OrderFulfillment.order_id == order.id).with_for_update()
    )
    plan = db.get(Plan, order.plan_id)
    if plan is None:
        raise DomainError("Paid order plan is unavailable for fulfillment", status_code=409)
    if fulfillment is not None and fulfillment.status == "fulfilled":
        if order.status == "paid":
            transition_order(order, "fulfilled")
        return _fulfilled_code(settings, order, plan)
    if fulfillment is None:
        fulfillment = OrderFulfillment(order_id=order.id, status="pending", attempts=0)
        db.add(fulfillment)
        db.flush()
    fulfillment.attempts += 1
    code: str | None = None
    if plan.plan_kind == "points":
        wallet, _idempotent = credit_order_points(db, order, plan, now=now)
        fulfillment.activation_code_id = None
        fulfillment.points_credited = plan.points_amount
        fulfillment.point_balance_after = wallet.balance_points
    elif plan.plan_kind == "license":
        code = order_card_code(settings, order.order_no)
        batch = CardBatch(
            plan_id=plan.id,
            name=f"Order {order.order_no}",
            quantity=1,
            duration_days=plan.duration_days,
            expires_at=None,
            status="active",
            created_by_user_id=order.user_id,
        )
        db.add(batch)
        db.flush()
        activation = ActivationCode(
            batch_id=batch.id,
            plan_id=plan.id,
            code_hash=hash_card_code(settings, code),
            code_prefix=code[:9],
            code_ciphertext=encrypt_card_code(settings, code),
            status="unused",
            owner_user_id=order.user_id,
            order_id=order.id,
        )
        db.add(activation)
        db.flush()
        fulfillment.activation_code_id = activation.id
        fulfillment.points_credited = 0
        fulfillment.point_balance_after = None
    else:
        raise DomainError("Paid order plan type is unsupported", status_code=409)
    fulfillment.status = "fulfilled"
    fulfillment.last_error = None
    fulfillment.fulfilled_at = now
    transition_order(order, "fulfilled")
    order.fulfilled_at = now
    _commission_fulfillment(db, settings, order, now)
    return code


def process_payment_success(
    db: Session,
    settings: Settings,
    *,
    provider: str,
    order_no: str,
    event_id: str,
    amount_cent: int,
    currency: str,
    payload_fingerprint: str,
    provider_payment_no: str | None = None,
) -> tuple[Order, str | None, bool]:
    existing_event = db.scalar(
        select(PaymentEvent).where(
            PaymentEvent.provider == provider,
            PaymentEvent.event_id == event_id,
        )
    )
    if existing_event is not None:
        order = db.get(Order, existing_event.order_id)
        if order is None:
            raise DomainError("Payment event order is unavailable", status_code=409)
        if order.order_no != order_no:
            raise DomainError("Payment event belongs to another order", status_code=409)
        code = _fulfilled_code(settings, order)
        return order, code, True
    order = db.scalar(select(Order).where(Order.order_no == order_no).with_for_update())
    if order is None:
        raise DomainError("Order not found", status_code=404)
    # A callback may have waited behind the order lock after its optimistic
    # idempotency lookup. Re-read under the lock before claiming the event.
    existing_event = db.scalar(
        select(PaymentEvent).where(
            PaymentEvent.provider == provider,
            PaymentEvent.event_id == event_id,
        )
    )
    if existing_event is not None:
        if existing_event.order_id != order.id:
            raise DomainError("Payment event belongs to another order", status_code=409)
        code = _fulfilled_code(settings, order)
        return order, code, True
    payment = db.scalar(
        select(Payment)
        .where(Payment.order_id == order.id, Payment.provider == provider)
        .with_for_update()
    )
    if payment is None:
        raise DomainError("Payment was not initialized", status_code=409)
    if amount_cent != order.amount_cent or currency != order.currency:
        raise DomainError("Payment amount or currency mismatch", status_code=409)
    if provider_payment_no:
        other_payment = db.scalar(
            select(Payment.id).where(
                Payment.provider == provider,
                Payment.provider_payment_no == provider_payment_no,
                Payment.id != payment.id,
            )
        )
        if other_payment is not None:
            raise DomainError("Provider payment belongs to another order", status_code=409)
    if order.status in {"closed", "refunded", "refunding"}:
        if order.status != "closed":
            raise DomainError("Order is not eligible for payment", status_code=409)
    now = datetime.now(UTC)
    event = PaymentEvent(
        provider=provider,
        event_id=event_id,
        order_id=order.id,
        payment_id=payment.id,
        event_type="payment_succeeded",
        amount_cent=amount_cent,
        currency=currency,
        payload_hash=hashlib.sha256(payload_fingerprint.encode()).hexdigest(),
        status="processed",
        processed_at=now,
    )
    try:
        # The database uniqueness constraint is the final guard for callbacks
        # racing on different workers or even maliciously different order numbers.
        with db.begin_nested():
            db.add(event)
            db.flush()
    except IntegrityError as exc:
        existing_event = db.scalar(
            select(PaymentEvent).where(
                PaymentEvent.provider == provider,
                PaymentEvent.event_id == event_id,
            )
        )
        if existing_event is None or existing_event.order_id != order.id:
            raise DomainError(
                "Payment event conflicts with another order", status_code=409
            ) from exc
        code = _fulfilled_code(settings, order)
        return order, code, True
    payment.status = "succeeded"
    if provider_payment_no:
        payment.provider_payment_no = provider_payment_no
    payment.paid_at = payment.paid_at or now
    order.payment_provider = provider
    order.provider_payment_no = provider_payment_no or payment.provider_payment_no
    order.paid_at = order.paid_at or now
    if order.status == "closed":
        order.closed_at = None
        transition_order(order, "paying")
    elif order.status in {"pending", "payment_failed"}:
        transition_order(order, "paying")
    if order.status == "paying":
        transition_order(order, "paid")
    code = _fulfill_order(db, settings, order, now)
    db.commit()
    db.refresh(order)
    return order, code, False


def query_payment(
    db: Session,
    settings: Settings,
    order: Order,
    *,
    now: datetime | None = None,
) -> Order:
    if order.status in {"paid", "fulfilled", "refunding", "refunded"}:
        return order
    if order.status == "closed":
        return order
    if not order.payment_provider:
        raise DomainError("Payment was not initialized", status_code=409)
    payment = db.scalar(
        select(Payment).where(
            Payment.order_id == order.id,
            Payment.provider == order.payment_provider,
        )
    )
    if payment is None:
        raise DomainError("Payment was not initialized", status_code=409)
    result = build_payment_provider(settings, payment.provider).query(order, payment)
    if result.status == "succeeded" and payment.status != "succeeded":
        if result.amount_cent is None or result.currency is None:
            raise DomainError("Payment query omitted amount or currency", status_code=502)
        process_payment_success(
            db,
            settings,
            provider=payment.provider,
            order_no=order.order_no,
            event_id=result.event_id or f"query:{payment.provider_payment_no}",
            amount_cent=result.amount_cent,
            currency=result.currency,
            payload_fingerprint=f"query:{payment.provider_payment_no}",
            provider_payment_no=result.provider_payment_no,
        )
    elif as_utc(order.expires_at) <= (now or datetime.now(UTC)) and order.status in {
        "pending",
        "paying",
        "payment_failed",
    }:
        transition_order(order, "closed")
        order.closed_at = now or datetime.now(UTC)
        db.commit()
    return order


def activation_code_for_order(settings: Settings, order: Order, user_id: int) -> str | None:
    if order.user_id != user_id or order.status != "fulfilled" or order.plan.plan_kind != "license":
        return None
    return order_card_code(settings, order.order_no)

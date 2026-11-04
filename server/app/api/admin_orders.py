from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.database.session import get_db
from app.models import (
    ActivationCode,
    CommissionRecord,
    Order,
    OrderFulfillment,
    Refund,
    User,
)
from app.schemas.admin_commerce import (
    AdminOrderRead,
    CommissionDashboard,
    CommissionRead,
    PaymentConfigStatus,
    ProviderStatus,
    RefundRead,
)
from app.schemas.commerce import RefundCreate
from app.schemas.common import Page
from app.services.admin_cleanup_service import delete_order_record
from app.services.errors import DomainError
from app.services.order_service import query_payment
from app.services.payments.providers import provider_configuration
from app.services.refund_service import request_refund
from app.services.sms import sms_provider_status

router = APIRouter(prefix="/admin", tags=["admin-commerce"], dependencies=[Depends(require_admin)])


def _order_read(db: Session, order: Order) -> AdminOrderRead:
    fulfillment = db.scalar(select(OrderFulfillment).where(OrderFulfillment.order_id == order.id))
    activation = (
        db.get(ActivationCode, fulfillment.activation_code_id)
        if fulfillment and fulfillment.activation_code_id
        else None
    )
    return AdminOrderRead(
        id=order.id,
        order_no=order.order_no,
        user_id=order.user_id,
        project_id=order.project_id,
        plan_id=order.plan_id,
        plan_kind=order.plan.plan_kind,
        points_amount=order.plan.points_amount,
        agent_id=order.agent_id,
        channel_id=order.channel_id,
        plan_name_snapshot=order.plan_name_snapshot,
        amount_cent=order.amount_cent,
        currency=order.currency,
        commission_rate_bps=order.commission_rate_bps,
        commission_amount_cent=order.commission_amount_cent,
        status=order.status,
        payment_provider=order.payment_provider,
        provider=order.payment_provider,
        provider_payment_no=order.provider_payment_no,
        activation_code_prefix=activation.code_prefix if activation else None,
        points_credited=fulfillment.points_credited if fulfillment else 0,
        point_balance_after=fulfillment.point_balance_after if fulfillment else None,
        created_at=order.created_at,
        expires_at=order.expires_at,
        paid_at=order.paid_at,
        fulfilled_at=order.fulfilled_at,
        refunded_at=order.refunded_at,
    )


def _release_available_commissions(db: Session) -> None:
    db.execute(
        update(CommissionRecord)
        .where(
            CommissionRecord.status == "pending",
            CommissionRecord.available_at.is_not(None),
            CommissionRecord.available_at <= datetime.now(UTC),
        )
        .values(status="available")
    )
    db.commit()


@router.get("/orders", response_model=Page[AdminOrderRead])
def list_orders(
    q: str | None = Query(default=None, max_length=128),
    user_id: int | None = Query(default=None, gt=0),
    project_id: int | None = Query(default=None, gt=0),
    plan_id: int | None = Query(default=None, gt=0),
    agent_id: int | None = Query(default=None, gt=0),
    channel_id: int | None = Query(default=None, gt=0),
    order_status: str | None = Query(default=None, alias="status", max_length=24),
    payment_provider: str | None = Query(default=None, max_length=24),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[AdminOrderRead]:
    filters = []
    if q:
        filters.append(or_(Order.order_no.contains(q), User.username.contains(q)))
    if user_id:
        filters.append(Order.user_id == user_id)
    if project_id:
        filters.append(Order.project_id == project_id)
    if plan_id:
        filters.append(Order.plan_id == plan_id)
    if agent_id:
        filters.append(Order.agent_id == agent_id)
    if channel_id:
        filters.append(Order.channel_id == channel_id)
    if order_status:
        filters.append(Order.status == order_status)
    if payment_provider:
        filters.append(Order.payment_provider == payment_provider)
    query = select(Order).join(User, User.id == Order.user_id)
    count_query = select(func.count(Order.id)).join(User, User.id == Order.user_id)
    total = db.scalar(count_query.where(*filters)) or 0
    orders = db.scalars(
        query.where(*filters)
        .order_by(Order.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(
        items=[_order_read(db, order) for order in orders],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/orders/{order_id}", response_model=AdminOrderRead)
def get_order(order_id: int, db: Session = Depends(get_db)) -> AdminOrderRead:
    order = db.get(Order, order_id)
    if order is None:
        raise DomainError("Order not found", status_code=404)
    return _order_read(db, order)


@router.delete("/orders/{order_id}", status_code=204)
def delete_order(order_id: int, db: Session = Depends(get_db)) -> None:
    order = db.get(Order, order_id)
    if order is None:
        raise DomainError("Order not found", status_code=404)
    delete_order_record(db, order)
    db.commit()


@router.post("/orders/{order_id}/query", response_model=AdminOrderRead)
def query_order_payment(
    order_id: int, request: Request, db: Session = Depends(get_db)
) -> AdminOrderRead:
    order = db.get(Order, order_id)
    if order is None:
        raise DomainError("Order not found", status_code=404)
    order = query_payment(db, request.app.state.settings, order)
    db.refresh(order)
    return _order_read(db, order)


@router.post("/orders/{order_id}/refund", response_model=RefundRead)
def refund_paid_order(
    order_id: int,
    payload: RefundCreate,
    request: Request,
    db: Session = Depends(get_db),
) -> Refund:
    return request_refund(
        db,
        request.app.state.settings,
        order_id,
        payload.amount_cent,
        payload.reason,
    )


@router.get("/commissions/dashboard", response_model=CommissionDashboard)
def commission_dashboard(db: Session = Depends(get_db)) -> CommissionDashboard:
    _release_available_commissions(db)
    rows = dict(
        db.execute(
            select(
                CommissionRecord.status,
                func.coalesce(func.sum(CommissionRecord.commission_amount_cent), 0),
            ).group_by(CommissionRecord.status)
        ).all()
    )
    return CommissionDashboard(
        records_total=db.scalar(select(func.count(CommissionRecord.id))) or 0,
        pending_cent=int(rows.get("pending", 0)),
        available_cent=int(rows.get("available", 0)),
        settled_cent=int(rows.get("settled", 0)),
        reversed_cent=int(rows.get("reversed", 0)),
    )


@router.get("/refunds", response_model=Page[RefundRead])
def list_refunds(
    order_id: int | None = Query(default=None, gt=0),
    refund_status: str | None = Query(default=None, alias="status", max_length=24),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[RefundRead]:
    filters = []
    if order_id:
        filters.append(Refund.order_id == order_id)
    if refund_status:
        filters.append(Refund.status == refund_status)
    total = db.scalar(select(func.count(Refund.id)).where(*filters)) or 0
    records = db.scalars(
        select(Refund)
        .where(*filters)
        .order_by(Refund.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(items=records, total=total, page=page, page_size=page_size)


@router.get("/commissions", response_model=Page[CommissionRead])
def list_commissions(
    agent_id: int | None = Query(default=None, gt=0),
    order_id: int | None = Query(default=None, gt=0),
    commission_status: str | None = Query(default=None, alias="status", max_length=24),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[CommissionRead]:
    _release_available_commissions(db)
    filters = []
    if agent_id:
        filters.append(CommissionRecord.agent_id == agent_id)
    if order_id:
        filters.append(CommissionRecord.order_id == order_id)
    if commission_status:
        filters.append(CommissionRecord.status == commission_status)
    total = db.scalar(select(func.count(CommissionRecord.id)).where(*filters)) or 0
    records = db.scalars(
        select(CommissionRecord)
        .where(*filters)
        .order_by(CommissionRecord.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(items=records, total=total, page=page, page_size=page_size)


@router.delete("/commissions/{commission_id}", status_code=204)
def delete_commission(commission_id: int, db: Session = Depends(get_db)) -> None:
    record = db.get(CommissionRecord, commission_id)
    if record is None:
        raise DomainError("Commission record not found", status_code=404)
    db.delete(record)
    db.commit()


@router.get("/payment-config/status", response_model=PaymentConfigStatus)
def payment_config_status(request: Request) -> PaymentConfigStatus:
    settings = request.app.state.settings
    providers = []
    for name in ("development", "wechat", "alipay"):
        configured, enabled, reason = provider_configuration(settings, name)
        providers.append(
            ProviderStatus(
                provider=name,
                configured=configured,
                enabled=enabled,
                reason=reason,
            )
        )
    sms_configured, _ = sms_provider_status(settings)
    return PaymentConfigStatus(
        default_provider=settings.payment_default_provider,
        providers=providers,
        sms_provider=settings.sms_provider,
        sms_configured=sms_configured,
    )

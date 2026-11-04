from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.helpers import rate_limit
from app.auth.dependencies import require_user_token
from app.database.session import get_db
from app.models import ActivationCode, Order, OrderFulfillment, Project, User
from app.schemas.commerce import (
    CustomerOrderRead,
    FulfillmentRead,
    OrderCreate,
    PaymentStartRequest,
    PaymentStartResponse,
)
from app.schemas.common import Page
from app.services.errors import DomainError
from app.services.order_service import (
    activation_code_for_order,
    create_order,
    create_payment_checkout,
    query_payment,
)

router = APIRouter(prefix="/orders", tags=["orders"])


def order_response(
    db: Session,
    settings,
    order: Order,
    *,
    user_id: int,
) -> CustomerOrderRead:
    fulfillment = db.scalar(select(OrderFulfillment).where(OrderFulfillment.order_id == order.id))
    activation = (
        db.get(ActivationCode, fulfillment.activation_code_id)
        if fulfillment and fulfillment.activation_code_id
        else None
    )
    code = activation_code_for_order(settings, order, user_id) if fulfillment else None
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
    project_code = order.project.code if order.project else db.get(Project, order.project_id).code
    return CustomerOrderRead(
        id=order.id,
        order_no=order.order_no,
        project_code=project_code,
        plan_kind=order.plan.plan_kind,
        points_amount=order.plan.points_amount,
        plan_name_snapshot=order.plan_name_snapshot,
        amount_cent=order.amount_cent,
        currency=order.currency,
        status=order.status,
        payment_provider=order.payment_provider,
        expires_at=order.expires_at,
        paid_at=order.paid_at,
        fulfilled_at=order.fulfilled_at,
        refunded_at=order.refunded_at,
        activation_code=code,
        fulfillment=fulfillment_read,
        created_at=order.created_at,
        updated_at=order.updated_at,
    )


@router.get("", response_model=Page[CustomerOrderRead])
def list_my_orders(
    request: Request,
    project_code: str | None = Query(default=None, max_length=64),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> Page[CustomerOrderRead]:
    filters = [Order.user_id == user.id]
    query = select(Order)
    count_query = select(func.count(Order.id))
    if project_code:
        query = query.join(Project, Project.id == Order.project_id)
        count_query = count_query.join(Project, Project.id == Order.project_id)
        filters.append(Project.code == project_code)
    total = db.scalar(count_query.where(*filters)) or 0
    orders = db.scalars(
        query.where(*filters)
        .order_by(Order.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(
        items=[
            order_response(db, request.app.state.settings, order, user_id=user.id)
            for order in orders
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("", response_model=CustomerOrderRead, status_code=201)
def place_order(
    payload: OrderCreate,
    request: Request,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> CustomerOrderRead:
    order = create_order(db, request.app.state.settings, user, payload)
    db.commit()
    db.refresh(order)
    return order_response(db, request.app.state.settings, order, user_id=user.id)


@router.get("/{order_id}", response_model=CustomerOrderRead)
def get_order(
    order_id: int,
    request: Request,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> CustomerOrderRead:
    order = db.get(Order, order_id)
    if order is None or order.user_id != user.id:
        raise DomainError("Order not found", status_code=404)
    return order_response(db, request.app.state.settings, order, user_id=user.id)


@router.post("/{order_id}/query", response_model=CustomerOrderRead)
def query_my_order_payment(
    order_id: int,
    request: Request,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> CustomerOrderRead:
    order = db.get(Order, order_id)
    if order is None or order.user_id != user.id:
        raise DomainError("Order not found", status_code=404)
    settings = request.app.state.settings
    rate_limit(
        request,
        "payment-query",
        f"{user.id}:{order.id}",
        settings.payment_query_rate_limit_per_minute,
        bind_ip=False,
    )
    order = query_payment(db, settings, order)
    db.refresh(order)
    return order_response(db, settings, order, user_id=user.id)


@router.post("/{order_id}/pay", response_model=PaymentStartResponse)
def pay_order(
    order_id: int,
    payload: PaymentStartRequest,
    request: Request,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> PaymentStartResponse:
    order, payment, code_url, qr_code_url = create_payment_checkout(
        db, request.app.state.settings, user, order_id, payload.provider
    )
    db.commit()
    return PaymentStartResponse(
        id=order.id,
        payment_id=payment.id,
        order_no=order.order_no,
        status=order.status,
        provider=payment.provider,
        amount_cent=payment.amount_cent,
        currency=payment.currency,
        code_url=code_url,
        qr_code_url=qr_code_url,
        expires_at=order.expires_at,
    )

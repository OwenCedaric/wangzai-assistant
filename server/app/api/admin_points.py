from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.api.points import point_package_read, point_wallet_read
from app.auth.dependencies import require_admin
from app.database.session import get_db
from app.models import (
    ActivationCode,
    CardBatch,
    CommissionRule,
    License,
    Order,
    Plan,
    PointLedgerEntry,
    PointWallet,
    Product,
    Project,
    UsageLog,
    User,
)
from app.models.paid_capabilities import PaidCapabilityRateCard
from app.schemas.common import Page
from app.schemas.points import (
    AdminPointWalletRead,
    PointLedgerRead,
    PointOperationResult,
    PointPackageCreate,
    PointPackageRead,
    PointPackageUpdate,
    PointWalletAdjustment,
)
from app.services.point_service import credit_points, expire_due_lots, spend_points

router = APIRouter(
    prefix="/admin",
    tags=["admin-points"],
    dependencies=[Depends(require_admin)],
)


def _point_plan(db: Session, plan_id: int) -> Plan:
    plan = db.scalar(
        select(Plan)
        .where(Plan.id == plan_id, Plan.plan_kind == "points")
        .options(joinedload(Plan.product).joinedload(Product.project))
    )
    if plan is None:
        raise HTTPException(status_code=404, detail="Point package not found")
    return plan


def _commit_plan(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=message) from exc


def _ceil_div(numerator: int, denominator: int) -> int:
    return (numerator + denominator - 1) // denominator


def _assert_point_package_pricing_compatible(
    db: Session,
    *,
    project_id: int,
    points_amount: int,
    sale_price_cent: int,
    online_sale_enabled: bool,
    status: str,
) -> None:
    if not online_sale_enabled or status != "active":
        return
    package_ratio = _ceil_div(points_amount * 100, sale_price_cent)
    now = datetime.now(UTC)
    minimum_rate_ratio = db.scalar(
        select(func.min(PaidCapabilityRateCard.points_per_cny)).where(
            PaidCapabilityRateCard.project_id == project_id,
            PaidCapabilityRateCard.status == "active",
            or_(
                PaidCapabilityRateCard.effective_until.is_(None),
                PaidCapabilityRateCard.effective_until > now,
            ),
        )
    )
    if minimum_rate_ratio is not None and package_ratio > minimum_rate_ratio:
        raise HTTPException(
            status_code=409,
            detail=(
                "Point package discount would underprice an active paid capability; "
                f"package requires at least {package_ratio} points/CNY pricing"
            ),
        )


@router.get("/point-packages", response_model=Page[PointPackageRead])
def list_admin_point_packages(
    request: Request,
    project_id: int | None = Query(default=None, gt=0),
    product_id: int | None = Query(default=None, gt=0),
    q: str | None = Query(default=None, max_length=128),
    package_status: str | None = Query(default=None, alias="status", max_length=24),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[PointPackageRead]:
    filters = [Plan.plan_kind == "points"]
    if project_id:
        filters.append(Project.id == project_id)
    if product_id:
        filters.append(Product.id == product_id)
    if q:
        filters.append(Plan.name.contains(q))
    if package_status:
        filters.append(Plan.status == package_status)
    base = (
        select(Plan)
        .join(Product, Product.id == Plan.product_id)
        .join(Project, Project.id == Product.project_id)
        .where(*filters)
    )
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    plans = db.scalars(
        base.options(joinedload(Plan.product).joinedload(Product.project))
        .order_by(Plan.display_order, Plan.sale_price_cent, Plan.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(
        items=[point_package_read(request, plan) for plan in plans],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/point-packages", response_model=PointPackageRead, status_code=201)
def create_point_package(
    payload: PointPackageCreate,
    request: Request,
    db: Session = Depends(get_db),
) -> PointPackageRead:
    product = db.scalar(
        select(Product).where(Product.id == payload.product_id).options(joinedload(Product.project))
    )
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    project = db.scalar(select(Project).where(Project.id == product.project_id).with_for_update())
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    _assert_point_package_pricing_compatible(
        db,
        project_id=product.project_id,
        points_amount=payload.points_amount,
        sale_price_cent=payload.sale_price_cent,
        online_sale_enabled=payload.online_sale_enabled,
        status=payload.status,
    )
    plan = Plan(
        product_id=product.id,
        name=payload.name,
        price=Decimal(payload.sale_price_cent) / Decimal(100),
        sale_price_cent=payload.sale_price_cent,
        online_sale_enabled=payload.online_sale_enabled,
        plan_kind="points",
        points_amount=payload.points_amount,
        customer_description=payload.customer_description,
        featured=payload.featured,
        display_order=payload.display_order,
        duration_days=payload.validity_days,
        max_devices=0,
        max_shops=0,
        offline_hours=0,
        status=payload.status,
        is_trial=False,
    )
    plan.product = product
    db.add(plan)
    _commit_plan(db, "Point package already exists for this product")
    db.refresh(plan)
    return point_package_read(request, _point_plan(db, plan.id))


@router.put("/point-packages/{plan_id}", response_model=PointPackageRead)
def update_point_package(
    plan_id: int,
    payload: PointPackageUpdate,
    request: Request,
    db: Session = Depends(get_db),
) -> PointPackageRead:
    plan = _point_plan(db, plan_id)
    project = db.scalar(
        select(Project).where(Project.id == plan.product.project_id).with_for_update()
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    data = payload.model_dump(exclude_unset=True)
    mapping = {"validity_days": "duration_days"}
    for key, value in data.items():
        setattr(plan, mapping.get(key, key), value)
    if "sale_price_cent" in data:
        plan.price = Decimal(plan.sale_price_cent) / Decimal(100)
    _assert_point_package_pricing_compatible(
        db,
        project_id=plan.product.project_id,
        points_amount=plan.points_amount,
        sale_price_cent=plan.sale_price_cent,
        online_sale_enabled=plan.online_sale_enabled,
        status=plan.status,
    )
    _commit_plan(db, "Point package update conflicts with existing data")
    db.refresh(plan)
    return point_package_read(request, _point_plan(db, plan.id))


@router.post("/point-packages/{plan_id}/stop-sales", response_model=PointPackageRead)
def stop_point_package_sales(
    plan_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> PointPackageRead:
    plan = _point_plan(db, plan_id)
    plan.online_sale_enabled = False
    db.commit()
    db.refresh(plan)
    return point_package_read(request, _point_plan(db, plan.id))


@router.delete("/point-packages/{plan_id}", status_code=204)
def delete_point_package(plan_id: int, db: Session = Depends(get_db)) -> None:
    plan = _point_plan(db, plan_id)
    dependency_models = (License, CardBatch, ActivationCode, Order, CommissionRule)
    dependency_count = sum(
        db.scalar(select(func.count(model.id)).where(model.plan_id == plan.id)) or 0
        for model in dependency_models
    )
    if dependency_count:
        raise HTTPException(
            status_code=409,
            detail="Point package is referenced; delete its orders and related records first",
        )
    db.delete(plan)
    db.commit()


@router.get("/point-wallets", response_model=Page[AdminPointWalletRead])
def list_admin_point_wallets(
    project_id: int | None = Query(default=None, gt=0),
    q: str | None = Query(default=None, max_length=128),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[AdminPointWalletRead]:
    filters = []
    if project_id:
        filters.append(PointWallet.project_id == project_id)
    if q:
        filters.append(
            or_(
                User.username.contains(q),
                User.email.contains(q),
                User.phone_masked.contains(q),
            )
        )
    query = (
        select(PointWallet, User, Project)
        .join(User, User.id == PointWallet.user_id)
        .join(Project, Project.id == PointWallet.project_id)
        .where(*filters)
    )
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(
        query.order_by(PointWallet.updated_at.desc(), PointWallet.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    items: list[AdminPointWalletRead] = []
    for wallet, user, project in rows:
        expire_due_lots(db, wallet)
        db.flush()
        base = point_wallet_read(db, wallet, project.code)
        items.append(
            AdminPointWalletRead(
                **base.model_dump(),
                username=user.username,
                email=user.email,
                phone_masked=user.phone_masked or user.phone,
            )
        )
    db.commit()
    return Page(items=items, total=total, page=page, page_size=page_size)


@router.post(
    "/point-wallets/{wallet_id}/adjust",
    response_model=PointOperationResult,
)
def adjust_point_wallet(
    wallet_id: int,
    payload: PointWalletAdjustment,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> PointOperationResult:
    wallet = db.scalar(select(PointWallet).where(PointWallet.id == wallet_id).with_for_update())
    if wallet is None:
        raise HTTPException(status_code=404, detail="Point wallet not found")
    project = db.get(Project, wallet.project_id)
    if project is None:
        raise HTTPException(status_code=409, detail="Point wallet project is unavailable")
    key = f"admin:{admin.id}:{payload.idempotency_key}"
    if payload.operation == "credit":
        expires_at = (
            datetime.now(UTC) + timedelta(days=payload.validity_days)
            if payload.validity_days
            else None
        )
        wallet, _lot, idempotent = credit_points(
            db,
            user_id=wallet.user_id,
            project_id=wallet.project_id,
            amount_points=payload.amount_points,
            idempotency_key=key,
            event_type="admin_credit",
            reason=payload.reason,
            expires_at=expires_at,
            reference_type="admin",
            reference_id=str(admin.id),
        )
    else:
        wallet, idempotent = spend_points(
            db,
            user_id=wallet.user_id,
            project_id=wallet.project_id,
            amount_points=payload.amount_points,
            idempotency_key=key,
            event_type="admin_debit",
            reason=payload.reason,
            reference_type="admin",
            reference_id=str(admin.id),
        )
    db.add(
        UsageLog(
            user_id=admin.id,
            project_id=wallet.project_id,
            event="point_wallet_adjusted",
            details={
                "wallet_id": wallet.id,
                "operation": payload.operation,
                "amount_points": payload.amount_points,
                "idempotent": idempotent,
            },
        )
    )
    db.commit()
    db.refresh(wallet)
    return PointOperationResult(
        wallet=point_wallet_read(db, wallet, project.code),
        idempotent=idempotent,
    )


@router.delete("/point-wallets/{wallet_id}", status_code=204)
def delete_point_wallet(wallet_id: int, db: Session = Depends(get_db)) -> None:
    wallet = db.get(PointWallet, wallet_id)
    if wallet is None:
        raise HTTPException(status_code=404, detail="Point wallet not found")
    db.delete(wallet)
    db.commit()


@router.get("/point-ledger", response_model=Page[PointLedgerRead])
def list_admin_point_ledger(
    wallet_id: int | None = Query(default=None, gt=0),
    project_id: int | None = Query(default=None, gt=0),
    user_id: int | None = Query(default=None, gt=0),
    event_type: str | None = Query(default=None, max_length=48),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[PointLedgerRead]:
    filters = []
    if wallet_id:
        filters.append(PointLedgerEntry.wallet_id == wallet_id)
    if project_id:
        filters.append(PointLedgerEntry.project_id == project_id)
    if user_id:
        filters.append(PointLedgerEntry.user_id == user_id)
    if event_type:
        filters.append(PointLedgerEntry.event_type == event_type)
    total = db.scalar(select(func.count(PointLedgerEntry.id)).where(*filters)) or 0
    entries = db.scalars(
        select(PointLedgerEntry)
        .where(*filters)
        .order_by(PointLedgerEntry.created_at.desc(), PointLedgerEntry.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(
        items=[PointLedgerRead.model_validate(entry, from_attributes=True) for entry in entries],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.delete("/point-ledger/{entry_id}", status_code=204)
def delete_point_ledger_entry(entry_id: int, db: Session = Depends(get_db)) -> None:
    entry = db.get(PointLedgerEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Point ledger entry not found")
    db.delete(entry)
    db.commit()

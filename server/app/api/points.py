from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.auth.dependencies import require_user_token
from app.database.session import get_db
from app.models import Plan, PointLedgerEntry, PointWallet, Product, Project, User
from app.schemas.common import Page
from app.schemas.points import (
    PointLedgerRead,
    PointOperationResult,
    PointPackageRead,
    PointSpendRequest,
    PointWalletRead,
)
from app.services.payments.providers import provider_configuration
from app.services.point_service import (
    expire_due_lots,
    project_by_code,
    spend_points,
    wallet_for_update,
    wallet_next_expiry,
)

router = APIRouter(prefix="/points", tags=["points"])


def point_package_read(request: Request, plan: Plan) -> PointPackageRead:
    providers = [
        name
        for name in ("wechat", "alipay", "development")
        if provider_configuration(request.app.state.settings, name)[1]
    ]
    return PointPackageRead(
        id=plan.id,
        project_id=plan.product.project.id,
        project_code=plan.product.project.code,
        product_id=plan.product.id,
        product_name=plan.product.name,
        name=plan.name,
        points_amount=plan.points_amount,
        sale_price_cent=plan.sale_price_cent,
        validity_days=plan.duration_days,
        customer_description=plan.customer_description,
        featured=plan.featured,
        display_order=plan.display_order,
        online_sale_enabled=plan.online_sale_enabled,
        status=plan.status,
        payment_providers=providers,
        created_at=plan.created_at,
        updated_at=plan.updated_at,
    )


def point_wallet_read(db: Session, wallet: PointWallet, project_code: str) -> PointWalletRead:
    next_expiry, next_expiring_points = wallet_next_expiry(db, wallet.id)
    return PointWalletRead(
        wallet_id=wallet.id,
        user_id=wallet.user_id,
        project_id=wallet.project_id,
        project_code=project_code,
        balance_points=wallet.balance_points,
        reserved_points=wallet.reserved_points,
        available_points=wallet.balance_points - wallet.reserved_points,
        lifetime_credited_points=wallet.lifetime_credited_points,
        lifetime_spent_points=wallet.lifetime_spent_points,
        next_expiry=next_expiry,
        next_expiring_points=next_expiring_points,
        updated_at=wallet.updated_at,
    )


@router.get("/packages", response_model=Page[PointPackageRead])
def list_point_packages(
    request: Request,
    response: Response,
    project_code: str = Query(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=64),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    _user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> Page[PointPackageRead]:
    # 套餐由管理后台动态上架，禁止浏览器或桌面 WebView 缓存旧目录。
    response.headers["Cache-Control"] = "no-store"
    filters = (
        Project.code == project_code,
        Project.status == "active",
        Product.status == "active",
        Plan.plan_kind == "points",
        Plan.status == "active",
        Plan.online_sale_enabled.is_(True),
        Plan.sale_price_cent > 0,
        Plan.points_amount > 0,
    )
    total = (
        db.scalar(
            select(func.count(Plan.id))
            .join(Product, Product.id == Plan.product_id)
            .join(Project, Project.id == Product.project_id)
            .where(*filters)
        )
        or 0
    )
    plans = db.scalars(
        select(Plan)
        .join(Product, Product.id == Plan.product_id)
        .join(Project, Project.id == Product.project_id)
        .where(*filters)
        .options(joinedload(Plan.product).joinedload(Product.project))
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


@router.get("/wallet", response_model=PointWalletRead)
def get_point_wallet(
    project_code: str = Query(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=64),
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> PointWalletRead:
    project = project_by_code(db, project_code)
    wallet = wallet_for_update(
        db,
        user_id=user.id,
        project_id=project.id,
        create=True,
    )
    assert wallet is not None
    expire_due_lots(db, wallet)
    db.commit()
    db.refresh(wallet)
    return point_wallet_read(db, wallet, project.code)


@router.get("/ledger", response_model=Page[PointLedgerRead])
def list_point_ledger(
    project_code: str = Query(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=64),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> Page[PointLedgerRead]:
    project = project_by_code(db, project_code)
    wallet = wallet_for_update(
        db,
        user_id=user.id,
        project_id=project.id,
        create=True,
    )
    assert wallet is not None
    expire_due_lots(db, wallet)
    db.commit()
    total = (
        db.scalar(
            select(func.count(PointLedgerEntry.id)).where(PointLedgerEntry.wallet_id == wallet.id)
        )
        or 0
    )
    entries = db.scalars(
        select(PointLedgerEntry)
        .where(PointLedgerEntry.wallet_id == wallet.id)
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


@router.post("/spend", response_model=PointOperationResult)
def spend_user_points(
    payload: PointSpendRequest,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> PointOperationResult:
    project = project_by_code(db, payload.project_code)
    wallet, idempotent = spend_points(
        db,
        user_id=user.id,
        project_id=project.id,
        amount_points=payload.amount_points,
        idempotency_key=payload.idempotency_key,
        reason=payload.reason,
        reference_type=payload.reference_type,
        reference_id=payload.reference_id,
    )
    db.commit()
    db.refresh(wallet)
    return PointOperationResult(
        wallet=point_wallet_read(db, wallet, project.code),
        idempotent=idempotent,
    )

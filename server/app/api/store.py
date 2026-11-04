from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.database.session import get_db
from app.licensing.shop_card_policy import STANDARD_SHOP_CARD_ROLES
from app.models import Permission, Plan, Product, Project
from app.schemas.commerce import StorePlanRead
from app.schemas.common import Page
from app.services.payments.providers import provider_configuration

router = APIRouter(prefix="/store", tags=["store"])


@router.get("/plans", response_model=Page[StorePlanRead])
def list_store_plans(
    request: Request,
    project_code: str = Query(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=64),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[StorePlanRead]:
    payment_providers = [
        name
        for name in ("wechat", "alipay", "development")
        if provider_configuration(request.app.state.settings, name)[1]
    ]
    filters = (
        Project.code == project_code,
        Project.status == "active",
        Product.status == "active",
        Plan.status == "active",
        Plan.plan_kind == "license",
        Plan.license_role.in_(STANDARD_SHOP_CARD_ROLES),
        Plan.online_sale_enabled.is_(True),
        Plan.sale_price_cent > 0,
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
        .options(
            joinedload(Plan.product).joinedload(Product.project),
            selectinload(Plan.permissions),
        )
        .order_by(Plan.sale_price_cent, Plan.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    items = [
        StorePlanRead(
            id=plan.id,
            project_id=plan.product.project.id,
            project_code=plan.product.project.code,
            product_id=plan.product.id,
            product_name=plan.product.name,
            name=plan.name,
            license_role=plan.license_role,
            sale_price_cent=plan.sale_price_cent,
            duration_days=plan.duration_days,
            max_devices=plan.max_devices,
            max_shops=plan.max_shops,
            offline_hours=plan.offline_hours,
            online_required=plan.offline_hours == 0,
            permission_codes=sorted(
                permission.code
                for permission in plan.permissions
                if isinstance(permission, Permission) and permission.status == "active"
            ),
            payment_providers=payment_providers,
        )
        for plan in plans
    ]
    return Page(items=items, total=total, page=page, page_size=page_size)

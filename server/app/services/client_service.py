from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.auth.dependencies import CurrentPrincipal
from app.licensing.shop_card_policy import is_shop_card_role
from app.models import Device, License, Plan, Product, Project, Shop, UsageLog
from app.models.base import as_utc
from app.schemas.licensing import BindOwnedShopLicenseRequest, ShopBindRequest
from app.services.errors import DomainError


def validate_license_lifecycle(license_record: License, now: datetime):
    if license_record.status != "active":
        raise DomainError("License is not active", status_code=403)
    if (as_utc(license_record.start_time) or now) > now:
        raise DomainError("License has not started", status_code=403)
    if (as_utc(license_record.expire_time) or now) <= now:
        raise DomainError("License has expired", status_code=403)
    if license_record.plan.status != "active" or license_record.plan.product.status != "active":
        raise DomainError("Plan or product is disabled", status_code=403)
    project = license_record.plan.product.project
    if project.status != "active":
        raise DomainError("Project is disabled", status_code=403)
    return project


def get_active_principal_license(
    db: Session, principal: CurrentPrincipal, *, require_device: bool = True
) -> License:
    if principal.token_type != "license" or principal.license_id is None:
        raise DomainError("A license token is required", status_code=403)
    license_record = db.scalar(
        select(License)
        .where(License.id == principal.license_id)
        .options(joinedload(License.plan).joinedload(Plan.product).joinedload(Product.project))
    )
    if license_record is None or license_record.user_id != principal.user_id:
        raise DomainError("License not found", status_code=404)
    project = validate_license_lifecycle(license_record, datetime.now(UTC))
    if project.code != principal.project_code:
        raise DomainError("License token project mismatch", status_code=403)
    if require_device:
        device = db.scalar(
            select(Device).where(
                Device.license_id == license_record.id,
                Device.device_code == principal.device_code,
                Device.status == "active",
            )
        )
        if device is None:
            raise DomainError("License device is not active", status_code=403)
    return license_record


def bind_shop(db: Session, principal: CurrentPrincipal, payload: ShopBindRequest) -> Shop:
    license_record = db.scalar(
        select(License)
        .where(License.license_key == payload.license_key)
        .options(joinedload(License.plan).joinedload(Plan.product).joinedload(Product.project))
        .with_for_update(of=License)
    )
    if license_record is None or license_record.user_id != principal.user_id:
        raise DomainError("License not found", status_code=404)
    if principal.license_id and principal.license_id != license_record.id:
        raise DomainError("License token does not match license_key", status_code=403)
    if principal.token_type == "license" and principal.project_code != payload.project_code:
        raise DomainError("License token is bound to another project", status_code=403)
    now = datetime.now(UTC)
    project = validate_license_lifecycle(license_record, now)
    if project.code != payload.project_code:
        raise DomainError("License belongs to another project", status_code=403)
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    single_shop_card = is_shop_card_role(license_record.plan.license_role)
    if single_shop_card and payload.platform != "ozon":
        raise DomainError("Shop cards can only bind an Ozon shop", status_code=422)
    assigned_shops = db.scalars(
        select(Shop).where(Shop.license_id == license_record.id).order_by(Shop.id)
    ).all()
    existing = next(
        (
            shop
            for shop in assigned_shops
            if shop.platform == payload.platform and shop.shop_id == payload.shop_id
        ),
        None,
    )
    if single_shop_card and assigned_shops and existing is None:
        raise DomainError(
            "This card is permanently assigned to another shop",
            status_code=409,
        )
    conflicting_shop = db.scalar(
        select(Shop.id).where(
            Shop.project_id == project.id,
            Shop.platform == payload.platform,
            Shop.shop_id == payload.shop_id,
            Shop.license_id != license_record.id,
        )
    )
    if conflicting_shop is not None:
        raise DomainError("This shop is already assigned to another card", status_code=409)
    if existing:
        if existing.status == "disabled":
            raise DomainError("Shop binding is disabled by an administrator", status_code=403)
        if existing.status != "active":
            count = (
                db.scalar(
                    select(func.count(Shop.id)).where(
                        Shop.license_id == license_record.id, Shop.status == "active"
                    )
                )
                or 0
            )
            if license_record.plan.max_shops > 0 and count >= license_record.plan.max_shops:
                raise DomainError("Shop limit reached", status_code=409)
        existing.shop_name = payload.shop_name
        existing.status = "active"
        db.commit()
        db.refresh(existing)
        return existing
    count = (
        db.scalar(
            select(func.count(Shop.id)).where(
                Shop.license_id == license_record.id, Shop.status == "active"
            )
        )
        or 0
    )
    if license_record.plan.max_shops > 0 and count >= license_record.plan.max_shops:
        raise DomainError("Shop limit reached", status_code=409)
    shop = Shop(
        user_id=principal.user_id,
        license_id=license_record.id,
        project_id=project.id,
        platform=payload.platform,
        shop_name=payload.shop_name,
        shop_id=payload.shop_id,
    )
    db.add(shop)
    db.add(
        UsageLog(
            user_id=principal.user_id,
            project_id=project.id,
            license_id=license_record.id,
            event="shop_bind",
            details={"platform": payload.platform},
        )
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise DomainError(
            "This shop is already assigned to another card",
            status_code=409,
        ) from exc
    db.refresh(shop)
    return shop


def bind_owned_shop_license(
    db: Session,
    user_id: int,
    payload: BindOwnedShopLicenseRequest,
) -> Shop:
    license_record = db.scalar(
        select(License)
        .where(License.id == payload.license_id, License.user_id == user_id)
        .with_for_update(of=License)
    )
    if license_record is None:
        raise DomainError("License not found", status_code=404)
    return bind_shop(
        db,
        CurrentPrincipal(
            user_id=user_id,
            token_type="user",
            license_id=None,
            project_code=None,
            device_code=None,
        ),
        ShopBindRequest(
            license_key=license_record.license_key,
            project_code=payload.project_code,
            platform="ozon",
            shop_name=payload.shop_name,
            shop_id=payload.shop_id,
        ),
    )

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.api.helpers import rate_limit
from app.auth.dependencies import CurrentPrincipal, get_current_user, get_principal
from app.config import Settings
from app.database.session import get_db
from app.models import Device, License, Plan, Product, Shop, UsageLog, User
from app.schemas.admin import UsageEventCreate, UsageLogRead
from app.schemas.licensing import DeviceRead, ShopBindRequest, ShopRead
from app.services.client_service import (
    bind_shop,
    get_active_principal_license,
    validate_license_lifecycle,
)

router = APIRouter(tags=["client"])


@router.get("/devices", response_model=list[DeviceRead])
def list_my_devices(
    principal: CurrentPrincipal = Depends(get_principal),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    filters = [Device.user_id == user.id]
    if principal.token_type == "license":
        get_active_principal_license(db, principal)
        filters.append(Device.license_id == principal.license_id)
        filters.append(Device.device_code == principal.device_code)
    return db.scalars(select(Device).where(*filters).order_by(Device.created_at.desc())).all()


@router.get("/shops", response_model=list[ShopRead])
def list_my_shops(
    principal: CurrentPrincipal = Depends(get_principal),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    filters = [Shop.user_id == user.id]
    if principal.token_type == "license":
        get_active_principal_license(db, principal)
        filters.append(Shop.license_id == principal.license_id)
    return db.scalars(select(Shop).where(*filters).order_by(Shop.created_at.desc())).all()


@router.post("/shops/bind", response_model=ShopRead, status_code=201)
def bind_my_shop(
    payload: ShopBindRequest,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if principal.token_type == "license":
        get_active_principal_license(db, principal)
    return bind_shop(db, principal, payload)


@router.delete("/shops/{shop_id}", status_code=204)
def unbind_my_shop(
    shop_id: int,
    principal: CurrentPrincipal = Depends(get_principal),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    shop = db.get(Shop, shop_id)
    if shop is None or shop.user_id != user.id:
        raise HTTPException(status_code=404, detail="Shop not found")
    if principal.token_type == "license":
        get_active_principal_license(db, principal)
        if shop.license_id != principal.license_id:
            raise HTTPException(status_code=403, detail="Shop belongs to another license")
    shop.status = "unbound"
    db.commit()


@router.post("/usage/log", response_model=UsageLogRead, status_code=201)
def log_usage(
    payload: UsageEventCreate,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    rate_limit(request, "usage", str(principal.user_id), settings.license_rate_limit_per_minute)
    license_record = db.scalar(
        select(License)
        .where(License.license_key == payload.license_key)
        .options(joinedload(License.plan).joinedload(Plan.product).joinedload(Product.project))
    )
    if license_record is None or license_record.user_id != principal.user_id:
        raise HTTPException(status_code=404, detail="License not found")
    if principal.license_id and principal.license_id != license_record.id:
        raise HTTPException(status_code=403, detail="License token mismatch")
    if principal.token_type == "license":
        get_active_principal_license(db, principal)
    project = validate_license_lifecycle(license_record, datetime.now(UTC))
    if project.code != payload.project_code:
        raise HTTPException(status_code=403, detail="Project mismatch")
    if principal.token_type == "license" and (
        principal.project_code != payload.project_code
        or (payload.device_code and principal.device_code != payload.device_code)
    ):
        raise HTTPException(status_code=403, detail="License token binding mismatch")
    if payload.device_code:
        device = db.scalar(
            select(Device).where(
                Device.license_id == license_record.id,
                Device.device_code == payload.device_code,
                Device.status == "active",
            )
        )
        if device is None:
            raise HTTPException(status_code=403, detail="Device is not active for this license")
    log = UsageLog(
        user_id=principal.user_id,
        project_id=project.id,
        license_id=license_record.id,
        event=payload.event,
        device_code=(
            principal.device_code if principal.token_type == "license" else payload.device_code
        ),
        details=payload.details,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log

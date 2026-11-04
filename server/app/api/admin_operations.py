from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.auth.security import hash_password
from app.database.session import get_db
from app.models import (
    Device,
    License,
    Shop,
    UsageLog,
    User,
    UserProjectAttribution,
)
from app.schemas.admin import (
    DashboardStats,
    UsageLogRead,
)
from app.schemas.auth import UserCreate, UserRead, UserUpdate
from app.schemas.common import Page
from app.schemas.licensing import (
    DeviceRead,
    DeviceStatusUpdate,
    LicenseGrantCreate,
    LicenseRead,
    LicenseStatusUpdate,
    ShopRead,
    ShopStatusUpdate,
)
from app.services.admin_cleanup_service import delete_license_record, delete_user_record
from app.services.identity_service import protect_phone
from app.services.license_service import effective_device_limit, grant_license
from app.services.stats_service import dashboard_stats

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _paged(db: Session, query, count_query, page: int, page_size: int):
    total = db.scalar(count_query) or 0
    items = db.scalars(query.offset((page - 1) * page_size).limit(page_size)).all()
    return Page(items=items, total=total, page=page, page_size=page_size)


@router.get("/dashboard", response_model=DashboardStats)
@router.get("/stats", response_model=DashboardStats, include_in_schema=False)
def dashboard(request: Request, db: Session = Depends(get_db)):
    return dashboard_stats(
        db,
        request.app.state.presence,
        request.app.state.settings.online_window_minutes,
    )


@router.get("/users", response_model=Page[UserRead])
def list_users(
    q: str | None = Query(default=None, max_length=128),
    user_status: str | None = Query(default=None, alias="status"),
    agent_id: int | None = Query(default=None, gt=0),
    project_id: int | None = Query(default=None, gt=0),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    filters = []
    if q:
        filters.append(
            or_(
                User.username.contains(q),
                User.email.contains(q),
                User.phone.contains(q),
                User.phone_masked.contains(q),
            )
        )
    if user_status:
        filters.append(User.status == user_status)
    query = select(User)
    count_query = select(func.count(func.distinct(User.id)))
    if agent_id or project_id:
        query = query.join(UserProjectAttribution)
        count_query = count_query.join(UserProjectAttribution)
    if agent_id:
        filters.append(UserProjectAttribution.agent_id == agent_id)
    if project_id:
        filters.append(UserProjectAttribution.project_id == project_id)
    total = db.scalar(count_query.where(*filters)) or 0
    items = (
        db.scalars(
            query.where(*filters)
            .order_by(User.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .unique()
        .all()
    )
    return Page(items=items, total=total, page=page, page_size=page_size)


@router.post("/users", response_model=UserRead, status_code=201)
def create_user(payload: UserCreate, request: Request, db: Session = Depends(get_db)):
    email = payload.email.strip().lower() if payload.email else None
    user = User(
        username=email or payload.username,
        password_hash=hash_password(payload.password),
        email=email,
        status=payload.status,
        is_admin=payload.is_admin,
        device_limit_exempt=payload.device_limit_exempt,
    )
    if payload.phone is not None:
        protect_phone(request.app.state.settings, user, payload.phone, verified=False)
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="Username, email, or phone already exists"
        ) from exc
    db.refresh(user)
    return user


@router.get("/users/{user_id}", response_model=UserRead)
def get_user(user_id: int, db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.put("/users/{user_id}", response_model=UserRead)
def update_user(
    user_id: int,
    payload: UserUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id and (payload.status == "disabled" or payload.is_admin is False):
        raise HTTPException(status_code=409, detail="Cannot disable or demote the current admin")
    data = payload.model_dump(exclude_unset=True)
    password = data.pop("password", None)
    phone_marker = object()
    phone = data.pop("phone", phone_marker)
    if password:
        user.password_hash = hash_password(password)
    if phone is not phone_marker:
        protect_phone(request.app.state.settings, user, phone, verified=False)
    if "email" in data and data["email"]:
        data["email"] = data["email"].strip().lower()
        user.username = data["email"]
    for key, value in data.items():
        setattr(user, key, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Email or phone already exists") from exc
    db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=409, detail="Cannot delete the current admin")
    delete_user_record(db, user, admin)
    db.commit()


@router.get("/licenses", response_model=Page[LicenseRead])
def list_licenses(
    user_id: int | None = Query(default=None, gt=0),
    plan_id: int | None = Query(default=None, gt=0),
    license_status: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    filters = []
    if user_id:
        filters.append(License.user_id == user_id)
    if plan_id:
        filters.append(License.plan_id == plan_id)
    if license_status:
        filters.append(License.status == license_status)
    return _paged(
        db,
        select(License).where(*filters).order_by(License.created_at.desc()),
        select(func.count(License.id)).where(*filters),
        page,
        page_size,
    )


@router.post("/licenses", response_model=LicenseRead, status_code=201)
def create_license(payload: LicenseGrantCreate, db: Session = Depends(get_db)):
    return grant_license(db, payload)


@router.get("/licenses/{license_id}", response_model=LicenseRead)
def get_license(license_id: int, db: Session = Depends(get_db)):
    license_record = db.get(License, license_id)
    if license_record is None:
        raise HTTPException(status_code=404, detail="License not found")
    return license_record


@router.put("/licenses/{license_id}", response_model=LicenseRead)
def update_license_status(
    license_id: int, payload: LicenseStatusUpdate, db: Session = Depends(get_db)
):
    license_record = db.get(License, license_id)
    if license_record is None:
        raise HTTPException(status_code=404, detail="License not found")
    license_record.status = payload.status
    if payload.status != "active":
        license_record.offline_until = None
    db.commit()
    db.refresh(license_record)
    return license_record


@router.delete("/licenses/{license_id}", status_code=204)
def delete_license(license_id: int, db: Session = Depends(get_db)) -> None:
    license_record = db.get(License, license_id)
    if license_record is None:
        raise HTTPException(status_code=404, detail="License not found")
    delete_license_record(db, license_record)
    db.commit()


@router.get("/devices", response_model=Page[DeviceRead])
def list_devices(
    user_id: int | None = Query(default=None, gt=0),
    license_id: int | None = Query(default=None, gt=0),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    filters = []
    if user_id:
        filters.append(Device.user_id == user_id)
    if license_id:
        filters.append(Device.license_id == license_id)
    return _paged(
        db,
        select(Device).where(*filters).order_by(Device.created_at.desc()),
        select(func.count(Device.id)).where(*filters),
        page,
        page_size,
    )


@router.put("/devices/{device_id}", response_model=DeviceRead)
def update_device(device_id: int, payload: DeviceStatusUpdate, db: Session = Depends(get_db)):
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if payload.status == "active" and device.status != "active":
        license_record = db.scalar(
            select(License).where(License.id == device.license_id).with_for_update()
        )
        if license_record is None:
            raise HTTPException(status_code=404, detail="License not found")
        db.refresh(device)
        if device.status != "active":
            active_count = (
                db.scalar(
                    select(func.count(Device.id)).where(
                        Device.license_id == license_record.id,
                        Device.status == "active",
                    )
                )
                or 0
            )
            limit = effective_device_limit(db, license_record)
            if limit > 0 and active_count >= limit:
                raise HTTPException(status_code=409, detail="Device limit reached")
    device.status = payload.status
    db.commit()
    db.refresh(device)
    return device


@router.get("/devices/{device_id}", response_model=DeviceRead)
def get_device(device_id: int, db: Session = Depends(get_db)):
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.delete("/devices/{device_id}", status_code=204)
def delete_device(device_id: int, db: Session = Depends(get_db)) -> None:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    db.delete(device)
    db.commit()


@router.get("/shops", response_model=Page[ShopRead])
def list_shops(
    platform: str | None = Query(default=None, max_length=32),
    user_id: int | None = Query(default=None, gt=0),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    filters = []
    if platform:
        filters.append(Shop.platform == platform)
    if user_id:
        filters.append(Shop.user_id == user_id)
    return _paged(
        db,
        select(Shop).where(*filters).order_by(Shop.created_at.desc()),
        select(func.count(Shop.id)).where(*filters),
        page,
        page_size,
    )


@router.put("/shops/{shop_id}", response_model=ShopRead)
def update_shop(shop_id: int, payload: ShopStatusUpdate, db: Session = Depends(get_db)):
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=404, detail="Shop not found")
    shop.status = payload.status
    db.commit()
    db.refresh(shop)
    return shop


@router.get("/shops/{shop_id}", response_model=ShopRead)
def get_shop(shop_id: int, db: Session = Depends(get_db)):
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=404, detail="Shop not found")
    return shop


@router.delete("/shops/{shop_id}", status_code=204)
def delete_shop(shop_id: int, db: Session = Depends(get_db)) -> None:
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=404, detail="Shop not found")
    db.delete(shop)
    db.commit()


@router.get("/usage-logs", response_model=Page[UsageLogRead])
def list_usage_logs(
    user_id: int | None = Query(default=None, gt=0),
    project_id: int | None = Query(default=None, gt=0),
    event: str | None = Query(default=None, max_length=96),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    filters = []
    if user_id:
        filters.append(UsageLog.user_id == user_id)
    if project_id:
        filters.append(UsageLog.project_id == project_id)
    if event:
        filters.append(UsageLog.event == event)
    return _paged(
        db,
        select(UsageLog).where(*filters).order_by(UsageLog.created_at.desc()),
        select(func.count(UsageLog.id)).where(*filters),
        page,
        page_size,
    )


@router.delete("/usage-logs/{log_id}", status_code=204)
def delete_usage_log(log_id: int, db: Session = Depends(get_db)) -> None:
    usage_log = db.get(UsageLog, log_id)
    if usage_log is None:
        raise HTTPException(status_code=404, detail="Usage log not found")
    db.delete(usage_log)
    db.commit()

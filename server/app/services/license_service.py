from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import case, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from app.auth.dependencies import CurrentPrincipal
from app.auth.offline import create_offline_token
from app.auth.security import create_access_token
from app.config import Settings
from app.licensing.shop_card_policy import (
    LICENSE_ROLE_LEGACY,
    LICENSE_ROLE_SHOP_INTRO,
    STANDARD_SHOP_CARD_ROLES,
)
from app.models import (
    ActivationCode,
    CardBatch,
    Device,
    License,
    Plan,
    Product,
    Project,
    Shop,
    ShopIntroRedemption,
    UsageLog,
    User,
)
from app.models.base import as_utc
from app.schemas.licensing import (
    ActivateRequest,
    ActivateShopRequest,
    CheckRequest,
    HeartbeatRequest,
    LicenseGrantCreate,
    LicenseResult,
    LicenseShopSummary,
    RenewRequest,
    UserShopLicenseSummary,
)
from app.services.card_service import hash_card_code, normalize_card_code
from app.services.errors import DomainError


def _plan_query(plan_id: int):
    return (
        select(Plan)
        .where(Plan.id == plan_id)
        .options(
            joinedload(Plan.product).joinedload(Product.project),
            selectinload(Plan.permissions),
        )
    )


def _license_query():
    return select(License).options(
        joinedload(License.plan).joinedload(Plan.product).joinedload(Product.project),
        joinedload(License.plan).selectinload(Plan.permissions),
    )


def _new_license_key() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "LIC-" + "-".join("".join(secrets.choice(alphabet) for _ in range(5)) for _ in range(4))


def _validate_project_version(
    project: Project, version: str | None, version_hash: str | None
) -> str | None:
    if project.status != "active":
        return "project_disabled"
    if version is not None and version != project.version:
        return "version_not_supported"
    if project.version_hash and version_hash != project.version_hash:
        return "version_hash_mismatch"
    return None


def _license_state_reason(license_record: License, now: datetime) -> str | None:
    if license_record.status != "active":
        return f"license_{license_record.status}"
    if (as_utc(license_record.start_time) or now) > now:
        return "license_not_started"
    if (as_utc(license_record.expire_time) or now) <= now:
        return "license_expired"
    if license_record.plan.status != "active":
        return "plan_disabled"
    if license_record.plan.product.status != "active":
        return "product_disabled"
    return None


def effective_device_limit(db: Session, license_record: License) -> int:
    exempt = db.scalar(
        select(User.device_limit_exempt).where(User.id == license_record.user_id)
    )
    return 0 if exempt else license_record.plan.max_devices


def _bind_or_touch_device(
    db: Session,
    license_record: License,
    project: Project,
    device_code: str,
    device_name: str | None,
    now: datetime,
    *,
    allow_create: bool,
) -> Device:
    if allow_create:
        db.execute(select(License.id).where(License.id == license_record.id).with_for_update())
    device = db.scalar(
        select(Device).where(
            Device.license_id == license_record.id, Device.device_code == device_code
        )
    )
    if device is not None:
        if device.status != "active":
            raise DomainError("Device binding is disabled", status_code=403)
        device.last_login = now
        if device_name:
            device.device_name = device_name
        return device
    if not allow_create:
        raise DomainError("Device is not bound to this license", status_code=403)
    active_count = (
        db.scalar(
            select(func.count(Device.id)).where(
                Device.license_id == license_record.id, Device.status == "active"
            )
        )
        or 0
    )
    limit = effective_device_limit(db, license_record)
    if limit > 0 and active_count >= limit:
        raise DomainError("Device limit reached", status_code=409)
    device = Device(
        user_id=license_record.user_id,
        license_id=license_record.id,
        project_id=project.id,
        device_code=device_code,
        device_name=device_name,
        last_login=now,
    )
    db.add(device)
    return device


def _refresh_offline_window(
    settings: Settings, license_record: License, now: datetime
) -> datetime | None:
    if license_record.plan.offline_hours <= 0:
        license_record.offline_until = None
        return None
    allowed_hours = min(license_record.plan.offline_hours, settings.offline_grace_hours)
    offline_until = min(
        now + timedelta(hours=allowed_hours),
        as_utc(license_record.expire_time) or now,
    )
    license_record.offline_until = offline_until
    return offline_until


def _result(
    settings: Settings,
    license_record: License,
    project: Project,
    device_code: str,
    now: datetime,
    *,
    valid: bool,
    reason: str | None = None,
    issue_access_token: bool = True,
) -> LicenseResult:
    permissions = (
        sorted(
            permission.code
            for permission in license_record.plan.permissions
            if permission.status == "active"
        )
        if valid
        else []
    )
    offline_enabled = license_record.plan.offline_hours > 0
    offline_until = as_utc(license_record.offline_until) if valid and offline_enabled else None
    access_token: str | None = None
    expires_in: int | None = None
    offline_token: str | None = None
    if valid and issue_access_token:
        access_token, expires_in = create_access_token(
            settings,
            user_id=license_record.user_id,
            token_type="license",
            license_id=license_record.id,
            project_code=project.code,
            device_code=device_code,
        )
    if valid and offline_until:
        offline_token = create_offline_token(
            settings,
            project_code=project.code,
            device_code=device_code,
            license_id=license_record.id,
            permissions=permissions,
            device_limit=license_record.plan.max_devices,
            shop_limit=license_record.plan.max_shops,
            license_expire=as_utc(license_record.expire_time) or offline_until,
            issued_at=now,
            offline_until=offline_until,
        )
    return LicenseResult(
        valid=valid,
        online_required=not offline_enabled,
        license_role=license_record.plan.license_role,
        expire=as_utc(license_record.expire_time),
        permissions=permissions,
        shop_limit=license_record.plan.max_shops,
        device_limit=license_record.plan.max_devices,
        offline_until=offline_until,
        offline_token=offline_token,
        access_token=access_token,
        token_type="bearer" if access_token else None,
        expires_in=expires_in,
        license_key=license_record.license_key if valid else None,
        reason=reason,
        server_time=now,
    )


def activate_license(
    db: Session,
    settings: Settings,
    user: User,
    payload: ActivateRequest,
    *,
    purpose: Literal["registration", "new_shop"] = "new_shop",
    commit: bool = True,
) -> LicenseResult:
    now = datetime.now(UTC)
    code_hash = hash_card_code(settings, normalize_card_code(payload.card_key))
    activation_code = db.scalar(
        select(ActivationCode).where(ActivationCode.code_hash == code_hash).with_for_update()
    )
    if activation_code is None:
        raise DomainError("Activation code is invalid", status_code=404)
    batch = db.scalar(
        select(CardBatch)
        .where(CardBatch.id == activation_code.batch_id)
        .with_for_update(of=CardBatch)
    )
    if activation_code.status != "unused" or batch is None or batch.status != "active":
        raise DomainError("Activation code is unavailable", status_code=409)
    if activation_code.owner_user_id is not None and activation_code.owner_user_id != user.id:
        raise DomainError("Activation code is bound to another account", status_code=403)
    card_expiry = as_utc(activation_code.expires_at)
    if card_expiry and card_expiry <= now:
        activation_code.status = "expired"
        if commit:
            db.commit()
        raise DomainError("Activation code has expired", status_code=409)
    plan = db.scalar(_plan_query(activation_code.plan_id))
    if (
        plan is None
        or plan.plan_kind != "license"
        or plan.status != "active"
        or plan.product.status != "active"
    ):
        raise DomainError("Plan is unavailable", status_code=409)
    project = plan.product.project
    if project.code != payload.project_code:
        raise DomainError("Activation code belongs to another project", status_code=409)
    version_reason = _validate_project_version(project, payload.version, payload.version_hash)
    if version_reason:
        raise DomainError(version_reason.replace("_", " "), status_code=409)

    if purpose == "registration":
        from app.annual_registration_policy import permits_annual_registration

        annual_registration = permits_annual_registration(
            settings, project.code, batch.id, plan.license_role,
        )
        if plan.license_role != LICENSE_ROLE_SHOP_INTRO and not annual_registration:
            raise DomainError(
                "Registration requires a first-shop introductory card",
                status_code=409,
            )
        db.execute(select(User.id).where(User.id == user.id).with_for_update())
        redeemed = db.scalar(
            select(ShopIntroRedemption.id).where(ShopIntroRedemption.user_id == user.id)
        )
        if redeemed is not None and plan.license_role == LICENSE_ROLE_SHOP_INTRO:
            raise DomainError(
                "The first-shop introductory offer has already been used by this account",
                status_code=409,
            )
    elif plan.license_role == LICENSE_ROLE_SHOP_INTRO:
        raise DomainError(
            "The first-shop introductory card can only be used during registration",
            status_code=409,
        )
    elif (
        plan.license_role not in STANDARD_SHOP_CARD_ROLES
        and plan.license_role != LICENSE_ROLE_LEGACY
    ):
        raise DomainError("Activation card role is unavailable", status_code=409)

    duration_days = batch.duration_days or plan.duration_days
    license_record = License(
        user_id=user.id,
        plan_id=plan.id,
        license_key=_new_license_key(),
        start_time=now,
        expire_time=now + timedelta(days=duration_days),
        status="active",
        last_verified_at=now,
        last_heartbeat_at=now,
    )
    license_record.plan = plan
    db.add(license_record)
    db.flush()
    if purpose == "registration" and plan.license_role == LICENSE_ROLE_SHOP_INTRO:
        db.add(
            ShopIntroRedemption(
                user_id=user.id,
                project_id=project.id,
                license_id=license_record.id,
                activation_code_id=activation_code.id,
                redeemed_at=now,
            )
        )
        db.flush()
    _bind_or_touch_device(
        db,
        license_record,
        project,
        payload.device_code,
        payload.device_name,
        now,
        allow_create=True,
    )
    _refresh_offline_window(settings, license_record, now)
    activation_code.status = "activated"
    activation_code.activated_by_user_id = user.id
    activation_code.activated_license_id = license_record.id
    activation_code.activated_at = now
    db.add(
        UsageLog(
            user_id=user.id,
            project_id=project.id,
            license_id=license_record.id,
            event=(
                "first_shop_license_activate" if purpose == "registration" else "license_activate"
            ),
            device_code=payload.device_code,
            details={"version": payload.version or ""},
        )
    )
    if commit:
        db.commit()
    return _result(settings, license_record, project, payload.device_code, now, valid=True)


def renew_shop_license(
    db: Session,
    settings: Settings,
    user: User,
    payload: RenewRequest,
) -> LicenseResult:
    now = datetime.now(UTC)
    target_filter = (
        License.id == payload.license_id
        if payload.license_id is not None
        else License.license_key == payload.license_key
    )
    license_record = db.scalar(_license_query().where(target_filter).with_for_update(of=License))
    if license_record is None or license_record.user_id != user.id:
        raise DomainError("License not found", status_code=404)
    if license_record.status != "active":
        raise DomainError("Only active shop licenses can be renewed", status_code=409)
    if license_record.plan.license_role not in {
        LICENSE_ROLE_SHOP_INTRO,
        *STANDARD_SHOP_CARD_ROLES,
    }:
        raise DomainError("This license is not a shop-card entitlement", status_code=409)

    code_hash = hash_card_code(settings, normalize_card_code(payload.card_key))
    activation_code = db.scalar(
        select(ActivationCode).where(ActivationCode.code_hash == code_hash).with_for_update()
    )
    if activation_code is None:
        raise DomainError("Activation code is invalid", status_code=404)
    batch = db.scalar(
        select(CardBatch)
        .where(CardBatch.id == activation_code.batch_id)
        .with_for_update(of=CardBatch)
    )
    if activation_code.status != "unused" or batch is None or batch.status != "active":
        raise DomainError("Activation code is unavailable", status_code=409)
    if activation_code.owner_user_id is not None and activation_code.owner_user_id != user.id:
        raise DomainError("Activation code is bound to another account", status_code=403)
    card_expiry = as_utc(activation_code.expires_at)
    if card_expiry and card_expiry <= now:
        activation_code.status = "expired"
        db.commit()
        raise DomainError("Activation code has expired", status_code=409)
    plan = db.scalar(_plan_query(activation_code.plan_id))
    if (
        plan is None
        or plan.plan_kind != "license"
        or plan.license_role not in STANDARD_SHOP_CARD_ROLES
        or plan.status != "active"
        or plan.product.status != "active"
    ):
        raise DomainError("Renewal requires a standard shop card", status_code=409)
    project = plan.product.project
    target_project = license_record.plan.product.project
    if project.id != target_project.id or project.code != payload.project_code:
        raise DomainError("Renewal card belongs to another project", status_code=409)
    version_reason = _validate_project_version(project, payload.version, payload.version_hash)
    if version_reason:
        raise DomainError(version_reason.replace("_", " "), status_code=409)

    duration_days = batch.duration_days or plan.duration_days
    base = max(as_utc(license_record.expire_time) or now, now)
    license_record.plan_id = plan.id
    license_record.plan = plan
    license_record.expire_time = base + timedelta(days=duration_days)
    license_record.last_verified_at = now
    license_record.last_heartbeat_at = now
    _bind_or_touch_device(
        db,
        license_record,
        project,
        payload.device_code,
        payload.device_name,
        now,
        allow_create=True,
    )
    _refresh_offline_window(settings, license_record, now)
    activation_code.status = "activated"
    activation_code.activated_by_user_id = user.id
    activation_code.activated_license_id = license_record.id
    activation_code.activated_at = now
    db.add(
        UsageLog(
            user_id=user.id,
            project_id=project.id,
            license_id=license_record.id,
            event="shop_license_renew",
            device_code=payload.device_code,
            details={"duration_days": duration_days},
        )
    )
    db.commit()
    return _result(settings, license_record, project, payload.device_code, now, valid=True)


def activate_and_bind_shop(
    db: Session,
    settings: Settings,
    user: User,
    payload: ActivateShopRequest,
) -> LicenseResult:
    result = activate_license(
        db,
        settings,
        user,
        ActivateRequest(
            card_key=payload.card_key,
            project_code=payload.project_code,
            device_code=payload.device_code,
            device_name=payload.device_name,
            version=payload.version,
            version_hash=payload.version_hash,
        ),
        purpose="new_shop",
        commit=False,
    )
    license_record = db.scalar(
        _license_query()
        .where(License.license_key == result.license_key)
        .with_for_update(of=License)
    )
    if license_record is None:
        raise DomainError("Activated shop license is unavailable", status_code=409)
    project = license_record.plan.product.project
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    conflict = db.scalar(
        select(Shop.id).where(
            Shop.project_id == project.id,
            Shop.platform == "ozon",
            Shop.shop_id == payload.shop_id,
        )
    )
    if conflict is not None:
        raise DomainError("This shop is already assigned to another card", status_code=409)
    db.add(
        Shop(
            user_id=user.id,
            license_id=license_record.id,
            project_id=project.id,
            platform="ozon",
            shop_name=payload.shop_name,
            shop_id=payload.shop_id,
        )
    )
    db.add(
        UsageLog(
            user_id=user.id,
            project_id=project.id,
            license_id=license_record.id,
            event="shop_bind",
            device_code=payload.device_code,
            details={"platform": "ozon", "activation": "atomic_new_shop"},
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
    return result


def user_shop_licenses(
    db: Session,
    user: User,
    project_code: str,
) -> list[UserShopLicenseSummary]:
    licenses = db.scalars(
        _license_query()
        .join(Plan, Plan.id == License.plan_id)
        .join(Product, Product.id == Plan.product_id)
        .join(Project, Project.id == Product.project_id)
        .where(
            License.user_id == user.id,
            Project.code == project_code,
            or_(
                Plan.license_role.in_({LICENSE_ROLE_SHOP_INTRO, *STANDARD_SHOP_CARD_ROLES}),
                select(Shop.id).where(Shop.license_id == License.id).exists(),
            ),
        )
        .order_by(License.expire_time.desc(), License.id.desc())
    ).all()
    shop_rows = (
        db.scalars(
            select(Shop)
            .where(Shop.license_id.in_([item.id for item in licenses]))
            .order_by(Shop.id)
        ).all()
        if licenses
        else []
    )
    shops_by_license: dict[int, list[LicenseShopSummary]] = {}
    for shop in shop_rows:
        shops_by_license.setdefault(shop.license_id, []).append(
            LicenseShopSummary(
                id=shop.id,
                shop_name=shop.shop_name,
                shop_id=shop.shop_id,
                status=shop.status,
            )
        )
    return [
        UserShopLicenseSummary(
            license_id=item.id,
            plan_name=item.plan.name,
            license_role=item.plan.license_role,
            start_time=as_utc(item.start_time) or item.start_time,
            expire_time=as_utc(item.expire_time) or item.expire_time,
            status=item.status,
            shops=shops_by_license.get(item.id, []),
        )
        for item in licenses
    ]


def _resolve_license(
    db: Session,
    principal: CurrentPrincipal,
    license_key: str | None,
    *,
    project_code: str | None = None,
    device_code: str | None = None,
) -> License:
    query = _license_query()
    if principal.license_id is not None:
        query = query.where(License.id == principal.license_id)
    elif license_key:
        query = query.where(License.license_key == license_key)
    elif principal.token_type == "user" and project_code:
        now = datetime.now(UTC)
        existing_binding = (
            select(Device.id)
            .where(
                Device.license_id == License.id,
                Device.device_code == device_code,
                Device.status == "active",
            )
            .exists()
        )
        query = (
            query.join(Plan, Plan.id == License.plan_id)
            .join(Product, Product.id == Plan.product_id)
            .join(Project, Project.id == Product.project_id)
            .where(
                License.user_id == principal.user_id,
                License.status == "active",
                License.start_time <= now,
                License.expire_time > now,
                Plan.status == "active",
                Product.status == "active",
                Project.status == "active",
                Project.code == project_code,
            )
            # Standard monthly/annual shop cards are add-on entitlements, not
            # the desktop account session. Keep an existing legacy or intro
            # license authoritative even when a newer shop card expires later.
            .order_by(
                case(
                    (Plan.license_role == LICENSE_ROLE_LEGACY, 2),
                    (Plan.license_role == LICENSE_ROLE_SHOP_INTRO, 1),
                    else_=0,
                ).desc(),
                existing_binding.desc(),
                License.expire_time.desc(),
                License.id.desc(),
            )
            .limit(1)
        )
    else:
        raise DomainError("license_key or project_code is required", status_code=422)
    license_record = db.scalar(query.with_for_update(of=License))
    if license_record is None or license_record.user_id != principal.user_id:
        raise DomainError("License not found", status_code=404)
    if license_key and license_record.license_key != license_key:
        raise DomainError("License token does not match license_key", status_code=403)
    return license_record


def check_license(
    db: Session,
    settings: Settings,
    principal: CurrentPrincipal,
    payload: CheckRequest,
) -> LicenseResult:
    now = datetime.now(UTC)
    license_record = _resolve_license(
        db,
        principal,
        payload.license_key,
        project_code=payload.project_code,
        device_code=payload.device_code,
    )
    project = license_record.plan.product.project
    if project.code != payload.project_code:
        raise DomainError("License belongs to another project", status_code=403)
    if principal.token_type == "license" and (
        principal.project_code != payload.project_code
        or principal.device_code != payload.device_code
    ):
        raise DomainError("License token is bound to another project or device", status_code=403)
    if principal.token_type == "license":
        _bind_or_touch_device(
            db,
            license_record,
            project,
            payload.device_code,
            payload.device_name,
            now,
            allow_create=False,
        )
    reason = _license_state_reason(license_record, now) or _validate_project_version(
        project, payload.version, payload.version_hash
    )
    if reason:
        return _result(
            settings,
            license_record,
            project,
            payload.device_code,
            now,
            valid=False,
            reason=reason,
            issue_access_token=False,
        )
    if principal.token_type == "user":
        _bind_or_touch_device(
            db,
            license_record,
            project,
            payload.device_code,
            payload.device_name,
            now,
            allow_create=True,
        )
    license_record.last_verified_at = now
    _refresh_offline_window(settings, license_record, now)
    db.add(
        UsageLog(
            user_id=license_record.user_id,
            project_id=project.id,
            license_id=license_record.id,
            event="license_check",
            device_code=payload.device_code,
            details={"version": payload.version or ""},
        )
    )
    db.commit()
    return _result(settings, license_record, project, payload.device_code, now, valid=True)


def heartbeat(
    db: Session,
    settings: Settings,
    principal: CurrentPrincipal,
    payload: HeartbeatRequest,
) -> LicenseResult:
    if principal.token_type != "license" or principal.license_id is None:
        raise DomainError("A license token is required", status_code=403)
    now = datetime.now(UTC)
    license_record = _resolve_license(db, principal, None)
    project = license_record.plan.product.project
    if project.code != payload.project_code:
        raise DomainError("License belongs to another project", status_code=403)
    if (
        principal.project_code != payload.project_code
        or principal.device_code != payload.device_code
    ):
        raise DomainError("License token is bound to another project or device", status_code=403)
    device = _bind_or_touch_device(
        db,
        license_record,
        project,
        payload.device_code,
        None,
        now,
        allow_create=False,
    )
    reason = _license_state_reason(license_record, now) or _validate_project_version(
        project, payload.version, payload.version_hash
    )
    if reason:
        return _result(
            settings,
            license_record,
            project,
            payload.device_code,
            now,
            valid=False,
            reason=reason,
            issue_access_token=False,
        )
    device.last_heartbeat = now
    license_record.last_heartbeat_at = now
    _refresh_offline_window(settings, license_record, now)
    db.add(
        UsageLog(
            user_id=license_record.user_id,
            project_id=project.id,
            license_id=license_record.id,
            event="heartbeat",
            device_code=payload.device_code,
        )
    )
    db.commit()
    return _result(settings, license_record, project, payload.device_code, now, valid=True)


def grant_license(db: Session, payload: LicenseGrantCreate) -> License:
    user = db.get(User, payload.user_id)
    plan = db.scalar(_plan_query(payload.plan_id))
    if user is None:
        raise DomainError("User not found", status_code=404)
    if plan is None:
        raise DomainError("Plan not found", status_code=404)
    if plan.plan_kind != "license":
        raise DomainError("Point packages cannot grant software licenses", status_code=409)
    if plan.license_role == LICENSE_ROLE_SHOP_INTRO:
        raise DomainError(
            "The first-shop introductory plan can only be redeemed with a card during registration",
            status_code=409,
        )
    start_time = as_utc(payload.start_time) or datetime.now(UTC)
    expire_time = as_utc(payload.expire_time) or start_time + timedelta(days=plan.duration_days)
    if expire_time <= start_time:
        raise DomainError("expire_time must be after start_time")
    record = License(
        user_id=user.id,
        plan_id=plan.id,
        license_key=_new_license_key(),
        start_time=start_time,
        expire_time=expire_time,
        status=payload.status,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record

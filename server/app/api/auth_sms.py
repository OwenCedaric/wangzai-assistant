from __future__ import annotations

import secrets
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.helpers import rate_limit
from app.auth.dependencies import require_user_token
from app.auth.security import create_access_token, hash_password
from app.config import Settings
from app.database.session import get_db
from app.models import (
    AgentProjectScope,
    Channel,
    License,
    Plan,
    Product,
    Project,
    UsageLog,
    User,
    UserProjectAttribution,
)
from app.schemas.auth_sms import (
    AttributionSummary,
    LogoutRequest,
    MeResponse,
    RefreshRequest,
    RefreshResponse,
    SmsSendRequest,
    SmsSendResponse,
    SmsUserSummary,
    SmsVerifyRequest,
    SmsVerifyResponse,
)
from app.schemas.licensing import ActivateRequest
from app.services.attribution_service import (
    lock_user_project_attribution,
    resolve_distribution_channel,
)
from app.services.errors import DomainError
from app.services.identity_service import (
    find_user_by_phone,
    mask_phone,
    normalize_phone,
    phone_hash,
    protect_phone,
)
from app.services.license_service import activate_license
from app.services.session_service import (
    create_refresh_session,
    revoke_refresh_session,
    rotate_refresh_session,
)

router = APIRouter(prefix="/auth", tags=["phone-authentication"])


def _project(db: Session, code: str, *, lock: bool = False) -> Project:
    query = select(Project).where(Project.code == code)
    if lock:
        query = query.with_for_update()
    project = db.scalar(query)
    if project is None or project.status != "active":
        raise DomainError("Project not found", status_code=404)
    return project


def _attribution_summary(
    attribution: UserProjectAttribution, project: Project
) -> AttributionSummary:
    return AttributionSummary(
        project_id=project.id,
        project_code=project.code,
        source_type=attribution.source_type,
        locked_at=attribution.locked_at,
    )


def _check_client_version(project: Project, payload: SmsSendRequest) -> None:
    if payload.version and payload.version != project.version:
        raise DomainError("Client version is not supported", status_code=409)
    if project.version_hash and payload.version_hash != project.version_hash:
        raise DomainError("Client version hash does not match", status_code=409)


def _get_or_create_user(
    db: Session,
    settings: Settings,
    phone: str,
    *,
    allow_create: bool,
) -> tuple[User, bool]:
    user = find_user_by_phone(db, settings, phone)
    if user is not None:
        if user.status != "active":
            raise DomainError("User is not active", status_code=403)
        protect_phone(settings, user, phone, verified=True)
        return user, False
    if not allow_create:
        raise DomainError("新账号注册必须提供首店首月卡密", status_code=422)
    for _ in range(3):
        candidate = User(
            username=f"pending_mobile_{secrets.token_hex(12)}",
            password_hash=hash_password(secrets.token_urlsafe(40)),
            status="active",
            is_admin=False,
        )
        protect_phone(settings, candidate, phone, verified=True)
        try:
            with db.begin_nested():
                db.add(candidate)
                db.flush()
                candidate.username = f"mobile_user_{candidate.id}"
                db.flush()
            return candidate, True
        except IntegrityError:
            user = find_user_by_phone(db, settings, phone)
            if user is not None:
                return user, False
    raise DomainError("Could not create user", status_code=409)


def _has_active_license(db: Session, user_id: int, project_id: int) -> bool:
    now = datetime.now(UTC)
    return (
        db.scalar(
            select(License.id)
            .join(Plan, Plan.id == License.plan_id)
            .join(Product, Product.id == Plan.product_id)
            .where(
                License.user_id == user_id,
                License.status == "active",
                License.start_time <= now,
                License.expire_time > now,
                Product.project_id == project_id,
                Product.status == "active",
                Plan.status == "active",
            )
            .limit(1)
        )
        is not None
    )


@router.post("/sms/send", response_model=SmsSendResponse)
def send_sms_code(
    payload: SmsSendRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> SmsSendResponse:
    settings: Settings = request.app.state.settings
    phone = normalize_phone(payload.phone)
    digest = phone_hash(settings, phone)
    rate_limit(
        request,
        "sms-send-ip",
        "all",
        settings.sms_ip_rate_limit_per_minute,
    )
    if payload.device_code:
        rate_limit(
            request,
            "sms-send-device",
            payload.device_code,
            settings.sms_device_rate_limit_per_minute,
            bind_ip=False,
        )
    rate_limit(request, "sms-send", digest, settings.auth_rate_limit_per_minute)
    project = _project(db, payload.project_code)
    _check_client_version(project, payload)
    channel = resolve_distribution_channel(
        db,
        settings,
        project,
        payload.channel_code,
        payload.distribution_token,
    )
    development_code = request.app.state.otp_service.send(
        phone,
        digest,
        project.id,
        channel.id if channel else None,
    )
    return SmsSendResponse(
        expires_in=settings.otp_ttl_seconds,
        retry_after=settings.otp_send_cooldown_seconds,
        phone_masked=mask_phone(phone),
        development_code=development_code,
    )


@router.post("/sms/verify", response_model=SmsVerifyResponse)
def verify_sms_code(
    payload: SmsVerifyRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> SmsVerifyResponse:
    settings: Settings = request.app.state.settings
    phone = normalize_phone(payload.phone)
    digest = phone_hash(settings, phone)
    rate_limit(
        request,
        "sms-verify-ip",
        "all",
        settings.sms_ip_rate_limit_per_minute,
    )
    rate_limit(
        request,
        "sms-verify-device",
        payload.device_code,
        settings.sms_device_rate_limit_per_minute,
        bind_ip=False,
    )
    rate_limit(request, "sms-verify", digest, settings.auth_rate_limit_per_minute)
    project = _project(db, payload.project_code, lock=True)
    _check_client_version(project, payload)
    metadata = request.app.state.otp_service.verify(digest, project.id, payload.code)
    if metadata.project_id != project.id:
        raise DomainError("Verification challenge does not match project", status_code=409)
    channel = db.get(Channel, metadata.channel_id) if metadata.channel_id else None
    if channel is not None and (channel.status != "active" or channel.project_id != project.id):
        raise DomainError("Distribution channel is no longer active", status_code=409)
    if channel is not None:
        active_scope = db.scalar(
            select(AgentProjectScope.id).where(
                AgentProjectScope.agent_id == channel.agent_id,
                AgentProjectScope.project_id == project.id,
                AgentProjectScope.status == "active",
            )
        )
        if channel.agent.status != "active" or active_scope is None:
            raise DomainError("Distribution channel is no longer active", status_code=409)
    user, created = _get_or_create_user(
        db,
        settings,
        phone,
        allow_create=bool(payload.card_key),
    )
    entitlement = None
    if created:
        entitlement = activate_license(
            db,
            settings,
            user,
            ActivateRequest(
                card_key=str(payload.card_key),
                project_code=payload.project_code,
                device_code=payload.device_code,
                device_name=payload.device_name,
                version=payload.version or project.version,
                version_hash=payload.version_hash,
            ),
            purpose="registration",
            commit=False,
        )
    attribution = lock_user_project_attribution(db, user, project, channel)
    _, refresh_token, refresh_expires_in = create_refresh_session(
        db, settings, user, project, payload.device_code
    )
    access_token, expires_in = create_access_token(settings, user_id=user.id, token_type="user")
    db.add(
        UsageLog(
            user_id=user.id,
            project_id=project.id,
            event="sms_login",
            device_code=payload.device_code,
            details={"source_type": attribution.source_type},
        )
    )
    active_license = _has_active_license(db, user.id, project.id)
    db.commit()
    return SmsVerifyResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=expires_in,
        refresh_expires_in=refresh_expires_in,
        user=SmsUserSummary.model_validate(user),
        attribution=_attribution_summary(attribution, project),
        project_code=project.code,
        license_status="active" if active_license else "needs_activation",
        entitlement=entitlement,
    )


@router.post("/refresh", response_model=RefreshResponse)
def refresh_tokens(
    payload: RefreshRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> RefreshResponse:
    settings: Settings = request.app.state.settings
    _, user, _, refresh_token, refresh_expires_in = rotate_refresh_session(
        db, settings, payload.refresh_token, payload.device_code
    )
    access_token, expires_in = create_access_token(settings, user_id=user.id, token_type="user")
    db.commit()
    return RefreshResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=expires_in,
        refresh_expires_in=refresh_expires_in,
    )


@router.post("/logout", status_code=204)
def logout(
    payload: LogoutRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> None:
    revoke_refresh_session(db, request.app.state.settings, payload.refresh_token)
    db.commit()


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(require_user_token), db: Session = Depends(get_db)) -> MeResponse:
    rows = db.execute(
        select(UserProjectAttribution, Project)
        .join(Project, Project.id == UserProjectAttribution.project_id)
        .where(UserProjectAttribution.user_id == user.id)
        .order_by(UserProjectAttribution.created_at)
    ).all()
    return MeResponse(
        user=SmsUserSummary.model_validate(user),
        attributions=[_attribution_summary(attribution, project) for attribution, project in rows],
    )

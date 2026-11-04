from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.auth_sms import _check_client_version, _has_active_license, _project
from app.api.helpers import rate_limit
from app.auth.security import create_access_token, hash_password, verify_password
from app.config import Settings
from app.database.session import get_db
from app.models import UsageLog, User
from app.schemas.auth import (
    LoginRequest,
    LoginResponse,
    PasswordAttributionSummary,
    RegisterRequest,
    RegisterResponse,
    UserSummary,
)
from app.schemas.licensing import ActivateRequest
from app.services.attribution_service import (
    lock_user_project_attribution,
    resolve_distribution_channel,
)
from app.services.errors import DomainError
from app.services.license_service import activate_license
from app.services.session_service import create_refresh_session

router = APIRouter(prefix="/auth", tags=["authentication"])
_DUMMY_PASSWORD_HASH = hash_password("not-a-real-user-password")


def _desktop_context(payload: LoginRequest | RegisterRequest) -> bool:
    project_code = getattr(payload, "project_code", None)
    device_code = getattr(payload, "device_code", None)
    if bool(project_code) != bool(device_code):
        raise DomainError("桌面端登录信息不完整，请重新打开软件后再试。", status_code=422)
    return bool(project_code and device_code)


def _desktop_login_response(
    *,
    payload: LoginRequest | RegisterRequest,
    request: Request,
    db: Session,
    user: User,
    event: str,
    commit: bool = True,
) -> LoginResponse:
    settings: Settings = request.app.state.settings
    project = _project(db, str(payload.project_code), lock=True)
    _check_client_version(project, payload)
    channel = resolve_distribution_channel(
        db,
        settings,
        project,
        payload.channel_code,
        payload.distribution_token,
    )
    attribution = lock_user_project_attribution(db, user, project, channel)
    _, refresh_token, refresh_expires_in = create_refresh_session(
        db,
        settings,
        user,
        project,
        str(payload.device_code),
    )
    access_token, expires_in = create_access_token(
        settings,
        user_id=user.id,
        token_type="user",
    )
    db.add(
        UsageLog(
            user_id=user.id,
            project_id=project.id,
            event=event,
            device_code=str(payload.device_code),
            details={"source_type": attribution.source_type},
        )
    )
    active_license = _has_active_license(db, user.id, project.id)
    if commit:
        db.commit()
    return LoginResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=expires_in,
        refresh_expires_in=refresh_expires_in,
        user=UserSummary.model_validate(user),
        attribution=PasswordAttributionSummary(
            project_id=project.id,
            project_code=project.code,
            source_type=attribution.source_type,
            locked_at=attribution.locked_at,
        ),
        project_code=project.code,
        license_status="active" if active_license else "needs_activation",
    )


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)) -> LoginResponse:
    settings: Settings = request.app.state.settings
    email = payload.email.strip().lower() if payload.email else ""
    username = payload.username.strip() if payload.username else ""
    identifier = email or username.lower()
    if not identifier:
        raise DomainError("请输入邮箱或账号。", status_code=422)
    rate_limit(
        request,
        "login",
        identifier,
        settings.auth_rate_limit_per_minute,
    )
    user = db.scalar(
        select(User).where(
            func.lower(User.email) == email
            if email
            else func.lower(User.username) == username.lower()
        )
    )
    password_hash = user.password_hash if user else _DUMMY_PASSWORD_HASH
    valid_password = verify_password(payload.password, password_hash)
    if user is None or not valid_password or user.status != "active":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="账号或密码错误",
        )
    if _desktop_context(payload):
        return _desktop_login_response(
            payload=payload,
            request=request,
            db=db,
            user=user,
            event="password_login",
        )
    token, expires_in = create_access_token(settings, user_id=user.id, token_type="user")
    db.add(UsageLog(user_id=user.id, event="login"))
    db.commit()
    return LoginResponse(
        access_token=token,
        expires_in=expires_in,
        user=UserSummary.model_validate(user),
    )


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def register(
    payload: RegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> RegisterResponse:
    settings: Settings = request.app.state.settings
    email = payload.email.strip().lower()
    username = email
    rate_limit(
        request,
        "register",
        email,
        settings.auth_rate_limit_per_minute,
    )
    _desktop_context(payload)
    # Validate the sealed project, version and distribution data before creating
    # an account so malformed clients cannot leave orphan users behind.
    project = _project(db, payload.project_code)
    _check_client_version(project, payload)
    resolve_distribution_channel(
        db,
        settings,
        project,
        payload.channel_code,
        payload.distribution_token,
    )
    existing_email = db.scalar(select(User.id).where(func.lower(User.email) == email))
    if existing_email is not None:
        raise DomainError("这个邮箱已经注册，请直接登录。", status_code=409)
    try:
        user = User(
            username=username,
            password_hash=hash_password(payload.password),
            email=email,
            status="active",
            is_admin=False,
        )
        db.add(user)
        db.flush()
        login_result = _desktop_login_response(
            payload=payload,
            request=request,
            db=db,
            user=user,
            event="password_register",
            commit=False,
        )
        entitlement = activate_license(
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
            purpose="registration",
            commit=False,
        )
        db.commit()
        return RegisterResponse(
            **login_result.model_dump(exclude={"license_status"}),
            license_status="active",
            entitlement=entitlement,
        )
    except IntegrityError as exc:
        db.rollback()
        raise DomainError("账号或邮箱已存在。", status_code=409) from exc
    except Exception:
        db.rollback()
        raise

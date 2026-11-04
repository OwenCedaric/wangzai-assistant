from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.helpers import rate_limit
from app.auth.dependencies import (
    CurrentPrincipal,
    get_current_user,
    get_principal,
    require_user_token,
)
from app.auth.offline import get_offline_public_key_pem
from app.config import Settings
from app.database.session import get_db
from app.models import User
from app.schemas.licensing import (
    ActivateRequest,
    ActivateShopRequest,
    BindOwnedShopLicenseRequest,
    CheckRequest,
    HeartbeatRequest,
    LicenseResult,
    PublicKeyResponse,
    RenewRequest,
    ShopRead,
    UserShopLicenseSummary,
)
from app.services.client_service import bind_owned_shop_license
from app.services.license_service import (
    activate_and_bind_shop,
    activate_license,
    check_license,
    heartbeat,
    renew_shop_license,
    user_shop_licenses,
)

router = APIRouter(prefix="/license", tags=["license"])


@router.get("/public-key", response_model=PublicKeyResponse)
def public_key(request: Request) -> PublicKeyResponse:
    settings: Settings = request.app.state.settings
    public_key_pem = get_offline_public_key_pem(settings)
    if public_key_pem is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Offline signing is not configured",
        )
    return PublicKeyResponse(key_id=settings.offline_signing_key_id, public_key_pem=public_key_pem)


@router.post("/activate", response_model=LicenseResult)
def activate(
    payload: ActivateRequest,
    request: Request,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> LicenseResult:
    settings: Settings = request.app.state.settings
    rate_limit(request, "activate", str(user.id), settings.license_rate_limit_per_minute)
    return activate_license(db, settings, user, payload)


@router.post("/activate-shop", response_model=LicenseResult)
def activate_shop(
    payload: ActivateShopRequest,
    request: Request,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> LicenseResult:
    settings: Settings = request.app.state.settings
    rate_limit(request, "activate-shop", str(user.id), settings.license_rate_limit_per_minute)
    return activate_and_bind_shop(db, settings, user, payload)


@router.get("/entitlements", response_model=list[UserShopLicenseSummary])
def entitlements(
    project_code: str = Query(
        pattern=r"^[a-z][a-z0-9_.-]*$",
        min_length=2,
        max_length=64,
    ),
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> list[UserShopLicenseSummary]:
    return user_shop_licenses(db, user, project_code)


@router.post("/bind-shop", response_model=ShopRead, status_code=201)
def bind_shop_license(
    payload: BindOwnedShopLicenseRequest,
    request: Request,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> ShopRead:
    settings: Settings = request.app.state.settings
    rate_limit(request, "bind-shop", str(user.id), settings.license_rate_limit_per_minute)
    return bind_owned_shop_license(db, user.id, payload)


@router.post("/renew", response_model=LicenseResult)
def renew(
    payload: RenewRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LicenseResult:
    settings: Settings = request.app.state.settings
    rate_limit(request, "renew", str(user.id), settings.license_rate_limit_per_minute)
    return renew_shop_license(db, settings, user, payload)


@router.post("/check", response_model=LicenseResult)
def check(
    payload: CheckRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LicenseResult:
    settings: Settings = request.app.state.settings
    rate_limit(request, "check", str(principal.user_id), settings.license_rate_limit_per_minute)
    result = check_license(db, settings, principal, payload)
    if result.valid and principal.license_id is not None:
        request.app.state.presence.touch(principal.user_id, principal.license_id)
    return result


@router.post("/heartbeat", response_model=LicenseResult)
def license_heartbeat(
    payload: HeartbeatRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LicenseResult:
    settings: Settings = request.app.state.settings
    rate_limit(
        request,
        "heartbeat",
        str(principal.user_id),
        settings.license_rate_limit_per_minute,
    )
    result = heartbeat(db, settings, principal, payload)
    if result.valid and principal.license_id is not None:
        request.app.state.presence.touch(principal.user_id, principal.license_id)
    return result

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.api.helpers import rate_limit
from app.auth.dependencies import CurrentPrincipal, get_current_user, get_principal
from app.config import Settings
from app.database.session import get_db
from app.models import User
from app.protected_compute.registry import CapabilityContractError, get_capability
from app.protected_compute.service import (
    ProtectedComputeFailure,
    execute_protected_compute,
    get_protected_compute_public_key_pem,
)
from app.schemas.protected_compute import ProtectedComputeRequest
from app.services.client_service import get_active_principal_license

router = APIRouter(prefix="/protected-compute", tags=["protected-compute"])


def _has_capability_permission(required_permission: str, active_permissions: set[str]) -> bool:
    accepted_permissions = {required_permission}
    if required_permission == "profit.view":
        accepted_permissions.add("profit")
    return not active_permissions.isdisjoint(accepted_permissions)


@router.get("/public-keys")
def protected_compute_public_keys(request: Request):
    settings: Settings = request.app.state.settings
    public_key = get_protected_compute_public_key_pem(settings)
    if public_key is None:
        raise HTTPException(status_code=503, detail="Protected compute is unavailable")
    return {
        "contract": "protected-compute-public-keys/v1",
        "keys": [
            {
                "algorithm": "Ed25519",
                "keyId": settings.protected_compute_signing_key_id,
                "publicKeyPem": public_key,
            }
        ],
        "revocationEpoch": settings.protected_compute_revocation_epoch,
        "fetchedAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "provisioningOnly": True,
    }


@router.post("/execute")
def execute(
    payload: ProtectedComputeRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    license_record = get_active_principal_license(db, principal)
    try:
        descriptor = get_capability(payload.capability, payload.version)
    except CapabilityContractError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "PROTECTED_COMPUTE_CAPABILITY_UNSUPPORTED"},
        ) from exc
    active_permissions = {
        permission.code
        for permission in license_record.plan.permissions
        if permission.status == "active"
    }
    # ``profit`` remains a compatibility alias only for the profitability
    # capability. Every other capability uses its exact current desktop module
    # permission, and permissions always come from the authenticated plan.
    if not _has_capability_permission(descriptor.required_permission, active_permissions):
        raise HTTPException(
            status_code=403,
            detail={"code": "PROTECTED_COMPUTE_CAPABILITY_FORBIDDEN"},
        )
    rate_limit(
        request,
        f"protected-compute:{descriptor.capability}",
        str(principal.license_id),
        settings.protected_compute_rate_limit_per_minute,
        bind_ip=False,
    )
    try:
        return execute_protected_compute(
            payload,
            settings=settings,
            replay_guard=request.app.state.protected_compute_replay_guard,
            redis=request.app.state.redis,
            license_offline_allowed=license_record.plan.offline_hours > 0,
        )
    except ProtectedComputeFailure as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc

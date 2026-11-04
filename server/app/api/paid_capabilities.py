from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.api.helpers import rate_limit
from app.auth.dependencies import CurrentPrincipal, get_current_user, get_principal
from app.config import Settings
from app.database.session import get_db
from app.models import User
from app.models.base import as_utc
from app.paid_capabilities.registry import (
    PaidCapabilityContractError,
    get_paid_capability,
    public_paid_capability_contracts,
)
from app.paid_capabilities.service import (
    PaidCapabilityFailure,
    execute_paid_capability,
    issue_quote,
    paid_input_hash,
)
from app.paid_capabilities.signing import sign_paid_capability_payload
from app.protected_compute.canonical import CanonicalValueError
from app.schemas.paid_capabilities import PaidCapabilityJobRequest, PaidCapabilityQuoteRequest
from app.services.client_service import get_active_principal_license
from app.services.errors import DomainError

router = APIRouter(prefix="/paid-capabilities", tags=["paid-capabilities"])


def _iso(value: datetime) -> str:
    normalized = as_utc(value)
    assert normalized is not None
    return normalized.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "PAID_CAPABILITY_REQUEST_TIME_INVALID"},
        ) from exc
    return parsed.astimezone(UTC)


def _claim_request(payload: Any, request: Request, settings: Settings) -> None:
    current = datetime.now(UTC)
    issued = _parse_time(payload.issuedAt)
    skew = timedelta(seconds=settings.paid_capability_request_skew_seconds)
    if issued < current - skew or issued > current + skew:
        raise HTTPException(
            status_code=400,
            detail={"code": "PAID_CAPABILITY_REQUEST_TIME_INVALID"},
        )
    if not request.app.state.paid_capability_replay_guard.claim(
        payload.requestId,
        payload.nonce,
        ttl_seconds=settings.paid_capability_request_skew_seconds * 2,
        redis=request.app.state.redis,
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "PAID_CAPABILITY_REQUEST_REPLAYED"},
        )


def _context(payload: Any, request: Request, principal: CurrentPrincipal, db: Session):
    settings: Settings = request.app.state.settings
    if not settings.paid_capability_enabled:
        raise HTTPException(
            status_code=503,
            detail={"code": "PAID_CAPABILITY_DISABLED"},
        )
    license_record = get_active_principal_license(db, principal)
    try:
        descriptor = get_paid_capability(payload.capability, payload.version)
        normalized_input = descriptor.normalize(payload.input)
        paid_input_hash(normalized_input)
    except (PaidCapabilityContractError, CanonicalValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "PAID_CAPABILITY_INPUT_REJECTED"},
        ) from exc
    permissions = {
        permission.code
        for permission in license_record.plan.permissions
        if permission.status == "active"
    }
    if descriptor.required_permission not in permissions:
        raise HTTPException(
            status_code=403,
            detail={"code": "PAID_CAPABILITY_FORBIDDEN"},
        )
    rate_limit(
        request,
        f"paid-capability:{descriptor.capability}",
        str(principal.license_id),
        settings.paid_capability_rate_limit_per_minute,
        bind_ip=False,
    )
    _claim_request(payload, request, settings)
    project = license_record.plan.product.project
    return settings, descriptor, normalized_input, project


@router.get("/contracts")
def contracts(
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    if not settings.paid_capability_enabled:
        raise HTTPException(status_code=503, detail={"code": "PAID_CAPABILITY_DISABLED"})
    get_active_principal_license(db, principal)
    return {
        "contract": "paid-capability-contracts/v1",
        "items": public_paid_capability_contracts(),
    }


@router.post("/quote")
def quote(
    payload: PaidCapabilityQuoteRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings, descriptor, normalized_input, project = _context(payload, request, principal, db)
    try:
        quote_record = issue_quote(
            db,
            user_id=principal.user_id,
            project_id=project.id,
            descriptor=descriptor,
            normalized_input=normalized_input,
            ttl_seconds=settings.paid_capability_quote_ttl_seconds,
            requested_model=payload.model,
            text_reservation_multiplier_ppm=(
                settings.paid_text_reservation_multiplier_ppm
            ),
            image_reservation_multiplier_ppm=(
                settings.paid_image_reservation_multiplier_ppm
            ),
        )
        db.commit()
        db.refresh(quote_record)
    except PaidCapabilityFailure as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    envelope: dict[str, object] = {
        "capability": quote_record.capability,
        "contract": "paid-capability-quote/v1",
        "estimatedPoints": quote_record.estimated_points,
        "expiresAt": _iso(quote_record.expires_at),
        "inputHash": quote_record.input_hash,
        "issuedAt": _iso(quote_record.created_at),
        "keyId": settings.protected_compute_signing_key_id,
        "maximumPoints": quote_record.maximum_points,
        "nonce": payload.nonce,
        "quoteId": quote_record.id,
        "requestId": payload.requestId,
        "signatureAlgorithm": "Ed25519",
        "version": quote_record.version,
    }
    try:
        return sign_paid_capability_payload(settings, envelope)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503, detail={"code": "PAID_CAPABILITY_SIGNER_UNAVAILABLE"}
        ) from exc


def _job_envelope(settings: Settings, job, *, request_id: str, nonce: str) -> dict[str, object]:
    reservation = job.reservation
    envelope: dict[str, object] = {
        "capability": job.capability,
        "chargedPoints": reservation.settled_points if reservation else 0,
        "contract": "paid-capability-result/v1",
        "completedAt": _iso(job.completed_at),
        "inputHash": job.input_hash,
        "jobId": job.id,
        "keyId": settings.protected_compute_signing_key_id,
        "nonce": nonce,
        "offlinePolicy": {"allowed": False, "maxUses": 0, "scope": "none"},
        "requestId": request_id,
        "result": job.result_json,
        "signatureAlgorithm": "Ed25519",
        "status": job.status,
        "version": job.version,
    }
    return sign_paid_capability_payload(settings, envelope)


@router.post("/jobs")
def execute_job(
    payload: PaidCapabilityJobRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # The quote owns capability/version. Look it up without revealing cross-user records.
    from app.models.paid_capabilities import PaidCapabilityQuote

    quote_record = db.get(PaidCapabilityQuote, payload.quoteId)
    if quote_record is None or quote_record.user_id != principal.user_id:
        raise HTTPException(status_code=404, detail={"code": "PAID_CAPABILITY_QUOTE_NOT_FOUND"})
    synthetic = type(
        "JobContext",
        (),
        {
            "capability": quote_record.capability,
            "version": quote_record.version,
            "input": payload.input,
            "issuedAt": payload.issuedAt,
            "requestId": payload.requestId,
            "nonce": payload.nonce,
        },
    )()
    settings, descriptor, normalized_input, project = _context(synthetic, request, principal, db)
    try:
        job = execute_paid_capability(
            db,
            user_id=principal.user_id,
            project_id=project.id,
            descriptor=descriptor,
            quote_id=payload.quoteId,
            normalized_input=normalized_input,
            input_hash=payload.inputHash,
            idempotency_key=payload.idempotencyKey,
            provider=request.app.state.paid_capability_provider,
        )
        return _job_envelope(
            settings,
            job,
            request_id=payload.requestId,
            nonce=payload.nonce,
        )
    except PaidCapabilityFailure as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message, "jobId": exc.job_id},
        ) from exc
    except DomainError as exc:
        # Reservation errors happen before the provider request. Keep their
        # public response machine-readable so the desktop can distinguish a
        # genuine zero balance from a network/provider failure.
        db.rollback()
        code = (
            "POINT_BALANCE_INSUFFICIENT"
            if exc.message == "Insufficient point balance"
            else "PAID_CAPABILITY_RESERVATION_REJECTED"
        )
        raise HTTPException(
            status_code=402 if code == "POINT_BALANCE_INSUFFICIENT" else exc.status_code,
            detail={"code": code, "message": exc.message, "jobId": None},
        ) from exc

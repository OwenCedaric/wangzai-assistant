from __future__ import annotations

import hashlib
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.auth.dependencies import require_admin
from app.database.session import get_db
from app.models import ApiPoolModel, ApiPoolProvider, Plan, Product, Project, UsageLog, User
from app.models.paid_capabilities import PaidCapabilityJob, PaidCapabilityRateCard
from app.paid_capabilities.api_pool_service import provider_supports_kind
from app.paid_capabilities.image_model_policy import (
    APPROVED_IMAGE_MODEL,
    image_model_is_allowed,
)
from app.paid_capabilities.pricing import PricingPolicy, ProviderUsage
from app.paid_capabilities.registry import (
    PaidCapabilityContractError,
    get_paid_capability,
)
from app.paid_capabilities.service import (
    PaidCapabilityFailure,
    reconcile_paid_capability_job,
)
from app.schemas.paid_capabilities import (
    PaidCapabilityImagePriceUpdate,
    PaidCapabilityMultiplierUpdate,
    PaidCapabilityRateCardCreate,
    PaidCapabilityRateCardRead,
    PaidCapabilityReconciliationRead,
    PaidCapabilityReconciliationRequest,
)

router = APIRouter(
    prefix="/admin/paid-capabilities",
    tags=["admin-paid-capabilities"],
    dependencies=[Depends(require_admin)],
)


def _ceil_div(numerator: int, denominator: int) -> int:
    return (numerator + denominator - 1) // denominator


def _maximum_sellable_points_per_cny(db: Session, project_id: int) -> int:
    packages = db.execute(
        select(Plan.points_amount, Plan.sale_price_cent)
        .join(Product, Product.id == Plan.product_id)
        .where(
            Product.project_id == project_id,
            Plan.plan_kind == "points",
            Plan.status == "active",
            Plan.online_sale_enabled.is_(True),
            Plan.points_amount > 0,
            Plan.sale_price_cent > 0,
        )
    ).all()
    return max(
        (_ceil_div(points * 100, price_cent) for points, price_cent in packages),
        default=0,
    )


def _read(rate: PaidCapabilityRateCard) -> PaidCapabilityRateCardRead:
    return PaidCapabilityRateCardRead.model_validate(
        {column.name: getattr(rate, column.name) for column in rate.__table__.columns}
    )


def _reconciliation_read(job: PaidCapabilityJob) -> PaidCapabilityReconciliationRead:
    reservation = job.reservation
    return PaidCapabilityReconciliationRead(
        id=job.id,
        user_id=job.user_id,
        project_id=job.project_id,
        capability=job.capability,
        version=job.version,
        status=job.status,
        error_code=job.error_code,
        reserved_points=reservation.reserved_points if reservation else 0,
        settled_points=reservation.settled_points if reservation else 0,
        released_points=reservation.released_points if reservation else 0,
        accepted_at=job.accepted_at,
        completed_at=job.completed_at,
        settled_at=job.settled_at,
    )


@router.get("/rate-cards", response_model=list[PaidCapabilityRateCardRead])
def list_rate_cards(
    project_id: int | None = Query(default=None, gt=0),
    capability: str | None = Query(default=None, max_length=96),
    status: str | None = Query(default=None, max_length=24),
    db: Session = Depends(get_db),
) -> list[PaidCapabilityRateCardRead]:
    filters = []
    if project_id is not None:
        filters.append(PaidCapabilityRateCard.project_id == project_id)
    if capability:
        filters.append(PaidCapabilityRateCard.capability == capability)
    if status:
        filters.append(PaidCapabilityRateCard.status == status)
    rates = db.scalars(
        select(PaidCapabilityRateCard)
        .where(*filters)
        .order_by(PaidCapabilityRateCard.created_at.desc(), PaidCapabilityRateCard.id.desc())
        .limit(500)
    ).all()
    return [_read(rate) for rate in rates]


@router.post(
    "/rate-cards",
    response_model=PaidCapabilityRateCardRead,
    status_code=201,
)
def create_rate_card(
    payload: PaidCapabilityRateCardCreate,
    db: Session = Depends(get_db),
) -> PaidCapabilityRateCardRead:
    # Project row is the shared pricing mutex for rate-card and point-package
    # changes, so two concurrent admin requests cannot both pass stale checks.
    project = db.scalar(select(Project).where(Project.id == payload.project_id).with_for_update())
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    required_points_per_cny = _maximum_sellable_points_per_cny(db, payload.project_id)
    if payload.points_per_cny < required_points_per_cny:
        raise HTTPException(
            status_code=422,
            detail=(
                "Rate-card points_per_cny is below the most generous active point package "
                f"({required_points_per_cny})"
            ),
        )
    try:
        descriptor = get_paid_capability(payload.capability, payload.version)
    except PaidCapabilityContractError as exc:
        raise HTTPException(status_code=422, detail="Unsupported paid capability/version") from exc
    legacy_provider = {
        "text": "builtin-text",
        "image": "builtin-image",
        "seerfar": "seerfar",
    }[descriptor.provider_kind]
    pool_provider = db.scalar(
        select(ApiPoolProvider).where(ApiPoolProvider.code == payload.provider_code)
    )
    if pool_provider is None:
        if payload.provider_code != legacy_provider:
            raise HTTPException(status_code=422, detail="Provider does not match capability")
    elif (
        pool_provider.status != "active"
        or not provider_supports_kind(pool_provider, descriptor.provider_kind)
    ):
        raise HTTPException(status_code=422, detail="API pool provider is unavailable")
    if descriptor.provider_kind in {"text", "image"} and not payload.provider_model.strip():
        raise HTTPException(status_code=422, detail="Provider model is required")
    if descriptor.provider_kind == "image" and not image_model_is_allowed(
        payload.provider_model
    ):
        raise HTTPException(
            status_code=422,
            detail=f"Image generation only permits {APPROVED_IMAGE_MODEL}",
        )
    if pool_provider is not None and descriptor.provider_kind in {"text", "image"}:
        pool_model = db.scalar(
            select(ApiPoolModel.id).where(
                ApiPoolModel.provider_id == pool_provider.id,
                ApiPoolModel.capability_kind == descriptor.provider_kind,
                ApiPoolModel.model_code == payload.provider_model,
                ApiPoolModel.status == "active",
            )
        )
        if pool_model is None:
            raise HTTPException(status_code=422, detail="API pool model is unavailable")
    if payload.effective_until is not None and payload.effective_until <= payload.effective_from:
        raise HTTPException(status_code=422, detail="Rate-card time range is invalid")
    if payload.unit_sell_price_micros and descriptor.provider_kind != "image":
        raise HTTPException(
            status_code=422,
            detail="Fixed unit sell price is only supported for image capabilities",
        )
    if (
        payload.unit_sell_price_micros
        and payload.unit_sell_price_micros < payload.unit_cost_micros
    ):
        raise HTTPException(status_code=422, detail="Image sell price is below configured cost")
    try:
        PricingPolicy(
            input_micros_per_million=payload.input_micros_per_million,
            output_micros_per_million=payload.output_micros_per_million,
            cached_input_micros_per_million=payload.cached_input_micros_per_million,
            fixed_cost_micros=payload.fixed_cost_micros,
            unit_cost_micros=payload.unit_cost_micros,
            unit_sell_price_micros=payload.unit_sell_price_micros,
            provider_multiplier_ppm=payload.provider_multiplier_ppm,
            customer_multiplier_ppm=payload.customer_multiplier_ppm,
            risk_buffer_basis_points=payload.risk_buffer_basis_points,
            target_margin_basis_points=payload.target_margin_basis_points,
            minimum_margin_basis_points=payload.minimum_margin_basis_points,
            points_per_cny=payload.points_per_cny,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Rate-card pricing is invalid") from exc
    start = payload.effective_from.astimezone(UTC)
    end = payload.effective_until.astimezone(UTC) if payload.effective_until else None
    overlap_filters = [
        PaidCapabilityRateCard.project_id == payload.project_id,
        PaidCapabilityRateCard.capability == payload.capability,
        PaidCapabilityRateCard.version == payload.version,
        PaidCapabilityRateCard.provider_model == payload.provider_model,
        PaidCapabilityRateCard.status == "active",
        or_(
            PaidCapabilityRateCard.effective_until.is_(None),
            PaidCapabilityRateCard.effective_until > start,
        ),
    ]
    if end is not None:
        overlap_filters.append(PaidCapabilityRateCard.effective_from < end)
    overlap = db.scalar(select(PaidCapabilityRateCard.id).where(*overlap_filters))
    if overlap is not None:
        raise HTTPException(status_code=409, detail="Active rate-card time range overlaps")
    rate = PaidCapabilityRateCard(
        **payload.model_dump(exclude={"effective_from", "effective_until"}),
        effective_from=start,
        effective_until=end,
        status="active",
    )
    db.add(rate)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Rate card already exists") from exc
    db.refresh(rate)
    return _read(rate)


@router.post(
    "/rate-cards/{rate_card_id}/image-price",
    response_model=PaidCapabilityRateCardRead,
)
def replace_image_price(
    rate_card_id: int,
    payload: PaidCapabilityImagePriceUpdate,
    db: Session = Depends(get_db),
) -> PaidCapabilityRateCardRead:
    rate = db.scalar(
        select(PaidCapabilityRateCard)
        .where(PaidCapabilityRateCard.id == rate_card_id)
        .with_for_update()
    )
    if rate is None:
        raise HTTPException(status_code=404, detail="Rate card not found")
    if rate.status != "active" or not rate.capability.startswith("image."):
        raise HTTPException(status_code=409, detail="Active image rate card is required")
    if not image_model_is_allowed(rate.provider_model):
        raise HTTPException(
            status_code=422,
            detail=f"Image generation only permits {APPROVED_IMAGE_MODEL}",
        )
    if payload.unit_sell_price_micros < payload.unit_cost_micros:
        raise HTTPException(status_code=422, detail="Image sell price is below configured cost")
    project = db.scalar(select(Project).where(Project.id == rate.project_id).with_for_update())
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    current = datetime.now(UTC)
    replacement_values = {
        column.name: getattr(rate, column.name)
        for column in PaidCapabilityRateCard.__table__.columns
        if column.name
        not in {
            "id",
            "created_at",
            "updated_at",
            "effective_from",
            "effective_until",
            "status",
            "price_version",
            "unit_cost_micros",
            "unit_sell_price_micros",
        }
    }
    replacement = PaidCapabilityRateCard(
        **replacement_values,
        price_version=f"image-price-{current:%Y%m%d%H%M%S%f}-{rate.id}",
        unit_cost_micros=payload.unit_cost_micros,
        unit_sell_price_micros=payload.unit_sell_price_micros,
        effective_from=current,
        effective_until=(
            rate.effective_until
            if rate.effective_until is not None and rate.effective_until > current
            else None
        ),
        status="active",
    )
    rate.status = "disabled"
    if rate.effective_until is None or rate.effective_until > current:
        rate.effective_until = current
    db.add(replacement)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Image price replacement conflicted") from exc
    db.refresh(replacement)
    return _read(replacement)


@router.post(
    "/rate-cards/{rate_card_id}/multipliers",
    response_model=PaidCapabilityRateCardRead,
)
def replace_rate_card_multipliers(
    rate_card_id: int,
    payload: PaidCapabilityMultiplierUpdate,
    db: Session = Depends(get_db),
) -> PaidCapabilityRateCardRead:
    rate = db.scalar(
        select(PaidCapabilityRateCard)
        .where(PaidCapabilityRateCard.id == rate_card_id)
        .with_for_update()
    )
    if rate is None:
        raise HTTPException(status_code=404, detail="Rate card not found")
    if rate.status != "active":
        raise HTTPException(status_code=409, detail="Active rate card is required")
    if (
        rate.capability.startswith("text.")
        and rate.minimum_margin_basis_points == 0
        and rate.target_margin_basis_points == 0
        and payload.customer_multiplier_ppm != 1_200_000
    ):
        raise HTTPException(
            status_code=422,
            detail="Text model customer charge must remain exactly 1.2x upstream cost",
        )
    if rate.capability.startswith("image.") and not image_model_is_allowed(
        rate.provider_model
    ):
        raise HTTPException(
            status_code=422,
            detail=f"Image generation only permits {APPROVED_IMAGE_MODEL}",
        )
    project = db.scalar(select(Project).where(Project.id == rate.project_id).with_for_update())
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    current = datetime.now(UTC)
    excluded = {
        "id", "created_at", "updated_at", "effective_from", "effective_until",
        "status", "price_version", "provider_multiplier_ppm", "customer_multiplier_ppm",
    }
    replacement_values = {
        column.name: getattr(rate, column.name)
        for column in PaidCapabilityRateCard.__table__.columns
        if column.name not in excluded
    }
    replacement = PaidCapabilityRateCard(
        **replacement_values,
        price_version=f"multipliers-{current:%Y%m%d%H%M%S%f}-{rate.id}",
        provider_multiplier_ppm=payload.provider_multiplier_ppm,
        customer_multiplier_ppm=payload.customer_multiplier_ppm,
        effective_from=current,
        effective_until=(
            rate.effective_until
            if rate.effective_until is not None and rate.effective_until > current
            else None
        ),
        status="active",
    )
    rate.status = "disabled"
    if rate.effective_until is None or rate.effective_until > current:
        rate.effective_until = current
    db.add(replacement)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Rate multiplier replacement conflicted",
        ) from exc
    db.refresh(replacement)
    return _read(replacement)


@router.post("/rate-cards/{rate_card_id}/disable", response_model=PaidCapabilityRateCardRead)
def disable_rate_card(
    rate_card_id: int,
    db: Session = Depends(get_db),
) -> PaidCapabilityRateCardRead:
    rate = db.scalar(
        select(PaidCapabilityRateCard)
        .where(PaidCapabilityRateCard.id == rate_card_id)
        .with_for_update()
    )
    if rate is None:
        raise HTTPException(status_code=404, detail="Rate card not found")
    rate.status = "disabled"
    db.commit()
    db.refresh(rate)
    return _read(rate)


@router.get("/reconciliations", response_model=list[PaidCapabilityReconciliationRead])
def list_reconciliations(
    project_id: int | None = Query(default=None, gt=0),
    status: str = Query(default="reconciliation_required", max_length=32),
    db: Session = Depends(get_db),
) -> list[PaidCapabilityReconciliationRead]:
    filters = [PaidCapabilityJob.status == status]
    if project_id is not None:
        filters.append(PaidCapabilityJob.project_id == project_id)
    jobs = db.scalars(
        select(PaidCapabilityJob)
        .where(*filters)
        .options(joinedload(PaidCapabilityJob.reservation))
        .order_by(PaidCapabilityJob.completed_at, PaidCapabilityJob.id)
        .limit(500)
    ).all()
    return [_reconciliation_read(job) for job in jobs]


@router.post(
    "/reconciliations/{job_id}",
    response_model=PaidCapabilityReconciliationRead,
)
def reconcile_job(
    job_id: str,
    payload: PaidCapabilityReconciliationRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> PaidCapabilityReconciliationRead:
    try:
        job = reconcile_paid_capability_job(
            db,
            job_id=job_id,
            decision=payload.decision,
            usage=ProviderUsage(
                input_tokens=payload.input_tokens,
                output_tokens=payload.output_tokens,
                cached_input_tokens=payload.cached_input_tokens,
                units=payload.units,
            ),
            provider_request_id=payload.provider_request_id,
            actual_provider_cost_micros=payload.actual_provider_cost_micros,
        )
    except PaidCapabilityFailure as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message, "jobId": exc.job_id},
        ) from exc
    db.add(
        UsageLog(
            user_id=admin.id,
            project_id=job.project_id,
            event="paid_capability_reconciled",
            details={
                "job_id": job.id,
                "decision": payload.decision,
                "note_sha256": hashlib.sha256(payload.note.encode("utf-8")).hexdigest(),
            },
        )
    )
    db.commit()
    db.refresh(job)
    return _reconciliation_read(job)

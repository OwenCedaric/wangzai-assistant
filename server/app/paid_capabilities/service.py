from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.base import as_utc
from app.models.paid_capabilities import (
    PaidCapabilityJob,
    PaidCapabilityQuote,
    PaidCapabilityRateCard,
    ProviderUsageEvent,
)
from app.paid_capabilities.api_pool_routing import dispatch_provider_code
from app.paid_capabilities.image_model_policy import (
    APPROVED_IMAGE_MODEL,
    image_model_is_allowed,
)
from app.paid_capabilities.model_presets import (
    ModelPresetError,
    resolve_model_rate_card,
)
from app.paid_capabilities.pricing import (
    PricingPolicy,
    ProviderUsage,
    calculate_charge_points,
    calculate_charge_points_from_provider_cost,
    calculate_provider_cost_micros,
    calculate_reservation_points,
)
from app.paid_capabilities.providers import (
    PaidCapabilityProvider,
    PaidProviderFailure,
    PaidProviderResult,
)
from app.paid_capabilities.registry import PaidCapabilityDescriptor
from app.paid_capabilities.reservations import (
    release_paid_capability_job,
    reserve_paid_capability_job,
    settle_paid_capability_job,
)
from app.protected_compute.canonical import CanonicalValueError, canonical_json, canonical_sha256

# Provider groups are priced as a fraction of each model's server-owned base
# rate. Quotes keep the conservative rate-card multiplier; settlement replaces
# it with the provider that actually handled the request.
TEXT_PROVIDER_MULTIPLIER_PPM: dict[str, int] = {
    "dragon": 100_000,
    "haoyue": 120_000,
    "wawa": 120_000,
    "callai": 150_000,
}


@dataclass(frozen=True, slots=True)
class PaidCapabilityFailure(Exception):
    code: str
    message: str
    status_code: int
    job_id: str | None = None


def _fail(
    code: str,
    message: str,
    status_code: int = 400,
    *,
    job_id: str | None = None,
) -> None:
    raise PaidCapabilityFailure(code, message, status_code, job_id)


def pricing_policy(rate: PaidCapabilityRateCard) -> PricingPolicy:
    return PricingPolicy(
        input_micros_per_million=rate.input_micros_per_million,
        output_micros_per_million=rate.output_micros_per_million,
        cached_input_micros_per_million=rate.cached_input_micros_per_million,
        fixed_cost_micros=rate.fixed_cost_micros,
        unit_cost_micros=rate.unit_cost_micros,
        unit_sell_price_micros=rate.unit_sell_price_micros,
        provider_multiplier_ppm=rate.provider_multiplier_ppm,
        customer_multiplier_ppm=rate.customer_multiplier_ppm,
        risk_buffer_basis_points=rate.risk_buffer_basis_points,
        target_margin_basis_points=rate.target_margin_basis_points,
        minimum_margin_basis_points=rate.minimum_margin_basis_points,
        points_per_cny=rate.points_per_cny,
    )


def active_rate_card(
    db: Session,
    *,
    project_id: int,
    descriptor: PaidCapabilityDescriptor,
    now: datetime,
    provider_model: str | None = None,
) -> PaidCapabilityRateCard:
    if descriptor.provider_kind == "image":
        if provider_model is not None and not image_model_is_allowed(provider_model):
            _fail(
                "PAID_CAPABILITY_IMAGE_MODEL_FORBIDDEN",
                f"图片生成只允许 {APPROVED_IMAGE_MODEL}",
                422,
            )
        provider_model = APPROVED_IMAGE_MODEL
    filters = [
        PaidCapabilityRateCard.project_id == project_id,
        PaidCapabilityRateCard.capability == descriptor.capability,
        PaidCapabilityRateCard.version == descriptor.version,
        PaidCapabilityRateCard.status == "active",
        PaidCapabilityRateCard.effective_from <= now,
        or_(
            PaidCapabilityRateCard.effective_until.is_(None),
            PaidCapabilityRateCard.effective_until > now,
        ),
    ]
    if provider_model is not None:
        filters.append(PaidCapabilityRateCard.provider_model == provider_model)
    rate = db.scalar(
        select(PaidCapabilityRateCard)
        .where(*filters)
        .order_by(PaidCapabilityRateCard.effective_from.desc(), PaidCapabilityRateCard.id.desc())
    )
    if rate is None:
        _fail(
            "PAID_CAPABILITY_RATE_UNAVAILABLE",
            "Paid capability pricing is unavailable",
            503,
        )
    return rate


def issue_quote(
    db: Session,
    *,
    user_id: int,
    project_id: int,
    descriptor: PaidCapabilityDescriptor,
    normalized_input: dict[str, Any],
    ttl_seconds: int,
    requested_model: str | None = None,
    text_reservation_multiplier_ppm: int = 1_250_000,
    image_reservation_multiplier_ppm: int = 2_000_000,
    now: datetime | None = None,
) -> PaidCapabilityQuote:
    current = (now or datetime.now(UTC)).astimezone(UTC)
    try:
        resolved = resolve_model_rate_card(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            requested_model=requested_model,
            now=current,
        )
    except ModelPresetError as exc:
        _fail(exc.code, exc.message, exc.status_code)
    rate = (
        resolved.rate_card
        if resolved is not None
        else active_rate_card(
            db,
            project_id=project_id,
            descriptor=descriptor,
            now=current,
            provider_model=requested_model,
        )
    )
    policy = pricing_policy(rate)
    estimated_points = calculate_charge_points(policy, descriptor.estimate_usage(normalized_input))
    reservation_policy = policy
    if rate.provider_code == "builtin-text":
        reservation_policy = replace(
            policy,
            provider_multiplier_ppm=max(
                policy.provider_multiplier_ppm,
                text_reservation_multiplier_ppm,
            ),
        )
    elif rate.provider_code == "builtin-image":
        reservation_policy = replace(
            policy,
            provider_multiplier_ppm=max(
                policy.provider_multiplier_ppm,
                image_reservation_multiplier_ppm,
            ),
        )
    maximum_points = calculate_reservation_points(
        reservation_policy,
        descriptor.maximum_usage(normalized_input),
    )
    if maximum_points <= 0 or estimated_points > maximum_points:
        _fail(
            "PAID_CAPABILITY_RATE_INVALID",
            "Paid capability pricing is invalid",
            503,
        )
    quote = PaidCapabilityQuote(
        id=str(uuid4()),
        user_id=user_id,
        project_id=project_id,
        rate_card_id=rate.id,
        capability=descriptor.capability,
        version=descriptor.version,
        input_hash=paid_input_hash(normalized_input),
        estimated_points=estimated_points,
        maximum_points=maximum_points,
        status="active",
        expires_at=current + timedelta(seconds=ttl_seconds),
    )
    db.add(quote)
    db.flush()
    return quote


def _request_hash(*, quote_id: str, input_hash: str, idempotency_key: str) -> str:
    return canonical_sha256(
        {
            "contract": "paid-capability-job-request/v1",
            "idempotencyKey": idempotency_key,
            "inputHash": input_hash,
            "quoteId": quote_id,
        }
    )


def _provider_request_hash(value: str | None) -> str | None:
    if not value:
        return None
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _record_usage(
    db: Session,
    *,
    job: PaidCapabilityJob,
    rate: PaidCapabilityRateCard,
    usage: ProviderUsage,
    provider_request_id: str | None,
    billable: bool,
    charged_points: int,
    provider_code: str | None = None,
    provider_model: str | None = None,
    provider_cost_micros: int | None = None,
    provider_cost_source: str = "rate_card",
) -> None:
    usage.validate()
    effective_provider_cost = (
        calculate_provider_cost_micros(pricing_policy(rate), usage)
        if provider_cost_micros is None
        else provider_cost_micros
    )
    usage_payload = {
        "cachedInputTokens": usage.cached_input_tokens,
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "providerCostMicros": effective_provider_cost,
        "providerCostSource": provider_cost_source,
        "units": usage.units,
    }
    db.add(
        ProviderUsageEvent(
            job_id=job.id,
            event_key="final",
            provider_code=provider_code or rate.provider_code,
            provider_model=provider_model or rate.provider_model,
            operation=job.capability,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cached_input_tokens=usage.cached_input_tokens,
            units=usage.units,
            provider_cost_micros=effective_provider_cost,
            provider_cost_source=provider_cost_source,
            charged_points=charged_points,
            billable=1 if billable else 0,
            provider_request_id_hash=_provider_request_hash(provider_request_id),
            usage_hash=canonical_sha256(usage_payload),
        )
    )


def _settlement_cost_and_points(
    rate: PaidCapabilityRateCard,
    usage: ProviderUsage,
    *,
    measured_provider_cost_micros: int | None,
    provider_cost_source: str | None,
    provider_code: str | None = None,
    require_measured_cost: bool = False,
) -> tuple[int, int, str]:
    policy = pricing_policy(rate)
    provider_multiplier = TEXT_PROVIDER_MULTIPLIER_PPM.get(str(provider_code or ""))
    if measured_provider_cost_micros is None and provider_multiplier is not None:
        policy = replace(policy, provider_multiplier_ppm=provider_multiplier)
    if measured_provider_cost_micros is not None:
        points = (
            calculate_charge_points(policy, usage)
            if policy.unit_sell_price_micros
            else calculate_charge_points_from_provider_cost(
                policy,
                measured_provider_cost_micros,
            )
        )
        return (
            measured_provider_cost_micros,
            points,
            provider_cost_source or "provider_usage_delta",
        )
    if require_measured_cost:
        raise ValueError("measured provider cost is required for built-in text")
    cost = calculate_provider_cost_micros(policy, usage)
    return cost, calculate_charge_points(policy, usage), "rate_card"


def _uses_metered_margin(rate: PaidCapabilityRateCard, cost_source: str) -> bool:
    return cost_source != "rate_card" and rate.unit_sell_price_micros == 0


def _load_idempotent_job(
    db: Session,
    *,
    user_id: int,
    project_id: int,
    idempotency_key: str,
    request_hash: str,
) -> PaidCapabilityJob | None:
    job = db.scalar(
        select(PaidCapabilityJob).where(
            PaidCapabilityJob.user_id == user_id,
            PaidCapabilityJob.project_id == project_id,
            PaidCapabilityJob.idempotency_key == idempotency_key,
        )
    )
    if job is not None and not hmac.compare_digest(job.request_hash, request_hash):
        _fail(
            "PAID_CAPABILITY_IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for another request",
            409,
        )
    return job


def _return_or_raise_existing(job: PaidCapabilityJob) -> PaidCapabilityJob:
    if job.status == "completed" and job.result_json is not None:
        return job
    if job.status in {"accepted", "reserved", "provider_running", "reconciliation_required"}:
        _fail(
            "PAID_CAPABILITY_JOB_PENDING",
            "Paid capability job is still pending reconciliation",
            409,
            job_id=job.id,
        )
    _fail(
        job.error_code or "PAID_CAPABILITY_JOB_FAILED",
        "Paid capability job has already failed",
        409,
        job_id=job.id,
    )


def execute_paid_capability(
    db: Session,
    *,
    user_id: int,
    project_id: int,
    descriptor: PaidCapabilityDescriptor,
    quote_id: str,
    normalized_input: dict[str, Any],
    input_hash: str,
    idempotency_key: str,
    provider: PaidCapabilityProvider,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> PaidCapabilityJob:
    calculated_hash = paid_input_hash(normalized_input)
    if not hmac.compare_digest(calculated_hash, input_hash):
        _fail(
            "PAID_CAPABILITY_INPUT_HASH_MISMATCH",
            "Paid capability input hash does not match normalized input",
        )
    request_hash = _request_hash(
        quote_id=quote_id,
        input_hash=input_hash,
        idempotency_key=idempotency_key,
    )
    existing = _load_idempotent_job(
        db,
        user_id=user_id,
        project_id=project_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if existing is not None:
        return _return_or_raise_existing(existing)

    current = now().astimezone(UTC)
    quote = db.scalar(
        select(PaidCapabilityQuote).where(PaidCapabilityQuote.id == quote_id).with_for_update()
    )
    if quote is None or quote.user_id != user_id or quote.project_id != project_id:
        _fail("PAID_CAPABILITY_QUOTE_NOT_FOUND", "Paid capability quote was not found", 404)
    if quote.status != "active" or as_utc(quote.expires_at) <= current:
        _fail("PAID_CAPABILITY_QUOTE_EXPIRED", "Paid capability quote has expired", 409)
    if quote.capability != descriptor.capability or quote.version != descriptor.version:
        _fail("PAID_CAPABILITY_QUOTE_MISMATCH", "Paid capability quote does not match", 409)
    if not hmac.compare_digest(quote.input_hash, input_hash):
        _fail("PAID_CAPABILITY_QUOTE_MISMATCH", "Paid capability quote does not match input", 409)
    rate = db.get(PaidCapabilityRateCard, quote.rate_card_id)
    if rate is None:
        _fail("PAID_CAPABILITY_RATE_UNAVAILABLE", "Paid capability pricing is unavailable", 503)

    routed_provider_code = dispatch_provider_code(
        db,
        capability_kind=descriptor.provider_kind,
        model_code=rate.provider_model,
        fallback_provider_code=rate.provider_code,
    )

    job = PaidCapabilityJob(
        id=str(uuid4()),
        user_id=user_id,
        project_id=project_id,
        quote_id=quote.id,
        capability=descriptor.capability,
        version=descriptor.version,
        input_hash=input_hash,
        request_hash=request_hash,
        idempotency_key=idempotency_key,
        status="accepted",
        accepted_at=current,
    )
    db.add(job)
    db.flush()
    reserve_paid_capability_job(db, job=job, amount_points=quote.maximum_points, now=current)
    quote.status = "used"
    quote.used_at = current
    job.status = "provider_running"
    db.commit()  # The reservation must be durable before any paid provider request.

    try:
        provider_result = provider.execute(
            descriptor,
            normalized_input,
            provider_code=routed_provider_code,
            provider_model=rate.provider_model,
        )
    except PaidProviderFailure as exc:
        actual_provider_code = exc.provider_code or routed_provider_code
        db.expire_all()
        locked_job = db.scalar(
            select(PaidCapabilityJob).where(PaidCapabilityJob.id == job.id).with_for_update()
        )
        assert locked_job is not None
        locked_rate = db.get(PaidCapabilityRateCard, quote.rate_card_id)
        assert locked_rate is not None
        locked_job.error_code = exc.code
        locked_job.provider_request_id_hash = _provider_request_hash(exc.provider_request_id)
        locked_job.completed_at = now().astimezone(UTC)
        if exc.billable is False:
            release_paid_capability_job(db, job=locked_job, reason=exc.code, now=now())
            locked_job.status = "failed_unbilled"
        elif exc.billable is True and (
            exc.usage is not None or exc.actual_provider_cost_micros is not None
        ):
            billed_usage = exc.usage or ProviderUsage()
            try:
                provider_cost, actual_points, cost_source = _settlement_cost_and_points(
                    locked_rate,
                    billed_usage,
                    measured_provider_cost_micros=exc.actual_provider_cost_micros,
                    provider_cost_source=exc.provider_cost_source,
                    provider_code=exc.provider_code,
                    require_measured_cost=actual_provider_code
                    in {"codesonline", "codesonline-2"},
                )
            except ValueError:
                locked_job.status = "reconciliation_required"
                db.commit()
                raise PaidCapabilityFailure(
                    exc.code,
                    exc.message,
                    exc.status_code,
                    locked_job.id,
                ) from exc
            reservation = locked_job.reservation
            if reservation is None or actual_points > reservation.reserved_points:
                locked_job.status = "reconciliation_required"
            else:
                settled = settle_paid_capability_job(
                    db,
                    job=locked_job,
                    actual_points=actual_points,
                    metered_provider_cost_micros=(
                        provider_cost
                        if _uses_metered_margin(locked_rate, cost_source)
                        else None
                    ),
                    metered_pricing_policy=(
                        pricing_policy(locked_rate)
                        if _uses_metered_margin(locked_rate, cost_source)
                        else None
                    ),
                    now=now(),
                )
                actual_points = settled.settled_points
                _record_usage(
                    db,
                    job=locked_job,
                    rate=locked_rate,
                    usage=billed_usage,
                    provider_request_id=exc.provider_request_id,
                    billable=True,
                    charged_points=actual_points,
                    provider_code=actual_provider_code,
                    provider_model=locked_rate.provider_model,
                    provider_cost_micros=provider_cost,
                    provider_cost_source=cost_source,
                )
                locked_job.status = "failed_billed"
        else:
            locked_job.status = "reconciliation_required"
        db.commit()
        raise PaidCapabilityFailure(exc.code, exc.message, exc.status_code, locked_job.id) from exc
    except Exception as exc:
        db.rollback()
        db.expire_all()
        locked_job = db.scalar(
            select(PaidCapabilityJob).where(PaidCapabilityJob.id == job.id).with_for_update()
        )
        if locked_job is not None:
            locked_job.status = "reconciliation_required"
            locked_job.error_code = "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN"
            locked_job.completed_at = now().astimezone(UTC)
            db.commit()
        raise PaidCapabilityFailure(
            "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN",
            "Provider outcome is unknown and has been held for reconciliation",
            503,
            job.id,
        ) from exc

    actual_provider_code = provider_result.provider_code or routed_provider_code
    return _complete_success(
        db,
        job_id=job.id,
        rate_card_id=rate.id,
        provider_result=provider_result,
        provider_code=actual_provider_code,
        provider_model=rate.provider_model,
        require_measured_cost=actual_provider_code in {"codesonline", "codesonline-2"},
        now=now,
    )


def _complete_success(
    db: Session,
    *,
    job_id: str,
    rate_card_id: int,
    provider_result: PaidProviderResult,
    provider_code: str,
    provider_model: str,
    require_measured_cost: bool,
    now: Callable[[], datetime],
) -> PaidCapabilityJob:
    try:
        canonical_json(provider_result.result)
        provider_result.usage.validate()
        if (
            provider_result.actual_provider_cost_micros is not None
            and provider_result.actual_provider_cost_micros < 0
        ):
            raise ValueError("provider cost must be non-negative")
    except (CanonicalValueError, TypeError, ValueError) as exc:
        db.expire_all()
        job = db.scalar(
            select(PaidCapabilityJob).where(PaidCapabilityJob.id == job_id).with_for_update()
        )
        assert job is not None
        job.status = "reconciliation_required"
        job.error_code = "PAID_CAPABILITY_PROVIDER_RESULT_INVALID"
        job.completed_at = now().astimezone(UTC)
        db.commit()
        raise PaidCapabilityFailure(
            "PAID_CAPABILITY_PROVIDER_RESULT_INVALID",
            "Provider result was rejected",
            502,
            job.id,
        ) from exc

    db.expire_all()
    job = db.scalar(
        select(PaidCapabilityJob).where(PaidCapabilityJob.id == job_id).with_for_update()
    )
    rate = db.get(PaidCapabilityRateCard, rate_card_id)
    assert job is not None and rate is not None
    try:
        provider_cost, actual_points, cost_source = _settlement_cost_and_points(
            rate,
            provider_result.usage,
            measured_provider_cost_micros=provider_result.actual_provider_cost_micros,
            provider_cost_source=provider_result.provider_cost_source,
            provider_code=provider_result.provider_code,
            require_measured_cost=require_measured_cost,
        )
    except ValueError as exc:
        job.status = "reconciliation_required"
        job.error_code = "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE"
        job.completed_at = now().astimezone(UTC)
        db.commit()
        raise PaidCapabilityFailure(
            "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE",
            "Provider result is missing trustworthy cost evidence",
            503,
            job.id,
        ) from exc
    reservation = job.reservation
    if reservation is None or actual_points > reservation.reserved_points:
        job.status = "reconciliation_required"
        job.error_code = "PAID_CAPABILITY_USAGE_ABOVE_RESERVATION"
        job.completed_at = now().astimezone(UTC)
        db.commit()
        _fail(
            "PAID_CAPABILITY_USAGE_ABOVE_RESERVATION",
            "Provider usage exceeded the reserved maximum",
            503,
            job_id=job.id,
        )
    settled = settle_paid_capability_job(
        db,
        job=job,
        actual_points=actual_points,
        metered_provider_cost_micros=(
            provider_cost if _uses_metered_margin(rate, cost_source) else None
        ),
        metered_pricing_policy=(
            pricing_policy(rate) if _uses_metered_margin(rate, cost_source) else None
        ),
        now=now(),
    )
    actual_points = settled.settled_points
    _record_usage(
        db,
        job=job,
        rate=rate,
        usage=provider_result.usage,
        provider_request_id=provider_result.provider_request_id,
        billable=True,
        charged_points=actual_points,
        provider_code=provider_code,
        provider_model=provider_model,
        provider_cost_micros=provider_cost,
        provider_cost_source=cost_source,
    )
    job.result_json = provider_result.result
    job.provider_request_id_hash = _provider_request_hash(provider_result.provider_request_id)
    job.error_code = None
    job.status = "completed"
    job.completed_at = now().astimezone(UTC)
    db.commit()
    db.refresh(job)
    return job


def paid_input_hash(value: dict[str, Any]) -> str:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        _fail("PAID_CAPABILITY_INPUT_REJECTED", "Paid capability input is invalid", 422)
        raise AssertionError("unreachable") from exc
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def reconcile_paid_capability_job(
    db: Session,
    *,
    job_id: str,
    decision: str,
    usage: ProviderUsage,
    provider_request_id: str | None,
    actual_provider_cost_micros: int | None = None,
    now: datetime | None = None,
) -> PaidCapabilityJob:
    current = (now or datetime.now(UTC)).astimezone(UTC)
    job = db.scalar(
        select(PaidCapabilityJob).where(PaidCapabilityJob.id == job_id).with_for_update()
    )
    if job is None:
        _fail("PAID_CAPABILITY_JOB_NOT_FOUND", "Paid capability job was not found", 404)
    if job.status != "reconciliation_required":
        _fail(
            "PAID_CAPABILITY_RECONCILIATION_CONFLICT",
            "Paid capability job is not awaiting reconciliation",
            409,
            job_id=job.id,
        )
    quote = db.get(PaidCapabilityQuote, job.quote_id)
    rate = db.get(PaidCapabilityRateCard, quote.rate_card_id) if quote is not None else None
    if rate is None:
        _fail(
            "PAID_CAPABILITY_RATE_UNAVAILABLE",
            "Historical paid capability pricing is unavailable",
            503,
            job_id=job.id,
        )
    if decision == "release_unbilled":
        release_paid_capability_job(
            db,
            job=job,
            reason="管理员对账确认供应商未计费",
            now=current,
        )
        job.status = "failed_unbilled"
    elif decision == "settle_billed":
        usage.validate()
        try:
            provider_cost, actual_points, cost_source = _settlement_cost_and_points(
                rate,
                usage,
                measured_provider_cost_micros=actual_provider_cost_micros,
                provider_cost_source=(
                    "admin_verified_provider_cost"
                    if actual_provider_cost_micros is not None
                    else None
                ),
                require_measured_cost=rate.provider_code
                in {"builtin-text", "builtin-image"},
            )
        except ValueError as exc:
            _fail(
                "PAID_CAPABILITY_PROVIDER_COST_REQUIRED",
                "Verified provider cost is required for this reconciliation",
                422,
                job_id=job.id,
            )
            raise AssertionError("unreachable") from exc
        reservation = job.reservation
        if reservation is None or actual_points > reservation.reserved_points:
            _fail(
                "PAID_CAPABILITY_USAGE_ABOVE_RESERVATION",
                "Reconciled provider usage exceeded the reserved maximum",
                409,
                job_id=job.id,
            )
        settled = settle_paid_capability_job(
            db,
            job=job,
            actual_points=actual_points,
            metered_provider_cost_micros=(
                provider_cost if _uses_metered_margin(rate, cost_source) else None
            ),
            metered_pricing_policy=(
                pricing_policy(rate) if _uses_metered_margin(rate, cost_source) else None
            ),
            now=current,
        )
        actual_points = settled.settled_points
        _record_usage(
            db,
            job=job,
            rate=rate,
            usage=usage,
            provider_request_id=provider_request_id,
            billable=True,
            charged_points=actual_points,
            provider_cost_micros=provider_cost,
            provider_cost_source=cost_source,
        )
        job.status = "failed_billed"
        job.provider_request_id_hash = _provider_request_hash(provider_request_id)
    else:
        _fail(
            "PAID_CAPABILITY_RECONCILIATION_INVALID",
            "Paid capability reconciliation decision is invalid",
            422,
            job_id=job.id,
        )
    job.completed_at = current
    db.flush()
    return job

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import Field, StrictInt, field_validator, model_validator

from app.protected_compute.secret_guard import SecretInputError, reject_secret_material
from app.schemas.common import StrictModel


class PaidCapabilityQuoteRequest(StrictModel):
    contract: Literal["paid-capability-quote-request/v1"]
    capability: str = Field(min_length=1, max_length=96, pattern=r"^[a-z][a-z0-9.-]+$")
    version: StrictInt = Field(ge=1, le=1_000_000)
    model: str | None = Field(
        default=None,
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$",
    )
    requestId: str = Field(
        pattern=(
            r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
            r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
        )
    )
    nonce: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    issuedAt: str = Field(
        min_length=24,
        max_length=30,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$",
    )
    input: dict[str, Any]


class PaidCapabilityJobRequest(StrictModel):
    contract: Literal["paid-capability-job-request/v1"]
    quoteId: str = Field(
        pattern=(
            r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
            r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
        )
    )
    requestId: str = Field(
        pattern=(
            r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
            r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
        )
    )
    nonce: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    issuedAt: str = Field(
        min_length=24,
        max_length=30,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$",
    )
    inputHash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    idempotencyKey: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    input: dict[str, Any]


class PaidCapabilityRateCardCreate(StrictModel):
    project_id: StrictInt = Field(gt=0)
    capability: str = Field(min_length=1, max_length=96)
    version: StrictInt = Field(default=1, ge=1, le=1_000_000)
    price_version: str = Field(min_length=1, max_length=128)
    provider_code: str = Field(
        min_length=2,
        max_length=64,
        pattern=r"^[a-z0-9][a-z0-9._-]{1,63}$",
    )
    provider_model: str = Field(default="", max_length=160)
    input_micros_per_million: StrictInt = Field(default=0, ge=0)
    output_micros_per_million: StrictInt = Field(default=0, ge=0)
    cached_input_micros_per_million: StrictInt = Field(default=0, ge=0)
    fixed_cost_micros: StrictInt = Field(default=0, ge=0)
    unit_cost_micros: StrictInt = Field(default=0, ge=0)
    unit_sell_price_micros: StrictInt = Field(default=0, ge=0)
    provider_multiplier_ppm: StrictInt = Field(default=1_000_000, ge=1)
    customer_multiplier_ppm: StrictInt = Field(default=1_000_000, ge=1_000_000, le=10_000_000)
    risk_buffer_basis_points: StrictInt = Field(default=500, ge=0, le=10_000)
    target_margin_basis_points: StrictInt = Field(default=1_800, ge=0, le=2_000)
    minimum_margin_basis_points: StrictInt = Field(default=1_500, ge=0, le=2_000)
    points_per_cny: StrictInt = Field(default=1_050, gt=0)
    currency: Literal["CNY"] = "CNY"
    effective_from: datetime
    effective_until: datetime | None = None

    @model_validator(mode="after")
    def validate_pricing_mode(self) -> PaidCapabilityRateCardCreate:
        exact_text_markup = (
            self.capability.startswith("text.")
            and self.minimum_margin_basis_points == 0
            and self.target_margin_basis_points == 0
            and self.customer_multiplier_ppm == 1_200_000
        )
        guarded_margin = (
            self.minimum_margin_basis_points >= 1_500
            and self.target_margin_basis_points >= self.minimum_margin_basis_points
        )
        if not (exact_text_markup or guarded_margin):
            raise ValueError(
                "pricing must use guarded margin or exact 1.2x text markup"
            )
        return self


class PaidCapabilityRateCardRead(StrictModel):
    id: int
    project_id: int
    capability: str
    version: int
    price_version: str
    provider_code: str
    provider_model: str
    input_micros_per_million: int
    output_micros_per_million: int
    cached_input_micros_per_million: int
    fixed_cost_micros: int
    unit_cost_micros: int
    unit_sell_price_micros: int
    provider_multiplier_ppm: int
    customer_multiplier_ppm: int
    risk_buffer_basis_points: int
    target_margin_basis_points: int
    minimum_margin_basis_points: int
    points_per_cny: int
    currency: str
    effective_from: datetime
    effective_until: datetime | None
    status: str
    created_at: datetime
    updated_at: datetime


class PaidCapabilityImagePriceUpdate(StrictModel):
    unit_cost_micros: StrictInt = Field(gt=0)
    unit_sell_price_micros: StrictInt = Field(gt=0)


class PaidCapabilityMultiplierUpdate(StrictModel):
    provider_multiplier_ppm: StrictInt = Field(ge=1, le=10_000_000)
    customer_multiplier_ppm: StrictInt = Field(ge=1_000_000, le=10_000_000)


class PaidCapabilityReconciliationRequest(StrictModel):
    decision: Literal["release_unbilled", "settle_billed"]
    input_tokens: StrictInt = Field(default=0, ge=0)
    output_tokens: StrictInt = Field(default=0, ge=0)
    cached_input_tokens: StrictInt = Field(default=0, ge=0)
    units: StrictInt = Field(default=0, ge=0)
    provider_request_id: str | None = Field(default=None, max_length=512)
    actual_provider_cost_micros: StrictInt | None = Field(default=None, ge=0)
    note: str = Field(min_length=3, max_length=500)

    @field_validator("note")
    @classmethod
    def reject_secret_note(cls, value: str) -> str:
        normalized = value.strip()
        try:
            reject_secret_material(normalized)
        except SecretInputError as exc:
            raise ValueError("secret material is forbidden in reconciliation notes") from exc
        if re.search(r"(?:^|[\s=:])sk-[A-Za-z0-9_-]{12,}", normalized, re.IGNORECASE):
            raise ValueError("secret material is forbidden in reconciliation notes")
        if len(normalized) < 3:
            raise ValueError("reconciliation note is too short")
        return normalized


class PaidCapabilityReconciliationRead(StrictModel):
    id: str
    user_id: int
    project_id: int
    capability: str
    version: int
    status: str
    error_code: str | None
    reserved_points: int
    settled_points: int
    released_points: int
    accepted_at: datetime | None
    completed_at: datetime | None
    settled_at: datetime | None

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field, model_validator

from app.schemas.common import StrictModel


class PointPackageCreate(StrictModel):
    product_id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=128)
    points_amount: int = Field(gt=0, le=2_000_000_000)
    sale_price_cent: int = Field(gt=0, le=999_999_999_999)
    validity_days: int = Field(default=30, ge=1, le=3650)
    customer_description: str | None = Field(default=None, max_length=1000)
    featured: bool = False
    display_order: int = Field(default=0, ge=0, le=100000)
    online_sale_enabled: bool = True
    status: str = Field(default="active", pattern=r"^(active|disabled)$")


class PointPackageUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    points_amount: int | None = Field(default=None, gt=0, le=2_000_000_000)
    sale_price_cent: int | None = Field(default=None, gt=0, le=999_999_999_999)
    validity_days: int | None = Field(default=None, ge=1, le=3650)
    customer_description: str | None = Field(default=None, max_length=1000)
    featured: bool | None = None
    display_order: int | None = Field(default=None, ge=0, le=100000)
    online_sale_enabled: bool | None = None
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")


class PointPackageRead(StrictModel):
    id: int
    project_id: int
    project_code: str
    product_id: int
    product_name: str
    name: str
    points_amount: int
    sale_price_cent: int
    currency: str = "CNY"
    validity_days: int
    customer_description: str | None
    featured: bool
    display_order: int
    online_sale_enabled: bool
    status: str
    payment_providers: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class PointWalletRead(StrictModel):
    wallet_id: int
    user_id: int
    project_id: int
    project_code: str
    balance_points: int
    reserved_points: int
    available_points: int
    lifetime_credited_points: int
    lifetime_spent_points: int
    next_expiry: datetime | None
    next_expiring_points: int
    updated_at: datetime


class AdminPointWalletRead(PointWalletRead):
    username: str
    email: str | None
    phone_masked: str | None


class PointLedgerRead(StrictModel):
    id: int
    wallet_id: int
    user_id: int
    project_id: int
    delta_points: int
    balance_after: int
    event_type: str
    reference_type: str | None
    reference_id: str | None
    reason: str | None
    details: dict[str, object]
    created_at: datetime


class PointSpendRequest(StrictModel):
    project_code: str = Field(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=64)
    amount_points: int = Field(gt=0, le=2_000_000_000)
    idempotency_key: str = Field(min_length=8, max_length=128)
    reason: str = Field(min_length=1, max_length=500)
    reference_type: str | None = Field(default=None, max_length=32)
    reference_id: str | None = Field(default=None, max_length=128)


class PointOperationResult(StrictModel):
    wallet: PointWalletRead
    idempotent: bool


class PointWalletAdjustment(StrictModel):
    operation: Literal["credit", "debit"]
    amount_points: int = Field(gt=0, le=2_000_000_000)
    reason: str = Field(min_length=2, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=128)
    validity_days: int | None = Field(default=None, ge=1, le=3650)

    @model_validator(mode="after")
    def credit_validity_only(self):
        if self.operation == "debit" and self.validity_days is not None:
            raise ValueError("validity_days is only valid for credit adjustments")
        return self

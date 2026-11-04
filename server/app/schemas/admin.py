from __future__ import annotations

from datetime import datetime

from pydantic import AliasChoices, Field

from app.schemas.common import ORMModel, StrictModel


class DashboardStats(StrictModel):
    users_total: int
    paid_users: int
    active_users_today: int
    online_users: int
    expired_licenses: int
    shops_by_platform: dict[str, int]
    launches_today: int
    feature_calls_today: int
    active_projects: int
    active_licenses: int


class CardBatchCreate(StrictModel):
    plan_id: int = Field(gt=0)
    name: str | None = Field(default=None, max_length=128)
    quantity: int = Field(ge=1, le=10000)
    duration_days: int | None = Field(
        default=None,
        ge=1,
        le=3650,
        validation_alias=AliasChoices("duration_days", "validity_days"),
    )
    expires_at: datetime | None = None


class CardBatchRead(ORMModel):
    id: int
    plan_id: int
    name: str
    quantity: int
    duration_days: int | None
    expires_at: datetime | None
    status: str
    created_by_user_id: int
    created_at: datetime
    updated_at: datetime


class CardBatchCreated(CardBatchRead):
    codes: list[str]
    export_available: bool


class CardBatchStatusUpdate(StrictModel):
    status: str = Field(pattern=r"^(active|disabled)$")


class ActivationCodeBoundShopRead(ORMModel):
    id: int
    license_id: int
    platform: str
    shop_name: str
    shop_id: str
    status: str


class ActivationCodeRead(ORMModel):
    id: int
    batch_id: int
    plan_id: int
    code_prefix: str
    status: str
    expires_at: datetime | None
    owner_user_id: int | None = None
    order_id: int | None = None
    activated_by_user_id: int | None
    activated_license_id: int | None
    activated_at: datetime | None
    activated_license_expire_at: datetime | None = None
    bound_shops: list[ActivationCodeBoundShopRead] = Field(default_factory=list)
    created_at: datetime


class ActivationCodeRevealedRead(ActivationCodeRead):
    card_key: str


class ActivationCodeRevealSearch(StrictModel):
    q: str | None = Field(default=None, max_length=128)
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=100, ge=1, le=500)


class ActivationCodeStatusUpdate(StrictModel):
    status: str = Field(pattern=r"^(unused|disabled)$")


class UsageLogRead(ORMModel):
    id: int
    user_id: int | None
    project_id: int | None
    license_id: int | None
    event: str
    device_code: str | None
    details: dict[str, object]
    created_at: datetime


class UsageEventCreate(StrictModel):
    project_code: str = Field(min_length=2, max_length=64)
    license_key: str = Field(min_length=12, max_length=64)
    event: str = Field(pattern=r"^(app_launch|feature_call|sync_order)$")
    device_code: str | None = Field(default=None, min_length=8, max_length=128)
    details: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

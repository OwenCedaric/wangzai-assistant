from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import StrictModel


class StorePlanRead(StrictModel):
    id: int
    project_id: int
    project_code: str
    product_id: int
    product_name: str
    name: str
    license_role: str
    sale_price_cent: int
    currency: str = "CNY"
    duration_days: int
    max_devices: int
    max_shops: int
    offline_hours: int
    online_required: bool
    permission_codes: list[str]
    payment_providers: list[str]


class OrderCreate(StrictModel):
    project_code: str = Field(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=64)
    plan_id: int = Field(gt=0)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=64)


class FulfillmentRead(StrictModel):
    status: str
    activation_code: str | None
    activation_code_prefix: str | None
    points_credited: int
    point_balance_after: int | None
    fulfilled_at: datetime | None


class CustomerOrderRead(StrictModel):
    id: int
    order_no: str
    project_code: str
    plan_kind: str
    points_amount: int
    plan_name_snapshot: str
    amount_cent: int
    currency: str
    status: str
    payment_provider: str | None
    expires_at: datetime
    paid_at: datetime | None
    fulfilled_at: datetime | None
    refunded_at: datetime | None
    activation_code: str | None
    fulfillment: FulfillmentRead | None
    created_at: datetime
    updated_at: datetime


class PaymentStartRequest(StrictModel):
    provider: Literal["development", "wechat", "alipay"] | None = None


class PaymentStartResponse(StrictModel):
    id: int
    payment_id: int
    order_no: str
    status: str
    provider: str
    amount_cent: int
    currency: str
    code_url: str | None
    qr_code_url: str | None
    expires_at: datetime


class DevelopmentCompleteRequest(StrictModel):
    event_id: str | None = Field(default=None, min_length=8, max_length=128)


class PaymentCallbackResult(StrictModel):
    order_no: str
    status: str
    idempotent: bool
    activation_code: str | None
    fulfillment: FulfillmentRead | None


class RefundCreate(StrictModel):
    amount_cent: int | None = Field(default=None, gt=0)
    reason: str = Field(min_length=2, max_length=500)

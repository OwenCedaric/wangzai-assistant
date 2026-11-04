from __future__ import annotations

from datetime import datetime

from pydantic import Field, model_validator

from app.schemas.common import ORMModel, StrictModel


class AgentCreate(StrictModel):
    code: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_.-]*$", min_length=2, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    contact_name: str | None = Field(default=None, max_length=128)
    contact_phone: str | None = Field(default=None, max_length=32)
    status: str = Field(default="active", pattern=r"^(active|disabled)$")
    default_commission_rate_bps: int = Field(default=0, ge=0, le=10000)
    project_ids: list[int] = Field(default_factory=list, max_length=500)


class AgentUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    contact_name: str | None = Field(default=None, max_length=128)
    contact_phone: str | None = Field(default=None, max_length=32)
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")
    default_commission_rate_bps: int | None = Field(default=None, ge=0, le=10000)
    project_ids: list[int] | None = Field(default=None, max_length=500)


class AgentRead(StrictModel):
    id: int
    code: str
    name: str
    contact_name: str | None
    contact_phone: str | None
    status: str
    default_commission_rate_bps: int
    project_ids: list[int]
    user_count: int
    order_count: int
    created_at: datetime
    updated_at: datetime


class AgentDashboard(StrictModel):
    agents_total: int
    active_agents: int
    channels_total: int
    attributed_users: int
    paid_orders: int
    gross_amount_cent: int
    commission_pending_cent: int
    commission_available_cent: int
    commission_settled_cent: int


class ChannelCreate(StrictModel):
    agent_id: int = Field(gt=0)
    project_id: int = Field(gt=0)
    code: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_.-]*$", min_length=2, max_length=64)
    name: str | None = Field(default=None, max_length=128)
    campaign: str | None = Field(default=None, max_length=128)
    status: str = Field(default="active", pattern=r"^(active|disabled)$")


class ChannelUpdate(StrictModel):
    agent_id: int | None = Field(default=None, gt=0)
    project_id: int | None = Field(default=None, gt=0)
    code: str | None = Field(
        default=None,
        pattern=r"^[A-Za-z][A-Za-z0-9_.-]*$",
        min_length=2,
        max_length=64,
    )
    name: str | None = Field(default=None, max_length=128)
    campaign: str | None = Field(default=None, max_length=128)
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")


class ChannelRead(StrictModel):
    id: int
    agent_id: int
    project_id: int
    code: str
    name: str | None
    campaign: str | None
    status: str
    token_prefix: str
    created_at: datetime
    updated_at: datetime


class ChannelCreated(ChannelRead):
    distribution_token: str


class AttributionAdminRead(StrictModel):
    attribution_id: int
    user_id: int
    username: str
    email: str | None
    phone_masked: str | None
    project_id: int
    project_code: str
    channel_id: int | None
    channel_code: str | None
    source_type: str
    locked_at: datetime
    status: str


class AttributionReassign(StrictModel):
    agent_id: int | None = Field(default=None, gt=0)
    channel_id: int | None = Field(default=None, gt=0)
    reason: str = Field(min_length=3, max_length=500)

    @model_validator(mode="after")
    def channel_requires_agent(self):
        if self.channel_id is not None and self.agent_id is None:
            raise ValueError("agent_id is required when channel_id is set")
        return self


class AdminOrderRead(StrictModel):
    id: int
    order_no: str
    user_id: int
    project_id: int
    plan_id: int
    plan_kind: str
    points_amount: int
    agent_id: int | None
    channel_id: int | None
    plan_name_snapshot: str
    amount_cent: int
    currency: str
    commission_rate_bps: int
    commission_amount_cent: int
    status: str
    payment_provider: str | None
    provider: str | None
    provider_payment_no: str | None
    activation_code_prefix: str | None
    points_credited: int
    point_balance_after: int | None
    created_at: datetime
    expires_at: datetime
    paid_at: datetime | None
    fulfilled_at: datetime | None
    refunded_at: datetime | None


class CommissionRead(ORMModel):
    id: int
    agent_id: int
    order_id: int
    rate_bps: int
    base_amount_cent: int
    commission_amount_cent: int
    status: str
    available_at: datetime | None
    settled_at: datetime | None
    reversed_at: datetime | None
    created_at: datetime


class CommissionDashboard(StrictModel):
    records_total: int
    pending_cent: int
    available_cent: int
    settled_cent: int
    reversed_cent: int


class CommissionRuleCreate(StrictModel):
    agent_id: int = Field(gt=0)
    project_id: int | None = Field(default=None, gt=0)
    plan_id: int | None = Field(default=None, gt=0)
    rate_bps: int = Field(ge=0, le=10000)
    status: str = Field(default="active", pattern=r"^(active|disabled)$")

    @model_validator(mode="after")
    def plan_requires_project(self):
        if self.plan_id is not None and self.project_id is None:
            raise ValueError("project_id is required when plan_id is set")
        return self


class CommissionRuleUpdate(StrictModel):
    rate_bps: int | None = Field(default=None, ge=0, le=10000)
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")


class CommissionRuleRead(ORMModel):
    id: int
    agent_id: int
    project_id: int | None
    plan_id: int | None
    rate_bps: int
    status: str
    created_at: datetime
    updated_at: datetime


class RefundRead(ORMModel):
    id: int
    refund_no: str
    order_id: int
    payment_id: int
    provider_refund_no: str | None
    amount_cent: int
    reason: str
    status: str
    processed_at: datetime | None
    created_at: datetime


class ProviderStatus(StrictModel):
    provider: str
    configured: bool
    enabled: bool
    reason: str | None


class PaymentConfigStatus(StrictModel):
    default_provider: str
    providers: list[ProviderStatus]
    sms_provider: str
    sms_configured: bool

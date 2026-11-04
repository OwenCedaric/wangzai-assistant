from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.models.base import TimestampMixin


class AuthSession(TimestampMixin, Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    public_id: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    device_code: Mapped[str] = mapped_column(String(128), index=True)
    refresh_token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    user = relationship("User", back_populates="auth_sessions")
    project = relationship("Project")


class Agent(TimestampMixin, Base):
    __tablename__ = "agents"
    __table_args__ = (
        CheckConstraint(
            "default_commission_rate_bps >= 0 AND default_commission_rate_bps <= 10000",
            name="ck_agents_default_commission_rate",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    contact_name: Mapped[str | None] = mapped_column(String(128))
    contact_phone: Mapped[str | None] = mapped_column(String(32))
    parent_agent_id: Mapped[int | None] = mapped_column(ForeignKey("agents.id"), index=True)
    default_commission_rate_bps: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    parent = relationship("Agent", remote_side="Agent.id")
    scopes = relationship("AgentProjectScope", back_populates="agent", cascade="all, delete-orphan")
    channels = relationship("Channel", back_populates="agent")
    attributions = relationship("UserProjectAttribution", back_populates="agent")
    orders = relationship("Order", back_populates="agent")


class AgentProjectScope(TimestampMixin, Base):
    __tablename__ = "agent_project_scopes"
    __table_args__ = (UniqueConstraint("agent_id", "project_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    agent = relationship("Agent", back_populates="scopes")
    project = relationship("Project")


class Channel(TimestampMixin, Base):
    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(128))
    campaign: Mapped[str | None] = mapped_column(String(128))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    token_prefix: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    agent = relationship("Agent", back_populates="channels")
    project = relationship("Project")
    attributions = relationship("UserProjectAttribution", back_populates="channel")
    orders = relationship("Order", back_populates="channel")


class UserProjectAttribution(TimestampMixin, Base):
    __tablename__ = "user_project_attributions"
    __table_args__ = (UniqueConstraint("user_id", "project_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("agents.id"), index=True)
    channel_id: Mapped[int | None] = mapped_column(ForeignKey("channels.id"), index=True)
    source_type: Mapped[str] = mapped_column(String(32), default="organic", index=True)
    locked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    user = relationship("User", back_populates="attributions")
    project = relationship("Project")
    agent = relationship("Agent", back_populates="attributions")
    channel = relationship("Channel", back_populates="attributions")


class Order(TimestampMixin, Base):
    __tablename__ = "orders"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key"),
        CheckConstraint("amount_cent >= 0", name="ck_orders_amount_nonnegative"),
        CheckConstraint(
            "commission_rate_bps >= 0 AND commission_rate_bps <= 10000",
            name="ck_orders_commission_rate",
        ),
        CheckConstraint(
            "commission_amount_cent >= 0", name="ck_orders_commission_amount_nonnegative"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    order_no: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(64))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id"), index=True)
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("agents.id"), index=True)
    channel_id: Mapped[int | None] = mapped_column(ForeignKey("channels.id"), index=True)
    plan_name_snapshot: Mapped[str] = mapped_column(String(128))
    amount_cent: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="CNY")
    commission_rate_bps: Mapped[int] = mapped_column(Integer, default=0)
    commission_amount_cent: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    payment_provider: Mapped[str | None] = mapped_column(String(24), index=True)
    provider_payment_no: Mapped[str | None] = mapped_column(String(128), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fulfilled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refunded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user = relationship("User", back_populates="orders")
    project = relationship("Project")
    plan = relationship("Plan", back_populates="orders")
    agent = relationship("Agent", back_populates="orders")
    channel = relationship("Channel", back_populates="orders")
    payments = relationship("Payment", back_populates="order")
    fulfillment = relationship("OrderFulfillment", back_populates="order", uselist=False)
    commission = relationship("CommissionRecord", back_populates="order", uselist=False)
    refunds = relationship("Refund", back_populates="order")


class Payment(TimestampMixin, Base):
    __tablename__ = "payments"
    __table_args__ = (
        UniqueConstraint("order_id", "provider"),
        UniqueConstraint("provider", "provider_payment_no"),
        CheckConstraint("amount_cent >= 0", name="ck_payments_amount_nonnegative"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    provider: Mapped[str] = mapped_column(String(24), index=True)
    provider_payment_no: Mapped[str | None] = mapped_column(String(128))
    amount_cent: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="CNY")
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    checkout_payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    order = relationship("Order", back_populates="payments")
    events = relationship("PaymentEvent", back_populates="payment")
    refunds = relationship("Refund", back_populates="payment")


class PaymentEvent(TimestampMixin, Base):
    __tablename__ = "payment_events"
    __table_args__ = (
        UniqueConstraint("provider", "event_id"),
        CheckConstraint("amount_cent >= 0", name="ck_payment_events_amount_nonnegative"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(24), index=True)
    event_id: Mapped[str] = mapped_column(String(128))
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    payment_id: Mapped[int | None] = mapped_column(ForeignKey("payments.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(48))
    amount_cent: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="CNY")
    payload_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24), default="processed", index=True)
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    order = relationship("Order")
    payment = relationship("Payment", back_populates="events")


class OrderFulfillment(TimestampMixin, Base):
    __tablename__ = "order_fulfillments"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), unique=True, index=True)
    activation_code_id: Mapped[int | None] = mapped_column(
        ForeignKey("activation_codes.id"), unique=True
    )
    points_credited: Mapped[int] = mapped_column(Integer, default=0)
    point_balance_after: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String(500))
    fulfilled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    order = relationship("Order", back_populates="fulfillment")
    activation_code = relationship("ActivationCode", foreign_keys=[activation_code_id])


class CommissionRule(TimestampMixin, Base):
    __tablename__ = "commission_rules"
    __table_args__ = (
        CheckConstraint("rate_bps >= 0 AND rate_bps <= 10000", name="ck_commission_rules_rate"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_key: Mapped[str] = mapped_column(String(128), unique=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id"), index=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), index=True)
    plan_id: Mapped[int | None] = mapped_column(ForeignKey("plans.id"), index=True)
    rate_bps: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    agent = relationship("Agent")
    project = relationship("Project")
    plan = relationship("Plan")


class CommissionRecord(TimestampMixin, Base):
    __tablename__ = "commission_records"
    __table_args__ = (
        CheckConstraint("rate_bps >= 0 AND rate_bps <= 10000", name="ck_commissions_rate"),
        CheckConstraint("base_amount_cent >= 0", name="ck_commissions_base_nonnegative"),
        CheckConstraint("commission_amount_cent >= 0", name="ck_commissions_amount_nonnegative"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), unique=True, index=True)
    rate_bps: Mapped[int] = mapped_column(Integer)
    base_amount_cent: Mapped[int] = mapped_column(Integer)
    commission_amount_cent: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    available_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    agent = relationship("Agent")
    order = relationship("Order", back_populates="commission")


class Refund(TimestampMixin, Base):
    __tablename__ = "refunds"
    __table_args__ = (CheckConstraint("amount_cent > 0", name="ck_refunds_amount_positive"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    refund_no: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    payment_id: Mapped[int] = mapped_column(ForeignKey("payments.id"), index=True)
    provider_refund_no: Mapped[str | None] = mapped_column(String(128), index=True)
    amount_cent: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    order = relationship("Order", back_populates="refunds")
    payment = relationship("Payment", back_populates="refunds")

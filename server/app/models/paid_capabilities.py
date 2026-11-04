from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
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


class PaidCapabilityRateCard(TimestampMixin, Base):
    __tablename__ = "paid_capability_rate_cards"
    __table_args__ = (
        UniqueConstraint("project_id", "capability", "version", "price_version"),
        CheckConstraint("version > 0", name="ck_paid_rate_version_positive"),
        CheckConstraint("points_per_cny > 0", name="ck_paid_rate_points_per_cny_positive"),
        CheckConstraint(
            "unit_sell_price_micros >= 0",
            name="ck_paid_rate_unit_sell_price_nonnegative",
        ),
        CheckConstraint(
            "target_margin_basis_points >= minimum_margin_basis_points "
            "AND target_margin_basis_points < 10000",
            name="ck_paid_rate_margin_safe",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    capability: Mapped[str] = mapped_column(String(96), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    price_version: Mapped[str] = mapped_column(String(128))
    provider_code: Mapped[str] = mapped_column(String(64))
    provider_model: Mapped[str] = mapped_column(String(160), default="")
    input_micros_per_million: Mapped[int] = mapped_column(BigInteger, default=0)
    output_micros_per_million: Mapped[int] = mapped_column(BigInteger, default=0)
    cached_input_micros_per_million: Mapped[int] = mapped_column(BigInteger, default=0)
    fixed_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    unit_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    unit_sell_price_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    provider_multiplier_ppm: Mapped[int] = mapped_column(Integer, default=1_000_000)
    customer_multiplier_ppm: Mapped[int] = mapped_column(Integer, default=1_000_000)
    risk_buffer_basis_points: Mapped[int] = mapped_column(Integer, default=500)
    target_margin_basis_points: Mapped[int] = mapped_column(Integer, default=1_800)
    minimum_margin_basis_points: Mapped[int] = mapped_column(Integer, default=1_500)
    points_per_cny: Mapped[int] = mapped_column(Integer, default=1_050)
    currency: Mapped[str] = mapped_column(String(3), default="CNY")
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    effective_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)


class UserModelPreset(TimestampMixin, Base):
    __tablename__ = "user_model_presets"
    __table_args__ = (
        UniqueConstraint("user_id", "project_id", "capability_kind"),
        CheckConstraint(
            "capability_kind IN ('text', 'image')",
            name="ck_user_model_preset_capability_kind",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    capability_kind: Mapped[str] = mapped_column(String(32), index=True)
    enabled_models: Mapped[list[str]] = mapped_column(JSON, default=list)
    default_model: Mapped[str] = mapped_column(String(160))


class PaidCapabilityQuote(TimestampMixin, Base):
    __tablename__ = "paid_capability_quotes"
    __table_args__ = (
        CheckConstraint("estimated_points >= 0", name="ck_paid_quote_estimate_nonnegative"),
        CheckConstraint("maximum_points > 0", name="ck_paid_quote_maximum_positive"),
        CheckConstraint(
            "maximum_points >= estimated_points", name="ck_paid_quote_maximum_not_below_estimate"
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    rate_card_id: Mapped[int] = mapped_column(
        ForeignKey("paid_capability_rate_cards.id"), index=True
    )
    capability: Mapped[str] = mapped_column(String(96), index=True)
    version: Mapped[int] = mapped_column(Integer)
    input_hash: Mapped[str] = mapped_column(String(71))
    estimated_points: Mapped[int] = mapped_column(Integer)
    maximum_points: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PaidCapabilityJob(TimestampMixin, Base):
    __tablename__ = "paid_capability_jobs"
    __table_args__ = (UniqueConstraint("user_id", "project_id", "idempotency_key"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    quote_id: Mapped[str | None] = mapped_column(
        ForeignKey("paid_capability_quotes.id"), unique=True, nullable=True
    )
    capability: Mapped[str] = mapped_column(String(96), index=True)
    version: Mapped[int] = mapped_column(Integer)
    input_hash: Mapped[str] = mapped_column(String(71))
    request_hash: Mapped[str] = mapped_column(String(71))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32), index=True)
    provider_request_id_hash: Mapped[str | None] = mapped_column(String(71), nullable=True)
    result_json: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(96), nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    reservation = relationship(
        "PointReservation", back_populates="job", uselist=False, cascade="all, delete-orphan"
    )


class PointReservation(TimestampMixin, Base):
    __tablename__ = "point_reservations"
    __table_args__ = (
        CheckConstraint("reserved_points > 0", name="ck_point_reservation_reserved_positive"),
        CheckConstraint("settled_points >= 0", name="ck_point_reservation_settled_nonnegative"),
        CheckConstraint("released_points >= 0", name="ck_point_reservation_released_nonnegative"),
        CheckConstraint(
            "settled_points + released_points <= reserved_points",
            name="ck_point_reservation_accounted_not_above_reserved",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    wallet_id: Mapped[int] = mapped_column(
        ForeignKey("point_wallets.id", ondelete="CASCADE"), index=True
    )
    job_id: Mapped[str] = mapped_column(
        ForeignKey("paid_capability_jobs.id", ondelete="CASCADE"), unique=True, index=True
    )
    reserved_points: Mapped[int] = mapped_column(Integer)
    settled_points: Mapped[int] = mapped_column(Integer, default=0)
    released_points: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(24), default="reserved", index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    release_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)

    job = relationship("PaidCapabilityJob", back_populates="reservation")
    lots = relationship(
        "PointReservationLot", back_populates="reservation", cascade="all, delete-orphan"
    )


class PointReservationLot(Base):
    __tablename__ = "point_reservation_lots"
    __table_args__ = (
        UniqueConstraint("reservation_id", "credit_lot_id"),
        CheckConstraint("reserved_points > 0", name="ck_point_reservation_lot_reserved_positive"),
        CheckConstraint("settled_points >= 0", name="ck_point_reservation_lot_settled_nonnegative"),
        CheckConstraint(
            "released_points >= 0", name="ck_point_reservation_lot_released_nonnegative"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    reservation_id: Mapped[int] = mapped_column(
        ForeignKey("point_reservations.id", ondelete="CASCADE"), index=True
    )
    credit_lot_id: Mapped[int] = mapped_column(
        ForeignKey("point_credit_lots.id", ondelete="RESTRICT"), index=True
    )
    reserved_points: Mapped[int] = mapped_column(Integer)
    settled_points: Mapped[int] = mapped_column(Integer, default=0)
    released_points: Mapped[int] = mapped_column(Integer, default=0)

    reservation = relationship("PointReservation", back_populates="lots")
    credit_lot = relationship("PointCreditLot")


class ProviderUsageEvent(TimestampMixin, Base):
    __tablename__ = "provider_usage_events"
    __table_args__ = (UniqueConstraint("job_id", "event_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[str] = mapped_column(
        ForeignKey("paid_capability_jobs.id", ondelete="CASCADE"), index=True
    )
    event_key: Mapped[str] = mapped_column(String(128))
    provider_code: Mapped[str] = mapped_column(String(64), index=True)
    provider_model: Mapped[str] = mapped_column(String(160), default="")
    operation: Mapped[str] = mapped_column(String(96))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cached_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    units: Mapped[int] = mapped_column(Integer, default=0)
    provider_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    provider_cost_source: Mapped[str] = mapped_column(String(48), default="rate_card")
    charged_points: Mapped[int] = mapped_column(Integer, default=0)
    billable: Mapped[int] = mapped_column(Integer, default=0)
    provider_request_id_hash: Mapped[str | None] = mapped_column(String(71), nullable=True)
    usage_hash: Mapped[str] = mapped_column(String(71))

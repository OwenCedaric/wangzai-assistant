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


class PointWallet(TimestampMixin, Base):
    __tablename__ = "point_wallets"
    __table_args__ = (
        UniqueConstraint("user_id", "project_id"),
        CheckConstraint("balance_points >= 0", name="ck_point_wallet_balance_nonnegative"),
        CheckConstraint("reserved_points >= 0", name="ck_point_wallet_reserved_nonnegative"),
        CheckConstraint(
            "reserved_points <= balance_points", name="ck_point_wallet_reserved_not_above_balance"
        ),
        CheckConstraint(
            "lifetime_credited_points >= 0",
            name="ck_point_wallet_credited_nonnegative",
        ),
        CheckConstraint("lifetime_spent_points >= 0", name="ck_point_wallet_spent_nonnegative"),
        CheckConstraint(
            "metered_provider_cost_micros >= 0",
            name="ck_point_wallet_metered_cost_nonnegative",
        ),
        CheckConstraint(
            "metered_provider_charged_points >= 0",
            name="ck_point_wallet_metered_points_nonnegative",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    balance_points: Mapped[int] = mapped_column(Integer, default=0)
    reserved_points: Mapped[int] = mapped_column(Integer, default=0)
    lifetime_credited_points: Mapped[int] = mapped_column(Integer, default=0)
    lifetime_spent_points: Mapped[int] = mapped_column(Integer, default=0)
    metered_provider_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    metered_provider_charged_points: Mapped[int] = mapped_column(BigInteger, default=0)

    user = relationship("User")
    project = relationship("Project")
    lots = relationship("PointCreditLot", back_populates="wallet", cascade="all, delete-orphan")
    entries = relationship(
        "PointLedgerEntry", back_populates="wallet", cascade="all, delete-orphan"
    )


class PointCreditLot(TimestampMixin, Base):
    __tablename__ = "point_credit_lots"
    __table_args__ = (
        CheckConstraint("original_points > 0", name="ck_point_lot_original_positive"),
        CheckConstraint("remaining_points >= 0", name="ck_point_lot_remaining_nonnegative"),
        CheckConstraint("reserved_points >= 0", name="ck_point_lot_reserved_nonnegative"),
        CheckConstraint(
            "reserved_points <= remaining_points", name="ck_point_lot_reserved_not_above_remaining"
        ),
        CheckConstraint(
            "remaining_points <= original_points", name="ck_point_lot_remaining_not_above_original"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    wallet_id: Mapped[int] = mapped_column(
        ForeignKey("point_wallets.id", ondelete="CASCADE"), index=True
    )
    source_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id"), unique=True, index=True, nullable=True
    )
    original_points: Mapped[int] = mapped_column(Integer)
    remaining_points: Mapped[int] = mapped_column(Integer)
    reserved_points: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    wallet = relationship("PointWallet", back_populates="lots")
    source_order = relationship("Order")


class PointLedgerEntry(TimestampMixin, Base):
    __tablename__ = "point_ledger_entries"
    __table_args__ = (
        UniqueConstraint("wallet_id", "idempotency_key"),
        CheckConstraint("delta_points != 0", name="ck_point_ledger_delta_nonzero"),
        CheckConstraint("balance_after >= 0", name="ck_point_ledger_balance_nonnegative"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    wallet_id: Mapped[int] = mapped_column(
        ForeignKey("point_wallets.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    delta_points: Mapped[int] = mapped_column(Integer)
    balance_after: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    reference_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reference_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    details: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)

    wallet = relationship("PointWallet", back_populates="entries")
    user = relationship("User")
    project = relationship("Project")

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.models.base import TimestampMixin


class License(TimestampMixin, Base):
    __tablename__ = "licenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id"), index=True)
    license_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expire_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    offline_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user = relationship("User", back_populates="licenses")
    plan = relationship("Plan", back_populates="licenses")
    devices = relationship("Device", back_populates="license", cascade="all, delete-orphan")
    shops = relationship("Shop", back_populates="license", cascade="all, delete-orphan")


class Device(TimestampMixin, Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("license_id", "device_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    license_id: Mapped[int] = mapped_column(
        ForeignKey("licenses.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    device_code: Mapped[str] = mapped_column(String(128), index=True)
    device_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    user = relationship("User", back_populates="devices")
    license = relationship("License", back_populates="devices")


class Shop(TimestampMixin, Base):
    __tablename__ = "shops"
    __table_args__ = (
        UniqueConstraint("license_id", "platform", "shop_id"),
        UniqueConstraint(
            "project_id",
            "platform",
            "shop_id",
            name="uq_shops_project_platform_shop",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    license_id: Mapped[int] = mapped_column(
        ForeignKey("licenses.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    platform: Mapped[str] = mapped_column(String(32), index=True)
    shop_name: Mapped[str] = mapped_column(String(128))
    shop_id: Mapped[str] = mapped_column(String(128), index=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    last_sync_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user = relationship("User", back_populates="shops")
    license = relationship("License", back_populates="shops")


class ShopIntroRedemption(TimestampMixin, Base):
    __tablename__ = "shop_intro_redemptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    license_id: Mapped[int | None] = mapped_column(
        ForeignKey("licenses.id", ondelete="SET NULL"), unique=True, nullable=True
    )
    activation_code_id: Mapped[int | None] = mapped_column(
        ForeignKey("activation_codes.id", ondelete="SET NULL"), unique=True, nullable=True
    )
    redeemed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class CardBatch(TimestampMixin, Base):
    __tablename__ = "card_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    quantity: Mapped[int] = mapped_column(Integer)
    duration_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)

    plan = relationship("Plan")
    codes = relationship("ActivationCode", back_populates="batch", cascade="all, delete-orphan")


class ActivationCode(TimestampMixin, Base):
    __tablename__ = "activation_codes"

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(
        ForeignKey("card_batches.id", ondelete="CASCADE"), index=True
    )
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id"), index=True)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    code_prefix: Mapped[str] = mapped_column(String(16), index=True)
    code_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="unused", index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    owner_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), unique=True, index=True)
    activated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    activated_license_id: Mapped[int | None] = mapped_column(ForeignKey("licenses.id"))
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    batch = relationship("CardBatch", back_populates="codes")

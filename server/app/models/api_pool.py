from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.models.base import TimestampMixin


class ApiPoolProvider(TimestampMixin, Base):
    __tablename__ = "api_pool_providers"
    __table_args__ = (
        UniqueConstraint("code"),
        CheckConstraint(
            "timeout_seconds >= 10 AND timeout_seconds <= 300",
            name="ck_api_pool_provider_timeout",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(128))
    adapter: Mapped[str] = mapped_column(String(48), index=True)
    base_url: Mapped[str] = mapped_column(String(512))
    auth_scheme: Mapped[str] = mapped_column(String(32), default="bearer")
    auth_header_name: Mapped[str] = mapped_column(String(128), default="Authorization")
    capability_kinds: Mapped[list[str]] = mapped_column(JSON, default=list)
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=150)
    priority: Mapped[int] = mapped_column(Integer, default=100)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    keys = relationship(
        "ApiPoolKey", back_populates="provider", cascade="all, delete-orphan"
    )
    models = relationship(
        "ApiPoolModel", back_populates="provider", cascade="all, delete-orphan"
    )


class ApiPoolModel(TimestampMixin, Base):
    __tablename__ = "api_pool_models"
    __table_args__ = (
        UniqueConstraint("provider_id", "capability_kind", "model_code"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    provider_id: Mapped[int] = mapped_column(
        ForeignKey("api_pool_providers.id", ondelete="CASCADE"), index=True
    )
    capability_kind: Mapped[str] = mapped_column(String(32), index=True)
    model_code: Mapped[str] = mapped_column(String(160))
    display_name: Mapped[str] = mapped_column(String(160))
    priority: Mapped[int] = mapped_column(Integer, default=100)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    provider = relationship("ApiPoolProvider", back_populates="models")


class ApiPoolKey(TimestampMixin, Base):
    __tablename__ = "api_pool_keys"
    __table_args__ = (
        UniqueConstraint("provider_id", "secret_fingerprint"),
        CheckConstraint(
            "max_concurrency >= 0 AND max_concurrency <= 100",
            name="ck_api_pool_key_concurrency",
        ),
        CheckConstraint("weight > 0 AND weight <= 1000", name="ck_api_pool_key_weight"),
        CheckConstraint("success_count >= 0", name="ck_api_pool_key_success_nonnegative"),
        CheckConstraint("failure_count >= 0", name="ck_api_pool_key_failure_nonnegative"),
        CheckConstraint("request_count >= 0", name="ck_api_pool_key_request_nonnegative"),
        CheckConstraint(
            "consecutive_failures >= 0",
            name="ck_api_pool_key_consecutive_nonnegative",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    provider_id: Mapped[int] = mapped_column(
        ForeignKey("api_pool_providers.id", ondelete="CASCADE"), index=True
    )
    label: Mapped[str] = mapped_column(String(128))
    secret_ciphertext: Mapped[str] = mapped_column(Text)
    secret_fingerprint: Mapped[str] = mapped_column(String(71))
    masked_hint: Mapped[str] = mapped_column(String(64))
    weight: Mapped[int] = mapped_column(Integer, default=100)
    max_concurrency: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    cooldown_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_failure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    success_count: Mapped[int] = mapped_column(Integer, default=0)
    failure_count: Mapped[int] = mapped_column(Integer, default=0)
    request_count: Mapped[int] = mapped_column(Integer, default=0)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    last_error_code: Mapped[str | None] = mapped_column(String(96), nullable=True)

    provider = relationship("ApiPoolProvider", back_populates="keys")
    leases = relationship(
        "ApiPoolLease", back_populates="key", cascade="all, delete-orphan"
    )


class ApiPoolLease(Base):
    __tablename__ = "api_pool_leases"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    key_id: Mapped[int] = mapped_column(
        ForeignKey("api_pool_keys.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    key = relationship("ApiPoolKey", back_populates="leases")

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, DateTime, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base
from app.models.base import TimestampMixin


class OssManagementConfiguration(TimestampMixin, Base):
    __tablename__ = "oss_management_configurations"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_oss_management_singleton"),
        CheckConstraint(
            "runtime_revision >= 1", name="ck_oss_management_runtime_revision_positive"
        ),
        CheckConstraint(
            "storage_price_cny_per_gb_month >= 0",
            name="ck_oss_management_storage_price_nonnegative",
        ),
        CheckConstraint(
            "network_out_price_cny_per_gb >= 0",
            name="ck_oss_management_network_price_nonnegative",
        ),
        CheckConstraint(
            "acceleration_price_cny_per_gb >= 0",
            name="ck_oss_management_acceleration_price_nonnegative",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    name: Mapped[str] = mapped_column(String(128), default="旺崽商品图片 OSS")
    region: Mapped[str] = mapped_column(String(64))
    bucket: Mapped[str] = mapped_column(String(128), index=True)
    endpoint: Mapped[str] = mapped_column(String(512))
    accelerate_endpoint: Mapped[str | None] = mapped_column(String(512), nullable=True)
    acceleration_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    runtime_revision: Mapped[int] = mapped_column(default=1)
    access_key_id_ciphertext: Mapped[str] = mapped_column(Text)
    access_key_secret_ciphertext: Mapped[str] = mapped_column(Text)
    access_key_fingerprint: Mapped[str] = mapped_column(String(71), unique=True)
    masked_access_key_id: Mapped[str] = mapped_column(String(64))
    object_access_key_id_ciphertext: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    object_access_key_secret_ciphertext: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    object_access_key_fingerprint: Mapped[str | None] = mapped_column(
        String(71), nullable=True, unique=True
    )
    masked_object_access_key_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    last_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_usage_sync_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    storage_price_cny_per_gb_month: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), default=Decimal("0.136")
    )
    network_out_price_cny_per_gb: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), default=Decimal("0.750")
    )
    acceleration_price_cny_per_gb: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), default=Decimal("1.250")
    )

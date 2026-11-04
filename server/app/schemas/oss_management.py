from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import Field

from app.schemas.common import StrictModel


class OssConfigurationUpdate(StrictModel):
    name: str = Field(min_length=1, max_length=128)
    region: str = Field(min_length=3, max_length=64)
    bucket: str = Field(min_length=3, max_length=128)
    endpoint: str = Field(min_length=12, max_length=512)
    accelerate_endpoint: str | None = Field(default=None, max_length=512)
    acceleration_enabled: bool = True
    access_key_id: str | None = Field(default=None, min_length=8, max_length=256)
    access_key_secret: str | None = Field(default=None, min_length=8, max_length=4096)
    object_access_key_id: str | None = Field(default=None, min_length=8, max_length=256)
    object_access_key_secret: str | None = Field(
        default=None, min_length=8, max_length=4096
    )
    storage_price_cny_per_gb_month: Decimal = Field(
        default=Decimal("0.136"), ge=0, max_digits=12, decimal_places=6
    )
    network_out_price_cny_per_gb: Decimal = Field(
        default=Decimal("0.750"), ge=0, max_digits=12, decimal_places=6
    )
    acceleration_price_cny_per_gb: Decimal = Field(
        default=Decimal("1.250"), ge=0, max_digits=12, decimal_places=6
    )


class OssConfigurationRead(StrictModel):
    configured: bool
    name: str | None = None
    region: str | None = None
    bucket: str | None = None
    endpoint: str | None = None
    accelerate_endpoint: str | None = None
    acceleration_enabled: bool = False
    runtime_revision: int = 0
    masked_access_key_id: str | None = None
    masked_object_access_key_id: str | None = None
    status: str = "unconfigured"
    last_verified_at: datetime | None = None
    last_usage_sync_at: datetime | None = None
    last_error_code: str | None = None
    storage_price_cny_per_gb_month: Decimal = Decimal("0.136")
    network_out_price_cny_per_gb: Decimal = Decimal("0.750")
    acceleration_price_cny_per_gb: Decimal = Decimal("1.250")


class OssUsagePoint(StrictModel):
    start_time: str
    end_time: str
    storage_bytes: int = Field(ge=0)
    network_in_bytes: int = Field(ge=0)
    network_out_bytes: int = Field(ge=0)
    acceleration_in_bytes: int = Field(ge=0)
    acceleration_out_bytes: int = Field(ge=0)
    get_requests: int = Field(ge=0)
    put_requests: int = Field(ge=0)
    image_process_bytes: int = Field(ge=0)


class OssUsageSummary(StrictModel):
    bucket: str
    region: str
    hours: int = Field(ge=1)
    sample_count: int = Field(ge=0)
    current_storage_bytes: int = Field(ge=0)
    network_in_bytes: int = Field(ge=0)
    network_out_bytes: int = Field(ge=0)
    acceleration_in_bytes: int = Field(ge=0)
    acceleration_out_bytes: int = Field(ge=0)
    get_requests: int = Field(ge=0)
    put_requests: int = Field(ge=0)
    image_process_bytes: int = Field(ge=0)
    estimated_storage_monthly_cny: Decimal
    estimated_period_network_out_cny: Decimal
    estimated_period_acceleration_cny: Decimal
    estimated_total_cny: Decimal
    data_delay_note: str
    points: list[OssUsagePoint]


class SignedOssRuntimeConfiguration(StrictModel):
    contract: str
    config_version: int = Field(ge=1)
    signing_key_id: str
    issued_at: str
    region: str
    bucket: str
    endpoint: str
    acceleration_enabled: bool
    accelerate_endpoint: str | None
    signature: str

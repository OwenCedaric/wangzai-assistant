from __future__ import annotations

from datetime import datetime

from pydantic import Field, model_validator

from app.schemas.common import ORMModel, StrictModel


class ActivateRequest(StrictModel):
    card_key: str = Field(pattern=r"^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$")
    project_code: str = Field(min_length=2, max_length=64)
    device_code: str = Field(min_length=8, max_length=128)
    device_name: str | None = Field(default=None, max_length=128)
    version: str = Field(min_length=1, max_length=32)
    version_hash: str | None = Field(default=None, max_length=128)


class RenewRequest(ActivateRequest):
    license_key: str | None = Field(default=None, min_length=12, max_length=64)
    license_id: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def require_one_license_target(self):
        if (self.license_key is None) == (self.license_id is None):
            raise ValueError("Provide exactly one of license_key or license_id")
        return self


class ActivateShopRequest(ActivateRequest):
    shop_name: str = Field(min_length=1, max_length=128)
    shop_id: str = Field(min_length=1, max_length=128)


class BindOwnedShopLicenseRequest(StrictModel):
    license_id: int = Field(gt=0)
    project_code: str = Field(min_length=2, max_length=64)
    shop_name: str = Field(min_length=1, max_length=128)
    shop_id: str = Field(min_length=1, max_length=128)


class CheckRequest(StrictModel):
    project_code: str = Field(min_length=2, max_length=64)
    device_code: str = Field(min_length=8, max_length=128)
    license_key: str | None = Field(default=None, min_length=12, max_length=64)
    device_name: str | None = Field(default=None, max_length=128)
    version: str = Field(min_length=1, max_length=32)
    version_hash: str | None = Field(default=None, max_length=128)


class HeartbeatRequest(StrictModel):
    project_code: str = Field(min_length=2, max_length=64)
    device_code: str = Field(min_length=8, max_length=128)
    version: str = Field(min_length=1, max_length=32)
    version_hash: str | None = Field(default=None, max_length=128)


class LicenseResult(StrictModel):
    valid: bool
    online_required: bool
    license_role: str
    expire: datetime | None
    permissions: list[str] = Field(default_factory=list)
    shop_limit: int = 0
    device_limit: int = 0
    offline_until: datetime | None = None
    offline_token: str | None = None
    access_token: str | None = None
    token_type: str | None = None
    expires_in: int | None = None
    license_key: str | None = None
    reason: str | None = None
    server_time: datetime


class PublicKeyResponse(StrictModel):
    algorithm: str = "EdDSA"
    key_id: str
    public_key_pem: str


class LicenseRead(ORMModel):
    id: int
    user_id: int
    plan_id: int
    license_key: str
    start_time: datetime
    expire_time: datetime
    status: str
    last_verified_at: datetime | None
    last_heartbeat_at: datetime | None
    offline_until: datetime | None
    created_at: datetime
    updated_at: datetime


class LicenseStatusUpdate(StrictModel):
    status: str = Field(pattern=r"^(active|suspended|revoked)$")


class LicenseGrantCreate(StrictModel):
    user_id: int = Field(gt=0)
    plan_id: int = Field(gt=0)
    start_time: datetime | None = None
    expire_time: datetime | None = None
    status: str = Field(default="active", pattern=r"^(active|suspended)$")


class DeviceRead(ORMModel):
    id: int
    user_id: int
    license_id: int
    project_id: int
    device_code: str
    device_name: str | None
    last_login: datetime | None
    last_heartbeat: datetime | None
    status: str
    created_at: datetime
    updated_at: datetime


class DeviceStatusUpdate(StrictModel):
    status: str = Field(pattern=r"^(active|disabled)$")


class ShopBindRequest(StrictModel):
    license_key: str = Field(min_length=12, max_length=64)
    project_code: str = Field(min_length=2, max_length=64)
    platform: str = Field(pattern=r"^(ozon|taobao|tmall|pinduoduo)$")
    shop_name: str = Field(min_length=1, max_length=128)
    shop_id: str = Field(min_length=1, max_length=128)


class ShopRead(ORMModel):
    id: int
    user_id: int
    license_id: int
    project_id: int
    platform: str
    shop_name: str
    shop_id: str
    status: str
    last_sync_time: datetime | None
    created_at: datetime
    updated_at: datetime


class ShopStatusUpdate(StrictModel):
    status: str = Field(pattern=r"^(active|disabled)$")


class LicenseShopSummary(StrictModel):
    id: int
    shop_name: str
    shop_id: str
    status: str


class UserShopLicenseSummary(StrictModel):
    license_id: int
    plan_name: str
    license_role: str
    start_time: datetime
    expire_time: datetime
    status: str
    shops: list[LicenseShopSummary] = Field(default_factory=list)

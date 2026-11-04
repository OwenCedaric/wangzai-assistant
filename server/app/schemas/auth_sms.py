from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import ORMModel, StrictModel
from app.schemas.licensing import LicenseResult


class SmsUserSummary(ORMModel):
    id: int
    username: str
    phone: str | None
    phone_masked: str | None
    phone_verified_at: datetime | None
    email: str | None
    status: str
    is_admin: bool


class SmsSendRequest(StrictModel):
    phone: str = Field(min_length=11, max_length=32)
    scene: Literal["login_or_register"] = "login_or_register"
    project_code: str = Field(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=64)
    device_code: str | None = Field(default=None, min_length=8, max_length=128)
    device_name: str | None = Field(default=None, max_length=128)
    version: str | None = Field(default=None, max_length=32)
    version_hash: str | None = Field(default=None, max_length=128)
    channel_code: str | None = Field(default=None, max_length=64)
    distribution_token: str | None = Field(default=None, min_length=16, max_length=256)


class SmsSendResponse(StrictModel):
    sent: bool = True
    expires_in: int
    retry_after: int
    phone_masked: str
    development_code: str | None = None


class SmsVerifyRequest(SmsSendRequest):
    code: str = Field(pattern=r"^\d{6}$")
    device_code: str = Field(min_length=8, max_length=128)
    card_key: str | None = Field(
        default=None,
        pattern=r"^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$",
    )


class AttributionSummary(StrictModel):
    project_id: int
    project_code: str
    source_type: str
    locked_at: datetime


class SmsVerifyResponse(StrictModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    refresh_expires_in: int
    user: SmsUserSummary
    attribution: AttributionSummary
    project_code: str
    license_status: Literal["active", "needs_activation"]
    entitlement: LicenseResult | None = None


class RefreshRequest(StrictModel):
    refresh_token: str = Field(min_length=48, max_length=512)
    device_code: str = Field(min_length=8, max_length=128)


class RefreshResponse(StrictModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    refresh_expires_in: int


class LogoutRequest(StrictModel):
    refresh_token: str = Field(min_length=48, max_length=512)


class MeResponse(StrictModel):
    user: SmsUserSummary
    attributions: list[AttributionSummary]

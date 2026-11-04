from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import ORMModel, StrictModel
from app.schemas.licensing import LicenseResult


class LoginRequest(StrictModel):
    username: str | None = Field(default=None, min_length=1, max_length=255)
    email: str | None = Field(
        default=None,
        pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$",
        min_length=5,
        max_length=255,
    )
    password: str = Field(min_length=8, max_length=256)
    project_code: str | None = Field(
        default=None,
        pattern=r"^[a-z][a-z0-9_.-]*$",
        min_length=2,
        max_length=64,
    )
    device_code: str | None = Field(default=None, min_length=8, max_length=128)
    device_name: str | None = Field(default=None, max_length=128)
    version: str | None = Field(default=None, max_length=32)
    version_hash: str | None = Field(default=None, max_length=128)
    channel_code: str | None = Field(default=None, max_length=64)
    distribution_token: str | None = Field(default=None, min_length=16, max_length=256)


class RegisterRequest(StrictModel):
    password: str = Field(min_length=8, max_length=256)
    email: str = Field(
        pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$",
        min_length=5,
        max_length=255,
    )
    project_code: str = Field(
        pattern=r"^[a-z][a-z0-9_.-]*$",
        min_length=2,
        max_length=64,
    )
    device_code: str = Field(min_length=8, max_length=128)
    device_name: str | None = Field(default=None, max_length=128)
    version: str | None = Field(default=None, max_length=32)
    version_hash: str | None = Field(default=None, max_length=128)
    channel_code: str | None = Field(default=None, max_length=64)
    distribution_token: str | None = Field(default=None, min_length=16, max_length=256)
    card_key: str = Field(pattern=r"^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$")


class UserSummary(ORMModel):
    id: int
    username: str
    phone: str | None
    email: str | None
    status: str
    is_admin: bool


class PasswordAttributionSummary(StrictModel):
    project_id: int
    project_code: str
    source_type: str
    locked_at: datetime


class LoginResponse(StrictModel):
    access_token: str
    refresh_token: str | None = None
    token_type: str = "bearer"
    expires_in: int
    refresh_expires_in: int | None = None
    user: UserSummary
    attribution: PasswordAttributionSummary | None = None
    project_code: str | None = None
    license_status: Literal["active", "needs_activation"] | None = None


class RegisterResponse(LoginResponse):
    entitlement: LicenseResult


class UserCreate(StrictModel):
    username: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=256)
    phone: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=255)
    status: str = Field(default="active", pattern=r"^(active|disabled)$")
    is_admin: bool = False
    device_limit_exempt: bool = False


class UserUpdate(StrictModel):
    password: str | None = Field(default=None, min_length=8, max_length=256)
    phone: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=255)
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")
    is_admin: bool | None = None
    device_limit_exempt: bool | None = None


class UserRead(UserSummary):
    phone_masked: str | None = None
    phone_verified_at: datetime | None = None
    device_limit_exempt: bool = False
    created_at: datetime
    updated_at: datetime

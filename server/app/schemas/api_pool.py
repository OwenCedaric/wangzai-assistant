from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field, SecretStr, StrictInt

from app.schemas.common import StrictModel


class ApiPoolProviderCreate(StrictModel):
    code: str = Field(min_length=2, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    adapter: Literal["openai-compatible", "seerfar"]
    base_url: str = Field(min_length=8, max_length=512)
    auth_scheme: Literal["bearer", "header"] = "bearer"
    auth_header_name: str = Field(default="Authorization", min_length=1, max_length=128)
    capability_kinds: list[Literal["text", "image", "seerfar"]] = Field(
        min_length=1, max_length=3
    )
    timeout_seconds: StrictInt = Field(default=150, ge=10, le=300)
    priority: StrictInt = Field(default=100, ge=1, le=10_000)


class ApiPoolProviderUpdate(StrictModel):
    name: str = Field(min_length=1, max_length=128)
    adapter: Literal["openai-compatible", "seerfar"]
    base_url: str = Field(min_length=8, max_length=512)
    auth_scheme: Literal["bearer", "header"] = "bearer"
    auth_header_name: str = Field(default="Authorization", min_length=1, max_length=128)
    capability_kinds: list[Literal["text", "image", "seerfar"]] = Field(
        min_length=1, max_length=3
    )
    timeout_seconds: StrictInt = Field(default=150, ge=10, le=300)
    priority: StrictInt = Field(default=100, ge=1, le=10_000)
    status: Literal["active", "disabled"]


class ApiPoolProviderEndpointUpdate(StrictModel):
    base_url: str = Field(min_length=8, max_length=512)


class ApiPoolProviderRead(StrictModel):
    id: int
    code: str
    name: str
    adapter: str
    base_url: str
    auth_scheme: str
    auth_header_name: str
    capability_kinds: list[str]
    timeout_seconds: int
    priority: int
    status: str
    key_count: int
    active_key_count: int
    model_count: int
    active_lease_count: int
    created_at: datetime
    updated_at: datetime


class ApiPoolKeyCreate(StrictModel):
    label: str = Field(min_length=1, max_length=128)
    secret: SecretStr = Field(min_length=8, max_length=4096)
    weight: StrictInt = Field(default=100, ge=1, le=1000)
    max_concurrency: StrictInt = Field(default=0, ge=0, le=100)


class ApiPoolKeyUpdate(StrictModel):
    label: str = Field(min_length=1, max_length=128)
    weight: StrictInt = Field(default=100, ge=1, le=1000)
    max_concurrency: StrictInt = Field(default=0, ge=0, le=100)
    status: Literal["active", "disabled"]


class ApiPoolKeyRotate(StrictModel):
    secret: SecretStr = Field(min_length=8, max_length=4096)


class ApiPoolKeyRead(StrictModel):
    id: int
    provider_id: int
    label: str
    masked_hint: str
    weight: int
    max_concurrency: int
    status: str
    active_leases: int
    cooldown_until: datetime | None
    last_used_at: datetime | None
    last_success_at: datetime | None
    last_failure_at: datetime | None
    success_count: int
    failure_count: int
    request_count: int
    consecutive_failures: int
    last_error_code: str | None
    created_at: datetime
    updated_at: datetime


class ApiPoolModelCreate(StrictModel):
    capability_kind: Literal["text", "image", "seerfar"]
    model_code: str = Field(min_length=1, max_length=160)
    display_name: str = Field(min_length=1, max_length=160)
    priority: StrictInt = Field(default=100, ge=1, le=10_000)


class ApiPoolModelUpdate(StrictModel):
    display_name: str = Field(min_length=1, max_length=160)
    priority: StrictInt = Field(default=100, ge=1, le=10_000)
    status: Literal["active", "disabled"]


class ApiPoolModelRead(StrictModel):
    id: int
    provider_id: int
    capability_kind: str
    model_code: str
    display_name: str
    priority: int
    status: str
    created_at: datetime
    updated_at: datetime


class ApiPoolSummaryRead(StrictModel):
    provider_count: int
    active_provider_count: int
    key_count: int
    available_key_count: int
    cooling_key_count: int
    invalid_key_count: int
    model_count: int
    active_lease_count: int


class ApiPoolAutoConnectRequest(StrictModel):
    base_url: str = Field(min_length=8, max_length=512)
    api_key: SecretStr = Field(min_length=8, max_length=4096)


class ApiPoolAutoConnectRead(StrictModel):
    provider: ApiPoolProviderRead
    key: ApiPoolKeyRead
    models: list[ApiPoolModelRead]
    provider_created: bool
    key_created: bool
    normalized_base_url: str
    discovered_model_count: int

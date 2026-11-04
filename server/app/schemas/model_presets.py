from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from app.schemas.common import StrictModel

CapabilityKind = Literal["text", "image"]
ApiStatus = Literal["available", "busy", "cooling", "unavailable"]


class ModelPresetItemRead(StrictModel):
    model_code: str
    display_name: str
    capability_kind: CapabilityKind
    api_status: ApiStatus
    configured_api_count: int
    available_api_count: int
    busy_api_count: int
    cooling_api_count: int
    priced_capability_count: int
    total_capability_count: int
    can_enable: bool
    unavailable_reason: str | None


class ModelPresetGroupRead(StrictModel):
    capability_kind: CapabilityKind
    label: str
    enabled_models: list[str]
    default_model: str
    models: list[ModelPresetItemRead]
    updated_at: datetime | None


class ModelPresetCatalogRead(StrictModel):
    contract: Literal["user-model-preset/v1"] = "user-model-preset/v1"
    project_code: str
    groups: list[ModelPresetGroupRead]


class ModelPresetGroupWrite(StrictModel):
    capability_kind: CapabilityKind
    enabled_models: list[str] = Field(min_length=1, max_length=50)
    default_model: str = Field(min_length=1, max_length=160)

    @field_validator("enabled_models")
    @classmethod
    def normalize_models(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value]
        if any(not item or len(item) > 160 for item in normalized):
            raise ValueError("model code is invalid")
        if len(set(normalized)) != len(normalized):
            raise ValueError("enabled models must be unique")
        return normalized

    @model_validator(mode="after")
    def default_must_be_enabled(self):
        self.default_model = self.default_model.strip()
        if self.default_model not in self.enabled_models:
            raise ValueError("default model must be enabled")
        return self


class ModelPresetUpdate(StrictModel):
    project_code: str = Field(
        min_length=2,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_.-]*$",
    )
    groups: list[ModelPresetGroupWrite] = Field(min_length=2, max_length=2)

    @field_validator("groups")
    @classmethod
    def require_both_groups(cls, value: list[ModelPresetGroupWrite]):
        if {item.capability_kind for item in value} != {"text", "image"}:
            raise ValueError("text and image presets are both required")
        return value

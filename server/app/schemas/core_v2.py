from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from app.paid_capabilities.text_model_policy import (
    DEFAULT_REASONING_EFFORT,
    DEFAULT_TEXT_MODEL,
    AllowedReasoningEffort,
    AllowedTextModel,
)


class OzonShopConnectionTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(min_length=1, max_length=160)
    api_key: SecretStr = Field(min_length=1, max_length=4096)


class OzonCheckResult(BaseModel):
    ok: bool
    endpoint: str
    data: dict | list | None = None


class OzonShopConnectionTestResponse(BaseModel):
    ok: bool
    connected: bool
    message: str
    checks: dict[str, OzonCheckResult]
    roles: dict | list | None = None
    seller_info: dict | list | None = None


class ModelApiDiscoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    website_url: str = Field(min_length=1, max_length=2048)
    api_key: SecretStr | None = Field(default=None, max_length=4096)
    api_alias: str = Field(default="", max_length=160)


class ModelApiDiscoveryResponse(BaseModel):
    updates: dict[str, Any]


class TextModelByokCredential(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=160)
    base_url: str = Field(min_length=1, max_length=2048)
    api_key: SecretStr = Field(min_length=1, max_length=4096)
    model: AllowedTextModel


class ImageModelByokCredential(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=160)
    base_url: str = Field(min_length=1, max_length=2048)
    api_key: SecretStr = Field(min_length=1, max_length=4096)
    model: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$",
    )


class TextModelExecutionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    capability: Literal[
        "text.product-description",
        "text.image-plan",
        "text.external-insight",
    ]
    request_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    template_id: str = Field(default="", max_length=160, pattern=r"^[A-Za-z0-9._:-]*$")
    template_input: dict[str, Any] = Field(default_factory=dict)
    custom_rules: str = Field(default="", max_length=12_000)
    user_instruction: str = Field(default="", max_length=8_000)
    # Transitional server compatibility only. Thin-client V2 rejects these
    # fields before transmission and always uses a server-owned template ID.
    system_prompt: str = Field(default="", max_length=24_000)
    user_prompt: str = Field(default="", max_length=120_000)
    reference_images: list[str] = Field(default_factory=list, max_length=10)
    model: AllowedTextModel = DEFAULT_TEXT_MODEL
    reasoning_effort: AllowedReasoningEffort = DEFAULT_REASONING_EFFORT
    byok: TextModelByokCredential | None = None

    @model_validator(mode="after")
    def require_server_template_or_legacy_prompt(self):
        if self.byok is not None and self.byok.model != self.model:
            raise ValueError("byok model must match the requested model")
        if self.template_id:
            if not self.template_input:
                raise ValueError("template_input is required when template_id is set")
            return self
        if not self.system_prompt.strip() or not self.user_prompt.strip():
            raise ValueError("template_id or complete legacy prompts are required")
        return self


class TextModelExecutionResponse(BaseModel):
    ok: bool
    text: str
    model: str
    account_id: str
    usage: dict[str, int] | None = None
    billing: dict[str, Any] | None = None
    reference_image_count: int = 0


class OpenClawByokCredential(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=160)
    base_url: str = Field(min_length=1, max_length=2048)
    api_key: SecretStr = Field(min_length=1, max_length=4096)
    model: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$",
    )


class OpenClawChatExecutionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    model: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$",
    )
    request_body: dict[str, Any]
    byok: OpenClawByokCredential | None = None

    @model_validator(mode="after")
    def validate_openclaw_contract(self):
        if self.byok is not None and self.byok.model != self.model:
            raise ValueError("byok model must match the requested model")
        if str(self.request_body.get("model") or "") != self.model:
            raise ValueError("request body model must match the requested model")
        if self.request_body.get("stream") is not False:
            raise ValueError("management execution only accepts non-streaming requests")
        return self


class OpenClawChatExecutionResponse(BaseModel):
    ok: bool
    response: dict[str, Any]
    model: str
    account_id: str
    billing: dict[str, Any] | None = None


class ImageModelExecutionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    capability: Literal["image.generate", "image.edit"]
    request_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    shop_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    template_id: Literal["product-image-generation.v1"]
    template_input: dict[str, Any]
    size: Literal["1024x1024", "1008x1344", "1344x1008"] = "1008x1344"
    quality: Literal["standard", "high", "hd", "2k", "4k"] = "2k"
    source_images: list[str] = Field(default_factory=list, max_length=4)
    byok: ImageModelByokCredential | None = None

    @field_validator("source_images")
    @classmethod
    def validate_source_images(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        total_characters = 0
        for raw in values:
            value = str(raw or "").strip()
            if not value:
                raise ValueError("source image cannot be empty")
            if not value.startswith(
                (
                    "https://",
                    "data:image/jpeg;base64,",
                    "data:image/png;base64,",
                    "data:image/webp;base64,",
                )
            ):
                raise ValueError("source image must be HTTPS or a supported data URL")
            total_characters += len(value)
            if total_characters > 28_000_000:
                raise ValueError("source images are too large")
            normalized.append(value)
        return normalized

    @model_validator(mode="after")
    def validate_image_contract(self):
        if self.shop_id == "shop-unbound":
            raise ValueError("shop_id is invalid")
        if not self.template_input:
            raise ValueError("template_input is required")
        if self.capability == "image.edit" and not self.source_images:
            raise ValueError("source_images are required for image.edit")
        if self.capability == "image.generate" and self.source_images:
            raise ValueError("source_images are forbidden for image.generate")
        return self


class ImageModelOutput(BaseModel):
    url: str = ""
    b64_json: str = ""

    @model_validator(mode="after")
    def require_one_delivery(self):
        if bool(self.url) == bool(self.b64_json):
            raise ValueError("exactly one image delivery field is required")
        return self


class ImageModelExecutionResponse(BaseModel):
    ok: bool
    images: list[ImageModelOutput] = Field(min_length=1, max_length=4)
    model: str
    account_id: str
    billing: dict[str, Any] | None = None


class CrossBorderAuthorizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_ref: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9._:-]+$")
    user_name: str = Field(min_length=1, max_length=160)
    password: SecretStr = Field(min_length=1, max_length=512)
    previous_authorization_ref: str = Field(default="", max_length=8192)


class CrossBorderAuthorizeResponse(BaseModel):
    ok: bool
    authorized: bool
    authorization_ref: str
    account_ref: str
    expires_at: str
    message: str


class CrossBorderRevokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_ref: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9._:-]+$")
    authorization_ref: str = Field(min_length=32, max_length=8192)


class CrossBorderReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    authorization_ref: str = Field(min_length=32, max_length=8192)
    endpoint_key: str = Field(min_length=1, max_length=96)
    body: dict[str, Any] = Field(default_factory=dict)


class CrossBorderWritePreviewRequest(CrossBorderReadRequest):
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9._:-]+$")


class CrossBorderWriteConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    authorization_ref: str = Field(min_length=32, max_length=8192)
    preview_token: str = Field(min_length=32, max_length=16384)

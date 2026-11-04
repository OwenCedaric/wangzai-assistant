from __future__ import annotations

from datetime import datetime

from pydantic import Field, SecretStr, field_validator, model_validator

from app.schemas.common import StrictModel

SCENES = "^(passportRequired|pickupReminder|shipmentNotice|reviewRequest)$"


class SmartReplyCredentialUpsert(StrictModel):
    client_id: str = Field(min_length=1, max_length=128)
    api_key: SecretStr = Field(min_length=8, max_length=4096)


class SmartReplyRuleUpsert(StrictModel):
    rule_id: str | None = Field(default=None, min_length=8, max_length=64)
    scene: str = Field(pattern=SCENES)
    shop_client_ids: list[str] = Field(min_length=1, max_length=100)
    send_time_type: str = Field(pattern="^(immediate|delayed)$")
    delay_hours: int = Field(default=0, ge=0, le=72)
    content_generate_type: str = Field(default="template", pattern="^template$")
    template_id: str = Field(min_length=1, max_length=100)
    message_template: str = Field(min_length=1, max_length=500)
    message_template_zh: str = Field(default="", max_length=500)
    enabled: bool = False

    @field_validator("shop_client_ids")
    @classmethod
    def normalize_shop_ids(cls, value: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))
        if not normalized:
            raise ValueError("请至少选择一个店铺。")
        return normalized

    @model_validator(mode="after")
    def validate_send_time(self):
        if self.send_time_type == "immediate" and self.delay_hours != 0:
            raise ValueError("立即发送不能填写延时时间。")
        if self.send_time_type == "delayed" and self.delay_hours < 1:
            raise ValueError("延时发送至少需要 1 小时。")
        return self


class SmartReplyRuleEnabledUpdate(StrictModel):
    enabled: bool


class SmartReplyRuleRead(StrictModel):
    rule_id: str
    scene: str
    shop_client_ids: list[str]
    send_time_type: str
    delay_hours: int
    content_generate_type: str
    template_id: str
    message_template: str
    message_template_zh: str
    enabled: bool
    created_at: datetime
    updated_at: datetime


class SmartReplyCredentialRead(StrictModel):
    client_id: str
    shop_name: str
    configured: bool
    status: str
    last_verified_at: datetime | None


class SmartReplyTaskRead(StrictModel):
    task_id: str
    rule_id: str
    client_id: str
    shop_name: str
    posting_number: str
    scene: str
    trigger_status: str
    scheduled_for: datetime
    status: str
    attempts: int
    chat_id: str | None
    ozon_message_id: str | None
    sent_at: datetime | None
    last_error_code: str | None
    last_error_message: str | None
    created_at: datetime


class SmartReplyTaskList(StrictModel):
    items: list[SmartReplyTaskRead]
    total: int


class SmartReplyRuntimeStatus(StrictModel):
    ok: bool = True
    mode: str = "server"
    worker_running: bool
    callback_configured: bool
    configured_shop_count: int
    enabled_rule_count: int
    pending_task_count: int

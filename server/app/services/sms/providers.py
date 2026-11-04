from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.config import Settings
from app.services.errors import DomainError


class SmsProvider(Protocol):
    name: str

    def send_verification_code(self, phone: str, code: str) -> str | None: ...


@dataclass(slots=True)
class DevelopmentSmsProvider:
    name: str = "development"

    def send_verification_code(self, phone: str, code: str) -> str:
        # Deliberately no logging: the code is returned only by the development API response.
        del phone, code
        return "development-local"


@dataclass(slots=True)
class TencentSmsProviderPlaceholder:
    name: str = "tencent"

    def send_verification_code(self, phone: str, code: str) -> str | None:
        del phone, code
        raise DomainError("Tencent SMS adapter is not installed", status_code=503)


def sms_provider_status(settings: Settings) -> tuple[bool, str | None]:
    if settings.sms_provider == "development":
        enabled = settings.app_env in {"development", "test"}
        return enabled, None if enabled else "development provider is disabled"
    configured = all(
        (
            settings.sms_access_key,
            settings.sms_secret_key,
            settings.sms_sign_name,
            settings.sms_template_code,
        )
    )
    if settings.sms_provider == "tencent":
        return False, "Tencent SMS adapter is not installed"
    return bool(configured), None if configured else "credentials or template are missing"


def build_sms_provider(settings: Settings) -> SmsProvider:
    if settings.sms_provider == "development":
        if settings.app_env not in {"development", "test"}:
            raise RuntimeError("Development SMS provider is forbidden outside development/test")
        return DevelopmentSmsProvider()
    configured, reason = sms_provider_status(settings)
    if not configured:
        if settings.sms_provider == "tencent":
            return TencentSmsProviderPlaceholder()
        raise RuntimeError(reason or "SMS provider is not configured")
    if settings.sms_provider == "aliyun":
        from app.services.sms.aliyun import AliyunSmsProvider

        return AliyunSmsProvider(settings)
    return TencentSmsProviderPlaceholder()

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        env_ignore_empty=True,
        extra="ignore",
    )

    app_name: str = "License Center"
    app_env: Literal["development", "test", "staging", "production"] = "development"
    debug: bool = False
    docs_enabled: bool = True
    registration_annual_batches: dict[str, list[int]] = Field(default_factory=dict)

    database_url: str = (
        "postgresql+psycopg://license_center:license_center@localhost:5432/license_center"
    )
    sql_echo: bool = False
    auto_create_tables: bool = False
    # Capacity knobs. Defaults equal the previous SQLAlchemy / anyio defaults, so an
    # unconfigured deployment behaves exactly as before; compose sizes them per role.
    db_pool_size: int = Field(default=5, ge=1, le=100)
    db_max_overflow: int = Field(default=10, ge=0, le=100)
    db_pool_timeout_seconds: int = Field(default=30, ge=1, le=300)
    threadpool_tokens: int = Field(default=40, ge=1, le=1000)
    # Only one role (the worker service) should run the smart-reply/maintenance loops.
    background_loops_enabled: bool = True
    redis_url: str | None = None
    redis_required: bool = False

    jwt_secret_key: str = Field(
        default="development-only-change-this-secret-before-production",
        min_length=32,
    )
    jwt_secret_key_file: str | None = None
    jwt_algorithm: str = "HS256"
    jwt_issuer: str = "license-center"
    jwt_audience: str = "license-center-clients"
    access_token_minutes: int = Field(default=60, ge=5, le=1440)
    refresh_token_days: int = Field(default=30, ge=1, le=365)
    license_token_hours: int = Field(default=24, ge=1, le=168)
    offline_grace_hours: int = Field(default=72, ge=1, le=72)

    offline_signing_private_key: str | None = None
    offline_signing_private_key_file: str | None = None
    offline_signing_key_id: str = Field(default="license-center-v1", min_length=1, max_length=64)
    protected_compute_signing_private_key: str | None = None
    protected_compute_signing_private_key_file: str | None = None
    protected_compute_signing_key_id: str = Field(
        default="protected-compute-v1", min_length=1, max_length=128
    )
    protected_compute_result_ttl_seconds: int = Field(default=300, ge=30, le=3600)
    protected_compute_offline_seconds: int = Field(default=300, ge=0, le=3600)
    protected_compute_request_skew_seconds: int = Field(default=60, ge=5, le=300)
    protected_compute_rate_limit_per_minute: int = Field(default=60, ge=1, le=1000)
    protected_compute_revocation_epoch: int = Field(default=0, ge=0)
    protected_compute_revoked_key_ids: str = ""
    protected_compute_revoked_capabilities: str = ""
    private_profit_core_file: str | None = None
    private_profit_core_sha256: str = ""
    private_profit_node_executable: str | None = None
    ozon_seller_api_base_url: str = "https://api-seller.ozon.ru"
    ozon_seller_api_timeout_seconds: int = Field(default=15, ge=5, le=60)
    ozon_notification_callback_token: str | None = Field(default=None, min_length=32)
    ozon_notification_callback_token_file: str | None = None
    ozon_notification_sink_url: str | None = None
    ozon_notification_sink_secret: str | None = Field(default=None, min_length=32)
    ozon_notification_sink_secret_file: str | None = None
    smart_reply_worker_interval_seconds: int = Field(default=5, ge=1, le=60)
    core_v2_rate_limit_per_minute: int = Field(default=30, ge=1, le=300)
    client_updates_enabled: bool = False
    client_update_bundle_file: str | None = None
    client_update_project_code: str = ""
    client_update_app_id: str = ""
    client_update_channel: str = "pilot"
    cross_border_api_base_url: str = "https://api.service.kuajing84.com"
    cross_border_api_timeout_seconds: int = Field(default=20, ge=5, le=60)
    cross_border_company_secret: str | None = Field(default=None, min_length=16)
    cross_border_company_secret_file: str | None = ".runtime/cross-border-company-secret"
    cross_border_token_state_file: str = ".runtime/cross-border-enterprise-token.enc"
    cross_border_grant_ttl_seconds: int = Field(
        default=30 * 24 * 60 * 60,
        ge=3600,
        le=365 * 24 * 60 * 60,
    )
    paid_capability_enabled: bool = False
    paid_capability_quote_ttl_seconds: int = Field(default=120, ge=30, le=600)
    paid_capability_request_skew_seconds: int = Field(default=60, ge=5, le=300)
    paid_capability_rate_limit_per_minute: int = Field(default=60, ge=1, le=1000)
    paid_text_base_url: str = "https://api.openai.com/v1"
    paid_text_api_key: str | None = None
    paid_text_api_key_file: str | None = None
    paid_image_base_url: str = "https://images.example.invalid/v1"
    paid_image_api_key: str | None = None
    paid_image_api_key_file: str | None = None
    paid_seerfar_base_url: str = "https://api.seerfar.cn"
    paid_seerfar_api_key: str | None = None
    paid_seerfar_api_key_file: str | None = None
    paid_provider_allowed_hosts: str = "api.openai.com,images.example.invalid,api.seerfar.cn"
    paid_source_image_allowed_hosts: str = ""
    paid_source_image_allow_proxy_fake_ip: bool = False
    paid_provider_timeout_seconds: int = Field(default=150, ge=10, le=300)
    # CodesOnline labels wallet credits as USD, while the current account buys
    # one credit for CNY 1. Keep that conversion explicit and server-owned.
    paid_text_credit_cny_micros: int = Field(
        default=1_000_000,
        ge=1,
        le=100_000_000,
    )
    paid_text_usage_poll_attempts: int = Field(default=8, ge=1, le=30)
    paid_text_usage_poll_interval_ms: int = Field(default=400, ge=50, le=5_000)
    paid_text_reservation_multiplier_ppm: int = Field(
        default=1_250_000,
        ge=1_000_000,
        le=5_000_000,
    )
    # Image relay task records expose credit_cost in 1/10,000 credits. The
    # verified CNY 100 package credits 11,500 points, or CNY 0.008696 each.
    paid_image_credit_cny_micros: int = Field(default=8_696, ge=1, le=100_000_000)
    paid_image_credit_scale: int = Field(default=10_000, ge=1, le=1_000_000_000)
    paid_image_reservation_multiplier_ppm: int = Field(
        default=2_000_000,
        ge=1_000_000,
        le=10_000_000,
    )
    api_pool_hash_secret: str | None = Field(default=None, min_length=32)
    api_pool_hash_secret_file: str | None = None
    api_pool_encryption_key: str | None = None
    api_pool_encryption_key_file: str | None = None
    card_hash_secret: str | None = Field(default=None, min_length=32)
    card_hash_secret_file: str | None = None
    card_encryption_key: str | None = None
    card_encryption_key_file: str | None = None

    identity_hash_secret: str | None = Field(default=None, min_length=32)
    identity_hash_secret_file: str | None = None
    identity_encryption_key: str | None = None
    identity_encryption_key_file: str | None = None
    otp_hash_secret: str | None = Field(default=None, min_length=32)
    otp_hash_secret_file: str | None = None
    refresh_token_secret: str | None = Field(default=None, min_length=32)
    refresh_token_secret_file: str | None = None
    channel_token_secret: str | None = Field(default=None, min_length=32)
    channel_token_secret_file: str | None = None

    sms_provider: Literal["development", "aliyun", "tencent"] = "development"
    sms_development_code: str = Field(default="123456", pattern=r"^\d{6}$")
    sms_expose_development_code: bool = True
    sms_access_key: str | None = None
    sms_secret_key: str | None = None
    sms_secret_key_file: str | None = None
    sms_sign_name: str | None = None
    sms_template_code: str | None = None
    sms_region_id: str = "cn-hangzhou"
    sms_api_endpoint: str = "https://dysmsapi.aliyuncs.com/"
    otp_ttl_seconds: int = Field(default=300, ge=60, le=900)
    otp_send_cooldown_seconds: int = Field(default=60, ge=10, le=300)
    otp_max_sends_per_hour: int = Field(default=5, ge=1, le=30)
    otp_max_attempts: int = Field(default=5, ge=1, le=20)
    sms_ip_rate_limit_per_minute: int = Field(default=30, ge=1, le=10000)
    sms_device_rate_limit_per_minute: int = Field(default=10, ge=1, le=10000)

    payment_default_provider: Literal["development", "wechat", "alipay"] = "development"
    payment_gateway_mode: Literal["direct", "jeepay"] = "direct"
    payment_development_enabled: bool = True
    payment_query_rate_limit_per_minute: int = Field(default=20, ge=1, le=120)
    order_expiry_minutes: int = Field(default=15, ge=5, le=1440)
    commission_hold_days: int = Field(default=7, ge=0, le=180)
    wechat_mch_id: str | None = None
    wechat_app_id: str | None = None
    wechat_merchant_serial_no: str | None = None
    wechat_api_v3_key: str | None = None
    wechat_api_v3_key_file: str | None = None
    wechat_private_key: str | None = None
    wechat_private_key_file: str | None = None
    wechat_platform_certificate: str | None = None
    wechat_platform_certificate_file: str | None = None
    wechat_notify_url: str | None = None
    wechat_refund_notify_url: str | None = None
    wechat_api_base_url: str = "https://api.mch.weixin.qq.com"
    alipay_app_id: str | None = None
    alipay_app_id_file: str | None = None
    alipay_seller_id: str | None = None
    # AI Pay's official non-Java variable names.  Keep the legacy fields below
    # as read-only compatibility fallbacks for existing deployments.
    alipay_private_pkcs_key: str | None = None
    alipay_private_pkcs_key_file: str | None = None
    alipay_alipay_public_key: str | None = None
    alipay_alipay_public_key_file: str | None = None
    alipay_private_key: str | None = None
    alipay_private_key_file: str | None = None
    alipay_public_key: str | None = None
    alipay_public_key_file: str | None = None
    alipay_notify_url: str | None = None
    alipay_gateway_url: str = "https://openapi.alipay.com/gateway.do"
    jeepay_enabled: bool = False
    jeepay_alipay_enabled: bool = False
    jeepay_wechat_enabled: bool = False
    jeepay_api_base_url: str = "http://127.0.0.1:9216"
    jeepay_mch_no: str | None = None
    jeepay_app_id: str | None = None
    jeepay_api_key: str | None = None
    jeepay_api_key_file: str | None = None
    jeepay_notify_url: str | None = None
    jeepay_refund_notify_url: str | None = None
    jeepay_alipay_way_code: Literal["ALI_QR", "ALI_PC"] = "ALI_QR"
    jeepay_wechat_way_code: Literal["WX_NATIVE"] = "WX_NATIVE"
    jeepay_client_ip: str = "127.0.0.1"
    jeepay_callback_max_age_seconds: int = Field(default=600, ge=180, le=1800)

    cors_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"
    )
    trusted_hosts: str = "localhost,127.0.0.1,testserver"

    auth_rate_limit_per_minute: int = Field(default=30, ge=1, le=10000)
    license_rate_limit_per_minute: int = Field(default=120, ge=1, le=10000)
    online_window_minutes: int = Field(default=390, ge=15, le=1440)

    bootstrap_admin_username: str | None = Field(
        default=None, min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$"
    )
    bootstrap_admin_password: str | None = Field(default=None, min_length=8, max_length=256)

    @field_validator("jwt_algorithm")
    @classmethod
    def validate_jwt_algorithm(cls, value: str) -> str:
        if value != "HS256":
            raise ValueError("JWT_ALGORITHM is fixed to HS256 in v1")
        return value

    @model_validator(mode="after")
    def load_file_secrets(self):
        # Docker/Kubernetes secrets should be mounted as files. A *_FILE value
        # intentionally overrides its inline counterpart.
        mappings = {
            "jwt_secret_key": "jwt_secret_key_file",
            "offline_signing_private_key": "offline_signing_private_key_file",
            "protected_compute_signing_private_key": ("protected_compute_signing_private_key_file"),
            "paid_text_api_key": "paid_text_api_key_file",
            "paid_image_api_key": "paid_image_api_key_file",
            "paid_seerfar_api_key": "paid_seerfar_api_key_file",
            "ozon_notification_callback_token": "ozon_notification_callback_token_file",
            "ozon_notification_sink_secret": "ozon_notification_sink_secret_file",
            "cross_border_company_secret": "cross_border_company_secret_file",
            "api_pool_hash_secret": "api_pool_hash_secret_file",
            "api_pool_encryption_key": "api_pool_encryption_key_file",
            "card_hash_secret": "card_hash_secret_file",
            "card_encryption_key": "card_encryption_key_file",
            "identity_hash_secret": "identity_hash_secret_file",
            "identity_encryption_key": "identity_encryption_key_file",
            "otp_hash_secret": "otp_hash_secret_file",
            "refresh_token_secret": "refresh_token_secret_file",
            "channel_token_secret": "channel_token_secret_file",
            "sms_secret_key": "sms_secret_key_file",
            "wechat_api_v3_key": "wechat_api_v3_key_file",
            "wechat_private_key": "wechat_private_key_file",
            "wechat_platform_certificate": "wechat_platform_certificate_file",
            "alipay_app_id": "alipay_app_id_file",
            "alipay_private_pkcs_key": "alipay_private_pkcs_key_file",
            "alipay_alipay_public_key": "alipay_alipay_public_key_file",
            "alipay_private_key": "alipay_private_key_file",
            "alipay_public_key": "alipay_public_key_file",
            "jeepay_api_key": "jeepay_api_key_file",
        }
        for value_field, file_field in mappings.items():
            file_path = getattr(self, file_field)
            if file_path:
                try:
                    value = Path(file_path).read_text(encoding="utf-8").strip()
                except OSError as exc:
                    if (
                        file_field == "cross_border_company_secret_file"
                        and not Path(file_path).exists()
                    ):
                        continue
                    raise ValueError(f"Cannot read secret file configured by {file_field}") from exc
                if not value:
                    raise ValueError(f"Secret file configured by {file_field} is empty")
                object.__setattr__(self, value_field, value)
        if not self.alipay_private_pkcs_key and self.alipay_private_key:
            object.__setattr__(self, "alipay_private_pkcs_key", self.alipay_private_key)
        if not self.alipay_alipay_public_key and self.alipay_public_key:
            object.__setattr__(self, "alipay_alipay_public_key", self.alipay_public_key)
        return self

    @field_validator("app_env", mode="before")
    @classmethod
    def normalize_app_env(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def trusted_host_list(self) -> list[str]:
        return [item.strip() for item in self.trusted_hosts.split(",") if item.strip()]

    @property
    def protected_compute_revoked_key_id_set(self) -> set[str]:
        return {
            item.strip()
            for item in self.protected_compute_revoked_key_ids.split(",")
            if item.strip()
        }

    @property
    def protected_compute_revoked_capability_set(self) -> set[str]:
        return {
            item.strip()
            for item in self.protected_compute_revoked_capabilities.split(",")
            if item.strip()
        }

    @property
    def paid_provider_allowed_host_set(self) -> set[str]:
        return {
            item.strip().lower()
            for item in self.paid_provider_allowed_hosts.split(",")
            if item.strip()
        }

    @property
    def paid_source_image_allowed_host_set(self) -> set[str]:
        return {
            item.strip().lower()
            for item in self.paid_source_image_allowed_hosts.split(",")
            if item.strip()
        }

    @property
    def api_pool_fingerprint_secret(self) -> str:
        return self.api_pool_hash_secret or self.jwt_secret_key

    @property
    def is_production(self) -> bool:
        return self.app_env in {"staging", "production"}


@lru_cache
def get_settings() -> Settings:
    from app.annual_registration_policy import load_annual_registration_policy
    from app.private_pilot_runtime import load_pilot_runtime_settings

    return load_pilot_runtime_settings(
        load_annual_registration_policy(
            Settings(), Path(__file__).resolve().parents[1] / ".annual-registration-policy.json",
        ),
        Path(__file__).resolve().parents[1] / ".pilot-server-settings.json",
    )

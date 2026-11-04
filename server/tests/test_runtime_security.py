import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import _validate_runtime_settings, create_app
from app.services.rate_limit import RateLimiterUnavailable


def _production_settings(**overrides: object) -> Settings:
    private_key = (
        Ed25519PrivateKey.generate()
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    protected_compute_private_key = (
        Ed25519PrivateKey.generate()
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    values: dict[str, object] = {
        "app_env": "production",
        "database_url": "sqlite:///:memory:",
        "redis_url": "redis://localhost:6379/0",
        "jwt_secret_key": "production-jwt-secret-that-is-long-enough",
        "card_hash_secret": "production-card-secret-that-is-long-enough",
        "card_encryption_key": Fernet.generate_key().decode(),
        "identity_hash_secret": "production-identity-secret-that-is-long-enough",
        "identity_encryption_key": Fernet.generate_key().decode(),
        "otp_hash_secret": "production-otp-secret-that-is-long-enough",
        "refresh_token_secret": "production-refresh-secret-that-is-long-enough",
        "channel_token_secret": "production-channel-secret-that-is-long-enough",
        "ozon_notification_callback_token": (
            "production-ozon-callback-token-that-is-long-enough"
        ),
        "offline_signing_private_key": private_key,
        "protected_compute_signing_private_key": protected_compute_private_key,
        "sms_provider": "aliyun",
        "sms_access_key": "key",
        "sms_secret_key": "secret",
        "sms_sign_name": "授权中心",
        "sms_template_code": "SMS_123456",
        "payment_development_enabled": False,
        "payment_default_provider": "wechat",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def test_production_rejects_development_secret() -> None:
    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY"):
        create_app(
            Settings(
                _env_file=None,
                app_env="production",
                database_url="sqlite:///:memory:",
                card_hash_secret="stable-card-secret-that-is-long-enough",
            )
        )


def test_offline_public_key_is_fail_closed_without_private_key(tmp_path) -> None:
    app = create_app(
        Settings(
            _env_file=None,
            database_url=f"sqlite:///{(tmp_path / 'no-key.db').as_posix()}",
            auto_create_tables=True,
            jwt_secret_key="runtime-test-jwt-secret-that-is-long-enough",
            card_hash_secret="runtime-card-secret-that-is-long-enough",
            offline_signing_private_key=None,
            redis_url=None,
        )
    )
    with TestClient(app) as client:
        response = client.get("/api/license/public-key")
        assert response.status_code == 503


def test_production_requires_offline_signing_key() -> None:
    with pytest.raises(RuntimeError, match="OFFLINE_SIGNING_PRIVATE_KEY"):
        create_app(
            Settings(
                _env_file=None,
                app_env="production",
                database_url="sqlite:///:memory:",
                redis_url="redis://localhost:6379/0",
                jwt_secret_key="production-jwt-secret-that-is-long-enough",
                card_hash_secret="production-card-secret-that-is-long-enough",
                card_encryption_key=Fernet.generate_key().decode(),
                identity_hash_secret="production-identity-secret-that-is-long-enough",
                identity_encryption_key=Fernet.generate_key().decode(),
                otp_hash_secret="production-otp-secret-that-is-long-enough",
                refresh_token_secret="production-refresh-secret-that-is-long-enough",
                channel_token_secret="production-channel-secret-that-is-long-enough",
                ozon_notification_callback_token=(
                    "production-ozon-callback-token-that-is-long-enough"
                ),
                sms_provider="aliyun",
                payment_development_enabled=False,
                payment_default_provider="wechat",
            )
        )


def test_production_requires_an_independent_protected_compute_key() -> None:
    private_key = (
        Ed25519PrivateKey.generate()
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    with pytest.raises(RuntimeError, match="must be independent"):
        _validate_runtime_settings(
            _production_settings(
                offline_signing_private_key=private_key,
                protected_compute_signing_private_key=private_key,
            )
        )


def test_production_requires_protected_compute_signing_key() -> None:
    with pytest.raises(RuntimeError, match="PROTECTED_COMPUTE_SIGNING_PRIVATE_KEY"):
        _validate_runtime_settings(_production_settings(protected_compute_signing_private_key=None))


def test_production_requires_ozon_notification_callback_token() -> None:
    with pytest.raises(RuntimeError, match="OZON_NOTIFICATION_CALLBACK_TOKEN"):
        _validate_runtime_settings(
            _production_settings(ozon_notification_callback_token=None)
        )


def test_file_secrets_override_inline_values(tmp_path) -> None:
    jwt_file = tmp_path / "jwt-secret"
    jwt_file.write_text("file-jwt-secret-that-is-at-least-32-characters", encoding="utf-8")
    private_key = Ed25519PrivateKey.generate()
    offline_file = tmp_path / "offline.pem"
    offline_file.write_bytes(
        private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    alipay_app_id_file = tmp_path / "alipay-app-id"
    alipay_app_id_file.write_text("2026000000000001", encoding="utf-8")
    settings = Settings(
        _env_file=None,
        jwt_secret_key="inline-jwt-secret-that-is-long-enough",
        jwt_secret_key_file=str(jwt_file),
        offline_signing_private_key="invalid-inline-value",
        offline_signing_private_key_file=str(offline_file),
        alipay_app_id="2026000000000002",
        alipay_app_id_file=str(alipay_app_id_file),
    )
    assert settings.jwt_secret_key == jwt_file.read_text(encoding="utf-8")
    assert "BEGIN PRIVATE KEY" in settings.offline_signing_private_key
    assert settings.alipay_app_id == "2026000000000001"


def test_production_does_not_register_development_payment_route() -> None:
    private_key = (
        Ed25519PrivateKey.generate()
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    protected_compute_private_key = (
        Ed25519PrivateKey.generate()
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    app = create_app(
        Settings(
            _env_file=None,
            app_env="production",
            database_url="sqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            jwt_secret_key="production-jwt-secret-that-is-long-enough",
            card_hash_secret="production-card-secret-that-is-long-enough",
            card_encryption_key=Fernet.generate_key().decode(),
            identity_hash_secret="production-identity-secret-that-is-long-enough",
            identity_encryption_key=Fernet.generate_key().decode(),
            otp_hash_secret="production-otp-secret-that-is-long-enough",
            refresh_token_secret="production-refresh-secret-that-is-long-enough",
            channel_token_secret="production-channel-secret-that-is-long-enough",
            ozon_notification_callback_token=(
                "production-ozon-callback-token-that-is-long-enough"
            ),
            offline_signing_private_key=private_key,
            protected_compute_signing_private_key=protected_compute_private_key,
            sms_provider="aliyun",
            sms_access_key="key",
            sms_secret_key="secret",
            sms_sign_name="授权中心",
            sms_template_code="SMS_123456",
            payment_development_enabled=False,
            payment_default_provider="wechat",
        )
    )
    assert "/api/payments/development/{order_no}/complete" not in app.openapi()["paths"]


@pytest.mark.parametrize(
    "field, value",
    [
        ("sms_api_endpoint", "http://dysmsapi.aliyuncs.com/"),
        ("sms_api_endpoint", "https://dysmsapi.aliyuncs.com.evil.example/"),
        ("wechat_api_base_url", "https://user@api.mch.weixin.qq.com"),
        ("wechat_api_base_url", "https://api.mch.weixin.qq.com/#fragment"),
        ("wechat_api_base_url", "https://payments.example.com"),
        ("alipay_gateway_url", "http://openapi.alipay.com/gateway.do"),
        ("alipay_gateway_url", "https://openapi.alipay.com.evil.example/gateway.do"),
        ("alipay_gateway_url", "https://openapi.alipay.com/other"),
        ("wechat_notify_url", "http://license.example/payments/wechat/notify"),
        (
            "wechat_refund_notify_url",
            "https://user@license.example/payments/wechat/refund-notify",
        ),
        ("alipay_notify_url", "https://license.example/payments/alipay/notify#fragment"),
    ],
)
def test_production_rejects_unsafe_provider_urls(field: str, value: str) -> None:
    with pytest.raises(RuntimeError, match=field.upper()):
        _validate_runtime_settings(_production_settings(**{field: value}))


def test_production_accepts_https_notify_urls_and_official_gateways() -> None:
    _validate_runtime_settings(
        _production_settings(
            wechat_notify_url="https://license.example/payments/wechat/notify?tenant=main",
            wechat_refund_notify_url=("https://license.example/payments/wechat/refund-notify"),
            alipay_notify_url="https://license.example/payments/alipay/notify",
        )
    )


def test_production_accepts_https_jeepay_gateway_and_exact_callback_paths() -> None:
    _validate_runtime_settings(
        _production_settings(
            payment_gateway_mode="jeepay",
            jeepay_enabled=True,
            jeepay_alipay_enabled=True,
            jeepay_wechat_enabled=True,
            jeepay_api_base_url="https://pay-api.example.com",
            jeepay_mch_no="M202608050001",
            jeepay_app_id="app-202608050001",
            jeepay_api_key="0123456789abcdef0123456789abcdef",
            jeepay_notify_url=("https://license.example/api/payments/jeepay/notify"),
            jeepay_refund_notify_url=(
                "https://license.example/api/payments/jeepay/refund-notify"
            ),
        )
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("jeepay_api_base_url", "http://pay-api.example.com"),
        ("jeepay_api_base_url", "https://user@pay-api.example.com"),
        (
            "jeepay_notify_url",
            "https://license.example/api/payments/alipay/notify",
        ),
        (
            "jeepay_refund_notify_url",
            "https://license.example/api/payments/jeepay/notify",
        ),
    ],
)
def test_production_rejects_unsafe_jeepay_urls(field: str, value: str) -> None:
    values: dict[str, object] = {
        "payment_gateway_mode": "jeepay",
        "jeepay_enabled": True,
        "jeepay_alipay_enabled": True,
        "jeepay_wechat_enabled": True,
        "jeepay_api_base_url": "https://pay-api.example.com",
        "jeepay_mch_no": "M202608050001",
        "jeepay_app_id": "app-202608050001",
        "jeepay_api_key": "0123456789abcdef0123456789abcdef",
        "jeepay_notify_url": "https://license.example/api/payments/jeepay/notify",
        "jeepay_refund_notify_url": (
            "https://license.example/api/payments/jeepay/refund-notify"
        ),
    }
    values[field] = value
    with pytest.raises(RuntimeError, match=field.upper()):
        _validate_runtime_settings(_production_settings(**values))


@pytest.mark.parametrize(
    "values",
    [
        {
            "jeepay_alipay_enabled": False,
            "jeepay_wechat_enabled": False,
        },
        {
            "payment_default_provider": "wechat",
            "jeepay_alipay_enabled": True,
            "jeepay_wechat_enabled": False,
        },
        {
            "payment_default_provider": "alipay",
            "jeepay_alipay_enabled": False,
            "jeepay_wechat_enabled": True,
        },
    ],
)
def test_production_rejects_missing_or_mismatched_jeepay_channel_switches(
    values: dict[str, object],
) -> None:
    configuration: dict[str, object] = {
        "payment_gateway_mode": "jeepay",
        "payment_default_provider": "wechat",
        "jeepay_enabled": True,
        "jeepay_alipay_enabled": True,
        "jeepay_wechat_enabled": True,
        "jeepay_api_base_url": "https://pay-api.example.com",
        "jeepay_mch_no": "M202608050001",
        "jeepay_app_id": "app-202608050001",
        "jeepay_api_key": "0123456789abcdef0123456789abcdef",
        "jeepay_notify_url": "https://license.example/api/payments/jeepay/notify",
        "jeepay_refund_notify_url": (
            "https://license.example/api/payments/jeepay/refund-notify"
        ),
    }
    configuration.update(values)
    with pytest.raises(RuntimeError, match="Jeepay payment channel"):
        _validate_runtime_settings(_production_settings(**configuration))


def test_validation_errors_do_not_echo_password(client: TestClient) -> None:
    secret = "Z" * 300
    response = client.post("/api/auth/login", json={"username": "some-user", "password": secret})
    assert response.status_code == 422
    assert secret not in response.text
    assert "input" not in response.text


def test_rate_limiter_outage_is_not_reported_as_client_throttling(client: TestClient) -> None:
    class UnavailableLimiter:
        def hit(self, _key: str, *, limit: int, window_seconds: int = 60) -> None:
            raise RateLimiterUnavailable

    client.app.state.rate_limiter = UnavailableLimiter()
    response = client.post(
        "/api/auth/login",
        json={"username": "some-user", "password": "long-enough-password"},
    )
    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"

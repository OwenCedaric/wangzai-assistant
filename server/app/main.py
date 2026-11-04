from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import anyio.to_thread
from cryptography.fernet import Fernet
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from redis import Redis
from redis.exceptions import RedisError
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.api.payments import development_router
from app.api.router import api_router
from app.auth.offline import load_offline_private_key
from app.auth.security import hash_password
from app.config import Settings, get_settings
from app.database import Base, build_engine, build_session_factory
from app.middleware.body_limit import BodySizeLimitMiddleware
from app.models import User  # noqa: F401 - registers every mapped model
from app.paid_capabilities.api_pool_provider import PooledPaidCapabilityProvider
from app.paid_capabilities.providers import (
    UnavailablePaidCapabilityProvider,
)
from app.protected_compute.replay import ProtectedComputeReplayGuard
from app.protected_compute.service import load_protected_compute_private_key
from app.services.background_loops import BackgroundLoops
from app.services.errors import DomainError
from app.services.otp_service import OtpService, build_otp_store
from app.services.presence import RedisPresence
from app.services.rate_limit import InMemoryRateLimiter, RedisRateLimiter
from app.services.sms import build_sms_provider, sms_provider_status

logger = logging.getLogger(__name__)


class NullPresence:
    def touch(self, user_id: int, license_id: int) -> None:
        return None

    def count_users(self) -> int | None:
        return None


def _validate_production_url(
    name: str,
    value: str,
    *,
    official_host: str | None = None,
    allowed_paths: set[str] | None = None,
    allow_query: bool = True,
) -> None:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a valid HTTPS URL") from exc
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or value != value.strip()
        or any(character.isspace() for character in value)
        or "\\" in value
    ):
        raise RuntimeError(f"{name} must be a valid HTTPS URL")
    if parsed.username is not None or parsed.password is not None:
        raise RuntimeError(f"{name} must not contain userinfo")
    if "#" in value:
        raise RuntimeError(f"{name} must not contain a fragment")
    if official_host:
        if parsed.hostname.lower() != official_host or port not in {None, 443}:
            raise RuntimeError(f"{name} must use the official {official_host} gateway")
    if allowed_paths is not None and parsed.path not in allowed_paths:
        raise RuntimeError(f"{name} path is not allowed")
    if not allow_query and parsed.query:
        raise RuntimeError(f"{name} must not contain a query string")


def _validate_runtime_settings(settings: Settings) -> None:
    if settings.redis_required and not settings.redis_url:
        raise RuntimeError("REDIS_URL is required when REDIS_REQUIRED=true")
    if settings.is_production:
        if settings.debug:
            raise RuntimeError("DEBUG must be false in production")
        if settings.auto_create_tables:
            raise RuntimeError("AUTO_CREATE_TABLES must be false in production")
        if (
            len(settings.jwt_secret_key) < 32
            or settings.jwt_secret_key.startswith("development-only")
            or "replace-with" in settings.jwt_secret_key
            or "change-me" in settings.jwt_secret_key
        ):
            raise RuntimeError("JWT_SECRET_KEY must be changed in production")
        if (
            not settings.card_hash_secret
            or len(settings.card_hash_secret) < 32
            or any(marker in settings.card_hash_secret for marker in ("replace-with", "change-me"))
        ):
            raise RuntimeError("CARD_HASH_SECRET is required in production")
        if not settings.card_encryption_key:
            raise RuntimeError("CARD_ENCRYPTION_KEY is required in production")
        required_secrets = {
            "IDENTITY_HASH_SECRET": settings.identity_hash_secret,
            "OTP_HASH_SECRET": settings.otp_hash_secret,
            "REFRESH_TOKEN_SECRET": settings.refresh_token_secret,
            "CHANNEL_TOKEN_SECRET": settings.channel_token_secret,
        }
        if any(
            not value
            or len(value) < 32
            or any(marker in value for marker in ("replace-with", "change-me"))
            for value in required_secrets.values()
        ):
            raise RuntimeError("Identity, OTP, refresh, and channel secrets are required")
        if not settings.identity_encryption_key:
            raise RuntimeError("IDENTITY_ENCRYPTION_KEY is required in production")
        if not settings.ozon_notification_callback_token:
            raise RuntimeError("OZON_NOTIFICATION_CALLBACK_TOKEN is required in production")
        if not settings.offline_signing_private_key:
            raise RuntimeError("OFFLINE_SIGNING_PRIVATE_KEY is required in production")
        if not settings.protected_compute_signing_private_key:
            raise RuntimeError("PROTECTED_COMPUTE_SIGNING_PRIVATE_KEY is required in production")
        if settings.paid_capability_enabled:
            paid_secrets = {
                "PAID_TEXT_API_KEY": settings.paid_text_api_key,
                "PAID_IMAGE_API_KEY": settings.paid_image_api_key,
                "PAID_SEERFAR_API_KEY": settings.paid_seerfar_api_key,
            }
            legacy_keys_complete = all(paid_secrets.values())
            api_pool_ready = bool(
                settings.api_pool_hash_secret and settings.api_pool_encryption_key
            )
            if not legacy_keys_complete and not api_pool_ready:
                raise RuntimeError(
                    "Paid capabilities require either the API pool secrets "
                    "or every legacy provider key"
                )
            if not settings.paid_source_image_allowed_host_set:
                raise RuntimeError("PAID_SOURCE_IMAGE_ALLOWED_HOSTS is required")
            for name, value in (
                ("PAID_TEXT_BASE_URL", settings.paid_text_base_url),
                ("PAID_IMAGE_BASE_URL", settings.paid_image_base_url),
                ("PAID_SEERFAR_BASE_URL", settings.paid_seerfar_base_url),
            ):
                _validate_production_url(name, value, allow_query=False)
                host = (urlsplit(value).hostname or "").lower()
                if host not in settings.paid_provider_allowed_host_set:
                    raise RuntimeError(f"{name} host is not in PAID_PROVIDER_ALLOWED_HOSTS")
        if settings.sms_provider == "development":
            raise RuntimeError("Development SMS provider is forbidden in production")
        sms_configured, sms_reason = sms_provider_status(settings)
        if not sms_configured:
            raise RuntimeError(sms_reason or "SMS provider is not configured")
        if (
            settings.payment_development_enabled
            or settings.payment_default_provider == "development"
        ):
            raise RuntimeError("Development payments are forbidden in production")
        if not settings.redis_url:
            raise RuntimeError("Redis is required for production OTP")
        _validate_production_url(
            "SMS_API_ENDPOINT",
            settings.sms_api_endpoint,
            official_host="dysmsapi.aliyuncs.com",
            allowed_paths={"", "/"},
            allow_query=False,
        )
        if settings.payment_gateway_mode == "direct":
            _validate_production_url(
                "WECHAT_API_BASE_URL",
                settings.wechat_api_base_url,
                official_host="api.mch.weixin.qq.com",
                allowed_paths={"", "/"},
                allow_query=False,
            )
            _validate_production_url(
                "ALIPAY_GATEWAY_URL",
                settings.alipay_gateway_url,
                official_host="openapi.alipay.com",
                allowed_paths={"/gateway.do"},
                allow_query=False,
            )
            for name, value in (
                ("WECHAT_NOTIFY_URL", settings.wechat_notify_url),
                ("WECHAT_REFUND_NOTIFY_URL", settings.wechat_refund_notify_url),
                ("ALIPAY_NOTIFY_URL", settings.alipay_notify_url),
            ):
                if value:
                    _validate_production_url(name, value)
        else:
            if not settings.jeepay_enabled:
                raise RuntimeError("JEEPAY_ENABLED must be true when Jeepay is selected")
            if not (
                settings.jeepay_alipay_enabled or settings.jeepay_wechat_enabled
            ):
                raise RuntimeError("At least one Jeepay payment channel must be enabled")
            default_channel_enabled = (
                settings.jeepay_alipay_enabled
                if settings.payment_default_provider == "alipay"
                else settings.jeepay_wechat_enabled
            )
            if not default_channel_enabled:
                raise RuntimeError("The default Jeepay payment channel must be enabled")
            if not all(
                (
                    settings.jeepay_mch_no,
                    settings.jeepay_app_id,
                    settings.jeepay_api_key,
                    settings.jeepay_notify_url,
                    settings.jeepay_refund_notify_url,
                )
            ) or len(settings.jeepay_api_key or "") < 16:
                raise RuntimeError("Jeepay merchant application credentials are required")
            _validate_production_url(
                "JEEPAY_API_BASE_URL",
                settings.jeepay_api_base_url,
                allow_query=False,
            )
            _validate_production_url(
                "JEEPAY_NOTIFY_URL",
                settings.jeepay_notify_url or "",
                allowed_paths={"/api/payments/jeepay/notify"},
                allow_query=False,
            )
            _validate_production_url(
                "JEEPAY_REFUND_NOTIFY_URL",
                settings.jeepay_refund_notify_url or "",
                allowed_paths={"/api/payments/jeepay/refund-notify"},
                allow_query=False,
            )
        if "*" in settings.cors_origin_list:
            raise RuntimeError("Wildcard CORS origins are forbidden in production")
        if "*" in settings.trusted_host_list:
            raise RuntimeError("Wildcard trusted hosts are forbidden in production")
    if bool(settings.bootstrap_admin_username) != bool(settings.bootstrap_admin_password):
        raise RuntimeError(
            "BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD must be configured together"
        )
    if settings.card_encryption_key:
        try:
            Fernet(settings.card_encryption_key.encode("ascii"))
        except (ValueError, TypeError) as exc:
            raise RuntimeError("CARD_ENCRYPTION_KEY must be a valid Fernet key") from exc
    if settings.identity_encryption_key:
        try:
            Fernet(settings.identity_encryption_key.encode("ascii"))
        except (ValueError, TypeError) as exc:
            raise RuntimeError("IDENTITY_ENCRYPTION_KEY must be a valid Fernet key") from exc
    if settings.api_pool_encryption_key:
        try:
            Fernet(settings.api_pool_encryption_key.encode("ascii"))
        except (ValueError, TypeError) as exc:
            raise RuntimeError("API_POOL_ENCRYPTION_KEY must be a valid Fernet key") from exc
    offline_private_key = (
        load_offline_private_key(settings) if settings.offline_signing_private_key else None
    )
    protected_compute_private_key = (
        load_protected_compute_private_key(settings)
        if settings.protected_compute_signing_private_key
        else None
    )
    if (
        settings.is_production
        and offline_private_key is not None
        and protected_compute_private_key is not None
        and offline_private_key.public_key().public_bytes_raw()
        == protected_compute_private_key.public_key().public_bytes_raw()
    ):
        raise RuntimeError("Protected-compute and offline-license signing keys must be independent")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    _validate_runtime_settings(settings)
    engine = build_engine(
        settings.database_url,
        echo=settings.sql_echo,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout_seconds=settings.db_pool_timeout_seconds,
    )
    session_factory = build_session_factory(engine)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Sync route handlers run in anyio's default thread pool (40 by default).
        anyio.to_thread.current_default_thread_limiter().total_tokens = (
            settings.threadpool_tokens
        )
        if settings.auto_create_tables:
            Base.metadata.create_all(engine)
        redis_client: Redis | None = None
        if settings.redis_url:
            try:
                redis_client = Redis.from_url(
                    settings.redis_url, decode_responses=False, socket_connect_timeout=2
                )
                redis_client.ping()
            except RedisError as exc:
                if settings.redis_required:
                    raise RuntimeError("Redis is required but unavailable") from exc
                redis_client = None
        app.state.redis = redis_client
        app.state.rate_limiter = (
            RedisRateLimiter(redis_client) if redis_client else InMemoryRateLimiter()
        )
        app.state.presence = (
            RedisPresence(redis_client, ttl_seconds=settings.online_window_minutes * 60)
            if redis_client
            else NullPresence()
        )
        app.state.otp_service = OtpService(
            settings,
            build_otp_store(settings, redis_client),
            build_sms_provider(settings),
        )

        if settings.bootstrap_admin_username and settings.bootstrap_admin_password:
            with session_factory() as db:
                existing = db.scalar(
                    select(User).where(User.username == settings.bootstrap_admin_username)
                )
                if existing is None:
                    db.add(
                        User(
                            username=settings.bootstrap_admin_username,
                            password_hash=hash_password(settings.bootstrap_admin_password),
                            is_admin=True,
                            status="active",
                        )
                    )
                    try:
                        db.commit()
                    except IntegrityError:
                        # Another worker may have bootstrapped the same admin concurrently.
                        db.rollback()
        background_loops = BackgroundLoops(session_factory, settings, redis_client)
        if settings.background_loops_enabled:
            background_loops.start()
        app.state.smart_reply_worker_task = background_loops.smart_reply_task
        yield
        await background_loops.stop()
        app.state.smart_reply_worker_task = None
        if redis_client:
            redis_client.close()
        engine.dispose()

    app = FastAPI(
        title=settings.app_name,
        version="1.1.0",
        debug=settings.debug and not settings.is_production,
        docs_url="/docs" if settings.docs_enabled and not settings.is_production else None,
        redoc_url="/redoc" if settings.docs_enabled and not settings.is_production else None,
        openapi_url=(
            "/openapi.json" if settings.docs_enabled and not settings.is_production else None
        ),
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.state.redis = None
    app.state.rate_limiter = InMemoryRateLimiter()
    app.state.presence = NullPresence()
    app.state.otp_service = (
        OtpService(settings, build_otp_store(settings, None), build_sms_provider(settings))
        if settings.app_env in {"development", "test"}
        else None
    )
    app.state.protected_compute_replay_guard = ProtectedComputeReplayGuard()
    app.state.paid_capability_replay_guard = ProtectedComputeReplayGuard()
    app.state.smart_reply_worker_task = None
    app.state.oss_usage_client_factory = None
    app.state.oss_image_source_stager_factory = None
    # Fail closed until a server-side provider dispatcher is explicitly configured.
    # Provider credentials are never accepted from, or returned to, desktop clients.
    app.state.paid_capability_provider = (
        PooledPaidCapabilityProvider(settings, session_factory)
        if settings.paid_capability_enabled
        else UnavailablePaidCapabilityProvider()
    )

    app.add_middleware(
        BodySizeLimitMiddleware,
        max_bytes=2 * 1024 * 1024,
        path_max_bytes={"/api/recovery/objects/": 30 * 1024 * 1024},
    )
    if settings.trusted_host_list:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.trusted_host_list)
    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=False,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=[
                "Authorization",
                "Content-Type",
                "Accept",
                "X-Recovery-Cipher-Sha256",
                "X-Recovery-Cipher-Bytes",
            ],
        )

    @app.exception_handler(DomainError)
    async def domain_error_handler(_request: Request, exc: DomainError):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, exc: RequestValidationError):
        sanitized_errors = [
            {key: value for key, value in error.items() if key not in {"input", "ctx", "url"}}
            for error in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": sanitized_errors})

    @app.get("/health", tags=["system"])
    def health(request: Request):
        database_ok = False
        try:
            with session_factory() as db:
                database_ok = db.scalar(text("SELECT 1")) == 1
        except Exception:
            database_ok = False
        redis_state = "disabled"
        if request.app.state.redis:
            try:
                request.app.state.redis.ping()
                redis_state = "ok"
            except RedisError:
                redis_state = "unavailable"
        return {
            "status": "ok" if database_ok else "degraded",
            "database": "ok" if database_ok else "unavailable",
            "redis": redis_state,
            "version": "1.1.0",
        }

    app.include_router(api_router)
    if settings.app_env in {"development", "test"} and settings.payment_development_enabled:
        app.include_router(development_router)
    return app


app = create_app()

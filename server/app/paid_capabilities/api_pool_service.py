from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from uuid import uuid4

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.models.api_pool import ApiPoolKey, ApiPoolLease, ApiPoolModel, ApiPoolProvider
from app.paid_capabilities.api_pool_crypto import decrypt_api_secret
from app.paid_capabilities.image_model_policy import (
    APPROVED_IMAGE_API_BASE_URL,
    APPROVED_IMAGE_MODEL,
    image_model_is_allowed,
    normalize_image_api_base_url,
)
from app.paid_capabilities.providers import ApiPoolConnection, PaidProviderFailure
from app.paid_capabilities.text_model_policy import text_model_is_allowed

PROVIDER_CODE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
HEADER_NAME_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,128}$")
API_POOL_ADAPTERS = frozenset({"openai-compatible", "seerfar"})
API_POOL_CAPABILITY_KINDS = frozenset({"text", "image", "seerfar"})
API_POOL_AUTH_SCHEMES = frozenset({"bearer", "header"})


class ApiPoolConfigurationError(ValueError):
    pass


class ApiPoolDispatchError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class AcquiredApiCredential:
    provider_id: int
    provider_code: str
    key_id: int
    lease_id: str
    connection: ApiPoolConnection


def normalize_provider_code(value: str) -> str:
    code = value.strip().lower()
    if not PROVIDER_CODE_PATTERN.fullmatch(code):
        raise ApiPoolConfigurationError("Provider code format is invalid")
    return code


def validate_provider_configuration(
    settings: Settings,
    *,
    adapter: str,
    base_url: str,
    auth_scheme: str,
    auth_header_name: str,
    capability_kinds: list[str],
) -> tuple[str, list[str]]:
    if adapter not in API_POOL_ADAPTERS:
        raise ApiPoolConfigurationError("Provider adapter is not supported")
    if auth_scheme not in API_POOL_AUTH_SCHEMES:
        raise ApiPoolConfigurationError("Provider authentication scheme is not supported")
    if not HEADER_NAME_PATTERN.fullmatch(auth_header_name):
        raise ApiPoolConfigurationError("Provider authentication header is invalid")
    kinds = sorted({item.strip().lower() for item in capability_kinds if item.strip()})
    if not kinds or any(item not in API_POOL_CAPABILITY_KINDS for item in kinds):
        raise ApiPoolConfigurationError("Provider capability types are invalid")
    if adapter == "openai-compatible" and any(item == "seerfar" for item in kinds):
        raise ApiPoolConfigurationError("OpenAI-compatible providers cannot serve Seerfar")
    if adapter == "seerfar" and kinds != ["seerfar"]:
        raise ApiPoolConfigurationError("Seerfar adapter only supports Seerfar capabilities")
    try:
        parsed = urlsplit(base_url.strip())
        port = parsed.port
    except ValueError as exc:
        raise ApiPoolConfigurationError("Provider base URL is invalid") from exc
    host = (parsed.hostname or "").lower()
    public_managed_host = False
    if (
        host
        and host != "localhost"
        and not host.endswith((".localhost", ".local", ".internal", ".arpa"))
    ):
        try:
            public_managed_host = ipaddress.ip_address(host).is_global
        except ValueError:
            public_managed_host = "." in host
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or port not in {None, 443}
        or (host not in settings.paid_provider_allowed_host_set and not public_managed_host)
    ):
        raise ApiPoolConfigurationError(
            "Provider base URL must use HTTPS and cannot point to a local or private host"
        )
    normalized_base_url = base_url.strip().rstrip("/")
    if "image" in kinds and not normalize_image_api_base_url(normalized_base_url):
        raise ApiPoolConfigurationError(
            f"Image providers must use exactly {APPROVED_IMAGE_API_BASE_URL}"
        )
    return normalized_base_url, kinds


def provider_supports_kind(provider: ApiPoolProvider, capability_kind: str) -> bool:
    return capability_kind in set(provider.capability_kinds or [])


def _expire_stale_leases(db: Session, current: datetime) -> None:
    db.execute(
        update(ApiPoolLease)
        .where(ApiPoolLease.status == "active", ApiPoolLease.expires_at <= current)
        .values(status="expired", released_at=current)
    )


def _active_lease_counts(db: Session, key_ids: list[int], current: datetime) -> dict[int, int]:
    if not key_ids:
        return {}
    rows = db.execute(
        select(ApiPoolLease.key_id, func.count(ApiPoolLease.id))
        .where(
            ApiPoolLease.key_id.in_(key_ids),
            ApiPoolLease.status == "active",
            ApiPoolLease.expires_at > current,
        )
        .group_by(ApiPoolLease.key_id)
    ).all()
    return {key_id: count for key_id, count in rows}


def acquire_api_credential(
    session_factory: sessionmaker[Session],
    settings: Settings,
    *,
    provider_code: str,
    capability_kind: str,
    provider_model: str,
    exclusive: bool = False,
    now: datetime | None = None,
) -> AcquiredApiCredential | None:
    if capability_kind == "text" and not text_model_is_allowed(provider_model):
        raise ApiPoolDispatchError(
            "PAID_CAPABILITY_API_POOL_MODEL_FORBIDDEN",
            "The requested text model is not allowed by server policy",
        )
    if capability_kind == "image" and not image_model_is_allowed(provider_model):
        raise ApiPoolDispatchError(
            "PAID_CAPABILITY_API_POOL_MODEL_FORBIDDEN",
            f"Image requests are locked to {APPROVED_IMAGE_MODEL}",
        )
    current = (now or datetime.now(UTC)).astimezone(UTC)
    with session_factory() as db:
        # SQLite ignores SELECT FOR UPDATE. BEGIN IMMEDIATE serializes the
        # lease decision so two workers cannot meter two requests on one key.
        if exclusive and db.bind is not None and db.bind.dialect.name == "sqlite":
            db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        provider = db.scalar(
            select(ApiPoolProvider).where(ApiPoolProvider.code == provider_code).with_for_update()
        )
        if provider is None:
            return None
        if provider.status != "active" or not provider_supports_kind(provider, capability_kind):
            raise ApiPoolDispatchError(
                "PAID_CAPABILITY_API_POOL_UNAVAILABLE",
                "Configured API provider is disabled or incompatible",
            )
        if capability_kind == "image" and not normalize_image_api_base_url(
            provider.base_url
        ):
            raise ApiPoolDispatchError(
                "PAID_CAPABILITY_IMAGE_PROVIDER_FORBIDDEN",
                f"Image providers must use exactly {APPROVED_IMAGE_API_BASE_URL}",
            )
        if capability_kind in {"text", "image"}:
            model = db.scalar(
                select(ApiPoolModel.id).where(
                    ApiPoolModel.provider_id == provider.id,
                    ApiPoolModel.capability_kind == capability_kind,
                    ApiPoolModel.model_code == provider_model,
                    ApiPoolModel.status == "active",
                )
            )
            if model is None:
                raise ApiPoolDispatchError(
                    "PAID_CAPABILITY_API_POOL_MODEL_UNAVAILABLE",
                    "Configured API model is unavailable",
                )
        _expire_stale_leases(db, current)
        keys = list(
            db.scalars(
                select(ApiPoolKey).where(
                    ApiPoolKey.provider_id == provider.id,
                    ApiPoolKey.status == "active",
                    or_(
                        ApiPoolKey.cooldown_until.is_(None),
                        ApiPoolKey.cooldown_until <= current,
                    ),
                )
            ).all()
        )
        counts = _active_lease_counts(db, [item.id for item in keys], current)
        available = [
            item
            for item in keys
            if (
                counts.get(item.id, 0) == 0
                if exclusive
                else item.max_concurrency == 0 or counts.get(item.id, 0) < item.max_concurrency
            )
        ]
        if not available:
            raise ApiPoolDispatchError(
                "PAID_CAPABILITY_API_POOL_BUSY",
                "Every API key is busy, disabled, or cooling down",
            )
        available.sort(
            key=lambda item: (
                counts.get(item.id, 0) / item.weight,
                item.last_used_at.timestamp() if item.last_used_at else float("-inf"),
                item.id,
            )
        )
        key = available[0]
        try:
            secret = decrypt_api_secret(settings, key.secret_ciphertext)
        except ValueError as exc:
            key.status = "invalid"
            key.last_error_code = "API_POOL_KEY_DECRYPT_FAILED"
            db.commit()
            raise ApiPoolDispatchError(
                "PAID_CAPABILITY_API_POOL_KEY_INVALID",
                "API key cannot be decrypted",
            ) from exc
        lease_id = str(uuid4())
        db.add(
            ApiPoolLease(
                id=lease_id,
                key_id=key.id,
                status="active",
                acquired_at=current,
                expires_at=current + timedelta(seconds=provider.timeout_seconds + 30),
            )
        )
        key.request_count += 1
        key.last_used_at = current
        db.commit()
        return AcquiredApiCredential(
            provider_id=provider.id,
            provider_code=provider.code,
            key_id=key.id,
            lease_id=lease_id,
            connection=ApiPoolConnection(
                base_url=provider.base_url,
                api_key=secret,
                adapter=provider.adapter,
                auth_scheme=provider.auth_scheme,
                auth_header_name=provider.auth_header_name,
                timeout_seconds=provider.timeout_seconds,
                managed_by_api_pool=True,
            ),
        )


def release_api_credential(
    session_factory: sessionmaker[Session],
    acquired: AcquiredApiCredential,
    *,
    failure: PaidProviderFailure | None = None,
    now: datetime | None = None,
) -> None:
    current = (now or datetime.now(UTC)).astimezone(UTC)
    with session_factory() as db:
        lease = db.scalar(
            select(ApiPoolLease).where(ApiPoolLease.id == acquired.lease_id).with_for_update()
        )
        key = db.scalar(
            select(ApiPoolKey).where(ApiPoolKey.id == acquired.key_id).with_for_update()
        )
        if lease is None or key is None or lease.status != "active":
            return
        lease.status = "released"
        lease.released_at = current
        if failure is None:
            key.success_count += 1
            key.consecutive_failures = 0
            key.last_success_at = current
            key.last_error_code = None
            key.cooldown_until = None
        else:
            key.failure_count += 1
            key.consecutive_failures += 1
            key.last_failure_at = current
            key.last_error_code = failure.code
            if failure.upstream_status in {401, 403}:
                key.status = "invalid"
            elif failure.upstream_status == 429:
                key.cooldown_until = current + timedelta(seconds=failure.retry_after_seconds or 60)
            elif failure.code == "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN":
                key.cooldown_until = current + timedelta(seconds=30)
            elif key.consecutive_failures >= 3:
                key.cooldown_until = current + timedelta(seconds=120)
        db.commit()

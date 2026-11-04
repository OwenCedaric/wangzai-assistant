from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import ApiPoolKey, ApiPoolLease, ApiPoolModel, ApiPoolProvider, UsageLog
from app.schemas.api_pool import ApiPoolKeyRead, ApiPoolModelRead, ApiPoolProviderRead


def utc_now() -> datetime:
    return datetime.now(UTC)


def audit_api_pool(
    db: Session, admin_id: int, event: str, details: dict[str, object]
) -> None:
    db.add(UsageLog(user_id=admin_id, project_id=None, event=event, details=details))


def provider_read(db: Session, provider: ApiPoolProvider) -> ApiPoolProviderRead:
    current = utc_now()
    key_count = db.scalar(
        select(func.count(ApiPoolKey.id)).where(ApiPoolKey.provider_id == provider.id)
    ) or 0
    active_key_count = db.scalar(
        select(func.count(ApiPoolKey.id)).where(
            ApiPoolKey.provider_id == provider.id,
            ApiPoolKey.status == "active",
        )
    ) or 0
    model_count = db.scalar(
        select(func.count(ApiPoolModel.id)).where(ApiPoolModel.provider_id == provider.id)
    ) or 0
    active_lease_count = db.scalar(
        select(func.count(ApiPoolLease.id))
        .join(ApiPoolKey, ApiPoolKey.id == ApiPoolLease.key_id)
        .where(
            ApiPoolKey.provider_id == provider.id,
            ApiPoolLease.status == "active",
            ApiPoolLease.expires_at > current,
        )
    ) or 0
    return ApiPoolProviderRead(
        id=provider.id,
        code=provider.code,
        name=provider.name,
        adapter=provider.adapter,
        base_url=provider.base_url,
        auth_scheme=provider.auth_scheme,
        auth_header_name=provider.auth_header_name,
        capability_kinds=list(provider.capability_kinds or []),
        timeout_seconds=provider.timeout_seconds,
        priority=provider.priority,
        status=provider.status,
        key_count=key_count,
        active_key_count=active_key_count,
        model_count=model_count,
        active_lease_count=active_lease_count,
        created_at=provider.created_at,
        updated_at=provider.updated_at,
    )


def key_read(db: Session, key: ApiPoolKey) -> ApiPoolKeyRead:
    active_leases = db.scalar(
        select(func.count(ApiPoolLease.id)).where(
            ApiPoolLease.key_id == key.id,
            ApiPoolLease.status == "active",
            ApiPoolLease.expires_at > utc_now(),
        )
    ) or 0
    return ApiPoolKeyRead(
        id=key.id,
        provider_id=key.provider_id,
        label=key.label,
        masked_hint=key.masked_hint,
        weight=key.weight,
        max_concurrency=key.max_concurrency,
        status=key.status,
        active_leases=active_leases,
        cooldown_until=key.cooldown_until,
        last_used_at=key.last_used_at,
        last_success_at=key.last_success_at,
        last_failure_at=key.last_failure_at,
        success_count=key.success_count,
        failure_count=key.failure_count,
        request_count=key.request_count,
        consecutive_failures=key.consecutive_failures,
        last_error_code=key.last_error_code,
        created_at=key.created_at,
        updated_at=key.updated_at,
    )


def model_read(model: ApiPoolModel) -> ApiPoolModelRead:
    return ApiPoolModelRead.model_validate(
        {column.name: getattr(model, column.name) for column in model.__table__.columns}
    )


def provider_or_404(db: Session, provider_id: int) -> ApiPoolProvider:
    provider = db.get(ApiPoolProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="API provider not found")
    return provider

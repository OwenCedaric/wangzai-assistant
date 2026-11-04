from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import ApiPoolKey, ApiPoolLease, ApiPoolModel, ApiPoolProvider
from app.paid_capabilities.image_model_policy import image_provider_is_allowed


@dataclass(frozen=True, slots=True)
class _ProviderCapacity:
    provider: ApiPoolProvider
    ready_key_count: int
    active_lease_count: int
    request_pressure: float


def _active_lease_counts(
    db: Session,
    key_ids: list[int],
    current: datetime,
) -> dict[int, int]:
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
    return {int(key_id): int(count) for key_id, count in rows}


def _provider_capacities(
    db: Session,
    providers: list[ApiPoolProvider],
    *,
    capability_kind: str,
    current: datetime,
) -> list[_ProviderCapacity]:
    provider_ids = [item.id for item in providers]
    keys = list(
        db.scalars(
            select(ApiPoolKey).where(
                ApiPoolKey.provider_id.in_(provider_ids),
                ApiPoolKey.status == "active",
                or_(ApiPoolKey.cooldown_until.is_(None), ApiPoolKey.cooldown_until <= current),
            )
        ).all()
    )
    keys_by_provider: dict[int, list[ApiPoolKey]] = defaultdict(list)
    for key in keys:
        keys_by_provider[key.provider_id].append(key)
    leases = _active_lease_counts(db, [item.id for item in keys], current)

    capacities: list[_ProviderCapacity] = []
    for provider in providers:
        provider_keys = keys_by_provider.get(provider.id, [])
        exclusive = capability_kind == "text" and provider.code == "codesonline"
        ready_keys = [
            key
            for key in provider_keys
            if (
                leases.get(key.id, 0) == 0
                if exclusive
                else key.max_concurrency == 0
                or leases.get(key.id, 0) < key.max_concurrency
            )
        ]
        total_weight = sum(max(1, key.weight) for key in provider_keys) or 1
        capacities.append(
            _ProviderCapacity(
                provider=provider,
                ready_key_count=len(ready_keys),
                active_lease_count=sum(leases.get(key.id, 0) for key in provider_keys),
                request_pressure=(
                    sum(max(0, key.request_count) for key in provider_keys) / total_weight
                ),
            )
        )
    return capacities


def dispatch_provider_codes(
    db: Session,
    *,
    capability_kind: str,
    model_code: str,
    fallback_provider_code: str,
    now: datetime | None = None,
) -> tuple[str, ...]:
    """Return private provider candidates without ever returning credentials.

    Text providers with the same administrator priority are balanced by live
    lease pressure and historical request pressure. Lower-priority providers
    remain bounded failover candidates. Image routing intentionally keeps the
    original single-provider behavior because its publishing chain is frozen.
    """

    providers = list(
        db.scalars(
            select(ApiPoolProvider)
            .join(ApiPoolModel, ApiPoolModel.provider_id == ApiPoolProvider.id)
            .where(
                ApiPoolProvider.status == "active",
                ApiPoolModel.status == "active",
                ApiPoolModel.capability_kind == capability_kind,
                ApiPoolModel.model_code == model_code,
            )
            .order_by(ApiPoolProvider.priority, ApiPoolProvider.id)
        ).all()
    )
    if capability_kind == "image":
        providers = [
            provider
            for provider in providers
            if image_provider_is_allowed(provider.base_url, model_code)
        ]
    if not providers:
        return (fallback_provider_code,)
    if capability_kind != "text":
        return (providers[0].code,)

    capacities = _provider_capacities(
        db,
        providers,
        capability_kind=capability_kind,
        current=(now or datetime.now(UTC)).astimezone(UTC),
    )
    capacities.sort(
        key=lambda item: (
            item.provider.priority,
            0 if item.ready_key_count else 1,
            item.active_lease_count / max(1, item.ready_key_count),
            item.request_pressure,
            item.provider.id,
        )
    )
    return tuple(item.provider.code for item in capacities)


def dispatch_provider_code(
    db: Session,
    *,
    capability_kind: str,
    model_code: str,
    fallback_provider_code: str,
) -> str:
    return dispatch_provider_codes(
        db,
        capability_kind=capability_kind,
        model_code=model_code,
        fallback_provider_code=fallback_provider_code,
    )[0]

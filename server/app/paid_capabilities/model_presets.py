from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    ApiPoolKey,
    ApiPoolLease,
    ApiPoolModel,
    ApiPoolProvider,
    PaidCapabilityRateCard,
    UserModelPreset,
)
from app.models.base import as_utc
from app.paid_capabilities.image_model_policy import image_provider_is_allowed
from app.paid_capabilities.registry import (
    PaidCapabilityDescriptor,
    public_paid_capability_contracts,
)
from app.paid_capabilities.text_model_policy import DEFAULT_TEXT_MODEL
from app.schemas.model_presets import (
    ModelPresetCatalogRead,
    ModelPresetGroupRead,
    ModelPresetItemRead,
)

MODEL_KINDS = ("text", "image")
MODEL_KIND_LABELS = {"text": "文本模型", "image": "图片模型"}


class ModelPresetError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True, slots=True)
class ResolvedModelRoute:
    rate_card: PaidCapabilityRateCard
    model_code: str


def _current(value: datetime | None = None) -> datetime:
    return (value or datetime.now(UTC)).astimezone(UTC)


def _active_rates(db: Session, project_id: int, current: datetime) -> list[PaidCapabilityRateCard]:
    return list(
        db.scalars(
            select(PaidCapabilityRateCard).where(
                PaidCapabilityRateCard.project_id == project_id,
                PaidCapabilityRateCard.status == "active",
                PaidCapabilityRateCard.effective_from <= current,
                or_(
                    PaidCapabilityRateCard.effective_until.is_(None),
                    PaidCapabilityRateCard.effective_until > current,
                ),
            )
        ).all()
    )


def _active_lease_counts(db: Session, current: datetime) -> dict[int, int]:
    rows = db.execute(
        select(ApiPoolLease.key_id, func.count(ApiPoolLease.id))
        .where(
            ApiPoolLease.status == "active",
            ApiPoolLease.expires_at > current,
        )
        .group_by(ApiPoolLease.key_id)
    ).all()
    return {key_id: count for key_id, count in rows}


def _capability_counts() -> dict[str, int]:
    counts = {kind: 0 for kind in MODEL_KINDS}
    for descriptor in public_paid_capability_contracts():
        kind = descriptor["providerKind"]
        if kind in counts:
            counts[kind] += 1
    return counts


def _catalog_items(
    db: Session,
    *,
    project_id: int,
    current: datetime,
) -> dict[str, list[ModelPresetItemRead]]:
    rows = db.execute(
        select(ApiPoolModel, ApiPoolProvider)
        .join(ApiPoolProvider, ApiPoolProvider.id == ApiPoolModel.provider_id)
        .where(ApiPoolModel.capability_kind.in_(MODEL_KINDS))
        .order_by(ApiPoolModel.priority, ApiPoolModel.id)
    ).all()
    provider_ids = {provider.id for _model, provider in rows}
    keys = (
        list(db.scalars(select(ApiPoolKey).where(ApiPoolKey.provider_id.in_(provider_ids))).all())
        if provider_ids
        else []
    )
    keys_by_provider: dict[int, list[ApiPoolKey]] = defaultdict(list)
    for key in keys:
        keys_by_provider[key.provider_id].append(key)
    lease_counts = _active_lease_counts(db, current)
    rates = _active_rates(db, project_id, current)
    priced_capabilities: dict[tuple[str, str], set[str]] = defaultdict(set)
    contracts = public_paid_capability_contracts()
    kind_by_capability = {
        item["capability"]: item["providerKind"]
        for item in contracts
        if item["providerKind"] in MODEL_KINDS
    }
    for rate in rates:
        kind = kind_by_capability.get(rate.capability)
        if kind and rate.provider_model:
            priced_capabilities[(kind, rate.provider_model)].add(rate.capability)

    aggregate: dict[tuple[str, str], dict[str, object]] = {}
    for model, provider in rows:
        if model.capability_kind == "image" and not image_provider_is_allowed(
            provider.base_url, model.model_code
        ):
            continue
        key = (model.capability_kind, model.model_code)
        item = aggregate.setdefault(
            key,
            {
                "display_name": model.display_name,
                "priority": (model.priority, model.id),
                "configured": set(),
                "available": set(),
                "busy": set(),
                "cooling": set(),
                "model_active": False,
            },
        )
        if (model.priority, model.id) < item["priority"]:
            item["priority"] = (model.priority, model.id)
            item["display_name"] = model.display_name
        if provider.status != "active" or model.status != "active":
            continue
        item["model_active"] = True
        for api_key in keys_by_provider.get(provider.id, []):
            if api_key.status != "active":
                continue
            item["configured"].add(api_key.id)
            cooldown_until = as_utc(api_key.cooldown_until)
            if cooldown_until is not None and cooldown_until > current:
                item["cooling"].add(api_key.id)
                continue
            if (
                api_key.max_concurrency > 0
                and lease_counts.get(api_key.id, 0) >= api_key.max_concurrency
            ):
                item["busy"].add(api_key.id)
                continue
            item["available"].add(api_key.id)

    totals = _capability_counts()
    result: dict[str, list[ModelPresetItemRead]] = {kind: [] for kind in MODEL_KINDS}
    for (kind, model_code), item in aggregate.items():
        configured_count = len(item["configured"])
        available_count = len(item["available"])
        busy_count = len(item["busy"])
        cooling_count = len(item["cooling"])
        priced_count = len(priced_capabilities.get((kind, model_code), set()))
        if available_count:
            api_status = "available"
        elif busy_count:
            api_status = "busy"
        elif cooling_count:
            api_status = "cooling"
        else:
            api_status = "unavailable"
        can_enable = bool(item["model_active"] and configured_count and priced_count)
        reason = None
        if not item["model_active"]:
            reason = "模型或 API 服务已停用"
        elif not configured_count:
            reason = "没有可用 API Key"
        elif not priced_count:
            reason = "管理后台尚未配置该模型的积分价格"
        result[kind].append(
            ModelPresetItemRead(
                model_code=model_code,
                display_name=str(item["display_name"]),
                capability_kind=kind,
                api_status=api_status,
                configured_api_count=configured_count,
                available_api_count=available_count,
                busy_api_count=busy_count,
                cooling_api_count=cooling_count,
                priced_capability_count=priced_count,
                total_capability_count=totals[kind],
                can_enable=can_enable,
                unavailable_reason=reason,
            )
        )
    for kind in MODEL_KINDS:
        result[kind].sort(
            key=lambda item: (
                not item.can_enable,
                item.api_status != "available",
                item.display_name.lower(),
                item.model_code,
            )
        )
    return result


def _preset_rows(db: Session, *, user_id: int, project_id: int) -> dict[str, UserModelPreset]:
    rows = db.scalars(
        select(UserModelPreset).where(
            UserModelPreset.user_id == user_id,
            UserModelPreset.project_id == project_id,
            UserModelPreset.capability_kind.in_(MODEL_KINDS),
        )
    ).all()
    return {item.capability_kind: item for item in rows}


def build_model_preset_catalog(
    db: Session,
    *,
    user_id: int,
    project_id: int,
    project_code: str,
    now: datetime | None = None,
) -> ModelPresetCatalogRead:
    current = _current(now)
    items_by_kind = _catalog_items(db, project_id=project_id, current=current)
    presets = _preset_rows(db, user_id=user_id, project_id=project_id)
    groups: list[ModelPresetGroupRead] = []
    for kind in MODEL_KINDS:
        models = items_by_kind[kind]
        selectable = [item.model_code for item in models if item.can_enable]
        preset = presets.get(kind)
        if preset is None:
            enabled = selectable
            default_model = (
                DEFAULT_TEXT_MODEL
                if kind == "text" and DEFAULT_TEXT_MODEL in enabled
                else (enabled[0] if enabled else "")
            )
            updated_at = None
        else:
            enabled = [code for code in preset.enabled_models if code in selectable]
            if kind == "text" and not enabled:
                enabled = selectable
            default_model = (
                preset.default_model
                if preset.default_model in enabled
                else (
                    DEFAULT_TEXT_MODEL
                    if kind == "text" and DEFAULT_TEXT_MODEL in enabled
                    else (enabled[0] if enabled else "")
                )
            )
            updated_at = preset.updated_at
        groups.append(
            ModelPresetGroupRead(
                capability_kind=kind,
                label=MODEL_KIND_LABELS[kind],
                enabled_models=enabled,
                default_model=default_model,
                models=models,
                updated_at=updated_at,
            )
        )
    return ModelPresetCatalogRead(project_code=project_code, groups=groups)


def save_model_presets(
    db: Session,
    *,
    user_id: int,
    project_id: int,
    project_code: str,
    groups: list[object],
    now: datetime | None = None,
) -> ModelPresetCatalogRead:
    catalog = build_model_preset_catalog(
        db,
        user_id=user_id,
        project_id=project_id,
        project_code=project_code,
        now=now,
    )
    available = {
        group.capability_kind: {item.model_code for item in group.models if item.can_enable}
        for group in catalog.groups
    }
    existing = _preset_rows(db, user_id=user_id, project_id=project_id)
    for group in groups:
        kind = group.capability_kind
        requested = list(group.enabled_models)
        invalid = [code for code in requested if code not in available[kind]]
        if invalid:
            raise ModelPresetError(
                "MODEL_PRESET_MODEL_UNAVAILABLE",
                f"模型 {invalid[0]} 暂不可启用，请先检查 API Key 和积分价格",
            )
        row = existing.get(kind)
        if row is None:
            row = UserModelPreset(
                user_id=user_id,
                project_id=project_id,
                capability_kind=kind,
                enabled_models=requested,
                default_model=group.default_model,
            )
            db.add(row)
        else:
            row.enabled_models = requested
            row.default_model = group.default_model
    db.flush()
    return build_model_preset_catalog(
        db,
        user_id=user_id,
        project_id=project_id,
        project_code=project_code,
        now=now,
    )


def resolve_model_rate_card(
    db: Session,
    *,
    user_id: int,
    project_id: int,
    descriptor: PaidCapabilityDescriptor,
    requested_model: str | None,
    now: datetime,
) -> ResolvedModelRoute | None:
    if descriptor.provider_kind not in MODEL_KINDS:
        return None
    catalog = build_model_preset_catalog(
        db,
        user_id=user_id,
        project_id=project_id,
        project_code="internal",
        now=now,
    )
    group = next(
        item for item in catalog.groups if item.capability_kind == descriptor.provider_kind
    )
    model_status = {item.model_code: item for item in group.models}
    if requested_model:
        candidates = [requested_model]
        if requested_model not in group.enabled_models:
            raise ModelPresetError(
                "MODEL_PRESET_MODEL_NOT_ENABLED",
                "所选模型未在当前账号的模型预设中启用",
            )
    else:
        candidates = [group.default_model, *group.enabled_models]
    seen: set[str] = set()
    for model_code in candidates:
        if not model_code or model_code in seen:
            continue
        seen.add(model_code)
        item = model_status.get(model_code)
        if item is None or not item.can_enable:
            continue
        rate = db.scalar(
            select(PaidCapabilityRateCard)
            .where(
                PaidCapabilityRateCard.project_id == project_id,
                PaidCapabilityRateCard.capability == descriptor.capability,
                PaidCapabilityRateCard.version == descriptor.version,
                PaidCapabilityRateCard.provider_model == model_code,
                PaidCapabilityRateCard.status == "active",
                PaidCapabilityRateCard.effective_from <= now,
                or_(
                    PaidCapabilityRateCard.effective_until.is_(None),
                    PaidCapabilityRateCard.effective_until > now,
                ),
            )
            .order_by(
                PaidCapabilityRateCard.effective_from.desc(),
                PaidCapabilityRateCard.id.desc(),
            )
        )
        if rate is not None:
            return ResolvedModelRoute(rate_card=rate, model_code=model_code)
    if requested_model:
        raise ModelPresetError(
            "MODEL_PRESET_RATE_UNAVAILABLE",
            "所选模型没有当前功能的有效积分价格",
            503,
        )
    return None

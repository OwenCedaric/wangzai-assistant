from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.admin_api_pool_helpers import (
    audit_api_pool as _audit,
)
from app.api.admin_api_pool_helpers import (
    key_read as _key_read,
)
from app.api.admin_api_pool_helpers import (
    model_read as _model_read,
)
from app.api.admin_api_pool_helpers import (
    provider_or_404 as _provider_or_404,
)
from app.api.admin_api_pool_helpers import (
    provider_read as _provider_read,
)
from app.api.admin_api_pool_helpers import (
    utc_now as _now,
)
from app.auth.dependencies import require_admin
from app.database.session import get_db
from app.models import (
    ApiPoolKey,
    ApiPoolLease,
    ApiPoolModel,
    ApiPoolProvider,
    PaidCapabilityRateCard,
    User,
)
from app.paid_capabilities.api_pool_crypto import (
    ApiPoolSecretError,
    api_secret_fingerprint,
    decrypt_api_secret,
    encrypt_api_secret,
    masked_api_secret,
)
from app.paid_capabilities.api_pool_discovery import (
    ApiPoolDiscoveryError,
    auto_connect_discovered_api,
    discover_openai_compatible_api,
)
from app.paid_capabilities.api_pool_service import (
    ApiPoolConfigurationError,
    normalize_provider_code,
    provider_supports_kind,
    validate_provider_configuration,
)
from app.paid_capabilities.image_model_policy import image_model_is_allowed
from app.paid_capabilities.providers import (
    ApiPoolConnection,
    PaidProviderFailure,
    read_provider_cost_snapshot,
)
from app.paid_capabilities.text_model_policy import text_model_is_allowed
from app.schemas.api_pool import (
    ApiPoolAutoConnectRead,
    ApiPoolAutoConnectRequest,
    ApiPoolKeyCreate,
    ApiPoolKeyRead,
    ApiPoolKeyRotate,
    ApiPoolKeyUpdate,
    ApiPoolModelCreate,
    ApiPoolModelRead,
    ApiPoolModelUpdate,
    ApiPoolProviderCreate,
    ApiPoolProviderEndpointUpdate,
    ApiPoolProviderRead,
    ApiPoolProviderUpdate,
    ApiPoolSummaryRead,
)

router = APIRouter(
    prefix="/admin/api-pool",
    tags=["admin-api-pool"],
    dependencies=[Depends(require_admin)],
)


@router.post("/auto-connect", response_model=ApiPoolAutoConnectRead, status_code=201)
def auto_connect_api(
    payload: ApiPoolAutoConnectRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ApiPoolAutoConnectRead:
    settings = request.app.state.settings
    api_key = payload.api_key.get_secret_value()
    injected_client = getattr(request.app.state, "api_pool_discovery_client", None)
    try:
        if injected_client is None:
            with httpx.Client(timeout=10, follow_redirects=False) as discovery_client:
                discovered = discover_openai_compatible_api(
                    settings,
                    discovery_client,
                    raw_url=payload.base_url,
                    api_key=api_key,
                )
        else:
            discovered = discover_openai_compatible_api(
                settings,
                injected_client,
                raw_url=payload.base_url,
                api_key=api_key,
            )
        connected = auto_connect_discovered_api(
            db,
            settings,
            discovered=discovered,
            api_key=api_key,
        )
    except (ApiPoolDiscoveryError, ApiPoolSecretError) as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="API 配置已存在，请刷新后重试") from exc
    _audit(
        db,
        admin.id,
        "admin.api_pool.auto_connected",
        {
            "provider_id": connected.provider.id,
            "key_id": connected.key.id,
            "provider_created": connected.provider_created,
            "key_created": connected.key_created,
            "model_count": len(connected.models),
        },
    )
    db.commit()
    return ApiPoolAutoConnectRead(
        provider=_provider_read(db, connected.provider),
        key=_key_read(db, connected.key),
        models=[_model_read(item) for item in connected.models],
        provider_created=connected.provider_created,
        key_created=connected.key_created,
        normalized_base_url=connected.provider.base_url,
        discovered_model_count=len(connected.models),
    )


@router.get("/summary", response_model=ApiPoolSummaryRead)
def api_pool_summary(db: Session = Depends(get_db)) -> ApiPoolSummaryRead:
    current = _now()
    return ApiPoolSummaryRead(
        provider_count=db.scalar(select(func.count(ApiPoolProvider.id))) or 0,
        active_provider_count=db.scalar(
            select(func.count(ApiPoolProvider.id)).where(ApiPoolProvider.status == "active")
        )
        or 0,
        key_count=db.scalar(select(func.count(ApiPoolKey.id))) or 0,
        available_key_count=db.scalar(
            select(func.count(ApiPoolKey.id)).where(
                ApiPoolKey.status == "active",
                (ApiPoolKey.cooldown_until.is_(None) | (ApiPoolKey.cooldown_until <= current)),
            )
        )
        or 0,
        cooling_key_count=db.scalar(
            select(func.count(ApiPoolKey.id)).where(
                ApiPoolKey.status == "active", ApiPoolKey.cooldown_until > current
            )
        )
        or 0,
        invalid_key_count=db.scalar(
            select(func.count(ApiPoolKey.id)).where(ApiPoolKey.status == "invalid")
        )
        or 0,
        model_count=db.scalar(select(func.count(ApiPoolModel.id))) or 0,
        active_lease_count=db.scalar(
            select(func.count(ApiPoolLease.id)).where(
                ApiPoolLease.status == "active", ApiPoolLease.expires_at > current
            )
        )
        or 0,
    )


@router.get("/providers", response_model=list[ApiPoolProviderRead])
def list_providers(db: Session = Depends(get_db)) -> list[ApiPoolProviderRead]:
    providers = db.scalars(
        select(ApiPoolProvider).order_by(
            ApiPoolProvider.priority, ApiPoolProvider.created_at, ApiPoolProvider.id
        )
    ).all()
    return [_provider_read(db, item) for item in providers]


@router.post("/providers", response_model=ApiPoolProviderRead, status_code=201)
def create_provider(
    payload: ApiPoolProviderCreate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ApiPoolProviderRead:
    try:
        code = normalize_provider_code(payload.code)
        base_url, kinds = validate_provider_configuration(
            request.app.state.settings,
            adapter=payload.adapter,
            base_url=payload.base_url,
            auth_scheme=payload.auth_scheme,
            auth_header_name=payload.auth_header_name,
            capability_kinds=list(payload.capability_kinds),
        )
    except ApiPoolConfigurationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    provider = ApiPoolProvider(
        code=code,
        name=payload.name.strip(),
        adapter=payload.adapter,
        base_url=base_url,
        auth_scheme=payload.auth_scheme,
        auth_header_name=payload.auth_header_name,
        capability_kinds=kinds,
        timeout_seconds=payload.timeout_seconds,
        priority=payload.priority,
        status="active",
    )
    db.add(provider)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="API provider code already exists") from exc
    _audit(db, admin.id, "api_pool_provider_created", {"provider_id": provider.id})
    db.commit()
    db.refresh(provider)
    return _provider_read(db, provider)


@router.put("/providers/{provider_id}", response_model=ApiPoolProviderRead)
def update_provider(
    provider_id: int,
    payload: ApiPoolProviderUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ApiPoolProviderRead:
    provider = _provider_or_404(db, provider_id)
    try:
        base_url, kinds = validate_provider_configuration(
            request.app.state.settings,
            adapter=payload.adapter,
            base_url=payload.base_url,
            auth_scheme=payload.auth_scheme,
            auth_header_name=payload.auth_header_name,
            capability_kinds=list(payload.capability_kinds),
        )
    except ApiPoolConfigurationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    for model in db.scalars(
        select(ApiPoolModel).where(
            ApiPoolModel.provider_id == provider.id, ApiPoolModel.status == "active"
        )
    ):
        if model.capability_kind not in kinds:
            raise HTTPException(
                status_code=409,
                detail="Disable incompatible models before removing a capability type",
            )
    provider.name = payload.name.strip()
    provider.adapter = payload.adapter
    provider.base_url = base_url
    provider.auth_scheme = payload.auth_scheme
    provider.auth_header_name = payload.auth_header_name
    provider.capability_kinds = kinds
    provider.timeout_seconds = payload.timeout_seconds
    provider.priority = payload.priority
    provider.status = payload.status
    _audit(db, admin.id, "api_pool_provider_updated", {"provider_id": provider.id})
    db.commit()
    db.refresh(provider)
    return _provider_read(db, provider)


@router.put("/providers/{provider_id}/endpoint", response_model=ApiPoolProviderRead)
def replace_provider_endpoint(
    provider_id: int,
    payload: ApiPoolProviderEndpointUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ApiPoolProviderRead:
    provider = _provider_or_404(db, provider_id)
    if provider.adapter != "openai-compatible":
        raise HTTPException(status_code=409, detail="当前接口类型不支持自动验证地址")

    keys = list(
        db.scalars(
            select(ApiPoolKey)
            .where(
                ApiPoolKey.provider_id == provider.id,
                ApiPoolKey.status == "active",
            )
            .order_by(ApiPoolKey.id)
        ).all()
    )
    if not keys:
        raise HTTPException(status_code=409, detail="请先为这个接口配置一个可用的 API Key")

    settings = request.app.state.settings
    injected_client = getattr(request.app.state, "api_pool_discovery_client", None)
    discovered = None
    verified_api_key = ""
    last_error: Exception | None = None
    for key in keys:
        try:
            api_key = decrypt_api_secret(settings, key.secret_ciphertext)
            if injected_client is None:
                with httpx.Client(timeout=10, follow_redirects=False) as discovery_client:
                    discovered = discover_openai_compatible_api(
                        settings,
                        discovery_client,
                        raw_url=payload.base_url,
                        api_key=api_key,
                    )
            else:
                discovered = discover_openai_compatible_api(
                    settings,
                    injected_client,
                    raw_url=payload.base_url,
                    api_key=api_key,
                )
            verified_api_key = api_key
            break
        except (ApiPoolDiscoveryError, ApiPoolSecretError) as exc:
            last_error = exc
    if discovered is None:
        raise HTTPException(
            status_code=422,
            detail=str(last_error or "新地址验证失败"),
        )

    active_models = {
        item.model_code
        for item in db.scalars(
            select(ApiPoolModel).where(
                ApiPoolModel.provider_id == provider.id,
                ApiPoolModel.status == "active",
            )
        ).all()
    }
    missing_models = sorted(active_models.difference(discovered.model_codes))
    if missing_models:
        preview = "、".join(missing_models[:3])
        suffix = "等" if len(missing_models) > 3 else ""
        raise HTTPException(
            status_code=409,
            detail=f"新地址缺少当前正在使用的模型：{preview}{suffix}",
        )

    if provider.code == "codesonline" and "text" in set(provider.capability_kinds or []):
        pricing_client = injected_client
        owned_pricing_client = pricing_client is None
        if pricing_client is None:
            pricing_client = httpx.Client(timeout=10, follow_redirects=False)
        try:
            read_provider_cost_snapshot(
                pricing_client,
                ApiPoolConnection(
                    base_url=discovered.base_url,
                    api_key=verified_api_key,
                    adapter=provider.adapter,
                    auth_scheme=provider.auth_scheme,
                    auth_header_name=provider.auth_header_name,
                    timeout_seconds=min(provider.timeout_seconds, 30),
                    managed_by_api_pool=True,
                ),
            )
        except PaidProviderFailure as exc:
            raise HTTPException(
                status_code=422,
                detail="新地址可以读取模型，但计费状态接口不可用，未执行切换",
            ) from exc
        finally:
            if owned_pricing_client:
                pricing_client.close()

    previous_base_url = provider.base_url
    provider.base_url = discovered.base_url
    for key in keys:
        key.cooldown_until = None
        key.consecutive_failures = 0
        key.last_error_code = None
    _audit(
        db,
        admin.id,
        "admin.api_pool.provider_endpoint_replaced",
        {
            "provider_id": provider.id,
            "provider_code": provider.code,
            "previous_base_url": previous_base_url,
            "base_url": provider.base_url,
            "verified_model_count": len(discovered.model_codes),
        },
    )
    db.commit()
    db.refresh(provider)
    return _provider_read(db, provider)


@router.delete("/providers/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_provider(
    provider_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    provider = _provider_or_404(db, provider_id)
    active_rate = db.scalar(
        select(PaidCapabilityRateCard.id).where(
            PaidCapabilityRateCard.provider_code == provider.code,
            PaidCapabilityRateCard.status == "active",
        )
    )
    if active_rate is not None:
        raise HTTPException(status_code=409, detail="Disable active rate cards before deletion")
    _audit(db, admin.id, "api_pool_provider_deleted", {"provider_id": provider.id})
    db.delete(provider)
    db.commit()


@router.get("/providers/{provider_id}/keys", response_model=list[ApiPoolKeyRead])
def list_keys(provider_id: int, db: Session = Depends(get_db)) -> list[ApiPoolKeyRead]:
    _provider_or_404(db, provider_id)
    keys = db.scalars(
        select(ApiPoolKey)
        .where(ApiPoolKey.provider_id == provider_id)
        .order_by(ApiPoolKey.created_at, ApiPoolKey.id)
    ).all()
    return [_key_read(db, item) for item in keys]


@router.post("/providers/{provider_id}/keys", response_model=ApiPoolKeyRead, status_code=201)
def create_key(
    provider_id: int,
    payload: ApiPoolKeyCreate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ApiPoolKeyRead:
    _provider_or_404(db, provider_id)
    secret = payload.secret.get_secret_value()
    try:
        key = ApiPoolKey(
            provider_id=provider_id,
            label=payload.label.strip(),
            secret_ciphertext=encrypt_api_secret(request.app.state.settings, secret),
            secret_fingerprint=api_secret_fingerprint(request.app.state.settings, secret),
            masked_hint=masked_api_secret(secret),
            weight=payload.weight,
            max_concurrency=payload.max_concurrency,
            status="active",
        )
    except ApiPoolSecretError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    db.add(key)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="This API key already exists") from exc
    _audit(db, admin.id, "api_pool_key_created", {"provider_id": provider_id, "key_id": key.id})
    db.commit()
    db.refresh(key)
    return _key_read(db, key)


@router.put("/keys/{key_id}", response_model=ApiPoolKeyRead)
def update_key(
    key_id: int,
    payload: ApiPoolKeyUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ApiPoolKeyRead:
    key = db.get(ApiPoolKey, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    key.label = payload.label.strip()
    key.weight = payload.weight
    key.max_concurrency = payload.max_concurrency
    key.status = payload.status
    if payload.status == "active":
        key.cooldown_until = None
        key.consecutive_failures = 0
        key.last_error_code = None
    _audit(db, admin.id, "api_pool_key_updated", {"provider_id": key.provider_id, "key_id": key.id})
    db.commit()
    db.refresh(key)
    return _key_read(db, key)


@router.post("/keys/{key_id}/rotate", response_model=ApiPoolKeyRead)
def rotate_key(
    key_id: int,
    payload: ApiPoolKeyRotate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ApiPoolKeyRead:
    key = db.get(ApiPoolKey, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    secret = payload.secret.get_secret_value()
    try:
        key.secret_ciphertext = encrypt_api_secret(request.app.state.settings, secret)
        key.secret_fingerprint = api_secret_fingerprint(request.app.state.settings, secret)
        key.masked_hint = masked_api_secret(secret)
    except ApiPoolSecretError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    key.status = "active"
    key.cooldown_until = None
    key.consecutive_failures = 0
    key.last_error_code = None
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="This API key already exists") from exc
    _audit(db, admin.id, "api_pool_key_rotated", {"provider_id": key.provider_id, "key_id": key.id})
    db.commit()
    db.refresh(key)
    return _key_read(db, key)


@router.delete("/keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_key(
    key_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    key = db.get(ApiPoolKey, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    active = db.scalar(
        select(ApiPoolLease.id).where(
            ApiPoolLease.key_id == key.id,
            ApiPoolLease.status == "active",
            ApiPoolLease.expires_at > _now(),
        )
    )
    if active is not None:
        raise HTTPException(status_code=409, detail="API key is currently in use")
    _audit(db, admin.id, "api_pool_key_deleted", {"provider_id": key.provider_id, "key_id": key.id})
    db.delete(key)
    db.commit()


@router.get("/providers/{provider_id}/models", response_model=list[ApiPoolModelRead])
def list_models(provider_id: int, db: Session = Depends(get_db)) -> list[ApiPoolModelRead]:
    _provider_or_404(db, provider_id)
    models = db.scalars(
        select(ApiPoolModel)
        .where(ApiPoolModel.provider_id == provider_id)
        .order_by(ApiPoolModel.priority, ApiPoolModel.created_at, ApiPoolModel.id)
    ).all()
    return [_model_read(item) for item in models]


@router.post("/providers/{provider_id}/models", response_model=ApiPoolModelRead, status_code=201)
def create_model(
    provider_id: int,
    payload: ApiPoolModelCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ApiPoolModelRead:
    provider = _provider_or_404(db, provider_id)
    if not provider_supports_kind(provider, payload.capability_kind):
        raise HTTPException(status_code=422, detail="Provider does not support this model type")
    if payload.capability_kind == "text" and not text_model_is_allowed(payload.model_code):
        raise HTTPException(status_code=422, detail="Text model is blocked by server policy")
    if payload.capability_kind == "image" and not image_model_is_allowed(payload.model_code):
        raise HTTPException(status_code=422, detail="Image model is blocked by server policy")
    model = ApiPoolModel(
        provider_id=provider.id,
        capability_kind=payload.capability_kind,
        model_code=payload.model_code.strip(),
        display_name=payload.display_name.strip(),
        priority=payload.priority,
        status="active",
    )
    db.add(model)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="API model already exists") from exc
    _audit(
        db,
        admin.id,
        "api_pool_model_created",
        {"provider_id": provider.id, "model_id": model.id},
    )
    db.commit()
    db.refresh(model)
    return _model_read(model)


@router.put("/models/{model_id}", response_model=ApiPoolModelRead)
def update_model(
    model_id: int,
    payload: ApiPoolModelUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ApiPoolModelRead:
    model = db.get(ApiPoolModel, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="API model not found")
    if (
        model.capability_kind == "text"
        and payload.status == "active"
        and not text_model_is_allowed(model.model_code)
    ):
        raise HTTPException(status_code=422, detail="Text model is blocked by server policy")
    if (
        model.capability_kind == "image"
        and payload.status == "active"
        and not image_model_is_allowed(model.model_code)
    ):
        raise HTTPException(status_code=422, detail="Image model is blocked by server policy")
    model.display_name = payload.display_name.strip()
    model.priority = payload.priority
    model.status = payload.status
    _audit(
        db,
        admin.id,
        "api_pool_model_updated",
        {"provider_id": model.provider_id, "model_id": model.id},
    )
    db.commit()
    db.refresh(model)
    return _model_read(model)


@router.delete("/models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(
    model_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    model = db.get(ApiPoolModel, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="API model not found")
    provider = _provider_or_404(db, model.provider_id)
    active_rate = db.scalar(
        select(PaidCapabilityRateCard.id).where(
            PaidCapabilityRateCard.provider_code == provider.code,
            PaidCapabilityRateCard.provider_model == model.model_code,
            PaidCapabilityRateCard.status == "active",
        )
    )
    if active_rate is not None:
        raise HTTPException(status_code=409, detail="Disable active rate cards before deletion")
    _audit(
        db,
        admin.id,
        "api_pool_model_deleted",
        {"provider_id": model.provider_id, "model_id": model.id},
    )
    db.delete(model)
    db.commit()

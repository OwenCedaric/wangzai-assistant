from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import ApiPoolKey, ApiPoolModel, ApiPoolProvider
from app.paid_capabilities.api_pool_crypto import (
    api_secret_fingerprint,
    encrypt_api_secret,
    masked_api_secret,
    normalize_api_secret,
)
from app.paid_capabilities.text_model_policy import text_model_is_allowed

_BROWSER_PATHS = frozenset({"admin", "account", "console", "dashboard", "key", "keys"})
_IMAGE_MODEL_MARKERS = (
    "dall-e",
    "flux",
    "gpt-image",
    "ideogram",
    "image-1",
    "image-2",
    "imagen",
    "midjourney",
    "recraft",
    "seedream",
)
_CODE_RE = re.compile(r"[^a-z0-9]+")


class ApiPoolDiscoveryError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class DiscoveredApi:
    base_url: str
    model_codes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AutoConnectedApi:
    provider: ApiPoolProvider
    key: ApiPoolKey
    models: tuple[ApiPoolModel, ...]
    provider_created: bool
    key_created: bool


def _origin(parsed) -> str:
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")


def api_base_candidates(raw_url: str) -> tuple[str, ...]:
    value = raw_url.strip()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ApiPoolDiscoveryError("接口网址格式不正确") from exc
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or port not in {None, 443}
    ):
        raise ApiPoolDiscoveryError("只允许填写不含账号、参数的 HTTPS 接口网址")
    path = parsed.path.rstrip("/")
    origin = _origin(parsed)
    candidates: list[str]
    if path.rsplit("/", 1)[-1].lower() in _BROWSER_PATHS:
        candidates = [f"{origin}/v1", origin]
    elif not path:
        candidates = [f"{origin}/v1", origin]
    elif path.lower().endswith("/v1"):
        candidates = [f"{origin}{path}"]
    else:
        candidates = [f"{origin}{path}", f"{origin}/v1", origin]
    return tuple(dict.fromkeys(item.rstrip("/") for item in candidates))


def _is_public_host(host: str) -> bool:
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return address.is_global


def _validate_discovery_target(settings: Settings, base_url: str) -> None:
    host = (urlsplit(base_url).hostname or "").lower()
    if host in settings.paid_provider_allowed_host_set:
        return
    if not _is_public_host(host) or "." not in host or host.endswith(".arpa"):
        raise ApiPoolDiscoveryError("接口网址不能指向本机或内网地址")


def _model_codes(payload: object) -> tuple[str, ...]:
    if not isinstance(payload, dict):
        return ()
    rows = payload.get("data")
    if not isinstance(rows, list):
        rows = payload.get("models")
    if not isinstance(rows, list):
        return ()
    values: list[str] = []
    for row in rows[:500]:
        code = row.get("id") if isinstance(row, dict) else row
        if isinstance(code, str) and 0 < len(code.strip()) <= 160:
            values.append(code.strip())
    return tuple(dict.fromkeys(values))


def discover_openai_compatible_api(
    settings: Settings,
    client: httpx.Client,
    *,
    raw_url: str,
    api_key: str,
) -> DiscoveredApi:
    secret = normalize_api_secret(api_key)
    last_status: int | None = None
    for base_url in api_base_candidates(raw_url):
        _validate_discovery_target(settings, base_url)
        try:
            response = client.get(
                f"{base_url}/models",
                headers={"Authorization": f"Bearer {secret}", "Accept": "application/json"},
            )
        except (httpx.TimeoutException, httpx.NetworkError):
            continue
        last_status = response.status_code
        if response.status_code in {401, 403}:
            raise ApiPoolDiscoveryError("API Key 验证失败，请检查 Key 是否正确或是否有模型权限")
        if response.status_code == 429:
            raise ApiPoolDiscoveryError("接口当前限流，请稍后重新接入")
        if response.status_code >= 500:
            continue
        if response.status_code != 200:
            continue
        try:
            models = _model_codes(response.json())
        except ValueError:
            models = ()
        if models:
            return DiscoveredApi(base_url=base_url, model_codes=models)
    if last_status is None:
        raise ApiPoolDiscoveryError("无法连接接口，请检查网址或中转站状态")
    raise ApiPoolDiscoveryError("没有识别到 OpenAI 兼容的模型接口，请填写中转站提供的 API 地址")


def model_capability_kind(model_code: str) -> str:
    lowered = model_code.lower()
    return "image" if any(marker in lowered for marker in _IMAGE_MODEL_MARKERS) else "text"


def _provider_code(host: str) -> str:
    labels = [item for item in host.split(".") if item and item not in {"api", "free", "mx", "www"}]
    stem = labels[-2] if len(labels) >= 2 else labels[0]
    code = _CODE_RE.sub("-", stem.lower()).strip("-")
    return (code or "api-provider")[:52]


def _unique_provider_code(db: Session, host: str) -> str:
    root = _provider_code(host)
    if db.scalar(select(ApiPoolProvider.id).where(ApiPoolProvider.code == root)) is None:
        return root
    for index in range(2, 10_000):
        candidate = f"{root}-{index}"
        if db.scalar(select(ApiPoolProvider.id).where(ApiPoolProvider.code == candidate)) is None:
            return candidate
    raise ApiPoolDiscoveryError("供应商代码空间已满")


def _find_provider(db: Session, base_url: str) -> ApiPoolProvider | None:
    exact = db.scalar(select(ApiPoolProvider).where(ApiPoolProvider.base_url == base_url))
    if exact is not None:
        return exact
    host = (urlsplit(base_url).hostname or "").lower()
    matches = [
        item
        for item in db.scalars(select(ApiPoolProvider)).all()
        if (urlsplit(item.base_url).hostname or "").lower() == host
    ]
    return matches[0] if len(matches) == 1 else None


def auto_connect_discovered_api(
    db: Session,
    settings: Settings,
    *,
    discovered: DiscoveredApi,
    api_key: str,
) -> AutoConnectedApi:
    secret = normalize_api_secret(api_key)
    host = (urlsplit(discovered.base_url).hostname or "").lower()
    capabilities = sorted({model_capability_kind(code) for code in discovered.model_codes})
    provider = _find_provider(db, discovered.base_url)
    provider_created = provider is None
    if provider is None:
        provider = ApiPoolProvider(
            code=_unique_provider_code(db, host),
            name=f"{host} API",
            adapter="openai-compatible",
            base_url=discovered.base_url,
            auth_scheme="bearer",
            auth_header_name="Authorization",
            capability_kinds=capabilities,
            timeout_seconds=150,
            priority=100,
            status="active",
        )
        db.add(provider)
        db.flush()
    else:
        provider.adapter = "openai-compatible"
        provider.base_url = discovered.base_url
        provider.auth_scheme = "bearer"
        provider.auth_header_name = "Authorization"
        provider.capability_kinds = sorted(set(provider.capability_kinds or []).union(capabilities))
        provider.status = "active"

    fingerprint = api_secret_fingerprint(settings, secret)
    key = db.scalar(
        select(ApiPoolKey).where(
            ApiPoolKey.provider_id == provider.id,
            ApiPoolKey.secret_fingerprint == fingerprint,
        )
    )
    key_created = key is None
    if key is None:
        key_count = (
            db.scalar(
                select(func.count(ApiPoolKey.id)).where(ApiPoolKey.provider_id == provider.id)
            )
            or 0
        )
        key = ApiPoolKey(
            provider_id=provider.id,
            label=f"API Key {key_count + 1}",
            secret_ciphertext=encrypt_api_secret(settings, secret),
            secret_fingerprint=fingerprint,
            masked_hint=masked_api_secret(secret),
            weight=100,
            max_concurrency=0,
            status="active",
        )
        db.add(key)
    else:
        key.status = "active"

    existing = {
        (item.capability_kind, item.model_code): item
        for item in db.scalars(
            select(ApiPoolModel).where(ApiPoolModel.provider_id == provider.id)
        ).all()
    }
    for index, code in enumerate(discovered.model_codes, start=1):
        kind = model_capability_kind(code)
        model_status = "active" if kind != "text" or text_model_is_allowed(code) else "disabled"
        model = existing.get((kind, code))
        if model is None:
            model = ApiPoolModel(
                provider_id=provider.id,
                capability_kind=kind,
                model_code=code,
                display_name=code,
                priority=100 + index,
                status=model_status,
            )
            db.add(model)
            existing[(kind, code)] = model
        else:
            model.status = model_status
    db.flush()
    models = tuple(
        db.scalars(
            select(ApiPoolModel)
            .where(ApiPoolModel.provider_id == provider.id)
            .order_by(ApiPoolModel.priority, ApiPoolModel.id)
        ).all()
    )
    return AutoConnectedApi(
        provider=provider,
        key=key,
        models=models,
        provider_created=provider_created,
        key_created=key_created,
    )

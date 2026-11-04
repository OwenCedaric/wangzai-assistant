from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import httpx

from app.schemas.core_v2 import ModelApiDiscoveryRequest
from app.paid_capabilities.image_model_policy import APPROVED_IMAGE_API_HOST

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_MODELS = 100
PRIVATE_HOSTNAMES = {"localhost", "localhost.localdomain"}


class ModelApiDiscoveryFailure(Exception):
    def __init__(self, code: str, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _text(value: Any) -> str:
    return str(value or "").strip()


def _parse_website_url(value: str) -> tuple[str, str, str]:
    raw = _text(value)
    if not raw:
        raise ModelApiDiscoveryFailure(
            "MODEL_API_WEBSITE_URL_REQUIRED",
            "请填写中转站登录网址。",
        )
    if "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlparse(raw)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ModelApiDiscoveryFailure(
            "MODEL_API_WEBSITE_URL_INVALID",
            "中转站登录网址必须使用 HTTPS。",
        )
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ModelApiDiscoveryFailure(
            "MODEL_API_WEBSITE_URL_INVALID",
            "中转站登录网址不能包含账号、密码、查询参数或片段。",
        )
    port = f":{parsed.port}" if parsed.port else ""
    origin = f"https://{parsed.hostname}{port}"
    return origin, parsed.hostname.lower(), parsed.path.rstrip("/")


def _default_resolver(hostname: str) -> list[str]:
    return sorted(
        {str(item[4][0]) for item in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)}
    )


def _assert_public_host(
    hostname: str,
    resolver: Callable[[str], list[str]],
) -> None:
    if hostname in PRIVATE_HOSTNAMES:
        raise ModelApiDiscoveryFailure(
            "MODEL_API_PRIVATE_ADDRESS_FORBIDDEN",
            "中转站网址不能指向本机或内网地址。",
        )
    try:
        direct = ipaddress.ip_address(hostname)
        addresses = [str(direct)]
    except ValueError:
        try:
            addresses = resolver(hostname)
        except (OSError, socket.gaierror) as exc:
            raise ModelApiDiscoveryFailure(
                "MODEL_API_DNS_LOOKUP_FAILED",
                "中转站域名暂时无法解析。",
            ) from exc
    if not addresses:
        raise ModelApiDiscoveryFailure(
            "MODEL_API_DNS_LOOKUP_FAILED",
            "中转站域名暂时无法解析。",
        )
    for address in addresses:
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError as exc:
            raise ModelApiDiscoveryFailure(
                "MODEL_API_DNS_RESPONSE_INVALID",
                "中转站域名解析结果无效。",
            ) from exc
        if not parsed.is_global:
            raise ModelApiDiscoveryFailure(
                "MODEL_API_PRIVATE_ADDRESS_FORBIDDEN",
                "中转站网址不能指向本机或内网地址。",
            )


def _known_profile(hostname: str, origin: str) -> dict[str, Any] | None:
    if hostname == APPROVED_IMAGE_API_HOST:
        return {
            "provider": "codesonline",
            "alias": "codesonline 中转站",
            "base_url": f"{origin}/v1",
            "models": [
                {
                    "id": "gpt-image-2",
                    "label": "gpt-image-2",
                    "capabilities": ["image-generation", "image-edit"],
                    "modalities": ["text", "image"],
                }
            ],
        }
    return None


def _candidate_base_urls(origin: str, page_path: str, profile: dict[str, Any] | None) -> list[str]:
    values: list[str] = []
    if profile:
        values.append(str(profile["base_url"]))
    if page_path.lower().endswith("/v1"):
        values.append(f"{origin}{page_path}")
    values.extend([f"{origin}/v1", f"{origin}/api/v1"])
    return list(dict.fromkeys(value.rstrip("/") for value in values))[:4]


def _string_list(value: Any) -> list[str]:
    source = value if isinstance(value, list) else [value] if value else []
    result: list[str] = []
    for item in source:
        for part in _text(item).lower().replace("|", ",").replace(" ", ",").split(","):
            if part and part not in result:
                result.append(part)
    return result[:32]


def _model_capabilities(model_id: str, row: dict[str, Any]) -> tuple[list[str], list[str]]:
    model_lower = model_id.lower()
    metadata = _string_list(row.get("capabilities"))
    for key in (
        "supported_endpoints",
        "endpoints",
        "modalities",
        "input_modalities",
        "output_modalities",
    ):
        metadata.extend(item for item in _string_list(row.get(key)) if item not in metadata)
    joined = " ".join(metadata)
    capabilities: set[str] = set()
    modalities: set[str] = set()
    if any(word in joined for word in ("image", "vision", "picture")):
        modalities.add("image")
    if any(word in joined for word in ("text", "chat", "completion", "response")):
        modalities.add("text")
    if any(word in joined for word in ("edit", "image_edit", "images/edits")):
        capabilities.add("image-edit")
    if any(word in joined for word in ("generation", "generate", "images/generations")):
        capabilities.add("image-generation")
    if any(word in model_lower for word in ("gpt-image", "dall-e", "imagen", "flux")):
        capabilities.update(("image-generation", "image-edit"))
        modalities.update(("image", "text"))
    if any(word in model_lower for word in ("gpt", "claude", "gemini", "qwen", "deepseek")):
        capabilities.add("text-generation")
        modalities.add("text")
    if "image" in modalities and "text" in modalities:
        capabilities.add("multimodal")
    if not capabilities and not modalities:
        capabilities.add("unknown")
    return sorted(capabilities), sorted(modalities)


def _normalize_models(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        rows = payload["data"]
    elif isinstance(payload, dict) and isinstance(payload.get("models"), list):
        rows = payload["models"]
    elif isinstance(payload, list):
        rows = payload
    else:
        rows = []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in rows:
        row = {"id": item} if isinstance(item, str) else item if isinstance(item, dict) else {}
        model_id = _text(row.get("id") or row.get("name") or row.get("model"))
        if not model_id or len(model_id) > 160 or model_id in seen:
            continue
        seen.add(model_id)
        capabilities, modalities = _model_capabilities(model_id, row)
        result.append(
            {
                "id": model_id,
                "label": _text(row.get("display_name") or row.get("label") or model_id)[:160],
                "capabilities": capabilities,
                "modalities": modalities,
            }
        )
        if len(result) >= MAX_MODELS:
            break
    return result


def _read_models(
    client: httpx.Client,
    url: str,
    api_key: str,
) -> tuple[bool, list[dict[str, Any]]]:
    headers = {"Accept": "application/json", "User-Agent": "Wangzai-Core-V2/1"}
    if api_key:
        headers.update({"Authorization": f"Bearer {api_key}", "X-API-Key": api_key})
    try:
        with client.stream("GET", url, headers=headers) as response:
            if response.status_code in (401, 403):
                return True, []
            if not response.is_success:
                return False, []
            content_length = int(response.headers.get("content-length", "0") or "0")
            if content_length > MAX_RESPONSE_BYTES:
                return False, []
            chunks: list[bytes] = []
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    return False, []
                chunks.append(chunk)
            try:
                payload = httpx.Response(200, content=b"".join(chunks)).json()
            except ValueError:
                return False, []
            return False, _normalize_models(payload)
    finally:
        headers.clear()


def _capabilities(models: list[dict[str, Any]]) -> list[str]:
    return sorted({capability for model in models for capability in model["capabilities"]})


def _usage_scene(capabilities: list[str]) -> str:
    labels: list[str] = []
    for capability, label in (
        ("text-generation", "文本"),
        ("image-generation", "文生图"),
        ("image-edit", "图生图"),
        ("multimodal", "多模态"),
    ):
        if capability in capabilities:
            labels.append(label)
    return " / ".join(labels) or "待识别能力"


def discover_model_api(
    request: ModelApiDiscoveryRequest,
    *,
    resolver: Callable[[str], list[str]] = _default_resolver,
    client: httpx.Client | None = None,
    timeout_seconds: int = 8,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> dict[str, Any]:
    origin, hostname, page_path = _parse_website_url(request.website_url)
    _assert_public_host(hostname, resolver)
    profile = _known_profile(hostname, origin)
    candidates = _candidate_base_urls(origin, page_path, profile)
    api_key = request.api_key.get_secret_value() if request.api_key else ""
    unauthorized = False
    owned_client = client is None
    active_client = client or httpx.Client(
        timeout=httpx.Timeout(timeout_seconds),
        follow_redirects=False,
        trust_env=False,
    )
    try:
        for base_url in candidates:
            try:
                rejected, models = _read_models(active_client, f"{base_url}/models", api_key)
            except (httpx.TimeoutException, httpx.NetworkError):
                continue
            unauthorized = unauthorized or rejected
            if not models:
                continue
            capabilities = _capabilities(models)
            preferred = next(
                (
                    model["id"]
                    for capability in ("image-edit", "image-generation")
                    for model in models
                    if capability in model["capabilities"]
                ),
                models[0]["id"],
            )
            return {
                "updates": {
                    "apiAlias": _text(request.api_alias)
                    or f"{hostname.removeprefix('www.')} 中转站",
                    "provider": profile["provider"] if profile else hostname,
                    "baseUrl": base_url,
                    "defaultModel": preferred,
                    "usageScene": _usage_scene(capabilities),
                    "detectionStatus": f"已自动识别接口，发现 {len(models)} 个可用模型。",
                    "detectedSource": f"{base_url}/models",
                    "detectedAt": now().isoformat().replace("+00:00", "Z"),
                    "availableModels": models,
                    "capabilities": capabilities,
                    "discoveryVerified": True,
                }
            }
    finally:
        if owned_client:
            active_client.close()

    fallback_models = list(profile["models"]) if profile else []
    capabilities = _capabilities(fallback_models)
    if unauthorized:
        status = "已找到接口，但 API Key 校验失败，请检查密钥。"
    elif profile:
        status = "已识别中转站类型，暂未读取到模型列表，可稍后重新保存重试。"
    else:
        status = "暂未识别到可用 API 接口，请检查网址或更换受支持的中转站。"
    return {
        "updates": {
            "apiAlias": _text(request.api_alias)
            or (str(profile["alias"]) if profile else f"{hostname.removeprefix('www.')} 中转站"),
            "provider": profile["provider"] if profile else hostname,
            "baseUrl": profile["base_url"] if profile else "",
            "defaultModel": fallback_models[0]["id"] if fallback_models else "",
            "usageScene": _usage_scene(capabilities),
            "detectionStatus": status,
            "detectedSource": "内置中转站规则" if profile else "",
            "detectedAt": now().isoformat().replace("+00:00", "Z"),
            "availableModels": fallback_models,
            "capabilities": capabilities,
            "discoveryVerified": False,
        }
    }

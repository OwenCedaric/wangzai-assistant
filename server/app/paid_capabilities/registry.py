from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.paid_capabilities.pricing import ProviderUsage
from app.paid_capabilities.text_model_policy import (
    DEFAULT_REASONING_EFFORT,
    reasoning_effort_is_allowed,
)
from app.protected_compute.secret_guard import SecretInputError, reject_secret_material


class PaidCapabilityContractError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class PaidCapabilityDescriptor:
    capability: str
    version: int
    required_permission: str
    provider_kind: str
    max_output_tokens: int
    normalize: Callable[[dict[str, Any]], dict[str, Any]]
    estimate_usage: Callable[[dict[str, Any]], ProviderUsage]
    maximum_usage: Callable[[dict[str, Any]], ProviderUsage]


def _plain_dict(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PaidCapabilityContractError(f"{label} must be an object")
    return value


def _exact(value: object, fields: set[str], label: str) -> dict[str, Any]:
    payload = _plain_dict(value, label)
    if set(payload) != fields:
        raise PaidCapabilityContractError(f"{label} fields do not match the contract")
    return payload


def _text(value: object, label: str, maximum: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise PaidCapabilityContractError(f"{label} must be a string")
    normalized = value.strip()
    if (not normalized and not allow_empty) or len(normalized) > maximum:
        raise PaidCapabilityContractError(f"{label} is outside the contract range")
    return normalized


def _integer(value: object, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise PaidCapabilityContractError(f"{label} is outside the contract range")
    return value


def _reject_secrets(payload: dict[str, Any]) -> None:
    try:
        reject_secret_material(payload)
    except SecretInputError as exc:
        raise PaidCapabilityContractError("secret material is forbidden") from exc


def _normalize_text(payload: dict[str, Any], *, system_max: int, user_max: int) -> dict[str, Any]:
    source = _plain_dict(payload, "text input")
    if set(source) not in (
        {"systemPrompt", "userPrompt"},
        {"systemPrompt", "userPrompt", "reasoningEffort"},
    ):
        raise PaidCapabilityContractError("text input fields do not match the contract")
    _reject_secrets(source)
    reasoning_effort = source.get("reasoningEffort", DEFAULT_REASONING_EFFORT)
    if not reasoning_effort_is_allowed(reasoning_effort):
        raise PaidCapabilityContractError("reasoningEffort is outside the allowed policy")
    normalized = {
        "systemPrompt": _text(source["systemPrompt"], "systemPrompt", system_max),
        "userPrompt": _text(source["userPrompt"], "userPrompt", user_max),
    }
    if "reasoningEffort" in source:
        normalized["reasoningEffort"] = str(reasoning_effort)
    return normalized


def _normalize_product_description(payload: dict[str, Any]) -> dict[str, Any]:
    return _normalize_text(payload, system_max=12_000, user_max=30_000)


def _normalize_data_analysis(payload: dict[str, Any]) -> dict[str, Any]:
    return _normalize_text(payload, system_max=20_000, user_max=120_000)


def _normalize_external_insight(payload: dict[str, Any]) -> dict[str, Any]:
    return _normalize_text(payload, system_max=20_000, user_max=80_000)


_OPENCLAW_CHAT_FIELDS = {
    "model",
    "messages",
    "tools",
    "tool_choice",
    "stream",
    "stream_options",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "reasoning_effort",
    "response_format",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "stop",
    "store",
    "prompt_cache_key",
    "prompt_cache_retention",
}


def _normalize_openclaw_chat(payload: dict[str, Any]) -> dict[str, Any]:
    source = _exact(payload, {"requestBody"}, "OpenClaw chat input")
    request_body = _bounded_json(source["requestBody"])
    if not set(request_body).issubset(_OPENCLAW_CHAT_FIELDS):
        raise PaidCapabilityContractError("OpenClaw chat fields do not match the contract")
    if request_body.get("stream") is not False:
        raise PaidCapabilityContractError("OpenClaw paid chat must be settled before streaming")
    messages = request_body.get("messages")
    tools = request_body.get("tools", [])
    if not isinstance(messages, list) or not 1 <= len(messages) <= 128:
        raise PaidCapabilityContractError("OpenClaw messages must be a bounded list")
    if not isinstance(tools, list) or len(tools) > 64:
        raise PaidCapabilityContractError("OpenClaw tools must be a bounded list")
    encoded = json.dumps(request_body, ensure_ascii=False, separators=(",", ":"))
    if len(encoded) > 800_000:
        raise PaidCapabilityContractError("OpenClaw chat input is too large")
    _reject_secrets(source)
    return {"requestBody": request_body}


def _normalize_https_images(value: object, label: str, maximum: int) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise PaidCapabilityContractError(f"{label} must be a bounded list")
    images: list[str] = []
    for item in value:
        url = _text(item, label, 2_048)
        if not url.startswith("https://"):
            raise PaidCapabilityContractError(f"{label} must contain HTTPS URLs")
        images.append(url)
    return images


def _normalize_image_plan(payload: dict[str, Any]) -> dict[str, Any]:
    source = _plain_dict(payload, "image plan input")
    if set(source) not in (
        {"systemPrompt", "userPrompt", "referenceImageUrls"},
        {"systemPrompt", "userPrompt", "referenceImageUrls", "reasoningEffort"},
    ):
        raise PaidCapabilityContractError("image plan input fields do not match the contract")
    _reject_secrets(source)
    reasoning_effort = source.get("reasoningEffort", DEFAULT_REASONING_EFFORT)
    if not reasoning_effort_is_allowed(reasoning_effort):
        raise PaidCapabilityContractError("reasoningEffort is outside the allowed policy")
    normalized = {
        "systemPrompt": _text(source["systemPrompt"], "systemPrompt", 20_000),
        "userPrompt": _text(source["userPrompt"], "userPrompt", 50_000),
        "referenceImageUrls": _normalize_https_images(
            source["referenceImageUrls"], "referenceImageUrls", 10
        ),
    }
    if "reasoningEffort" in source:
        normalized["reasoningEffort"] = str(reasoning_effort)
    return normalized


_SHOP_PATTERN = re.compile(r"[A-Za-z0-9._:-]{1,160}", flags=re.ASCII)
_IMAGE_SIZES = {"1024x1024", "1008x1344", "1344x1008"}
_IMAGE_QUALITIES = {"standard", "high", "hd", "2k", "4k"}


def _normalize_image_common(payload: dict[str, Any], *, edit: bool) -> dict[str, Any]:
    fields = {"prompt", "size", "quality", "count", "shopId"}
    if edit:
        fields.add("sourceImageUrls")
    source = _exact(payload, fields, "image input")
    _reject_secrets(source)
    size = _text(source["size"], "size", 32)
    quality = _text(source["quality"], "quality", 32).lower()
    shop_id = _text(source["shopId"], "shopId", 160)
    if size not in _IMAGE_SIZES or quality not in _IMAGE_QUALITIES:
        raise PaidCapabilityContractError("image size or quality is unsupported")
    if _SHOP_PATTERN.fullmatch(shop_id) is None or shop_id == "shop-unbound":
        raise PaidCapabilityContractError("shopId is invalid")
    normalized: dict[str, Any] = {
        "prompt": _text(source["prompt"], "prompt", 20_000),
        "size": size,
        "quality": quality,
        "count": _integer(source["count"], "count", 1, 16),
        "shopId": shop_id,
    }
    if edit:
        normalized["sourceImageUrls"] = _normalize_https_images(
            source["sourceImageUrls"], "sourceImageUrls", 16
        )
        if not normalized["sourceImageUrls"]:
            raise PaidCapabilityContractError("sourceImageUrls cannot be empty")
    return normalized


def _normalize_image_generate(payload: dict[str, Any]) -> dict[str, Any]:
    return _normalize_image_common(payload, edit=False)


def _normalize_image_edit(payload: dict[str, Any]) -> dict[str, Any]:
    return _normalize_image_common(payload, edit=True)


def _bounded_json(value: object) -> dict[str, Any]:
    payload = _plain_dict(value, "requestBody")
    pending: list[object] = [payload]
    visited = 0
    while pending:
        current = pending.pop()
        visited += 1
        if visited > 10_000:
            raise PaidCapabilityContractError("requestBody is too large")
        if isinstance(current, dict):
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
        elif current is not None and not isinstance(current, (str, int, float, bool)):
            raise PaidCapabilityContractError("requestBody contains an unsupported value")
    return payload


def _normalize_external_read(payload: dict[str, Any]) -> dict[str, Any]:
    source = _exact(payload, {"requestBody"}, "external read input")
    _reject_secrets(source)
    return {"requestBody": _bounded_json(source["requestBody"])}


def _text_estimate(payload: dict[str, Any]) -> ProviderUsage:
    characters = len(payload["systemPrompt"]) + len(payload["userPrompt"])
    return ProviderUsage(input_tokens=max(1, math.ceil(characters / 4)), output_tokens=1_500)


def _text_maximum(max_output_tokens: int) -> Callable[[dict[str, Any]], ProviderUsage]:
    def maximum(payload: dict[str, Any]) -> ProviderUsage:
        characters = len(payload["systemPrompt"]) + len(payload["userPrompt"])
        image_allowance = len(payload.get("referenceImageUrls", [])) * 2_000
        return ProviderUsage(
            input_tokens=max(1, math.ceil(characters / 2)) + image_allowance,
            output_tokens=max_output_tokens,
        )

    return maximum


def _openclaw_text_estimate(payload: dict[str, Any]) -> ProviderUsage:
    request_body = payload["requestBody"]
    characters = len(json.dumps(request_body, ensure_ascii=False, separators=(",", ":")))
    output_tokens = request_body.get("max_completion_tokens", request_body.get("max_tokens", 1_500))
    if isinstance(output_tokens, bool) or not isinstance(output_tokens, int):
        output_tokens = 1_500
    return ProviderUsage(
        input_tokens=max(1, math.ceil(characters / 4)),
        output_tokens=max(1, min(8_000, output_tokens)),
    )


def _openclaw_text_maximum(payload: dict[str, Any]) -> ProviderUsage:
    request_body = payload["requestBody"]
    characters = len(json.dumps(request_body, ensure_ascii=False, separators=(",", ":")))
    output_tokens = request_body.get("max_completion_tokens", request_body.get("max_tokens", 8_000))
    if isinstance(output_tokens, bool) or not isinstance(output_tokens, int):
        output_tokens = 8_000
    return ProviderUsage(
        input_tokens=max(1, math.ceil(characters / 2)),
        output_tokens=max(1, min(8_000, output_tokens)),
    )


def _image_usage(payload: dict[str, Any]) -> ProviderUsage:
    return ProviderUsage(units=payload["count"])


def _external_usage(_payload: dict[str, Any]) -> ProviderUsage:
    return ProviderUsage(units=1)


def _descriptor(
    capability: str,
    permission: str,
    provider_kind: str,
    normalize: Callable[[dict[str, Any]], dict[str, Any]],
    estimate: Callable[[dict[str, Any]], ProviderUsage],
    maximum: Callable[[dict[str, Any]], ProviderUsage],
    max_output_tokens: int = 0,
) -> PaidCapabilityDescriptor:
    return PaidCapabilityDescriptor(
        capability=capability,
        version=1,
        required_permission=permission,
        provider_kind=provider_kind,
        max_output_tokens=max_output_tokens,
        normalize=normalize,
        estimate_usage=estimate,
        maximum_usage=maximum,
    )


_CAPABILITIES = {
    ("text.product-description", 1): _descriptor(
        "text.product-description",
        "products.view",
        "text",
        _normalize_product_description,
        _text_estimate,
        _text_maximum(8_000),
        8_000,
    ),
    ("text.image-plan", 1): _descriptor(
        "text.image-plan",
        "products.view",
        "text",
        _normalize_image_plan,
        _text_estimate,
        _text_maximum(8_000),
        8_000,
    ),
    ("text.data-analysis", 1): _descriptor(
        "text.data-analysis",
        "analytics.view",
        "text",
        _normalize_data_analysis,
        _text_estimate,
        _text_maximum(12_000),
        12_000,
    ),
    ("text.external-insight", 1): _descriptor(
        "text.external-insight",
        "dashboard.view",
        "text",
        _normalize_external_insight,
        _text_estimate,
        _text_maximum(8_000),
        8_000,
    ),
    ("text.openclaw-chat", 1): _descriptor(
        "text.openclaw-chat",
        "dashboard.view",
        "text",
        _normalize_openclaw_chat,
        _openclaw_text_estimate,
        _openclaw_text_maximum,
        8_000,
    ),
    ("image.generate", 1): _descriptor(
        "image.generate",
        "products.view",
        "image",
        _normalize_image_generate,
        _image_usage,
        _image_usage,
    ),
    ("image.edit", 1): _descriptor(
        "image.edit", "products.view", "image", _normalize_image_edit, _image_usage, _image_usage
    ),
}

for suffix in (
    "shop",
    "product-detail",
    "category",
    "product-report",
    "market-keyword",
    "keyword-mining",
    "keyword-back",
):
    capability = f"external.seerfar.{suffix}"
    _CAPABILITIES[(capability, 1)] = _descriptor(
        capability,
        "dashboard.view",
        "seerfar",
        _normalize_external_read,
        _external_usage,
        _external_usage,
    )


def get_paid_capability(capability: str, version: int) -> PaidCapabilityDescriptor:
    descriptor = _CAPABILITIES.get((capability, version))
    if descriptor is None:
        raise PaidCapabilityContractError("unsupported paid capability/version")
    return descriptor


def public_paid_capability_contracts() -> list[dict[str, Any]]:
    return [
        {
            "capability": descriptor.capability,
            "version": descriptor.version,
            "requiredPermission": descriptor.required_permission,
            "providerKind": descriptor.provider_kind,
        }
        for descriptor in _CAPABILITIES.values()
    ]

from __future__ import annotations

from urllib.parse import urlsplit
import os

APPROVED_IMAGE_API_BASE_URL = os.environ.get("WANGZAI_IMAGE_API_URL", "https://images.example.invalid/v1").strip().rstrip("/")
APPROVED_IMAGE_API_HOST = urlsplit(APPROVED_IMAGE_API_BASE_URL).hostname or ""
APPROVED_IMAGE_MODEL = "gpt-image-2"


def normalize_image_api_base_url(value: str | None) -> str:
    normalized = str(value or "").strip().rstrip("/")
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError:
        return ""
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() != APPROVED_IMAGE_API_HOST
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or port not in {None, 443}
        or parsed.path.rstrip("/") != "/v1"
    ):
        return ""
    return APPROVED_IMAGE_API_BASE_URL


def image_provider_is_allowed(base_url: str | None, model: str | None) -> bool:
    return (
        normalize_image_api_base_url(base_url) == APPROVED_IMAGE_API_BASE_URL
        and str(model or "").strip() == APPROVED_IMAGE_MODEL
    )


def image_model_is_allowed(model: str | None) -> bool:
    return str(model or "").strip() == APPROVED_IMAGE_MODEL

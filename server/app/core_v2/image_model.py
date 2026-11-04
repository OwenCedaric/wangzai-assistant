from __future__ import annotations

import base64
import binascii
import hashlib
import json
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy.orm import Session

from app.config import Settings
from app.paid_capabilities.image_model_policy import (
    APPROVED_IMAGE_API_BASE_URL,
    APPROVED_IMAGE_MODEL,
    image_provider_is_allowed,
)
from app.paid_capabilities.registry import get_paid_capability
from app.paid_capabilities.service import execute_paid_capability, issue_quote, paid_input_hash
from app.protected_compute.canonical import canonical_sha256
from app.schemas.core_v2 import ImageModelExecutionRequest
from app.services.errors import DomainError
from app.services.managed_oss_image_sources import (
    AliyunManagedOssImageSourceStager,
    build_managed_oss_image_source_stager,
)
from app.services.oss_management import get_configuration

from .model_api import ModelApiDiscoveryFailure, _assert_public_host, _default_resolver
from .prompt_registry import render_server_image_prompt

MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024
SUPPORTED_SOURCE_TYPES = {"image/jpeg", "image/png", "image/webp"}


class ImageModelExecutionFailure(Exception):
    def __init__(self, code: str, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _safe_https_url(
    value: str,
    resolver: Callable[[str], list[str]],
    *,
    code: str,
    message: str,
) -> str:
    normalized = str(value or "").strip()
    parsed = urlsplit(normalized)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise ImageModelExecutionFailure(code, message)
    try:
        _assert_public_host(parsed.hostname.lower(), resolver)
    except ModelApiDiscoveryFailure as exc:
        raise ImageModelExecutionFailure(code, message, status_code=exc.status_code) from exc
    return normalized


def _safe_base_url(value: str, resolver: Callable[[str], list[str]]) -> str:
    normalized = _safe_https_url(
        value,
        resolver,
        code="IMAGE_MODEL_BASE_URL_INVALID",
        message="图片模型接口必须使用公开 HTTPS 地址。",
    )
    parsed = urlsplit(normalized)
    if parsed.query:
        raise ImageModelExecutionFailure(
            "IMAGE_MODEL_BASE_URL_INVALID",
            "图片模型接口地址不能包含查询参数。",
        )
    return normalized.rstrip("/")


def _prompt(payload: ImageModelExecutionRequest) -> str:
    prompt = render_server_image_prompt(
        template_id=payload.template_id,
        template_input=payload.template_input,
    ).strip()
    if not prompt or len(prompt) > 20_000:
        raise ImageModelExecutionFailure(
            "IMAGE_MODEL_PROMPT_INVALID",
            "服务器生成的图片指令为空或过长。",
        )
    return prompt


def _read_bounded_json(response: httpx.Response) -> dict[str, Any]:
    if not response.is_success:
        raise ImageModelExecutionFailure(
            "IMAGE_MODEL_UPSTREAM_REJECTED",
            "图片模型暂时无法完成本次请求。",
            status_code=502,
        )
    content_length = int(response.headers.get("content-length", "0") or "0")
    if content_length > MAX_PROVIDER_RESPONSE_BYTES:
        raise ImageModelExecutionFailure(
            "IMAGE_MODEL_RESPONSE_TOO_LARGE",
            "图片模型返回内容过大。",
            status_code=502,
        )
    content = response.content
    if len(content) > MAX_PROVIDER_RESPONSE_BYTES:
        raise ImageModelExecutionFailure(
            "IMAGE_MODEL_RESPONSE_TOO_LARGE",
            "图片模型返回内容过大。",
            status_code=502,
        )
    try:
        payload = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ImageModelExecutionFailure(
            "IMAGE_MODEL_RESPONSE_INVALID",
            "图片模型返回了无法识别的内容。",
            status_code=502,
        ) from exc
    if not isinstance(payload, dict):
        raise ImageModelExecutionFailure(
            "IMAGE_MODEL_RESPONSE_INVALID",
            "图片模型返回了无法识别的内容。",
            status_code=502,
        )
    return payload


def _normalized_images(payload: Any) -> list[dict[str, str]]:
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        rows = payload.get("images") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return []
    images: list[dict[str, str]] = []
    for row in rows[:4]:
        if not isinstance(row, dict):
            continue
        url = str(row.get("url") or "").strip()
        encoded = str(row.get("b64_json") or row.get("b64Json") or "").strip()
        if url.startswith("https://") and not encoded:
            images.append({"url": url, "b64_json": ""})
        elif encoded and not url and len(encoded) <= MAX_PROVIDER_RESPONSE_BYTES:
            try:
                base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                continue
            images.append({"url": "", "b64_json": encoded})
    return images


def _decode_data_url(value: str) -> tuple[bytes, str] | None:
    prefixes = {
        "data:image/jpeg;base64,": "image/jpeg",
        "data:image/png;base64,": "image/png",
        "data:image/webp;base64,": "image/webp",
    }
    for prefix, content_type in prefixes.items():
        if value.startswith(prefix):
            try:
                data = base64.b64decode(value[len(prefix) :], validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ImageModelExecutionFailure(
                    "IMAGE_MODEL_SOURCE_INVALID",
                    "参考图片内容无效。",
                ) from exc
            if not 1 <= len(data) <= MAX_SOURCE_IMAGE_BYTES:
                raise ImageModelExecutionFailure(
                    "IMAGE_MODEL_SOURCE_INVALID",
                    "参考图片大小不符合要求。",
                )
            return data, content_type
    return None


def _load_sources(
    values: list[str],
    *,
    client: httpx.Client,
    resolver: Callable[[str], list[str]],
) -> list[tuple[str, tuple[str, bytes, str]]]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for index, value in enumerate(values):
        decoded = _decode_data_url(value)
        if decoded is None:
            source_url = _safe_https_url(
                value,
                resolver,
                code="IMAGE_MODEL_SOURCE_INVALID",
                message="参考图片必须使用公开 HTTPS 地址。",
            )
            try:
                response = client.get(source_url, follow_redirects=False)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                raise ImageModelExecutionFailure(
                    "IMAGE_MODEL_SOURCE_UNAVAILABLE",
                    "参考图片暂时无法读取。",
                    status_code=503,
                ) from exc
            content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if (
                not response.is_success
                or content_type not in SUPPORTED_SOURCE_TYPES
                or not 1 <= len(response.content) <= MAX_SOURCE_IMAGE_BYTES
            ):
                raise ImageModelExecutionFailure(
                    "IMAGE_MODEL_SOURCE_INVALID",
                    "参考图片格式或大小不符合要求。",
                )
            decoded = response.content, content_type
        data, content_type = decoded
        extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[content_type]
        files.append(("image", (f"source-{index}.{extension}", data, content_type)))
    return files


def execute_byok_image_model(
    payload: ImageModelExecutionRequest,
    *,
    resolver: Callable[[str], list[str]] = _default_resolver,
    client: httpx.Client | None = None,
    timeout_seconds: int = 300,
) -> dict[str, Any]:
    credential = payload.byok
    if credential is None:
        raise ImageModelExecutionFailure(
            "IMAGE_MODEL_BYOK_REQUIRED",
            "缺少可用的自有图片模型账号。",
        )
    base_url = _safe_base_url(credential.base_url, resolver)
    if not image_provider_is_allowed(base_url, credential.model):
        raise ImageModelExecutionFailure(
            "IMAGE_MODEL_PROVIDER_FORBIDDEN",
            (
                "图片生成只允许 "
                f"{APPROVED_IMAGE_API_BASE_URL} 的 {APPROVED_IMAGE_MODEL}。"
            ),
        )
    prompt = _prompt(payload)
    api_key = credential.api_key.get_secret_value()
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "Wangzai-Core-V2/1",
    }
    owned_client = client is None
    active_client = client or httpx.Client(
        timeout=httpx.Timeout(timeout_seconds),
        follow_redirects=False,
        trust_env=False,
    )
    try:
        try:
            if payload.capability == "image.generate":
                response = active_client.post(
                    f"{base_url}/images/generations",
                    headers={**headers, "Content-Type": "application/json"},
                    json={
                        "model": credential.model,
                        "prompt": prompt,
                        "n": 1,
                        "response_format": "url",
                        "size": payload.size,
                        "quality": payload.quality,
                    },
                    follow_redirects=False,
                )
            else:
                files = _load_sources(
                    payload.source_images,
                    client=active_client,
                    resolver=resolver,
                )
                response = active_client.post(
                    f"{base_url}/images/edits",
                    headers=headers,
                    data={
                        "model": credential.model,
                        "prompt": prompt,
                        "n": "1",
                        "response_format": "url",
                        "size": payload.size,
                        "quality": payload.quality,
                    },
                    files=files,
                    follow_redirects=False,
                )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise ImageModelExecutionFailure(
                "IMAGE_MODEL_NETWORK_UNAVAILABLE",
                "图片模型连接超时或暂时不可用。",
                status_code=503,
            ) from exc
        result = _read_bounded_json(response)
        images = _normalized_images(result)
        if not images:
            raise ImageModelExecutionFailure(
                "IMAGE_MODEL_RESPONSE_EMPTY",
                "图片模型没有返回可用图片。",
                status_code=502,
            )
        return {
            "ok": True,
            "images": images,
            "model": credential.model,
            "account_id": credential.account_id,
            "billing": None,
        }
    finally:
        headers.clear()
        api_key = ""
        if owned_client:
            active_client.close()


def execute_paid_image_model(
    payload: ImageModelExecutionRequest,
    *,
    db: Session,
    user_id: int,
    project_id: int,
    settings: Settings,
    provider: Any,
    source_stager: AliyunManagedOssImageSourceStager | Any | None = None,
) -> dict[str, Any]:
    descriptor = get_paid_capability(payload.capability, 1)
    prompt = _prompt(payload)
    normalized_input: dict[str, Any] = {
        "prompt": prompt,
        "size": payload.size,
        "quality": payload.quality,
        "count": 1,
        "shopId": payload.shop_id,
    }
    active_stager = source_stager
    owns_stager = False
    staged_object_keys: list[str] = []
    if payload.capability == "image.edit":
        if active_stager is None:
            config = get_configuration(db)
            if config is None:
                raise ImageModelExecutionFailure(
                    "IMAGE_MODEL_MANAGED_OSS_UNAVAILABLE",
                    "管理端统一OSS尚未配置，请联系管理员。",
                    status_code=503,
                )
            try:
                active_stager = build_managed_oss_image_source_stager(config, settings)
            except DomainError as exc:
                raise ImageModelExecutionFailure(
                    "IMAGE_MODEL_MANAGED_OSS_UNAVAILABLE",
                    exc.message,
                    status_code=exc.status_code,
                ) from exc
            owns_stager = True
        try:
            staged = active_stager.stage(
                payload.source_images,
                user_id=user_id,
                project_id=project_id,
                shop_id=payload.shop_id,
                request_id=payload.request_id,
            )
        except DomainError as exc:
            if owns_stager and active_stager is not None:
                active_stager.close()
            raise ImageModelExecutionFailure(
                "IMAGE_MODEL_MANAGED_OSS_STAGING_FAILED",
                exc.message,
                status_code=exc.status_code,
            ) from exc
        staged_object_keys = list(staged.object_keys)
        normalized_input["sourceImageUrls"] = list(staged.urls)
    try:
        normalized_input = descriptor.normalize(normalized_input)
        quote = issue_quote(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            normalized_input=normalized_input,
            ttl_seconds=settings.paid_capability_quote_ttl_seconds,
            text_reservation_multiplier_ppm=settings.paid_text_reservation_multiplier_ppm,
            image_reservation_multiplier_ppm=settings.paid_image_reservation_multiplier_ppm,
        )
        digest = hashlib.sha256(
            f"{user_id}\0{payload.capability}\0{payload.request_id}".encode()
        ).hexdigest()
        job = execute_paid_capability(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            quote_id=quote.id,
            normalized_input=normalized_input,
            input_hash=paid_input_hash(normalized_input),
            idempotency_key=f"core-v2-image:{digest}",
            provider=provider,
        )
        result = dict(job.result_json or {})
        images = _normalized_images(result)
        charged_points = job.reservation.settled_points if job.reservation else 0
        job.result_json = {"resultSha256": canonical_sha256(result), "retained": False}
        db.commit()
        if not images:
            raise ImageModelExecutionFailure(
                "PAID_CAPABILITY_RESULT_EMPTY",
                "内置积分图片模型没有返回图片。",
                status_code=502,
            )
        return {
            "ok": True,
            "images": images,
            "model": APPROVED_IMAGE_MODEL,
            "account_id": "",
            "billing": {"chargedPoints": charged_points, "source": "paid-cloud"},
        }
    finally:
        if active_stager is not None and staged_object_keys:
            try:
                active_stager.cleanup(staged_object_keys)
            except Exception:
                pass
        if owns_stager and active_stager is not None:
            active_stager.close()

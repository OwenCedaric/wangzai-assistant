from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from sqlalchemy.orm import Session

from app.config import Settings
from app.paid_capabilities.registry import get_paid_capability
from app.paid_capabilities.service import (
    execute_paid_capability,
    issue_quote,
    paid_input_hash,
)
from app.protected_compute.canonical import canonical_sha256
from app.schemas.core_v2 import TextModelExecutionRequest

from .model_api import ModelApiDiscoveryFailure, _assert_public_host, _default_resolver
from .prompt_registry import render_server_prompt

MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def _execution_prompts(payload: TextModelExecutionRequest) -> tuple[str, str]:
    if payload.template_id:
        return render_server_prompt(
            capability=payload.capability,
            template_id=payload.template_id,
            template_input=payload.template_input,
            custom_rules=payload.custom_rules,
            user_instruction=payload.user_instruction,
        )
    return payload.system_prompt.strip(), payload.user_prompt.strip()


class TextModelExecutionFailure(Exception):
    def __init__(self, code: str, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _safe_base_url(
    value: str,
    resolver: Callable[[str], list[str]],
) -> str:
    parsed = urlsplit(str(value or "").strip())
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise TextModelExecutionFailure(
            "MODEL_API_BASE_URL_INVALID",
            "文本模型接口必须使用不含账号、查询参数或片段的 HTTPS 地址。",
        )
    try:
        _assert_public_host(parsed.hostname.lower(), resolver)
    except ModelApiDiscoveryFailure as exc:
        raise TextModelExecutionFailure(exc.code, exc.message, status_code=exc.status_code) from exc
    normalized_path = parsed.path.rstrip("/")
    return urlunsplit(("https", parsed.netloc, normalized_path, "", ""))


def _reference_content(values: list[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for raw in values[:10]:
        value = str(raw or "").strip()
        if value.startswith("https://") or value.startswith(
            ("data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,")
        ):
            result.append({"type": "image_url", "image_url": {"url": value}})
    return result


def _completion_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    for key in ("output_text", "text", "result"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    choices = payload.get("choices")
    content = (
        choices[0].get("message", {}).get("content")
        if isinstance(choices, list) and choices
        else None
    )
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "\n".join(
            str(item.get("text") or item.get("content") or "").strip()
            for item in content
            if isinstance(item, dict) and (item.get("text") or item.get("content"))
        ).strip()
    output = payload.get("output")
    if isinstance(output, list):
        parts: list[str] = []
        for row in output:
            if not isinstance(row, dict) or not isinstance(row.get("content"), list):
                continue
            for item in row["content"]:
                if isinstance(item, dict):
                    value = str(item.get("text") or item.get("content") or "").strip()
                    if value:
                        parts.append(value)
        return "\n".join(parts).strip()
    return ""


def _usage(payload: Any) -> dict[str, int] | None:
    source = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(source, dict):
        return None
    result: dict[str, int] = {}
    for key in (
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "input_tokens",
        "output_tokens",
    ):
        value = source.get(key)
        if isinstance(value, int) and value >= 0:
            result[key] = value
    return result or None


def execute_byok_text_model(
    payload: TextModelExecutionRequest,
    *,
    resolver: Callable[[str], list[str]] = _default_resolver,
    client: httpx.Client | None = None,
    timeout_seconds: int = 270,
) -> dict[str, Any]:
    credential = payload.byok
    if credential is None:
        raise TextModelExecutionFailure("MODEL_API_BYOK_REQUIRED", "缺少可用的自有模型账号。")
    system_prompt, user_prompt = _execution_prompts(payload)
    system_max, user_max = {
        "text.product-description": (12_000, 30_000),
        "text.image-plan": (20_000, 50_000),
        "text.external-insight": (24_000, 120_000),
    }[payload.capability]
    if len(system_prompt) > system_max or len(user_prompt) > user_max:
        raise TextModelExecutionFailure(
            "TEXT_MODEL_PROMPT_TOO_LARGE",
            "本次模型输入内容过长，请缩小范围后重试。",
        )
    base_url = _safe_base_url(credential.base_url, resolver)
    references = _reference_content(payload.reference_images)
    user_content: str | list[dict[str, Any]] = user_prompt
    if references:
        user_content = [{"type": "text", "text": user_prompt}, *references]
    temperature = {
        "text.product-description": 0.25,
        "text.image-plan": 0.2,
        "text.external-insight": 0.15,
    }[payload.capability]
    api_key = credential.api_key.get_secret_value()
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
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
            with active_client.stream(
                "POST",
                f"{base_url}/chat/completions",
                headers=headers,
                json={
                    "model": credential.model,
                    "reasoning_effort": payload.reasoning_effort,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_content},
                    ],
                    "temperature": temperature,
                },
                follow_redirects=False,
            ) as response:
                if not response.is_success:
                    raise TextModelExecutionFailure(
                        "MODEL_API_UPSTREAM_REJECTED",
                        "文本模型暂时无法完成本次请求。",
                        status_code=502,
                    )
                content_length = int(response.headers.get("content-length", "0") or "0")
                if content_length > MAX_RESPONSE_BYTES:
                    raise TextModelExecutionFailure(
                        "MODEL_API_RESPONSE_TOO_LARGE",
                        "文本模型返回内容过大。",
                        status_code=502,
                    )
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise TextModelExecutionFailure(
                            "MODEL_API_RESPONSE_TOO_LARGE",
                            "文本模型返回内容过大。",
                            status_code=502,
                        )
                    chunks.append(chunk)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise TextModelExecutionFailure(
                "MODEL_API_NETWORK_UNAVAILABLE",
                "文本模型连接超时或暂时不可用。",
                status_code=503,
            ) from exc
        try:
            result = json.loads(b"".join(chunks))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TextModelExecutionFailure(
                "MODEL_API_RESPONSE_INVALID",
                "文本模型返回了无法识别的内容。",
                status_code=502,
            ) from exc
        text = _completion_text(result)
        if not text:
            raise TextModelExecutionFailure(
                "MODEL_API_RESPONSE_EMPTY",
                "文本模型没有返回正文。",
                status_code=502,
            )
        return {
            "ok": True,
            "text": text,
            "model": credential.model,
            "account_id": credential.account_id,
            "usage": _usage(result),
            "billing": None,
            "reference_image_count": len(references),
        }
    finally:
        headers.clear()
        api_key = ""
        if owned_client:
            active_client.close()


def execute_paid_text_model(
    payload: TextModelExecutionRequest,
    *,
    db: Session,
    user_id: int,
    project_id: int,
    settings: Settings,
    provider: Any,
) -> dict[str, Any]:
    descriptor = get_paid_capability(payload.capability, 1)
    reference_urls = [
        value for value in payload.reference_images if str(value).startswith("https://")
    ]
    system_prompt, user_prompt = _execution_prompts(payload)
    normalized_input = descriptor.normalize(
        {
            "systemPrompt": system_prompt,
            "userPrompt": user_prompt,
            "reasoningEffort": payload.reasoning_effort,
            **(
                {"referenceImageUrls": reference_urls}
                if payload.capability == "text.image-plan"
                else {}
            ),
        }
    )
    quote = issue_quote(
        db,
        user_id=user_id,
        project_id=project_id,
        descriptor=descriptor,
        normalized_input=normalized_input,
        ttl_seconds=settings.paid_capability_quote_ttl_seconds,
        requested_model=payload.model,
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
        idempotency_key=f"core-v2:{digest}",
        provider=provider,
    )
    result = dict(job.result_json or {})
    text = str(result.get("text") or "").strip()
    charged_points = job.reservation.settled_points if job.reservation else 0
    # Core V2 returns the provider result once, then keeps only a non-reversible
    # digest in the management audit ledger. Prompts were never stored there.
    job.result_json = {
        "resultSha256": canonical_sha256(result),
        "retained": False,
    }
    db.commit()
    if not text:
        raise TextModelExecutionFailure(
            "PAID_CAPABILITY_RESULT_EMPTY",
            "内置积分模型没有返回正文。",
            status_code=502,
        )
    return {
        "ok": True,
        "text": text,
        "model": payload.model,
        "account_id": "",
        "usage": None,
        "billing": {"chargedPoints": charged_points, "source": "paid-cloud"},
        "reference_image_count": len(reference_urls),
    }

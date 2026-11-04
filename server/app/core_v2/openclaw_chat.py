from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from typing import Any

import httpx
from sqlalchemy.orm import Session

from app.config import Settings
from app.paid_capabilities.registry import get_paid_capability
from app.paid_capabilities.service import (
    execute_paid_capability,
    issue_quote,
    paid_input_hash,
)
from app.paid_capabilities.text_model_policy import text_model_is_allowed
from app.protected_compute.canonical import canonical_sha256
from app.schemas.core_v2 import OpenClawChatExecutionRequest

from .model_api import _default_resolver
from .text_model import MAX_RESPONSE_BYTES, TextModelExecutionFailure, _safe_base_url


def _sanitize_tool_calls(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 64:
        return []
    result: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            return []
        function = item.get("function")
        if not isinstance(function, dict):
            return []
        name = str(function.get("name") or "").strip()
        arguments = function.get("arguments")
        if (
            not name
            or len(name) > 160
            or not isinstance(arguments, str)
            or len(arguments) > 200_000
        ):
            return []
        result.append(
            {
                "id": str(item.get("id") or f"call_{index}")[:200],
                "type": "function",
                "function": {"name": name, "arguments": arguments},
            }
        )
    return result


def sanitize_openclaw_response(body: object, fallback_model: str) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise TextModelExecutionFailure(
            "MODEL_API_RESPONSE_INVALID",
            "模型返回了无法识别的内容。",
            status_code=502,
        )
    choices = body.get("choices")
    choice = (
        choices[0]
        if isinstance(choices, list) and choices and isinstance(choices[0], dict)
        else None
    )
    message = choice.get("message") if isinstance(choice, dict) else None
    if not isinstance(message, dict):
        raise TextModelExecutionFailure(
            "MODEL_API_RESPONSE_INVALID", "模型没有返回有效消息。", status_code=502
        )
    content = message.get("content")
    if content is not None and not isinstance(content, str):
        raise TextModelExecutionFailure(
            "MODEL_API_RESPONSE_INVALID", "模型正文格式无效。", status_code=502
        )
    if isinstance(content, str) and len(content) > 500_000:
        raise TextModelExecutionFailure(
            "MODEL_API_RESPONSE_TOO_LARGE", "模型返回内容过大。", status_code=502
        )
    tool_calls = _sanitize_tool_calls(message.get("tool_calls"))
    if not (isinstance(content, str) and content) and not tool_calls:
        raise TextModelExecutionFailure(
            "MODEL_API_RESPONSE_EMPTY", "模型没有返回正文或工具调用。", status_code=502
        )
    safe_message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        safe_message["tool_calls"] = tool_calls
    raw_usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}

    def token(name: str) -> int:
        value = raw_usage.get(name)
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0

    prompt_tokens = token("prompt_tokens") or token("input_tokens")
    completion_tokens = token("completion_tokens") or token("output_tokens")
    cached_details = (
        raw_usage.get("prompt_tokens_details")
        if isinstance(raw_usage.get("prompt_tokens_details"), dict)
        else {}
    )
    cached_tokens = cached_details.get("cached_tokens")
    if not isinstance(cached_tokens, int) or isinstance(cached_tokens, bool) or cached_tokens < 0:
        cached_tokens = 0
    return {
        "id": str(body.get("id") or "")[:200],
        "object": "chat.completion",
        "created": int(body.get("created") or 0),
        "model": str(body.get("model") or fallback_model)[:160],
        "choices": [
            {
                "index": 0,
                "message": safe_message,
                "finish_reason": str(
                    choice.get("finish_reason") or ("tool_calls" if tool_calls else "stop")
                )[:40],
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": token("total_tokens") or prompt_tokens + completion_tokens,
            "prompt_tokens_details": {"cached_tokens": cached_tokens},
        },
    }


def execute_byok_openclaw_chat(
    payload: OpenClawChatExecutionRequest,
    *,
    resolver: Callable[[str], list[str]] = _default_resolver,
    client: httpx.Client | None = None,
    timeout_seconds: int = 270,
) -> dict[str, Any]:
    credential = payload.byok
    if credential is None:
        raise TextModelExecutionFailure("MODEL_API_BYOK_REQUIRED", "缺少可用的自有模型账号。")
    base_url = _safe_base_url(credential.base_url, resolver)
    api_key = credential.api_key.get_secret_value()
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "Wangzai-OpenClaw-Relay/1",
    }
    owned_client = client is None
    active_client = client or httpx.Client(
        timeout=httpx.Timeout(timeout_seconds), follow_redirects=False, trust_env=False
    )
    try:
        try:
            with active_client.stream(
                "POST",
                f"{base_url}/chat/completions",
                headers=headers,
                json=payload.request_body,
                follow_redirects=False,
            ) as response:
                if not response.is_success:
                    raise TextModelExecutionFailure(
                        "MODEL_API_UPSTREAM_REJECTED",
                        "自有模型暂时无法完成本次请求。",
                        status_code=502,
                    )
                content_length = int(response.headers.get("content-length", "0") or "0")
                if content_length > MAX_RESPONSE_BYTES:
                    raise TextModelExecutionFailure(
                        "MODEL_API_RESPONSE_TOO_LARGE", "模型返回内容过大。", status_code=502
                    )
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise TextModelExecutionFailure(
                            "MODEL_API_RESPONSE_TOO_LARGE", "模型返回内容过大。", status_code=502
                        )
                    chunks.append(chunk)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise TextModelExecutionFailure(
                "MODEL_API_NETWORK_UNAVAILABLE",
                "自有模型连接超时或暂时不可用。",
                status_code=503,
            ) from exc
        try:
            body = json.loads(b"".join(chunks))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TextModelExecutionFailure(
                "MODEL_API_RESPONSE_INVALID", "模型返回了无法识别的内容。", status_code=502
            ) from exc
        return {
            "ok": True,
            "response": sanitize_openclaw_response(body, payload.model),
            "model": payload.model,
            "account_id": credential.account_id,
            "billing": None,
        }
    finally:
        headers.clear()
        api_key = ""
        if owned_client:
            active_client.close()


def execute_paid_openclaw_chat(
    payload: OpenClawChatExecutionRequest,
    *,
    db: Session,
    user_id: int,
    project_id: int,
    settings: Settings,
    provider: Any,
) -> dict[str, Any]:
    if not text_model_is_allowed(payload.model):
        raise TextModelExecutionFailure(
            "TEXT_MODEL_FORBIDDEN", "内置积分模型不支持所选模型。", status_code=422
        )
    descriptor = get_paid_capability("text.openclaw-chat", 1)
    normalized_input = descriptor.normalize({"requestBody": payload.request_body})
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
        f"{user_id}\0text.openclaw-chat\0{payload.request_id}".encode()
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
    response = result.get("response")
    charged_points = job.reservation.settled_points if job.reservation else 0
    job.result_json = {"resultSha256": canonical_sha256(result), "retained": False}
    db.commit()
    if not isinstance(response, dict):
        raise TextModelExecutionFailure(
            "PAID_CAPABILITY_RESULT_EMPTY",
            "本次请求已处理，但模型响应不可重复读取，请发送一条新消息。",
            status_code=409,
        )
    return {
        "ok": True,
        "response": sanitize_openclaw_response(response, payload.model),
        "model": payload.model,
        "account_id": "",
        "billing": {"chargedPoints": charged_points, "source": "paid-cloud"},
    }

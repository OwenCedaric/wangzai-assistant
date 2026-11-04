from __future__ import annotations

import ipaddress
import math
import re
import socket
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx

from app.config import Settings
from app.paid_capabilities.image_model_policy import (
    APPROVED_IMAGE_API_BASE_URL,
    APPROVED_IMAGE_MODEL,
    image_provider_is_allowed,
)
from app.paid_capabilities.pricing import ProviderUsage
from app.paid_capabilities.registry import PaidCapabilityDescriptor
from app.paid_capabilities.usage_meter import (
    ProviderCostSnapshot,
    ProviderUsageMeterError,
    parse_provider_cost_snapshot,
    usage_endpoint,
)


@dataclass(frozen=True, slots=True)
class PaidProviderResult:
    result: dict[str, Any]
    usage: ProviderUsage
    provider_request_id: str | None = None
    actual_provider_cost_micros: int | None = None
    provider_cost_source: str | None = None
    provider_code: str | None = None


@dataclass(frozen=True, slots=True)
class PaidProviderFailure(Exception):
    code: str
    message: str
    billable: bool | None
    usage: ProviderUsage | None = None
    provider_request_id: str | None = None
    status_code: int = 502
    upstream_status: int | None = None
    retry_after_seconds: int | None = None
    actual_provider_cost_micros: int | None = None
    provider_cost_source: str | None = None
    provider_code: str | None = None


@dataclass(frozen=True, slots=True)
class ApiPoolConnection:
    base_url: str
    api_key: str
    adapter: str
    auth_scheme: str = "bearer"
    auth_header_name: str = "Authorization"
    timeout_seconds: int = 150
    managed_by_api_pool: bool = False


class PaidCapabilityProvider(Protocol):
    def execute(
        self,
        descriptor: PaidCapabilityDescriptor,
        payload: dict[str, Any],
        *,
        provider_code: str,
        provider_model: str,
    ) -> PaidProviderResult: ...


class UnavailablePaidCapabilityProvider:
    def execute(
        self,
        descriptor: PaidCapabilityDescriptor,
        payload: dict[str, Any],
        *,
        provider_code: str,
        provider_model: str,
    ) -> PaidProviderResult:
        raise PaidProviderFailure(
            code="PAID_CAPABILITY_PROVIDER_UNAVAILABLE",
            message="Paid capability provider is unavailable",
            billable=False,
            status_code=503,
        )


_SEERFAR_PATHS = {
    "external.seerfar.shop": "/open-api/shop/detail/search/ozon",
    "external.seerfar.product-detail": "/open-api/product/detail/search/ozon",
    "external.seerfar.category": "/open-api/category/detail/search/ozon",
    "external.seerfar.product-report": "/open-api/productReport/search/ozon",
    "external.seerfar.market-keyword": "/open-api/market/search/ozon",
    "external.seerfar.keyword-mining": "/open-api/keyword/mining/ozon",
    "external.seerfar.keyword-back": "/open-api/keyword/backSearch/ozon",
}

_PROXY_FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")


def _signed_json_safe(value: Any) -> Any:
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("provider returned a non-finite number")
        return format(value, ".15g")
    if isinstance(value, list):
        return [_signed_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _signed_json_safe(item) for key, item in value.items()}
    if value is None or isinstance(value, (str, int, bool)):
        return value
    raise ValueError("provider returned an unsupported value")


def _checked_base_url(
    value: str,
    allowed_hosts: set[str],
    *,
    allow_admin_managed_host: bool = False,
) -> str:
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    public_managed_host = False
    if (
        allow_admin_managed_host
        and host
        and host != "localhost"
        and not host.endswith((".localhost", ".local", ".internal", ".arpa"))
    ):
        try:
            public_managed_host = ipaddress.ip_address(host).is_global
        except ValueError:
            public_managed_host = "." in host
    if (
        parsed.scheme != "https"
        or not host
        or (host not in allowed_hosts and not public_managed_host)
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.port not in {None, 443}
    ):
        raise ValueError("paid provider base URL is not allowlisted")
    return value.rstrip("/")


def _usage(payload: dict[str, Any], *, units: int = 0) -> ProviderUsage:
    raw = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    details = (
        raw.get("prompt_tokens_details")
        if isinstance(raw.get("prompt_tokens_details"), dict)
        else {}
    )
    return ProviderUsage(
        input_tokens=max(0, int(raw.get("prompt_tokens") or raw.get("input_tokens") or 0)),
        output_tokens=max(0, int(raw.get("completion_tokens") or raw.get("output_tokens") or 0)),
        cached_input_tokens=max(0, int(details.get("cached_tokens") or 0)),
        units=units,
    )


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise PaidProviderFailure(
            "PAID_CAPABILITY_PROVIDER_RESPONSE_INVALID",
            "Provider returned invalid JSON",
            None if response.status_code >= 500 else response.is_success,
            status_code=502,
        ) from exc
    if not isinstance(payload, dict):
        raise PaidProviderFailure(
            "PAID_CAPABILITY_PROVIDER_RESPONSE_INVALID",
            "Provider returned an invalid response",
            None if response.status_code >= 500 else response.is_success,
            status_code=502,
        )
    return payload


def _raise_remote(response: httpx.Response, payload: dict[str, Any]) -> None:
    if response.is_success:
        return
    # 4xx is known rejected before provider work, except throttling/timeouts where
    # an intermediary may have accepted the upstream request.
    known_unbilled = 400 <= response.status_code < 500 and response.status_code not in {
        408,
        425,
        429,
    }
    message = "Paid provider request failed"
    error = payload.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        message = error["message"][:500]
    retry_after: int | None = None
    try:
        retry_after = max(1, min(3600, int(response.headers.get("retry-after", ""))))
    except ValueError:
        pass
    raise PaidProviderFailure(
        "PAID_CAPABILITY_PROVIDER_REJECTED",
        message,
        False if known_unbilled else None,
        provider_request_id=response.headers.get("x-request-id"),
        status_code=502,
        upstream_status=response.status_code,
        retry_after_seconds=retry_after,
    )


def _auth_headers(connection: ApiPoolConnection) -> dict[str, str]:
    if connection.auth_scheme == "bearer":
        return {"Authorization": f"Bearer {connection.api_key}"}
    if connection.auth_scheme == "header":
        return {connection.auth_header_name: connection.api_key}
    raise PaidProviderFailure(
        "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
        "Provider authentication scheme is not supported",
        False,
        status_code=503,
    )


def read_provider_cost_snapshot(
    client: httpx.Client,
    connection: ApiPoolConnection,
) -> ProviderCostSnapshot:
    try:
        response = client.get(
            usage_endpoint(connection.base_url),
            headers=_auth_headers(connection),
            timeout=min(30, connection.timeout_seconds),
        )
        if not response.is_success:
            raise ProviderUsageMeterError("provider usage endpoint rejected the request")
        return parse_provider_cost_snapshot(response.json())
    except (httpx.HTTPError, ValueError, TypeError, ProviderUsageMeterError) as exc:
        raise PaidProviderFailure(
            "PAID_CAPABILITY_PROVIDER_PRICING_UNAVAILABLE",
            "Provider cost evidence is unavailable",
            False,
            status_code=503,
        ) from exc


def _image_urls(payload: dict[str, Any]) -> list[dict[str, str]]:
    data = payload.get("data")
    if not isinstance(data, list) or not 1 <= len(data) <= 16:
        raise PaidProviderFailure(
            "PAID_CAPABILITY_PROVIDER_RESPONSE_INVALID",
            "Image provider returned no bounded image result",
            True,
            usage=_usage(payload),
            status_code=502,
        )
    images: list[dict[str, str]] = []
    for item in data:
        if not isinstance(item, dict):
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_RESPONSE_INVALID",
                "Image provider returned an invalid item",
                True,
                usage=_usage(payload),
                status_code=502,
            )
        url = item.get("url")
        b64_json = item.get("b64_json")
        if isinstance(url, str) and url.startswith("https://") and len(url) <= 8_192:
            images.append({"url": url})
        elif isinstance(b64_json, str) and 1 <= len(b64_json) <= 40_000_000:
            images.append({"b64Json": b64_json})
        else:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_RESPONSE_INVALID",
                "Image provider returned an unusable image",
                True,
                usage=_usage(payload),
                status_code=502,
            )
    return images


def _public_https_host(
    url: str,
    allowed_hosts: set[str],
    *,
    allow_proxy_fake_ip: bool = False,
) -> str:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or not parsed.hostname:
        raise PaidProviderFailure(
            "PAID_CAPABILITY_SOURCE_IMAGE_REJECTED",
            "Source image URL is invalid",
            False,
            status_code=422,
        )
    if parsed.hostname.lower() not in allowed_hosts:
        raise PaidProviderFailure(
            "PAID_CAPABILITY_SOURCE_IMAGE_REJECTED",
            "Source image host is not allowlisted",
            False,
            status_code=422,
        )
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise PaidProviderFailure(
            "PAID_CAPABILITY_SOURCE_IMAGE_UNAVAILABLE",
            "Source image host cannot be resolved",
            False,
            status_code=422,
        ) from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        proxy_fake_ip = allow_proxy_fake_ip and ip in _PROXY_FAKE_IP_NETWORK
        if not ip.is_global and not proxy_fake_ip:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_SOURCE_IMAGE_REJECTED",
                "Source image host is not public",
                False,
                status_code=422,
            )
    return url


class HttpPaidCapabilityProvider:
    def __init__(self, settings: Settings, *, client: httpx.Client | None = None) -> None:
        self.settings = settings
        self.client = client or httpx.Client(
            timeout=settings.paid_provider_timeout_seconds,
            follow_redirects=False,
        )
        allowed = settings.paid_provider_allowed_host_set
        self.text_base = _checked_base_url(settings.paid_text_base_url, allowed)
        self.image_base = _checked_base_url(settings.paid_image_base_url, allowed)
        self.seerfar_base = _checked_base_url(settings.paid_seerfar_base_url, allowed)

    def execute(
        self,
        descriptor: PaidCapabilityDescriptor,
        payload: dict[str, Any],
        *,
        provider_code: str,
        provider_model: str,
    ) -> PaidProviderResult:
        if descriptor.provider_kind == "text":
            connection = ApiPoolConnection(
                base_url=self.text_base,
                api_key=self.settings.paid_text_api_key or "",
                adapter="openai-compatible",
            )
        elif descriptor.provider_kind == "image":
            connection = ApiPoolConnection(
                base_url=self.image_base,
                api_key=self.settings.paid_image_api_key or "",
                adapter="openai-compatible",
            )
        else:
            connection = ApiPoolConnection(
                base_url=self.seerfar_base,
                api_key=self.settings.paid_seerfar_api_key or "",
                adapter="seerfar",
            )
        return self.execute_with_connection(
            descriptor,
            payload,
            provider_code=provider_code,
            provider_model=provider_model,
            connection=connection,
        )

    def execute_with_connection(
        self,
        descriptor: PaidCapabilityDescriptor,
        payload: dict[str, Any],
        *,
        provider_code: str,
        provider_model: str,
        connection: ApiPoolConnection,
    ) -> PaidProviderResult:
        try:
            base_url = _checked_base_url(
                connection.base_url,
                self.settings.paid_provider_allowed_host_set,
                allow_admin_managed_host=connection.managed_by_api_pool,
            )
        except ValueError as exc:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
                "Paid provider URL is not allowlisted",
                False,
                status_code=503,
            ) from exc
        if descriptor.provider_kind == "image" and not image_provider_is_allowed(
            base_url, provider_model
        ):
            raise PaidProviderFailure(
                "PAID_CAPABILITY_IMAGE_PROVIDER_FORBIDDEN",
                (
                    "图片生成只允许 "
                    f"{APPROVED_IMAGE_API_BASE_URL} 的 {APPROVED_IMAGE_MODEL}"
                ),
                False,
                status_code=503,
            )
        try:
            if descriptor.provider_kind == "text":
                if connection.adapter != "openai-compatible":
                    raise PaidProviderFailure(
                        "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
                        "Provider adapter does not support text requests",
                        False,
                        status_code=503,
                    )
                return self._text(descriptor, payload, provider_model, base_url, connection)
            if descriptor.capability == "image.generate":
                return self._image_generate(payload, provider_model, base_url, connection)
            if descriptor.capability == "image.edit":
                return self._image_edit(payload, provider_model, base_url, connection)
            if descriptor.provider_kind == "seerfar":
                if connection.adapter != "seerfar":
                    raise PaidProviderFailure(
                        "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
                        "Provider adapter does not support Seerfar requests",
                        False,
                        status_code=503,
                    )
                return self._seerfar(descriptor, payload, base_url, connection)
        except PaidProviderFailure:
            raise
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN",
                "Provider network outcome is unknown",
                None,
                status_code=503,
            ) from exc
        raise PaidProviderFailure(
            "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
            f"Provider {provider_code} is not configured",
            False,
            status_code=503,
        )

    def _text(
        self,
        descriptor: PaidCapabilityDescriptor,
        payload: dict[str, Any],
        model: str,
        base_url: str,
        connection: ApiPoolConnection,
    ) -> PaidProviderResult:
        if not connection.api_key or not model:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
                "Paid text provider is not configured",
                False,
                status_code=503,
            )
        if descriptor.capability == "text.openclaw-chat":
            request_body = dict(payload["requestBody"])
            request_body["model"] = model
            request_body["stream"] = False
            request_body.pop("stream_options", None)
            requested_max = request_body.get(
                "max_completion_tokens", request_body.get("max_tokens")
            )
            if isinstance(requested_max, int) and not isinstance(requested_max, bool):
                if "max_completion_tokens" in request_body:
                    request_body["max_completion_tokens"] = min(
                        descriptor.max_output_tokens, max(1, requested_max)
                    )
                else:
                    request_body["max_tokens"] = min(
                        descriptor.max_output_tokens, max(1, requested_max)
                    )
            response = self.client.post(
                f"{base_url}/chat/completions",
                headers=_auth_headers(connection),
                json=request_body,
                timeout=connection.timeout_seconds,
            )
            body = _json(response)
            _raise_remote(response, body)
            choices = body.get("choices")
            message = (
                choices[0].get("message")
                if isinstance(choices, list)
                and choices
                and isinstance(choices[0], dict)
                else None
            )
            content = message.get("content") if isinstance(message, dict) else None
            tool_calls = message.get("tool_calls") if isinstance(message, dict) else None
            if not isinstance(message, dict) or not (
                isinstance(content, str) or isinstance(tool_calls, list) and tool_calls
            ):
                raise PaidProviderFailure(
                    "PAID_CAPABILITY_PROVIDER_RESPONSE_INVALID",
                    "Text provider returned no usable assistant message",
                    True,
                    usage=_usage(body),
                    provider_request_id=response.headers.get("x-request-id"),
                    status_code=502,
                )
            safe_message: dict[str, Any] = {"role": "assistant", "content": content}
            if isinstance(tool_calls, list):
                safe_message["tool_calls"] = tool_calls
            safe_choice = {
                "index": 0,
                "message": safe_message,
                "finish_reason": choices[0].get("finish_reason") or (
                    "tool_calls" if tool_calls else "stop"
                ),
            }
            safe_response = {
                "id": str(body.get("id") or response.headers.get("x-request-id") or ""),
                "object": "chat.completion",
                "created": int(body.get("created") or 0),
                "model": str(body.get("model") or model),
                "choices": [safe_choice],
                "usage": {
                    "prompt_tokens": _usage(body).input_tokens,
                    "completion_tokens": _usage(body).output_tokens,
                    "total_tokens": _usage(body).input_tokens + _usage(body).output_tokens,
                    "prompt_tokens_details": {
                        "cached_tokens": _usage(body).cached_input_tokens,
                    },
                },
            }
            return PaidProviderResult(
                result={"response": safe_response},
                usage=_usage(body),
                provider_request_id=response.headers.get("x-request-id")
                or str(body.get("id") or ""),
            )
        user_content: Any = payload["userPrompt"]
        references = payload.get("referenceImageUrls", [])
        if references:
            user_content = [{"type": "text", "text": payload["userPrompt"]}]
            user_content.extend(
                {"type": "image_url", "image_url": {"url": url}} for url in references
            )
        prompt_contract = f'{payload["systemPrompt"]}\n{payload["userPrompt"]}'
        requires_json_object = "json" in prompt_contract.lower()
        system_prompt = payload["systemPrompt"]
        if requires_json_object and "json" not in system_prompt:
            # Some OpenAI-compatible relays enforce a case-sensitive literal
            # `json` marker whenever response_format=json_object is present.
            system_prompt = f"{system_prompt}\nResponse format: json object."
        request_body: dict[str, Any] = {
            "model": model,
            "reasoning_effort": payload.get("reasoningEffort", "medium"),
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "max_tokens": descriptor.max_output_tokens,
        }
        # Server-owned prompt templates for listing, analysis and image-plan
        # tasks explicitly require a JSON object. Ask compatible providers to
        # enforce that contract instead of billing for prose that the desktop
        # must discard as an invalid batch.
        if requires_json_object:
            request_body["response_format"] = {"type": "json_object"}
        response = self.client.post(
            f"{base_url}/chat/completions",
            headers=_auth_headers(connection),
            json=request_body,
            timeout=connection.timeout_seconds,
        )
        body = _json(response)
        _raise_remote(response, body)
        choices = body.get("choices")
        content = (
            choices[0].get("message", {}).get("content")
            if isinstance(choices, list) and choices and isinstance(choices[0], dict)
            else None
        )
        if not isinstance(content, str) or not content or len(content) > 500_000:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_RESPONSE_INVALID",
                "Text provider returned no usable content",
                True,
                usage=_usage(body),
                provider_request_id=response.headers.get("x-request-id"),
                status_code=502,
            )
        return PaidProviderResult(
            result={"text": content},
            usage=_usage(body),
            provider_request_id=response.headers.get("x-request-id") or str(body.get("id") or ""),
        )

    def _image_generate(
        self,
        payload: dict[str, Any],
        model: str,
        base_url: str,
        connection: ApiPoolConnection,
    ) -> PaidProviderResult:
        if connection.adapter != "openai-compatible" or not connection.api_key or not model:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
                "Paid image provider is not configured",
                False,
                status_code=503,
            )
        response = self.client.post(
            f"{base_url}/images/generations",
            headers=_auth_headers(connection),
            json={
                "model": model,
                "prompt": payload["prompt"],
                "n": payload["count"],
                "response_format": "url",
                "size": payload["size"],
                "quality": payload["quality"],
            },
            timeout=connection.timeout_seconds,
        )
        body = _json(response)
        _raise_remote(response, body)
        images = _image_urls(body)
        provider_cost = self._image_task_cost(body, base_url, connection)
        return PaidProviderResult(
            result={"images": images},
            usage=_usage(body, units=payload["count"]),
            provider_request_id=response.headers.get("x-request-id"),
            actual_provider_cost_micros=provider_cost,
            provider_cost_source="provider_task_credit_cost",
        )

    def _image_edit(
        self,
        payload: dict[str, Any],
        model: str,
        base_url: str,
        connection: ApiPoolConnection,
    ) -> PaidProviderResult:
        if connection.adapter != "openai-compatible" or not connection.api_key or not model:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
                "Paid image provider is not configured",
                False,
                status_code=503,
            )
        files: list[tuple[str, tuple[str, bytes, str]]] = []
        for index, source_url in enumerate(payload["sourceImageUrls"]):
            source_response = self.client.get(
                _public_https_host(
                    source_url,
                    self.settings.paid_source_image_allowed_host_set,
                    allow_proxy_fake_ip=(self.settings.paid_source_image_allow_proxy_fake_ip),
                )
            )
            content_type = source_response.headers.get("content-type", "").split(";", 1)[0]
            if (
                not source_response.is_success
                or content_type not in {"image/jpeg", "image/png", "image/webp"}
                or not 1 <= len(source_response.content) <= 20_000_000
            ):
                raise PaidProviderFailure(
                    "PAID_CAPABILITY_SOURCE_IMAGE_REJECTED",
                    "Source image could not be validated",
                    False,
                    status_code=422,
                )
            files.append(("image", (f"source-{index}", source_response.content, content_type)))
        response = self.client.post(
            f"{base_url}/images/edits",
            headers=_auth_headers(connection),
            data={
                "model": model,
                "prompt": payload["prompt"],
                "n": str(payload["count"]),
                "response_format": "url",
                "size": payload["size"],
                "quality": payload["quality"],
                # The Ozon workflow edits an existing product photograph. High
                # input fidelity tells compatible gateways to preserve the
                # source product's shape, colour and physical details instead
                # of re-imagining it from the category name.
                "input_fidelity": "high",
            },
            files=files,
            timeout=connection.timeout_seconds,
        )
        body = _json(response)
        _raise_remote(response, body)
        images = _image_urls(body)
        provider_cost = self._image_task_cost(body, base_url, connection)
        return PaidProviderResult(
            result={"images": images},
            usage=_usage(body, units=payload["count"]),
            provider_request_id=response.headers.get("x-request-id"),
            actual_provider_cost_micros=provider_cost,
            provider_cost_source="provider_task_credit_cost",
        )

    def _image_task_cost(
        self,
        generation_payload: dict[str, Any],
        base_url: str,
        connection: ApiPoolConnection,
    ) -> int:
        task_id = generation_payload.get("task_id")
        if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", task_id):
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE",
                "Image provider omitted its billing task identifier",
                None,
                status_code=503,
            )
        try:
            response = self.client.get(
                f"{base_url}/images/tasks/{task_id}",
                headers=_auth_headers(connection),
                timeout=min(30, connection.timeout_seconds),
            )
            task = response.json()
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE",
                "Image provider cost evidence is unavailable",
                None,
                status_code=503,
            ) from exc
        credit_cost = task.get("credit_cost") if isinstance(task, dict) else None
        if (
            not response.is_success
            or not isinstance(task, dict)
            or task.get("task_id") != task_id
            or task.get("status") != "success"
            or isinstance(credit_cost, bool)
            or not isinstance(credit_cost, int)
            or credit_cost < 0
        ):
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE",
                "Image provider cost evidence is invalid",
                None,
                status_code=503,
            )
        numerator = credit_cost * self.settings.paid_image_credit_cny_micros
        return (numerator + self.settings.paid_image_credit_scale - 1) // (
            self.settings.paid_image_credit_scale
        )

    def _seerfar(
        self,
        descriptor: PaidCapabilityDescriptor,
        payload: dict[str, Any],
        base_url: str,
        connection: ApiPoolConnection,
    ) -> PaidProviderResult:
        if not connection.api_key:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
                "Paid Seerfar provider is not configured",
                False,
                status_code=503,
            )
        path = _SEERFAR_PATHS.get(descriptor.capability)
        if path is None:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED",
                "Paid Seerfar operation is not configured",
                False,
                status_code=503,
            )
        response = self.client.post(
            f"{base_url}{path}",
            headers=_auth_headers(connection),
            json=payload["requestBody"],
            timeout=connection.timeout_seconds,
        )
        body = _json(response)
        remote_code = body.get("code")
        if not response.is_success or remote_code not in {None, 0, 200, "0", "200"}:
            _raise_remote(response, body)
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_REJECTED",
                "Seerfar rejected the request",
                False if remote_code not in {408, 425, 429, "408", "425", "429"} else None,
                provider_request_id=response.headers.get("x-request-id"),
                status_code=502,
                upstream_status=(
                    int(remote_code)
                    if str(remote_code).isdigit() and int(remote_code) in {408, 425, 429}
                    else response.status_code
                ),
            )
        return PaidProviderResult(
            result={"data": _signed_json_safe(body)},
            usage=ProviderUsage(units=1),
            provider_request_id=response.headers.get("x-request-id"),
        )

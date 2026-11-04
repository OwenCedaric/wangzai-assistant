from __future__ import annotations

import json

import httpx
import pytest

from app.config import Settings
from app.paid_capabilities.providers import (
    ApiPoolConnection,
    HttpPaidCapabilityProvider,
    PaidProviderFailure,
    _public_https_host,
)
from app.paid_capabilities.registry import get_paid_capability


def settings(**overrides: object) -> Settings:
    values = {
        "app_env": "test",
        "paid_text_base_url": "https://text.example/v1",
        "paid_text_api_key": "server-text-key",
        "paid_image_base_url": "https://images.example.invalid/v1",
        "paid_image_api_key": "server-image-key",
        "paid_seerfar_base_url": "https://seerfar.example",
        "paid_seerfar_api_key": "server-seerfar-key",
        "paid_provider_allowed_hosts": "text.example,images.example.invalid,seerfar.example",
        "paid_source_image_allowed_hosts": "oss.example",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def provider(handler, **overrides: object) -> HttpPaidCapabilityProvider:
    client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)
    return HttpPaidCapabilityProvider(settings(**overrides), client=client)


def test_text_provider_uses_only_server_key_and_returns_bounded_usage() -> None:
    observed: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        assert json.loads(request.read())["reasoning_effort"] == "medium"
        return httpx.Response(
            200,
            headers={"x-request-id": "remote-request"},
            json={
                "id": "completion-1",
                "choices": [{"message": {"content": "result"}}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 8},
            },
        )

    result = provider(handler).execute(
        get_paid_capability("text.product-description", 1),
        {"systemPrompt": "system", "userPrompt": "user"},
        provider_code="builtin-text",
        provider_model="gpt-5.6-sol",
    )
    assert len(observed) == 1
    assert str(observed[0].url) == "https://text.example/v1/chat/completions"
    assert observed[0].headers["authorization"] == "Bearer server-text-key"
    assert b"server-text-key" not in observed[0].content
    assert result.result == {"text": "result"}
    assert result.usage.input_tokens == 20
    assert result.usage.output_tokens == 8


def test_text_provider_enforces_json_object_when_server_prompt_requires_json() -> None:
    observed: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(json.loads(request.read()))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"ok":true}'}}],
                "usage": {"prompt_tokens": 2, "completion_tokens": 2},
            },
        )

    result = provider(handler).execute(
        get_paid_capability("text.product-description", 1),
        {
            "systemPrompt": "严格返回完整 JSON 对象。",
            "userPrompt": "按 JSON 输出属性结果。",
        },
        provider_code="builtin-text",
        provider_model="gpt-5.6-terra",
    )

    assert observed[0]["response_format"] == {"type": "json_object"}
    assert "json" in observed[0]["messages"][0]["content"]
    assert result.result == {"text": '{"ok":true}'}


def test_openclaw_text_provider_preserves_tool_calls_and_forces_non_streaming() -> None:
    observed: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(json.loads(request.read()))
        return httpx.Response(
            200,
            json={
                "id": "completion-tool-1",
                "model": "gpt-5.6-terra",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call-1",
                                    "type": "function",
                                    "function": {
                                        "name": "wangzai_read_orders",
                                        "arguments": '{"limit":5}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {
                    "prompt_tokens": 40,
                    "completion_tokens": 12,
                    "prompt_tokens_details": {"cached_tokens": 8},
                },
            },
        )

    result = provider(handler).execute(
        get_paid_capability("text.openclaw-chat", 1),
        {
            "requestBody": {
                "model": "client-placeholder",
                "messages": [{"role": "user", "content": "查看订单"}],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "wangzai_read_orders",
                            "parameters": {"type": "object"},
                        },
                    }
                ],
                "stream": False,
            }
        },
        provider_code="builtin-text",
        provider_model="gpt-5.6-terra",
    )
    assert observed[0]["model"] == "gpt-5.6-terra"
    assert observed[0]["stream"] is False
    assert result.result["response"]["choices"][0]["message"]["tool_calls"][0][
        "function"
    ]["name"] == "wangzai_read_orders"
    assert result.usage.input_tokens == 40
    assert result.usage.output_tokens == 12
    assert result.usage.cached_input_tokens == 8


def test_admin_managed_pool_endpoint_does_not_require_static_env_allowlist() -> None:
    observed: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "managed result"}}],
                "usage": {"prompt_tokens": 2, "completion_tokens": 1},
            },
        )

    runtime = provider(handler)
    result = runtime.execute_with_connection(
        get_paid_capability("text.product-description", 1),
        {"systemPrompt": "system", "userPrompt": "user"},
        provider_code="managed-provider",
        provider_model="gpt-5.6-sol",
        connection=ApiPoolConnection(
            base_url="https://replacement.example/v1",
            api_key="server-managed-key",
            adapter="openai-compatible",
            managed_by_api_pool=True,
        ),
    )
    assert result.result == {"text": "managed result"}
    assert str(observed[0].url) == "https://replacement.example/v1/chat/completions"


def test_provider_post_is_not_retried_when_network_outcome_is_unknown() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("unknown", request=request)

    with pytest.raises(PaidProviderFailure) as failure:
        provider(handler).execute(
            get_paid_capability("image.generate", 1),
            {
                "prompt": "product",
                "size": "1024x1024",
                "quality": "high",
                "count": 1,
                "shopId": "shop-1",
            },
            provider_code="builtin-image",
            provider_model="gpt-image-2",
        )
    assert calls == 1
    assert failure.value.code == "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN"
    assert failure.value.billable is None


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_known_provider_rejection_is_unbilled(status: int) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "rejected"}})

    with pytest.raises(PaidProviderFailure) as failure:
        provider(handler).execute(
            get_paid_capability("text.product-description", 1),
            {"systemPrompt": "system", "userPrompt": "user"},
            provider_code="builtin-text",
            provider_model="gpt-5.6-sol",
        )
    assert failure.value.billable is False


@pytest.mark.parametrize("status", [408, 425, 429, 500, 502, 503, 504])
def test_ambiguous_provider_rejection_keeps_reconciliation_reservation(status: int) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "uncertain"}})

    with pytest.raises(PaidProviderFailure) as failure:
        provider(handler).execute(
            get_paid_capability("text.product-description", 1),
            {"systemPrompt": "system", "userPrompt": "user"},
            provider_code="builtin-text",
            provider_model="gpt-5.6-sol",
        )
    assert failure.value.billable is None


def test_image_provider_rejects_unbounded_or_non_https_result() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"url": "http://unsafe.example/image.png"}]})

    with pytest.raises(PaidProviderFailure) as failure:
        provider(handler).execute(
            get_paid_capability("image.generate", 1),
            {
                "prompt": "product",
                "size": "1024x1024",
                "quality": "high",
                "count": 1,
                "shopId": "shop-1",
            },
            provider_code="builtin-image",
            provider_model="gpt-image-2",
        )
    assert failure.value.code == "PAID_CAPABILITY_PROVIDER_RESPONSE_INVALID"
    assert failure.value.billable is True


def test_image_provider_reads_exact_task_credit_cost() -> None:
    observed: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        if request.method == "POST":
            return httpx.Response(
                200,
                json={
                    "task_id": "img_exact_cost_1",
                    "data": [{"url": "https://image.example/result.png"}],
                },
            )
        return httpx.Response(
            200,
            json={
                "task_id": "img_exact_cost_1",
                "status": "success",
                "credit_cost": 15_840,
            },
        )

    result = provider(handler).execute(
        get_paid_capability("image.generate", 1),
        {
            "prompt": "product",
            "size": "1024x1024",
            "quality": "high",
            "count": 1,
            "shopId": "shop-1",
        },
        provider_code="builtin-image",
        provider_model="gpt-image-2",
    )
    assert [request.method for request in observed] == ["POST", "GET"]
    assert str(observed[1].url) == (
        "https://images.example.invalid/v1/images/tasks/img_exact_cost_1"
    )
    assert result.actual_provider_cost_micros == 13_775
    assert result.provider_cost_source == "provider_task_credit_cost"


def test_image_edit_requests_high_input_fidelity(monkeypatch) -> None:
    observed_edit_body = b""

    monkeypatch.setattr(
        "app.paid_capabilities.providers.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(None, None, None, None, ("93.184.216.34", 443))],
    )

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal observed_edit_body
        if request.method == "GET" and request.url.host == "oss.example":
            return httpx.Response(200, content=b"image-bytes", headers={"content-type": "image/png"})
        if request.method == "POST":
            observed_edit_body = request.read()
            return httpx.Response(
                200,
                json={
                    "task_id": "img_edit_fidelity_1",
                    "data": [{"url": "https://image.example/result.png"}],
                },
            )
        return httpx.Response(
            200,
            json={"task_id": "img_edit_fidelity_1", "status": "success", "credit_cost": 15_840},
        )

    provider(handler).execute(
        get_paid_capability("image.edit", 1),
        {
            "prompt": "只替换背景并保持商品外形",
            "sourceImageUrls": ["https://oss.example/source.png"],
            "size": "1024x1024",
            "quality": "high",
            "count": 1,
            "shopId": "shop-1",
        },
        provider_code="builtin-image",
        provider_model="gpt-image-2",
    )

    assert b'name="input_fidelity"' in observed_edit_body
    assert b"high" in observed_edit_body


def test_seerfar_uses_exact_operation_path_and_converts_floats_for_signed_json() -> None:
    observed: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        return httpx.Response(200, json={"code": 200, "data": {"score": 4.75}})

    result = provider(handler).execute(
        get_paid_capability("external.seerfar.product-detail", 1),
        {"requestBody": {"sku": "123"}},
        provider_code="seerfar",
        provider_model="",
    )
    assert str(observed[0].url) == ("https://seerfar.example/open-api/product/detail/search/ozon")
    assert observed[0].headers["authorization"] == "Bearer server-seerfar-key"
    assert result.result["data"]["data"]["score"] == "4.75"
    assert result.usage.units == 1


@pytest.mark.parametrize(
    "unsafe_url",
    [
        "http://text.example/v1",
        "https://user:pass@text.example/v1",
        "https://not-allowlisted.example/v1",
        "https://text.example/v1?api_key=leak",
    ],
)
def test_provider_rejects_unsafe_configured_base_url(unsafe_url: str) -> None:
    with pytest.raises(ValueError, match="allowlisted"):
        provider(lambda _request: httpx.Response(200, json={}), paid_text_base_url=unsafe_url)


def test_source_image_rejects_private_or_proxy_fake_ip_by_default(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.paid_capabilities.providers.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(None, None, None, None, ("198.18.1.76", 443))],
    )
    with pytest.raises(PaidProviderFailure) as failure:
        _public_https_host("https://oss.example/source.png", {"oss.example"})
    assert failure.value.code == "PAID_CAPABILITY_SOURCE_IMAGE_REJECTED"


def test_source_image_allows_only_explicit_proxy_fake_ip_mode(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.paid_capabilities.providers.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(None, None, None, None, ("198.18.1.76", 443))],
    )
    assert (
        _public_https_host(
            "https://oss.example/source.png",
            {"oss.example"},
            allow_proxy_fake_ip=True,
        )
        == "https://oss.example/source.png"
    )


def test_source_image_still_rejects_rfc1918_when_proxy_mode_is_enabled(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.paid_capabilities.providers.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(None, None, None, None, ("10.0.0.8", 443))],
    )
    with pytest.raises(PaidProviderFailure):
        _public_https_host(
            "https://oss.example/source.png",
            {"oss.example"},
            allow_proxy_fake_ip=True,
        )

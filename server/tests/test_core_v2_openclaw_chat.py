from __future__ import annotations

from types import SimpleNamespace

import httpx

from app.core_v2.openclaw_chat import (
    execute_byok_openclaw_chat,
    execute_paid_openclaw_chat,
)
from app.schemas.core_v2 import OpenClawChatExecutionRequest


def _payload(**updates) -> OpenClawChatExecutionRequest:
    values = {
        "request_id": "wechat-openclaw-request-1",
        "model": "custom-chat-model",
        "request_body": {
            "model": "custom-chat-model",
            "messages": [{"role": "user", "content": "读取今天的订单摘要"}],
            "tools": [],
            "stream": False,
        },
        "byok": {
            "account_id": "saved-model-account",
            "base_url": "https://relay.example/v1",
            "api_key": "temporary-byok-secret",
            "model": "custom-chat-model",
        },
    }
    values.update(updates)
    return OpenClawChatExecutionRequest(**values)


def test_openclaw_byok_supports_saved_custom_model_without_points() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["authorization"] == "Bearer temporary-byok-secret"
        return httpx.Response(
            200,
            json={
                "id": "reply-1",
                "model": "custom-chat-model",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "订单摘要"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 4},
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = execute_byok_openclaw_chat(
            _payload(),
            resolver=lambda _hostname: ["93.184.216.34"],
            client=client,
        )

    assert result["billing"] is None
    assert result["account_id"] == "saved-model-account"
    assert result["response"]["choices"][0]["message"]["content"] == "订单摘要"
    assert "temporary-byok-secret" not in str(result)
    assert [request.url.path for request in requests] == ["/v1/chat/completions"]


def test_paid_openclaw_uses_server_ledger_and_discards_plain_result(monkeypatch) -> None:
    descriptor = SimpleNamespace(
        capability="text.openclaw-chat",
        version=1,
        normalize=lambda value: value,
    )
    job = SimpleNamespace(
        result_json={
            "response": {
                "id": "reply-paid",
                "model": "gpt-5.6-terra",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "经营摘要"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5},
            }
        },
        reservation=SimpleNamespace(settled_points=7),
    )
    observed = {}

    class Database:
        commits = 0

        def commit(self):
            self.commits += 1

    database = Database()
    monkeypatch.setattr("app.core_v2.openclaw_chat.get_paid_capability", lambda *_args: descriptor)
    monkeypatch.setattr(
        "app.core_v2.openclaw_chat.issue_quote",
        lambda *_args, **_kwargs: SimpleNamespace(id="quote-1"),
    )
    monkeypatch.setattr("app.core_v2.openclaw_chat.paid_input_hash", lambda _value: "sha256:input")

    def execute(*_args, **kwargs):
        observed.update(kwargs)
        return job

    monkeypatch.setattr("app.core_v2.openclaw_chat.execute_paid_capability", execute)
    payload = _payload(
        model="gpt-5.6-terra",
        request_body={
            "model": "gpt-5.6-terra",
            "messages": [{"role": "user", "content": "经营摘要"}],
            "stream": False,
        },
        byok=None,
    )
    result = execute_paid_openclaw_chat(
        payload,
        db=database,
        user_id=10,
        project_id=20,
        settings=SimpleNamespace(
            paid_capability_quote_ttl_seconds=30,
            paid_text_reservation_multiplier_ppm=1_250_000,
            paid_image_reservation_multiplier_ppm=2_000_000,
        ),
        provider=object(),
    )

    assert result["billing"] == {"chargedPoints": 7, "source": "paid-cloud"}
    assert result["response"]["choices"][0]["message"]["content"] == "经营摘要"
    assert observed["idempotency_key"].startswith("core-v2:")
    assert database.commits == 1
    assert job.result_json["retained"] is False
    assert "经营摘要" not in str(job.result_json)

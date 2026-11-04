from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core_v2.text_model import (
    TextModelExecutionFailure,
    execute_byok_text_model,
    execute_paid_text_model,
)
from app.schemas.core_v2 import TextModelExecutionRequest
from tests.helpers import create_user, login_user


def _payload(**updates) -> TextModelExecutionRequest:
    values = {
        "capability": "text.image-plan",
        "request_id": "request-12345678",
        "system_prompt": "只根据真实商品信息生成图片方案。",
        "user_prompt": "商品：保温杯。",
        "reference_images": ["https://assets.example/source.webp"],
        "byok": {
            "account_id": "model-account",
            "base_url": "https://relay.example/v1",
            "api_key": "temporary-model-secret",
            "model": "gpt-5.6-terra",
        },
    }
    values.update(updates)
    return TextModelExecutionRequest(**values)


def test_byok_text_execution_is_stateless_and_returns_only_public_output() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer temporary-model-secret"
        body = request.read().decode()
        assert "只根据真实商品信息" in body
        assert "https://assets.example/source.webp" in body
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "图片方案正文"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20, "ignored": "x"},
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = execute_byok_text_model(
            _payload(),
            resolver=lambda _hostname: ["93.184.216.34"],
            client=client,
        )

    assert result["text"] == "图片方案正文"
    assert result["model"] == "gpt-5.6-terra"
    assert result["account_id"] == "model-account"
    assert result["reference_image_count"] == 1
    assert result["usage"] == {"prompt_tokens": 10, "completion_tokens": 20}
    assert "temporary-model-secret" not in str(result)
    assert [request.url.path for request in requests] == ["/v1/chat/completions"]


def test_byok_text_execution_rejects_private_model_targets() -> None:
    transport = httpx.MockTransport(lambda _request: httpx.Response(500))
    with httpx.Client(transport=transport) as client:
        with pytest.raises(TextModelExecutionFailure) as captured:
            execute_byok_text_model(
                _payload(
                    byok={
                        "account_id": "model-account",
                        "base_url": "https://relay.example/v1",
                        "api_key": "secret",
                        "model": "gpt-5.6-terra",
                    }
                ),
                resolver=lambda _hostname: ["10.0.0.8"],
                client=client,
            )
    assert captured.value.code == "MODEL_API_PRIVATE_ADDRESS_FORBIDDEN"


@pytest.mark.parametrize("model", ["gpt-5.5", "gpt-5.6-luna", "gpt-4o"])
def test_text_request_rejects_every_model_outside_the_two_model_policy(model: str) -> None:
    with pytest.raises(ValidationError):
        TextModelExecutionRequest(
            capability="text.product-description",
            request_id="blocked-model-request",
            system_prompt="只处理真实数据。",
            user_prompt="商品：保温杯。",
            model=model,
        )


@pytest.mark.parametrize("effort", ["xhigh", "max", "ultra"])
def test_text_request_rejects_reasoning_effort_outside_approved_range(effort: str) -> None:
    with pytest.raises(ValidationError):
        TextModelExecutionRequest(
            capability="text.product-description",
            request_id="blocked-effort-request",
            system_prompt="只处理真实数据。",
            user_prompt="商品：保温杯。",
            reasoning_effort=effort,
        )


@pytest.mark.parametrize("effort", ["low", "medium", "high"])
def test_text_request_accepts_approved_reasoning_efforts(effort: str) -> None:
    payload = TextModelExecutionRequest(
        capability="text.product-description",
        request_id="allowed-effort-request",
        system_prompt="只处理真实数据。",
        user_prompt="商品：保温杯。",
        model="gpt-5.6-sol",
        reasoning_effort=effort,
    )
    assert payload.model == "gpt-5.6-sol"
    assert payload.reasoning_effort == effort


def test_paid_text_execution_keeps_only_a_result_digest_in_management_storage(
    monkeypatch,
) -> None:
    observed = {}
    descriptor = SimpleNamespace(
        normalize=lambda value: {**value},
        capability="text.product-description",
        version=1,
    )
    quote = SimpleNamespace(id="quote-1")
    job = SimpleNamespace(
        result_json={"text": "积分模型正文"},
        reservation=SimpleNamespace(settled_points=12),
    )

    class Database:
        commits = 0

        def commit(self):
            self.commits += 1

    database = Database()
    monkeypatch.setattr("app.core_v2.text_model.get_paid_capability", lambda *_args: descriptor)

    def create_quote(*_args, **kwargs):
        observed["requested_model"] = kwargs.get("requested_model")
        return quote

    monkeypatch.setattr("app.core_v2.text_model.issue_quote", create_quote)
    monkeypatch.setattr("app.core_v2.text_model.paid_input_hash", lambda _value: "sha256:input")

    def execute(*_args, **kwargs):
        observed.update(kwargs)
        return job

    monkeypatch.setattr("app.core_v2.text_model.execute_paid_capability", execute)
    payload = TextModelExecutionRequest(
        capability="text.product-description",
        request_id="paid-request-12345678",
        system_prompt="只根据真实字段生成。",
        user_prompt="商品：保温杯。",
    )
    result = execute_paid_text_model(
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

    assert result["text"] == "积分模型正文"
    assert result["billing"] == {"chargedPoints": 12, "source": "paid-cloud"}
    assert observed["idempotency_key"].startswith("core-v2:")
    assert observed["requested_model"] == "gpt-5.6-terra"
    assert database.commits == 1
    assert job.result_json["retained"] is False
    assert job.result_json["resultSha256"].startswith("sha256:")
    assert "积分模型正文" not in str(job.result_json)


def test_text_model_route_requires_login(client: TestClient) -> None:
    response = client.post(
        "/api/core-v2/text-model/execute",
        json=_payload().model_dump(mode="json"),
    )
    assert response.status_code == 401


def test_text_model_route_returns_no_byok_secret(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    create_user(client, admin_headers)
    headers = login_user(client)
    license_record = SimpleNamespace(
        plan=SimpleNamespace(
            permissions=[SimpleNamespace(code="products.view", status="active")],
            product=SimpleNamespace(project=SimpleNamespace(id=1)),
        )
    )
    observed = {}

    monkeypatch.setattr(
        "app.api.core_v2.get_active_principal_license",
        lambda _db, _principal: license_record,
    )

    def execute(payload, **_kwargs):
        observed["api_key"] = payload.byok.api_key.get_secret_value()
        return {
            "ok": True,
            "text": "商品描述正文",
            "model": payload.byok.model,
            "account_id": payload.byok.account_id,
            "usage": None,
            "billing": None,
            "reference_image_count": 0,
        }

    monkeypatch.setattr("app.api.core_v2.execute_byok_text_model", execute)
    payload = _payload(
        capability="text.product-description",
        reference_images=[],
    )
    response = client.post(
        "/api/core-v2/text-model/execute",
        headers=headers,
        json={
            **payload.model_dump(mode="json"),
            "byok": {
                **payload.model_dump(mode="json")["byok"],
                "api_key": "temporary-model-secret",
            },
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["text"] == "商品描述正文"
    assert observed == {"api_key": "temporary-model-secret"}
    assert "temporary-model-secret" not in response.text

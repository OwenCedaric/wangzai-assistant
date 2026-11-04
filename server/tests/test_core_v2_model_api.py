from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core_v2.model_api import ModelApiDiscoveryFailure, discover_model_api
from app.schemas.core_v2 import ModelApiDiscoveryRequest
from tests.helpers import create_user, login_user


def _request() -> ModelApiDiscoveryRequest:
    return ModelApiDiscoveryRequest(
        website_url="https://relay.example/dashboard",
        api_key="model-api-secret-marker",
        api_alias="主中转",
    )


def test_model_api_discovery_is_stateless_and_normalizes_models() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer model-api-secret-marker"
        assert request.headers["X-API-Key"] == "model-api-secret-marker"
        if request.url.path == "/v1/models":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"id": "gpt-image-2", "modalities": ["text", "image"]},
                        {"id": "gpt-5.5", "capabilities": ["chat"]},
                    ]
                },
            )
        return httpx.Response(404, json={})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = discover_model_api(
            _request(),
            resolver=lambda _hostname: ["93.184.216.34"],
            client=client,
            now=lambda: datetime(2026, 8, 20, tzinfo=UTC),
        )

    updates = result["updates"]
    assert updates["discoveryVerified"] is True
    assert updates["baseUrl"] == "https://relay.example/v1"
    assert updates["defaultModel"] == "gpt-image-2"
    assert updates["availableModels"][0]["id"] == "gpt-image-2"
    assert "image-generation" in updates["capabilities"]
    assert "model-api-secret-marker" not in str(result)
    assert [request.url.path for request in requests] == ["/v1/models"]


@pytest.mark.parametrize(
    "website_url,addresses",
    [
        ("https://127.0.0.1/dashboard", []),
        ("https://relay.example/dashboard", ["10.0.0.8"]),
        ("http://relay.example/dashboard", ["93.184.216.34"]),
    ],
)
def test_model_api_discovery_blocks_private_or_plaintext_targets(
    website_url: str,
    addresses: list[str],
) -> None:
    with pytest.raises(ModelApiDiscoveryFailure) as captured:
        discover_model_api(
            ModelApiDiscoveryRequest(website_url=website_url, api_key="secret"),
            resolver=lambda _hostname: addresses,
            client=httpx.Client(
                transport=httpx.MockTransport(lambda _request: httpx.Response(500))
            ),
        )
    assert captured.value.code in {
        "MODEL_API_PRIVATE_ADDRESS_FORBIDDEN",
        "MODEL_API_WEBSITE_URL_INVALID",
    }


def test_model_api_discovery_route_requires_login(client: TestClient) -> None:
    response = client.post(
        "/api/core-v2/model-api/discover",
        json={"website_url": "https://relay.example", "api_key": "secret"},
    )
    assert response.status_code == 401


def test_model_api_discovery_route_returns_only_public_updates(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    create_user(client, admin_headers)
    headers = login_user(client)
    observed: dict[str, str] = {}

    monkeypatch.setattr(
        "app.api.core_v2.get_active_principal_license",
        lambda _db, _principal: object(),
    )

    def execute(payload, **_kwargs):
        observed["api_key"] = payload.api_key.get_secret_value()
        return {
            "updates": {
                "apiAlias": "主中转",
                "baseUrl": "https://relay.example/v1",
                "availableModels": [],
                "capabilities": [],
                "discoveryVerified": False,
            }
        }

    monkeypatch.setattr("app.api.core_v2.discover_model_api", execute)
    response = client.post(
        "/api/core-v2/model-api/discover",
        headers=headers,
        json={
            "website_url": "https://relay.example/dashboard",
            "api_key": "temporary-model-secret",
            "api_alias": "主中转",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["updates"]["apiAlias"] == "主中转"
    assert observed == {"api_key": "temporary-model-secret"}
    assert "temporary-model-secret" not in response.text

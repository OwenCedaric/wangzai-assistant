from __future__ import annotations

from datetime import UTC, datetime

import httpx

from app.paid_capabilities.api_pool_service import (
    ApiPoolDispatchError,
    acquire_api_credential,
    release_api_credential,
)
from app.paid_capabilities.providers import PaidProviderFailure


def test_admin_only_enters_url_and_key_then_models_are_discovered(client, admin_headers) -> None:
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        assert request.headers["Authorization"] == "Bearer sk-test-fixture-auto-connect-never-return"
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "gpt-5.6-sol"},
                    {"id": "gpt-5.6-luna"},
                    {"id": "gpt-image-2"},
                ]
            },
        )

    discovery_client = httpx.Client(transport=httpx.MockTransport(handler))
    client.app.state.api_pool_discovery_client = discovery_client
    try:
        response = client.post(
            "/api/admin/api-pool/auto-connect",
            headers=admin_headers,
            json={
                "base_url": "https://api.openai.com/keys",
                "api_key": "sk-test-fixture-auto-connect-never-return",
            },
        )
        assert response.status_code == 201, response.text
        result = response.json()
        assert result["normalized_base_url"] == "https://api.openai.com/v1"
        assert result["provider_created"] is True
        assert result["key_created"] is True
        assert result["discovered_model_count"] == 3
        assert {item["capability_kind"] for item in result["models"]} == {
            "text",
            "image",
        }
        assert requested_urls == ["https://api.openai.com/v1/models"]
        statuses = {item["model_code"]: item["status"] for item in result["models"]}
        assert statuses["gpt-5.6-sol"] == "active"
        assert statuses["gpt-5.6-luna"] == "disabled"
        assert statuses["gpt-image-2"] == "active"
        assert "never-return" not in response.text

        duplicate = client.post(
            "/api/admin/api-pool/auto-connect",
            headers=admin_headers,
            json={
                "base_url": "https://api.openai.com/v1",
                "api_key": "sk-test-fixture-auto-connect-never-return",
            },
        )
        assert duplicate.status_code == 201, duplicate.text
        assert duplicate.json()["provider_created"] is False
        assert duplicate.json()["key_created"] is False
        summary = client.get("/api/admin/api-pool/summary", headers=admin_headers)
        assert summary.json()["provider_count"] == 1
        assert summary.json()["key_count"] == 1
        assert summary.json()["model_count"] == 3
    finally:
        discovery_client.close()
        del client.app.state.api_pool_discovery_client


def test_admin_cannot_create_or_reenable_a_text_model_outside_server_policy(
    client, admin_headers
) -> None:
    provider = create_provider(client, admin_headers, code="policy-guard")
    provider_id = int(provider["id"])
    blocked_create = client.post(
        f"/api/admin/api-pool/providers/{provider_id}/models",
        headers=admin_headers,
        json={
            "capability_kind": "text",
            "model_code": "gpt-5.6-luna",
            "display_name": "GPT 5.6 Luna",
            "priority": 100,
        },
    )
    assert blocked_create.status_code == 422

    discovery_client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"data": [{"id": "gpt-5.6-luna"}]})
        )
    )
    client.app.state.api_pool_discovery_client = discovery_client
    try:
        connected = client.post(
            "/api/admin/api-pool/auto-connect",
            headers=admin_headers,
            json={
                "base_url": "https://api.openai.com/v1",
                "api_key": "sk-test-fixture-policy-guard-never-return",
            },
        )
        assert connected.status_code == 201, connected.text
        blocked = next(
            item for item in connected.json()["models"] if item["model_code"] == "gpt-5.6-luna"
        )
        assert blocked["status"] == "disabled"
        reenable = client.put(
            f"/api/admin/api-pool/models/{blocked['id']}",
            headers=admin_headers,
            json={
                "display_name": "GPT 5.6 Luna",
                "priority": 100,
                "status": "active",
            },
        )
        assert reenable.status_code == 422
    finally:
        discovery_client.close()
        del client.app.state.api_pool_discovery_client


def test_auto_connect_failure_does_not_leave_partial_pool_configuration(
    client, admin_headers
) -> None:
    discovery_client = httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(401))
    )
    client.app.state.api_pool_discovery_client = discovery_client
    try:
        response = client.post(
            "/api/admin/api-pool/auto-connect",
            headers=admin_headers,
            json={
                "base_url": "https://api.openai.com/v1",
                "api_key": "sk-test-fixture-invalid-never-return",
            },
        )
        assert response.status_code == 422
        assert "never-return" not in response.text
        summary = client.get("/api/admin/api-pool/summary", headers=admin_headers)
        assert summary.json()["provider_count"] == 0
        assert summary.json()["key_count"] == 0
        assert summary.json()["model_count"] == 0
    finally:
        discovery_client.close()
        del client.app.state.api_pool_discovery_client


def test_auto_connect_accepts_public_domain_when_proxy_dns_uses_reserved_fake_ip(
    client, admin_headers
) -> None:
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        return httpx.Response(200, json={"data": [{"id": "gpt-image-2"}]})

    discovery_client = httpx.Client(transport=httpx.MockTransport(handler))
    client.app.state.api_pool_discovery_client = discovery_client
    try:
        response = client.post(
            "/api/admin/api-pool/auto-connect",
            headers=admin_headers,
            json={
                "base_url": "https://images.example.invalid/",
                "api_key": "sk-test-fixture-image-api-never-return",
            },
        )
        assert response.status_code == 201, response.text
        assert requested_urls == ["https://images.example.invalid/v1/models"]
        assert response.json()["models"][0]["capability_kind"] == "image"
        assert "never-return" not in response.text
    finally:
        discovery_client.close()
        del client.app.state.api_pool_discovery_client


def create_provider(client, admin_headers, *, code: str = "pool-text") -> dict[str, object]:
    response = client.post(
        "/api/admin/api-pool/providers",
        headers=admin_headers,
        json={
            "code": code,
            "name": "文本接口池",
            "adapter": "openai-compatible",
            "base_url": "https://api.openai.com/v1",
            "auth_scheme": "bearer",
            "auth_header_name": "Authorization",
            "capability_kinds": ["text"],
            "timeout_seconds": 60,
            "priority": 100,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_key(client, admin_headers, provider_id: int, index: int) -> dict[str, object]:
    response = client.post(
        f"/api/admin/api-pool/providers/{provider_id}/keys",
        headers=admin_headers,
        json={
            "label": f"Key {index}",
            "secret": f"sk-test-fixture-api-pool-secret-{index:02d}-never-return",
            "weight": 100,
            "max_concurrency": 1,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_admin_can_manage_expandable_provider_model_and_five_key_pool(
    client, admin_headers
) -> None:
    provider = create_provider(client, admin_headers)
    provider_id = provider["id"]
    model_response = client.post(
        f"/api/admin/api-pool/providers/{provider_id}/models",
        headers=admin_headers,
        json={
            "capability_kind": "text",
            "model_code": "gpt-5.6-sol",
            "display_name": "GPT 5.6 Sol",
            "priority": 100,
        },
    )
    assert model_response.status_code == 201, model_response.text

    keys = [create_key(client, admin_headers, provider_id, index) for index in range(1, 6)]
    serialized = str(keys)
    assert "never-return" not in serialized
    assert "secret_ciphertext" not in serialized
    assert all(item["masked_hint"].endswith("turn") for item in keys)

    duplicate = client.post(
        f"/api/admin/api-pool/providers/{provider_id}/keys",
        headers=admin_headers,
        json={
            "label": "duplicate",
            "secret": "sk-test-fixture-api-pool-secret-01-never-return",
            "weight": 100,
            "max_concurrency": 1,
        },
    )
    assert duplicate.status_code == 409
    assert "never-return" not in duplicate.text

    summary = client.get("/api/admin/api-pool/summary", headers=admin_headers)
    assert summary.status_code == 200
    assert summary.json() == {
        "provider_count": 1,
        "active_provider_count": 1,
        "key_count": 5,
        "available_key_count": 5,
        "cooling_key_count": 0,
        "invalid_key_count": 0,
        "model_count": 1,
        "active_lease_count": 0,
    }

    listed = client.get(f"/api/admin/api-pool/providers/{provider_id}/keys", headers=admin_headers)
    assert listed.status_code == 200
    assert len(listed.json()) == 5
    assert "secret" not in listed.text.lower()


def test_admin_can_verify_and_hot_replace_provider_endpoint(client, admin_headers) -> None:
    provider = create_provider(client, admin_headers, code="codesonline")
    provider_id = int(provider["id"])
    model_response = client.post(
        f"/api/admin/api-pool/providers/{provider_id}/models",
        headers=admin_headers,
        json={
            "capability_kind": "text",
            "model_code": "gpt-5.6-sol",
            "display_name": "GPT 5.6 Sol",
            "priority": 100,
        },
    )
    assert model_response.status_code == 201, model_response.text
    create_key(client, admin_headers, provider_id, 1)

    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        assert request.headers["Authorization"] == "Bearer sk-test-fixture-api-pool-secret-01-never-return"
        if request.url.path == "/v1/usage":
            return httpx.Response(
                200,
                json={
                    "unit": "USD",
                    "usage": {"total": {"requests": 12, "actual_cost": "1.23"}},
                },
            )
        return httpx.Response(200, json={"data": [{"id": "gpt-5.6-sol"}]})

    discovery_client = httpx.Client(transport=httpx.MockTransport(handler))
    client.app.state.api_pool_discovery_client = discovery_client
    try:
        response = client.put(
            f"/api/admin/api-pool/providers/{provider_id}/endpoint",
            headers=admin_headers,
            json={"base_url": "https://replacement.example/v1"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["base_url"] == "https://replacement.example/v1"
        assert requested_urls == [
            "https://replacement.example/v1/models",
            "https://replacement.example/v1/usage",
        ]

        acquired = acquire_api_credential(
            client.app.state.session_factory,
            client.app.state.settings,
            provider_code="codesonline",
            capability_kind="text",
            provider_model="gpt-5.6-sol",
        )
        assert acquired is not None
        assert acquired.connection.base_url == "https://replacement.example/v1"
        assert acquired.connection.managed_by_api_pool is True
        release_api_credential(client.app.state.session_factory, acquired)
    finally:
        discovery_client.close()
        del client.app.state.api_pool_discovery_client


def test_codesonline_endpoint_replacement_requires_billing_usage_endpoint(
    client, admin_headers
) -> None:
    provider = create_provider(client, admin_headers, code="codesonline")
    provider_id = int(provider["id"])
    client.post(
        f"/api/admin/api-pool/providers/{provider_id}/models",
        headers=admin_headers,
        json={
            "capability_kind": "text",
            "model_code": "gpt-5.6-sol",
            "display_name": "GPT 5.6 Sol",
            "priority": 100,
        },
    )
    create_key(client, admin_headers, provider_id, 1)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "gpt-5.6-sol"}]})
        return httpx.Response(404, json={"error": {"message": "not found"}})

    discovery_client = httpx.Client(transport=httpx.MockTransport(handler))
    client.app.state.api_pool_discovery_client = discovery_client
    try:
        response = client.put(
            f"/api/admin/api-pool/providers/{provider_id}/endpoint",
            headers=admin_headers,
            json={"base_url": "https://replacement.example/v1"},
        )
        assert response.status_code == 422
        assert "计费状态接口不可用" in response.text
        listed = client.get("/api/admin/api-pool/providers", headers=admin_headers)
        current = next(item for item in listed.json() if item["id"] == provider_id)
        assert current["base_url"] == "https://api.openai.com/v1"
    finally:
        discovery_client.close()
        del client.app.state.api_pool_discovery_client


def test_endpoint_replacement_rejects_address_missing_active_models(client, admin_headers) -> None:
    provider = create_provider(client, admin_headers, code="model-guard")
    provider_id = int(provider["id"])
    client.post(
        f"/api/admin/api-pool/providers/{provider_id}/models",
        headers=admin_headers,
        json={
            "capability_kind": "text",
            "model_code": "gpt-5.6-sol",
            "display_name": "GPT 5.6 Sol",
            "priority": 100,
        },
    )
    create_key(client, admin_headers, provider_id, 1)
    discovery_client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"data": [{"id": "gpt-5.6-terra"}]})
        )
    )
    client.app.state.api_pool_discovery_client = discovery_client
    try:
        response = client.put(
            f"/api/admin/api-pool/providers/{provider_id}/endpoint",
            headers=admin_headers,
            json={"base_url": "https://wrong-models.example/v1"},
        )
        assert response.status_code == 409
        assert "gpt-5.6-sol" in response.text
        listed = client.get("/api/admin/api-pool/providers", headers=admin_headers)
        current = next(item for item in listed.json() if item["id"] == provider_id)
        assert current["base_url"] == "https://api.openai.com/v1"
    finally:
        discovery_client.close()
        del client.app.state.api_pool_discovery_client


def test_pool_dispatches_independent_keys_and_cools_only_the_throttled_key(
    client, admin_headers
) -> None:
    provider = create_provider(client, admin_headers, code="pool-rotate")
    provider_id = int(provider["id"])
    client.post(
        f"/api/admin/api-pool/providers/{provider_id}/models",
        headers=admin_headers,
        json={
            "capability_kind": "text",
            "model_code": "gpt-5.6-sol",
            "display_name": "GPT 5.6 Sol",
            "priority": 100,
        },
    )
    for index in range(1, 6):
        create_key(client, admin_headers, provider_id, index)

    factory = client.app.state.session_factory
    settings = client.app.state.settings
    acquired = [
        acquire_api_credential(
            factory,
            settings,
            provider_code="pool-rotate",
            capability_kind="text",
            provider_model="gpt-5.6-sol",
        )
        for _ in range(5)
    ]
    assert len({item.key_id for item in acquired if item is not None}) == 5
    try:
        acquire_api_credential(
            factory,
            settings,
            provider_code="pool-rotate",
            capability_kind="text",
            provider_model="gpt-5.6-sol",
        )
    except ApiPoolDispatchError as exc:
        assert exc.code == "PAID_CAPABILITY_API_POOL_BUSY"
    else:
        raise AssertionError("sixth request must not overrun five one-slot keys")

    first = acquired[0]
    assert first is not None
    release_api_credential(
        factory,
        first,
        failure=PaidProviderFailure(
            "PAID_CAPABILITY_PROVIDER_REJECTED",
            "rate limited",
            None,
            upstream_status=429,
            retry_after_seconds=90,
        ),
        now=datetime.now(UTC),
    )
    for item in acquired[1:]:
        assert item is not None
        release_api_credential(factory, item)

    next_item = acquire_api_credential(
        factory,
        settings,
        provider_code="pool-rotate",
        capability_kind="text",
        provider_model="gpt-5.6-sol",
    )
    assert next_item is not None
    assert next_item.key_id != first.key_id
    release_api_credential(factory, next_item)


def test_zero_concurrency_means_no_software_limit(client, admin_headers) -> None:
    provider = create_provider(client, admin_headers, code="pool-unlimited")
    provider_id = int(provider["id"])
    client.post(
        f"/api/admin/api-pool/providers/{provider_id}/models",
        headers=admin_headers,
        json={
            "capability_kind": "text",
            "model_code": "gpt-5.6-terra",
            "display_name": "GPT 5.6 Terra",
            "priority": 100,
        },
    )
    key_response = client.post(
        f"/api/admin/api-pool/providers/{provider_id}/keys",
        headers=admin_headers,
        json={
            "label": "Unlimited Key",
            "secret": "sk-test-fixture-unlimited-api-secret-never-return",
            "weight": 100,
            "max_concurrency": 0,
        },
    )
    assert key_response.status_code == 201, key_response.text
    assert key_response.json()["max_concurrency"] == 0

    factory = client.app.state.session_factory
    settings = client.app.state.settings
    acquired = [
        acquire_api_credential(
            factory,
            settings,
            provider_code="pool-unlimited",
            capability_kind="text",
            provider_model="gpt-5.6-terra",
        )
        for _ in range(25)
    ]
    assert len(acquired) == 25
    assert len({item.key_id for item in acquired if item is not None}) == 1
    for item in acquired:
        assert item is not None
        release_api_credential(factory, item)


def test_pool_key_can_be_rotated_disabled_and_deleted_without_secret_disclosure(
    client, admin_headers
) -> None:
    provider = create_provider(client, admin_headers, code="pool-admin")
    key = create_key(client, admin_headers, int(provider["id"]), 1)
    key_id = int(key["id"])
    updated = client.put(
        f"/api/admin/api-pool/keys/{key_id}",
        headers=admin_headers,
        json={
            "label": "暂停使用",
            "weight": 100,
            "max_concurrency": 2,
            "status": "disabled",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "disabled"

    rotated = client.post(
        f"/api/admin/api-pool/keys/{key_id}/rotate",
        headers=admin_headers,
        json={"secret": "sk-test-fixture-rotated-api-secret-never-return"},
    )
    assert rotated.status_code == 200
    assert rotated.json()["status"] == "active"
    assert "never-return" not in rotated.text

    deleted = client.delete(f"/api/admin/api-pool/keys/{key_id}", headers=admin_headers)
    assert deleted.status_code == 204

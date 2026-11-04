from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from app.core_v2.ozon import OzonConnectionFailure, execute_shop_connection_test
from app.schemas.core_v2 import OzonShopConnectionTestRequest
from tests.helpers import (
    create_cards,
    create_catalog,
    create_intro_cards,
    create_user,
    login_user,
)


def _payload() -> OzonShopConnectionTestRequest:
    return OzonShopConnectionTestRequest(client_id="10001", api_key="ozon-secret-marker")


def test_stateless_ozon_connection_test_calls_only_two_registered_read_endpoints() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["Client-Id"] == "10001"
        assert request.headers["Api-Key"] == "ozon-secret-marker"
        if request.url.path == "/v1/roles":
            return httpx.Response(200, json={"result": ["Seller"]})
        if request.url.path == "/v1/seller/info":
            return httpx.Response(200, json={"result": {"name": "Shop"}})
        raise AssertionError(request.url.path)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = execute_shop_connection_test(
            _payload(),
            base_url="https://api-seller.ozon.ru",
            timeout_seconds=15,
            client=client,
        )

    assert result["connected"] is True
    assert [request.url.path for request in requests] == ["/v1/roles", "/v1/seller/info"]
    assert all(request.method == "POST" for request in requests)
    assert "ozon-secret-marker" not in repr(_payload())
    assert "api_key" not in str(result).lower()


def test_stateless_ozon_connection_test_maps_authentication_without_leaking_secret() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"code": 5, "message": "Invalid Api-Key"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        try:
            execute_shop_connection_test(
                _payload(),
                base_url="https://api-seller.ozon.ru",
                timeout_seconds=15,
                client=client,
            )
        except OzonConnectionFailure as exc:
            assert exc.code == "OZON_AUTHENTICATION_FAILED"
            assert "ozon-secret-marker" not in exc.message
        else:
            raise AssertionError("authentication failure was not raised")


def test_core_v2_api_requires_login(client: TestClient) -> None:
    response = client.post(
        "/api/core-v2/ozon/shop-connection-test",
        json={"client_id": "10001", "api_key": "secret"},
    )
    assert response.status_code == 401


def test_core_v2_api_returns_transient_result(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    create_user(client, admin_headers)
    headers = login_user(client)
    observed: dict[str, str] = {}

    def allow_entitlement(_db, _principal, client_id: str) -> None:
        observed["client_id"] = client_id

    def execute(payload, **_kwargs):
        observed["api_key"] = payload.api_key.get_secret_value()
        return {
            "ok": True,
            "connected": True,
            "message": "Ozon 店铺连接正常。",
            "checks": {
                "roles": {"ok": True, "endpoint": "shop.roles", "data": {}},
                "sellerInfo": {"ok": True, "endpoint": "shop.sellerInfo", "data": {}},
            },
            "roles": {},
            "seller_info": {},
        }

    monkeypatch.setattr("app.api.core_v2._assert_shop_entitled", allow_entitlement)
    monkeypatch.setattr("app.api.core_v2.execute_shop_connection_test", execute)
    response = client.post(
        "/api/core-v2/ozon/shop-connection-test",
        headers=headers,
        json={"client_id": "10001", "api_key": "temporary-secret"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["connected"] is True
    assert observed == {"client_id": "10001", "api_key": "temporary-secret"}
    assert "temporary-secret" not in response.text


def test_core_v2_shop_check_accepts_another_valid_shop_card_on_same_account(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    second_cards = create_cards(
        client,
        admin_headers,
        catalog["plan"]["id"],
        quantity=1,
    )
    registered = client.post(
        "/api/auth/register",
        json={
            "password": "CoreV2MultiShop123!",
            "email": "core-v2-multi-shop@example.com",
            "project_code": "ozon_helper",
            "device_code": "core-v2-multi-shop-device-001",
            "device_name": "多店连接测试电脑",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
            "card_key": intro_cards["codes"][0],
        },
    )
    assert registered.status_code == 201, registered.text
    payload = registered.json()
    user_headers = {"Authorization": f"Bearer {payload['access_token']}"}
    first_license_headers = {
        "Authorization": f"Bearer {payload['entitlement']['access_token']}"
    }
    first = client.post(
        "/api/shops/bind",
        headers=user_headers,
        json={
            "license_key": payload["entitlement"]["license_key"],
            "project_code": "ozon_helper",
            "platform": "ozon",
            "shop_name": "Core V2 一店",
            "shop_id": "core-v2-10001",
        },
    )
    assert first.status_code == 201, first.text
    second = client.post(
        "/api/license/activate-shop",
        headers=user_headers,
        json={
            "card_key": second_cards["codes"][0],
            "project_code": "ozon_helper",
            "device_code": "core-v2-multi-shop-device-002",
            "device_name": "第二店授权",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
            "shop_name": "Core V2 二店",
            "shop_id": "core-v2-10002",
        },
    )
    assert second.status_code == 200, second.text

    monkeypatch.setattr(
        "app.api.core_v2.execute_shop_connection_test",
        lambda _payload, **_kwargs: {
            "ok": True,
            "connected": True,
            "message": "Ozon 店铺连接正常。",
            "checks": {},
            "roles": {},
            "seller_info": {},
        },
    )
    response = client.post(
        "/api/core-v2/ozon/shop-connection-test",
        headers=first_license_headers,
        json={"client_id": "core-v2-10002", "api_key": "temporary-second-key"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["connected"] is True

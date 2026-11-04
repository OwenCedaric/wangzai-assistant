from fastapi.testclient import TestClient

from tests.helpers import create_user, login_user


def test_unimplemented_legacy_routes_never_report_success(
    client: TestClient, admin_headers, monkeypatch
):
    create_user(client, admin_headers)
    headers = login_user(client)
    monkeypatch.setattr(
        "app.api.core_v2.get_active_principal_license", lambda _db, _principal: object()
    )
    for method, path in [
        ("GET", "api/ozon/notifications"),
        ("GET", "api/ozon/scheduler/status"),
        ("GET", "api/exchange-rate/realtime"),
        ("POST", "api/orders/preview"),
        ("POST", "api/orders/confirm"),
        ("DELETE", "api/shops/example"),
        ("POST", "api/product/translate"),
    ]:
        url = f"/api/core-v2/legacy/{path}"
        assert client.request(method, url).status_code == 401
        response = client.request(
            method, url, headers=headers, json={"marker": "isolated-business-test"}
        )
        assert response.status_code == 501, response.text
        assert response.json()["detail"]["code"] == "CORE_V2_ROUTE_NOT_IMPLEMENTED"
        assert "isolated-business-test" not in response.text
        assert "operationId" not in response.text

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.helpers import create_catalog, create_intro_cards


def _register_with_card(
    client: TestClient,
    card_key: str,
    *,
    email: str = "cleanup@example.com",
) -> dict[str, object]:
    response = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "CleanupPass123!",
            "card_key": card_key,
            "project_code": "ozon_helper",
            "device_code": "cleanup-device-001",
            "device_name": "清理测试设备",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_email_username_and_permanent_user_license_card_cleanup(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    batch = create_intro_cards(client, admin_headers, catalog, quantity=2)
    registered = _register_with_card(client, batch["codes"][0])
    user = registered["user"]
    assert user["username"] == "cleanup@example.com"

    license_page = client.get(f"/api/admin/licenses?user_id={user['id']}", headers=admin_headers)
    assert license_page.status_code == 200
    license_record = license_page.json()["items"][0]

    codes = client.get(
        f"/api/admin/card-batches/{batch['id']}/codes", headers=admin_headers
    ).json()["items"]
    unused_code = next(item for item in codes if item["status"] == "unused")
    deleted_code = client.delete(
        f"/api/admin/card-batches/{batch['id']}/codes/{unused_code['id']}",
        headers=admin_headers,
    )
    assert deleted_code.status_code == 204
    remaining_codes = client.get(
        f"/api/admin/card-batches/{batch['id']}/codes", headers=admin_headers
    )
    assert remaining_codes.json()["total"] == 1

    deleted_batch = client.delete(f"/api/admin/card-batches/{batch['id']}", headers=admin_headers)
    assert deleted_batch.status_code == 204
    assert (
        client.get(f"/api/admin/card-batches/{batch['id']}", headers=admin_headers).status_code
        == 404
    )
    assert (
        client.get(f"/api/admin/licenses/{license_record['id']}", headers=admin_headers).status_code
        == 200
    )

    deleted_license = client.delete(
        f"/api/admin/licenses/{license_record['id']}", headers=admin_headers
    )
    assert deleted_license.status_code == 204
    assert (
        client.get(f"/api/admin/licenses/{license_record['id']}", headers=admin_headers).status_code
        == 404
    )

    deleted_user = client.delete(f"/api/admin/users/{user['id']}", headers=admin_headers)
    assert deleted_user.status_code == 204
    assert client.get(f"/api/admin/users/{user['id']}", headers=admin_headers).status_code == 404


def test_current_admin_cannot_delete_itself(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    users = client.get("/api/admin/users?q=admin", headers=admin_headers).json()["items"]
    admin = next(item for item in users if item["is_admin"])
    response = client.delete(f"/api/admin/users/{admin['id']}", headers=admin_headers)
    assert response.status_code == 409


def test_all_management_list_resources_expose_permanent_delete_routes(
    client: TestClient,
) -> None:
    schema = client.get("/openapi.json")
    assert schema.status_code == 200
    delete_paths = {
        path for path, operations in schema.json()["paths"].items() if "delete" in operations
    }
    assert {
        "/api/admin/users/{user_id}",
        "/api/admin/licenses/{license_id}",
        "/api/admin/card-batches/{batch_id}",
        "/api/admin/card-batches/{batch_id}/codes/{code_id}",
        "/api/admin/devices/{device_id}",
        "/api/admin/shops/{shop_id}",
        "/api/admin/usage-logs/{log_id}",
        "/api/admin/agents/{agent_id}",
        "/api/admin/channels/{channel_id}",
        "/api/admin/orders/{order_id}",
        "/api/admin/commissions/{commission_id}",
        "/api/admin/commission-rules/{rule_id}",
        "/api/admin/point-packages/{plan_id}",
        "/api/admin/point-wallets/{wallet_id}",
        "/api/admin/point-ledger/{entry_id}",
    }.issubset(delete_paths)

from fastapi.testclient import TestClient

from tests.helpers import (
    create_cards,
    create_catalog,
    create_commerce_catalog,
    create_user,
    login_user,
)


def test_admin_catalog_import_crud_and_dashboard(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    assert client.get("/api/admin/dashboard").status_code == 401
    catalog = create_catalog(client, admin_headers)
    user = create_user(client, admin_headers)
    batch = create_cards(client, admin_headers, catalog["plan"]["id"])

    assert batch["export_available"] is True
    assert len(batch["codes"]) == 2
    assert all(len(code.split("-")) == 4 for code in batch["codes"])

    codes = client.get(f"/api/admin/card-batches/{batch['id']}/codes", headers=admin_headers)
    assert codes.status_code == 200
    assert codes.json()["total"] == 2
    assert "code_hash" not in codes.text
    assert batch["codes"][0] not in codes.text

    exported = client.get(
        f"/api/admin/card-batches/{batch['id']}/export?format=csv",
        headers=admin_headers,
    )
    assert exported.status_code == 200
    assert batch["codes"][0] in exported.content.decode("utf-8-sig")

    dashboard = client.get("/api/admin/dashboard", headers=admin_headers)
    assert dashboard.status_code == 200
    assert dashboard.json()["users_total"] == 2
    assert user["username"] == "customer"


def test_extra_fields_are_rejected(client: TestClient, admin_headers: dict[str, str]) -> None:
    response = client.post(
        "/api/admin/projects/import",
        headers=admin_headers,
        json={
            "name": "Bad",
            "code": "bad_project",
            "version": "1.0.0",
            "modules": [],
            "source_url": "https://example.invalid/project.json",
        },
    )
    assert response.status_code == 422
    too_long_code = client.post(
        "/api/admin/projects",
        headers=admin_headers,
        json={"name": "Too long", "code": "p" + "x" * 64},
    )
    assert too_long_code.status_code == 422


def test_card_and_batch_status_control_activation(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    create_user(client, admin_headers)
    batch = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=1)
    code_page = client.get(f"/api/admin/card-batches/{batch['id']}/codes", headers=admin_headers)
    code_id = code_page.json()["items"][0]["id"]
    user_headers = login_user(client)
    activation = {
        "card_key": batch["codes"][0],
        "project_code": "ozon_helper",
        "device_code": "card-status-device",
        "version": "1.0.0",
        "version_hash": "sha256:test-build",
    }

    disabled_code = client.put(
        f"/api/admin/card-batches/{batch['id']}/codes/{code_id}",
        headers=admin_headers,
        json={"status": "disabled"},
    )
    assert disabled_code.status_code == 200
    assert (
        client.post("/api/license/activate", headers=user_headers, json=activation).status_code
        == 409
    )

    restored_code = client.put(
        f"/api/admin/card-batches/{batch['id']}/codes/{code_id}",
        headers=admin_headers,
        json={"status": "unused"},
    )
    assert restored_code.status_code == 200
    disabled_batch = client.put(
        f"/api/admin/card-batches/{batch['id']}",
        headers=admin_headers,
        json={"status": "disabled"},
    )
    assert disabled_batch.status_code == 200
    assert (
        client.post("/api/license/activate", headers=user_headers, json=activation).status_code
        == 409
    )

    enabled_batch = client.put(
        f"/api/admin/card-batches/{batch['id']}",
        headers=admin_headers,
        json={"status": "active"},
    )
    assert enabled_batch.status_code == 200
    activated = client.post("/api/license/activate", headers=user_headers, json=activation)
    assert activated.status_code == 200
    assert activated.json()["valid"] is True


def test_plan_in_use_reports_dependencies_and_can_stop_sales_safely(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_commerce_catalog(client, admin_headers)
    plan_id = catalog["plan"]["id"]
    create_user(client, admin_headers)
    batch = create_cards(client, admin_headers, plan_id, quantity=1)
    user_headers = login_user(client)
    activation = client.post(
        "/api/license/activate",
        headers=user_headers,
        json={
            "card_key": batch["codes"][0],
            "project_code": "ozon_helper",
            "device_code": "stop-sales-device",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert activation.status_code == 200, activation.text

    conflict = client.delete(f"/api/admin/plans/{plan_id}", headers=admin_headers)
    assert conflict.status_code == 409
    detail = conflict.json()["detail"]
    assert detail["code"] == "PLAN_IN_USE"
    assert detail["recommended_action"] == "STOP_ONLINE_SALES"
    assert detail["dependencies"] == {
        "licenses": 1,
        "card_batches": 1,
        "activation_codes": 1,
        "orders": 0,
        "commission_rules": 0,
    }

    stopped = client.post(f"/api/admin/plans/{plan_id}/stop-sales", headers=admin_headers)
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["online_sale_enabled"] is False
    assert stopped.json()["status"] == "active"

    store = client.get("/api/store/plans?project_code=ozon_helper")
    assert store.status_code == 200
    assert store.json()["total"] == 0
    existing_license = client.post(
        "/api/license/check",
        headers=user_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "stop-sales-device",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert existing_license.status_code == 200, existing_license.text
    assert existing_license.json()["valid"] is True


def test_unused_plan_can_still_be_deleted(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    plan_id = catalog["plan"]["id"]

    deleted = client.delete(f"/api/admin/plans/{plan_id}", headers=admin_headers)
    assert deleted.status_code == 204
    assert client.get(f"/api/admin/plans/{plan_id}", headers=admin_headers).status_code == 404

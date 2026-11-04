from __future__ import annotations

from fastapi.testclient import TestClient


def create_catalog(client: TestClient, admin_headers: dict[str, str]) -> dict[str, object]:
    imported = client.post(
        "/api/admin/projects/import",
        headers=admin_headers,
        json={
            "name": "Ozon助手",
            "code": "ozon_helper",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
            "modules": [
                {"code": "order_sync", "name": "订单同步"},
                {"code": "profit", "name": "利润分析"},
            ],
        },
    )
    assert imported.status_code == 200, imported.text
    project = imported.json()["project"]
    products_response = client.get(
        f"/api/admin/products?project_id={project['id']}", headers=admin_headers
    )
    assert products_response.status_code == 200
    product = products_response.json()["items"][0]
    permissions_response = client.get(
        f"/api/admin/permissions?project_id={project['id']}", headers=admin_headers
    )
    permissions = permissions_response.json()["items"]
    plan_response = client.post(
        "/api/admin/plans",
        headers=admin_headers,
        json={
            "product_id": product["id"],
            "name": "标准店铺月卡",
            "price": "50.00",
            "sale_price_cent": 5000,
            "license_role": "shop_standard_monthly",
            "duration_days": 30,
            "max_devices": 1,
            "max_shops": 1,
            "permission_ids": [permission["id"] for permission in permissions],
        },
    )
    assert plan_response.status_code == 201, plan_response.text
    return {
        "project": project,
        "product": product,
        "permissions": permissions,
        "plan": plan_response.json(),
    }


def create_commerce_catalog(client: TestClient, admin_headers: dict[str, str]) -> dict[str, object]:
    catalog = create_catalog(client, admin_headers)
    plan_id = catalog["plan"]["id"]
    response = client.put(
        f"/api/admin/plans/{plan_id}",
        headers=admin_headers,
        json={"online_sale_enabled": True},
    )
    assert response.status_code == 200, response.text
    catalog["plan"] = response.json()
    return catalog


def sms_login(
    client: TestClient,
    *,
    phone: str,
    channel: dict[str, object] | None = None,
    device_code: str = "desktop-device-001",
    card_key: str | None = None,
) -> dict[str, object]:
    body = {
        "phone": phone,
        "scene": "login_or_register",
        "project_code": "ozon_helper",
        "device_code": device_code,
        "device_name": "测试电脑",
        "version": "1.0.0",
        "version_hash": "sha256:test-build",
    }
    if channel:
        body.update(
            {
                "channel_code": channel["code"],
                "distribution_token": channel["distribution_token"],
            }
        )
    sent = client.post("/api/auth/sms/send", json=body)
    assert sent.status_code == 200, sent.text
    assert sent.json()["phone_masked"] == f"{phone[:3]}****{phone[-4:]}"
    verify = client.post(
        "/api/auth/sms/verify",
        json={
            **body,
            "code": sent.json()["development_code"],
            **({"card_key": card_key} if card_key else {}),
        },
    )
    assert verify.status_code == 200, verify.text
    return verify.json()


def create_user(
    client: TestClient,
    admin_headers: dict[str, str],
    username: str = "customer",
    password: str = "CustomerPass123!",
) -> dict[str, object]:
    response = client.post(
        "/api/admin/users",
        headers=admin_headers,
        json={"username": username, "password": password},
    )
    assert response.status_code == 201, response.text
    return response.json()


def login_user(
    client: TestClient,
    username: str = "customer",
    password: str = "CustomerPass123!",
) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def create_cards(
    client: TestClient,
    admin_headers: dict[str, str],
    plan_id: int,
    quantity: int = 2,
) -> dict[str, object]:
    response = client.post(
        "/api/admin/card-batches",
        headers=admin_headers,
        json={"plan_id": plan_id, "quantity": quantity},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_intro_plan(
    client: TestClient,
    admin_headers: dict[str, str],
    catalog: dict[str, object],
) -> dict[str, object]:
    response = client.post(
        "/api/admin/plans",
        headers=admin_headers,
        json={
            "product_id": catalog["product"]["id"],
            "name": "首店首月体验卡",
            "price": "19.90",
            "sale_price_cent": 1990,
            "license_role": "shop_intro",
            "duration_days": 30,
            "max_devices": 1,
            "max_shops": 1,
            "permission_ids": [permission["id"] for permission in catalog["permissions"]],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_intro_cards(
    client: TestClient,
    admin_headers: dict[str, str],
    catalog: dict[str, object],
    quantity: int = 2,
) -> dict[str, object]:
    plan = create_intro_plan(client, admin_headers, catalog)
    return create_cards(client, admin_headers, plan["id"], quantity=quantity)


def register_sms_user(
    client: TestClient,
    admin_headers: dict[str, str],
    catalog: dict[str, object],
    *,
    phone: str,
    channel: dict[str, object] | None = None,
    device_code: str = "desktop-device-001",
) -> dict[str, object]:
    cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    return sms_login(
        client,
        phone=phone,
        channel=channel,
        device_code=device_code,
        card_key=cards["codes"][0],
    )

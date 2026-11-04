from datetime import datetime, timedelta

import jwt
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient

from tests.helpers import create_cards, create_catalog, create_user, login_user


def _activate(client, user_headers, card_key, device_code="device-code-0001"):
    return client.post(
        "/api/license/activate",
        headers=user_headers,
        json={
            "card_key": card_key,
            "project_code": "ozon_helper",
            "device_code": device_code,
            "device_name": "Test workstation",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )


def test_activate_check_heartbeat_and_offline_signature(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    offline_plan = client.put(
        f"/api/admin/plans/{catalog['plan']['id']}",
        headers=admin_headers,
        json={"offline_hours": 72},
    )
    assert offline_plan.status_code == 200, offline_plan.text
    create_user(client, admin_headers)
    batch = create_cards(client, admin_headers, catalog["plan"]["id"])
    user_headers = login_user(client)

    activated = _activate(client, user_headers, batch["codes"][0])
    assert activated.status_code == 200, activated.text
    result = activated.json()
    assert result["valid"] is True
    assert result["online_required"] is False
    assert result["permissions"] == ["order_sync", "profit"]
    assert result["shop_limit"] == 1
    assert result["device_limit"] == 1
    assert result["offline_token"]
    assert datetime.fromisoformat(result["offline_until"]) <= datetime.fromisoformat(
        result["expire"]
    )

    public_key_response = client.get("/api/license/public-key")
    assert public_key_response.status_code == 200
    public_key = serialization.load_pem_public_key(
        public_key_response.json()["public_key_pem"].encode("utf-8")
    )
    offline_claims = jwt.decode(
        result["offline_token"],
        public_key,
        algorithms=["EdDSA"],
        audience="license-center-clients",
        issuer="license-center",
    )
    assert offline_claims["device_code"] == "device-code-0001"
    assert offline_claims["project_code"] == "ozon_helper"

    restored_session = client.post(
        "/api/license/check",
        headers=user_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "device-code-0001",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert restored_session.status_code == 200, restored_session.text
    assert restored_session.json()["valid"] is True
    assert restored_session.json()["access_token"]

    license_headers = {"Authorization": f"Bearer {result['access_token']}"}
    assert client.get("/api/admin/dashboard", headers=license_headers).status_code == 403
    checked = client.post(
        "/api/license/check",
        headers=license_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "device-code-0001",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert checked.status_code == 200
    assert checked.json()["valid"] is True

    missing_version = client.post(
        "/api/license/check",
        headers=license_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "device-code-0001",
            "version_hash": "sha256:test-build",
        },
    )
    assert missing_version.status_code == 422

    heartbeat = client.post(
        "/api/license/heartbeat",
        headers={"Authorization": f"Bearer {checked.json()['access_token']}"},
        json={
            "project_code": "ozon_helper",
            "device_code": "device-code-0001",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert heartbeat.status_code == 200
    assert heartbeat.json()["valid"] is True

    replayed_on_other_device = client.post(
        "/api/license/heartbeat",
        headers=license_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "device-code-replay",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert replayed_on_other_device.status_code == 403

    wrong_scope_activation = _activate(client, license_headers, batch["codes"][1])
    assert wrong_scope_activation.status_code == 403

    reused = _activate(client, user_headers, batch["codes"][0])
    assert reused.status_code == 409


def test_online_only_plan_never_returns_offline_grant_and_clears_old_window(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    plan_id = catalog["plan"]["id"]
    assert catalog["plan"]["offline_hours"] == 0

    invalid_negative = client.put(
        f"/api/admin/plans/{plan_id}",
        headers=admin_headers,
        json={"offline_hours": -1},
    )
    assert invalid_negative.status_code == 422
    invalid_too_large = client.put(
        f"/api/admin/plans/{plan_id}",
        headers=admin_headers,
        json={"offline_hours": 169},
    )
    assert invalid_too_large.status_code == 422

    listed_plan = client.put(
        f"/api/admin/plans/{plan_id}",
        headers=admin_headers,
        json={"online_sale_enabled": True},
    )
    assert listed_plan.status_code == 200, listed_plan.text
    store = client.get("/api/store/plans?project_code=ozon_helper")
    assert store.status_code == 200, store.text
    assert store.json()["items"][0]["offline_hours"] == 0
    assert store.json()["items"][0]["online_required"] is True

    create_user(client, admin_headers)
    batch = create_cards(client, admin_headers, plan_id)
    user_headers = login_user(client)
    activated = _activate(client, user_headers, batch["codes"][0])
    assert activated.status_code == 200, activated.text
    activated_result = activated.json()
    assert activated_result["valid"] is True
    assert activated_result["online_required"] is True
    assert activated_result["offline_until"] is None
    assert activated_result["offline_token"] is None

    license_headers = {"Authorization": f"Bearer {activated_result['access_token']}"}
    opt_in = client.put(
        f"/api/admin/plans/{plan_id}",
        headers=admin_headers,
        json={"offline_hours": 24},
    )
    assert opt_in.status_code == 200, opt_in.text
    with_offline = client.post(
        "/api/license/check",
        headers=license_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "device-code-0001",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert with_offline.status_code == 200, with_offline.text
    assert with_offline.json()["online_required"] is False
    assert with_offline.json()["offline_until"]
    assert with_offline.json()["offline_token"]

    opt_out = client.put(
        f"/api/admin/plans/{plan_id}",
        headers=admin_headers,
        json={"offline_hours": 0},
    )
    assert opt_out.status_code == 200, opt_out.text
    licenses = client.get("/api/admin/licenses", headers=admin_headers)
    assert licenses.status_code == 200, licenses.text
    assert licenses.json()["items"][0]["offline_until"] is None

    checked = client.post(
        "/api/license/check",
        headers={"Authorization": f"Bearer {with_offline.json()['access_token']}"},
        json={
            "project_code": "ozon_helper",
            "device_code": "device-code-0001",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert checked.status_code == 200, checked.text
    assert checked.json()["online_required"] is True
    assert checked.json()["offline_until"] is None
    assert checked.json()["offline_token"] is None

    heartbeat = client.post(
        "/api/license/heartbeat",
        headers={"Authorization": f"Bearer {checked.json()['access_token']}"},
        json={
            "project_code": "ozon_helper",
            "device_code": "device-code-0001",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["online_required"] is True
    assert heartbeat.json()["offline_until"] is None
    assert heartbeat.json()["offline_token"] is None


def test_device_and_shop_limits(client: TestClient, admin_headers: dict[str, str]) -> None:
    catalog = create_catalog(client, admin_headers)
    create_user(client, admin_headers)
    batch = create_cards(client, admin_headers, catalog["plan"]["id"])
    user_headers = login_user(client)
    activated = _activate(client, user_headers, batch["codes"][0]).json()
    license_headers = {"Authorization": f"Bearer {activated['access_token']}"}

    second_device = client.post(
        "/api/license/check",
        headers=license_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "device-code-0002",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert second_device.status_code == 403

    first_shop = client.post(
        "/api/shops/bind",
        headers=license_headers,
        json={
            "license_key": activated["license_key"],
            "project_code": "ozon_helper",
            "platform": "ozon",
            "shop_name": "Main Shop",
            "shop_id": "shop-1",
        },
    )
    assert first_shop.status_code == 201, first_shop.text
    second_shop = client.post(
        "/api/shops/bind",
        headers=license_headers,
        json={
            "license_key": activated["license_key"],
            "project_code": "ozon_helper",
            "platform": "ozon",
            "shop_name": "Second Shop",
            "shop_id": "shop-2",
        },
    )
    assert second_shop.status_code == 409

    second_license = _activate(
        client, user_headers, batch["codes"][1], device_code="device-code-0002"
    )
    assert second_license.status_code == 200, second_license.text
    second_result = second_license.json()
    second_headers = {"Authorization": f"Bearer {second_result['access_token']}"}
    other_shop = client.post(
        "/api/shops/bind",
        headers=second_headers,
        json={
            "license_key": second_result["license_key"],
            "project_code": "ozon_helper",
            "platform": "ozon",
            "shop_name": "Other License Shop",
            "shop_id": "shop-other-license",
        },
    )
    assert other_shop.status_code == 201, other_shop.text
    scoped_shops = client.get("/api/shops", headers=license_headers)
    assert scoped_shops.status_code == 200
    assert len(scoped_shops.json()) == 1
    assert scoped_shops.json()[0]["license_id"] == first_shop.json()["license_id"]
    cross_license_delete = client.delete(
        f"/api/shops/{other_shop.json()['id']}", headers=license_headers
    )
    assert cross_license_delete.status_code == 403


def test_user_token_binds_second_device_and_disabled_binding_releases_slot(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    plan_id = catalog["plan"]["id"]
    updated_plan = client.put(
        f"/api/admin/plans/{plan_id}",
        headers=admin_headers,
        json={"max_devices": 2},
    )
    assert updated_plan.status_code == 200, updated_plan.text
    create_user(client, admin_headers)
    batch = create_cards(client, admin_headers, plan_id)
    user_headers = login_user(client)
    activated = _activate(client, user_headers, batch["codes"][0], device_code="multi-device-0001")
    assert activated.status_code == 200, activated.text
    assert activated.json()["device_limit"] == 2

    second_device = client.post(
        "/api/license/check",
        headers=user_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "multi-device-0002",
            "device_name": "Second workstation",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert second_device.status_code == 200, second_device.text
    assert second_device.json()["valid"] is True

    strict_license_token = {"Authorization": f"Bearer {second_device.json()['access_token']}"}
    cross_device = client.post(
        "/api/license/check",
        headers=strict_license_token,
        json={
            "project_code": "ozon_helper",
            "device_code": "multi-device-0003",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert cross_device.status_code == 403

    over_limit = client.post(
        "/api/license/check",
        headers=user_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "multi-device-0003",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert over_limit.status_code == 409
    assert over_limit.json()["detail"] == "Device limit reached"

    licenses = client.get("/api/admin/licenses", headers=admin_headers).json()["items"]
    license_id = licenses[0]["id"]
    devices = client.get(
        f"/api/admin/devices?license_id={license_id}", headers=admin_headers
    ).json()["items"]
    first_device = next(item for item in devices if item["device_code"] == "multi-device-0001")
    disabled = client.put(
        f"/api/admin/devices/{first_device['id']}",
        headers=admin_headers,
        json={"status": "disabled"},
    )
    assert disabled.status_code == 200

    replacement = client.post(
        "/api/license/check",
        headers=user_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "multi-device-0003",
            "device_name": "Replacement workstation",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert replacement.status_code == 200, replacement.text
    assert replacement.json()["valid"] is True

    disabled_device_cannot_restore_itself = client.post(
        "/api/license/check",
        headers=user_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "multi-device-0001",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert disabled_device_cannot_restore_itself.status_code == 403
    assert disabled_device_cannot_restore_itself.json()["detail"] == ("Device binding is disabled")
    reenable_over_quota = client.put(
        f"/api/admin/devices/{first_device['id']}",
        headers=admin_headers,
        json={"status": "active"},
    )
    assert reenable_over_quota.status_code == 409
    assert reenable_over_quota.json()["detail"] == "Device limit reached"


def test_device_limit_exemption_applies_only_to_selected_user(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    plan_id = catalog["plan"]["id"]
    first_user = create_user(client, admin_headers)
    first_batch = create_cards(client, admin_headers, plan_id)
    first_headers = login_user(client)
    first_activation = _activate(
        client,
        first_headers,
        first_batch["codes"][0],
        device_code="exempt-device-0001",
    )
    assert first_activation.status_code == 200, first_activation.text

    before_exemption = client.post(
        "/api/license/check",
        headers=first_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "exempt-device-0002",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert before_exemption.status_code == 409

    enabled = client.put(
        f"/api/admin/users/{first_user['id']}",
        headers=admin_headers,
        json={"device_limit_exempt": True},
    )
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["device_limit_exempt"] is True

    after_exemption = client.post(
        "/api/license/check",
        headers=first_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "exempt-device-0002",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert after_exemption.status_code == 200, after_exemption.text
    assert after_exemption.json()["valid"] is True

    second_user = create_user(
        client,
        admin_headers,
        username="other-device-limit-user",
    )
    second_batch = create_cards(client, admin_headers, plan_id)
    second_headers = login_user(
        client,
        username="other-device-limit-user",
    )
    second_activation = _activate(
        client,
        second_headers,
        second_batch["codes"][0],
        device_code="regular-device-0001",
    )
    assert second_activation.status_code == 200, second_activation.text
    assert second_user["device_limit_exempt"] is False
    second_over_limit = client.post(
        "/api/license/check",
        headers=second_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "regular-device-0002",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert second_over_limit.status_code == 409
    assert second_over_limit.json()["detail"] == "Device limit reached"


def test_future_license_and_disabled_product_are_invalid(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    user = create_user(client, admin_headers)
    user_headers = login_user(client)
    now = datetime.now().astimezone()
    future_grant = client.post(
        "/api/admin/licenses",
        headers=admin_headers,
        json={
            "user_id": user["id"],
            "plan_id": catalog["plan"]["id"],
            "start_time": (now + timedelta(days=1)).isoformat(),
            "expire_time": (now + timedelta(days=31)).isoformat(),
        },
    )
    assert future_grant.status_code == 201
    future_check = client.post(
        "/api/license/check",
        headers=user_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "future-device-0001",
            "license_key": future_grant.json()["license_key"],
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert future_check.status_code == 200
    assert future_check.json()["valid"] is False
    assert future_check.json()["reason"] == "license_not_started"

    active_grant = client.post(
        "/api/admin/licenses",
        headers=admin_headers,
        json={"user_id": user["id"], "plan_id": catalog["plan"]["id"]},
    )
    assert active_grant.status_code == 201
    disabled = client.put(
        f"/api/admin/products/{catalog['product']['id']}",
        headers=admin_headers,
        json={"status": "disabled"},
    )
    assert disabled.status_code == 200
    disabled_check = client.post(
        "/api/license/check",
        headers=user_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "product-disabled-device",
            "license_key": active_grant.json()["license_key"],
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert disabled_check.status_code == 200
    assert disabled_check.json()["valid"] is False
    assert disabled_check.json()["reason"] == "product_disabled"

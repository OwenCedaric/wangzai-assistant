import json
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import License, Shop
from app.models.smart_reply import SmartReplyTask
from tests.helpers import create_cards, create_catalog, create_intro_cards


def _owner(client: TestClient, admin_headers: dict[str, str]):
    catalog = create_catalog(client, admin_headers)
    cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    registered = client.post(
        "/api/auth/register",
        json={
            "password": "SmartReplyPass123!",
            "email": "smart-reply@example.com",
            "project_code": "ozon_helper",
            "device_code": "smart-reply-device-001",
            "device_name": "测试电脑",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
            "card_key": cards["codes"][0],
        },
    )
    assert registered.status_code == 201, registered.text
    payload = registered.json()
    user_headers = {"Authorization": f"Bearer {payload['access_token']}"}
    license_headers = {
        "Authorization": f"Bearer {payload['entitlement']['access_token']}"
    }
    bound = client.post(
        "/api/shops/bind",
        headers=user_headers,
        json={
            "license_key": payload["entitlement"]["license_key"],
            "project_code": "ozon_helper",
            "platform": "ozon",
            "shop_name": "Ozon 一店",
            "shop_id": "10001",
        },
    )
    assert bound.status_code == 201, bound.text
    return license_headers


def test_rule_requires_verified_credential_and_can_be_disabled(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    client.app.state.settings.ozon_notification_callback_token = (
        "test-smart-reply-callback-token-that-is-long-enough"
    )
    headers = _owner(client, admin_headers)
    rule = {
        "scene": "pickupReminder",
        "shop_client_ids": ["10001"],
        "send_time_type": "immediate",
        "delay_hours": 0,
        "content_generate_type": "template",
        "template_id": "pickup-reminder-1",
        "message_template": "Здравствуйте, {{买家昵称}}, заказ {{货件编号}} готов.",
        "message_template_zh": "您好，订单已到提货点。",
        "enabled": True,
    }
    missing = client.post("/api/smart-reply/rules", headers=headers, json=rule)
    assert missing.status_code == 409

    monkeypatch.setattr(
        "app.services.smart_reply_rules.SmartReplyOzonClient.verify",
        lambda _self: None,
    )
    credential = client.post(
        "/api/smart-reply/credentials",
        headers=headers,
        json={"client_id": "10001", "api_key": "temporary-ozon-key"},
    )
    assert credential.status_code == 200, credential.text
    assert "temporary-ozon-key" not in credential.text
    assert credential.json()["configured"] is True

    created = client.post("/api/smart-reply/rules", headers=headers, json=rule)
    assert created.status_code == 200, created.text
    assert created.json()["enabled"] is True
    rule_id = created.json()["rule_id"]

    with client.app.state.session_factory() as db:
        shop = db.scalar(select(Shop).where(Shop.shop_id == "10001"))
        db.add(
            SmartReplyTask(
                id="srt_disable_test",
                idempotency_key="smart-reply:disable-test",
                rule_id=rule_id,
                shop_id=shop.id,
                posting_number="POST-DISABLE-1",
                scene="pickupReminder",
                trigger_status="posting_in_pickup_point",
                scheduled_for=datetime.now(UTC),
                status="pending",
                template_snapshot=json.dumps({"messageTemplate": "test"}),
            )
        )
        db.commit()

    duplicate = client.post(
        "/api/smart-reply/rules",
        headers=headers,
        json={**rule, "template_id": "pickup-reminder-2"},
    )
    assert duplicate.status_code == 409

    disabled = client.post(
        f"/api/smart-reply/rules/{rule_id}/enabled",
        headers=headers,
        json={"enabled": False},
    )
    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False
    with client.app.state.session_factory() as db:
        cancelled_task = db.get(SmartReplyTask, "srt_disable_test")
        assert cancelled_task.status == "cancelled"

    status = client.get("/api/smart-reply/status", headers=headers)
    assert status.status_code == 200, status.text
    assert status.json()["configured_shop_count"] == 1
    assert status.json()["enabled_rule_count"] == 0


def test_one_desktop_session_can_manage_all_valid_shop_card_entitlements(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    """The login/session card is not the per-shop authorization card."""

    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    second_shop_cards = create_cards(
        client,
        admin_headers,
        catalog["plan"]["id"],
        quantity=1,
    )
    registered = client.post(
        "/api/auth/register",
        json={
            "password": "SmartReplyMultiShop123!",
            "email": "smart-reply-multi@example.com",
            "project_code": "ozon_helper",
            "device_code": "smart-reply-multi-device-001",
            "device_name": "多店测试电脑",
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
            "shop_name": "Ozon 一店",
            "shop_id": "multi-10001",
        },
    )
    assert first.status_code == 201, first.text
    second = client.post(
        "/api/license/activate-shop",
        headers=user_headers,
        json={
            "card_key": second_shop_cards["codes"][0],
            "project_code": "ozon_helper",
            "device_code": "smart-reply-multi-device-002",
            "device_name": "第二店授权",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
            "shop_name": "Ozon 二店",
            "shop_id": "multi-10002",
        },
    )
    assert second.status_code == 200, second.text
    second_license_headers = {
        "Authorization": f"Bearer {second.json()['access_token']}"
    }

    client.app.state.settings.ozon_notification_callback_token = (
        "test-smart-reply-callback-token-that-is-long-enough"
    )
    monkeypatch.setattr(
        "app.services.smart_reply_rules.SmartReplyOzonClient.verify",
        lambda _self: None,
    )
    for client_id in ("multi-10001", "multi-10002"):
        credential = client.post(
            "/api/smart-reply/credentials",
            headers=first_license_headers,
            json={"client_id": client_id, "api_key": f"temporary-{client_id}-key"},
        )
        assert credential.status_code == 200, credential.text

    credentials = client.get(
        "/api/smart-reply/credentials",
        headers=first_license_headers,
    )
    assert credentials.status_code == 200, credentials.text
    assert {row["client_id"] for row in credentials.json()} == {
        "multi-10001",
        "multi-10002",
    }
    assert all(row["configured"] for row in credentials.json())

    created = client.post(
        "/api/smart-reply/rules",
        headers=first_license_headers,
        json={
            "scene": "shipmentNotice",
            "shop_client_ids": ["multi-10001", "multi-10002"],
            "send_time_type": "immediate",
            "delay_hours": 0,
            "content_generate_type": "template",
            "template_id": "shipment-multi-1",
            "message_template": "Заказ {{货件编号}} отправлен.",
            "message_template_zh": "订单已发货。",
            "enabled": True,
        },
    )
    assert created.status_code == 200, created.text
    assert set(created.json()["shop_client_ids"]) == {"multi-10001", "multi-10002"}
    status = client.get("/api/smart-reply/status", headers=first_license_headers)
    assert status.status_code == 200, status.text
    assert status.json()["configured_shop_count"] == 2

    # Enabling through the switch must re-check every selected shop's own card,
    # not merely the currently logged-in desktop card.
    with client.app.state.session_factory() as db:
        first_shop = db.scalar(select(Shop).where(Shop.shop_id == "multi-10001"))
        first_license = db.get(License, first_shop.license_id)
        first_license.expire_time = datetime.now(UTC) - timedelta(days=1)
        first_license_id = first_license.id
        db.commit()
    disabled = client.post(
        f"/api/smart-reply/rules/{created.json()['rule_id']}/enabled",
        headers=second_license_headers,
        json={"enabled": False},
    )
    assert disabled.status_code == 200, disabled.text
    refused = client.post(
        f"/api/smart-reply/rules/{created.json()['rule_id']}/enabled",
        headers=second_license_headers,
        json={"enabled": True},
    )
    assert refused.status_code == 403, refused.text

    # Removing the expired first card must not cascade-delete the account-level
    # rule that still targets the valid second shop.
    deleted = client.delete(
        f"/api/admin/licenses/{first_license_id}",
        headers=admin_headers,
    )
    assert deleted.status_code == 204, deleted.text
    surviving_rules = client.get(
        "/api/smart-reply/rules",
        headers=second_license_headers,
    )
    assert surviving_rules.status_code == 200, surviving_rules.text
    assert len(surviving_rules.json()) == 1
    assert surviving_rules.json()[0]["shop_client_ids"] == ["multi-10002"]
    enabled_again = client.post(
        f"/api/smart-reply/rules/{created.json()['rule_id']}/enabled",
        headers=second_license_headers,
        json={"enabled": True},
    )
    assert enabled_again.status_code == 200, enabled_again.text

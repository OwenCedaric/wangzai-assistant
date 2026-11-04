from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.models import (
    ActivationCode,
    CommissionRecord,
    License,
    Order,
    OrderFulfillment,
    Payment,
    PaymentEvent,
    Refund,
    User,
    UserProjectAttribution,
)
from app.services.errors import DomainError
from app.services.identity_service import phone_hash
from app.services.payments.providers import QueryResult, RefundNotification
from app.services.refund_service import process_refund_notification
from tests.helpers import (
    create_commerce_catalog,
    create_user,
    login_user,
    register_sms_user,
    sms_login,
)

CUSTOMER_PRIVATE_ORDER_FIELDS = {
    "user_id",
    "project_id",
    "plan_id",
    "agent_id",
    "channel_id",
    "commission_rate_bps",
    "commission_amount_cent",
    "provider",
    "provider_payment_no",
}


def _agent_channel(
    client: TestClient,
    admin_headers: dict[str, str],
    project_id: int,
    suffix: str = "A",
) -> tuple[dict[str, object], dict[str, object]]:
    agent_response = client.post(
        "/api/admin/agents",
        headers=admin_headers,
        json={
            "code": f"AGENT_{suffix}",
            "name": f"代理 {suffix}",
            "default_commission_rate_bps": 1500,
            "project_ids": [project_id],
        },
    )
    assert agent_response.status_code == 201, agent_response.text
    agent = agent_response.json()
    channel_response = client.post(
        "/api/admin/channels",
        headers=admin_headers,
        json={
            "agent_id": agent["id"],
            "project_id": project_id,
            "code": f"CHANNEL_{suffix}",
            "name": f"渠道 {suffix}",
        },
    )
    assert channel_response.status_code == 201, channel_response.text
    return agent, channel_response.json()


def test_customer_payment_query_reconciles_a_lost_callback(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    catalog = create_commerce_catalog(client, admin_headers)
    login = register_sms_user(
        client,
        admin_headers,
        catalog,
        phone="13700137000",
        device_code="query-device-001",
    )
    headers = {"Authorization": f"Bearer {login['access_token']}"}
    order = client.post(
        "/api/orders",
        headers=headers,
        json={"project_code": "ozon_helper", "plan_id": catalog["plan"]["id"]},
    ).json()
    started = client.post(
        f"/api/orders/{order['id']}/pay",
        headers=headers,
        json={"provider": "development"},
    )
    assert started.status_code == 200, started.text

    class ReconciledProvider:
        def query(self, current_order, _payment):
            return QueryResult(
                status="succeeded",
                event_id="query:lost-callback",
                provider_payment_no="DEV-RECONCILED",
                amount_cent=current_order.amount_cent,
                currency=current_order.currency,
            )

    monkeypatch.setattr(
        "app.services.order_service.build_payment_provider",
        lambda *_args, **_kwargs: ReconciledProvider(),
    )
    reconciled = client.post(f"/api/orders/{order['id']}/query", headers=headers)

    assert reconciled.status_code == 200, reconciled.text
    assert reconciled.json()["status"] == "fulfilled"
    assert reconciled.json()["activation_code"]


def test_channel_sms_order_payment_activation_and_refund_e2e(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_commerce_catalog(client, admin_headers)
    project = catalog["project"]
    plan = catalog["plan"]
    agent, channel = _agent_channel(client, admin_headers, project["id"])
    login = register_sms_user(
        client,
        admin_headers,
        catalog,
        phone="13800138000",
        channel=channel,
    )
    headers = {"Authorization": f"Bearer {login['access_token']}"}

    assert login["license_status"] == "active"
    assert login["attribution"]["source_type"] == "channel"
    assert "agent_id" not in login["attribution"]
    assert "channel_id" not in login["attribution"]
    assert login["user"]["phone"] is None
    assert login["user"]["phone_masked"] == "138****8000"
    assert "13800138000" not in str(login)

    attributed_users = client.get(
        f"/api/admin/agents/{agent['id']}/users", headers=admin_headers
    ).json()
    attribution_id = attributed_users["items"][0]["attribution_id"]
    corrected = client.post(
        f"/api/admin/attributions/{attribution_id}/reassign",
        headers=admin_headers,
        json={
            "agent_id": agent["id"],
            "channel_id": channel["id"],
            "reason": "confirm imported attribution",
        },
    )
    assert corrected.status_code == 200
    assert corrected.json()["source_type"] == "admin_reassigned"

    channels = client.get("/api/admin/channels", headers=admin_headers)
    assert channels.status_code == 200
    assert channel["distribution_token"] not in channels.text
    assert "token_hash" not in channels.text

    store = client.get("/api/store/plans?project_code=ozon_helper")
    assert store.status_code == 200
    assert store.json()["items"][0]["sale_price_cent"] == 5000
    assert store.json()["items"][0]["payment_providers"] == ["development"]

    placed = client.post(
        "/api/orders",
        headers=headers,
        json={
            "project_code": "ozon_helper",
            "plan_id": plan["id"],
            "idempotency_key": "desktop-order-0001",
        },
    )
    assert placed.status_code == 201, placed.text
    order = placed.json()
    assert order["amount_cent"] == 5000
    assert CUSTOMER_PRIVATE_ORDER_FIELDS.isdisjoint(order)

    admin_order = client.get(f"/api/admin/orders/{order['id']}", headers=admin_headers).json()
    assert admin_order["agent_id"] == agent["id"]
    assert admin_order["channel_id"] == channel["id"]
    assert admin_order["commission_rate_bps"] == 1500
    assert admin_order["commission_amount_cent"] == 750

    repeated_order = client.post(
        "/api/orders",
        headers=headers,
        json={
            "project_code": "ozon_helper",
            "plan_id": plan["id"],
            "idempotency_key": "desktop-order-0001",
        },
    )
    assert repeated_order.status_code == 201
    assert repeated_order.json()["id"] == order["id"]
    assert CUSTOMER_PRIVATE_ORDER_FIELDS.isdisjoint(repeated_order.json())

    payment = client.post(
        f"/api/orders/{order['id']}/pay",
        headers=headers,
        json={"provider": "development"},
    )
    assert payment.status_code == 200, payment.text
    assert payment.json()["qr_code_url"].startswith("development://pay/")

    queried = client.post(f"/api/orders/{order['id']}/query", headers=headers)
    assert queried.status_code == 200, queried.text
    assert queried.json()["status"] == "paying"

    intruder = create_user(client, admin_headers, "intruder", "IntruderPass123!")
    assert intruder["id"] != login["user"]["id"]
    intruder_headers = login_user(client, "intruder", "IntruderPass123!")
    forbidden = client.post(
        f"/api/payments/development/{order['order_no']}/complete",
        headers=intruder_headers,
    )
    assert forbidden.status_code == 404
    forbidden_query = client.post(f"/api/orders/{order['id']}/query", headers=intruder_headers)
    assert forbidden_query.status_code == 404

    completed = client.post(
        f"/api/payments/development/{order['order_no']}/complete", headers=headers
    )
    assert completed.status_code == 200, completed.text
    activation_code = completed.json()["activation_code"]
    assert completed.json()["status"] == "fulfilled"
    assert activation_code == completed.json()["fulfillment"]["activation_code"]
    stolen_activation = client.post(
        "/api/license/activate",
        headers=intruder_headers,
        json={
            "card_key": activation_code,
            "project_code": "ozon_helper",
            "device_code": "intruder-device-001",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert stolen_activation.status_code == 403

    duplicate = client.post(
        f"/api/payments/development/{order['order_no']}/complete", headers=headers
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["idempotent"] is True
    assert duplicate.json()["activation_code"] == activation_code

    second_order = client.post(
        "/api/orders",
        headers=headers,
        json={"project_code": "ozon_helper", "plan_id": plan["id"]},
    ).json()
    assert (
        client.post(
            f"/api/orders/{second_order['id']}/pay",
            headers=headers,
            json={"provider": "development"},
        ).status_code
        == 200
    )
    event_collision = client.post(
        f"/api/payments/development/{second_order['order_no']}/complete",
        headers=headers,
        json={"event_id": f"dev:{order['order_no']}:paid"},
    )
    assert event_collision.status_code == 409

    session_factory = client.app.state.session_factory
    with session_factory() as db:
        assert db.scalar(select(func.count(PaymentEvent.id))) == 1
        assert db.scalar(select(func.count(OrderFulfillment.id))) == 1
        # One introductory registration card plus one fulfilled order card.
        assert db.scalar(select(func.count(ActivationCode.id))) == 2
        assert db.scalar(select(func.count(CommissionRecord.id))) == 1
        user = db.get(User, login["user"]["id"])
        assert user.phone is None
        assert user.phone_hash == phone_hash(client.app.state.settings, "13800138000")
        assert user.phone_ciphertext and "13800138000" not in user.phone_ciphertext

    fetched = client.get(f"/api/orders/{order['id']}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["activation_code"] == activation_code
    assert CUSTOMER_PRIVATE_ORDER_FIELDS.isdisjoint(fetched.json())
    listed = client.get("/api/orders", headers=headers)
    assert listed.status_code == 200
    assert CUSTOMER_PRIVATE_ORDER_FIELDS.isdisjoint(listed.json()["items"][0])

    me = client.get("/api/auth/me", headers=headers)
    assert me.status_code == 200
    assert all(
        "agent_id" not in item and "channel_id" not in item for item in me.json()["attributions"]
    )

    activated = client.post(
        "/api/license/activate",
        headers=headers,
        json={
            "card_key": activation_code,
            "project_code": "ozon_helper",
            "device_code": "desktop-device-001",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert activated.status_code == 200, activated.text

    refund = client.post(
        f"/api/admin/orders/{order['id']}/refund",
        headers=admin_headers,
        json={"reason": "用户申请退款"},
    )
    assert refund.status_code == 200, refund.text
    assert refund.json()["status"] == "succeeded"
    refunded_order = client.get(f"/api/orders/{order['id']}", headers=headers)
    assert refunded_order.json()["status"] == "refunded"
    assert refunded_order.json()["activation_code"] is None
    assert refunded_order.json()["fulfillment"]["activation_code"] is None
    refunded_replay = client.post(
        f"/api/payments/development/{order['order_no']}/complete", headers=headers
    )
    assert refunded_replay.status_code == 200
    assert refunded_replay.json()["activation_code"] is None
    commissions = client.get("/api/admin/commissions", headers=admin_headers)
    assert commissions.json()["items"][0]["status"] == "reversed"
    with session_factory() as db:
        license_record = db.scalar(
            select(License).where(
                License.user_id == login["user"]["id"],
                License.plan_id == plan["id"],
            )
        )
        assert license_record.status == "disabled"
        assert license_record.offline_until is None


def test_attribution_is_locked_refresh_rotates_and_ip_limit_applies(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_commerce_catalog(client, admin_headers)
    project_id = catalog["project"]["id"]
    first_agent, first_channel = _agent_channel(client, admin_headers, project_id, "LOCK1")
    second_agent, second_channel = _agent_channel(client, admin_headers, project_id, "LOCK2")
    first_login = register_sms_user(
        client,
        admin_headers,
        catalog,
        phone="13900139000",
        channel=first_channel,
    )

    settings = client.app.state.settings
    digest = phone_hash(settings, "13900139000")
    client.app.state.otp_service.store.cancel(f"{project_id}:{digest}")
    second_login = sms_login(client, phone="13900139000", channel=second_channel)
    assert second_login["user"]["id"] == first_login["user"]["id"]
    assert "agent_id" not in second_login["attribution"]
    assert "channel_id" not in second_login["attribution"]

    with client.app.state.session_factory() as db:
        attributions = db.scalars(
            select(UserProjectAttribution).where(
                UserProjectAttribution.user_id == first_login["user"]["id"]
            )
        ).all()
        assert len(attributions) == 1
        assert attributions[0].agent_id == first_agent["id"]
        assert attributions[0].agent_id != second_agent["id"]

    refreshed = client.post(
        "/api/auth/refresh",
        json={
            "refresh_token": second_login["refresh_token"],
            "device_code": "desktop-device-001",
        },
    )
    assert refreshed.status_code == 200
    rotated_again = client.post(
        "/api/auth/refresh",
        json={
            "refresh_token": refreshed.json()["refresh_token"],
            "device_code": "desktop-device-001",
        },
    )
    assert rotated_again.status_code == 200
    replay = client.post(
        "/api/auth/refresh",
        json={
            "refresh_token": refreshed.json()["refresh_token"],
            "device_code": "desktop-device-001",
        },
    )
    assert replay.status_code == 401

    settings.sms_ip_rate_limit_per_minute = 2
    client.app.state.rate_limiter._events.clear()
    base = {
        "scene": "login_or_register",
        "project_code": "ozon_helper",
        "device_name": "限流测试",
        "version": "1.0.0",
        "version_hash": "sha256:test-build",
    }
    assert (
        client.post(
            "/api/auth/sms/send",
            json={**base, "phone": "13700000001", "device_code": "rate-device-001"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/auth/sms/send",
            json={**base, "phone": "13700000002", "device_code": "rate-device-002"},
        ).status_code
        == 200
    )
    limited = client.post(
        "/api/auth/sms/send",
        json={**base, "phone": "13700000003", "device_code": "rate-device-003"},
    )
    assert limited.status_code == 429


def test_refund_notification_is_idempotent(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_commerce_catalog(client, admin_headers)
    login = register_sms_user(
        client,
        admin_headers,
        catalog,
        phone="13600136000",
        device_code="refund-device-001",
    )
    headers = {"Authorization": f"Bearer {login['access_token']}"}
    order = client.post(
        "/api/orders",
        headers=headers,
        json={"project_code": "ozon_helper", "plan_id": catalog["plan"]["id"]},
    ).json()
    client.post(
        f"/api/orders/{order['id']}/pay",
        headers=headers,
        json={"provider": "development"},
    )
    completed = client.post(
        f"/api/payments/development/{order['order_no']}/complete", headers=headers
    )
    assert completed.status_code == 200

    session_factory = client.app.state.session_factory
    with session_factory() as db:
        record = db.get(Order, order["id"])
        payment = db.scalar(select(Payment).where(Payment.order_id == record.id))
        record.status = "refunding"
        record.payment_provider = "wechat"
        payment.provider = "wechat"
        db.add(
            Refund(
                refund_no="RF-IDEMPOTENT-001",
                order_id=record.id,
                payment_id=payment.id,
                provider_refund_no="503-refund-001",
                amount_cent=record.amount_cent,
                reason="callback test",
                status="pending",
            )
        )
        db.commit()

    notification = RefundNotification(
        order_no=None,
        refund_no="RF-IDEMPOTENT-001",
        event_id="refund:503-refund-001:SUCCESS",
        provider_refund_no="503-refund-001",
        status="succeeded",
        refund_amount_cent=5000,
        total_amount_cent=5000,
        currency="CNY",
        payload_fingerprint="verified-refund-callback",
        provider_payment_no="DEV-" + order["order_no"],
    )
    mismatched_payment = RefundNotification(
        order_no=None,
        refund_no=notification.refund_no,
        event_id="refund:wrong-payment:SUCCESS",
        provider_refund_no=notification.provider_refund_no,
        status=notification.status,
        refund_amount_cent=notification.refund_amount_cent,
        total_amount_cent=notification.total_amount_cent,
        currency=notification.currency,
        payload_fingerprint="verified-but-wrong-payment-callback",
        provider_payment_no="P-WRONG-TRANSACTION",
    )
    with session_factory() as db, pytest.raises(
        DomainError,
        match="payment transaction mismatch",
    ):
        process_refund_notification(
            db,
            provider="wechat",
            notification=mismatched_payment,
        )
    with session_factory() as db:
        assert (
            process_refund_notification(db, provider="wechat", notification=notification) is False
        )
    with session_factory() as db:
        assert process_refund_notification(db, provider="wechat", notification=notification) is True
        record = db.get(Order, order["id"])
        assert record.status == "refunded"
        assert (
            db.scalar(
                select(func.count(PaymentEvent.id)).where(
                    PaymentEvent.event_type == "refund_succeeded"
                )
            )
            == 1
        )

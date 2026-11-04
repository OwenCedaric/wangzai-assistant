from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.models import Order, PointCreditLot
from tests.helpers import (
    create_commerce_catalog,
    create_intro_cards,
    register_sms_user,
    sms_login,
)


def _create_point_package(
    client: TestClient,
    admin_headers: dict[str, str],
    product_id: int,
) -> dict[str, object]:
    response = client.post(
        "/api/admin/point-packages",
        headers=admin_headers,
        json={
            "product_id": product_id,
            "name": "积分专业包",
            "points_amount": 1000,
            "sale_price_cent": 990,
            "validity_days": 30,
            "customer_description": "用于智能工具调用",
            "featured": True,
            "display_order": 10,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _buy_point_package(
    client: TestClient,
    headers: dict[str, str],
    plan_id: int,
    idempotency_key: str,
) -> dict[str, object]:
    order_response = client.post(
        "/api/orders",
        headers=headers,
        json={
            "project_code": "ozon_helper",
            "plan_id": plan_id,
            "idempotency_key": idempotency_key,
        },
    )
    assert order_response.status_code == 201, order_response.text
    order = order_response.json()
    payment = client.post(
        f"/api/orders/{order['id']}/pay",
        headers=headers,
        json={"provider": "development"},
    )
    assert payment.status_code == 200, payment.text
    completed = client.post(
        f"/api/payments/development/{order['order_no']}/complete",
        headers=headers,
    )
    assert completed.status_code == 200, completed.text
    payload = completed.json()
    assert payload["status"] == "fulfilled"
    assert payload["activation_code"] is None
    assert payload["fulfillment"]["points_credited"] == 1000
    return {**order, "completion": payload}


def test_same_package_orders_are_isolated_per_user_and_credit_exact_owner(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_commerce_catalog(client, admin_headers)
    package = _create_point_package(client, admin_headers, catalog["product"]["id"])
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=2)
    first_login = sms_login(
        client,
        phone="13700137001",
        device_code="points-isolation-a",
        card_key=intro_cards["codes"][0],
    )
    second_login = sms_login(
        client,
        phone="13700137002",
        device_code="points-isolation-b",
        card_key=intro_cards["codes"][1],
    )
    first_headers = {"Authorization": f"Bearer {first_login['access_token']}"}
    second_headers = {"Authorization": f"Bearer {second_login['access_token']}"}
    order_payload = {
        "project_code": "ozon_helper",
        "plan_id": package["id"],
        "idempotency_key": "same-client-key",
    }

    first_order = client.post("/api/orders", headers=first_headers, json=order_payload)
    second_order = client.post("/api/orders", headers=second_headers, json=order_payload)
    assert first_order.status_code == second_order.status_code == 201
    first_order_body = first_order.json()
    second_order_body = second_order.json()
    assert first_order_body["id"] != second_order_body["id"]
    assert first_order_body["order_no"] != second_order_body["order_no"]

    assert (
        client.post(
            f"/api/orders/{first_order_body['id']}/pay",
            headers=second_headers,
            json={"provider": "development"},
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/orders/{second_order_body['id']}/pay",
            headers=first_headers,
            json={"provider": "development"},
        ).status_code
        == 404
    )

    for order, headers in (
        (first_order_body, first_headers),
        (second_order_body, second_headers),
    ):
        started = client.post(
            f"/api/orders/{order['id']}/pay",
            headers=headers,
            json={"provider": "development"},
        )
        assert started.status_code == 200, started.text

    first_paid = client.post(
        f"/api/payments/development/{first_order_body['order_no']}/complete",
        headers=first_headers,
    )
    assert first_paid.status_code == 200, first_paid.text
    first_wallet = client.get(
        "/api/points/wallet?project_code=ozon_helper", headers=first_headers
    ).json()
    second_wallet_before = client.get(
        "/api/points/wallet?project_code=ozon_helper", headers=second_headers
    ).json()
    assert first_wallet["balance_points"] == 1000
    assert second_wallet_before["balance_points"] == 0

    second_paid = client.post(
        f"/api/payments/development/{second_order_body['order_no']}/complete",
        headers=second_headers,
    )
    assert second_paid.status_code == 200, second_paid.text
    second_wallet_after = client.get(
        "/api/points/wallet?project_code=ozon_helper", headers=second_headers
    ).json()
    assert second_wallet_after["balance_points"] == 1000

    replay = client.post(
        f"/api/payments/development/{first_order_body['order_no']}/complete",
        headers=first_headers,
    )
    assert replay.status_code == 200
    assert replay.json()["idempotent"] is True
    with client.app.state.session_factory() as db:
        assert (
            db.scalar(
                select(func.count(Order.id)).where(
                    Order.id.in_([first_order_body["id"], second_order_body["id"]])
                )
            )
            == 2
        )


def test_expired_qr_order_closes_and_verified_late_payment_still_credits_owner(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_commerce_catalog(client, admin_headers)
    package = _create_point_package(client, admin_headers, catalog["product"]["id"])
    login = register_sms_user(
        client,
        admin_headers,
        catalog,
        phone="13700137003",
        device_code="points-expiry-owner",
    )
    headers = {"Authorization": f"Bearer {login['access_token']}"}
    order = client.post(
        "/api/orders",
        headers=headers,
        json={
            "project_code": "ozon_helper",
            "plan_id": package["id"],
            "idempotency_key": "expiry-order-owner",
        },
    ).json()
    started = client.post(
        f"/api/orders/{order['id']}/pay",
        headers=headers,
        json={"provider": "development"},
    )
    assert started.status_code == 200, started.text
    with client.app.state.session_factory() as db:
        record = db.get(Order, order["id"])
        record.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()

    expired = client.post(f"/api/orders/{order['id']}/query", headers=headers)
    assert expired.status_code == 200, expired.text
    assert expired.json()["status"] == "closed"

    paid = client.post(
        f"/api/payments/development/{order['order_no']}/complete",
        headers=headers,
    )
    assert paid.status_code == 200, paid.text
    assert paid.json()["status"] == "fulfilled"
    wallet = client.get(
        "/api/points/wallet?project_code=ozon_helper", headers=headers
    ).json()
    assert wallet["balance_points"] == 1000


def test_point_package_payment_wallet_spend_refund_and_expiry(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_commerce_catalog(client, admin_headers)
    package = _create_point_package(
        client,
        admin_headers,
        catalog["product"]["id"],
    )
    login = register_sms_user(
        client,
        admin_headers,
        catalog,
        phone="13900139000",
        device_code="points-device-001",
    )
    headers = {"Authorization": f"Bearer {login['access_token']}"}

    packages = client.get(
        "/api/points/packages?project_code=ozon_helper",
        headers=headers,
    )
    assert packages.status_code == 200, packages.text
    assert packages.headers["cache-control"] == "no-store"
    assert packages.json()["total"] == 1
    assert packages.json()["items"][0]["points_amount"] == 1000
    assert packages.json()["items"][0]["featured"] is True

    wallet = client.get(
        "/api/points/wallet?project_code=ozon_helper",
        headers=headers,
    )
    assert wallet.status_code == 200, wallet.text
    assert wallet.json()["balance_points"] == 0
    wallet_id = wallet.json()["wallet_id"]

    first = _buy_point_package(
        client,
        headers,
        package["id"],
        "points-order-idempotency-001",
    )
    replay = client.post(
        f"/api/payments/development/{first['order_no']}/complete",
        headers=headers,
    )
    assert replay.status_code == 200
    assert replay.json()["idempotent"] is True

    wallet = client.get(
        "/api/points/wallet?project_code=ozon_helper",
        headers=headers,
    ).json()
    assert wallet["balance_points"] == 1000
    assert wallet["lifetime_credited_points"] == 1000
    assert wallet["next_expiring_points"] == 1000

    spend_body = {
        "project_code": "ozon_helper",
        "amount_points": 250,
        "idempotency_key": "tool-run-idempotency-001",
        "reason": "智能工具调用",
        "reference_type": "smart_tool",
        "reference_id": "profit-risk-review",
    }
    spent = client.post("/api/points/spend", headers=headers, json=spend_body)
    assert spent.status_code == 200, spent.text
    assert spent.json()["wallet"]["balance_points"] == 750
    assert spent.json()["idempotent"] is False
    spent_replay = client.post("/api/points/spend", headers=headers, json=spend_body)
    assert spent_replay.status_code == 200
    assert spent_replay.json()["wallet"]["balance_points"] == 750
    assert spent_replay.json()["idempotent"] is True

    insufficient = client.post(
        "/api/points/spend",
        headers=headers,
        json={**spend_body, "amount_points": 9999, "idempotency_key": "insufficient-001"},
    )
    assert insufficient.status_code == 409

    adjustment = client.post(
        f"/api/admin/point-wallets/{wallet_id}/adjust",
        headers=admin_headers,
        json={
            "operation": "credit",
            "amount_points": 100,
            "reason": "客服补偿",
            "idempotency_key": "support-credit-001",
            "validity_days": 1,
        },
    )
    assert adjustment.status_code == 200, adjustment.text
    assert adjustment.json()["wallet"]["balance_points"] == 850

    used_refund = client.post(
        f"/api/admin/orders/{first['id']}/refund",
        headers=admin_headers,
        json={"reason": "已使用积分不应退款"},
    )
    assert used_refund.status_code == 409

    second = _buy_point_package(
        client,
        headers,
        package["id"],
        "points-order-idempotency-002",
    )
    assert (
        client.get("/api/points/wallet?project_code=ozon_helper", headers=headers).json()[
            "balance_points"
        ]
        == 1850
    )
    refunded = client.post(
        f"/api/admin/orders/{second['id']}/refund",
        headers=admin_headers,
        json={"reason": "未使用积分全额退款"},
    )
    assert refunded.status_code == 200, refunded.text
    assert refunded.json()["status"] == "succeeded"
    assert (
        client.get("/api/points/wallet?project_code=ozon_helper", headers=headers).json()[
            "balance_points"
        ]
        == 850
    )

    with client.app.state.session_factory() as db:
        admin_lot = db.scalar(
            select(PointCreditLot)
            .where(
                PointCreditLot.wallet_id == wallet_id,
                PointCreditLot.source_order_id.is_(None),
                PointCreditLot.status == "active",
            )
            .order_by(PointCreditLot.id.desc())
        )
        assert admin_lot is not None
        admin_lot.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()

    expired_wallet = client.get("/api/points/wallet?project_code=ozon_helper", headers=headers)
    assert expired_wallet.status_code == 200
    assert expired_wallet.json()["balance_points"] == 750

    ledger = client.get(
        "/api/points/ledger?project_code=ozon_helper&page_size=100",
        headers=headers,
    )
    assert ledger.status_code == 200, ledger.text
    event_types = [entry["event_type"] for entry in ledger.json()["items"]]
    assert event_types.count("purchase_credit") == 2
    assert event_types.count("spent") == 1
    assert "refund_reserved" in event_types
    assert "admin_credit" in event_types
    assert "expired" in event_types

    admin_wallets = client.get(
        "/api/admin/point-wallets?project_id=1",
        headers=admin_headers,
    )
    assert admin_wallets.status_code == 200, admin_wallets.text
    assert admin_wallets.json()["items"][0]["balance_points"] == 750

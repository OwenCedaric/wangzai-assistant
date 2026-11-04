from __future__ import annotations

import json
import re

from fastapi.testclient import TestClient
from sqlalchemy import text

CALLBACK_TOKEN = "test-ozon-callback-token-that-is-long-enough"


def enable_callback(client: TestClient) -> str:
    client.app.state.settings.ozon_notification_callback_token = CALLBACK_TOKEN
    return f"/api/ozon/notifications/{CALLBACK_TOKEN}"


def test_callback_is_hidden_when_token_is_not_configured(client: TestClient) -> None:
    response = client.post(
        "/api/ozon/notifications/not-configured-token-value",
        json={"message_type": "TYPE_PING", "time": "2026-08-22T00:00:00Z"},
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


def test_callback_rejects_wrong_token_without_revealing_secret(client: TestClient) -> None:
    enable_callback(client)

    response = client.post(
        "/api/ozon/notifications/wrong-token-value-that-is-long-enough",
        json={"message_type": "TYPE_PING", "time": "2026-08-22T00:00:00Z"},
    )

    assert response.status_code == 404
    assert CALLBACK_TOKEN not in response.text


def test_ping_returns_ozon_connection_check_contract(client: TestClient) -> None:
    callback_path = enable_callback(client)

    response = client.post(
        callback_path,
        json={"message_type": "TYPE_PING", "time": "2026-08-22T00:00:00Z"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["version"] == "1.1.0"
    assert response.json()["name"] == "Wangzai Ozon Notifications"
    assert re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z",
        response.json()["time"],
    )


def test_event_is_acknowledged_and_only_safe_receipt_is_exposed(client: TestClient) -> None:
    callback_path = enable_callback(client)
    payload = {
        "message_type": "TYPE_NEW_POSTING",
        "posting_number": "private-posting-number",
        "seller_id": 12345,
        "buyer": {"name": "private-buyer-name", "phone": "+79990000000"},
        "delivery_address": "private-delivery-address",
    }

    response = client.post(callback_path, json=payload)
    status = client.get(callback_path)

    assert response.status_code == 200
    assert response.json() == {"result": True}
    assert status.status_code == 200
    assert status.json()["received_count"] == 1
    assert status.json()["last_message_type"] == "TYPE_NEW_POSTING"
    assert len(status.json()["last_payload_sha256"]) == 64
    assert "private-posting-number" not in status.text
    assert "12345" not in status.text
    with client.app.state.session_factory() as db:
        row = db.execute(
            text(
                "SELECT message_type, seller_id, delivery_state, payload_json "
                "FROM ozon_notification_events"
            )
        ).mappings().one()
    assert row["message_type"] == "TYPE_NEW_POSTING"
    assert row["seller_id"] == "12345"
    assert row["delivery_state"] == "pending"
    assert json.loads(row["payload_json"]) == {
        "message_type": "TYPE_NEW_POSTING",
        "posting_number": "private-posting-number",
        "seller_id": "12345",
    }
    assert "private-buyer-name" not in row["payload_json"]
    assert "private-delivery-address" not in row["payload_json"]


def test_invalid_payloads_use_ozon_error_shape(client: TestClient) -> None:
    callback_path = enable_callback(client)

    wrong_content_type = client.post(
        callback_path,
        content="{}",
        headers={"Content-Type": "text/plain"},
    )
    missing_type = client.post(callback_path, json={"time": "2026-08-22T00:00:00Z"})

    assert wrong_content_type.status_code == 415
    assert wrong_content_type.json()["error"]["code"] == "ERROR_UNKNOWN"
    assert missing_type.status_code == 400
    assert missing_type.json()["error"]["code"] == "ERROR_PARAMETER_VALUE_MISSED"


def test_pending_event_is_signed_and_delivered_to_loopback_sink(
    client: TestClient, monkeypatch
) -> None:
    callback_path = enable_callback(client)
    client.app.state.settings.ozon_notification_sink_url = (
        "http://127.0.0.1:3790/api/internal/ozon/push-notifications"
    )
    client.app.state.settings.ozon_notification_sink_secret = (
        "test-desktop-sink-secret-that-is-long-enough"
    )
    captured: dict[str, object] = {}

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            body = json.loads(captured["content"])
            return {"accepted": [body["events"][0]["id"]], "deduped": []}

    def fake_post(url, *, content, headers, timeout):
        captured.update(url=url, content=content.decode("utf-8"), headers=headers, timeout=timeout)
        return Response()

    monkeypatch.setattr("app.services.ozon_notification_receiver.httpx.post", fake_post)
    response = client.post(
        callback_path,
        json={
            "message_type": "TYPE_ORDER_NEW",
            "seller_id": 778899,
            "order_number": "TEST-ORDER-1",
        },
    )

    assert response.status_code == 200
    assert captured["url"] == "http://127.0.0.1:3790/api/internal/ozon/push-notifications"
    assert str(captured["headers"]["X-Wangzai-Ozon-Push-Signature"]).startswith("t=")
    assert ",v1=" in str(captured["headers"]["X-Wangzai-Ozon-Push-Signature"])
    with client.app.state.session_factory() as db:
        state = db.scalar(text("SELECT delivery_state FROM ozon_notification_events"))
    assert state == "delivered"

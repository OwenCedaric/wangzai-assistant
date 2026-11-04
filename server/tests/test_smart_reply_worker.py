from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.models.smart_reply import SmartReplyRule, SmartReplyTask
from app.services.ozon_notification_receiver import enqueue_event
from app.services.smart_reply_worker import drain_due_tasks, process_notification_event
from tests.helpers import create_catalog, create_intro_cards


class FakeOzon:
    sent: list[tuple[str, str]] = []

    def __init__(self, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def close(self):
        return None

    def verify(self):
        return None

    def read_posting(self, posting_number: str):
        return (
            {
                "posting_number": posting_number,
                "status": "delivering",
                "substatus": "posting_in_pickup_point",
                "analytics_data": {"buyer_name": "Анна"},
                "products": [{"name": "Чехол"}],
                "in_process_at": "2026-08-23T10:00:00Z",
            },
            "FBS",
        )

    def start_chat(self, _posting_number: str):
        return "chat-1"

    def send_message(self, chat_id: str, text: str):
        self.sent.append((chat_id, text))
        return "message-1"

    def history(self, _chat_id: str):
        return [{"message_id": "message-1", "data": self.sent[-1][1]}]

    def has_return_or_refund(self, _posting_number: str):
        return False


class FakeReturnOzon(FakeOzon):
    def read_posting(self, posting_number: str):
        return (
            {
                "posting_number": posting_number,
                "status": "delivered",
                "substatus": "posting_received",
                "analytics_data": {"buyer_name": "Анна"},
                "products": [{"name": "Чехол"}],
                "in_process_at": "2026-08-23T10:00:00Z",
            },
            "FBS",
        )

    def has_return_or_refund(self, _posting_number: str):
        return True


class FakeDisableDuringChat(FakeOzon):
    disable_callback = None

    def start_chat(self, posting_number: str):
        if type(self).disable_callback is not None:
            type(self).disable_callback()
        return super().start_chat(posting_number)


def _setup(client: TestClient, admin_headers: dict[str, str]):
    catalog = create_catalog(client, admin_headers)
    cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    registered = client.post(
        "/api/auth/register",
        json={
            "password": "SmartWorkerPass123!",
            "email": "smart-worker@example.com",
            "project_code": "ozon_helper",
            "device_code": "smart-worker-device-001",
            "device_name": "测试电脑",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
            "card_key": cards["codes"][0],
        },
    ).json()
    user_headers = {"Authorization": f"Bearer {registered['access_token']}"}
    license_headers = {
        "Authorization": f"Bearer {registered['entitlement']['access_token']}"
    }
    response = client.post(
        "/api/shops/bind",
        headers=user_headers,
        json={
            "license_key": registered["entitlement"]["license_key"],
            "project_code": "ozon_helper",
            "platform": "ozon",
            "shop_name": "Ozon 一店",
            "shop_id": "10001",
        },
    )
    assert response.status_code == 201, response.text
    return license_headers


def test_push_to_live_order_check_to_template_send_and_readback_is_idempotent(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    FakeOzon.sent.clear()
    client.app.state.settings.ozon_notification_callback_token = (
        "test-smart-reply-callback-token-that-is-long-enough"
    )
    monkeypatch.setattr("app.services.smart_reply_rules.SmartReplyOzonClient", FakeOzon)
    monkeypatch.setattr("app.services.smart_reply_worker.SmartReplyOzonClient", FakeOzon)
    headers = _setup(client, admin_headers)
    credential = client.post(
        "/api/smart-reply/credentials",
        headers=headers,
        json={"client_id": "10001", "api_key": "temporary-ozon-key"},
    )
    assert credential.status_code == 200, credential.text
    rule = client.post(
        "/api/smart-reply/rules",
        headers=headers,
        json={
            "scene": "pickupReminder",
            "shop_client_ids": ["10001"],
            "send_time_type": "immediate",
            "delay_hours": 0,
            "content_generate_type": "template",
            "template_id": "pickup-reminder-1",
            "message_template": "Здравствуйте, {{买家昵称}}. Заказ {{货件编号}} готов.",
            "message_template_zh": "您好，订单已到提货点。",
            "enabled": True,
        },
    )
    assert rule.status_code == 200, rule.text

    with client.app.state.session_factory() as db:
        event = enqueue_event(
            db,
            {
                "message_type": "TYPE_STATE_CHANGED",
                "seller_id": "10001",
                "posting_number": "POST-1",
                "new_state": "posting_in_pickup_point",
            },
            received_at=datetime.now(UTC),
        )
        event_id = event.id

    process_notification_event(
        client.app.state.session_factory,
        client.app.state.settings,
        event_id,
    )
    drain_due_tasks(client.app.state.session_factory, client.app.state.settings)
    process_notification_event(
        client.app.state.session_factory,
        client.app.state.settings,
        event_id,
    )
    drain_due_tasks(client.app.state.session_factory, client.app.state.settings)

    with client.app.state.session_factory() as db:
        tasks = list(db.scalars(select(SmartReplyTask)))
    assert len(tasks) == 1
    assert tasks[0].status == "sent"
    assert tasks[0].chat_id == "chat-1"
    assert len(FakeOzon.sent) == 1
    assert FakeOzon.sent[0][1] == "Здравствуйте, Анна. Заказ POST-1 готов."


def test_review_message_is_skipped_when_live_return_exists(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    FakeReturnOzon.sent.clear()
    client.app.state.settings.ozon_notification_callback_token = (
        "test-smart-reply-callback-token-that-is-long-enough"
    )
    monkeypatch.setattr("app.services.smart_reply_rules.SmartReplyOzonClient", FakeReturnOzon)
    monkeypatch.setattr("app.services.smart_reply_worker.SmartReplyOzonClient", FakeReturnOzon)
    headers = _setup(client, admin_headers)
    credential = client.post(
        "/api/smart-reply/credentials",
        headers=headers,
        json={"client_id": "10001", "api_key": "temporary-ozon-key"},
    )
    assert credential.status_code == 200, credential.text
    rule = client.post(
        "/api/smart-reply/rules",
        headers=headers,
        json={
            "scene": "reviewRequest",
            "shop_client_ids": ["10001"],
            "send_time_type": "immediate",
            "delay_hours": 0,
            "content_generate_type": "template",
            "template_id": "review-request-1",
            "message_template": "Здравствуйте, {{买家昵称}}. Оставьте отзыв.",
            "message_template_zh": "您好，欢迎留下评价。",
            "enabled": True,
        },
    )
    assert rule.status_code == 200, rule.text

    with client.app.state.session_factory() as db:
        event = enqueue_event(
            db,
            {
                "message_type": "TYPE_STATE_CHANGED",
                "seller_id": "10001",
                "posting_number": "POST-RETURN-1",
                "new_state": "posting_received",
            },
            received_at=datetime.now(UTC),
        )
        event_id = event.id

    process_notification_event(
        client.app.state.session_factory,
        client.app.state.settings,
        event_id,
    )
    drain_due_tasks(client.app.state.session_factory, client.app.state.settings)

    with client.app.state.session_factory() as db:
        task = db.scalar(select(SmartReplyTask))
    assert task.status == "skipped"
    assert task.last_error_code == "SMART_REPLY_RETURN_OR_REFUND_EXISTS"
    assert FakeReturnOzon.sent == []


def test_turning_rule_off_while_opening_chat_prevents_message_send(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    FakeDisableDuringChat.sent.clear()
    client.app.state.settings.ozon_notification_callback_token = (
        "test-smart-reply-callback-token-that-is-long-enough"
    )
    monkeypatch.setattr(
        "app.services.smart_reply_rules.SmartReplyOzonClient",
        FakeDisableDuringChat,
    )
    monkeypatch.setattr(
        "app.services.smart_reply_worker.SmartReplyOzonClient",
        FakeDisableDuringChat,
    )
    headers = _setup(client, admin_headers)
    assert client.post(
        "/api/smart-reply/credentials",
        headers=headers,
        json={"client_id": "10001", "api_key": "temporary-ozon-key"},
    ).status_code == 200
    created = client.post(
        "/api/smart-reply/rules",
        headers=headers,
        json={
            "scene": "pickupReminder",
            "shop_client_ids": ["10001"],
            "send_time_type": "immediate",
            "delay_hours": 0,
            "content_generate_type": "template",
            "template_id": "pickup-disable-race",
            "message_template": "Заказ {{货件编号}} готов.",
            "message_template_zh": "订单已到提货点。",
            "enabled": True,
        },
    )
    assert created.status_code == 200, created.text
    rule_id = created.json()["rule_id"]
    with client.app.state.session_factory() as db:
        event = enqueue_event(
            db,
            {
                "message_type": "TYPE_STATE_CHANGED",
                "seller_id": "10001",
                "posting_number": "POST-DISABLE-RACE",
            },
            received_at=datetime.now(UTC),
        )
        event_id = event.id
    process_notification_event(
        client.app.state.session_factory,
        client.app.state.settings,
        event_id,
    )

    def disable_rule() -> None:
        with client.app.state.session_factory() as db:
            db.execute(
                update(SmartReplyRule)
                .where(SmartReplyRule.id == rule_id)
                .values(enabled=False)
            )
            db.commit()

    FakeDisableDuringChat.disable_callback = disable_rule
    try:
        drain_due_tasks(client.app.state.session_factory, client.app.state.settings)
    finally:
        FakeDisableDuringChat.disable_callback = None

    with client.app.state.session_factory() as db:
        task = db.scalar(select(SmartReplyTask))
    assert task.status == "cancelled"
    assert task.last_error_code == "SMART_REPLY_RULE_DISABLED"
    assert FakeDisableDuringChat.sent == []

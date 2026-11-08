from __future__ import annotations

from pathlib import Path

from conftest import FakeTransport
from test_commerce import make_client, order_response, phone_session_response


def test_customer_responses_can_omit_commercial_internal_fields(tmp_path: Path) -> None:
    auth = phone_session_response()
    auth["attribution"].pop("agent_id")
    auth["attribution"].pop("channel_id")
    order = order_response(status="fulfilled", activation_code="AAAA-BBBB-CCCC-DDDD")
    internal_fields = (
        "user_id",
        "project_id",
        "plan_id",
        "agent_id",
        "channel_id",
        "commission_rate_bps",
        "commission_amount_cent",
        "provider",
        "provider_payment_no",
    )
    for field in internal_fields:
        order.pop(field)
    client = make_client(tmp_path, FakeTransport(auth, order))

    session = client.verify_sms_code("13800000000", "123456")
    customer_order = client.get_order(41)

    assert session.attribution.agent_id is None
    assert session.attribution.channel_id is None
    assert customer_order.user_id is None
    assert customer_order.project_id is None
    assert customer_order.plan_id is None
    assert customer_order.commission_amount_cent is None
    assert customer_order.provider == "development"
    assert customer_order.fulfillment_code == "AAAA-BBBB-CCCC-DDDD"

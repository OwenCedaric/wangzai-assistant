from app.services.smart_reply_contract import (
    SCENE_PASSPORT,
    SCENE_PICKUP,
    SCENE_REVIEW,
    SCENE_SHIPMENT,
    detect_trigger_scene,
    missing_template_variables,
    posting_variables,
    render_template,
)


def test_four_exact_trigger_scenes_and_later_state_priority() -> None:
    assert detect_trigger_scene(
        {"status": "awaiting_packaging", "substatus": "posting_awaiting_passport_data"}
    )[0] == SCENE_PASSPORT
    assert detect_trigger_scene(
        {"status": "delivering", "substatus": "posting_in_pickup_point"}
    )[0] == SCENE_PICKUP
    assert detect_trigger_scene(
        {"status": "delivering", "substatus": "posting_in_carriage"}
    )[0] == SCENE_SHIPMENT
    assert detect_trigger_scene(
        {"status": "delivered", "substatus": "posting_received"}
    )[0] == SCENE_REVIEW


def test_cancelled_posting_never_triggers() -> None:
    assert detect_trigger_scene(
        {"status": "delivered", "substatus": "posting_received", "cancellation": {"id": 1}}
    )[0] is None
    assert detect_trigger_scene(
        {"status": "cancelled", "substatus": "posting_canceled"}
    )[0] is None


def test_template_variables_come_from_live_posting() -> None:
    posting = {
        "analytics_data": {"buyer_name": "Анна"},
        "products": [{"name": "Чехол"}, {"name": "Стекло"}],
        "in_process_at": "2026-08-23T11:12:13Z",
        "tracking_number": "RU123",
    }
    values = posting_variables(posting, "POST-1")
    rendered = render_template(
        "{{买家昵称}} / {{产品名称}} / {{下单日期}} / {{货件编号}} / {{运单号}}",
        values,
    )
    assert rendered == "Анна / Чехол, Стекло / 2026-08-23 / POST-1 / RU123"


def test_template_does_not_silently_send_when_a_used_variable_is_missing() -> None:
    assert missing_template_variables(
        "Заказ {{货件编号}}, трек {{运单号}}",
        {"posting_number": "POST-1", "tracking_number": ""},
    ) == ["{{运单号}}"]

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

SCENE_PASSPORT = "passportRequired"
SCENE_PICKUP = "pickupReminder"
SCENE_SHIPMENT = "shipmentNotice"
SCENE_REVIEW = "reviewRequest"

SUPPORTED_NOTIFICATION_TYPES = frozenset(
    {
        "TYPE_NEW_POSTING",
        "TYPE_STATE_CHANGED",
        "TYPE_POSTING_CANCELLED",
        "TYPE_ORDER_NEW",
        "TYPE_ORDER_STATE_CHANGED",
        "TYPE_ORDER_CANCELLED",
        "TYPE_FBO_POSTING_NEW",
        "TYPE_FBO_POSTING_STATE_CHANGED",
        "TYPE_FBO_POSTING_CANCELLED",
    }
)

PASSPORT_STATUSES = frozenset({"posting_awaiting_passport_data"})
PICKUP_STATUSES = frozenset({"posting_in_pickup_point"})
DELIVERED_STATUSES = frozenset({"delivered", "posting_delivered", "posting_received"})
CANCELLED_STATUSES = frozenset(
    {
        "cancelled",
        "canceled",
        "posting_canceled",
        "posting_cancelled",
        "posting_not_accepted",
    }
)
SHIPMENT_SUBSTATUSES = frozenset(
    {
        "posting_transferring_to_delivery",
        "posting_transferring_to_courier",
        "posting_driver_pick_up",
        "posting_in_carriage",
        "posting_transferred_to_courier_service",
        "posting_in_courier_service",
        "posting_on_way_to_city",
        "posting_on_way_to_pickup_point",
    }
)

VARIABLE_PLACEHOLDERS = {
    "{{买家昵称}}": "buyer_name",
    "{{产品名称}}": "product_name",
    "{{下单日期}}": "ordered_at",
    "{{货件编号}}": "posting_number",
    "{{运单号}}": "tracking_number",
}


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(*values: Any) -> str:
    for value in values:
        if value is None or isinstance(value, (dict, list)):
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _lower(*values: Any) -> str:
    return _text(*values).lower()


def notification_posting_number(payload: dict[str, Any]) -> str:
    data = _object(payload.get("data"))
    posting = _object(payload.get("posting") or data.get("posting"))
    order = _object(payload.get("order") or data.get("order"))
    return _text(
        payload.get("posting_number"),
        payload.get("postingNumber"),
        payload.get("order_number"),
        data.get("posting_number"),
        data.get("postingNumber"),
        posting.get("posting_number"),
        posting.get("number"),
        order.get("posting_number"),
        order.get("order_number"),
    )[:160]


def unwrap_posting(payload: Any) -> dict[str, Any]:
    source = _object(payload)
    result = source.get("result")
    if isinstance(result, dict):
        return result
    return source


def posting_status(posting: dict[str, Any]) -> tuple[str, str]:
    raw = _object(posting.get("raw"))
    return (
        _lower(posting.get("status"), raw.get("status")),
        _lower(posting.get("substatus"), raw.get("substatus")),
    )


def posting_is_cancelled(posting: dict[str, Any]) -> bool:
    status, substatus = posting_status(posting)
    if status in CANCELLED_STATUSES or substatus in CANCELLED_STATUSES:
        return True
    cancellation = posting.get("cancellation")
    if isinstance(cancellation, dict) and any(
        value not in (None, "", False, 0) for value in cancellation.values()
    ):
        return True
    return bool(posting.get("cancel_reason") or posting.get("cancellation_reason"))


def detect_trigger_scene(posting: dict[str, Any]) -> tuple[str | None, str]:
    """Return the one exact Miaoshou-compatible order stage currently active.

    A later state wins over an earlier state.  This prevents a delayed or
    duplicated push from sending a shipment notice after the parcel is already
    at the pickup point or delivered.
    """

    status, substatus = posting_status(posting)
    trigger_status = substatus or status
    if posting_is_cancelled(posting):
        return None, trigger_status
    if status in DELIVERED_STATUSES or substatus in DELIVERED_STATUSES:
        return SCENE_REVIEW, trigger_status
    if substatus in PICKUP_STATUSES or status in PICKUP_STATUSES:
        return SCENE_PICKUP, trigger_status
    if substatus in PASSPORT_STATUSES or status in PASSPORT_STATUSES:
        return SCENE_PASSPORT, trigger_status
    if status == "delivering" and (not substatus or substatus in SHIPMENT_SUBSTATUSES):
        return SCENE_SHIPMENT, trigger_status or status
    if substatus in SHIPMENT_SUBSTATUSES:
        return SCENE_SHIPMENT, trigger_status
    return None, trigger_status


def _date_only(value: Any) -> str:
    text = _text(value)
    if not text:
        return ""
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.astimezone(UTC).date().isoformat()
    except ValueError:
        return text[:10]


def posting_variables(posting: dict[str, Any], posting_number: str) -> dict[str, str]:
    analytics = _object(posting.get("analytics_data"))
    customer = _object(posting.get("customer"))
    products = posting.get("products") if isinstance(posting.get("products"), list) else []
    names: list[str] = []
    for product in products:
        row = _object(product)
        name = _text(row.get("name"), row.get("product_name"), row.get("title"))
        if name and name not in names:
            names.append(name)
    tracking_numbers = posting.get("tracking_numbers")
    if not isinstance(tracking_numbers, list):
        tracking_numbers = []
    return {
        "buyer_name": _text(
            analytics.get("buyer_name"),
            analytics.get("buyerName"),
            customer.get("name"),
            posting.get("customer_name"),
            "покупатель",
        ),
        "product_name": ", ".join(names[:3]) or "товар",
        "ordered_at": _date_only(
            posting.get("in_process_at")
            or posting.get("created_at")
            or posting.get("order_date")
        ),
        "posting_number": _text(posting_number, posting.get("posting_number")),
        "tracking_number": _text(
            posting.get("tracking_number"),
            posting.get("trackingNumber"),
            tracking_numbers[0] if tracking_numbers else "",
        ),
    }


def render_template(template: str, variables: dict[str, str]) -> str:
    rendered = str(template or "").strip()
    for placeholder, variable in VARIABLE_PLACEHOLDERS.items():
        rendered = rendered.replace(placeholder, str(variables.get(variable) or ""))
    return " ".join(rendered.split())


def missing_template_variables(template: str, variables: dict[str, str]) -> list[str]:
    source = str(template or "")
    return [
        placeholder
        for placeholder, variable in VARIABLE_PLACEHOLDERS.items()
        if placeholder in source and not str(variables.get(variable) or "").strip()
    ]

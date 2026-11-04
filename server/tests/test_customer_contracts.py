from fastapi.testclient import TestClient

PRIVATE_ORDER_FIELDS = {
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


def test_openapi_separates_customer_and_admin_commerce_fields(client: TestClient) -> None:
    schemas = client.get("/openapi.json").json()["components"]["schemas"]
    customer_order = set(schemas["CustomerOrderRead"]["properties"])
    admin_order = set(schemas["AdminOrderRead"]["properties"])
    attribution = set(schemas["AttributionSummary"]["properties"])

    assert PRIVATE_ORDER_FIELDS.isdisjoint(customer_order)
    assert {
        "agent_id",
        "channel_id",
        "commission_rate_bps",
        "commission_amount_cent",
        "provider_payment_no",
    } <= admin_order
    assert {"agent_id", "channel_id"}.isdisjoint(attribution)
    assert {"project_id", "project_code", "source_type", "locked_at"} <= attribution

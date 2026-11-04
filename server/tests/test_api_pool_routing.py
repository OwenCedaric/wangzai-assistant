from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.models import ApiPoolKey, ApiPoolProvider
from app.paid_capabilities.api_pool_routing import dispatch_provider_codes
from tests.test_api_pool import create_key, create_provider


def _add_text_model(client, admin_headers, provider_id: int, model: str) -> None:
    response = client.post(
        f"/api/admin/api-pool/providers/{provider_id}/models",
        headers=admin_headers,
        json={
            "capability_kind": "text",
            "model_code": model,
            "display_name": model,
            "priority": 100,
        },
    )
    assert response.status_code == 201, response.text


def test_equal_priority_text_providers_share_the_managed_key_load(
    client,
    admin_headers,
) -> None:
    primary = create_provider(client, admin_headers, code="route-primary")
    secondary = create_provider(client, admin_headers, code="route-secondary")
    for provider in (primary, secondary):
        _add_text_model(client, admin_headers, int(provider["id"]), "gpt-5.6-sol")
        create_key(client, admin_headers, int(provider["id"]), int(provider["id"]))

    with client.app.state.session_factory() as db:
        primary_key = db.scalar(
            select(ApiPoolKey).where(ApiPoolKey.provider_id == int(primary["id"]))
        )
        assert primary_key is not None
        primary_key.request_count = 10
        db.commit()

    with client.app.state.session_factory() as db:
        routes = dispatch_provider_codes(
            db,
            capability_kind="text",
            model_code="gpt-5.6-sol",
            fallback_provider_code="builtin-text",
        )
    assert routes == ("route-secondary", "route-primary")


def test_cooling_text_provider_is_kept_only_as_bounded_fallback(
    client,
    admin_headers,
) -> None:
    primary = create_provider(client, admin_headers, code="cooling-primary")
    secondary = create_provider(client, admin_headers, code="ready-secondary")
    for provider in (primary, secondary):
        _add_text_model(client, admin_headers, int(provider["id"]), "gpt-5.6-terra")
        create_key(client, admin_headers, int(provider["id"]), int(provider["id"]))

    with client.app.state.session_factory() as db:
        key = db.scalar(
            select(ApiPoolKey).where(ApiPoolKey.provider_id == int(primary["id"]))
        )
        assert key is not None
        key.cooldown_until = datetime.now(UTC) + timedelta(minutes=10)
        db.commit()

    with client.app.state.session_factory() as db:
        routes = dispatch_provider_codes(
            db,
            capability_kind="text",
            model_code="gpt-5.6-terra",
            fallback_provider_code="builtin-text",
        )
    assert routes == ("ready-secondary", "cooling-primary")


def test_image_routing_keeps_original_single_provider_contract(
    client,
    admin_headers,
) -> None:
    primary = create_provider(client, admin_headers, code="image-route-primary")
    secondary = create_provider(client, admin_headers, code="image-route-secondary")
    with client.app.state.session_factory() as db:
        for provider in (primary, secondary):
            provider_row = db.get(ApiPoolProvider, int(provider["id"]))
            assert provider_row is not None
            provider_row.base_url = "https://images.example.invalid/v1"
            provider_row.capability_kinds = ["image"]
        db.commit()
    for provider in (primary, secondary):
        response = client.post(
            f"/api/admin/api-pool/providers/{provider['id']}/models",
            headers=admin_headers,
            json={
                "capability_kind": "image",
                "model_code": "gpt-image-2",
                "display_name": "GPT Image 2",
                "priority": 100,
            },
        )
        assert response.status_code == 201, response.text

    with client.app.state.session_factory() as db:
        routes = dispatch_provider_codes(
            db,
            capability_kind="image",
            model_code="gpt-image-2",
            fallback_provider_code="builtin-image",
        )
    assert routes == ("image-route-primary",)

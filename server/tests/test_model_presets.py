from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import (
    ApiPoolKey,
    ApiPoolModel,
    ApiPoolProvider,
    PaidCapabilityRateCard,
    UserModelPreset,
)
from app.paid_capabilities.registry import get_paid_capability
from app.paid_capabilities.service import issue_quote
from tests.helpers import create_catalog, create_user, login_user


def _seed_models(client: TestClient, project_id: int) -> None:
    current = datetime.now(UTC)
    with client.app.state.session_factory() as db:
        text = ApiPoolProvider(
            code="preset-text",
            name="Preset text",
            adapter="openai-compatible",
            base_url="https://api.openai.com/v1",
            capability_kinds=["text"],
            status="active",
        )
        image = ApiPoolProvider(
            code="preset-image",
            name="Preset image",
            adapter="openai-compatible",
            base_url="https://images.example.invalid/v1",
            capability_kinds=["image"],
            status="active",
        )
        db.add_all([text, image])
        db.flush()
        db.add_all(
            [
                ApiPoolModel(
                    provider_id=text.id,
                    capability_kind="text",
                    model_code="gpt-text-pro",
                    display_name="GPT Text Pro",
                    priority=10,
                    status="active",
                ),
                ApiPoolModel(
                    provider_id=text.id,
                    capability_kind="text",
                    model_code="gpt-text-mini",
                    display_name="GPT Text Mini",
                    priority=20,
                    status="active",
                ),
                ApiPoolModel(
                    provider_id=text.id,
                    capability_kind="text",
                    model_code="unpriced-text",
                    display_name="Unpriced Text",
                    priority=30,
                    status="active",
                ),
                ApiPoolModel(
                    provider_id=image.id,
                    capability_kind="image",
                    model_code="gpt-image-2",
                    display_name="GPT Image Ready",
                    priority=10,
                    status="active",
                ),
            ]
        )
        for index in range(2):
            db.add(
                ApiPoolKey(
                    provider_id=text.id,
                    label=f"text-{index}",
                    secret_ciphertext=f"cipher-text-{index}",
                    secret_fingerprint=f"sha256:text-{index}",
                    masked_hint="sk-••••test",
                    status="active",
                    max_concurrency=0,
                )
            )
        db.add(
            ApiPoolKey(
                provider_id=image.id,
                label="image-0",
                secret_ciphertext="cipher-image-0",
                secret_fingerprint="sha256:image-0",
                masked_hint="sk-••••image",
                status="active",
                max_concurrency=0,
            )
        )
        for model_code in ("gpt-text-pro", "gpt-text-mini"):
            db.add(
                PaidCapabilityRateCard(
                    project_id=project_id,
                    capability="text.product-description",
                    version=1,
                    price_version=f"preset-{model_code}",
                    provider_code="preset-text",
                    provider_model=model_code,
                    fixed_cost_micros=100,
                    input_micros_per_million=1_000_000,
                    output_micros_per_million=1_000_000,
                    effective_from=current - timedelta(minutes=1),
                    status="active",
                )
            )
        db.add(
            PaidCapabilityRateCard(
                project_id=project_id,
                capability="image.generate",
                version=1,
                price_version="preset-image-ready",
                provider_code="preset-image",
                provider_model="gpt-image-2",
                unit_cost_micros=1_000_000,
                effective_from=current - timedelta(minutes=1),
                status="active",
            )
        )
        db.commit()


def test_model_presets_are_account_scoped_and_report_api_capacity(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    first = create_user(client, admin_headers)
    first_headers = login_user(client)
    _seed_models(client, catalog["project"]["id"])

    response = client.get(
        "/api/model-presets?project_code=ozon_helper",
        headers=first_headers,
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    groups = {item["capability_kind"]: item for item in response.json()["groups"]}
    assert groups["text"]["enabled_models"] == ["gpt-text-mini", "gpt-text-pro"]
    text_models = {item["model_code"]: item for item in groups["text"]["models"]}
    assert text_models["gpt-text-pro"]["configured_api_count"] == 2
    assert text_models["gpt-text-pro"]["available_api_count"] == 2
    assert text_models["gpt-text-pro"]["api_status"] == "available"
    assert text_models["unpriced-text"]["can_enable"] is False
    assert "积分价格" in text_models["unpriced-text"]["unavailable_reason"]

    saved = client.put(
        "/api/model-presets",
        headers=first_headers,
        json={
            "project_code": "ozon_helper",
            "groups": [
                {
                    "capability_kind": "text",
                    "enabled_models": ["gpt-text-mini"],
                    "default_model": "gpt-text-mini",
                },
                {
                    "capability_kind": "image",
                    "enabled_models": ["gpt-image-2"],
                    "default_model": "gpt-image-2",
                },
            ],
        },
    )
    assert saved.status_code == 200, saved.text
    saved_groups = {item["capability_kind"]: item for item in saved.json()["groups"]}
    assert saved_groups["text"]["enabled_models"] == ["gpt-text-mini"]
    assert saved_groups["text"]["default_model"] == "gpt-text-mini"

    create_user(client, admin_headers, username="second", password="SecondPass123!")
    second_headers = login_user(client, username="second", password="SecondPass123!")
    second_response = client.get(
        "/api/model-presets?project_code=ozon_helper",
        headers=second_headers,
    )
    second_groups = {item["capability_kind"]: item for item in second_response.json()["groups"]}
    assert second_groups["text"]["enabled_models"] == ["gpt-text-mini", "gpt-text-pro"]

    with client.app.state.session_factory() as db:
        rows = list(
            db.scalars(select(UserModelPreset).where(UserModelPreset.user_id == first["id"])).all()
        )
        assert len(rows) == 2


def test_saved_default_model_controls_paid_quote_rate_card(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    user = create_user(client, admin_headers)
    headers = login_user(client)
    _seed_models(client, catalog["project"]["id"])
    saved = client.put(
        "/api/model-presets",
        headers=headers,
        json={
            "project_code": "ozon_helper",
            "groups": [
                {
                    "capability_kind": "text",
                    "enabled_models": ["gpt-text-pro", "gpt-text-mini"],
                    "default_model": "gpt-text-mini",
                },
                {
                    "capability_kind": "image",
                    "enabled_models": ["gpt-image-2"],
                    "default_model": "gpt-image-2",
                },
            ],
        },
    )
    assert saved.status_code == 200, saved.text

    with client.app.state.session_factory() as db:
        quote = issue_quote(
            db,
            user_id=user["id"],
            project_id=catalog["project"]["id"],
            descriptor=get_paid_capability("text.product-description", 1),
            normalized_input={
                "systemPrompt": "Write accurately",
                "userPrompt": "Metal frame",
            },
            ttl_seconds=120,
        )
        rate = db.get(PaidCapabilityRateCard, quote.rate_card_id)
        assert rate is not None
        assert rate.provider_model == "gpt-text-mini"

        explicit = issue_quote(
            db,
            user_id=user["id"],
            project_id=catalog["project"]["id"],
            descriptor=get_paid_capability("text.product-description", 1),
            normalized_input={
                "systemPrompt": "Write accurately",
                "userPrompt": "Metal frame",
            },
            ttl_seconds=120,
            requested_model="gpt-text-pro",
        )
        explicit_rate = db.get(PaidCapabilityRateCard, explicit.rate_card_id)
        assert explicit_rate is not None
        assert explicit_rate.provider_model == "gpt-text-pro"


def test_unpriced_model_cannot_be_enabled(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    create_user(client, admin_headers)
    headers = login_user(client)
    _seed_models(client, catalog["project"]["id"])
    response = client.put(
        "/api/model-presets",
        headers=headers,
        json={
            "project_code": "ozon_helper",
            "groups": [
                {
                    "capability_kind": "text",
                    "enabled_models": ["unpriced-text"],
                    "default_model": "unpriced-text",
                },
                {
                    "capability_kind": "image",
                    "enabled_models": ["gpt-image-2"],
                    "default_model": "gpt-image-2",
                },
            ],
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "MODEL_PRESET_MODEL_UNAVAILABLE"

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import PointWallet, UsageLog
from app.models.paid_capabilities import PaidCapabilityJob, ProviderUsageEvent
from app.paid_capabilities.api_pool_provider import PooledPaidCapabilityProvider
from app.paid_capabilities.pricing import ProviderUsage
from app.paid_capabilities.providers import PaidProviderFailure, PaidProviderResult
from app.protected_compute.canonical import canonical_json, canonical_sha256
from app.services.point_service import credit_points
from tests.helpers import create_cards, create_catalog, create_user, login_user


class FakeProvider:
    def __init__(self, outcome: object) -> None:
        self.outcome = outcome
        self.calls = 0

    def execute(self, *_args, **_kwargs):
        self.calls += 1
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class FakePooledHttpProvider:
    def __init__(self) -> None:
        self.seen_api_key: str | None = None

    def execute_with_connection(self, *_args, connection, **_kwargs):
        self.seen_api_key = connection.api_key
        return PaidProviderResult(
            result={"text": "pooled result"},
            usage=ProviderUsage(input_tokens=12, output_tokens=8),
            provider_request_id="pool-provider-request",
        )

    def execute(self, *_args, **_kwargs):
        raise AssertionError("configured pool must not fall back to legacy environment keys")


def _nonce() -> str:
    return base64.urlsafe_b64encode(uuid4().bytes + uuid4().bytes).rstrip(b"=").decode()


def _issued_at(offset: timedelta = timedelta()) -> str:
    return (datetime.now(UTC) + offset).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def activate_paid_license(
    client: TestClient,
    admin_headers: dict[str, str],
    *,
    points: int = 10_000,
) -> tuple[dict[str, str], int, int]:
    catalog = create_catalog(client, admin_headers)
    imported = client.post(
        "/api/admin/projects/import",
        headers=admin_headers,
        json={
            "name": "Ozon助手",
            "code": "ozon_helper",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
            "modules": [
                {"code": "products.view", "name": "商品"},
                {"code": "analytics.view", "name": "数据分析"},
                {"code": "dashboard.view", "name": "看板"},
            ],
        },
    )
    assert imported.status_code == 200, imported.text
    permissions = client.get(
        f"/api/admin/permissions?project_id={catalog['project']['id']}",
        headers=admin_headers,
    ).json()["items"]
    updated = client.put(
        f"/api/admin/plans/{catalog['plan']['id']}",
        headers=admin_headers,
        json={"permission_ids": [item["id"] for item in permissions]},
    )
    assert updated.status_code == 200, updated.text
    user = create_user(client, admin_headers)
    cards = create_cards(client, admin_headers, catalog["plan"]["id"])
    activated = client.post(
        "/api/license/activate",
        headers=login_user(client),
        json={
            "card_key": cards["codes"][0],
            "project_code": "ozon_helper",
            "device_code": "paid-capability-device",
            "device_name": "Paid capability test",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert activated.status_code == 200, activated.text
    with client.app.state.session_factory() as db:
        credit_points(
            db,
            user_id=user["id"],
            project_id=catalog["project"]["id"],
            amount_points=points,
            idempotency_key=f"paid-api-seed:{user['id']}",
            event_type="test_credit",
            reason="paid API test",
        )
        db.commit()
    client.app.state.settings.paid_capability_enabled = True
    return (
        {"Authorization": f"Bearer {activated.json()['access_token']}"},
        user["id"],
        catalog["project"]["id"],
    )


def create_rate(client: TestClient, admin_headers: dict[str, str], project_id: int) -> None:
    response = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": project_id,
            "capability": "text.product-description",
            "version": 1,
            "price_version": "api-test-v1",
            "provider_code": "builtin-text",
            "provider_model": "test-model",
            "input_micros_per_million": 1_000_000,
            "output_micros_per_million": 1_000_000,
            "fixed_cost_micros": 10,
            "target_margin_basis_points": 1_800,
            "minimum_margin_basis_points": 1_500,
            "points_per_cny": 1_050,
            "effective_from": _issued_at(timedelta(minutes=-1)),
        },
    )
    assert response.status_code == 201, response.text


def quote_payload(input_payload: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "contract": "paid-capability-quote-request/v1",
        "capability": "text.product-description",
        "version": 1,
        "requestId": str(uuid4()),
        "nonce": _nonce(),
        "issuedAt": _issued_at(),
        "input": input_payload
        or {"systemPrompt": "Accurate description", "userPrompt": "Metal frame GB02"},
    }


def job_payload(quote: dict[str, object], input_payload: dict[str, object]) -> dict[str, object]:
    return {
        "contract": "paid-capability-job-request/v1",
        "quoteId": quote["quoteId"],
        "requestId": str(uuid4()),
        "nonce": _nonce(),
        "issuedAt": _issued_at(),
        "inputHash": canonical_sha256(input_payload),
        "idempotencyKey": f"job-{uuid4()}",
        "input": input_payload,
    }


def create_reconciliation_job(
    client: TestClient,
    admin_headers: dict[str, str],
) -> tuple[dict[str, str], int, int, str]:
    headers, user_id, project_id = activate_paid_license(client, admin_headers)
    create_rate(client, admin_headers, project_id)
    provider = FakeProvider(
        PaidProviderFailure(
            code="PROVIDER_TIMEOUT",
            message="provider outcome unknown",
            billable=None,
            status_code=503,
        )
    )
    client.app.state.paid_capability_provider = provider
    quote_request = quote_payload()
    quote = client.post(
        "/api/paid-capabilities/quote",
        headers=headers,
        json=quote_request,
    ).json()
    response = client.post(
        "/api/paid-capabilities/jobs",
        headers=headers,
        json=job_payload(quote, quote_request["input"]),
    )
    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == "PROVIDER_TIMEOUT"
    assert provider.calls == 1
    return headers, user_id, project_id, response.json()["detail"]["jobId"]


def test_quote_and_job_return_signed_point_bound_result(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    license_headers, _user_id, project_id = activate_paid_license(client, admin_headers)
    create_rate(client, admin_headers, project_id)
    provider = FakeProvider(
        PaidProviderResult(
            result={"text": "safe result"},
            usage=ProviderUsage(input_tokens=10, output_tokens=20),
            provider_request_id="provider-secret-id",
        )
    )
    client.app.state.paid_capability_provider = provider
    request_body = quote_payload()
    quote_response = client.post(
        "/api/paid-capabilities/quote", headers=license_headers, json=request_body
    )
    assert quote_response.status_code == 200, quote_response.text
    quote = quote_response.json()
    assert quote["inputHash"] == canonical_sha256(request_body["input"])
    assert quote["maximumPoints"] >= quote["estimatedPoints"] > 0

    public_key = serialization.load_pem_public_key(
        client.get("/api/protected-compute/public-keys").json()["keys"][0]["publicKeyPem"].encode()
    )
    quote_signature = base64.urlsafe_b64decode(quote.pop("signature") + "==")
    public_key.verify(quote_signature, canonical_json(quote))

    response = client.post(
        "/api/paid-capabilities/jobs",
        headers=license_headers,
        json=job_payload(quote, request_body["input"]),
    )
    assert response.status_code == 200, response.text
    envelope = response.json()
    signature = base64.urlsafe_b64decode(envelope.pop("signature") + "==")
    public_key.verify(signature, canonical_json(envelope))
    assert envelope["result"] == {"text": "safe result"}
    assert envelope["chargedPoints"] > 0
    assert envelope["offlinePolicy"]["allowed"] is False
    assert "provider-secret-id" not in str(envelope)
    assert provider.calls == 1


def test_database_api_pool_executes_and_settles_registered_user_points(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    license_headers, user_id, project_id = activate_paid_license(client, admin_headers)
    provider_response = client.post(
        "/api/admin/api-pool/providers",
        headers=admin_headers,
        json={
            "code": "pooled-text",
            "name": "Pooled text",
            "adapter": "openai-compatible",
            "base_url": "https://api.openai.com/v1",
            "auth_scheme": "bearer",
            "auth_header_name": "Authorization",
            "capability_kinds": ["text"],
            "timeout_seconds": 60,
            "priority": 100,
        },
    )
    assert provider_response.status_code == 201, provider_response.text
    provider_id = provider_response.json()["id"]
    model_response = client.post(
        f"/api/admin/api-pool/providers/{provider_id}/models",
        headers=admin_headers,
        json={
            "capability_kind": "text",
            "model_code": "gpt-5.6-sol",
            "display_name": "GPT 5.6 Sol",
            "priority": 100,
        },
    )
    assert model_response.status_code == 201, model_response.text
    key_response = client.post(
        f"/api/admin/api-pool/providers/{provider_id}/keys",
        headers=admin_headers,
        json={
            "label": "pool key 1",
            "secret": "sk-test-fixture-pooled-provider-secret-never-return",
            "weight": 100,
            "max_concurrency": 2,
        },
    )
    assert key_response.status_code == 201, key_response.text
    rate_response = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": project_id,
            "capability": "text.product-description",
            "version": 1,
            "price_version": "pool-rate-v1",
            "provider_code": "pooled-text",
            "provider_model": "gpt-5.6-sol",
            "input_micros_per_million": 1_000_000,
            "output_micros_per_million": 1_000_000,
            "fixed_cost_micros": 10,
            "target_margin_basis_points": 1_800,
            "minimum_margin_basis_points": 1_500,
            "points_per_cny": 1_050,
            "effective_from": _issued_at(timedelta(minutes=-1)),
        },
    )
    assert rate_response.status_code == 201, rate_response.text

    fake_http = FakePooledHttpProvider()
    client.app.state.paid_capability_provider = PooledPaidCapabilityProvider(
        client.app.state.settings,
        client.app.state.session_factory,
        http_provider=fake_http,
    )
    request_body = quote_payload()
    quote = client.post(
        "/api/paid-capabilities/quote",
        headers=license_headers,
        json=request_body,
    ).json()
    result = client.post(
        "/api/paid-capabilities/jobs",
        headers=license_headers,
        json=job_payload(quote, request_body["input"]),
    )
    assert result.status_code == 200, result.text
    assert result.json()["result"] == {"text": "pooled result"}
    assert result.json()["chargedPoints"] > 0
    assert "never-return" not in result.text
    assert fake_http.seen_api_key == "sk-test-fixture-pooled-provider-secret-never-return"
    with client.app.state.session_factory() as db:
        wallet = db.scalar(
            select(PointWallet).where(
                PointWallet.user_id == user_id,
                PointWallet.project_id == project_id,
            )
        )
        assert wallet is not None
        assert wallet.reserved_points == 0
        assert wallet.lifetime_spent_points == result.json()["chargedPoints"]


def test_replayed_quote_request_is_rejected(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    headers, _user_id, project_id = activate_paid_license(client, admin_headers)
    create_rate(client, admin_headers, project_id)
    payload = quote_payload()
    assert (
        client.post("/api/paid-capabilities/quote", headers=headers, json=payload).status_code
        == 200
    )
    replay = client.post("/api/paid-capabilities/quote", headers=headers, json=payload)
    assert replay.status_code == 409
    assert replay.json()["detail"]["code"] == "PAID_CAPABILITY_REQUEST_REPLAYED"


def test_stale_request_is_rejected_before_quote(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    headers, _user_id, project_id = activate_paid_license(client, admin_headers)
    create_rate(client, admin_headers, project_id)
    payload = quote_payload()
    payload["issuedAt"] = _issued_at(timedelta(minutes=-5))
    response = client.post("/api/paid-capabilities/quote", headers=headers, json=payload)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "PAID_CAPABILITY_REQUEST_TIME_INVALID"


def test_unknown_extra_pricing_field_is_rejected(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    headers, _user_id, project_id = activate_paid_license(client, admin_headers)
    create_rate(client, admin_headers, project_id)
    payload = quote_payload()
    payload["amountPoints"] = 0
    response = client.post("/api/paid-capabilities/quote", headers=headers, json=payload)
    assert response.status_code == 422


def test_secret_material_is_rejected_before_quote(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    headers, _user_id, project_id = activate_paid_license(client, admin_headers)
    create_rate(client, admin_headers, project_id)
    payload = quote_payload(
        {"systemPrompt": "Accurate", "userPrompt": "item", "apiKey": "forbidden"}
    )
    response = client.post("/api/paid-capabilities/quote", headers=headers, json=payload)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "PAID_CAPABILITY_INPUT_REJECTED"


def test_no_points_means_zero_provider_calls(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    headers, _user_id, project_id = activate_paid_license(client, admin_headers, points=1)
    create_rate(client, admin_headers, project_id)
    provider = FakeProvider(
        PaidProviderResult(result={"text": "must not run"}, usage=ProviderUsage())
    )
    client.app.state.paid_capability_provider = provider
    quote_request = quote_payload()
    quote = client.post("/api/paid-capabilities/quote", headers=headers, json=quote_request).json()
    response = client.post(
        "/api/paid-capabilities/jobs",
        headers=headers,
        json=job_payload(quote, quote_request["input"]),
    )
    assert response.status_code == 402
    assert response.json()["detail"]["code"] == "POINT_BALANCE_INSUFFICIENT"
    assert provider.calls == 0


def test_unbilled_provider_failure_releases_reservation(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    headers, _user_id, project_id = activate_paid_license(client, admin_headers)
    create_rate(client, admin_headers, project_id)
    provider = FakeProvider(PaidProviderFailure("REJECTED", "rejected", False))
    client.app.state.paid_capability_provider = provider
    quote_request = quote_payload()
    quote = client.post("/api/paid-capabilities/quote", headers=headers, json=quote_request).json()
    response = client.post(
        "/api/paid-capabilities/jobs",
        headers=headers,
        json=job_payload(quote, quote_request["input"]),
    )
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "REJECTED"
    with client.app.state.session_factory() as db:
        wallet = db.scalar(select(PointWallet).where(PointWallet.project_id == project_id))
        assert wallet is not None
        assert wallet.reserved_points == 0


def test_only_admin_can_release_an_unknown_provider_outcome(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    license_headers, _user_id, project_id, job_id = create_reconciliation_job(client, admin_headers)
    forbidden = client.post(
        f"/api/admin/paid-capabilities/reconciliations/{job_id}",
        headers=license_headers,
        json={"decision": "release_unbilled", "note": "provider confirms no charge"},
    )
    assert forbidden.status_code == 403

    listed = client.get(
        f"/api/admin/paid-capabilities/reconciliations?project_id={project_id}",
        headers=admin_headers,
    )
    assert listed.status_code == 200, listed.text
    assert [row["id"] for row in listed.json()] == [job_id]
    assert listed.json()[0]["reserved_points"] > 0

    response = client.post(
        f"/api/admin/paid-capabilities/reconciliations/{job_id}",
        headers=admin_headers,
        json={"decision": "release_unbilled", "note": "provider confirms no charge"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "failed_unbilled"
    assert response.json()["released_points"] == response.json()["reserved_points"]
    repeated = client.post(
        f"/api/admin/paid-capabilities/reconciliations/{job_id}",
        headers=admin_headers,
        json={"decision": "release_unbilled", "note": "must not release twice"},
    )
    assert repeated.status_code == 409
    with client.app.state.session_factory() as db:
        wallet = db.scalar(select(PointWallet).where(PointWallet.project_id == project_id))
        job = db.get(PaidCapabilityJob, job_id)
        audit = db.scalar(
            select(UsageLog).where(
                UsageLog.event == "paid_capability_reconciled",
                UsageLog.project_id == project_id,
            )
        )
        assert wallet is not None and wallet.reserved_points == 0
        assert job is not None and job.reservation.release_reason == "管理员对账确认供应商未计费"
        assert audit is not None
        assert "provider confirms no charge" not in str(audit.details)
        assert len(str(audit.details["note_sha256"])) == 64


def test_admin_can_settle_unknown_outcome_from_verified_usage_without_leaking_provider_id(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    _license_headers, _user_id, project_id, job_id = create_reconciliation_job(
        client, admin_headers
    )
    provider_request_id = "provider-sensitive-request-id"
    response = client.post(
        f"/api/admin/paid-capabilities/reconciliations/{job_id}",
        headers=admin_headers,
        json={
            "decision": "settle_billed",
            "input_tokens": 10,
            "output_tokens": 20,
            "actual_provider_cost_micros": 40,
            "provider_request_id": provider_request_id,
            "note": "provider dashboard confirms charge",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "failed_billed"
    assert 0 < response.json()["settled_points"] <= response.json()["reserved_points"]
    assert response.json()["released_points"] == (
        response.json()["reserved_points"] - response.json()["settled_points"]
    )
    assert provider_request_id not in response.text
    with client.app.state.session_factory() as db:
        wallet = db.scalar(select(PointWallet).where(PointWallet.project_id == project_id))
        job = db.get(PaidCapabilityJob, job_id)
        usage = db.scalar(select(ProviderUsageEvent).where(ProviderUsageEvent.job_id == job_id))
        audit = db.scalar(
            select(UsageLog).where(
                UsageLog.event == "paid_capability_reconciled",
                UsageLog.project_id == project_id,
            )
        )
        assert wallet is not None and wallet.reserved_points == 0
        assert job is not None and provider_request_id not in str(job.provider_request_id_hash)
        assert usage is not None and provider_request_id not in str(usage.provider_request_id_hash)
        assert audit is not None and provider_request_id not in str(audit.details)


def test_reconciliation_cannot_charge_above_original_reservation(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    _license_headers, _user_id, project_id, job_id = create_reconciliation_job(
        client, admin_headers
    )
    response = client.post(
        f"/api/admin/paid-capabilities/reconciliations/{job_id}",
        headers=admin_headers,
        json={
            "decision": "settle_billed",
            "input_tokens": 2_000_000_000,
            "output_tokens": 2_000_000_000,
            "actual_provider_cost_micros": 2_000_000_000,
            "note": "intentionally excessive usage",
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "PAID_CAPABILITY_USAGE_ABOVE_RESERVATION"
    with client.app.state.session_factory() as db:
        wallet = db.scalar(select(PointWallet).where(PointWallet.project_id == project_id))
        job = db.get(PaidCapabilityJob, job_id)
        assert wallet is not None and wallet.reserved_points > 0
        assert job is not None and job.status == "reconciliation_required"


def test_reconciliation_rejects_secret_shaped_notes_without_changing_reservation(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    _license_headers, _user_id, project_id, job_id = create_reconciliation_job(
        client, admin_headers
    )
    response = client.post(
        f"/api/admin/paid-capabilities/reconciliations/{job_id}",
        headers=admin_headers,
        json={
            "decision": "release_unbilled",
            "note": "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        },
    )
    assert response.status_code == 422
    with client.app.state.session_factory() as db:
        wallet = db.scalar(select(PointWallet).where(PointWallet.project_id == project_id))
        job = db.get(PaidCapabilityJob, job_id)
        assert wallet is not None and wallet.reserved_points > 0
        assert job is not None and job.status == "reconciliation_required"


def test_rate_card_margin_below_fifteen_percent_is_rejected(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    response = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": catalog["project"]["id"],
            "capability": "text.product-description",
            "version": 1,
            "price_version": "unsafe-margin",
            "provider_code": "builtin-text",
            "provider_model": "test",
            "output_micros_per_million": 1,
            "target_margin_basis_points": 1_499,
            "minimum_margin_basis_points": 1_500,
            "effective_from": _issued_at(),
        },
    )
    assert response.status_code == 422


def test_rate_card_margin_above_twenty_percent_is_rejected(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    response = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": catalog["project"]["id"],
            "capability": "text.product-description",
            "version": 1,
            "price_version": "excessive-margin",
            "provider_code": "builtin-text",
            "provider_model": "test",
            "output_micros_per_million": 1,
            "target_margin_basis_points": 2_001,
            "minimum_margin_basis_points": 1_500,
            "effective_from": _issued_at(),
        },
    )
    assert response.status_code == 422


def test_admin_can_create_exact_one_point_two_text_markup_rate(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    response = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": catalog["project"]["id"],
            "capability": "text.product-description",
            "version": 1,
            "price_version": "exact-text-markup",
            "provider_code": "builtin-text",
            "provider_model": "test",
            "output_micros_per_million": 1,
            "customer_multiplier_ppm": 1_200_000,
            "target_margin_basis_points": 0,
            "minimum_margin_basis_points": 0,
            "effective_from": _issued_at(),
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["customer_multiplier_ppm"] == 1_200_000
    assert response.json()["target_margin_basis_points"] == 0


def test_admin_rejects_zero_margin_text_rate_without_exact_one_point_two_markup(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    response = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": catalog["project"]["id"],
            "capability": "text.product-description",
            "version": 1,
            "price_version": "unsafe-text-markup",
            "provider_code": "builtin-text",
            "provider_model": "test",
            "output_micros_per_million": 1,
            "customer_multiplier_ppm": 1_100_000,
            "target_margin_basis_points": 0,
            "minimum_margin_basis_points": 0,
            "effective_from": _issued_at(),
        },
    )
    assert response.status_code == 422


def test_rate_card_cannot_underprice_an_active_point_package(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    package = client.post(
        "/api/admin/point-packages",
        headers=admin_headers,
        json={
            "product_id": catalog["product"]["id"],
            "name": "high-discount-points",
            "points_amount": 2_000,
            "sale_price_cent": 100,
            "validity_days": 30,
            "online_sale_enabled": True,
            "status": "active",
        },
    )
    assert package.status_code == 201, package.text
    response = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": catalog["project"]["id"],
            "capability": "text.product-description",
            "version": 1,
            "price_version": "underpriced-points",
            "provider_code": "builtin-text",
            "provider_model": "test",
            "output_micros_per_million": 1,
            "target_margin_basis_points": 1_800,
            "minimum_margin_basis_points": 1_500,
            "points_per_cny": 1_050,
            "effective_from": _issued_at(),
        },
    )
    assert response.status_code == 422
    assert "most generous active point package" in response.json()["detail"]


def test_point_package_discount_cannot_dilute_an_active_rate_card(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    create_rate(client, admin_headers, catalog["project"]["id"])
    response = client.post(
        "/api/admin/point-packages",
        headers=admin_headers,
        json={
            "product_id": catalog["product"]["id"],
            "name": "unsafe-future-discount",
            "points_amount": 2_000,
            "sale_price_cent": 100,
            "validity_days": 30,
            "online_sale_enabled": True,
            "status": "active",
        },
    )
    assert response.status_code == 409
    assert "underprice an active paid capability" in response.json()["detail"]


def test_admin_can_list_and_disable_an_immutable_rate_card(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    project_id = catalog["project"]["id"]
    create_rate(client, admin_headers, project_id)
    listed = client.get(
        f"/api/admin/paid-capabilities/rate-cards?project_id={project_id}",
        headers=admin_headers,
    )
    assert listed.status_code == 200
    rows = listed.json()
    assert len(rows) == 1
    assert rows[0]["target_margin_basis_points"] == 1_800
    disabled = client.post(
        f"/api/admin/paid-capabilities/rate-cards/{rows[0]['id']}/disable",
        headers=admin_headers,
    )
    assert disabled.status_code == 200
    assert disabled.json()["status"] == "disabled"


def test_admin_can_replace_an_active_image_price_without_mutating_history(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    created = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": catalog["project"]["id"],
            "capability": "image.generate",
            "version": 1,
            "price_version": "image-initial",
            "provider_code": "builtin-image",
            "provider_model": "gpt-image-2",
            "unit_cost_micros": 20_000,
            "unit_sell_price_micros": 50_000,
            "target_margin_basis_points": 1_800,
            "minimum_margin_basis_points": 1_500,
            "points_per_cny": 1_050,
            "effective_from": _issued_at(timedelta(minutes=-1)),
        },
    )
    assert created.status_code == 201, created.text
    changed = client.post(
        f"/api/admin/paid-capabilities/rate-cards/{created.json()['id']}/image-price",
        headers=admin_headers,
        json={"unit_cost_micros": 25_000, "unit_sell_price_micros": 60_000},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["unit_cost_micros"] == 25_000
    assert changed.json()["unit_sell_price_micros"] == 60_000
    listed = client.get(
        f"/api/admin/paid-capabilities/rate-cards?project_id={catalog['project']['id']}",
        headers=admin_headers,
    )
    rows = listed.json()
    assert {row["status"] for row in rows} == {"active", "disabled"}
    historical = next(row for row in rows if row["id"] == created.json()["id"])
    assert historical["unit_sell_price_micros"] == 50_000


def test_admin_rejects_every_image_rate_model_except_gpt_image_2(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    rejected = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": catalog["project"]["id"],
            "capability": "image.generate",
            "version": 1,
            "price_version": "image-forbidden",
            "provider_code": "builtin-image",
            "provider_model": "gpt-image-2-adobe",
            "unit_cost_micros": 20_000,
            "unit_sell_price_micros": 50_000,
            "target_margin_basis_points": 1_800,
            "minimum_margin_basis_points": 1_500,
            "points_per_cny": 1_050,
            "effective_from": _issued_at(timedelta(minutes=-1)),
        },
    )
    assert rejected.status_code == 422, rejected.text
    assert "gpt-image-2" in rejected.json()["detail"]


def test_admin_can_replace_rate_multipliers_without_mutating_history(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    create_rate(client, admin_headers, catalog["project"]["id"])
    created = client.get(
        f"/api/admin/paid-capabilities/rate-cards?project_id={catalog['project']['id']}",
        headers=admin_headers,
    ).json()[0]
    changed = client.post(
        f"/api/admin/paid-capabilities/rate-cards/{created['id']}/multipliers",
        headers=admin_headers,
        json={"provider_multiplier_ppm": 800_000, "customer_multiplier_ppm": 1_150_000},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["provider_multiplier_ppm"] == 800_000
    assert changed.json()["customer_multiplier_ppm"] == 1_150_000
    listed = client.get(
        f"/api/admin/paid-capabilities/rate-cards?project_id={catalog['project']['id']}",
        headers=admin_headers,
    ).json()
    historical = next(row for row in listed if row["id"] == created["id"])
    assert historical["status"] == "disabled"
    assert historical["customer_multiplier_ppm"] == 1_000_000


def test_admin_cannot_drift_exact_text_markup_away_from_one_point_two(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    created = client.post(
        "/api/admin/paid-capabilities/rate-cards",
        headers=admin_headers,
        json={
            "project_id": catalog["project"]["id"],
            "capability": "text.product-description",
            "version": 1,
            "price_version": "exact-text-markup-lock",
            "provider_code": "builtin-text",
            "provider_model": "test",
            "output_micros_per_million": 1,
            "customer_multiplier_ppm": 1_200_000,
            "target_margin_basis_points": 0,
            "minimum_margin_basis_points": 0,
            "effective_from": _issued_at(timedelta(minutes=-1)),
        },
    )
    assert created.status_code == 201, created.text
    changed = client.post(
        f"/api/admin/paid-capabilities/rate-cards/{created.json()['id']}/multipliers",
        headers=admin_headers,
        json={
            "provider_multiplier_ppm": 1_000_000,
            "customer_multiplier_ppm": 1_100_000,
        },
    )
    assert changed.status_code == 422

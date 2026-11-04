from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import PointWallet
from app.models.paid_capabilities import (
    PaidCapabilityJob,
    PaidCapabilityRateCard,
    ProviderUsageEvent,
)
from app.paid_capabilities.pricing import ProviderUsage
from app.paid_capabilities.providers import PaidProviderFailure, PaidProviderResult
from app.paid_capabilities.registry import get_paid_capability
from app.paid_capabilities.service import (
    PaidCapabilityFailure,
    execute_paid_capability,
    issue_quote,
)
from app.protected_compute.canonical import canonical_sha256
from app.services.errors import DomainError
from tests.test_paid_capability_reservations import seeded_wallet


class FakeProvider:
    def __init__(self, outcome: object) -> None:
        self.outcome = outcome
        self.calls = 0

    def execute(self, *_args, **_kwargs):
        self.calls += 1
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


def add_rate(db, *, project_id: int) -> PaidCapabilityRateCard:
    rate = PaidCapabilityRateCard(
        project_id=project_id,
        capability="text.product-description",
        version=1,
        price_version="test-v1",
        provider_code="builtin-text",
        provider_model="test-model",
        input_micros_per_million=1_000_000,
        output_micros_per_million=1_000_000,
        cached_input_micros_per_million=100_000,
        fixed_cost_micros=10,
        unit_cost_micros=0,
        provider_multiplier_ppm=1_000_000,
        risk_buffer_basis_points=500,
        target_margin_basis_points=1_800,
        minimum_margin_basis_points=1_500,
        points_per_cny=1_050,
        effective_from=datetime.now(UTC) - timedelta(minutes=1),
        status="active",
    )
    db.add(rate)
    db.flush()
    return rate


def add_fixed_image_rate(db, *, project_id: int) -> PaidCapabilityRateCard:
    rate = PaidCapabilityRateCard(
        project_id=project_id,
        capability="image.generate",
        version=1,
        price_version="image-fixed-v1",
        provider_code="builtin-image",
        provider_model="gpt-image-2",
        unit_cost_micros=150_000,
        unit_sell_price_micros=300_000,
        provider_multiplier_ppm=1_000_000,
        risk_buffer_basis_points=0,
        target_margin_basis_points=1_800,
        minimum_margin_basis_points=1_500,
        points_per_cny=1_050,
        effective_from=datetime.now(UTC) - timedelta(minutes=1),
        status="active",
    )
    db.add(rate)
    db.flush()
    return rate


def prepare(db, *, user_id: int, project_id: int):
    add_rate(db, project_id=project_id)
    descriptor = get_paid_capability("text.product-description", 1)
    normalized = descriptor.normalize(
        {"systemPrompt": "Write accurate product data", "userPrompt": "Metal frame GB02"}
    )
    quote = issue_quote(
        db,
        user_id=user_id,
        project_id=project_id,
        descriptor=descriptor,
        normalized_input=normalized,
        ttl_seconds=120,
    )
    return descriptor, normalized, quote


def execute(db, *, user_id, project_id, descriptor, normalized, quote, provider, key="idem-1"):
    return execute_paid_capability(
        db,
        user_id=user_id,
        project_id=project_id,
        descriptor=descriptor,
        quote_id=quote.id,
        normalized_input=normalized,
        input_hash=canonical_sha256(normalized),
        idempotency_key=key,
        provider=provider,
    )


def test_provider_specific_multiplier_uses_the_actual_routed_provider(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _wallet_id = seeded_wallet(client, admin_headers, amount=10_000)
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(
            db,
            user_id=user_id,
            project_id=project_id,
        )
        job = execute(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            normalized=normalized,
            quote=quote,
            provider=FakeProvider(
                PaidProviderResult(
                    result={"text": "ok"},
                    usage=ProviderUsage(input_tokens=1_000),
                    provider_code="dragon",
                )
            ),
        )
        event = db.scalar(
            select(ProviderUsageEvent).where(ProviderUsageEvent.job_id == job.id)
        )
        assert event is not None
        assert event.provider_code == "dragon"
        assert event.provider_cost_micros == 101


def test_fixed_approved_image_price_charges_315_points_and_keeps_actual_cost_for_audit(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers, amount=10_000)
    with client.app.state.session_factory() as db:
        add_fixed_image_rate(db, project_id=project_id)
        descriptor = get_paid_capability("image.generate", 1)
        normalized = descriptor.normalize(
            {
                "prompt": "neutral product test",
                "size": "1024x1024",
                "quality": "standard",
                "count": 1,
                "shopId": "ozon-shop-test",
            }
        )
        quote = issue_quote(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            normalized_input=normalized,
            ttl_seconds=120,
        )
        assert quote.estimated_points == 315
        provider = FakeProvider(
            PaidProviderResult(
                result={"images": ["https://example.com/approved-image-test.png"]},
                usage=ProviderUsage(units=1),
                provider_request_id="approved-image-fixed-price-test",
                actual_provider_cost_micros=143_478,
                provider_cost_source="provider_task_credit_cost",
            )
        )
        job = execute(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            normalized=normalized,
            quote=quote,
            provider=provider,
            key="approved-image-fixed-price",
        )
        wallet = db.get(PointWallet, wallet_id)
        usage = db.scalar(select(ProviderUsageEvent).where(ProviderUsageEvent.job_id == job.id))
        assert job.status == "completed"
        assert wallet is not None and wallet.balance_points == 9_685
        assert wallet.metered_provider_cost_micros == 0
        assert usage is not None and usage.provider_cost_micros == 143_478
        assert usage.charged_points == 315


def test_success_reserves_before_provider_and_settles_actual(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers, amount=10_000)
    provider = FakeProvider(
        PaidProviderResult(
            result={"text": "result"},
            usage=ProviderUsage(input_tokens=20, output_tokens=100),
            provider_request_id="secret-provider-request-id",
        )
    )
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        job = execute(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            normalized=normalized,
            quote=quote,
            provider=provider,
        )
        wallet = db.get(PointWallet, wallet_id)
        assert job.status == "completed"
        assert job.result_json == {"text": "result"}
        assert job.provider_request_id_hash.startswith("sha256:")
        assert "secret-provider" not in job.provider_request_id_hash
        assert wallet.reserved_points == 0
        assert 0 < wallet.lifetime_spent_points < quote.maximum_points
        assert provider.calls == 1


def test_idempotent_success_never_calls_provider_twice(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _ = seeded_wallet(client, admin_headers, amount=10_000)
    provider = FakeProvider(
        PaidProviderResult(result={"text": "ok"}, usage=ProviderUsage(output_tokens=10))
    )
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        first = execute(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            normalized=normalized,
            quote=quote,
            provider=provider,
        )
        second = execute(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            normalized=normalized,
            quote=quote,
            provider=provider,
        )
        assert first.id == second.id
        assert provider.calls == 1


def test_insufficient_points_prevents_provider_call(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _ = seeded_wallet(client, admin_headers, amount=1)
    provider = FakeProvider(
        PaidProviderResult(result={"text": "must not run"}, usage=ProviderUsage())
    )
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        with pytest.raises(DomainError, match="Insufficient point balance"):
            execute(
                db,
                user_id=user_id,
                project_id=project_id,
                descriptor=descriptor,
                normalized=normalized,
                quote=quote,
                provider=provider,
            )
        assert provider.calls == 0


def test_known_unbilled_failure_releases_all_points(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers, amount=10_000)
    provider = FakeProvider(PaidProviderFailure("REJECTED", "rejected", False))
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        with pytest.raises(PaidCapabilityFailure, match="rejected"):
            execute(
                db,
                user_id=user_id,
                project_id=project_id,
                descriptor=descriptor,
                normalized=normalized,
                quote=quote,
                provider=provider,
            )
        wallet = db.get(PointWallet, wallet_id)
        job = db.scalar(select(PaidCapabilityJob).where(PaidCapabilityJob.quote_id == quote.id))
        assert wallet.balance_points == 10_000
        assert wallet.reserved_points == 0
        assert job.status == "failed_unbilled"


def test_known_billable_failure_settles_reported_usage(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers, amount=10_000)
    provider = FakeProvider(
        PaidProviderFailure(
            "BAD_RESULT",
            "bad result",
            True,
            usage=ProviderUsage(output_tokens=20),
        )
    )
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        with pytest.raises(PaidCapabilityFailure):
            execute(
                db,
                user_id=user_id,
                project_id=project_id,
                descriptor=descriptor,
                normalized=normalized,
                quote=quote,
                provider=provider,
            )
        wallet = db.get(PointWallet, wallet_id)
        job = db.scalar(select(PaidCapabilityJob).where(PaidCapabilityJob.quote_id == quote.id))
        assert wallet.reserved_points == 0
        assert wallet.lifetime_spent_points > 0
        assert job.status == "failed_billed"
        assert db.scalar(select(ProviderUsageEvent).where(ProviderUsageEvent.job_id == job.id))


def test_unknown_provider_outcome_keeps_reservation(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers, amount=10_000)
    provider = FakeProvider(PaidProviderFailure("TIMEOUT", "unknown", None))
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        with pytest.raises(PaidCapabilityFailure):
            execute(
                db,
                user_id=user_id,
                project_id=project_id,
                descriptor=descriptor,
                normalized=normalized,
                quote=quote,
                provider=provider,
            )
        wallet = db.get(PointWallet, wallet_id)
        job = db.scalar(select(PaidCapabilityJob).where(PaidCapabilityJob.quote_id == quote.id))
        assert wallet.reserved_points == quote.maximum_points
        assert job.status == "reconciliation_required"


def test_unexpected_provider_exception_keeps_reservation(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers, amount=10_000)
    provider = FakeProvider(RuntimeError("socket closed after request"))
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        with pytest.raises(PaidCapabilityFailure) as failure:
            execute(
                db,
                user_id=user_id,
                project_id=project_id,
                descriptor=descriptor,
                normalized=normalized,
                quote=quote,
                provider=provider,
            )
        assert failure.value.code == "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN"
        assert db.get(PointWallet, wallet_id).reserved_points == quote.maximum_points


def test_input_hash_tamper_prevents_provider_call(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _ = seeded_wallet(client, admin_headers, amount=10_000)
    provider = FakeProvider(PaidProviderResult(result={"text": "x"}, usage=ProviderUsage()))
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        with pytest.raises(PaidCapabilityFailure) as failure:
            execute_paid_capability(
                db,
                user_id=user_id,
                project_id=project_id,
                descriptor=descriptor,
                quote_id=quote.id,
                normalized_input=normalized,
                input_hash="sha256:" + "0" * 64,
                idempotency_key="tampered-1",
                provider=provider,
            )
        assert failure.value.code == "PAID_CAPABILITY_INPUT_HASH_MISMATCH"
        assert provider.calls == 0


def test_expired_quote_prevents_provider_call(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _ = seeded_wallet(client, admin_headers, amount=10_000)
    provider = FakeProvider(PaidProviderResult(result={"text": "x"}, usage=ProviderUsage()))
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        quote.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        with pytest.raises(PaidCapabilityFailure) as failure:
            execute(
                db,
                user_id=user_id,
                project_id=project_id,
                descriptor=descriptor,
                normalized=normalized,
                quote=quote,
                provider=provider,
            )
        assert failure.value.code == "PAID_CAPABILITY_QUOTE_EXPIRED"
        assert provider.calls == 0


def test_idempotency_key_cannot_be_rebound_to_changed_input(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _ = seeded_wallet(client, admin_headers, amount=10_000)
    provider = FakeProvider(
        PaidProviderResult(result={"text": "ok"}, usage=ProviderUsage(output_tokens=10))
    )
    with client.app.state.session_factory() as db:
        descriptor, normalized, quote = prepare(db, user_id=user_id, project_id=project_id)
        execute(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            normalized=normalized,
            quote=quote,
            provider=provider,
        )
        other = descriptor.normalize(
            {"systemPrompt": "Write accurate product data", "userPrompt": "changed"}
        )
        other_quote = issue_quote(
            db,
            user_id=user_id,
            project_id=project_id,
            descriptor=descriptor,
            normalized_input=other,
            ttl_seconds=120,
        )
        with pytest.raises(PaidCapabilityFailure) as failure:
            execute(
                db,
                user_id=user_id,
                project_id=project_id,
                descriptor=descriptor,
                normalized=other,
                quote=other_quote,
                provider=provider,
            )
        assert failure.value.code == "PAID_CAPABILITY_IDEMPOTENCY_CONFLICT"
        assert provider.calls == 1

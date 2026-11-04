from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import PointCreditLot, PointWallet
from app.models.paid_capabilities import PaidCapabilityJob, PointReservation
from app.paid_capabilities.pricing import PricingPolicy
from app.paid_capabilities.reservations import (
    _increment_lot_reservation_counter,
    release_paid_capability_job,
    reserve_paid_capability_job,
    settle_paid_capability_job,
)
from app.services.errors import DomainError
from app.services.point_service import credit_points, expire_due_lots, spend_points
from tests.helpers import create_catalog, create_user


def seeded_wallet(
    client: TestClient,
    admin_headers: dict[str, str],
    *,
    amount: int = 1_000,
    expires_at: datetime | None = None,
) -> tuple[int, int, int]:
    catalog = create_catalog(client, admin_headers)
    user = create_user(client, admin_headers)
    with client.app.state.session_factory() as db:
        wallet, _lot, _ = credit_points(
            db,
            user_id=user["id"],
            project_id=catalog["project"]["id"],
            amount_points=amount,
            idempotency_key=f"seed:{user['id']}:{amount}",
            event_type="test_credit",
            reason="paid capability test seed",
            expires_at=expires_at,
        )
        db.commit()
        return user["id"], catalog["project"]["id"], wallet.id


def create_job(db, *, user_id: int, project_id: int, suffix: str) -> PaidCapabilityJob:
    job = PaidCapabilityJob(
        id=f"job-{suffix}",
        user_id=user_id,
        project_id=project_id,
        capability="text.product-description",
        version=1,
        input_hash=f"sha256:{suffix.zfill(64)[-64:]}",
        request_hash=f"sha256:{('a' + suffix).zfill(64)[-64:]}",
        idempotency_key=f"idem-{suffix}",
        status="quoted",
    )
    db.add(job)
    db.flush()
    return job


def test_credit_lot_reservation_counter_uses_atomic_database_addition(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    _user_id, _project_id, wallet_id = seeded_wallet(
        client,
        admin_headers,
        amount=1_000,
    )
    with client.app.state.session_factory() as db:
        lot = db.scalar(select(PointCreditLot).where(PointCreditLot.wallet_id == wallet_id))
        assert lot is not None and lot.reserved_points == 0

        assert _increment_lot_reservation_counter(db, lot_id=lot.id, amount_points=164)
        assert _increment_lot_reservation_counter(db, lot_id=lot.id, amount_points=165)
        db.expire(lot)

        assert lot.reserved_points == 329


def metered_policy() -> PricingPolicy:
    return PricingPolicy(
        input_micros_per_million=0,
        output_micros_per_million=0,
        cached_input_micros_per_million=0,
        fixed_cost_micros=0,
        unit_cost_micros=0,
        provider_multiplier_ppm=1_000_000,
        risk_buffer_basis_points=0,
        target_margin_basis_points=1_800,
        minimum_margin_basis_points=1_500,
        points_per_cny=1_050,
    )


def test_reserve_settle_releases_difference_and_spends_only_actual(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="1")
        reservation, idempotent = reserve_paid_capability_job(db, job=job, amount_points=100)
        assert idempotent is False
        db.commit()
        wallet = db.get(PointWallet, wallet_id)
        assert wallet.balance_points == 1_000
        assert wallet.reserved_points == 100

        settled = settle_paid_capability_job(db, job=job, actual_points=35)
        db.commit()
        assert settled.settled_points == 35
        assert settled.released_points == 65
        assert job.status == "settled"
        assert wallet.balance_points == 965
        assert wallet.reserved_points == 0
        assert wallet.lifetime_spent_points == 35
        assert reservation.id == settled.id


def test_metered_cost_accumulator_removes_systematic_per_request_rounding(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        first = create_job(db, user_id=user_id, project_id=project_id, suffix="meter-1")
        reserve_paid_capability_job(db, job=first, amount_points=100)
        first_settlement = settle_paid_capability_job(
            db,
            job=first,
            actual_points=1,
            metered_provider_cost_micros=741,
            metered_pricing_policy=metered_policy(),
        )
        second = create_job(db, user_id=user_id, project_id=project_id, suffix="meter-2")
        reserve_paid_capability_job(db, job=second, amount_points=100)
        second_settlement = settle_paid_capability_job(
            db,
            job=second,
            actual_points=12,
            metered_provider_cost_micros=8_948,
            metered_pricing_policy=metered_policy(),
        )
        db.commit()
        wallet = db.get(PointWallet, wallet_id)
        assert first_settlement.settled_points == 1
        assert second_settlement.settled_points == 11
        assert wallet.metered_provider_cost_micros == 9_689
        assert wallet.metered_provider_charged_points == 12
        assert wallet.lifetime_spent_points == 12


def test_reservation_blocks_ordinary_spend_from_using_reserved_points(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _wallet_id = seeded_wallet(client, admin_headers, amount=100)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="2")
        reserve_paid_capability_job(db, job=job, amount_points=80)
        with pytest.raises(DomainError, match="Insufficient point balance"):
            spend_points(
                db,
                user_id=user_id,
                project_id=project_id,
                amount_points=21,
                idempotency_key="ordinary-spend-blocked",
                reason="must not consume reservation",
            )


def test_insufficient_available_balance_creates_no_reservation(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers, amount=50)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="3")
        with pytest.raises(DomainError, match="Insufficient point balance"):
            reserve_paid_capability_job(db, job=job, amount_points=51)
        db.rollback()
        assert db.get(PointWallet, wallet_id).reserved_points == 0
        assert db.scalar(select(PointReservation).where(PointReservation.job_id == job.id)) is None


def test_duplicate_reserve_is_idempotent(client: TestClient, admin_headers: dict[str, str]) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="4")
        first, first_idempotent = reserve_paid_capability_job(db, job=job, amount_points=100)
        second, second_idempotent = reserve_paid_capability_job(db, job=job, amount_points=100)
        db.commit()
        assert first.id == second.id
        assert first_idempotent is False
        assert second_idempotent is True
        assert db.get(PointWallet, wallet_id).reserved_points == 100


def test_duplicate_reserve_with_different_amount_is_rejected(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="5")
        reserve_paid_capability_job(db, job=job, amount_points=100)
        with pytest.raises(DomainError, match="Reservation amount mismatch"):
            reserve_paid_capability_job(db, job=job, amount_points=101)


@pytest.mark.parametrize("actual_points", [-1, 101])
def test_settlement_rejects_invalid_actual_amount(
    client: TestClient,
    admin_headers: dict[str, str],
    actual_points: int,
) -> None:
    user_id, project_id, _wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix=f"6{actual_points}")
        reserve_paid_capability_job(db, job=job, amount_points=100)
        with pytest.raises(DomainError):
            settle_paid_capability_job(db, job=job, actual_points=actual_points)


def test_release_returns_all_unexpired_points(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="7")
        reserve_paid_capability_job(db, job=job, amount_points=100)
        release_paid_capability_job(db, job=job, reason="provider rejected before billing")
        db.commit()
        wallet = db.get(PointWallet, wallet_id)
        assert wallet.balance_points == 1_000
        assert wallet.reserved_points == 0
        assert wallet.lifetime_spent_points == 0
        assert job.status == "released"


def test_release_after_expiry_does_not_restore_expired_points(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    expires_at = datetime.now(UTC) + timedelta(seconds=5)
    user_id, project_id, wallet_id = seeded_wallet(
        client, admin_headers, amount=100, expires_at=expires_at
    )
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="8")
        reserve_paid_capability_job(db, job=job, amount_points=100)
        lot = db.scalar(select(PointCreditLot).where(PointCreditLot.wallet_id == wallet_id))
        assert lot is not None
        lot.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        release_paid_capability_job(db, job=job, reason="expired while reserved")
        db.commit()
        wallet = db.get(PointWallet, wallet_id)
        assert wallet.balance_points == 0
        assert wallet.reserved_points == 0
        assert lot.remaining_points == 0
        assert lot.reserved_points == 0
        assert lot.status == "expired"


def test_settlement_and_release_are_individually_idempotent(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        settled_job = create_job(db, user_id=user_id, project_id=project_id, suffix="9")
        reserve_paid_capability_job(db, job=settled_job, amount_points=100)
        first = settle_paid_capability_job(db, job=settled_job, actual_points=40)
        second = settle_paid_capability_job(db, job=settled_job, actual_points=40)
        assert first.id == second.id

        released_job = create_job(db, user_id=user_id, project_id=project_id, suffix="10")
        reserve_paid_capability_job(db, job=released_job, amount_points=50)
        released_first = release_paid_capability_job(db, job=released_job, reason="first")
        released_second = release_paid_capability_job(db, job=released_job, reason="second")
        db.commit()
        assert released_first.id == released_second.id
        wallet = db.get(PointWallet, wallet_id)
        assert wallet.balance_points == 960
        assert wallet.reserved_points == 0


def test_settled_reservation_cannot_be_released(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="11")
        reserve_paid_capability_job(db, job=job, amount_points=100)
        settle_paid_capability_job(db, job=job, actual_points=50)
        with pytest.raises(DomainError, match="already settled"):
            release_paid_capability_job(db, job=job, reason="illegal")


def test_released_reservation_cannot_be_settled(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, _wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="12")
        reserve_paid_capability_job(db, job=job, amount_points=100)
        release_paid_capability_job(db, job=job, reason="provider not billed")
        with pytest.raises(DomainError, match="already released"):
            settle_paid_capability_job(db, job=job, actual_points=50)


def test_wallet_read_repairs_only_orphaned_excess_reservation_counters(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="orphan-counter")
        reserve_paid_capability_job(db, job=job, amount_points=100)
        wallet = db.get(PointWallet, wallet_id)
        lot = db.scalar(select(PointCreditLot).where(PointCreditLot.wallet_id == wallet_id))
        assert wallet is not None and lot is not None
        wallet.reserved_points += 25
        lot.reserved_points += 25
        db.flush()

        expire_due_lots(db, wallet)
        db.commit()

        assert wallet.reserved_points == 100
        assert lot.reserved_points == 100
        assert job.reservation is not None
        assert job.reservation.reserved_points == 100


def test_reservation_counter_undercount_repairs_from_verified_allocations(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="undercount")
        reserve_paid_capability_job(db, job=job, amount_points=100)
        wallet = db.get(PointWallet, wallet_id)
        lot = db.scalar(select(PointCreditLot).where(PointCreditLot.wallet_id == wallet_id))
        assert wallet is not None and lot is not None
        wallet.reserved_points = 99
        lot.reserved_points = 99
        db.flush()

        expired = expire_due_lots(db, wallet)
        db.commit()

        assert expired == 0
        assert wallet.reserved_points == 100
        assert lot.reserved_points == 100


def test_stale_running_job_moves_to_reconciliation_without_releasing_points(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user_id, project_id, wallet_id = seeded_wallet(client, admin_headers)
    reserved_at = datetime.now(UTC) - timedelta(minutes=20)
    with client.app.state.session_factory() as db:
        job = create_job(db, user_id=user_id, project_id=project_id, suffix="stale-running")
        reserve_paid_capability_job(
            db,
            job=job,
            amount_points=100,
            reservation_ttl_seconds=60,
            now=reserved_at,
        )
        job.status = "provider_running"
        db.commit()

        wallet = db.get(PointWallet, wallet_id)
        assert wallet is not None
        expire_due_lots(db, wallet, now=datetime.now(UTC))
        db.commit()

        assert job.status == "reconciliation_required"
        assert job.error_code == "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN"
        assert job.reservation is not None and job.reservation.status == "reserved"
        assert wallet.balance_points == 1_000
        assert wallet.reserved_points == 100

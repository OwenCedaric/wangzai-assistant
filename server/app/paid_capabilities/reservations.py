from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session, joinedload

from app.models import PointCreditLot, PointWallet
from app.models.base import as_utc
from app.models.paid_capabilities import (
    PaidCapabilityJob,
    PointReservation,
    PointReservationLot,
)
from app.paid_capabilities.pricing import (
    PricingPolicy,
    calculate_charge_points_from_provider_cost,
)
from app.services.errors import DomainError
from app.services.point_service import (
    _record_entry,
    expire_due_lots,
    reconcile_point_reservation_counters,
    wallet_for_update,
)


def _now() -> datetime:
    return datetime.now(UTC)


def _reservation_for_job(db: Session, job_id: str) -> PointReservation | None:
    return db.scalar(
        select(PointReservation)
        .where(PointReservation.job_id == job_id)
        .options(joinedload(PointReservation.lots).joinedload(PointReservationLot.credit_lot))
    )


def _lot_is_expired(lot: PointCreditLot, current: datetime) -> bool:
    expires_at = as_utc(lot.expires_at)
    return expires_at is not None and expires_at <= current


def _refresh_lot_status(lot: PointCreditLot, current: datetime) -> None:
    if lot.remaining_points == 0:
        lot.status = "expired" if _lot_is_expired(lot, current) else "consumed"
    elif _lot_is_expired(lot, current):
        lot.status = "reserved_expiry" if lot.reserved_points else "expired"
    else:
        lot.status = "active"


def _increment_lot_reservation_counter(
    db: Session,
    *,
    lot_id: int,
    amount_points: int,
) -> bool:
    """Atomically claim points from one credit lot.

    SQLite ignores ``FOR UPDATE``.  Updating an ORM value that was read before
    another request commits can therefore overwrite that request's increment.
    A guarded SQL expression always adds to the value currently stored by the
    database and prevents that lost-update race.
    """
    if amount_points <= 0:
        return False
    updated = db.execute(
        update(PointCreditLot)
        .where(
            PointCreditLot.id == lot_id,
            PointCreditLot.remaining_points - PointCreditLot.reserved_points
            >= amount_points,
        )
        .values(
            reserved_points=PointCreditLot.reserved_points + amount_points,
            updated_at=_now(),
        )
        .execution_options(synchronize_session=False)
    )
    return updated.rowcount == 1


def reserve_paid_capability_job(
    db: Session,
    *,
    job: PaidCapabilityJob,
    amount_points: int,
    reservation_ttl_seconds: int = 900,
    now: datetime | None = None,
) -> tuple[PointReservation, bool]:
    if isinstance(amount_points, bool) or not isinstance(amount_points, int) or amount_points <= 0:
        raise DomainError("Reservation amount must be positive", status_code=422)
    existing = _reservation_for_job(db, job.id)
    if existing is not None:
        if existing.reserved_points != amount_points:
            raise DomainError("Reservation amount mismatch", status_code=409)
        return existing, True

    current = now or _now()
    wallet = wallet_for_update(
        db,
        user_id=job.user_id,
        project_id=job.project_id,
        create=True,
    )
    assert wallet is not None
    expire_due_lots(db, wallet, now=current)
    db.flush()

    updated = db.execute(
        update(PointWallet)
        .where(
            PointWallet.id == wallet.id,
            PointWallet.balance_points - PointWallet.reserved_points >= amount_points,
        )
        .values(reserved_points=PointWallet.reserved_points + amount_points)
    )
    if updated.rowcount != 1:
        raise DomainError("Insufficient point balance", status_code=409)
    db.expire(wallet)

    reservation = PointReservation(
        wallet_id=wallet.id,
        job_id=job.id,
        reserved_points=amount_points,
        settled_points=0,
        released_points=0,
        status="reserved",
        expires_at=current + timedelta(seconds=reservation_ttl_seconds),
    )
    db.add(reservation)
    db.flush()

    remaining = amount_points
    while remaining > 0:
        lots = db.scalars(
            select(PointCreditLot)
            .where(
                PointCreditLot.wallet_id == wallet.id,
                PointCreditLot.status == "active",
                PointCreditLot.remaining_points > PointCreditLot.reserved_points,
            )
            .order_by(
                PointCreditLot.expires_at.is_(None),
                PointCreditLot.expires_at,
                PointCreditLot.id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        ).all()
        allocated = False
        for lot in lots:
            available = lot.remaining_points - lot.reserved_points
            held = min(available, remaining)
            if held <= 0 or not _increment_lot_reservation_counter(
                db,
                lot_id=lot.id,
                amount_points=held,
            ):
                continue
            db.expire(lot)
            remaining -= held
            allocated = True
            db.add(
                PointReservationLot(
                    reservation_id=reservation.id,
                    credit_lot_id=lot.id,
                    reserved_points=held,
                    settled_points=0,
                    released_points=0,
                )
            )
            if remaining <= 0:
                break
        if not allocated:
            break
    if remaining:
        raise DomainError("Point wallet lots are inconsistent", status_code=409)
    job.status = "reserved"
    db.flush()
    return reservation, False


def _expire_released_points(
    db: Session,
    *,
    wallet: PointWallet,
    job: PaidCapabilityJob,
    amount_points: int,
    current: datetime,
) -> None:
    if amount_points <= 0:
        return
    if wallet.balance_points < amount_points:
        raise DomainError("Point wallet balance is inconsistent", status_code=409)
    wallet.balance_points -= amount_points
    _record_entry(
        db,
        wallet,
        delta_points=-amount_points,
        event_type="expired",
        idempotency_key=f"paid-job:{job.id}:reserved-expiry",
        reference_type="paid_capability_job",
        reference_id=job.id,
        reason="付费能力执行期间积分到期",
        details={"job_id": job.id, "expired_at": current.isoformat()},
    )


def settle_paid_capability_job(
    db: Session,
    *,
    job: PaidCapabilityJob,
    actual_points: int,
    metered_provider_cost_micros: int | None = None,
    metered_pricing_policy: PricingPolicy | None = None,
    now: datetime | None = None,
) -> PointReservation:
    reservation = _reservation_for_job(db, job.id)
    if reservation is None:
        raise DomainError("Point reservation not found", status_code=409)
    if reservation.status == "settled":
        if metered_provider_cost_micros is not None:
            return reservation
        if reservation.settled_points != actual_points:
            raise DomainError("Settlement amount mismatch", status_code=409)
        return reservation
    if reservation.status == "released":
        raise DomainError("Point reservation is already released", status_code=409)
    if (
        isinstance(actual_points, bool)
        or not isinstance(actual_points, int)
        or actual_points < 0
    ):
        raise DomainError("Settlement amount is outside the reservation", status_code=409)

    current = now or _now()
    wallet = db.scalar(
        select(PointWallet).where(PointWallet.id == reservation.wallet_id).with_for_update()
    )
    if wallet is None:
        raise DomainError("Point wallet is unavailable", status_code=409)
    reconcile_point_reservation_counters(db, wallet, now=current)
    db.flush()
    if (metered_provider_cost_micros is None) != (metered_pricing_policy is None):
        raise DomainError("Metered settlement evidence is incomplete", status_code=409)
    if metered_provider_cost_micros is not None and metered_pricing_policy is not None:
        if metered_provider_cost_micros < 0:
            raise DomainError("Metered provider cost is invalid", status_code=409)
        cumulative_cost = (
            wallet.metered_provider_cost_micros + metered_provider_cost_micros
        )
        cumulative_points = calculate_charge_points_from_provider_cost(
            metered_pricing_policy,
            cumulative_cost,
        )
        # Historical per-request ceiling may leave the account slightly ahead
        # of the cumulative target. Charge zero until real cost catches up.
        actual_points = max(
            0,
            cumulative_points - wallet.metered_provider_charged_points,
        )
    if actual_points > reservation.reserved_points:
        raise DomainError("Settlement amount is outside the reservation", status_code=409)
    remaining_to_settle = actual_points
    expired_release = 0
    for allocation in sorted(reservation.lots, key=lambda item: item.id):
        lot = allocation.credit_lot
        used = min(allocation.reserved_points, remaining_to_settle)
        released = allocation.reserved_points - used
        if lot.reserved_points < allocation.reserved_points or lot.remaining_points < used:
            raise DomainError("Point reservation lots are inconsistent", status_code=409)
        lot.reserved_points -= allocation.reserved_points
        lot.remaining_points -= used
        remaining_to_settle -= used
        allocation.settled_points = used
        allocation.released_points = released
        if released and _lot_is_expired(lot, current):
            if lot.remaining_points < released:
                raise DomainError("Expired point reservation is inconsistent", status_code=409)
            lot.remaining_points -= released
            expired_release += released
        _refresh_lot_status(lot, current)
    if remaining_to_settle:
        raise DomainError("Point reservation allocation is incomplete", status_code=409)
    if wallet.reserved_points < reservation.reserved_points:
        raise DomainError("Point wallet reservation is inconsistent", status_code=409)
    if wallet.balance_points < actual_points:
        raise DomainError("Point wallet balance is inconsistent", status_code=409)
    wallet.reserved_points -= reservation.reserved_points
    wallet.balance_points -= actual_points
    wallet.lifetime_spent_points += actual_points
    if metered_provider_cost_micros is not None:
        wallet.metered_provider_cost_micros = cumulative_cost
        wallet.metered_provider_charged_points += actual_points
    if actual_points:
        _record_entry(
            db,
            wallet,
            delta_points=-actual_points,
            event_type="paid_capability_spent",
            idempotency_key=f"paid-job:{job.id}:settle",
            reference_type="paid_capability_job",
            reference_id=job.id,
            reason=f"付费能力调用：{job.capability}",
            details={"capability": job.capability, "job_id": job.id},
        )
    _expire_released_points(
        db,
        wallet=wallet,
        job=job,
        amount_points=expired_release,
        current=current,
    )
    reservation.settled_points = actual_points
    reservation.released_points = reservation.reserved_points - actual_points
    reservation.status = "settled"
    reservation.settled_at = current
    job.status = "settled"
    job.settled_at = current
    db.flush()
    return reservation


def release_paid_capability_job(
    db: Session,
    *,
    job: PaidCapabilityJob,
    reason: str,
    now: datetime | None = None,
) -> PointReservation:
    reservation = _reservation_for_job(db, job.id)
    if reservation is None:
        raise DomainError("Point reservation not found", status_code=409)
    if reservation.status == "released":
        return reservation
    if reservation.status == "settled":
        raise DomainError("Point reservation is already settled", status_code=409)
    current = now or _now()
    wallet = db.scalar(
        select(PointWallet).where(PointWallet.id == reservation.wallet_id).with_for_update()
    )
    if wallet is None:
        raise DomainError("Point wallet is unavailable", status_code=409)
    reconcile_point_reservation_counters(db, wallet, now=current)
    db.flush()
    expired_release = 0
    for allocation in reservation.lots:
        lot = allocation.credit_lot
        if lot.reserved_points < allocation.reserved_points:
            raise DomainError("Point reservation lots are inconsistent", status_code=409)
        lot.reserved_points -= allocation.reserved_points
        allocation.released_points = allocation.reserved_points
        if _lot_is_expired(lot, current):
            if lot.remaining_points < allocation.reserved_points:
                raise DomainError("Expired point reservation is inconsistent", status_code=409)
            lot.remaining_points -= allocation.reserved_points
            expired_release += allocation.reserved_points
        _refresh_lot_status(lot, current)
    if wallet.reserved_points < reservation.reserved_points:
        raise DomainError("Point wallet reservation is inconsistent", status_code=409)
    wallet.reserved_points -= reservation.reserved_points
    _expire_released_points(
        db,
        wallet=wallet,
        job=job,
        amount_points=expired_release,
        current=current,
    )
    reservation.released_points = reservation.reserved_points
    reservation.status = "released"
    reservation.settled_at = current
    reservation.release_reason = str(reason)[:500]
    job.status = "released"
    job.settled_at = current
    db.flush()
    return reservation

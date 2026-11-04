from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.models import (
    Order,
    Plan,
    PointCreditLot,
    PointLedgerEntry,
    PointWallet,
    Project,
)
from app.models.base import as_utc
from app.models.paid_capabilities import PointReservation
from app.services.errors import DomainError


def project_by_code(db: Session, project_code: str) -> Project:
    project = db.scalar(select(Project).where(Project.code == project_code))
    if project is None or project.status != "active":
        raise DomainError("Project not found", status_code=404)
    return project


def wallet_for_update(
    db: Session,
    *,
    user_id: int,
    project_id: int,
    create: bool = True,
) -> PointWallet | None:
    wallet = db.scalar(
        select(PointWallet)
        .where(
            PointWallet.user_id == user_id,
            PointWallet.project_id == project_id,
        )
        .with_for_update()
    )
    if wallet is not None or not create:
        return wallet

    wallet = PointWallet(user_id=user_id, project_id=project_id)
    try:
        with db.begin_nested():
            db.add(wallet)
            db.flush()
    except IntegrityError as exc:
        wallet = db.scalar(
            select(PointWallet)
            .where(
                PointWallet.user_id == user_id,
                PointWallet.project_id == project_id,
            )
            .with_for_update()
        )
        if wallet is None:
            raise DomainError("Point wallet creation conflicted; retry", status_code=409) from exc
    return wallet


def _existing_entry(db: Session, wallet_id: int, idempotency_key: str) -> PointLedgerEntry | None:
    return db.scalar(
        select(PointLedgerEntry).where(
            PointLedgerEntry.wallet_id == wallet_id,
            PointLedgerEntry.idempotency_key == idempotency_key,
        )
    )


def _record_entry(
    db: Session,
    wallet: PointWallet,
    *,
    delta_points: int,
    event_type: str,
    idempotency_key: str,
    reference_type: str | None = None,
    reference_id: str | None = None,
    reason: str | None = None,
    details: dict[str, object] | None = None,
) -> PointLedgerEntry:
    if delta_points == 0:
        raise DomainError("Point ledger entries cannot be zero", status_code=422)
    entry = PointLedgerEntry(
        wallet_id=wallet.id,
        user_id=wallet.user_id,
        project_id=wallet.project_id,
        delta_points=delta_points,
        balance_after=wallet.balance_points,
        event_type=event_type,
        reference_type=reference_type,
        reference_id=reference_id,
        idempotency_key=idempotency_key,
        reason=reason,
        details=details or {},
    )
    db.add(entry)
    return entry


def reconcile_point_reservation_counters(
    db: Session,
    wallet: PointWallet,
    *,
    now: datetime | None = None,
) -> int:
    """Keep wallet/lot reservation counters derived from reservation details.

    Reservation rows and their lot allocations are the durable source of truth.
    A counter that is larger than the detailed outstanding amount only blocks
    spendable points, so it can be reduced safely. A counter that is smaller
    than the details could allow double spending and must fail closed.
    """

    current = now or datetime.now(UTC)
    reservations = (
        db.execute(
            select(PointReservation)
            .where(PointReservation.wallet_id == wallet.id)
            .options(
                joinedload(PointReservation.job),
                joinedload(PointReservation.lots),
            )
            .with_for_update()
        )
        .unique()
        .scalars()
        .all()
    )

    active_by_lot: dict[int, int] = {}
    active_total = 0
    for reservation in reservations:
        allocation_reserved = sum(item.reserved_points for item in reservation.lots)
        allocation_settled = sum(item.settled_points for item in reservation.lots)
        allocation_released = sum(item.released_points for item in reservation.lots)
        if (
            allocation_reserved != reservation.reserved_points
            or allocation_settled != reservation.settled_points
            or allocation_released != reservation.released_points
        ):
            raise DomainError("Point reservation allocations are inconsistent", status_code=409)

        outstanding = (
            reservation.reserved_points
            - reservation.settled_points
            - reservation.released_points
        )
        if reservation.status == "reserved":
            if outstanding <= 0:
                raise DomainError("Active point reservation is inconsistent", status_code=409)
            active_total += outstanding
            for allocation in reservation.lots:
                allocation_outstanding = (
                    allocation.reserved_points
                    - allocation.settled_points
                    - allocation.released_points
                )
                if allocation_outstanding < 0:
                    raise DomainError(
                        "Point reservation lot allocation is inconsistent",
                        status_code=409,
                    )
                active_by_lot[allocation.credit_lot_id] = (
                    active_by_lot.get(allocation.credit_lot_id, 0) + allocation_outstanding
                )

            expires_at = as_utc(reservation.expires_at)
            job = reservation.job
            if (
                expires_at is not None
                and expires_at <= current
                and job is not None
                and job.status in {"accepted", "reserved", "provider_running"}
            ):
                # Timeout is not proof that the upstream provider did not bill.
                # Preserve the hold and expose the job for explicit reconciliation.
                job.status = "reconciliation_required"
                job.error_code = "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN"
                job.completed_at = job.completed_at or current
        elif outstanding != 0:
            raise DomainError("Closed point reservation is inconsistent", status_code=409)

    lots = db.scalars(
        select(PointCreditLot)
        .where(PointCreditLot.wallet_id == wallet.id)
        .order_by(PointCreditLot.id)
        .with_for_update()
    ).all()
    repaired_points = 0
    for lot in lots:
        target = active_by_lot.pop(lot.id, 0)
        if target > lot.remaining_points:
            raise DomainError("Point lot reservation counter is inconsistent", status_code=409)
        if lot.reserved_points != target:
            repaired_points += abs(lot.reserved_points - target)
            lot.reserved_points = target
    if active_by_lot:
        raise DomainError("Point reservation references an unavailable lot", status_code=409)
    if sum(lot.reserved_points for lot in lots) != active_total:
        raise DomainError("Point reservation lot totals are inconsistent", status_code=409)
    if active_total > wallet.balance_points:
        raise DomainError("Point wallet reservation counter is inconsistent", status_code=409)
    if wallet.reserved_points != active_total:
        repaired_points = max(repaired_points, abs(wallet.reserved_points - active_total))
        wallet.reserved_points = active_total
    return repaired_points


def expire_due_lots(
    db: Session,
    wallet: PointWallet,
    *,
    now: datetime | None = None,
) -> int:
    current = now or datetime.now(UTC)
    reconcile_point_reservation_counters(db, wallet, now=current)
    db.flush()
    lots = db.scalars(
        select(PointCreditLot)
        .where(
            PointCreditLot.wallet_id == wallet.id,
            PointCreditLot.status == "active",
            PointCreditLot.remaining_points > 0,
            PointCreditLot.expires_at.is_not(None),
            PointCreditLot.expires_at <= current,
        )
        .order_by(PointCreditLot.expires_at, PointCreditLot.id)
        .with_for_update()
    ).all()
    expired_total = 0
    for lot in lots:
        amount = lot.remaining_points - lot.reserved_points
        key = f"lot:{lot.id}:expire"
        if amount > 0 and _existing_entry(db, wallet.id, key) is None:
            if wallet.balance_points < amount:
                raise DomainError("Point wallet balance is inconsistent", status_code=409)
            wallet.balance_points -= amount
            expired_total += amount
            _record_entry(
                db,
                wallet,
                delta_points=-amount,
                event_type="expired",
                idempotency_key=key,
                reference_type="point_lot",
                reference_id=str(lot.id),
                reason="积分到期",
            )
        lot.remaining_points -= amount
        lot.status = "reserved_expiry" if lot.reserved_points else "expired"
    return expired_total


def credit_points(
    db: Session,
    *,
    user_id: int,
    project_id: int,
    amount_points: int,
    idempotency_key: str,
    event_type: str,
    reason: str,
    expires_at: datetime | None = None,
    source_order_id: int | None = None,
    reference_type: str | None = None,
    reference_id: str | None = None,
    details: dict[str, object] | None = None,
) -> tuple[PointWallet, PointCreditLot | None, bool]:
    if amount_points <= 0:
        raise DomainError("Point credit amount must be positive", status_code=422)
    wallet = wallet_for_update(
        db,
        user_id=user_id,
        project_id=project_id,
        create=True,
    )
    assert wallet is not None
    expire_due_lots(db, wallet)
    existing = _existing_entry(db, wallet.id, idempotency_key)
    if existing is not None:
        lot = (
            db.scalar(
                select(PointCreditLot).where(PointCreditLot.source_order_id == source_order_id)
            )
            if source_order_id is not None
            else None
        )
        return wallet, lot, True

    lot = PointCreditLot(
        wallet_id=wallet.id,
        source_order_id=source_order_id,
        original_points=amount_points,
        remaining_points=amount_points,
        expires_at=expires_at,
        status="active",
    )
    db.add(lot)
    db.flush()
    wallet.balance_points += amount_points
    wallet.lifetime_credited_points += amount_points
    _record_entry(
        db,
        wallet,
        delta_points=amount_points,
        event_type=event_type,
        idempotency_key=idempotency_key,
        reference_type=reference_type,
        reference_id=reference_id,
        reason=reason,
        details={**(details or {}), "lot_id": lot.id},
    )
    return wallet, lot, False


def spend_points(
    db: Session,
    *,
    user_id: int,
    project_id: int,
    amount_points: int,
    idempotency_key: str,
    event_type: str = "spent",
    reason: str,
    reference_type: str | None = None,
    reference_id: str | None = None,
    details: dict[str, object] | None = None,
) -> tuple[PointWallet, bool]:
    if amount_points <= 0:
        raise DomainError("Point spend amount must be positive", status_code=422)
    wallet = wallet_for_update(
        db,
        user_id=user_id,
        project_id=project_id,
        create=True,
    )
    assert wallet is not None
    expire_due_lots(db, wallet)
    existing = _existing_entry(db, wallet.id, idempotency_key)
    if existing is not None:
        return wallet, True
    if wallet.balance_points - wallet.reserved_points < amount_points:
        raise DomainError("Insufficient point balance", status_code=409)

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
    ).all()
    remaining = amount_points
    deductions: list[dict[str, int]] = []
    for lot in lots:
        if remaining <= 0:
            break
        used = min(lot.remaining_points - lot.reserved_points, remaining)
        lot.remaining_points -= used
        remaining -= used
        deductions.append({"lot_id": lot.id, "points": used})
        if lot.remaining_points == 0:
            lot.status = "consumed"
    if remaining:
        raise DomainError("Point wallet lots are inconsistent", status_code=409)

    wallet.balance_points -= amount_points
    wallet.lifetime_spent_points += amount_points
    _record_entry(
        db,
        wallet,
        delta_points=-amount_points,
        event_type=event_type,
        idempotency_key=idempotency_key,
        reference_type=reference_type,
        reference_id=reference_id,
        reason=reason,
        details={**(details or {}), "deductions": deductions},
    )
    return wallet, False


def credit_order_points(
    db: Session,
    order: Order,
    plan: Plan,
    *,
    now: datetime,
) -> tuple[PointWallet, bool]:
    if plan.plan_kind != "points" or plan.points_amount <= 0:
        raise DomainError("Paid order point package is invalid", status_code=409)
    expires_at = now + timedelta(days=plan.duration_days)
    wallet, _lot, idempotent = credit_points(
        db,
        user_id=order.user_id,
        project_id=order.project_id,
        amount_points=plan.points_amount,
        idempotency_key=f"order:{order.id}:credit",
        event_type="purchase_credit",
        reason=f"购买积分套餐：{order.plan_name_snapshot}",
        expires_at=expires_at,
        source_order_id=order.id,
        reference_type="order",
        reference_id=order.order_no,
        details={"plan_id": plan.id, "order_id": order.id},
    )
    return wallet, idempotent


def reserve_order_points_refund(db: Session, order: Order) -> None:
    lot = db.scalar(
        select(PointCreditLot).where(PointCreditLot.source_order_id == order.id).with_for_update()
    )
    if lot is None:
        raise DomainError("Order point credit is unavailable", status_code=409)
    if lot.status == "refund_pending":
        return
    if lot.status == "refunded":
        return
    wallet = db.scalar(select(PointWallet).where(PointWallet.id == lot.wallet_id).with_for_update())
    if wallet is None:
        raise DomainError("Point wallet is unavailable", status_code=409)
    expire_due_lots(db, wallet)
    if (
        lot.status != "active"
        or lot.remaining_points != lot.original_points
        or lot.reserved_points != 0
    ):
        raise DomainError(
            "Purchased points have been used or expired and cannot be refunded",
            status_code=409,
        )
    key = f"order:{order.id}:refund-reserve"
    if _existing_entry(db, wallet.id, key) is None:
        if wallet.balance_points < lot.original_points:
            raise DomainError("Point wallet balance is inconsistent", status_code=409)
        wallet.balance_points -= lot.original_points
        _record_entry(
            db,
            wallet,
            delta_points=-lot.original_points,
            event_type="refund_reserved",
            idempotency_key=key,
            reference_type="order",
            reference_id=order.order_no,
            reason="积分订单退款预留",
            details={"lot_id": lot.id, "order_id": order.id},
        )
    lot.remaining_points = 0
    lot.status = "refund_pending"


def restore_order_points_refund(db: Session, order: Order) -> None:
    lot = db.scalar(
        select(PointCreditLot).where(PointCreditLot.source_order_id == order.id).with_for_update()
    )
    if lot is None or lot.status != "refund_pending":
        return
    wallet = db.scalar(select(PointWallet).where(PointWallet.id == lot.wallet_id).with_for_update())
    if wallet is None:
        raise DomainError("Point wallet is unavailable", status_code=409)
    key = f"order:{order.id}:refund-restore"
    if _existing_entry(db, wallet.id, key) is None:
        wallet.balance_points += lot.original_points
        _record_entry(
            db,
            wallet,
            delta_points=lot.original_points,
            event_type="refund_restored",
            idempotency_key=key,
            reference_type="order",
            reference_id=order.order_no,
            reason="积分订单退款失败，恢复积分",
            details={"lot_id": lot.id, "order_id": order.id},
        )
    lot.remaining_points = lot.original_points
    lot.status = "active"


def finalize_order_points_refund(db: Session, order: Order) -> None:
    lot = db.scalar(
        select(PointCreditLot).where(PointCreditLot.source_order_id == order.id).with_for_update()
    )
    if lot is None:
        raise DomainError("Order point credit is unavailable", status_code=409)
    if lot.status == "refunded":
        return
    if lot.status != "refund_pending" or lot.remaining_points != 0:
        raise DomainError("Point refund reservation is inconsistent", status_code=409)
    lot.status = "refunded"


def wallet_next_expiry(db: Session, wallet_id: int) -> tuple[datetime | None, int]:
    lots = db.scalars(
        select(PointCreditLot)
        .where(
            PointCreditLot.wallet_id == wallet_id,
            PointCreditLot.status == "active",
            PointCreditLot.remaining_points > 0,
            PointCreditLot.expires_at.is_not(None),
        )
        .order_by(PointCreditLot.expires_at, PointCreditLot.id)
    ).all()
    if not lots:
        return None, 0
    next_expiry = as_utc(lots[0].expires_at)
    points = sum(
        lot.remaining_points - lot.reserved_points
        for lot in lots
        if as_utc(lot.expires_at) == next_expiry
    )
    return next_expiry, points

from __future__ import annotations

import argparse
import json
import sqlite3
from collections.abc import Sequence
from pathlib import Path


def scalar(connection: sqlite3.Connection, statement: str, parameters: Sequence[object]) -> int:
    row = connection.execute(statement, parameters).fetchone()
    return int(row[0] or 0)


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only Wangzai point-ledger audit")
    parser.add_argument("--account", required=True, help="Account email or username")
    parser.add_argument("--database", default="license_center_demo.sqlite3")
    parser.add_argument("--price-version", default="wangzai-paid-2026-08-05-v3")
    args = parser.parse_args()

    database = Path(args.database).resolve()
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("database integrity_check failed")

        user = connection.execute(
            "SELECT id FROM users WHERE email = ? OR username = ?",
            (args.account, args.account),
        ).fetchone()
        project = connection.execute(
            "SELECT id FROM projects WHERE code = 'wangzai_desktop'"
        ).fetchone()
        if user is None or project is None:
            raise RuntimeError("account or wangzai_desktop project not found")

        wallet = connection.execute(
            """
            SELECT id, balance_points, reserved_points,
                   lifetime_credited_points, lifetime_spent_points
            FROM point_wallets WHERE user_id = ? AND project_id = ?
            """,
            (user["id"], project["id"]),
        ).fetchone()
        if wallet is None:
            raise RuntimeError("point wallet not found")

        wallet_id = wallet["id"]
        ledger_count = scalar(
            connection,
            "SELECT COUNT(*) FROM point_ledger_entries WHERE wallet_id = ?",
            (wallet_id,),
        )
        ledger_delta = scalar(
            connection,
            "SELECT COALESCE(SUM(delta_points), 0) FROM point_ledger_entries WHERE wallet_id = ?",
            (wallet_id,),
        )
        last_ledger = connection.execute(
            """
            SELECT balance_after FROM point_ledger_entries
            WHERE wallet_id = ? ORDER BY id DESC LIMIT 1
            """,
            (wallet_id,),
        ).fetchone()
        lot_remaining = scalar(
            connection,
            "SELECT COALESCE(SUM(remaining_points), 0) FROM point_credit_lots WHERE wallet_id = ?",
            (wallet_id,),
        )
        lot_reserved = scalar(
            connection,
            "SELECT COALESCE(SUM(reserved_points), 0) FROM point_credit_lots WHERE wallet_id = ?",
            (wallet_id,),
        )
        active_reservation_outstanding = scalar(
            connection,
            """
            SELECT COALESCE(SUM(reserved_points - settled_points - released_points), 0)
            FROM point_reservations
            WHERE wallet_id = ? AND status = 'reserved'
            """,
            (wallet_id,),
        )
        active_allocation_outstanding = scalar(
            connection,
            """
            SELECT COALESCE(SUM(allocation.reserved_points
                                - allocation.settled_points
                                - allocation.released_points), 0)
            FROM point_reservation_lots allocation
            JOIN point_reservations reservation
              ON reservation.id = allocation.reservation_id
            WHERE reservation.wallet_id = ? AND reservation.status = 'reserved'
            """,
            (wallet_id,),
        )
        malformed_reservation_allocations = scalar(
            connection,
            """
            SELECT COUNT(*) FROM (
                SELECT reservation.id
                FROM point_reservations reservation
                LEFT JOIN point_reservation_lots allocation
                  ON allocation.reservation_id = reservation.id
                WHERE reservation.wallet_id = ?
                GROUP BY reservation.id
                HAVING reservation.reserved_points
                           != COALESCE(SUM(allocation.reserved_points), 0)
                    OR reservation.settled_points
                           != COALESCE(SUM(allocation.settled_points), 0)
                    OR reservation.released_points
                           != COALESCE(SUM(allocation.released_points), 0)
            )
            """,
            (wallet_id,),
        )
        stale_running_jobs = scalar(
            connection,
            """
            SELECT COUNT(*)
            FROM point_reservations reservation
            JOIN paid_capability_jobs job ON job.id = reservation.job_id
            WHERE reservation.wallet_id = ?
              AND reservation.status = 'reserved'
              AND reservation.expires_at IS NOT NULL
              AND datetime(reservation.expires_at) <= datetime('now')
              AND job.status IN ('accepted', 'reserved', 'provider_running')
            """,
            (wallet_id,),
        )

        job_rows = connection.execute(
            """
            SELECT status, COUNT(*) AS count FROM paid_capability_jobs
            WHERE user_id = ? AND project_id = ? GROUP BY status ORDER BY status
            """,
            (user["id"], project["id"]),
        ).fetchall()
        job_statuses = {row["status"]: row["count"] for row in job_rows}
        completed_jobs = int(job_statuses.get("completed", 0))
        usage_events = scalar(
            connection,
            """
            SELECT COUNT(*) FROM provider_usage_events event
            JOIN paid_capability_jobs job ON job.id = event.job_id
            WHERE job.user_id = ? AND job.project_id = ?
            """,
            (user["id"], project["id"]),
        )
        missing_completed_usage = scalar(
            connection,
            """
            SELECT COUNT(*) FROM paid_capability_jobs job
            LEFT JOIN provider_usage_events event ON event.job_id = job.id
            WHERE job.user_id = ? AND job.project_id = ?
              AND job.status = 'completed' AND event.id IS NULL
            """,
            (user["id"], project["id"]),
        )
        reconciliation_required = int(job_statuses.get("reconciliation_required", 0))
        incomplete_completed_reservations = scalar(
            connection,
            """
            SELECT COUNT(*) FROM paid_capability_jobs job
            JOIN point_reservations reservation ON reservation.job_id = job.id
            WHERE job.user_id = ? AND job.project_id = ? AND job.status = 'completed'
              AND reservation.settled_points + reservation.released_points
                  != reservation.reserved_points
            """,
            (user["id"], project["id"]),
        )
        incomplete_unbilled_releases = scalar(
            connection,
            """
            SELECT COUNT(*) FROM paid_capability_jobs job
            JOIN point_reservations reservation ON reservation.job_id = job.id
            WHERE job.user_id = ? AND job.project_id = ? AND job.status = 'failed_unbilled'
              AND reservation.released_points != reservation.reserved_points
            """,
            (user["id"], project["id"]),
        )
        active_rates = scalar(
            connection,
            """
            SELECT COUNT(*) FROM paid_capability_rate_cards
            WHERE project_id = ? AND status = 'active' AND price_version = ?
            """,
            (project["id"], args.price_version),
        )
        other_active_rates = scalar(
            connection,
            """
            SELECT COUNT(*) FROM paid_capability_rate_cards
            WHERE project_id = ? AND status = 'active' AND price_version != ?
            """,
            (project["id"], args.price_version),
        )

        checks = {
            "wallet_equals_ledger_delta": wallet["balance_points"] == ledger_delta,
            "wallet_equals_lot_remaining": wallet["balance_points"] == lot_remaining,
            "wallet_reservation_matches_lots": wallet["reserved_points"] == lot_reserved,
            "wallet_reservation_matches_active_details": wallet["reserved_points"]
            == active_reservation_outstanding,
            "reservation_details_match_allocations": active_reservation_outstanding
            == active_allocation_outstanding
            and malformed_reservation_allocations == 0,
            "no_stale_invisible_running_jobs": stale_running_jobs == 0,
            "last_ledger_matches_wallet": last_ledger is not None
            and last_ledger["balance_after"] == wallet["balance_points"],
            "no_reconciliation_required": reconciliation_required == 0,
            "every_completed_job_has_usage": missing_completed_usage == 0
            and usage_events == completed_jobs,
            "completed_reservations_accounted": incomplete_completed_reservations == 0,
            "failed_unbilled_reservations_released": incomplete_unbilled_releases == 0,
            "exact_active_rate_set": active_rates == 13 and other_active_rates == 0,
        }
        result = {
            "ok": all(checks.values()),
            "account_id": user["id"],
            "wallet": {
                "balance_points": wallet["balance_points"],
                "reserved_points": wallet["reserved_points"],
                "lifetime_credited_points": wallet["lifetime_credited_points"],
                "lifetime_spent_points": wallet["lifetime_spent_points"],
            },
            "ledger_entries": ledger_count,
            "job_statuses": job_statuses,
            "provider_usage_events": usage_events,
            "active_rate_cards": active_rates,
            "checks": checks,
        }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        if not result["ok"]:
            raise SystemExit(1)
    finally:
        connection.close()


if __name__ == "__main__":
    main()

"""accumulate metered costs without systematic point rounding

Revision ID: fc02e8d4b731
Revises: fbd17c2a940e
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fc02e8d4b731"
down_revision: str | Sequence[str] | None = "fbd17c2a940e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("point_wallets") as batch:
        batch.add_column(
            sa.Column(
                "metered_provider_cost_micros",
                sa.BigInteger(),
                nullable=False,
                server_default="0",
            )
        )
        batch.add_column(
            sa.Column(
                "metered_provider_charged_points",
                sa.BigInteger(),
                nullable=False,
                server_default="0",
            )
        )
        batch.create_check_constraint(
            "ck_point_wallet_metered_cost_nonnegative",
            "metered_provider_cost_micros >= 0",
        )
        batch.create_check_constraint(
            "ck_point_wallet_metered_points_nonnegative",
            "metered_provider_charged_points >= 0",
        )
    op.execute(
        """
        UPDATE point_wallets
        SET metered_provider_cost_micros = COALESCE((
            SELECT SUM(e.provider_cost_micros)
            FROM provider_usage_events AS e
            JOIN paid_capability_jobs AS j ON j.id = e.job_id
            JOIN point_reservations AS r ON r.job_id = j.id
            WHERE r.wallet_id = point_wallets.id
              AND e.provider_cost_source = 'provider_usage_delta'
              AND e.billable = 1
        ), 0),
        metered_provider_charged_points = COALESCE((
            SELECT SUM(e.charged_points)
            FROM provider_usage_events AS e
            JOIN paid_capability_jobs AS j ON j.id = e.job_id
            JOIN point_reservations AS r ON r.job_id = j.id
            WHERE r.wallet_id = point_wallets.id
              AND e.provider_cost_source = 'provider_usage_delta'
              AND e.billable = 1
        ), 0)
        """
    )


def downgrade() -> None:
    with op.batch_alter_table("point_wallets") as batch:
        batch.drop_constraint("ck_point_wallet_metered_points_nonnegative", type_="check")
        batch.drop_constraint("ck_point_wallet_metered_cost_nonnegative", type_="check")
        batch.drop_column("metered_provider_charged_points")
        batch.drop_column("metered_provider_cost_micros")

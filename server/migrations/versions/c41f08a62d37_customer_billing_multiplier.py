"""add customer billing multiplier

Revision ID: c41f08a62d37
Revises: ad83e1c7b920
Create Date: 2026-08-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c41f08a62d37"
down_revision: str | None = "ad83e1c7b920"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("paid_capability_rate_cards") as batch:
        batch.add_column(
            sa.Column(
                "customer_multiplier_ppm",
                sa.Integer(),
                nullable=False,
                server_default="1000000",
            )
        )
        batch.create_check_constraint(
            "ck_paid_rate_customer_multiplier_safe",
            "customer_multiplier_ppm >= 1000000 AND customer_multiplier_ppm <= 10000000",
        )


def downgrade() -> None:
    with op.batch_alter_table("paid_capability_rate_cards") as batch:
        batch.drop_constraint("ck_paid_rate_customer_multiplier_safe", type_="check")
        batch.drop_column("customer_multiplier_ppm")

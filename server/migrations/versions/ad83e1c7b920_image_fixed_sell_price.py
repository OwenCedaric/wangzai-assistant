"""add fixed per-image customer sell price

Revision ID: ad83e1c7b920
Revises: fc02e8d4b731
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ad83e1c7b920"
down_revision: str | Sequence[str] | None = "fc02e8d4b731"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("paid_capability_rate_cards") as batch:
        batch.add_column(
            sa.Column(
                "unit_sell_price_micros",
                sa.BigInteger(),
                nullable=False,
                server_default="0",
            )
        )
        batch.create_check_constraint(
            "ck_paid_rate_unit_sell_price_nonnegative",
            "unit_sell_price_micros >= 0",
        )


def downgrade() -> None:
    with op.batch_alter_table("paid_capability_rate_cards") as batch:
        batch.drop_constraint("ck_paid_rate_unit_sell_price_nonnegative", type_="check")
        batch.drop_column("unit_sell_price_micros")

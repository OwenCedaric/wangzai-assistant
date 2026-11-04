"""store auditable dynamic provider cost evidence

Revision ID: fbd17c2a940e
Revises: f9a2c6e8d410
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fbd17c2a940e"
down_revision: str | Sequence[str] | None = "f9a2c6e8d410"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("provider_usage_events") as batch:
        batch.add_column(
            sa.Column(
                "provider_cost_source",
                sa.String(48),
                nullable=False,
                server_default="rate_card",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("provider_usage_events") as batch:
        batch.drop_column("provider_cost_source")

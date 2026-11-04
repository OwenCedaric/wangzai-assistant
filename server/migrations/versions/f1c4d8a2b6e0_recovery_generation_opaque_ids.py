"""expand recovery generation opaque ids

Revision ID: f1c4d8a2b6e0
Revises: e6b3a4d0912f
Create Date: 2026-07-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1c4d8a2b6e0"
down_revision: str | Sequence[str] | None = "e6b3a4d0912f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("recovery_generations") as batch_op:
        batch_op.alter_column(
            "public_id",
            existing_type=sa.String(length=36),
            type_=sa.String(length=128),
            existing_nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("recovery_generations") as batch_op:
        batch_op.alter_column(
            "public_id",
            existing_type=sa.String(length=128),
            type_=sa.String(length=36),
            existing_nullable=False,
        )

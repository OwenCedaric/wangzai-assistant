"""use registration email as the visible username

Revision ID: e4b8a7c5d210
Revises: d7f2c8a401bc
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e4b8a7c5d210"
down_revision: str | None = "d7f2c8a401bc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.alter_column(
            "username",
            existing_type=sa.String(length=64),
            type_=sa.String(length=255),
            existing_nullable=False,
        )
    op.execute(
        sa.text(
            """
            UPDATE users
            SET username = lower(trim(email))
            WHERE email IS NOT NULL
              AND trim(email) <> ''
              AND (username LIKE 'email_%' OR username LIKE 'u_%')
            """
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.alter_column(
            "username",
            existing_type=sa.String(length=255),
            type_=sa.String(length=64),
            existing_nullable=False,
        )

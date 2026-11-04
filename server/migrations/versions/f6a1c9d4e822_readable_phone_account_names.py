"""Use stable readable identifiers for phone-only accounts.

Revision ID: f6a1c9d4e822
Revises: e4b8a7c5d210
Create Date: 2026-08-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f6a1c9d4e822"
down_revision: str | None = "e4b8a7c5d210"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    users = sa.table(
        "users",
        sa.column("id", sa.Integer()),
        sa.column("username", sa.String()),
        sa.column("email", sa.String()),
    )
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(users.c.id).where(
            users.c.email.is_(None),
            users.c.username.like(r"u\_%", escape="\\"),
        )
    ).all()
    for (user_id,) in rows:
        connection.execute(
            sa.update(users).where(users.c.id == user_id).values(username=f"mobile_user_{user_id}")
        )


def downgrade() -> None:
    # The former random value cannot be reconstructed; keep the stable identifier.
    pass

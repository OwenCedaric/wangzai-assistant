"""add per-user device limit exemption

Revision ID: ef31c8a6d240
Revises: c8e4f1a7b260
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ef31c8a6d240"
down_revision: str | Sequence[str] | None = "c8e4f1a7b260"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "device_limit_exempt",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.create_index(
        "ix_users_device_limit_exempt",
        "users",
        ["device_limit_exempt"],
    )


def downgrade() -> None:
    op.drop_index("ix_users_device_limit_exempt", table_name="users")
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("device_limit_exempt")

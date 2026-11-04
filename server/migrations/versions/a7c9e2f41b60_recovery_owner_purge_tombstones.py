"""recovery owner purge tombstones

Revision ID: a7c9e2f41b60
Revises: f1c4d8a2b6e0
Create Date: 2026-07-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7c9e2f41b60"
down_revision: str | Sequence[str] | None = "f1c4d8a2b6e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("recovery_generations") as batch_op:
        batch_op.add_column(
            sa.Column("owner_refs", sa.JSON(), server_default=sa.text("'[]'"), nullable=False)
        )
    op.create_table(
        "recovery_owner_tombstones",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("owner_ref", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "owner_ref"),
    )
    op.create_index(
        op.f("ix_recovery_owner_tombstones_user_id"),
        "recovery_owner_tombstones",
        ["user_id"],
    )
    op.create_index(
        op.f("ix_recovery_owner_tombstones_owner_ref"),
        "recovery_owner_tombstones",
        ["owner_ref"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_recovery_owner_tombstones_owner_ref"),
        table_name="recovery_owner_tombstones",
    )
    op.drop_index(
        op.f("ix_recovery_owner_tombstones_user_id"),
        table_name="recovery_owner_tombstones",
    )
    op.drop_table("recovery_owner_tombstones")
    with op.batch_alter_table("recovery_generations") as batch_op:
        batch_op.drop_column("owner_refs")

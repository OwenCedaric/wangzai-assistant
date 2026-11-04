"""plan online-only offline policy

Revision ID: c4e8a1d2f390
Revises: a7c9e2f41b60
Create Date: 2026-07-15
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c4e8a1d2f390"
down_revision: str | Sequence[str] | None = "a7c9e2f41b60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("plans") as batch_op:
        batch_op.create_check_constraint(
            "ck_plans_offline_hours_range",
            "offline_hours >= 0 AND offline_hours <= 168",
        )


def downgrade() -> None:
    with op.batch_alter_table("plans") as batch_op:
        batch_op.drop_constraint("ck_plans_offline_hours_range", type_="check")

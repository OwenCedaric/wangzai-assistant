"""allow zero as unlimited API key concurrency

Revision ID: d4e1b8a2c650
Revises: ab72d5e48190
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e1b8a2c650"
down_revision: str | Sequence[str] | None = "ab72d5e48190"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("api_pool_keys") as batch_op:
        batch_op.drop_constraint("ck_api_pool_key_concurrency", type_="check")
        batch_op.alter_column(
            "max_concurrency",
            existing_type=sa.Integer(),
            existing_nullable=False,
            server_default="0",
        )
        batch_op.create_check_constraint(
            "ck_api_pool_key_concurrency",
            "max_concurrency >= 0 AND max_concurrency <= 100",
        )


def downgrade() -> None:
    op.execute("UPDATE api_pool_keys SET max_concurrency = 1 WHERE max_concurrency = 0")
    with op.batch_alter_table("api_pool_keys") as batch_op:
        batch_op.drop_constraint("ck_api_pool_key_concurrency", type_="check")
        batch_op.alter_column(
            "max_concurrency",
            existing_type=sa.Integer(),
            existing_nullable=False,
            server_default="1",
        )
        batch_op.create_check_constraint(
            "ck_api_pool_key_concurrency",
            "max_concurrency > 0 AND max_concurrency <= 100",
        )

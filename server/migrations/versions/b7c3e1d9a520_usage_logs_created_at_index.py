"""index usage_logs.created_at for date-bounded dashboard counts

Every heartbeat/check appends a usage_logs row and the dashboard counts rows since
the start of the day, so without this index those counts scan the whole table.

Revision ID: b7c3e1d9a520
Revises: a94f1e6c2d70
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b7c3e1d9a520"
down_revision: str | Sequence[str] | None = "a94f1e6c2d70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX_NAME = "ix_usage_logs_created_at"


def upgrade() -> None:
    op.create_index(INDEX_NAME, "usage_logs", ["created_at"])


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name="usage_logs")

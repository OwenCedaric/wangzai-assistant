"""add server-only OSS object credentials

Revision ID: a94f1e6c2d70
Revises: ef31c8a6d240
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a94f1e6c2d70"
down_revision: str | Sequence[str] | None = "ef31c8a6d240"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("oss_management_configurations") as batch_op:
        batch_op.add_column(
            sa.Column("object_access_key_id_ciphertext", sa.Text(), nullable=True)
        )
        batch_op.add_column(
            sa.Column("object_access_key_secret_ciphertext", sa.Text(), nullable=True)
        )
        batch_op.add_column(
            sa.Column("object_access_key_fingerprint", sa.String(71), nullable=True)
        )
        batch_op.add_column(
            sa.Column("masked_object_access_key_id", sa.String(64), nullable=True)
        )
        batch_op.create_unique_constraint(
            "uq_oss_management_object_access_key_fingerprint",
            ["object_access_key_fingerprint"],
        )


def downgrade() -> None:
    with op.batch_alter_table("oss_management_configurations") as batch_op:
        batch_op.drop_constraint(
            "uq_oss_management_object_access_key_fingerprint", type_="unique"
        )
        batch_op.drop_column("masked_object_access_key_id")
        batch_op.drop_column("object_access_key_fingerprint")
        batch_op.drop_column("object_access_key_secret_ciphertext")
        batch_op.drop_column("object_access_key_id_ciphertext")

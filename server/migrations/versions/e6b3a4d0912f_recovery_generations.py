"""encrypted recovery generations

Revision ID: e6b3a4d0912f
Revises: 8131978a5744
Create Date: 2026-07-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e6b3a4d0912f"
down_revision: str | Sequence[str] | None = "8131978a5744"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "recovery_objects",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("chunk_id", sa.String(length=128), nullable=False),
        sa.Column("cipher_sha256", sa.String(length=64), nullable=False),
        sa.Column("cipher_bytes", sa.Integer(), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("cipher_bytes > 28", name="ck_recovery_objects_cipher_bytes"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "chunk_id"),
    )
    op.create_index(op.f("ix_recovery_objects_chunk_id"), "recovery_objects", ["chunk_id"])
    op.create_index(op.f("ix_recovery_objects_user_id"), "recovery_objects", ["user_id"])
    op.create_table(
        "recovery_generations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("public_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("scope_key", sa.String(length=128), nullable=False),
        sa.Column("manifest_chunk_id", sa.String(length=128), nullable=False),
        sa.Column("key_envelope", sa.JSON(), nullable=False),
        sa.Column("logical_cipher_bytes", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "logical_cipher_bytes > 0", name="ck_recovery_generations_logical_bytes"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("public_id"),
        sa.UniqueConstraint("user_id", "scope_key"),
    )
    op.create_index(
        op.f("ix_recovery_generations_public_id"), "recovery_generations", ["public_id"]
    )
    op.create_index(
        op.f("ix_recovery_generations_scope_key"), "recovery_generations", ["scope_key"]
    )
    op.create_index(op.f("ix_recovery_generations_status"), "recovery_generations", ["status"])
    op.create_index(op.f("ix_recovery_generations_user_id"), "recovery_generations", ["user_id"])
    op.create_table(
        "recovery_generation_objects",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("generation_id", sa.Integer(), nullable=False),
        sa.Column("recovery_object_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["generation_id"], ["recovery_generations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["recovery_object_id"], ["recovery_objects.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("generation_id", "recovery_object_id"),
    )
    op.create_index(
        op.f("ix_recovery_generation_objects_generation_id"),
        "recovery_generation_objects",
        ["generation_id"],
    )
    op.create_index(
        op.f("ix_recovery_generation_objects_recovery_object_id"),
        "recovery_generation_objects",
        ["recovery_object_id"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_recovery_generation_objects_recovery_object_id"),
        table_name="recovery_generation_objects",
    )
    op.drop_index(
        op.f("ix_recovery_generation_objects_generation_id"),
        table_name="recovery_generation_objects",
    )
    op.drop_table("recovery_generation_objects")
    op.drop_index(op.f("ix_recovery_generations_user_id"), table_name="recovery_generations")
    op.drop_index(op.f("ix_recovery_generations_status"), table_name="recovery_generations")
    op.drop_index(op.f("ix_recovery_generations_scope_key"), table_name="recovery_generations")
    op.drop_index(op.f("ix_recovery_generations_public_id"), table_name="recovery_generations")
    op.drop_table("recovery_generations")
    op.drop_index(op.f("ix_recovery_objects_user_id"), table_name="recovery_objects")
    op.drop_index(op.f("ix_recovery_objects_chunk_id"), table_name="recovery_objects")
    op.drop_table("recovery_objects")

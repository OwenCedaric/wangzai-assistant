"""add encrypted OSS management configuration

Revision ID: c8e4f1a7b260
Revises: b13e7f2c9a40
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8e4f1a7b260"
down_revision: str | Sequence[str] | None = "b13e7f2c9a40"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "oss_management_configurations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("region", sa.String(64), nullable=False),
        sa.Column("bucket", sa.String(128), nullable=False),
        sa.Column("endpoint", sa.String(512), nullable=False),
        sa.Column("accelerate_endpoint", sa.String(512), nullable=True),
        sa.Column("acceleration_enabled", sa.Boolean(), nullable=False),
        sa.Column("runtime_revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("access_key_id_ciphertext", sa.Text(), nullable=False),
        sa.Column("access_key_secret_ciphertext", sa.Text(), nullable=False),
        sa.Column("access_key_fingerprint", sa.String(71), nullable=False),
        sa.Column("masked_access_key_id", sa.String(64), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_usage_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(120), nullable=True),
        sa.Column(
            "storage_price_cny_per_gb_month",
            sa.Numeric(12, 6),
            nullable=False,
            server_default="0.136",
        ),
        sa.Column(
            "network_out_price_cny_per_gb",
            sa.Numeric(12, 6),
            nullable=False,
            server_default="0.750",
        ),
        sa.Column(
            "acceleration_price_cny_per_gb",
            sa.Numeric(12, 6),
            nullable=False,
            server_default="1.250",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_oss_management_singleton"),
        sa.CheckConstraint(
            "runtime_revision >= 1", name="ck_oss_management_runtime_revision_positive"
        ),
        sa.CheckConstraint(
            "storage_price_cny_per_gb_month >= 0",
            name="ck_oss_management_storage_price_nonnegative",
        ),
        sa.CheckConstraint(
            "network_out_price_cny_per_gb >= 0",
            name="ck_oss_management_network_price_nonnegative",
        ),
        sa.CheckConstraint(
            "acceleration_price_cny_per_gb >= 0",
            name="ck_oss_management_acceleration_price_nonnegative",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("access_key_fingerprint"),
    )
    op.create_index(
        "ix_oss_management_configurations_bucket",
        "oss_management_configurations",
        ["bucket"],
    )
    op.create_index(
        "ix_oss_management_configurations_status",
        "oss_management_configurations",
        ["status"],
    )


def downgrade() -> None:
    op.drop_table("oss_management_configurations")

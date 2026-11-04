"""generic API provider, model, key, and lease pool

Revision ID: ab72d5e48190
Revises: c2a7f4e9b130
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ab72d5e48190"
down_revision: str | Sequence[str] | None = "c2a7f4e9b130"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "api_pool_providers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("adapter", sa.String(48), nullable=False),
        sa.Column("base_url", sa.String(512), nullable=False),
        sa.Column("auth_scheme", sa.String(32), nullable=False, server_default="bearer"),
        sa.Column(
            "auth_header_name",
            sa.String(128),
            nullable=False,
            server_default="Authorization",
        ),
        sa.Column("capability_kinds", sa.JSON(), nullable=False),
        sa.Column("timeout_seconds", sa.Integer(), nullable=False, server_default="150"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("status", sa.String(24), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("code"),
        sa.CheckConstraint(
            "timeout_seconds >= 10 AND timeout_seconds <= 300",
            name="ck_api_pool_provider_timeout",
        ),
    )
    op.create_index("ix_api_pool_provider_code", "api_pool_providers", ["code"])
    op.create_index("ix_api_pool_provider_adapter", "api_pool_providers", ["adapter"])
    op.create_index("ix_api_pool_provider_status", "api_pool_providers", ["status"])

    op.create_table(
        "api_pool_models",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "provider_id",
            sa.Integer(),
            sa.ForeignKey("api_pool_providers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("capability_kind", sa.String(32), nullable=False),
        sa.Column("model_code", sa.String(160), nullable=False),
        sa.Column("display_name", sa.String(160), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("status", sa.String(24), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("provider_id", "capability_kind", "model_code"),
    )
    op.create_index("ix_api_pool_model_provider", "api_pool_models", ["provider_id"])
    op.create_index("ix_api_pool_model_kind", "api_pool_models", ["capability_kind"])
    op.create_index("ix_api_pool_model_status", "api_pool_models", ["status"])

    op.create_table(
        "api_pool_keys",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "provider_id",
            sa.Integer(),
            sa.ForeignKey("api_pool_providers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("label", sa.String(128), nullable=False),
        sa.Column("secret_ciphertext", sa.Text(), nullable=False),
        sa.Column("secret_fingerprint", sa.String(71), nullable=False),
        sa.Column("masked_hint", sa.String(64), nullable=False),
        sa.Column("weight", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("max_concurrency", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(24), nullable=False, server_default="active"),
        sa.Column("cooldown_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_failure_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("success_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failure_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("request_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error_code", sa.String(96), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("provider_id", "secret_fingerprint"),
        sa.CheckConstraint(
            "max_concurrency > 0 AND max_concurrency <= 100",
            name="ck_api_pool_key_concurrency",
        ),
        sa.CheckConstraint("weight > 0 AND weight <= 1000", name="ck_api_pool_key_weight"),
        sa.CheckConstraint("success_count >= 0", name="ck_api_pool_key_success_nonnegative"),
        sa.CheckConstraint("failure_count >= 0", name="ck_api_pool_key_failure_nonnegative"),
        sa.CheckConstraint("request_count >= 0", name="ck_api_pool_key_request_nonnegative"),
        sa.CheckConstraint(
            "consecutive_failures >= 0", name="ck_api_pool_key_consecutive_nonnegative"
        ),
    )
    op.create_index("ix_api_pool_key_provider", "api_pool_keys", ["provider_id"])
    op.create_index("ix_api_pool_key_status", "api_pool_keys", ["status"])
    op.create_index("ix_api_pool_key_cooldown", "api_pool_keys", ["cooldown_until"])

    op.create_table(
        "api_pool_leases",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "key_id",
            sa.Integer(),
            sa.ForeignKey("api_pool_keys.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(24), nullable=False, server_default="active"),
        sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_api_pool_lease_key", "api_pool_leases", ["key_id"])
    op.create_index("ix_api_pool_lease_status", "api_pool_leases", ["status"])
    op.create_index("ix_api_pool_lease_expires", "api_pool_leases", ["expires_at"])


def downgrade() -> None:
    op.drop_table("api_pool_leases")
    op.drop_table("api_pool_keys")
    op.drop_table("api_pool_models")
    op.drop_table("api_pool_providers")

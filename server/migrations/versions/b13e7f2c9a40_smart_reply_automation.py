"""add server-side smart reply automation

Revision ID: b13e7f2c9a40
Revises: a82b7d39e410
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b13e7f2c9a40"
down_revision: str | Sequence[str] | None = "a82b7d39e410"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ozon_notification_events",
        sa.Column("smart_reply_state", sa.String(24), nullable=False, server_default="pending"),
    )
    op.add_column(
        "ozon_notification_events",
        sa.Column("smart_reply_attempts", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "ozon_notification_events",
        sa.Column("smart_reply_retry_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ozon_notification_events",
        sa.Column("smart_reply_processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ozon_notification_events",
        sa.Column("smart_reply_error_code", sa.String(120), nullable=True),
    )
    op.create_index(
        "ix_ozon_notification_events_smart_reply_state",
        "ozon_notification_events",
        ["smart_reply_state"],
    )
    op.create_index(
        "ix_ozon_notification_events_smart_reply_retry_at",
        "ozon_notification_events",
        ["smart_reply_retry_at"],
    )
    op.create_table(
        "smart_reply_credentials",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("api_key_ciphertext", sa.Text(), nullable=False),
        sa.Column("api_key_fingerprint", sa.String(80), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["shop_id"], ["shops.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("shop_id"),
    )
    op.create_index("ix_smart_reply_credentials_shop_id", "smart_reply_credentials", ["shop_id"])
    op.create_index("ix_smart_reply_credentials_status", "smart_reply_credentials", ["status"])

    op.create_table(
        "smart_reply_rules",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("license_id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("scene", sa.String(40), nullable=False),
        sa.Column("send_time_type", sa.String(20), nullable=False),
        sa.Column("delay_hours", sa.Integer(), nullable=False),
        sa.Column("content_generate_type", sa.String(20), nullable=False),
        sa.Column("template_id", sa.String(100), nullable=False),
        sa.Column("message_template", sa.Text(), nullable=False),
        sa.Column("message_template_zh", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["license_id"], ["licenses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("user_id", "license_id", "project_id", "scene", "enabled"):
        op.create_index(f"ix_smart_reply_rules_{column}", "smart_reply_rules", [column])

    op.create_table(
        "smart_reply_rule_shops",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("rule_id", sa.String(64), nullable=False),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["rule_id"], ["smart_reply_rules.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["shop_id"], ["shops.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("rule_id", "shop_id"),
    )
    op.create_index("ix_smart_reply_rule_shops_rule_id", "smart_reply_rule_shops", ["rule_id"])
    op.create_index("ix_smart_reply_rule_shops_shop_id", "smart_reply_rule_shops", ["shop_id"])

    op.create_table(
        "smart_reply_tasks",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(220), nullable=False),
        sa.Column("notification_event_id", sa.String(64), nullable=True),
        sa.Column("rule_id", sa.String(64), nullable=False),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("posting_number", sa.String(160), nullable=False),
        sa.Column("scene", sa.String(40), nullable=False),
        sa.Column("trigger_status", sa.String(120), nullable=False),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("template_snapshot", sa.Text(), nullable=False),
        sa.Column("rendered_message", sa.Text(), nullable=True),
        sa.Column("chat_id", sa.String(160), nullable=True),
        sa.Column("ozon_message_id", sa.String(160), nullable=True),
        sa.Column("send_submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("retry_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(120), nullable=True),
        sa.Column("last_error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["notification_event_id"], ["ozon_notification_events.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["rule_id"], ["smart_reply_rules.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["shop_id"], ["shops.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key"),
    )
    for column in (
        "idempotency_key",
        "notification_event_id",
        "rule_id",
        "shop_id",
        "posting_number",
        "scene",
        "scheduled_for",
        "status",
    ):
        op.create_index(f"ix_smart_reply_tasks_{column}", "smart_reply_tasks", [column])


def downgrade() -> None:
    op.drop_table("smart_reply_tasks")
    op.drop_table("smart_reply_rule_shops")
    op.drop_table("smart_reply_rules")
    op.drop_table("smart_reply_credentials")
    op.drop_index(
        "ix_ozon_notification_events_smart_reply_retry_at",
        table_name="ozon_notification_events",
    )
    op.drop_index(
        "ix_ozon_notification_events_smart_reply_state",
        table_name="ozon_notification_events",
    )
    op.drop_column("ozon_notification_events", "smart_reply_error_code")
    op.drop_column("ozon_notification_events", "smart_reply_processed_at")
    op.drop_column("ozon_notification_events", "smart_reply_retry_at")
    op.drop_column("ozon_notification_events", "smart_reply_attempts")
    op.drop_column("ozon_notification_events", "smart_reply_state")

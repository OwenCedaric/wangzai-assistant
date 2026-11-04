"""add durable Ozon notification delivery queue

Revision ID: a82b7d39e410
Revises: e7a2c94d310b
Create Date: 2026-08-22 22:25:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a82b7d39e410"
down_revision = "e7a2c94d310b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ozon_notification_events",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=False),
        sa.Column("message_type", sa.String(length=80), nullable=False),
        sa.Column("seller_id", sa.String(length=200), nullable=True),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("delivery_state", sa.String(length=24), nullable=False),
        sa.Column("delivery_attempts", sa.Integer(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(length=120), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("payload_sha256"),
    )
    op.create_index(
        "ix_ozon_notification_events_payload_sha256",
        "ozon_notification_events",
        ["payload_sha256"],
    )
    op.create_index(
        "ix_ozon_notification_events_message_type",
        "ozon_notification_events",
        ["message_type"],
    )
    op.create_index(
        "ix_ozon_notification_events_seller_id",
        "ozon_notification_events",
        ["seller_id"],
    )
    op.create_index(
        "ix_ozon_notification_events_delivery_state",
        "ozon_notification_events",
        ["delivery_state"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ozon_notification_events_delivery_state",
        table_name="ozon_notification_events",
    )
    op.drop_index("ix_ozon_notification_events_seller_id", table_name="ozon_notification_events")
    op.drop_index("ix_ozon_notification_events_message_type", table_name="ozon_notification_events")
    op.drop_index(
        "ix_ozon_notification_events_payload_sha256",
        table_name="ozon_notification_events",
    )
    op.drop_table("ozon_notification_events")

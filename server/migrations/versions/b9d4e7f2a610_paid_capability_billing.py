"""paid capability billing, reservations, rate cards, and usage

Revision ID: b9d4e7f2a610
Revises: f6a1c9d4e822
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b9d4e7f2a610"
down_revision: str | Sequence[str] | None = "f6a1c9d4e822"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("point_wallets") as batch:
        batch.add_column(
            sa.Column("reserved_points", sa.Integer(), nullable=False, server_default="0")
        )
        batch.create_check_constraint(
            "ck_point_wallet_reserved_nonnegative", "reserved_points >= 0"
        )
        batch.create_check_constraint(
            "ck_point_wallet_reserved_not_above_balance", "reserved_points <= balance_points"
        )
    with op.batch_alter_table("point_credit_lots") as batch:
        batch.add_column(
            sa.Column("reserved_points", sa.Integer(), nullable=False, server_default="0")
        )
        batch.create_check_constraint("ck_point_lot_reserved_nonnegative", "reserved_points >= 0")
        batch.create_check_constraint(
            "ck_point_lot_reserved_not_above_remaining", "reserved_points <= remaining_points"
        )

    op.create_table(
        "paid_capability_rate_cards",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("capability", sa.String(96), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("price_version", sa.String(128), nullable=False),
        sa.Column("provider_code", sa.String(64), nullable=False),
        sa.Column("provider_model", sa.String(160), nullable=False, server_default=""),
        sa.Column("input_micros_per_million", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("output_micros_per_million", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "cached_input_micros_per_million", sa.BigInteger(), nullable=False, server_default="0"
        ),
        sa.Column("fixed_cost_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("unit_cost_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "provider_multiplier_ppm", sa.Integer(), nullable=False, server_default="1000000"
        ),
        sa.Column("risk_buffer_basis_points", sa.Integer(), nullable=False, server_default="500"),
        sa.Column(
            "target_margin_basis_points", sa.Integer(), nullable=False, server_default="1800"
        ),
        sa.Column(
            "minimum_margin_basis_points", sa.Integer(), nullable=False, server_default="1500"
        ),
        sa.Column("points_per_cny", sa.Integer(), nullable=False, server_default="1050"),
        sa.Column("currency", sa.String(3), nullable=False, server_default="CNY"),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("effective_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(24), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("project_id", "capability", "version", "price_version"),
        sa.CheckConstraint("version > 0", name="ck_paid_rate_version_positive"),
        sa.CheckConstraint("points_per_cny > 0", name="ck_paid_rate_points_per_cny_positive"),
        sa.CheckConstraint(
            "target_margin_basis_points >= minimum_margin_basis_points "
            "AND target_margin_basis_points < 10000",
            name="ck_paid_rate_margin_safe",
        ),
    )
    op.create_index("ix_paid_rate_project", "paid_capability_rate_cards", ["project_id"])
    op.create_index("ix_paid_rate_capability", "paid_capability_rate_cards", ["capability"])
    op.create_index("ix_paid_rate_effective", "paid_capability_rate_cards", ["effective_from"])

    op.create_table(
        "paid_capability_quotes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "rate_card_id",
            sa.Integer(),
            sa.ForeignKey("paid_capability_rate_cards.id"),
            nullable=False,
        ),
        sa.Column("capability", sa.String(96), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("input_hash", sa.String(71), nullable=False),
        sa.Column("estimated_points", sa.Integer(), nullable=False),
        sa.Column("maximum_points", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="active"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("estimated_points >= 0", name="ck_paid_quote_estimate_nonnegative"),
        sa.CheckConstraint("maximum_points > 0", name="ck_paid_quote_maximum_positive"),
        sa.CheckConstraint(
            "maximum_points >= estimated_points", name="ck_paid_quote_maximum_not_below_estimate"
        ),
    )
    op.create_index("ix_paid_quote_user", "paid_capability_quotes", ["user_id"])
    op.create_index("ix_paid_quote_project", "paid_capability_quotes", ["project_id"])
    op.create_index("ix_paid_quote_rate", "paid_capability_quotes", ["rate_card_id"])
    op.create_index("ix_paid_quote_capability", "paid_capability_quotes", ["capability"])
    op.create_index("ix_paid_quote_status", "paid_capability_quotes", ["status"])
    op.create_index("ix_paid_quote_expires", "paid_capability_quotes", ["expires_at"])

    op.create_table(
        "paid_capability_jobs",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "quote_id",
            sa.String(36),
            sa.ForeignKey("paid_capability_quotes.id"),
            nullable=True,
            unique=True,
        ),
        sa.Column("capability", sa.String(96), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("input_hash", sa.String(71), nullable=False),
        sa.Column("request_hash", sa.String(71), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("provider_request_id_hash", sa.String(71), nullable=True),
        sa.Column("result_json", sa.JSON(), nullable=True),
        sa.Column("error_code", sa.String(96), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "project_id", "idempotency_key"),
    )
    op.create_index("ix_paid_job_user", "paid_capability_jobs", ["user_id"])
    op.create_index("ix_paid_job_project", "paid_capability_jobs", ["project_id"])
    op.create_index("ix_paid_job_capability", "paid_capability_jobs", ["capability"])
    op.create_index("ix_paid_job_status", "paid_capability_jobs", ["status"])

    op.create_table(
        "point_reservations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "wallet_id",
            sa.Integer(),
            sa.ForeignKey("point_wallets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "job_id",
            sa.String(64),
            sa.ForeignKey("paid_capability_jobs.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("reserved_points", sa.Integer(), nullable=False),
        sa.Column("settled_points", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("released_points", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(24), nullable=False, server_default="reserved"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("release_reason", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("reserved_points > 0", name="ck_point_reservation_reserved_positive"),
        sa.CheckConstraint("settled_points >= 0", name="ck_point_reservation_settled_nonnegative"),
        sa.CheckConstraint(
            "released_points >= 0", name="ck_point_reservation_released_nonnegative"
        ),
        sa.CheckConstraint(
            "settled_points + released_points <= reserved_points",
            name="ck_point_reservation_accounted_not_above_reserved",
        ),
    )
    op.create_index("ix_point_reservation_wallet", "point_reservations", ["wallet_id"])
    op.create_index("ix_point_reservation_job", "point_reservations", ["job_id"])
    op.create_index("ix_point_reservation_status", "point_reservations", ["status"])

    op.create_table(
        "point_reservation_lots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "reservation_id",
            sa.Integer(),
            sa.ForeignKey("point_reservations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "credit_lot_id",
            sa.Integer(),
            sa.ForeignKey("point_credit_lots.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("reserved_points", sa.Integer(), nullable=False),
        sa.Column("settled_points", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("released_points", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("reservation_id", "credit_lot_id"),
        sa.CheckConstraint(
            "reserved_points > 0", name="ck_point_reservation_lot_reserved_positive"
        ),
        sa.CheckConstraint(
            "settled_points >= 0", name="ck_point_reservation_lot_settled_nonnegative"
        ),
        sa.CheckConstraint(
            "released_points >= 0", name="ck_point_reservation_lot_released_nonnegative"
        ),
    )
    op.create_index(
        "ix_point_reservation_lot_reservation", "point_reservation_lots", ["reservation_id"]
    )
    op.create_index("ix_point_reservation_lot_credit", "point_reservation_lots", ["credit_lot_id"])

    op.create_table(
        "provider_usage_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "job_id",
            sa.String(64),
            sa.ForeignKey("paid_capability_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_key", sa.String(128), nullable=False),
        sa.Column("provider_code", sa.String(64), nullable=False),
        sa.Column("provider_model", sa.String(160), nullable=False, server_default=""),
        sa.Column("operation", sa.String(96), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cached_input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("units", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("provider_cost_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("charged_points", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("billable", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("provider_request_id_hash", sa.String(71), nullable=True),
        sa.Column("usage_hash", sa.String(71), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("job_id", "event_key"),
    )
    op.create_index("ix_provider_usage_job", "provider_usage_events", ["job_id"])
    op.create_index("ix_provider_usage_provider", "provider_usage_events", ["provider_code"])


def downgrade() -> None:
    op.drop_table("provider_usage_events")
    op.drop_table("point_reservation_lots")
    op.drop_table("point_reservations")
    op.drop_table("paid_capability_jobs")
    op.drop_table("paid_capability_quotes")
    op.drop_table("paid_capability_rate_cards")
    with op.batch_alter_table("point_credit_lots") as batch:
        batch.drop_constraint("ck_point_lot_reserved_not_above_remaining", type_="check")
        batch.drop_constraint("ck_point_lot_reserved_nonnegative", type_="check")
        batch.drop_column("reserved_points")
    with op.batch_alter_table("point_wallets") as batch:
        batch.drop_constraint("ck_point_wallet_reserved_not_above_balance", type_="check")
        batch.drop_constraint("ck_point_wallet_reserved_nonnegative", type_="check")
        batch.drop_column("reserved_points")

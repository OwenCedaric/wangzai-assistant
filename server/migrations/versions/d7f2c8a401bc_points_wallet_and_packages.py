"""points wallet, ledger, lots, and point package metadata

Revision ID: d7f2c8a401bc
Revises: c4e8a1d2f390
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d7f2c8a401bc"
down_revision: str | None = "c4e8a1d2f390"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("plans") as batch:
        batch.add_column(
            sa.Column("plan_kind", sa.String(length=24), nullable=False, server_default="license")
        )
        batch.add_column(
            sa.Column("points_amount", sa.Integer(), nullable=False, server_default="0")
        )
        batch.add_column(sa.Column("customer_description", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column("featured", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch.add_column(
            sa.Column("display_order", sa.Integer(), nullable=False, server_default="0")
        )
        batch.create_check_constraint("ck_plans_kind", "plan_kind IN ('license', 'points')")
        batch.create_check_constraint("ck_plans_points_amount_nonnegative", "points_amount >= 0")
        batch.create_index("ix_plans_plan_kind", ["plan_kind"], unique=False)

    with op.batch_alter_table("order_fulfillments") as batch:
        batch.add_column(
            sa.Column("points_credited", sa.Integer(), nullable=False, server_default="0")
        )
        batch.add_column(sa.Column("point_balance_after", sa.Integer(), nullable=True))

    op.create_table(
        "point_wallets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("balance_points", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lifetime_credited_points", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lifetime_spent_points", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "project_id"),
        sa.CheckConstraint("balance_points >= 0", name="ck_point_wallet_balance_nonnegative"),
        sa.CheckConstraint(
            "lifetime_credited_points >= 0", name="ck_point_wallet_credited_nonnegative"
        ),
        sa.CheckConstraint("lifetime_spent_points >= 0", name="ck_point_wallet_spent_nonnegative"),
    )
    op.create_index("ix_point_wallets_user_id", "point_wallets", ["user_id"])
    op.create_index("ix_point_wallets_project_id", "point_wallets", ["project_id"])

    op.create_table(
        "point_credit_lots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "wallet_id",
            sa.Integer(),
            sa.ForeignKey("point_wallets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=True),
        sa.Column("original_points", sa.Integer(), nullable=False),
        sa.Column("remaining_points", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source_order_id"),
        sa.CheckConstraint("original_points > 0", name="ck_point_lot_original_positive"),
        sa.CheckConstraint("remaining_points >= 0", name="ck_point_lot_remaining_nonnegative"),
        sa.CheckConstraint(
            "remaining_points <= original_points", name="ck_point_lot_remaining_not_above_original"
        ),
    )
    op.create_index("ix_point_credit_lots_wallet_id", "point_credit_lots", ["wallet_id"])
    op.create_index(
        "ix_point_credit_lots_source_order_id",
        "point_credit_lots",
        ["source_order_id"],
        unique=True,
    )
    op.create_index("ix_point_credit_lots_expires_at", "point_credit_lots", ["expires_at"])
    op.create_index("ix_point_credit_lots_status", "point_credit_lots", ["status"])

    op.create_table(
        "point_ledger_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "wallet_id",
            sa.Integer(),
            sa.ForeignKey("point_wallets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("delta_points", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=48), nullable=False),
        sa.Column("reference_type", sa.String(length=32), nullable=True),
        sa.Column("reference_id", sa.String(length=128), nullable=True),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("wallet_id", "idempotency_key"),
        sa.CheckConstraint("delta_points != 0", name="ck_point_ledger_delta_nonzero"),
        sa.CheckConstraint("balance_after >= 0", name="ck_point_ledger_balance_nonnegative"),
    )
    for column in ("wallet_id", "user_id", "project_id", "event_type", "reference_id"):
        op.create_index(f"ix_point_ledger_entries_{column}", "point_ledger_entries", [column])


def downgrade() -> None:
    op.drop_table("point_ledger_entries")
    op.drop_table("point_credit_lots")
    op.drop_table("point_wallets")
    with op.batch_alter_table("order_fulfillments") as batch:
        batch.drop_column("point_balance_after")
        batch.drop_column("points_credited")
    with op.batch_alter_table("plans") as batch:
        batch.drop_index("ix_plans_plan_kind")
        batch.drop_constraint("ck_plans_points_amount_nonnegative", type_="check")
        batch.drop_constraint("ck_plans_kind", type_="check")
        batch.drop_column("display_order")
        batch.drop_column("featured")
        batch.drop_column("customer_description")
        batch.drop_column("points_amount")
        batch.drop_column("plan_kind")

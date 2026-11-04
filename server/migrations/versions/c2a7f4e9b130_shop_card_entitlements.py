"""shop-card roles and one-time introductory offer redemption

Revision ID: c2a7f4e9b130
Revises: b9d4e7f2a610
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c2a7f4e9b130"
down_revision: str | Sequence[str] | None = "b9d4e7f2a610"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("shops") as batch:
        batch.create_unique_constraint(
            "uq_shops_project_platform_shop",
            ["project_id", "platform", "shop_id"],
        )

    with op.batch_alter_table("plans") as batch:
        batch.add_column(
            sa.Column("license_role", sa.String(32), nullable=False, server_default="legacy")
        )
        batch.create_index("ix_plans_license_role", ["license_role"])
        batch.create_check_constraint(
            "ck_plans_license_role",
            "license_role IN ('legacy', 'shop_intro', 'shop_standard_monthly', "
            "'shop_standard_annual')",
        )

    op.create_table(
        "shop_intro_redemptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "license_id",
            sa.Integer(),
            sa.ForeignKey("licenses.id", ondelete="SET NULL"),
            nullable=True,
            unique=True,
        ),
        sa.Column(
            "activation_code_id",
            sa.Integer(),
            sa.ForeignKey("activation_codes.id", ondelete="SET NULL"),
            nullable=True,
            unique=True,
        ),
        sa.Column("redeemed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_shop_intro_redemptions_user_id",
        "shop_intro_redemptions",
        ["user_id"],
    )
    op.create_index(
        "ix_shop_intro_redemptions_project_id",
        "shop_intro_redemptions",
        ["project_id"],
    )
    op.create_index(
        "ix_shop_intro_redemptions_redeemed_at",
        "shop_intro_redemptions",
        ["redeemed_at"],
    )


def downgrade() -> None:
    op.drop_table("shop_intro_redemptions")
    with op.batch_alter_table("plans") as batch:
        batch.drop_constraint("ck_plans_license_role", type_="check")
        batch.drop_index("ix_plans_license_role")
        batch.drop_column("license_role")
    with op.batch_alter_table("shops") as batch:
        batch.drop_constraint("uq_shops_project_platform_shop", type_="unique")

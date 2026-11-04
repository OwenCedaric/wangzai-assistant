"""user model presets

Revision ID: f9a2c6e8d410
Revises: d4e1b8a2c650
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f9a2c6e8d410"
down_revision: str | Sequence[str] | None = "d4e1b8a2c650"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_model_presets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("capability_kind", sa.String(length=32), nullable=False),
        sa.Column("enabled_models", sa.JSON(), nullable=False),
        sa.Column("default_model", sa.String(length=160), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "capability_kind IN ('text', 'image')",
            name="ck_user_model_preset_capability_kind",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "project_id", "capability_kind"),
    )
    op.create_index(
        op.f("ix_user_model_presets_user_id"),
        "user_model_presets",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_user_model_presets_project_id"),
        "user_model_presets",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_user_model_presets_capability_kind"),
        "user_model_presets",
        ["capability_kind"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_user_model_presets_capability_kind"), table_name="user_model_presets")
    op.drop_index(op.f("ix_user_model_presets_project_id"), table_name="user_model_presets")
    op.drop_index(op.f("ix_user_model_presets_user_id"), table_name="user_model_presets")
    op.drop_table("user_model_presets")

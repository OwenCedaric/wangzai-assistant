"""limit text models to Terra/Sol and reasoning to medium/high

Revision ID: e7a2c94d310b
Revises: c41f08a62d37
Create Date: 2026-08-22 16:30:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "e7a2c94d310b"
down_revision = "c41f08a62d37"
branch_labels = None
depends_on = None

_ALLOWED = ("gpt-5.6-terra", "gpt-5.6-sol")


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE api_pool_models SET status = 'disabled' "
            "WHERE capability_kind = 'text' "
            "AND model_code NOT IN ('gpt-5.6-terra', 'gpt-5.6-sol')"
        )
    )
    bind.execute(
        sa.text(
            "UPDATE api_pool_models SET status = 'active' "
            "WHERE capability_kind = 'text' "
            "AND model_code IN ('gpt-5.6-terra', 'gpt-5.6-sol')"
        )
    )
    bind.execute(
        sa.text(
            "UPDATE paid_capability_rate_cards SET status = 'disabled' "
            "WHERE capability LIKE 'text.%' "
            "AND provider_model NOT IN ('gpt-5.6-terra', 'gpt-5.6-sol')"
        )
    )
    presets = sa.table(
        "user_model_presets",
        sa.column("id", sa.Integer),
        sa.column("capability_kind", sa.String),
        sa.column("enabled_models", sa.JSON),
        sa.column("default_model", sa.String),
    )
    bind.execute(
        presets.update()
        .where(presets.c.capability_kind == "text")
        .values(enabled_models=list(_ALLOWED), default_model="gpt-5.6-terra")
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text("UPDATE api_pool_models SET status = 'active' WHERE capability_kind = 'text'")
    )
    bind.execute(
        sa.text(
            "UPDATE paid_capability_rate_cards SET status = 'active' WHERE capability LIKE 'text.%'"
        )
    )

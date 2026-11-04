from __future__ import annotations

from sqlalchemy import JSON, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base
from app.models.base import TimestampMixin


class UsageLog(TimestampMixin, Base):
    __tablename__ = "usage_logs"
    # Dashboard counts are bounded by created_at (migration b7c3e1d9a520).
    __table_args__ = (Index("ix_usage_logs_created_at", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), index=True)
    license_id: Mapped[int | None] = mapped_column(ForeignKey("licenses.id"), index=True)
    event: Mapped[str] = mapped_column(String(96), index=True)
    device_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    details: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)

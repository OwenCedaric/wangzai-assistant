from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base
from app.models.base import utcnow


class OzonNotificationEvent(Base):
    __tablename__ = "ozon_notification_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload_sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    message_type: Mapped[str] = mapped_column(String(80), index=True)
    seller_id: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    payload_json: Mapped[str] = mapped_column(Text)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    delivery_state: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    delivery_attempts: Mapped[int] = mapped_column(Integer, default=0)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    smart_reply_state: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    smart_reply_attempts: Mapped[int] = mapped_column(Integer, default=0)
    smart_reply_retry_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    smart_reply_processed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    smart_reply_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)

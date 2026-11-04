from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.models.base import TimestampMixin


class SmartReplyCredential(TimestampMixin, Base):
    __tablename__ = "smart_reply_credentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    shop_id: Mapped[int] = mapped_column(
        ForeignKey("shops.id", ondelete="CASCADE"), unique=True, index=True
    )
    api_key_ciphertext: Mapped[str] = mapped_column(Text)
    api_key_fingerprint: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    last_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)

    shop = relationship("Shop")


class SmartReplyRule(TimestampMixin, Base):
    __tablename__ = "smart_reply_rules"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    license_id: Mapped[int] = mapped_column(
        ForeignKey("licenses.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    scene: Mapped[str] = mapped_column(String(40), index=True)
    send_time_type: Mapped[str] = mapped_column(String(20), default="immediate")
    delay_hours: Mapped[int] = mapped_column(Integer, default=0)
    content_generate_type: Mapped[str] = mapped_column(String(20), default="template")
    template_id: Mapped[str] = mapped_column(String(100))
    message_template: Mapped[str] = mapped_column(Text)
    message_template_zh: Mapped[str] = mapped_column(Text, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    shops = relationship(
        "SmartReplyRuleShop",
        back_populates="rule",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class SmartReplyRuleShop(Base):
    __tablename__ = "smart_reply_rule_shops"
    __table_args__ = (UniqueConstraint("rule_id", "shop_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[str] = mapped_column(
        ForeignKey("smart_reply_rules.id", ondelete="CASCADE"), index=True
    )
    shop_id: Mapped[int] = mapped_column(
        ForeignKey("shops.id", ondelete="CASCADE"), index=True
    )

    rule = relationship("SmartReplyRule", back_populates="shops")
    shop = relationship("Shop")


class SmartReplyTask(TimestampMixin, Base):
    __tablename__ = "smart_reply_tasks"
    __table_args__ = (UniqueConstraint("idempotency_key"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(220), index=True)
    notification_event_id: Mapped[str | None] = mapped_column(
        ForeignKey("ozon_notification_events.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    rule_id: Mapped[str] = mapped_column(
        ForeignKey("smart_reply_rules.id", ondelete="CASCADE"), index=True
    )
    shop_id: Mapped[int] = mapped_column(
        ForeignKey("shops.id", ondelete="CASCADE"), index=True
    )
    posting_number: Mapped[str] = mapped_column(String(160), index=True)
    scene: Mapped[str] = mapped_column(String(40), index=True)
    trigger_status: Mapped[str] = mapped_column(String(120))
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    template_snapshot: Mapped[str] = mapped_column(Text)
    rendered_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    chat_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    ozon_message_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    send_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    rule = relationship("SmartReplyRule")
    shop = relationship("Shop")

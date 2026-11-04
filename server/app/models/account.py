from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.models.base import TimestampMixin


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    # Kept for v1 username/password API and legacy rows. New SMS accounts use the
    # hash/ciphertext/masked fields below and never persist a plaintext phone here.
    phone: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)
    phone_hash: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    phone_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    phone_masked: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    phone_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    email: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    device_limit_exempt: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    licenses = relationship("License", back_populates="user")
    devices = relationship("Device", back_populates="user")
    shops = relationship("Shop", back_populates="user")
    auth_sessions = relationship("AuthSession", back_populates="user", cascade="all, delete-orphan")
    attributions = relationship(
        "UserProjectAttribution", back_populates="user", cascade="all, delete-orphan"
    )
    orders = relationship("Order", back_populates="user")

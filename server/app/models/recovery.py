from __future__ import annotations

from sqlalchemy import CheckConstraint, ForeignKey, Integer, LargeBinary, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.database.base import Base
from app.models.base import TimestampMixin


class RecoveryObject(TimestampMixin, Base):
    """Opaque encrypted recovery object; the service never decrypts this binary payload."""

    __tablename__ = "recovery_objects"
    __table_args__ = (
        UniqueConstraint("user_id", "chunk_id"),
        CheckConstraint("cipher_bytes > 28", name="ck_recovery_objects_cipher_bytes"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    chunk_id: Mapped[str] = mapped_column(String(128), index=True)
    cipher_sha256: Mapped[str] = mapped_column(String(64))
    cipher_bytes: Mapped[int] = mapped_column(Integer)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)

    generation_links = relationship(
        "RecoveryGenerationObject", back_populates="recovery_object", cascade="all, delete-orphan"
    )


class RecoveryGeneration(TimestampMixin, Base):
    """One atomically committed current generation for an opaque per-shop scope."""

    __tablename__ = "recovery_generations"
    __table_args__ = (
        UniqueConstraint("public_id"),
        UniqueConstraint("user_id", "scope_key"),
        CheckConstraint("logical_cipher_bytes > 0", name="ck_recovery_generations_logical_bytes"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    public_id: Mapped[str] = mapped_column(String(128), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # Generated client-side from a recovery key; it does not contain the Ozon shop id.
    scope_key: Mapped[str] = mapped_column(String(128), index=True)
    manifest_chunk_id: Mapped[str] = mapped_column(String(128))
    key_envelope: Mapped[dict[str, object]] = mapped_column(JSON)
    # Stable, client-derived HMAC references. Raw owner ids never leave the
    # desktop, while the server can reject a stale device after owner purge.
    owner_refs: Mapped[list[str]] = mapped_column(JSON, default=list)
    logical_cipher_bytes: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    object_links = relationship(
        "RecoveryGenerationObject", back_populates="generation", cascade="all, delete-orphan"
    )


class RecoveryGenerationObject(Base):
    __tablename__ = "recovery_generation_objects"
    __table_args__ = (UniqueConstraint("generation_id", "recovery_object_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    generation_id: Mapped[int] = mapped_column(
        ForeignKey("recovery_generations.id", ondelete="CASCADE"), index=True
    )
    recovery_object_id: Mapped[int] = mapped_column(
        ForeignKey("recovery_objects.id", ondelete="CASCADE"), index=True
    )

    generation = relationship("RecoveryGeneration", back_populates="object_links")
    recovery_object = relationship("RecoveryObject", back_populates="generation_links")


class RecoveryOwnerTombstone(TimestampMixin, Base):
    """Irreversible opaque owner fence shared by all recovery devices for one user."""

    __tablename__ = "recovery_owner_tombstones"
    __table_args__ = (UniqueConstraint("user_id", "owner_ref"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    owner_ref: Mapped[str] = mapped_column(String(128), index=True)

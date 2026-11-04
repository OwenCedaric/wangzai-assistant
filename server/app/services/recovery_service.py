from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, selectinload

from app.models.account import User
from app.models.base import utcnow
from app.models.recovery import (
    RecoveryGeneration,
    RecoveryGenerationObject,
    RecoveryObject,
    RecoveryOwnerTombstone,
)
from app.schemas.recovery import OPAQUE_ID_PATTERN, RecoveryGenerationCommit, RecoveryObjectRef
from app.services.errors import DomainError

RECOVERY_GENERATION_QUOTA_BYTES = 30 * 1024 * 1024
MAX_KEY_ENVELOPE_BYTES = 16 * 1024
STAGED_OBJECT_TTL = timedelta(hours=24)
# A generation may legitimately upload all of its encrypted chunks before its
# final manifest commit. Keep that short-lived staging set within one generation
# quota so abandoned/retried uploads cannot turn into unbounded server storage.
MAX_STAGED_OBJECT_BYTES_PER_USER = RECOVERY_GENERATION_QUOTA_BYTES


def _new_generation_public_id() -> str:
    """Return an opaque URL-safe id shared by the desktop recovery contract."""
    # token_urlsafe(24) is a 32-character base64url identifier.  Do not use UUID
    # strings here: older UUID-with-hyphen IDs did not satisfy the desktop client's
    # opaque-id contract and made a successfully uploaded backup impossible to restore.
    return secrets.token_urlsafe(24)


def _object_ref(row: RecoveryObject) -> RecoveryObjectRef:
    return RecoveryObjectRef(
        chunk_id=row.chunk_id,
        cipher_bytes=row.cipher_bytes,
        cipher_sha256=row.cipher_sha256,
    )


def _validate_key_envelope(value: dict[str, object]) -> None:
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise DomainError("Recovery key envelope must be JSON") from exc
    if not encoded or len(encoded) > MAX_KEY_ENVELOPE_BYTES:
        raise DomainError("Recovery key envelope is invalid")
    if value.get("format") != "wangzai-recovery-key-envelope" or value.get("version") != 1:
        raise DomainError("Recovery key envelope is unsupported")


def _normalize_owner_refs(values: list[str]) -> list[str]:
    refs = sorted(values)
    if len(set(refs)) != len(refs) or any(not re.fullmatch(OPAQUE_ID_PATTERN, ref) for ref in refs):
        raise DomainError("Recovery owner references are invalid")
    return refs


def _is_generation_lock_conflict(exc: OperationalError) -> bool:
    """Recognize only retryable database lock/serialization errors as a CAS conflict."""
    sqlstate = getattr(exc.orig, "pgcode", None)
    if sqlstate in {"40001", "40P01"}:
        return True
    message = str(exc.orig).lower()
    return "database is locked" in message or "database table is locked" in message


def purge_expired_staged_objects(
    db: Session,
    *,
    now=None,
    user_id: int | None = None,
) -> int:
    """Delete only expired, unreferenced ciphertext staging objects.

    Active generations are linked through ``generation_links`` and therefore
    cannot match this predicate. The caller owns the surrounding transaction.
    """

    cutoff = (now or utcnow()) - STAGED_OBJECT_TTL
    statement = delete(RecoveryObject).where(
        RecoveryObject.created_at < cutoff,
        ~RecoveryObject.generation_links.any(),
    )
    if user_id is not None:
        statement = statement.where(RecoveryObject.user_id == user_id)
    result = db.execute(statement)
    return int(result.rowcount or 0)


def _staged_object_bytes(db: Session, *, user_id: int) -> int:
    value = db.scalar(
        select(func.coalesce(func.sum(RecoveryObject.cipher_bytes), 0)).where(
            RecoveryObject.user_id == user_id,
            ~RecoveryObject.generation_links.any(),
        )
    )
    return int(value or 0)


def store_object(
    db: Session,
    *,
    user_id: int,
    chunk_id: str,
    cipher_sha256: str,
    ciphertext: bytes,
) -> tuple[RecoveryObject, bool]:
    if len(ciphertext) <= 28 or len(ciphertext) > RECOVERY_GENERATION_QUOTA_BYTES:
        raise DomainError("Recovery object size is invalid", status_code=413)
    actual_hash = hashlib.sha256(ciphertext).hexdigest()
    if actual_hash != cipher_sha256:
        raise DomainError("Recovery object hash mismatch")
    try:
        # PostgreSQL serializes concurrent uploads for one account on this row;
        # SQLite test mode keeps the same correctness through its write lock.
        owner = db.scalar(select(User.id).where(User.id == user_id).with_for_update())
        if owner is None:
            raise DomainError("Recovery user not found", status_code=404)
        purge_expired_staged_objects(db, user_id=user_id)
        existing = db.scalar(
            select(RecoveryObject).where(
                RecoveryObject.user_id == user_id,
                RecoveryObject.chunk_id == chunk_id,
            )
        )
        if existing:
            if existing.cipher_sha256 != cipher_sha256 or existing.cipher_bytes != len(ciphertext):
                raise DomainError("Recovery object id collision", status_code=409)
            # Persist an expired-staging purge even when this upload reused an
            # existing object and did not create another row.
            db.commit()
            return existing, True
        staged_bytes = _staged_object_bytes(db, user_id=user_id)
        if staged_bytes + len(ciphertext) > MAX_STAGED_OBJECT_BYTES_PER_USER:
            raise DomainError("Recovery staged object quota exceeded", status_code=413)
        created = RecoveryObject(
            user_id=user_id,
            chunk_id=chunk_id,
            cipher_sha256=cipher_sha256,
            cipher_bytes=len(ciphertext),
            ciphertext=ciphertext,
        )
        db.add(created)
        db.commit()
        db.refresh(created)
        return created, False
    except Exception:
        db.rollback()
        raise


def _load_commit_objects(
    db: Session, *, user_id: int, object_refs: list[RecoveryObjectRef]
) -> list[RecoveryObject]:
    chunk_ids = [item.chunk_id for item in object_refs]
    if len(set(chunk_ids)) != len(chunk_ids):
        raise DomainError("Recovery object refs must be unique")
    rows = db.scalars(
        select(RecoveryObject).where(
            RecoveryObject.user_id == user_id,
            RecoveryObject.chunk_id.in_(chunk_ids),
        )
    ).all()
    by_id = {row.chunk_id: row for row in rows}
    if len(by_id) != len(chunk_ids):
        raise DomainError("Recovery object is not uploaded", status_code=409)
    ordered = [by_id[chunk_id] for chunk_id in chunk_ids]
    for expected, actual in zip(object_refs, ordered, strict=True):
        if (
            actual.cipher_bytes != expected.cipher_bytes
            or actual.cipher_sha256 != expected.cipher_sha256
        ):
            raise DomainError("Recovery object reference mismatch", status_code=409)
    return ordered


def commit_generation(
    db: Session, *, user_id: int, payload: RecoveryGenerationCommit
) -> RecoveryGeneration:
    _validate_key_envelope(payload.key_envelope)
    owner_refs = _normalize_owner_refs(payload.owner_refs)
    referenced_bytes = sum(item.cipher_bytes for item in payload.object_refs)
    if (
        payload.logical_cipher_bytes != referenced_bytes
        or referenced_bytes > RECOVERY_GENERATION_QUOTA_BYTES
    ):
        raise DomainError("Recovery generation exceeds the 30 MiB quota")
    try:
        owner = db.scalar(select(User.id).where(User.id == user_id).with_for_update())
        if owner is None:
            raise DomainError("Recovery user not found", status_code=404)
        tombstone_refs = set(
            db.scalars(
                select(RecoveryOwnerTombstone.owner_ref).where(
                    RecoveryOwnerTombstone.user_id == user_id
                )
            ).all()
        )
        if tombstone_refs and not owner_refs:
            raise DomainError("Recovery client owner metadata required", status_code=409)
        if tombstone_refs.intersection(owner_refs):
            raise DomainError("Recovery owner was purged", status_code=409)
        objects = _load_commit_objects(db, user_id=user_id, object_refs=payload.object_refs)
        manifest = next(
            (item for item in objects if item.chunk_id == payload.manifest_chunk_id),
            None,
        )
        if manifest is None:
            raise DomainError("Recovery manifest object is missing")
        previous = db.scalar(
            select(RecoveryGeneration)
            .where(
                RecoveryGeneration.user_id == user_id,
                RecoveryGeneration.scope_key == payload.scope_key,
                RecoveryGeneration.status == "active",
            )
            .options(selectinload(RecoveryGeneration.object_links))
            .with_for_update()
        )
        previous_object_ids = (
            {link.recovery_object_id for link in previous.object_links}
            if previous is not None
            else set()
        )
        if "expected_generation_id" in payload.model_fields_set:
            actual_generation_id = previous.public_id if previous is not None else None
            if payload.expected_generation_id != actual_generation_id:
                raise DomainError("Recovery generation conflict", status_code=409)
        if previous is not None:
            db.delete(previous)
            db.flush()
        generation = RecoveryGeneration(
            public_id=_new_generation_public_id(),
            user_id=user_id,
            scope_key=payload.scope_key,
            manifest_chunk_id=payload.manifest_chunk_id,
            key_envelope=payload.key_envelope,
            owner_refs=owner_refs,
            logical_cipher_bytes=referenced_bytes,
            status="active",
        )
        db.add(generation)
        db.flush()
        for object_row in objects:
            db.add(
                RecoveryGenerationObject(
                    generation_id=generation.id,
                    recovery_object_id=object_row.id,
                )
            )
        db.flush()
        new_object_ids = {item.id for item in objects}
        orphans = db.scalars(
            select(RecoveryObject).where(
                RecoveryObject.user_id == user_id,
                RecoveryObject.id.in_(previous_object_ids - new_object_ids),
                ~RecoveryObject.generation_links.any(),
            )
        ).all()
        for orphan in orphans:
            db.delete(orphan)
        db.commit()
        db.refresh(generation)
        return generation
    except IntegrityError as exc:
        # A first-generation commit has no existing row to lock.  A competing
        # commit can therefore win the unique (user_id, scope_key) insert race.
        # It must become an explicit retryable CAS conflict, never an unhandled
        # database error or a destructive retry.
        db.rollback()
        raise DomainError("Recovery generation conflict", status_code=409) from exc
    except OperationalError as exc:
        db.rollback()
        if _is_generation_lock_conflict(exc):
            raise DomainError("Recovery generation conflict", status_code=409) from exc
        raise
    except Exception:
        db.rollback()
        raise


def list_active_generations(db: Session, *, user_id: int) -> list[RecoveryGeneration]:
    return db.scalars(
        select(RecoveryGeneration)
        .where(RecoveryGeneration.user_id == user_id, RecoveryGeneration.status == "active")
        .order_by(RecoveryGeneration.created_at.desc())
    ).all()


def get_generation(db: Session, *, user_id: int, generation_id: str) -> RecoveryGeneration:
    generation = db.scalar(
        select(RecoveryGeneration)
        .where(
            RecoveryGeneration.public_id == generation_id,
            RecoveryGeneration.user_id == user_id,
            RecoveryGeneration.status == "active",
        )
        .options(
            selectinload(RecoveryGeneration.object_links).selectinload(
                RecoveryGenerationObject.recovery_object
            )
        )
    )
    if generation is None:
        raise DomainError("Recovery generation not found", status_code=404)
    return generation


def get_generation_object(
    db: Session, *, user_id: int, generation_id: str, chunk_id: str
) -> RecoveryObject:
    generation = get_generation(db, user_id=user_id, generation_id=generation_id)
    for link in generation.object_links:
        if link.recovery_object.chunk_id == chunk_id:
            return link.recovery_object
    raise DomainError("Recovery object not found", status_code=404)


def generation_refs(generation: RecoveryGeneration) -> list[RecoveryObjectRef]:
    return sorted(
        (_object_ref(link.recovery_object) for link in generation.object_links),
        key=lambda item: item.chunk_id,
    )


def purge_recovery_owner(
    db: Session,
    *,
    user_id: int,
    owner_ref: str,
    expected_generation_ids: list[str],
) -> tuple[list[str], int]:
    if not re.fullmatch(OPAQUE_ID_PATTERN, owner_ref):
        raise DomainError("Recovery owner reference is invalid")
    if len(set(expected_generation_ids)) != len(expected_generation_ids):
        raise DomainError("Recovery expected generations are invalid")
    try:
        owner = db.scalar(select(User.id).where(User.id == user_id).with_for_update())
        if owner is None:
            raise DomainError("Recovery user not found", status_code=404)
        generations = db.scalars(
            select(RecoveryGeneration)
            .where(
                RecoveryGeneration.user_id == user_id,
                RecoveryGeneration.status == "active",
            )
            .options(selectinload(RecoveryGeneration.object_links))
            .with_for_update()
        ).all()
        actual_ids = sorted(generation.public_id for generation in generations)
        if actual_ids != sorted(expected_generation_ids):
            raise DomainError("Recovery owner purge conflict", status_code=409)
        deleted_ids: list[str] = []
        candidate_object_ids: set[int] = set()
        for generation in generations:
            refs = _normalize_owner_refs(list(generation.owner_refs or []))
            # Legacy generations have no trusted owner metadata. The caller has
            # already CAS-inspected the complete active set, so fail closed by
            # deleting an unclassified legacy generation at the tombstone gate.
            if refs and owner_ref not in refs:
                continue
            deleted_ids.append(generation.public_id)
            candidate_object_ids.update(link.recovery_object_id for link in generation.object_links)
            db.delete(generation)
        db.flush()
        if candidate_object_ids:
            orphan_objects = db.scalars(
                select(RecoveryObject).where(
                    RecoveryObject.user_id == user_id,
                    RecoveryObject.id.in_(candidate_object_ids),
                    ~RecoveryObject.generation_links.any(),
                )
            ).all()
            for orphan in orphan_objects:
                db.delete(orphan)
        existing = db.scalar(
            select(RecoveryOwnerTombstone).where(
                RecoveryOwnerTombstone.user_id == user_id,
                RecoveryOwnerTombstone.owner_ref == owner_ref,
            )
        )
        if existing is None:
            db.add(RecoveryOwnerTombstone(user_id=user_id, owner_ref=owner_ref))
        db.commit()
        remaining = db.scalar(
            select(func.count())
            .select_from(RecoveryGeneration)
            .where(
                RecoveryGeneration.user_id == user_id,
                RecoveryGeneration.status == "active",
            )
        )
        return sorted(deleted_ids), int(remaining or 0)
    except Exception:
        db.rollback()
        raise


def recovery_owner_is_tombstoned(db: Session, *, user_id: int, owner_ref: str) -> bool:
    if not re.fullmatch(OPAQUE_ID_PATTERN, owner_ref):
        raise DomainError("Recovery owner reference is invalid")
    return (
        db.scalar(
            select(RecoveryOwnerTombstone.id).where(
                RecoveryOwnerTombstone.user_id == user_id,
                RecoveryOwnerTombstone.owner_ref == owner_ref,
            )
        )
        is not None
    )

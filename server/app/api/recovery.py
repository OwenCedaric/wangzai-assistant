from __future__ import annotations

import hashlib
import re

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from app.auth.dependencies import require_user_token
from app.database.session import get_db
from app.models import User
from app.schemas.recovery import (
    OPAQUE_ID_PATTERN,
    SHA256_PATTERN,
    RecoveryGenerationCommit,
    RecoveryGenerationDetail,
    RecoveryGenerationRead,
    RecoveryObjectUploadRead,
    RecoveryOwnerPurgeRead,
    RecoveryOwnerPurgeRequest,
    RecoveryOwnerPurgeStatusRead,
)
from app.services.recovery_service import (
    RECOVERY_GENERATION_QUOTA_BYTES,
    commit_generation,
    generation_refs,
    get_generation,
    get_generation_object,
    list_active_generations,
    purge_recovery_owner,
    recovery_owner_is_tombstoned,
    store_object,
)

router = APIRouter(prefix="/recovery", tags=["recovery"])


def _read_cipher_headers(cipher_sha256: str | None, cipher_bytes: str | None, body: bytes) -> str:
    if cipher_sha256 is None or cipher_bytes is None:
        raise ValueError("Recovery cipher headers required")
    if not re.fullmatch(SHA256_PATTERN, cipher_sha256):
        raise ValueError("Recovery cipher hash invalid")
    try:
        declared_bytes = int(cipher_bytes)
    except ValueError as exc:
        raise ValueError("Recovery cipher bytes invalid") from exc
    if declared_bytes != len(body) or declared_bytes > RECOVERY_GENERATION_QUOTA_BYTES:
        raise ValueError("Recovery cipher bytes mismatch")
    if hashlib.sha256(body).hexdigest() != cipher_sha256:
        raise ValueError("Recovery cipher hash mismatch")
    return cipher_sha256


@router.put("/objects/{chunk_id}", response_model=RecoveryObjectUploadRead)
async def upload_recovery_object(
    chunk_id: str,
    request: Request,
    x_recovery_cipher_sha256: str | None = Header(default=None),
    x_recovery_cipher_bytes: str | None = Header(default=None),
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> RecoveryObjectUploadRead:
    if not re.fullmatch(OPAQUE_ID_PATTERN, chunk_id):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Recovery object id invalid",
        )
    body = await request.body()
    try:
        cipher_hash = _read_cipher_headers(x_recovery_cipher_sha256, x_recovery_cipher_bytes, body)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    stored, reused = store_object(
        db,
        user_id=user.id,
        chunk_id=chunk_id,
        cipher_sha256=cipher_hash,
        ciphertext=body,
    )
    return RecoveryObjectUploadRead(
        chunk_id=stored.chunk_id, cipher_bytes=stored.cipher_bytes, reused=reused
    )


@router.post("/generations", response_model=RecoveryGenerationRead, status_code=201)
def commit_recovery_generation(
    payload: RecoveryGenerationCommit,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> RecoveryGenerationRead:
    generation = commit_generation(db, user_id=user.id, payload=payload)
    return RecoveryGenerationRead(
        generation_id=generation.public_id,
        scope_key=generation.scope_key,
        manifest_chunk_id=generation.manifest_chunk_id,
        key_envelope=generation.key_envelope,
        owner_refs=list(generation.owner_refs or []),
        logical_cipher_bytes=generation.logical_cipher_bytes,
        created_at=generation.created_at,
    )


@router.get("/generations", response_model=list[RecoveryGenerationRead])
def list_recovery_generations(
    user: User = Depends(require_user_token), db: Session = Depends(get_db)
) -> list[RecoveryGenerationRead]:
    return [
        RecoveryGenerationRead(
            generation_id=item.public_id,
            scope_key=item.scope_key,
            manifest_chunk_id=item.manifest_chunk_id,
            key_envelope=item.key_envelope,
            owner_refs=list(item.owner_refs or []),
            logical_cipher_bytes=item.logical_cipher_bytes,
            created_at=item.created_at,
        )
        for item in list_active_generations(db, user_id=user.id)
    ]


@router.get("/generations/{generation_id}", response_model=RecoveryGenerationDetail)
def get_recovery_generation(
    generation_id: str,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> RecoveryGenerationDetail:
    generation = get_generation(db, user_id=user.id, generation_id=generation_id)
    return RecoveryGenerationDetail(
        generation_id=generation.public_id,
        scope_key=generation.scope_key,
        manifest_chunk_id=generation.manifest_chunk_id,
        key_envelope=generation.key_envelope,
        owner_refs=list(generation.owner_refs or []),
        logical_cipher_bytes=generation.logical_cipher_bytes,
        created_at=generation.created_at,
        object_refs=generation_refs(generation),
    )


@router.get("/generations/{generation_id}/objects/{chunk_id}")
def download_recovery_object(
    generation_id: str,
    chunk_id: str,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> Response:
    object_row = get_generation_object(
        db, user_id=user.id, generation_id=generation_id, chunk_id=chunk_id
    )
    return Response(
        content=object_row.ciphertext,
        media_type="application/octet-stream",
        headers={
            "X-Recovery-Cipher-Sha256": object_row.cipher_sha256,
            "X-Recovery-Cipher-Bytes": str(object_row.cipher_bytes),
            "Cache-Control": "no-store",
        },
    )


@router.post("/owners/{owner_ref}/purge", response_model=RecoveryOwnerPurgeRead)
def purge_recovery_owner_route(
    owner_ref: str,
    payload: RecoveryOwnerPurgeRequest,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> RecoveryOwnerPurgeRead:
    deleted_ids, remaining = purge_recovery_owner(
        db,
        user_id=user.id,
        owner_ref=owner_ref,
        expected_generation_ids=payload.expected_generation_ids,
    )
    return RecoveryOwnerPurgeRead(
        owner_ref=owner_ref,
        tombstoned=True,
        deleted_generation_ids=deleted_ids,
        remaining_generation_count=remaining,
    )


@router.get("/owners/{owner_ref}/purge-status", response_model=RecoveryOwnerPurgeStatusRead)
def get_recovery_owner_purge_status(
    owner_ref: str,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> RecoveryOwnerPurgeStatusRead:
    return RecoveryOwnerPurgeStatusRead(
        owner_ref=owner_ref,
        tombstoned=recovery_owner_is_tombstoned(db, user_id=user.id, owner_ref=owner_ref),
    )

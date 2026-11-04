from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from pydantic import Field

from app.schemas.common import StrictModel

OPAQUE_ID_PATTERN = r"^[A-Za-z0-9_-]{20,128}$"
# CU-073 changed newly issued server generation ids to base64url tokens.  Recovery
# backups created before that release used UUIDs, which must still be usable as a
# compare-and-swap predecessor while they are being replaced.
GENERATION_ID_PATTERN = (
    r"^(?:[A-Za-z0-9_-]{20,128}|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})$"
)
SHA256_PATTERN = r"^[a-f0-9]{64}$"
OpaqueId = Annotated[str, Field(pattern=OPAQUE_ID_PATTERN)]
GenerationId = Annotated[str, Field(pattern=GENERATION_ID_PATTERN)]


class RecoveryObjectRef(StrictModel):
    chunk_id: str = Field(pattern=OPAQUE_ID_PATTERN)
    cipher_bytes: int = Field(gt=28, le=30 * 1024 * 1024)
    cipher_sha256: str = Field(pattern=SHA256_PATTERN)


class RecoveryGenerationCommit(StrictModel):
    scope_key: str = Field(pattern=OPAQUE_ID_PATTERN)
    # New clients always send this field, including null for a first generation.
    # Keeping it optional preserves recovery for pre-CAS desktop clients until
    # their next upgrade; the service uses model_fields_set to distinguish an
    # omitted legacy field from an explicit first-generation assertion.
    expected_generation_id: str | None = Field(default=None, pattern=GENERATION_ID_PATTERN)
    owner_refs: list[OpaqueId] = Field(default_factory=list, max_length=10_000)
    key_envelope: dict[str, Any]
    manifest_chunk_id: str = Field(pattern=OPAQUE_ID_PATTERN)
    logical_cipher_bytes: int = Field(gt=0, le=30 * 1024 * 1024)
    object_refs: list[RecoveryObjectRef] = Field(min_length=1, max_length=10_000)


class RecoveryGenerationRead(StrictModel):
    generation_id: str
    scope_key: str
    manifest_chunk_id: str
    key_envelope: dict[str, Any]
    owner_refs: list[str]
    logical_cipher_bytes: int
    created_at: datetime


class RecoveryGenerationDetail(RecoveryGenerationRead):
    object_refs: list[RecoveryObjectRef]


class RecoveryObjectUploadRead(StrictModel):
    chunk_id: str
    cipher_bytes: int
    reused: bool


class RecoveryOwnerPurgeRequest(StrictModel):
    expected_generation_ids: list[GenerationId] = Field(max_length=10_000)


class RecoveryOwnerPurgeRead(StrictModel):
    owner_ref: str
    tombstoned: bool
    deleted_generation_ids: list[str]
    remaining_generation_count: int


class RecoveryOwnerPurgeStatusRead(StrictModel):
    owner_ref: str
    tombstoned: bool

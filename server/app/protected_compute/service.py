from __future__ import annotations

import base64
import hmac
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.config import Settings
from app.protected_compute.canonical import (
    CanonicalValueError,
    canonical_json,
    canonical_sha256,
)
from app.protected_compute.private_profit import PrivateProfitFailure
from app.protected_compute.registry import CapabilityContractError, get_capability
from app.protected_compute.replay import ProtectedComputeReplayGuard
from app.protected_compute.secret_guard import SecretInputError, reject_secret_material
from app.schemas.protected_compute import ProtectedComputeRequest


@dataclass(frozen=True, slots=True)
class ProtectedComputeFailure(Exception):
    code: str
    message: str
    status_code: int


def _fail(code: str, message: str, status_code: int = 400) -> None:
    raise ProtectedComputeFailure(code, message, status_code)


def _normalized_pem(value: str) -> bytes:
    return value.replace("\\n", "\n").strip().encode("utf-8")


def load_protected_compute_private_key(settings: Settings) -> Ed25519PrivateKey | None:
    if not settings.protected_compute_signing_private_key:
        return None
    try:
        key = serialization.load_pem_private_key(
            _normalized_pem(settings.protected_compute_signing_private_key), password=None
        )
    except (TypeError, ValueError) as exc:
        raise ValueError(
            "PROTECTED_COMPUTE_SIGNING_PRIVATE_KEY must contain a valid private key"
        ) from exc
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("PROTECTED_COMPUTE_SIGNING_PRIVATE_KEY must use Ed25519")
    return key


def get_protected_compute_public_key_pem(settings: Settings) -> str | None:
    private_key = load_protected_compute_private_key(settings)
    if private_key is None:
        return None
    return (
        private_key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("utf-8")
    )


def _timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail("PROTECTED_COMPUTE_REQUEST_TIME_INVALID", "Request timestamp is invalid")
    if parsed.tzinfo is None:
        _fail("PROTECTED_COMPUTE_REQUEST_TIME_INVALID", "Request timestamp requires UTC")
    return parsed.astimezone(UTC)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _signature(private_key: Ed25519PrivateKey, payload: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(private_key.sign(canonical_json(payload))).rstrip(b"=").decode()


def execute_protected_compute(
    payload: ProtectedComputeRequest,
    *,
    settings: Settings,
    replay_guard: ProtectedComputeReplayGuard,
    redis: Any = None,
    license_offline_allowed: bool,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> dict[str, Any]:
    private_key = load_protected_compute_private_key(settings)
    if private_key is None:
        _fail(
            "PROTECTED_COMPUTE_SIGNER_UNAVAILABLE",
            "Protected-compute signing service is unavailable",
            503,
        )
    if settings.protected_compute_signing_key_id in settings.protected_compute_revoked_key_id_set:
        _fail(
            "PROTECTED_COMPUTE_SIGNING_KEY_REVOKED",
            "Protected-compute signing key is revoked",
            503,
        )
    try:
        descriptor = get_capability(payload.capability, payload.version)
    except CapabilityContractError:
        _fail(
            "PROTECTED_COMPUTE_CAPABILITY_UNSUPPORTED",
            "Protected-compute capability/version is unsupported",
            404,
        )
    capability_identity = f"{descriptor.capability}@{descriptor.version}"
    if (
        descriptor.capability in settings.protected_compute_revoked_capability_set
        or capability_identity in settings.protected_compute_revoked_capability_set
    ):
        _fail(
            "PROTECTED_COMPUTE_CAPABILITY_REVOKED",
            "Protected-compute capability is revoked",
            403,
        )
    try:
        reject_secret_material(payload.input)
        normalized_input = descriptor.normalize(payload.input)
        calculated_hash = canonical_sha256(normalized_input)
    except (SecretInputError, CapabilityContractError, CanonicalValueError):
        _fail(
            "PROTECTED_COMPUTE_INPUT_REJECTED",
            "Protected-compute input does not match the minimal public contract",
        )
    if not hmac.compare_digest(calculated_hash, payload.inputHash):
        _fail(
            "PROTECTED_COMPUTE_INPUT_HASH_MISMATCH",
            "Protected-compute input hash does not match normalized input",
        )
    current = now().astimezone(UTC)
    issued = _timestamp(payload.issuedAt)
    allowed_skew = timedelta(seconds=settings.protected_compute_request_skew_seconds)
    if issued < current - allowed_skew or issued > current + allowed_skew:
        _fail(
            "PROTECTED_COMPUTE_REQUEST_TIME_INVALID",
            "Protected-compute request is outside the accepted time window",
        )
    if not replay_guard.claim(
        payload.requestId,
        payload.nonce,
        ttl_seconds=settings.protected_compute_request_skew_seconds * 2,
        redis=redis,
    ):
        _fail(
            "PROTECTED_COMPUTE_REQUEST_REPLAYED",
            "Protected-compute request replay was rejected",
            409,
        )
    try:
        executed = (
            descriptor.execute(normalized_input, settings=settings)
            if descriptor.uses_runtime_settings
            else descriptor.execute(normalized_input)
        )
        result = descriptor.validate_result(executed)
        canonical_json(result)
    except PrivateProfitFailure as exc:
        _fail(exc.code, "Private profit calculation is unavailable", exc.status)
    except (ArithmeticError, CanonicalValueError, KeyError, TypeError, ValueError):
        _fail(
            "PROTECTED_COMPUTE_EXECUTION_FAILED",
            "Protected-compute execution failed",
            500,
        )
    result_expires = current + timedelta(seconds=settings.protected_compute_result_ttl_seconds)
    offline_allowed = (
        license_offline_allowed
        and descriptor.offline_allowed
        and settings.protected_compute_offline_seconds > 0
    )
    offline_until = (
        min(
            result_expires,
            current + timedelta(seconds=settings.protected_compute_offline_seconds),
        )
        if offline_allowed
        else None
    )
    signed_payload: dict[str, Any] = {
        "capability": descriptor.capability,
        "contract": "protected-compute-result/v1",
        "expiresAt": _iso(result_expires),
        "inputHash": calculated_hash,
        "issuedAt": _iso(current),
        "keyId": settings.protected_compute_signing_key_id,
        "nonce": payload.nonce,
        "offlinePolicy": {
            "allowed": offline_allowed,
            "maxUses": descriptor.offline_max_uses if offline_allowed else 0,
            "scope": "input-hash",
        },
        "offlineUntil": _iso(offline_until) if offline_until else None,
        "requestId": payload.requestId,
        "responseId": str(uuid4()),
        "result": result,
        "revocationEpoch": settings.protected_compute_revocation_epoch,
        "signatureAlgorithm": "Ed25519",
        "version": descriptor.version,
    }
    return {**signed_payload, "signature": _signature(private_key, signed_payload)}

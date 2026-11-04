from __future__ import annotations

from datetime import datetime
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.config import Settings


def _normalized_pem(value: str) -> bytes:
    return value.replace("\\n", "\n").strip().encode("utf-8")


def load_offline_private_key(settings: Settings) -> Ed25519PrivateKey | None:
    if not settings.offline_signing_private_key:
        return None
    key = serialization.load_pem_private_key(
        _normalized_pem(settings.offline_signing_private_key), password=None
    )
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("OFFLINE_SIGNING_PRIVATE_KEY must contain an Ed25519 private key")
    return key


def get_offline_public_key_pem(settings: Settings) -> str | None:
    private_key = load_offline_private_key(settings)
    if private_key is None:
        return None
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return public_bytes.decode("utf-8")


def create_offline_token(
    settings: Settings,
    *,
    project_code: str,
    device_code: str,
    license_id: int,
    permissions: list[str],
    device_limit: int,
    shop_limit: int,
    license_expire: datetime,
    issued_at: datetime,
    offline_until: datetime,
) -> str | None:
    private_key = load_offline_private_key(settings)
    if private_key is None:
        return None
    payload: dict[str, Any] = {
        "sub": str(license_id),
        "license_id": license_id,
        "project_code": project_code,
        "device_code": device_code,
        "permissions": permissions,
        "device_limit": device_limit,
        "shop_limit": shop_limit,
        "expire": int(license_expire.timestamp()),
        "license_expire": int(license_expire.timestamp()),
        "iat": issued_at,
        "nbf": issued_at,
        "exp": offline_until,
        "offline_until": int(offline_until.timestamp()),
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
    }
    return jwt.encode(
        payload,
        private_key,
        algorithm="EdDSA",
        headers={"kid": settings.offline_signing_key_id, "typ": "JWT"},
    )

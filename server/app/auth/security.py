from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

import jwt
from jwt import InvalidTokenError
from pwdlib import PasswordHash

from app.config import Settings

password_hasher = PasswordHash.recommended()


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return password_hasher.verify(password, password_hash)


def create_access_token(
    settings: Settings,
    *,
    user_id: int,
    token_type: Literal["user", "license"],
    license_id: int | None = None,
    project_code: str | None = None,
    device_code: str | None = None,
) -> tuple[str, int]:
    if token_type == "license" and not (license_id and project_code and device_code):
        raise ValueError("license tokens require license_id, project_code, and device_code")
    now = datetime.now(UTC)
    lifetime = (
        timedelta(hours=settings.license_token_hours)
        if token_type == "license"
        else timedelta(minutes=settings.access_token_minutes)
    )
    expires_at = now + lifetime
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "user_id": user_id,
        "type": token_type,
        "iat": now,
        "nbf": now,
        "exp": expires_at,
        "jti": uuid4().hex,
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
    }
    if license_id is not None:
        payload["license_id"] = license_id
    if project_code is not None:
        payload["project_code"] = project_code
    if device_code is not None:
        payload["device_code"] = device_code
    token = jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return token, int(lifetime.total_seconds())


def decode_access_token(settings: Settings, token: str) -> dict[str, Any]:
    try:
        return jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
            options={
                "require": ["sub", "user_id", "type", "iat", "nbf", "exp", "jti", "iss", "aud"]
            },
        )
    except InvalidTokenError as exc:
        raise ValueError("invalid or expired access token") from exc

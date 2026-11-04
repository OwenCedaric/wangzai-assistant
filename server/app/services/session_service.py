from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import AuthSession, Project, User
from app.models.base import as_utc
from app.services.errors import DomainError


def _secret(settings: Settings) -> str:
    return settings.refresh_token_secret or settings.jwt_secret_key


def _token_hash(settings: Settings, token: str) -> str:
    return hmac.new(_secret(settings).encode(), token.encode(), hashlib.sha256).hexdigest()


def _new_token(public_id: str) -> str:
    return f"rft_{public_id}.{secrets.token_urlsafe(48)}"


def create_refresh_session(
    db: Session,
    settings: Settings,
    user: User,
    project: Project,
    device_code: str,
) -> tuple[AuthSession, str, int]:
    public_id = str(uuid4())
    token = _new_token(public_id)
    now = datetime.now(UTC)
    lifetime = timedelta(days=settings.refresh_token_days)
    existing_sessions = db.scalars(
        select(AuthSession)
        .where(
            AuthSession.user_id == user.id,
            AuthSession.project_id == project.id,
            AuthSession.device_code == device_code,
            AuthSession.status == "active",
        )
        .with_for_update()
    ).all()
    for existing in existing_sessions:
        existing.status = "revoked"
        existing.revoked_at = now
    session = AuthSession(
        public_id=public_id,
        user_id=user.id,
        project_id=project.id,
        device_code=device_code,
        refresh_token_hash=_token_hash(settings, token),
        expires_at=now + lifetime,
        last_used_at=now,
        status="active",
    )
    db.add(session)
    db.flush()
    return session, token, int(lifetime.total_seconds())


def _parse_public_id(token: str) -> str:
    try:
        prefix, rest = token.split("_", 1)
        public_id, secret = rest.split(".", 1)
    except ValueError as exc:
        raise DomainError("Invalid refresh token", status_code=401) from exc
    if prefix != "rft" or len(public_id) != 36 or len(secret) < 32:
        raise DomainError("Invalid refresh token", status_code=401)
    return public_id


def rotate_refresh_session(
    db: Session,
    settings: Settings,
    token: str,
    device_code: str,
) -> tuple[AuthSession, User, Project, str, int]:
    public_id = _parse_public_id(token)
    session = db.scalar(
        select(AuthSession).where(AuthSession.public_id == public_id).with_for_update()
    )
    now = datetime.now(UTC)
    supplied_hash = _token_hash(settings, token)
    if session is None:
        raise DomainError("Invalid refresh token", status_code=401)
    if not hmac.compare_digest(session.refresh_token_hash, supplied_hash):
        session.status = "revoked"
        session.revoked_at = now
        db.commit()
        raise DomainError("Refresh token replay detected", status_code=401)
    if (
        session.status != "active"
        or session.revoked_at is not None
        or as_utc(session.expires_at) <= now
        or session.device_code != device_code
    ):
        raise DomainError("Refresh session is not active", status_code=401)
    user = db.get(User, session.user_id)
    project = db.get(Project, session.project_id)
    if user is None or user.status != "active" or project is None or project.status != "active":
        session.status = "revoked"
        session.revoked_at = now
        db.commit()
        raise DomainError("Refresh session is not active", status_code=401)
    new_token = _new_token(session.public_id)
    session.refresh_token_hash = _token_hash(settings, new_token)
    session.last_used_at = now
    remaining = max(1, int((as_utc(session.expires_at) - now).total_seconds()))
    return session, user, project, new_token, remaining


def revoke_refresh_session(db: Session, settings: Settings, token: str) -> None:
    public_id = _parse_public_id(token)
    session = db.scalar(
        select(AuthSession).where(AuthSession.public_id == public_id).with_for_update()
    )
    if session is None or not hmac.compare_digest(
        session.refresh_token_hash, _token_hash(settings, token)
    ):
        return
    if session.status == "active":
        session.status = "revoked"
        session.revoked_at = datetime.now(UTC)

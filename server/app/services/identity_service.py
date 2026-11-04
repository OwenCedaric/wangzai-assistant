from __future__ import annotations

import hashlib
import hmac
import re
from datetime import UTC, datetime

from cryptography.fernet import Fernet
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import User
from app.services.errors import DomainError

_PHONE_RE = re.compile(r"^1[3-9]\d{9}$")


def normalize_phone(value: str) -> str:
    phone = re.sub(r"[\s()-]", "", value.strip())
    if phone.startswith("+86"):
        phone = phone[3:]
    elif phone.startswith("0086"):
        phone = phone[4:]
    if not _PHONE_RE.fullmatch(phone):
        raise DomainError("A valid mainland China mobile phone is required", status_code=422)
    return phone


def mask_phone(phone: str) -> str:
    return f"{phone[:3]}****{phone[-4:]}"


def phone_hash(settings: Settings, phone: str) -> str:
    secret = settings.identity_hash_secret or settings.jwt_secret_key
    return hmac.new(secret.encode(), phone.encode(), hashlib.sha256).hexdigest()


def _phone_cipher(settings: Settings) -> Fernet | None:
    if not settings.identity_encryption_key:
        return None
    return Fernet(settings.identity_encryption_key.encode("ascii"))


def protect_phone(
    settings: Settings,
    user: User,
    raw_phone: str | None,
    *,
    verified: bool,
) -> str | None:
    if raw_phone is None:
        user.phone = None
        user.phone_hash = None
        user.phone_ciphertext = None
        user.phone_masked = None
        user.phone_verified_at = None
        return None
    phone = normalize_phone(raw_phone)
    cipher = _phone_cipher(settings)
    user.phone = None
    user.phone_hash = phone_hash(settings, phone)
    user.phone_ciphertext = (
        cipher.encrypt(phone.encode("ascii")).decode("ascii") if cipher else None
    )
    user.phone_masked = mask_phone(phone)
    user.phone_verified_at = datetime.now(UTC) if verified else None
    return phone


def find_user_by_phone(db: Session, settings: Settings, phone: str) -> User | None:
    digest = phone_hash(settings, phone)
    user = db.scalar(select(User).where(User.phone_hash == digest))
    if user is not None:
        return user
    # One-way, in-place migration path for legacy v1 rows. New phone values never
    # enter the plaintext compatibility column.
    legacy = db.scalar(select(User).where(User.phone == phone).with_for_update())
    if legacy is not None:
        protect_phone(settings, legacy, phone, verified=True)
    return legacy

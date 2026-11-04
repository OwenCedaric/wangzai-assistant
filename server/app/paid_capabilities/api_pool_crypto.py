from __future__ import annotations

import hashlib
import hmac

from cryptography.fernet import Fernet, InvalidToken

from app.config import Settings


class ApiPoolSecretError(ValueError):
    pass


def normalize_api_secret(value: str) -> str:
    secret = value.strip()
    if not 8 <= len(secret) <= 4096 or any(ord(char) < 32 for char in secret):
        raise ApiPoolSecretError("API key format is invalid")
    return secret


def _cipher(settings: Settings) -> Fernet:
    if not settings.api_pool_encryption_key:
        raise ApiPoolSecretError("API pool encryption is not configured")
    try:
        return Fernet(settings.api_pool_encryption_key.encode("ascii"))
    except (TypeError, ValueError) as exc:
        raise ApiPoolSecretError("API pool encryption is not configured") from exc


def api_secret_fingerprint(settings: Settings, secret: str) -> str:
    digest = hmac.new(
        settings.api_pool_fingerprint_secret.encode("utf-8"),
        normalize_api_secret(secret).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"sha256:{digest}"


def encrypt_api_secret(settings: Settings, secret: str) -> str:
    normalized = normalize_api_secret(secret)
    return _cipher(settings).encrypt(normalized.encode("utf-8")).decode("ascii")


def decrypt_api_secret(settings: Settings, ciphertext: str) -> str:
    try:
        return _cipher(settings).decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError, ValueError, TypeError) as exc:
        raise ApiPoolSecretError("API key cannot be decrypted") from exc


def masked_api_secret(secret: str) -> str:
    normalized = normalize_api_secret(secret)
    if len(normalized) <= 12:
        return f"••••{normalized[-4:]}"
    return f"{normalized[:4]}••••{normalized[-4:]}"

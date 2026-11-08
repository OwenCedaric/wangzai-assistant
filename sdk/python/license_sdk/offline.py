"""Verification and storage for server-signed, device-bound offline grants."""

from __future__ import annotations

import base64
import json
import os
import re
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

from .errors import ConfigurationError, OfflineCacheError, OfflineUnavailableError
from .models import LicenseStatus, parse_datetime
from .permission import PermissionSet

Clock = Callable[[], datetime]
_APP_PATH_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")
_UTC = timezone.utc
DEFAULT_OFFLINE_TOKEN_ISSUER = "license-center"
DEFAULT_OFFLINE_TOKEN_AUDIENCE = "license-center-clients"


def _utc_now() -> datetime:
    return datetime.now(_UTC)


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=_UTC)
    return value.astimezone(_UTC)


def _b64url_decode(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise OfflineCacheError("Offline token contains invalid base64url data") from exc


def _json_part(value: str, label: str) -> Mapping[str, Any]:
    try:
        parsed = json.loads(_b64url_decode(value).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OfflineCacheError(f"Offline token has an invalid {label}") from exc
    if not isinstance(parsed, Mapping):
        raise OfflineCacheError(f"Offline token {label} must be a JSON object")
    return parsed


def _claim_time(claims: Mapping[str, Any], name: str) -> datetime:
    value = parse_datetime(claims.get(name))
    if value is None:
        raise OfflineCacheError(f"Offline token is missing a valid {name} claim")
    return value


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    if not isinstance(value, (str, bytes, bytearray, int, float)):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True, slots=True)
class VerifiedOfflineGrant:
    project_code: str
    device_code: str
    issued_at: datetime
    offline_until: datetime
    expire: str | None
    permissions: PermissionSet
    shop_limit: int | None
    device_limit: int | None
    license_id: str | None

    def to_status(self) -> LicenseStatus:
        return LicenseStatus(
            valid=True,
            expire=self.expire,
            permissions=self.permissions,
            shop_limit=self.shop_limit,
            device_limit=self.device_limit,
            offline_until=self.offline_until.isoformat().replace("+00:00", "Z"),
            source="offline",
            metadata={"license_id": self.license_id} if self.license_id else {},
        )


class OfflineTokenVerifier(Protocol):
    def verify(
        self,
        token: str,
        *,
        project_code: str,
        device_code: str,
        now: datetime,
        max_offline: timedelta,
    ) -> VerifiedOfflineGrant: ...


class Ed25519OfflineTokenVerifier:
    """Verify compact-JWS offline grants signed by License Center (alg=EdDSA)."""

    def __init__(
        self,
        public_keys: str | bytes | Mapping[str, str | bytes],
        *,
        issuer: str = DEFAULT_OFFLINE_TOKEN_ISSUER,
        audience: str = DEFAULT_OFFLINE_TOKEN_AUDIENCE,
    ) -> None:
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        except ImportError as exc:  # pragma: no cover - dependency declared by the package
            raise ConfigurationError(
                "cryptography is required for Ed25519 offline verification"
            ) from exc

        source = public_keys if isinstance(public_keys, Mapping) else {"": public_keys}
        if not source:
            raise ConfigurationError("At least one offline public key is required")
        self._issuer = self._validate_expected_claim(issuer, "issuer")
        self._audience = self._validate_expected_claim(audience, "audience")
        loaded: dict[str, Any] = {}
        for kid, key_data in source.items():
            raw = key_data.encode("utf-8") if isinstance(key_data, str) else key_data
            try:
                key = serialization.load_pem_public_key(raw)
            except (TypeError, ValueError) as exc:
                raise ConfigurationError(f"Invalid offline public key for kid={kid!r}") from exc
            if not isinstance(key, Ed25519PublicKey):
                raise ConfigurationError("Offline public keys must be Ed25519 keys")
            loaded[str(kid)] = key
        self._keys = loaded

    @staticmethod
    def _validate_expected_claim(value: str, label: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ConfigurationError(f"Offline token {label} must not be empty")
        return value.strip()

    def verify(
        self,
        token: str,
        *,
        project_code: str,
        device_code: str,
        now: datetime,
        max_offline: timedelta,
    ) -> VerifiedOfflineGrant:
        parts = token.split(".")
        if len(parts) != 3:
            raise OfflineCacheError("Offline token must use compact JWS format")
        encoded_header, encoded_claims, encoded_signature = parts
        header = _json_part(encoded_header, "header")
        if header.get("alg") != "EdDSA":
            raise OfflineCacheError("Offline token must use alg=EdDSA")
        kid = str(header.get("kid") or "")
        key = self._keys.get(kid)
        if key is None and len(self._keys) == 1 and "" in self._keys:
            key = self._keys[""]
        if key is None:
            raise OfflineCacheError(f"No pinned offline public key for kid={kid!r}")
        signing_input = f"{encoded_header}.{encoded_claims}".encode("ascii")
        try:
            key.verify(_b64url_decode(encoded_signature), signing_input)
        except Exception as exc:  # cryptography exposes InvalidSignature; keep it out of public API
            raise OfflineCacheError("Offline token signature verification failed") from exc

        claims = _json_part(encoded_claims, "claims")
        if claims.get("iss") != self._issuer:
            raise OfflineCacheError("Offline token issuer does not match the configured issuer")
        if claims.get("aud") != self._audience:
            raise OfflineCacheError("Offline token audience does not match the configured audience")
        claim_project = str(claims.get("project_code") or "")
        claim_device = str(claims.get("device_code") or "")
        if claim_project != project_code or claim_device != device_code:
            raise OfflineCacheError("Offline token is not bound to this project and device")

        current = _aware_utc(now)
        issued_at = _claim_time(claims, "iat")
        expires_at = _claim_time(claims, "exp")
        server_offline_until = _claim_time(claims, "offline_until")
        if issued_at - current > timedelta(minutes=5):
            raise OfflineCacheError("System clock is earlier than the offline grant issue time")
        not_before = parse_datetime(claims.get("nbf"))
        if not_before is not None and not_before - current > timedelta(minutes=5):
            raise OfflineUnavailableError("The server-signed offline grant is not active yet")
        deadline = min(expires_at, server_offline_until, issued_at + max_offline)
        license_expire = claims.get("expire") or claims.get("license_expire")
        parsed_license_expire = parse_datetime(license_expire, date_at_end_of_day=True)
        if parsed_license_expire is not None:
            deadline = min(deadline, parsed_license_expire)
        if current > deadline:
            raise OfflineUnavailableError("The server-signed offline grant has expired")

        raw_permissions = claims.get("permissions") or ()
        if isinstance(raw_permissions, (str, bytes)) or not hasattr(raw_permissions, "__iter__"):
            raise OfflineCacheError("Offline token permissions claim must be a list")
        license_id = claims.get("license_id")
        return VerifiedOfflineGrant(
            project_code=claim_project,
            device_code=claim_device,
            issued_at=issued_at,
            offline_until=deadline,
            expire=str(license_expire) if license_expire is not None else expires_at.isoformat(),
            permissions=PermissionSet(raw_permissions),
            shop_limit=_optional_int(claims.get("shop_limit")),
            device_limit=_optional_int(claims.get("device_limit")),
            license_id=str(license_id) if license_id is not None else None,
        )


def default_cache_directory(app: str) -> Path:
    safe_app = _APP_PATH_PATTERN.sub("_", app).strip("._") or "application"
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif platform_name() == "darwin":
        root = Path.home() / "Library" / "Application Support"
    else:
        root = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return root / "LicenseCenter" / safe_app


def platform_name() -> str:
    # Kept tiny and patchable for tests.
    import sys

    return sys.platform


class OfflineGrantCache:
    """Atomically store a JWS; all trusted fields are re-verified on every read."""

    def __init__(
        self,
        *,
        project_code: str,
        device_code: str,
        verifier: OfflineTokenVerifier | None,
        cache_directory: str | os.PathLike[str] | None = None,
        max_offline_hours: float = 72,
        clock: Clock = _utc_now,
    ) -> None:
        if not 0 < max_offline_hours <= 72:
            raise ConfigurationError("max_offline_hours must be greater than 0 and no more than 72")
        self.project_code = project_code
        self.device_code = device_code
        self._verifier = verifier
        self._directory = (
            Path(cache_directory) if cache_directory else default_cache_directory(project_code)
        )
        self._path = self._directory / "offline-grant.json"
        self._max_offline = timedelta(hours=max_offline_hours)
        self._clock = clock

    @property
    def path(self) -> Path:
        return self._path

    @property
    def enabled(self) -> bool:
        return self._verifier is not None

    def set_verifier(self, verifier: OfflineTokenVerifier) -> None:
        self._verifier = verifier

    def store(self, token: str) -> VerifiedOfflineGrant:
        grant = self._verify(token)
        self._directory.mkdir(parents=True, exist_ok=True)
        envelope = {"version": 1, "offline_token": token}
        data = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        temp_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(dir=self._directory, delete=False) as temp:
                temp_name = temp.name
                temp.write(data)
                temp.flush()
                os.fsync(temp.fileno())
            os.chmod(temp_name, 0o600)
            os.replace(temp_name, self._path)
            os.chmod(self._path, 0o600)
        finally:
            if temp_name and os.path.exists(temp_name):
                os.unlink(temp_name)
        return grant

    def load(self) -> VerifiedOfflineGrant | None:
        if not self._path.exists():
            return None
        if self._verifier is None:
            raise OfflineUnavailableError("Offline verification public key is not configured")
        try:
            envelope = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise OfflineCacheError("Offline grant cache is unreadable") from exc
        if not isinstance(envelope, Mapping) or envelope.get("version") != 1:
            raise OfflineCacheError("Offline grant cache format is unsupported")
        token = envelope.get("offline_token")
        if not isinstance(token, str) or not token:
            raise OfflineCacheError("Offline grant cache does not contain a token")
        return self._verify(token)

    def clear(self) -> None:
        try:
            self._path.unlink()
        except FileNotFoundError:
            pass

    def _verify(self, token: str) -> VerifiedOfflineGrant:
        if self._verifier is None:
            raise OfflineUnavailableError("Offline verification public key is not configured")
        return self._verifier.verify(
            token,
            project_code=self.project_code,
            device_code=self.device_code,
            now=_aware_utc(self._clock()),
            max_offline=self._max_offline,
        )

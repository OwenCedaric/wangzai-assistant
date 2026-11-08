"""Value objects exposed by the License Center SDK."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from .errors import PermissionDeniedError, ResponseFormatError
from .permission import PermissionSet

_SENSITIVE_KEYS = {
    "access_token",
    "refresh_token",
    "password",
    "token",
    "license_key",
    "card_key",
    "offline_token",
}
_UTC = timezone.utc


def unwrap_response(data: Mapping[str, Any]) -> dict[str, Any]:
    """Unwrap the optional ``data`` envelope used by some deployments."""
    nested = data.get("data")
    if isinstance(nested, Mapping):
        return dict(nested)
    return dict(data)


def sanitized_metadata(data: Mapping[str, Any]) -> dict[str, Any]:
    """Return a shallow allow-list of non-secret diagnostic fields."""
    allowed = {
        "reason",
        "server_time",
        "license_id",
        "plan_id",
        "plan_name",
        "project_code",
        "user_id",
    }
    return {key: data[key] for key in allowed if key in data and key not in _SENSITIVE_KEYS}


def parse_datetime(value: object, *, date_at_end_of_day: bool = False) -> datetime | None:
    """Parse API ISO-8601 or Unix timestamps into an aware UTC datetime."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, tz=_UTC)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        if len(text) == 10 and text[4] == "-" and text[7] == "-":
            parsed = datetime.fromisoformat(text).replace(tzinfo=_UTC)
            if date_at_end_of_day:
                parsed += timedelta(days=1, microseconds=-1)
            return parsed
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_UTC)
    return parsed.astimezone(_UTC)


def _as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "valid", "active", "yes"}
    return False


def _as_optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    if not isinstance(value, (str, bytes, bytearray, int, float)):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True, slots=True)
class AuthSession:
    """An in-memory authentication result. The token is redacted from ``repr``."""

    access_token: str = field(repr=False)
    token_type: str = "bearer"
    expires_at: datetime | None = None
    user: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_response(cls, response: Mapping[str, Any]) -> AuthSession:
        payload = unwrap_response(response)
        token = payload.get("access_token")
        if not isinstance(token, str) or not token.strip():
            raise ResponseFormatError("Login response did not contain access_token")
        expires_at = parse_datetime(payload.get("expires_at"))
        if expires_at is None and isinstance(payload.get("expires_in"), (int, float)):
            expires_at = datetime.now(_UTC) + timedelta(seconds=float(payload["expires_in"]))
        user = payload.get("user")
        return cls(
            access_token=token.strip(),
            token_type=str(payload.get("token_type") or "bearer"),
            expires_at=expires_at,
            user=dict(user) if isinstance(user, Mapping) else {},
        )


@dataclass(frozen=True, slots=True)
class LicenseStatus:
    """The current entitlement returned by an online check or offline grant."""

    valid: bool
    expire: str | None
    permissions: PermissionSet
    shop_limit: int | None = None
    device_limit: int | None = None
    offline_until: str | None = None
    reason: str | None = None
    source: str = "online"
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_response(
        cls,
        response: Mapping[str, Any],
        *,
        source: str = "online",
    ) -> LicenseStatus:
        payload = unwrap_response(response)
        license_data = payload.get("license")
        if isinstance(license_data, Mapping):
            merged = dict(license_data)
            merged.update(payload)
            payload = merged
        permissions = payload.get("permissions") or ()
        if isinstance(permissions, (str, bytes)) or not hasattr(permissions, "__iter__"):
            permissions = ()
        expire_value = (
            payload.get("expire") or payload.get("expire_time") or payload.get("expires_at")
        )
        offline_value = payload.get("offline_until")
        return cls(
            valid=_as_bool(payload.get("valid", payload.get("status"))),
            expire=str(expire_value) if expire_value is not None else None,
            permissions=PermissionSet(permissions),
            shop_limit=_as_optional_int(payload.get("shop_limit")),
            device_limit=_as_optional_int(payload.get("device_limit")),
            offline_until=str(offline_value) if offline_value is not None else None,
            reason=str(payload["reason"]) if payload.get("reason") is not None else None,
            source=source,
            metadata=sanitized_metadata(payload),
        )

    def has_permission(self, permission: str) -> bool:
        return self.valid and self.permissions.has(permission)

    def require_permission(self, permission: str) -> None:
        if not self.valid:
            raise PermissionDeniedError(permission)
        self.permissions.require(permission)

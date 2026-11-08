"""Public exception hierarchy for the License Center SDK."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class LicenseSDKError(Exception):
    """Base class for all expected SDK failures."""


class ConfigurationError(LicenseSDKError, ValueError):
    """Raised when the SDK is configured unsafely or incompletely."""


class TransportError(LicenseSDKError):
    """Raised when License Center cannot be reached or decoded."""


@dataclass(slots=True)
class APIError(LicenseSDKError):
    """A non-success response returned by License Center."""

    status_code: int
    message: str
    error_code: str | None = None
    details: Any = None

    def __str__(self) -> str:
        suffix = f" ({self.error_code})" if self.error_code else ""
        return f"License Center API {self.status_code}{suffix}: {self.message}"


class AuthenticationError(APIError):
    """Authentication or authorization was rejected by the server."""


class ResponseFormatError(TransportError):
    """The server returned a response that does not match the API contract."""


class OperationTimeoutError(LicenseSDKError, TimeoutError):
    """A multi-request SDK operation did not finish before its deadline."""


class OrderStateError(LicenseSDKError):
    """An order reached a state that cannot produce an activation code."""

    def __init__(self, order_id: int, status: str) -> None:
        self.order_id = order_id
        self.status = status
        super().__init__(f"Order {order_id} cannot be fulfilled from state: {status}")


class PermissionDeniedError(LicenseSDKError):
    """The current entitlement does not contain a required permission."""

    def __init__(self, permission: str) -> None:
        self.permission = permission
        super().__init__(f"Required permission is not granted: {permission}")


class OfflineCacheError(LicenseSDKError):
    """The cached offline grant is invalid, corrupt, or unverifiable."""


class OfflineUnavailableError(LicenseSDKError):
    """No currently valid, server-signed offline grant is available."""

"""License Center Python SDK public API."""

from .client import License
from .commerce_models import (
    Attribution,
    Fulfillment,
    Order,
    PageResult,
    PaymentCheckout,
    PaymentCompletion,
    PhoneAuthSession,
    PurchaseActivation,
    RefreshSession,
    SmsChallenge,
    StorePlan,
)
from .device import DeviceIdentity, generate_device_code
from .errors import (
    APIError,
    AuthenticationError,
    ConfigurationError,
    LicenseSDKError,
    OfflineCacheError,
    OfflineUnavailableError,
    OperationTimeoutError,
    OrderStateError,
    PermissionDeniedError,
    ResponseFormatError,
    TransportError,
)
from .heartbeat import DEFAULT_HEARTBEAT_INTERVAL_SECONDS, HeartbeatRunner
from .models import AuthSession, LicenseStatus
from .offline import (
    DEFAULT_OFFLINE_TOKEN_AUDIENCE,
    DEFAULT_OFFLINE_TOKEN_ISSUER,
    Ed25519OfflineTokenVerifier,
    OfflineTokenVerifier,
    VerifiedOfflineGrant,
)
from .permission import PermissionSet

__version__ = "1.1.0"

__all__ = [
    "APIError",
    "AuthSession",
    "AuthenticationError",
    "Attribution",
    "ConfigurationError",
    "DEFAULT_HEARTBEAT_INTERVAL_SECONDS",
    "DEFAULT_OFFLINE_TOKEN_AUDIENCE",
    "DEFAULT_OFFLINE_TOKEN_ISSUER",
    "DeviceIdentity",
    "Ed25519OfflineTokenVerifier",
    "HeartbeatRunner",
    "Fulfillment",
    "License",
    "LicenseSDKError",
    "LicenseStatus",
    "OfflineCacheError",
    "OfflineTokenVerifier",
    "OfflineUnavailableError",
    "OperationTimeoutError",
    "Order",
    "OrderStateError",
    "PageResult",
    "PaymentCheckout",
    "PaymentCompletion",
    "PermissionDeniedError",
    "PermissionSet",
    "PhoneAuthSession",
    "PurchaseActivation",
    "RefreshSession",
    "ResponseFormatError",
    "TransportError",
    "VerifiedOfflineGrant",
    "SmsChallenge",
    "StorePlan",
    "generate_device_code",
]

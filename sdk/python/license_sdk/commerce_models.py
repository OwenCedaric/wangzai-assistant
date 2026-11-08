"""Typed value objects for phone authentication and online purchases."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Generic, TypeVar

from .errors import ResponseFormatError
from .models import LicenseStatus, parse_datetime, unwrap_response

_UTC = timezone.utc
T = TypeVar("T")


def _required_str(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ResponseFormatError(f"Response did not contain a valid {key}")
    return value.strip()


def _optional_str(payload: Mapping[str, Any], key: str) -> str | None:
    value = payload.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _required_int(payload: Mapping[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ResponseFormatError(f"Response did not contain a valid {key}")
    return value


def _optional_int(payload: Mapping[str, Any], key: str) -> int | None:
    value = payload.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ResponseFormatError(f"Response did not contain a valid {key}")
    return value


def _required_datetime(payload: Mapping[str, Any], key: str) -> datetime:
    value = parse_datetime(payload.get(key))
    if value is None:
        raise ResponseFormatError(f"Response did not contain a valid {key}")
    return value


def _optional_datetime(payload: Mapping[str, Any], key: str) -> datetime | None:
    raw = payload.get(key)
    if raw is None:
        return None
    value = parse_datetime(raw)
    if value is None:
        raise ResponseFormatError(f"Response did not contain a valid {key}")
    return value


def _string_list(payload: Mapping[str, Any], key: str) -> tuple[str, ...]:
    value = payload.get(key)
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ResponseFormatError(f"Response did not contain a valid {key}")
    return tuple(item for item in value if item)


@dataclass(frozen=True, slots=True)
class SmsChallenge:
    sent: bool
    expires_in: int
    retry_after: int
    phone_masked: str
    development_code: str | None = field(default=None, repr=False)

    @classmethod
    def from_response(cls, response: Mapping[str, Any]) -> SmsChallenge:
        payload = unwrap_response(response)
        sent = payload.get("sent", True)
        if not isinstance(sent, bool):
            raise ResponseFormatError("Response did not contain a valid sent flag")
        return cls(
            sent=sent,
            expires_in=_required_int(payload, "expires_in"),
            retry_after=_required_int(payload, "retry_after"),
            phone_masked=_required_str(payload, "phone_masked"),
            development_code=_optional_str(payload, "development_code"),
        )


@dataclass(frozen=True, slots=True)
class Attribution:
    project_id: int
    project_code: str
    agent_id: int | None
    channel_id: int | None
    source_type: str
    locked_at: datetime

    @classmethod
    def from_mapping(cls, payload: Mapping[str, Any]) -> Attribution:
        return cls(
            project_id=_required_int(payload, "project_id"),
            project_code=_required_str(payload, "project_code"),
            agent_id=_optional_int(payload, "agent_id"),
            channel_id=_optional_int(payload, "channel_id"),
            source_type=_required_str(payload, "source_type"),
            locked_at=_required_datetime(payload, "locked_at"),
        )


@dataclass(frozen=True, slots=True)
class PhoneAuthSession:
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    token_type: str
    expires_in: int
    refresh_expires_in: int
    expires_at: datetime
    refresh_expires_at: datetime
    user: Mapping[str, Any] = field(repr=False)
    attribution: Attribution
    project_code: str
    license_status: str

    @classmethod
    def from_response(cls, response: Mapping[str, Any]) -> PhoneAuthSession:
        payload = unwrap_response(response)
        user = payload.get("user")
        attribution = payload.get("attribution")
        if not isinstance(user, Mapping) or not isinstance(attribution, Mapping):
            raise ResponseFormatError("Phone verification response is missing identity data")
        expires_in = _required_int(payload, "expires_in")
        refresh_expires_in = _required_int(payload, "refresh_expires_in")
        now = datetime.now(_UTC)
        return cls(
            access_token=_required_str(payload, "access_token"),
            refresh_token=_required_str(payload, "refresh_token"),
            token_type=str(payload.get("token_type") or "bearer"),
            expires_in=expires_in,
            refresh_expires_in=refresh_expires_in,
            expires_at=now + timedelta(seconds=expires_in),
            refresh_expires_at=now + timedelta(seconds=refresh_expires_in),
            user=dict(user),
            attribution=Attribution.from_mapping(attribution),
            project_code=_required_str(payload, "project_code"),
            license_status=_required_str(payload, "license_status"),
        )


@dataclass(frozen=True, slots=True)
class RefreshSession:
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    token_type: str
    expires_in: int
    refresh_expires_in: int
    expires_at: datetime
    refresh_expires_at: datetime

    @classmethod
    def from_response(cls, response: Mapping[str, Any]) -> RefreshSession:
        payload = unwrap_response(response)
        now = datetime.now(_UTC)
        expires_in = _required_int(payload, "expires_in")
        refresh_expires_in = _required_int(payload, "refresh_expires_in")
        return cls(
            access_token=_required_str(payload, "access_token"),
            refresh_token=_required_str(payload, "refresh_token"),
            token_type=str(payload.get("token_type") or "bearer"),
            expires_in=expires_in,
            refresh_expires_in=refresh_expires_in,
            expires_at=now + timedelta(seconds=expires_in),
            refresh_expires_at=now + timedelta(seconds=refresh_expires_in),
        )


@dataclass(frozen=True, slots=True)
class PageResult(Generic[T]):
    items: tuple[T, ...]
    total: int
    page: int
    page_size: int


@dataclass(frozen=True, slots=True)
class StorePlan:
    id: int
    project_id: int
    project_code: str
    product_id: int
    product_name: str
    name: str
    sale_price_cent: int
    currency: str
    duration_days: int
    max_devices: int
    max_shops: int
    offline_hours: int
    permission_codes: tuple[str, ...]
    payment_providers: tuple[str, ...]

    @classmethod
    def from_mapping(cls, payload: Mapping[str, Any]) -> StorePlan:
        return cls(
            id=_required_int(payload, "id"),
            project_id=_required_int(payload, "project_id"),
            project_code=_required_str(payload, "project_code"),
            product_id=_required_int(payload, "product_id"),
            product_name=_required_str(payload, "product_name"),
            name=_required_str(payload, "name"),
            sale_price_cent=_required_int(payload, "sale_price_cent"),
            currency=_required_str(payload, "currency"),
            duration_days=_required_int(payload, "duration_days"),
            max_devices=_required_int(payload, "max_devices"),
            max_shops=_required_int(payload, "max_shops"),
            offline_hours=_required_int(payload, "offline_hours"),
            permission_codes=_string_list(payload, "permission_codes"),
            payment_providers=_string_list(payload, "payment_providers"),
        )


@dataclass(frozen=True, slots=True)
class Fulfillment:
    status: str
    activation_code: str | None = field(repr=False)
    activation_code_prefix: str | None
    fulfilled_at: datetime | None

    @classmethod
    def from_mapping(cls, payload: Mapping[str, Any]) -> Fulfillment:
        return cls(
            status=_required_str(payload, "status"),
            activation_code=_optional_str(payload, "activation_code"),
            activation_code_prefix=_optional_str(payload, "activation_code_prefix"),
            fulfilled_at=_optional_datetime(payload, "fulfilled_at"),
        )


@dataclass(frozen=True, slots=True)
class Order:
    id: int
    order_no: str
    user_id: int | None
    project_id: int | None
    project_code: str
    plan_id: int | None
    agent_id: int | None
    channel_id: int | None
    plan_name_snapshot: str
    amount_cent: int
    currency: str
    commission_rate_bps: int | None
    commission_amount_cent: int | None
    status: str
    provider: str | None
    payment_provider: str | None
    provider_payment_no: str | None
    expires_at: datetime
    activation_code: str | None = field(repr=False)
    fulfillment: Fulfillment | None
    paid_at: datetime | None
    fulfilled_at: datetime | None
    refunded_at: datetime | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_response(cls, response: Mapping[str, Any]) -> Order:
        payload = unwrap_response(response)
        raw_fulfillment = payload.get("fulfillment")
        if raw_fulfillment is not None and not isinstance(raw_fulfillment, Mapping):
            raise ResponseFormatError("Response did not contain a valid fulfillment")
        return cls(
            id=_required_int(payload, "id"),
            order_no=_required_str(payload, "order_no"),
            user_id=_optional_int(payload, "user_id"),
            project_id=_optional_int(payload, "project_id"),
            project_code=_required_str(payload, "project_code"),
            plan_id=_optional_int(payload, "plan_id"),
            agent_id=_optional_int(payload, "agent_id"),
            channel_id=_optional_int(payload, "channel_id"),
            plan_name_snapshot=_required_str(payload, "plan_name_snapshot"),
            amount_cent=_required_int(payload, "amount_cent"),
            currency=_required_str(payload, "currency"),
            commission_rate_bps=_optional_int(payload, "commission_rate_bps"),
            commission_amount_cent=_optional_int(payload, "commission_amount_cent"),
            status=_required_str(payload, "status"),
            provider=_optional_str(payload, "provider")
            or _optional_str(payload, "payment_provider"),
            payment_provider=_optional_str(payload, "payment_provider"),
            provider_payment_no=_optional_str(payload, "provider_payment_no"),
            expires_at=_required_datetime(payload, "expires_at"),
            activation_code=_optional_str(payload, "activation_code"),
            fulfillment=(
                Fulfillment.from_mapping(raw_fulfillment) if raw_fulfillment is not None else None
            ),
            paid_at=_optional_datetime(payload, "paid_at"),
            fulfilled_at=_optional_datetime(payload, "fulfilled_at"),
            refunded_at=_optional_datetime(payload, "refunded_at"),
            created_at=_required_datetime(payload, "created_at"),
            updated_at=_required_datetime(payload, "updated_at"),
        )

    @property
    def fulfillment_code(self) -> str | None:
        nested_code = self.fulfillment.activation_code if self.fulfillment else None
        return self.activation_code or nested_code

    @property
    def plan_name(self) -> str:
        """Convenience alias for the immutable order-time plan snapshot."""
        return self.plan_name_snapshot


@dataclass(frozen=True, slots=True)
class PaymentCheckout:
    order_id: int
    payment_id: int
    order_no: str
    status: str
    provider: str
    amount_cent: int
    currency: str
    code_url: str | None = field(repr=False)
    qr_code_url: str | None = field(repr=False)
    expires_at: datetime

    @classmethod
    def from_response(cls, response: Mapping[str, Any]) -> PaymentCheckout:
        payload = unwrap_response(response)
        return cls(
            order_id=_required_int(payload, "id"),
            payment_id=_required_int(payload, "payment_id"),
            order_no=_required_str(payload, "order_no"),
            status=_required_str(payload, "status"),
            provider=_required_str(payload, "provider"),
            amount_cent=_required_int(payload, "amount_cent"),
            currency=_required_str(payload, "currency"),
            code_url=_optional_str(payload, "code_url"),
            qr_code_url=_optional_str(payload, "qr_code_url"),
            expires_at=_required_datetime(payload, "expires_at"),
        )


@dataclass(frozen=True, slots=True)
class PaymentCompletion:
    order_no: str
    status: str
    idempotent: bool
    activation_code: str | None = field(repr=False)
    fulfillment: Fulfillment | None

    @classmethod
    def from_response(cls, response: Mapping[str, Any]) -> PaymentCompletion:
        payload = unwrap_response(response)
        idempotent = payload.get("idempotent")
        raw_fulfillment = payload.get("fulfillment")
        if not isinstance(idempotent, bool):
            raise ResponseFormatError("Response did not contain a valid idempotent flag")
        if raw_fulfillment is not None and not isinstance(raw_fulfillment, Mapping):
            raise ResponseFormatError("Response did not contain a valid fulfillment")
        return cls(
            order_no=_required_str(payload, "order_no"),
            status=_required_str(payload, "status"),
            idempotent=idempotent,
            activation_code=_optional_str(payload, "activation_code"),
            fulfillment=(
                Fulfillment.from_mapping(raw_fulfillment) if raw_fulfillment is not None else None
            ),
        )

    @property
    def fulfillment_code(self) -> str | None:
        nested_code = self.fulfillment.activation_code if self.fulfillment else None
        return self.activation_code or nested_code


@dataclass(frozen=True, slots=True)
class PurchaseActivation:
    """A fulfilled order and the entitlement created from its bound card."""

    order: Order
    license_status: LicenseStatus

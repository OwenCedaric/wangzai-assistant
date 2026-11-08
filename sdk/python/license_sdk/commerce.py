"""Stateless HTTP operations for phone authentication and online commerce."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urlencode

from .commerce_models import (
    Order,
    PageResult,
    PaymentCheckout,
    PaymentCompletion,
    PhoneAuthSession,
    RefreshSession,
    SmsChallenge,
    StorePlan,
)
from .errors import ConfigurationError, ResponseFormatError
from .models import unwrap_response
from .transport import Transport


def _authorization_header(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


def _positive(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _clean_required(value: str, name: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ConfigurationError(f"{name} must not be empty")
    return cleaned


class CommerceClient:
    """Maps the v1.1 public API without retaining credentials or tokens."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def send_sms(self, phone: str, client_payload: Mapping[str, Any]) -> SmsChallenge:
        payload = dict(client_payload)
        payload.update(phone=_clean_required(phone, "phone"), scene="login_or_register")
        response = self._transport.request("POST", "/api/auth/sms/send", json_body=payload)
        return SmsChallenge.from_response(response)

    def verify_sms(
        self,
        phone: str,
        code: str,
        client_payload: Mapping[str, Any],
    ) -> PhoneAuthSession:
        payload = dict(client_payload)
        payload.update(
            phone=_clean_required(phone, "phone"),
            code=_clean_required(code, "code"),
            scene="login_or_register",
        )
        response = self._transport.request("POST", "/api/auth/sms/verify", json_body=payload)
        return PhoneAuthSession.from_response(response)

    def refresh(self, refresh_token: str, device_code: str) -> RefreshSession:
        response = self._transport.request(
            "POST",
            "/api/auth/refresh",
            json_body={
                "refresh_token": _clean_required(refresh_token, "refresh_token"),
                "device_code": _clean_required(device_code, "device_code"),
            },
        )
        return RefreshSession.from_response(response)

    def logout(self, refresh_token: str) -> None:
        self._transport.request(
            "POST",
            "/api/auth/logout",
            json_body={"refresh_token": _clean_required(refresh_token, "refresh_token")},
        )

    def list_plans(self, project_code: str, *, page: int, page_size: int) -> PageResult[StorePlan]:
        _positive(page, "page")
        _positive(page_size, "page_size")
        query = urlencode(
            {
                "project_code": _clean_required(project_code, "project_code"),
                "page": page,
                "page_size": page_size,
            }
        )
        payload = unwrap_response(self._transport.request("GET", f"/api/store/plans?{query}"))
        raw_items = payload.get("items")
        if not isinstance(raw_items, list) or any(
            not isinstance(item, Mapping) for item in raw_items
        ):
            raise ResponseFormatError("Store response did not contain a valid items list")
        total = payload.get("total")
        response_page = payload.get("page")
        response_page_size = payload.get("page_size")
        if isinstance(total, bool) or not isinstance(total, int):
            raise ResponseFormatError("Store response did not contain valid pagination")
        if isinstance(response_page, bool) or not isinstance(response_page, int):
            raise ResponseFormatError("Store response did not contain valid pagination")
        if isinstance(response_page_size, bool) or not isinstance(response_page_size, int):
            raise ResponseFormatError("Store response did not contain valid pagination")
        return PageResult(
            items=tuple(StorePlan.from_mapping(item) for item in raw_items),
            total=total,
            page=response_page,
            page_size=response_page_size,
        )

    def create_order(
        self,
        access_token: str,
        project_code: str,
        plan_id: int,
        idempotency_key: str | None,
    ) -> Order:
        payload: dict[str, Any] = {
            "project_code": _clean_required(project_code, "project_code"),
            "plan_id": _positive(plan_id, "plan_id"),
        }
        if idempotency_key is not None:
            payload["idempotency_key"] = _clean_required(idempotency_key, "idempotency_key")
        response = self._transport.request(
            "POST",
            "/api/orders",
            json_body=payload,
            headers=_authorization_header(access_token),
        )
        return Order.from_response(response)

    def get_order(self, access_token: str, order_id: int) -> Order:
        response = self._transport.request(
            "GET",
            f"/api/orders/{_positive(order_id, 'order_id')}",
            headers=_authorization_header(access_token),
        )
        return Order.from_response(response)

    def query_order_payment(self, access_token: str, order_id: int) -> Order:
        response = self._transport.request(
            "POST",
            f"/api/orders/{_positive(order_id, 'order_id')}/query",
            json_body={},
            headers=_authorization_header(access_token),
        )
        return Order.from_response(response)

    def start_payment(
        self,
        access_token: str,
        order_id: int,
        provider: str | None,
    ) -> PaymentCheckout:
        payload: dict[str, Any] = {}
        if provider is not None:
            payload["provider"] = _clean_required(provider, "provider")
        response = self._transport.request(
            "POST",
            f"/api/orders/{_positive(order_id, 'order_id')}/pay",
            json_body=payload,
            headers=_authorization_header(access_token),
        )
        return PaymentCheckout.from_response(response)

    def complete_development_payment(
        self,
        access_token: str,
        order_no: str,
        event_id: str | None,
    ) -> PaymentCompletion:
        payload: dict[str, Any] = {}
        if event_id is not None:
            payload["event_id"] = _clean_required(event_id, "event_id")
        clean_order_no = _clean_required(order_no, "order_no")
        allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
        if any(character not in allowed for character in clean_order_no.upper()):
            raise ConfigurationError("order_no contains unsupported characters")
        response = self._transport.request(
            "POST",
            f"/api/payments/development/{clean_order_no}/complete",
            json_body=payload,
            headers=_authorization_header(access_token),
        )
        return PaymentCompletion.from_response(response)

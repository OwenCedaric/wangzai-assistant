from __future__ import annotations

import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeTransport

from license_sdk import (
    AuthenticationError,
    ConfigurationError,
    License,
    OrderStateError,
    ResponseFormatError,
    TransportError,
)

DEVICE_CODE = "DEV-TEST-12345678"


class BlockingRefreshTransport:
    def __init__(self, outcome: Mapping[str, Any] | BaseException) -> None:
        self.outcome = outcome
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Mapping[str, Any]:
        with self._lock:
            self.calls.append(
                {
                    "method": method,
                    "path": path,
                    "json_body": dict(json_body or {}),
                    "headers": dict(headers or {}),
                }
            )
        self.started.set()
        assert self.release.wait(timeout=3)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


def make_client(tmp_path: Path, transport: Any, **kwargs) -> License:
    return License(
        app="sample_app",
        version="1.2.3",
        version_hash="sha256:client",
        device_code=DEVICE_CODE,
        device_name="Test machine",
        cache_directory=tmp_path,
        transport=transport,
        **kwargs,
    )


def phone_session_response(
    access_token: str = "phone-access-token",
    refresh_token: str = "r" * 64,
) -> dict:
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "expires_in": 900,
        "refresh_expires_in": 2_592_000,
        "user": {"id": 7, "username": "u_masked", "phone_masked": "138****0000"},
        "attribution": {
            "project_id": 3,
            "project_code": "sample_app",
            "agent_id": 9,
            "channel_id": 11,
            "source_type": "channel",
            "locked_at": "2026-07-11T08:00:00Z",
        },
        "project_code": "sample_app",
        "license_status": "needs_activation",
    }


def order_response(
    *,
    status: str = "pending",
    activation_code: str | None = None,
) -> dict:
    fulfilled = status == "fulfilled"
    return {
        "id": 41,
        "order_no": "LC202607110001",
        "user_id": 7,
        "project_id": 3,
        "project_code": "sample_app",
        "plan_id": 5,
        "agent_id": 9,
        "channel_id": 11,
        "plan_name_snapshot": "专业版",
        "amount_cent": 29_900,
        "currency": "CNY",
        "commission_rate_bps": 2_000,
        "commission_amount_cent": 5_980,
        "status": status,
        "provider": "development" if status != "pending" else None,
        "payment_provider": "development" if status != "pending" else None,
        "provider_payment_no": None,
        "expires_at": "2026-07-11T09:00:00Z",
        "paid_at": "2026-07-11T08:05:00Z" if fulfilled else None,
        "fulfilled_at": "2026-07-11T08:05:01Z" if fulfilled else None,
        "refunded_at": None,
        "activation_code": activation_code,
        "fulfillment": (
            {
                "status": "fulfilled",
                "activation_code": activation_code,
                "activation_code_prefix": "AAAA",
                "fulfilled_at": "2026-07-11T08:05:01Z",
            }
            if fulfilled
            else None
        ),
        "created_at": "2026-07-11T08:00:00Z",
        "updated_at": "2026-07-11T08:05:01Z",
    }


def test_sms_registration_carries_distribution_and_rotates_refresh_token(tmp_path: Path) -> None:
    first_refresh = "a" * 64
    second_refresh = "b" * 64
    transport = FakeTransport(
        {
            "sent": True,
            "expires_in": 300,
            "retry_after": 60,
            "phone_masked": "138****0000",
            "development_code": "123456",
        },
        phone_session_response(refresh_token=first_refresh),
        {
            "access_token": "rotated-access-token",
            "refresh_token": second_refresh,
            "token_type": "bearer",
            "expires_in": 900,
            "refresh_expires_in": 2_592_000,
        },
    )
    client = make_client(
        tmp_path,
        transport,
        channel_code="agent-a",
        distribution_token="distribution-secret-1234567890",
    )

    challenge = client.send_sms_code("13800000000")
    session = client.verify_sms_code("13800000000", challenge.development_code or "")
    rotated = client.refresh_session()

    assert challenge.phone_masked == "138****0000"
    assert session.attribution.agent_id == 9
    assert client.has_refresh_session
    assert first_refresh not in repr(session)
    assert second_refresh not in repr(rotated)
    assert transport.calls[0]["json_body"] == {
        "project_code": "sample_app",
        "device_code": DEVICE_CODE,
        "device_name": "Test machine",
        "version": "1.2.3",
        "version_hash": "sha256:client",
        "channel_code": "agent-a",
        "distribution_token": "distribution-secret-1234567890",
        "phone": "13800000000",
        "scene": "login_or_register",
    }
    assert transport.calls[2]["json_body"] == {
        "refresh_token": first_refresh,
        "device_code": DEVICE_CODE,
    }


def test_store_plan_contract_and_pagination(tmp_path: Path) -> None:
    transport = FakeTransport(
        {
            "items": [
                {
                    "id": 5,
                    "project_id": 3,
                    "project_code": "sample_app",
                    "product_id": 4,
                    "product_name": "桌面端",
                    "name": "专业版",
                    "sale_price_cent": 29_900,
                    "currency": "CNY",
                    "duration_days": 365,
                    "max_devices": 2,
                    "max_shops": 5,
                    "offline_hours": 72,
                    "permission_codes": ["orders.view", "profit.view"],
                    "payment_providers": ["wechat", "alipay"],
                }
            ],
            "total": 1,
            "page": 1,
            "page_size": 50,
        }
    )
    client = make_client(tmp_path, transport)

    plans = client.list_store_plans()

    assert plans.total == 1
    assert plans.items[0].sale_price_cent == 29_900
    assert plans.items[0].payment_providers == ("wechat", "alipay")
    assert transport.calls[0]["path"].startswith("/api/store/plans?project_code=sample_app")


def test_query_order_payment_uses_owner_reconciliation_endpoint(tmp_path: Path) -> None:
    transport = FakeTransport(order_response(status="paying"))
    client = make_client(tmp_path, transport, access_token="user-token")

    order = client.query_order_payment(41)

    assert order.status == "paying"
    assert transport.calls[0]["method"] == "POST"
    assert transport.calls[0]["path"] == "/api/orders/41/query"
    assert transport.calls[0]["json_body"] == {}


def test_refresh_rotation_preserves_the_separate_license_token(tmp_path: Path) -> None:
    transport = FakeTransport(
        phone_session_response(),
        {
            "valid": True,
            "access_token": "license-access-token",
            "expire": "2027-07-11T08:05:01Z",
            "permissions": ["orders.view"],
        },
        {
            "access_token": "rotated-user-token",
            "refresh_token": "n" * 64,
            "expires_in": 900,
            "refresh_expires_in": 2_592_000,
        },
        order_response(),
        {
            "valid": True,
            "expire": "2027-07-11T08:05:01Z",
            "permissions": ["orders.view"],
        },
    )
    client = make_client(tmp_path, transport)

    client.verify_sms_code("13800000000", "123456")
    client.activate("AAAA-BBBB-CCCC-DDDD")
    client.refresh_session()
    client.create_order(5)
    client.check(allow_offline=False)

    assert transport.calls[1]["headers"]["Authorization"] == "Bearer phone-access-token"
    assert transport.calls[3]["headers"]["Authorization"] == "Bearer rotated-user-token"
    assert transport.calls[4]["headers"]["Authorization"] == "Bearer license-access-token"


def test_concurrent_refresh_callers_share_one_rotation(tmp_path: Path) -> None:
    old_refresh = "r" * 64
    transport = BlockingRefreshTransport(
        {
            "access_token": "rotated-user-token",
            "refresh_token": "n" * 64,
            "expires_in": 900,
            "refresh_expires_in": 2_592_000,
        }
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="user-token",
        refresh_token=old_refresh,
    )
    barrier = threading.Barrier(7)
    results = []
    errors = []

    def refresh_worker() -> None:
        barrier.wait()
        try:
            results.append(client.refresh_session())
        except BaseException as error:  # pragma: no cover - asserted empty below
            errors.append(error)

    workers = [threading.Thread(target=refresh_worker) for _ in range(6)]
    for worker in workers:
        worker.start()
    barrier.wait()
    assert transport.started.wait(timeout=2)
    time.sleep(0.05)
    transport.release.set()
    for worker in workers:
        worker.join(timeout=3)

    assert all(not worker.is_alive() for worker in workers)
    assert errors == []
    assert len(results) == 6
    assert all(result is results[0] for result in results)
    assert len(transport.calls) == 1
    assert transport.calls[0]["json_body"]["refresh_token"] == old_refresh


def test_concurrent_refresh_callers_share_the_same_rejection(tmp_path: Path) -> None:
    rejection = AuthenticationError(status_code=401, message="refresh token replay")
    transport = BlockingRefreshTransport(rejection)
    client = make_client(
        tmp_path,
        transport,
        access_token="user-token",
        refresh_token="r" * 64,
    )
    barrier = threading.Barrier(6)
    errors = []

    def refresh_worker() -> None:
        barrier.wait()
        try:
            client.refresh_session()
        except BaseException as error:
            errors.append(error)

    workers = [threading.Thread(target=refresh_worker) for _ in range(5)]
    for worker in workers:
        worker.start()
    barrier.wait()
    assert transport.started.wait(timeout=2)
    time.sleep(0.05)
    transport.release.set()
    for worker in workers:
        worker.join(timeout=3)

    assert all(not worker.is_alive() for worker in workers)
    assert len(errors) == 5
    assert all(error is rejection for error in errors)
    assert len(transport.calls) == 1
    assert not client.is_authenticated
    assert not client.has_refresh_session


def test_development_purchase_retrieves_bound_card_and_activates(tmp_path: Path) -> None:
    card = "AAAA-BBBB-CCCC-DDDD"
    transport = FakeTransport(
        order_response(),
        {
            "id": 41,
            "payment_id": 23,
            "order_no": "LC202607110001",
            "status": "paying",
            "provider": "development",
            "amount_cent": 29_900,
            "currency": "CNY",
            "code_url": "development://pay/LC202607110001",
            "qr_code_url": "development://pay/LC202607110001",
            "expires_at": "2026-07-11T09:00:00Z",
        },
        {
            "order_no": "LC202607110001",
            "status": "fulfilled",
            "idempotent": False,
            "activation_code": card,
            "fulfillment": {
                "status": "fulfilled",
                "activation_code": card,
                "activation_code_prefix": "AAAA",
                "fulfilled_at": "2026-07-11T08:05:01Z",
            },
        },
        order_response(status="fulfilled", activation_code=card),
        {
            "valid": True,
            "access_token": "license-access-token",
            "expire": "2027-07-11T08:05:01Z",
            "permissions": ["orders.view"],
        },
    )
    client = make_client(tmp_path, transport, access_token="user-access-token")

    result = client.purchase_development_and_activate(
        5,
        idempotency_key="purchase-attempt-001",
        event_id="desktop-event-001",
    )

    assert result.order.fulfillment_code == card
    assert result.order.channel_id == 11
    assert result.order.commission_amount_cent == 5_980
    assert result.license_status.has_permission("orders.view")
    assert card not in repr(result)
    assert transport.calls[0]["json_body"]["idempotency_key"] == "purchase-attempt-001"
    assert transport.calls[2]["path"] == ("/api/payments/development/LC202607110001/complete")
    assert transport.calls[3]["headers"]["Authorization"] == "Bearer user-access-token"
    assert transport.calls[4]["headers"]["Authorization"] == "Bearer user-access-token"


def test_wait_for_fulfillment_rejects_terminal_order_state(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        FakeTransport(order_response(status="closed")),
        access_token="user-token",
    )

    with pytest.raises(OrderStateError) as error:
        client.wait_for_fulfillment_and_activate(41, timeout=1, poll_interval=0.01)

    assert error.value.status == "closed"


def test_logout_clears_memory_even_when_revoke_is_unreachable(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        FakeTransport(TransportError("offline")),
        access_token="user-token",
        refresh_token="r" * 64,
    )

    with pytest.raises(TransportError):
        client.logout()

    assert not client.is_authenticated
    assert not client.has_refresh_session


def test_rejected_refresh_discards_the_replayed_user_session(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        FakeTransport(AuthenticationError(status_code=401, message="refresh token replay")),
        access_token="user-token",
        refresh_token="r" * 64,
    )

    with pytest.raises(AuthenticationError):
        client.refresh_session()

    assert not client.is_authenticated
    assert not client.has_refresh_session


def test_malformed_store_response_uses_shared_response_error(tmp_path: Path) -> None:
    client = make_client(tmp_path, FakeTransport({"items": "not-a-list"}))

    with pytest.raises(ResponseFormatError):
        client.list_store_plans()


def test_commerce_operations_require_a_user_token(tmp_path: Path) -> None:
    client = make_client(tmp_path, FakeTransport())

    with pytest.raises(ConfigurationError):
        client.create_order(5)


def test_securely_restored_user_token_is_used_for_entitlement_and_orders(tmp_path: Path) -> None:
    transport = FakeTransport(
        {"valid": False, "permissions": [], "reason": "needs_activation"},
        order_response(),
    )
    client = make_client(tmp_path, transport, user_access_token="restored-user-token")

    client.check(allow_offline=False)
    client.create_order(5)

    assert client.is_authenticated
    assert all(
        call["headers"]["Authorization"] == "Bearer restored-user-token" for call in transport.calls
    )

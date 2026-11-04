from __future__ import annotations

from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.models import ActivationCode, Order, Refund
from app.services.errors import DomainError
from app.services.payments.providers import RefundNotification, RefundResult
from app.services.refund_service import process_refund_notification
from tests.helpers import create_commerce_catalog, register_sms_user


class ScriptedRefundProvider:
    def __init__(
        self,
        inspect_intent: Callable[[str], None],
        outcomes: list[RefundResult | Exception],
    ) -> None:
        self.inspect_intent = inspect_intent
        self.outcomes = outcomes
        self.refund_numbers: list[str] = []

    def refund(self, _order, _payment, _amount_cent: int, refund_no: str) -> RefundResult:
        self.inspect_intent(refund_no)
        self.refund_numbers.append(refund_no)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _fulfilled_order(
    client: TestClient, admin_headers: dict[str, str]
) -> tuple[dict[str, object], dict[str, str]]:
    catalog = create_commerce_catalog(client, admin_headers)
    login = register_sms_user(
        client,
        admin_headers,
        catalog,
        phone="13500135000",
        device_code="refund-intent-device",
    )
    headers = {"Authorization": f"Bearer {login['access_token']}"}
    order = client.post(
        "/api/orders",
        headers=headers,
        json={"project_code": "ozon_helper", "plan_id": catalog["plan"]["id"]},
    ).json()
    paid = client.post(
        f"/api/orders/{order['id']}/pay",
        headers=headers,
        json={"provider": "development"},
    )
    assert paid.status_code == 200, paid.text
    completed = client.post(
        f"/api/payments/development/{order['order_no']}/complete", headers=headers
    )
    assert completed.status_code == 200, completed.text
    return order, headers


def _intent_inspector(client: TestClient, order_id: int) -> Callable[[str], None]:
    def inspect(refund_no: str) -> None:
        with client.app.state.session_factory() as db:
            refund = db.scalar(select(Refund).where(Refund.refund_no == refund_no))
            order = db.get(Order, order_id)
            assert refund is not None and refund.status == "pending"
            assert order is not None and order.status == "refunding"

    return inspect


def test_unknown_refund_result_retries_the_persisted_intent(
    client: TestClient, admin_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    order, _ = _fulfilled_order(client, admin_headers)
    provider = ScriptedRefundProvider(
        _intent_inspector(client, order["id"]),
        [
            DomainError("Provider timeout", status_code=503),
            RefundResult(status="succeeded", provider_refund_no="PROVIDER-R-001"),
        ],
    )
    monkeypatch.setattr(
        "app.services.refund_service.build_payment_provider", lambda *_args: provider
    )

    first = client.post(
        f"/api/admin/orders/{order['id']}/refund",
        headers=admin_headers,
        json={"reason": "首次退款请求"},
    )
    assert first.status_code == 503
    with client.app.state.session_factory() as db:
        intent = db.scalar(select(Refund).where(Refund.order_id == order["id"]))
        activation = db.scalar(select(ActivationCode).where(ActivationCode.order_id == order["id"]))
        assert intent is not None and intent.status == "pending"
        assert activation is not None and activation.status == "disabled"

    retried = client.post(
        f"/api/admin/orders/{order['id']}/refund",
        headers=admin_headers,
        json={"reason": "重试不得换退款号"},
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["status"] == "succeeded"
    assert provider.refund_numbers[0] == provider.refund_numbers[1]
    with client.app.state.session_factory() as db:
        assert db.scalar(select(func.count(Refund.id))) == 1
        assert db.get(Order, order["id"]).status == "refunded"


def test_explicit_failure_allows_a_new_refund_number(
    client: TestClient, admin_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    order, _ = _fulfilled_order(client, admin_headers)
    provider = ScriptedRefundProvider(
        _intent_inspector(client, order["id"]),
        [
            RefundResult(status="failed", provider_refund_no="PROVIDER-R-FAILED"),
            RefundResult(status="succeeded", provider_refund_no="PROVIDER-R-SUCCEEDED"),
        ],
    )
    monkeypatch.setattr(
        "app.services.refund_service.build_payment_provider", lambda *_args: provider
    )

    failed = client.post(
        f"/api/admin/orders/{order['id']}/refund",
        headers=admin_headers,
        json={"reason": "平台明确拒绝"},
    )
    assert failed.status_code == 409
    succeeded = client.post(
        f"/api/admin/orders/{order['id']}/refund",
        headers=admin_headers,
        json={"reason": "新退款申请"},
    )
    assert succeeded.status_code == 200, succeeded.text
    assert provider.refund_numbers[0] != provider.refund_numbers[1]
    with client.app.state.session_factory() as db:
        refunds = db.scalars(select(Refund).order_by(Refund.created_at)).all()
        assert [refund.status for refund in refunds] == ["failed", "succeeded"]


def test_refund_callback_matches_the_persisted_refund_number(
    client: TestClient, admin_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    order, _ = _fulfilled_order(client, admin_headers)
    provider = ScriptedRefundProvider(
        _intent_inspector(client, order["id"]),
        [RefundResult(status="pending", provider_refund_no="WX-REFUND-001")],
    )
    monkeypatch.setattr(
        "app.services.refund_service.build_payment_provider", lambda *_args: provider
    )
    pending = client.post(
        f"/api/admin/orders/{order['id']}/refund",
        headers=admin_headers,
        json={"reason": "等待微信退款回调"},
    )
    assert pending.status_code == 200, pending.text
    refund_no = pending.json()["refund_no"]

    def notification(number: str, event: str) -> RefundNotification:
        return RefundNotification(
            order_no=order["order_no"],
            refund_no=number,
            event_id=event,
            provider_refund_no="WX-REFUND-001",
            status="succeeded",
            refund_amount_cent=5000,
            total_amount_cent=5000,
            currency="CNY",
            payload_fingerprint=event,
        )

    with client.app.state.session_factory() as db:
        with pytest.raises(DomainError, match="Pending refund not found"):
            process_refund_notification(
                db,
                provider="development",
                notification=notification("RF-WRONG", "refund:wrong:success"),
            )
    with client.app.state.session_factory() as db:
        assert (
            process_refund_notification(
                db,
                provider="development",
                notification=notification(refund_no, "refund:correct:success"),
            )
            is False
        )
        assert db.get(Order, order["id"]).status == "refunded"

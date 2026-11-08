"""High-level v1.1 phone, order, payment, and fulfillment workflows."""

from __future__ import annotations

import time
from concurrent.futures import Future
from threading import RLock
from typing import Any

from .commerce import CommerceClient
from .commerce_models import (
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
from .device import DeviceIdentity
from .errors import AuthenticationError, ConfigurationError, OperationTimeoutError, OrderStateError
from .models import AuthSession, LicenseStatus

_UNFULFILLABLE_ORDER_STATES = frozenset({"closed", "payment_failed", "refunded"})


class CommerceMixin:
    """Adds v1.1 workflows while leaving the v1.0 entitlement API unchanged."""

    app: str
    version: str
    version_hash: str | None
    device: DeviceIdentity
    _commerce: CommerceClient
    _state_lock: RLock
    _session_generation: int
    _access_token: str | None
    _user_access_token: str | None
    _refresh_token: str | None
    _refresh_future: Future[RefreshSession] | None
    _channel_code: str | None
    _distribution_token: str | None
    _status: LicenseStatus | None
    _offline_cache: Any
    _last_offline_error: Exception | None

    @property
    def has_refresh_session(self) -> bool:
        """Whether a rotatable phone-login session is currently held in memory."""
        with self._state_lock:
            return bool(self._refresh_token)

    def send_sms_code(
        self,
        phone: str,
        *,
        channel_code: str | None = None,
        distribution_token: str | None = None,
    ) -> SmsChallenge:
        """Send a login-or-register OTP for this client project and device."""
        return self._commerce.send_sms(
            phone,
            self._commerce_client_payload(
                channel_code=channel_code,
                distribution_token=distribution_token,
            ),
        )

    def verify_sms_code(
        self,
        phone: str,
        code: str,
        *,
        channel_code: str | None = None,
        distribution_token: str | None = None,
    ) -> PhoneAuthSession:
        """Register or login by OTP and atomically adopt both rotated tokens."""
        with self._state_lock:
            generation = self._session_generation
        session = self._commerce.verify_sms(
            phone,
            code,
            self._commerce_client_payload(
                channel_code=channel_code,
                distribution_token=distribution_token,
            ),
        )
        with self._state_lock:
            if generation == self._session_generation:
                self._session_generation += 1
                self._offline_cache.clear()
                self._access_token = session.access_token
                self._user_access_token = session.access_token
                self._refresh_token = session.refresh_token
                self._status = None
                self._last_offline_error = None
        return session

    def refresh_session(self, refresh_token: str | None = None) -> RefreshSession:
        """Rotate a refresh token; the old token is invalid after a successful call."""
        with self._state_lock:
            existing_future = self._refresh_future
            if existing_future is None:
                generation = self._session_generation
                old_user_token = self._user_access_token
                token = refresh_token.strip() if refresh_token else self._require_refresh_token()
                shared_future: Future[RefreshSession] = Future()
                self._refresh_future = shared_future
            else:
                shared_future = existing_future
        if existing_future is not None:
            return existing_future.result()
        try:
            session = self._commerce.refresh(token, self.device.code)
        except AuthenticationError as error:
            with self._state_lock:
                if generation == self._session_generation and token == self._refresh_token:
                    self._refresh_token = None
                    self._user_access_token = None
                    if self._access_token == old_user_token:
                        self._access_token = None
            shared_future.set_exception(error)
            raise
        except BaseException as error:
            shared_future.set_exception(error)
            raise
        else:
            with self._state_lock:
                if generation == self._session_generation:
                    self._session_generation += 1
                    if self._access_token == old_user_token:
                        self._access_token = session.access_token
                    self._user_access_token = session.access_token
                    self._refresh_token = session.refresh_token
            shared_future.set_result(session)
            return session
        finally:
            with self._state_lock:
                if self._refresh_future is shared_future:
                    self._refresh_future = None

    def logout(self, *, clear_offline_cache: bool = True) -> None:
        """Revoke the refresh session and clear every local in-memory token."""
        with self._state_lock:
            token = self._require_refresh_token()
        try:
            self._commerce.logout(token)
        finally:
            self.clear_session(clear_offline_cache=clear_offline_cache)

    def list_store_plans(self, *, page: int = 1, page_size: int = 50) -> PageResult[StorePlan]:
        """List public, online-sale plans for this client project."""
        return self._commerce.list_plans(self.app, page=page, page_size=page_size)

    def create_order(self, plan_id: int, *, idempotency_key: str | None = None) -> Order:
        """Create an account-bound order using the server's current plan price."""
        return self._commerce.create_order(
            self._require_user_access_token(),
            self.app,
            plan_id,
            idempotency_key,
        )

    def get_order(self, order_id: int) -> Order:
        """Read one order owned by the currently authenticated user."""
        return self._commerce.get_order(self._require_user_access_token(), order_id)

    def query_order_payment(self, order_id: int) -> Order:
        """Reconcile an owned order with its payment provider, then return it."""
        return self._commerce.query_order_payment(self._require_user_access_token(), order_id)

    def start_payment(self, order_id: int, *, provider: str | None = None) -> PaymentCheckout:
        """Create or reuse a provider checkout for an order."""
        return self._commerce.start_payment(
            self._require_user_access_token(),
            order_id,
            provider,
        )

    def complete_development_payment(
        self,
        order_no: str,
        *,
        event_id: str | None = None,
    ) -> PaymentCompletion:
        """Complete a development payment; production servers reject this endpoint."""
        return self._commerce.complete_development_payment(
            self._require_user_access_token(),
            order_no,
            event_id,
        )

    def wait_for_fulfillment_and_activate(
        self,
        order_id: int,
        *,
        timeout: float = 300.0,
        poll_interval: float = 2.0,
    ) -> PurchaseActivation:
        """Poll for an account-bound card, then activate it on this device."""
        if timeout <= 0 or poll_interval <= 0:
            raise ConfigurationError("timeout and poll_interval must be greater than zero")
        deadline = time.monotonic() + timeout
        while True:
            order = self.query_order_payment(order_id)
            code = order.fulfillment_code
            if code:
                status = self.activate(code)
                return PurchaseActivation(order=order, license_status=status)
            if order.status in _UNFULFILLABLE_ORDER_STATES:
                raise OrderStateError(order.id, order.status)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OperationTimeoutError(
                    f"Order {order_id} was not fulfilled within {timeout:g} seconds"
                )
            time.sleep(min(poll_interval, remaining))

    def purchase_development_and_activate(
        self,
        plan_id: int,
        *,
        idempotency_key: str | None = None,
        event_id: str | None = None,
    ) -> PurchaseActivation:
        """Run the complete local/test purchase flow; unavailable in production."""
        order = self.create_order(plan_id, idempotency_key=idempotency_key)
        self.start_payment(order.id, provider="development")
        completion = self.complete_development_payment(order.order_no, event_id=event_id)
        code = completion.fulfillment_code
        if not code:
            return self.wait_for_fulfillment_and_activate(order.id)
        fulfilled_order = self.get_order(order.id)
        status = self.activate(code)
        return PurchaseActivation(order=fulfilled_order, license_status=status)

    def _commerce_client_payload(
        self,
        *,
        channel_code: str | None,
        distribution_token: str | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "project_code": self.app,
            "device_code": self.device.code,
            "device_name": self.device.name,
            "version": self.version,
        }
        if self.version_hash:
            payload["version_hash"] = self.version_hash
        resolved_channel = channel_code if channel_code is not None else self._channel_code
        resolved_token = (
            distribution_token if distribution_token is not None else self._distribution_token
        )
        if resolved_channel:
            payload["channel_code"] = resolved_channel.strip()
        if resolved_token:
            payload["distribution_token"] = resolved_token.strip()
        return payload

    def _adopt_password_session(self, session: AuthSession) -> None:
        self._access_token = session.access_token
        self._user_access_token = session.access_token
        self._refresh_token = None

    def _clear_commerce_tokens(self) -> None:
        self._user_access_token = None
        self._refresh_token = None

    def _require_user_access_token(self) -> str:
        with self._state_lock:
            if not self._user_access_token:
                raise ConfigurationError("Phone/password login is required before this operation")
            return self._user_access_token

    def _require_refresh_token(self) -> str:
        if not self._refresh_token:
            raise ConfigurationError("No refresh session is available")
        return self._refresh_token

    def activate(self, card_key: str) -> LicenseStatus:
        raise NotImplementedError

    def clear_session(self, *, clear_offline_cache: bool = False) -> None:
        raise NotImplementedError

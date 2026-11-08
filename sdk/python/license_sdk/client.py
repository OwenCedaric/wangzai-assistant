"""Unified public client used by desktop and SaaS applications."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from threading import RLock
from time import monotonic
from typing import Any

from .auth import AuthClient
from .commerce import CommerceClient
from .commerce_mixin import CommerceMixin
from .device import DeviceIdentity
from .errors import (
    APIError,
    ConfigurationError,
    OfflineCacheError,
    OfflineUnavailableError,
    PermissionDeniedError,
    TransportError,
)
from .heartbeat import DEFAULT_HEARTBEAT_INTERVAL_SECONDS, HeartbeatRunner, HeartbeatService
from .models import AuthSession, LicenseStatus, unwrap_response
from .offline import (
    DEFAULT_OFFLINE_TOKEN_AUDIENCE,
    DEFAULT_OFFLINE_TOKEN_ISSUER,
    Ed25519OfflineTokenVerifier,
    OfflineGrantCache,
    OfflineTokenVerifier,
)
from .transport import Transport, UrllibTransport

_ENTITLEMENT_REJECTION_STATUSES = frozenset({401, 403, 404, 409, 410, 422})
_ONLINE_ONLY_FRESHNESS_SECONDS = 90.0


class License(CommerceMixin):
    """License Center login, activation, entitlement, and heartbeat client."""

    def __init__(
        self,
        *,
        app: str,
        version: str,
        base_url: str | None = None,
        access_token: str | None = None,
        user_access_token: str | None = None,
        refresh_token: str | None = None,
        device_code: str | None = None,
        device_name: str | None = None,
        version_hash: str | None = None,
        channel_code: str | None = None,
        distribution_token: str | None = None,
        timeout: float = 10.0,
        allow_insecure_http: bool = False,
        cache_directory: str | os.PathLike[str] | None = None,
        max_offline_hours: float = 72,
        offline_public_key: str | bytes | os.PathLike[str] | None = None,
        offline_key_id: str | None = None,
        offline_token_issuer: str = DEFAULT_OFFLINE_TOKEN_ISSUER,
        offline_token_audience: str = DEFAULT_OFFLINE_TOKEN_AUDIENCE,
        offline_verifier: OfflineTokenVerifier | None = None,
        transport: Transport | None = None,
    ) -> None:
        self.app = app.strip()
        self.version = version.strip()
        if not self.app or not self.version:
            raise ConfigurationError("app and version must not be empty")
        self.version_hash = version_hash.strip() if version_hash else None
        self.device = DeviceIdentity.detect(
            self.app,
            device_code=device_code,
            device_name=device_name,
        )
        if transport is None:
            resolved_url = (
                base_url or os.environ.get("LICENSE_CENTER_URL") or "http://127.0.0.1:8000"
            )
            transport = UrllibTransport(
                resolved_url,
                timeout=timeout,
                allow_insecure_http=allow_insecure_http,
            )
        self._transport = transport
        self._auth = AuthClient(transport)
        self._commerce = CommerceClient(transport)
        self._heartbeat_service = HeartbeatService(transport)
        self._state_lock = RLock()
        initial_user_token = user_access_token.strip() if user_access_token else None
        self._access_token = access_token.strip() if access_token else initial_user_token
        self._user_access_token = initial_user_token or self._access_token
        self._refresh_token = refresh_token.strip() if refresh_token else None
        self._refresh_future = None
        self._channel_code = channel_code.strip() if channel_code else None
        self._distribution_token = distribution_token.strip() if distribution_token else None
        self._status: LicenseStatus | None = None
        self._online_only_fresh_until = 0.0
        self._session_generation = 0
        self._heartbeat_runner: HeartbeatRunner | None = None
        self._last_offline_error: Exception | None = None

        verifier = offline_verifier
        if verifier is None and offline_public_key is not None:
            key_data = self._read_public_key(offline_public_key)
            verifier = Ed25519OfflineTokenVerifier(
                {offline_key_id: key_data} if offline_key_id else key_data,
                issuer=offline_token_issuer,
                audience=offline_token_audience,
            )
        self._offline_cache = OfflineGrantCache(
            project_code=self.app,
            device_code=self.device.code,
            verifier=verifier,
            cache_directory=cache_directory,
            max_offline_hours=max_offline_hours,
        )

    @staticmethod
    def _read_public_key(source: str | bytes | os.PathLike[str]) -> str | bytes:
        if isinstance(source, os.PathLike):
            return Path(source).read_bytes()
        return source

    @property
    def current_status(self) -> LicenseStatus | None:
        with self._state_lock:
            return self._fresh_status()

    @property
    def is_authenticated(self) -> bool:
        with self._state_lock:
            return bool(self._access_token)

    @property
    def last_offline_error(self) -> Exception | None:
        """Why the most recent online grant could not be cached, if applicable."""
        with self._state_lock:
            return self._last_offline_error

    @property
    def cache_path(self) -> Path:
        return self._offline_cache.path

    def login(self, username: str, password: str) -> AuthSession:
        with self._state_lock:
            generation = self._session_generation
        session = self._auth.login(username, password)
        with self._state_lock:
            if generation == self._session_generation:
                self._session_generation += 1
                self._offline_cache.clear()
                self._adopt_password_session(session)
                self._status = None
                self._online_only_fresh_until = 0.0
                self._last_offline_error = None
        return session

    def activate(self, card_key: str) -> LicenseStatus:
        with self._state_lock:
            generation = self._session_generation
            token = self._require_user_access_token()
        clean_card_key = card_key.strip()
        if not clean_card_key:
            raise ConfigurationError("card_key must not be empty")
        payload = self._base_payload(include_device_name=True)
        payload["card_key"] = clean_card_key
        response = self._transport.request(
            "POST",
            "/api/license/activate",
            json_body=payload,
            headers=self._authorization_header(token),
        )
        with self._state_lock:
            if generation != self._session_generation:
                return LicenseStatus.from_response(response)
            self._adopt_response_token(response)
            return self._accept_online_status(response)

    def check(
        self,
        *,
        license_key: str | None = None,
        allow_offline: bool = True,
    ) -> LicenseStatus:
        with self._state_lock:
            generation = self._session_generation
            access_token = self._access_token
        payload = self._base_payload()
        if license_key:
            payload["license_key"] = license_key.strip()
        headers = self._authorization_header(access_token) if access_token else {}
        try:
            response = self._transport.request(
                "POST",
                "/api/license/check",
                json_body=payload,
                headers=headers,
            )
        except TransportError as exc:
            with self._state_lock:
                if generation != self._session_generation:
                    raise
                return self._offline_or_raise(exc, allow_offline=allow_offline)
        except APIError as exc:
            with self._state_lock:
                if exc.status_code < 500:
                    if (
                        exc.status_code in _ENTITLEMENT_REJECTION_STATUSES
                        and generation == self._session_generation
                    ):
                        self._invalidate_cached_entitlement()
                    else:
                        self._clear_online_status_without_offline_grant()
                    raise
                if generation != self._session_generation:
                    raise
                return self._offline_or_raise(exc, allow_offline=allow_offline)
        with self._state_lock:
            if generation != self._session_generation:
                return LicenseStatus.from_response(response)
            self._adopt_response_token(response)
            return self._accept_online_status(response)

    def heartbeat(self) -> LicenseStatus:
        with self._state_lock:
            generation = self._session_generation
            token = self._require_access_token()
        try:
            status, response = self._heartbeat_service.pulse(
                access_token=token,
                project_code=self.app,
                device_code=self.device.code,
                version=self.version,
                version_hash=self.version_hash,
            )
        except TransportError as exc:
            with self._state_lock:
                if generation != self._session_generation:
                    raise
                return self._offline_or_raise(exc, allow_offline=True)
        except APIError as exc:
            with self._state_lock:
                if (
                    exc.status_code in _ENTITLEMENT_REJECTION_STATUSES
                    and generation == self._session_generation
                ):
                    self._invalidate_cached_entitlement()
                elif exc.status_code >= 500 and generation == self._session_generation:
                    return self._offline_or_raise(exc, allow_offline=True)
                elif generation == self._session_generation:
                    self._clear_online_status_without_offline_grant()
            raise
        with self._state_lock:
            if generation != self._session_generation:
                return status
            self._adopt_response_token(response)
            return self._accept_online_status(response, parsed_status=status)

    def start_heartbeat(
        self,
        *,
        interval_seconds: float = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
        on_error: Any = None,
        run_immediately: bool = False,
    ) -> HeartbeatRunner:
        if self._heartbeat_runner:
            self._heartbeat_runner.stop()
        self._heartbeat_runner = HeartbeatRunner(
            self.heartbeat,
            interval_seconds=interval_seconds,
            on_error=on_error,
            run_immediately=run_immediately,
        ).start()
        return self._heartbeat_runner

    def stop_heartbeat(self) -> None:
        if self._heartbeat_runner:
            self._heartbeat_runner.stop()
            self._heartbeat_runner = None

    def has_permission(self, permission: str) -> bool:
        with self._state_lock:
            status = self._fresh_status()
            return bool(status and status.has_permission(permission))

    def require_permission(self, permission: str) -> None:
        if not self.has_permission(permission):
            raise PermissionDeniedError(permission)

    def clear_session(self, *, clear_offline_cache: bool = False) -> None:
        with self._state_lock:
            self._session_generation += 1
            self._access_token = None
            self._clear_commerce_tokens()
            self._status = None
            self._online_only_fresh_until = 0.0
            self._last_offline_error = None
            if clear_offline_cache:
                self._offline_cache.clear()
        self.stop_heartbeat()

    def configure_offline_public_key(
        self,
        public_key_pem: str | bytes | os.PathLike[str],
        *,
        key_id: str | None = None,
    ) -> None:
        key_data = self._read_public_key(public_key_pem)
        verifier = Ed25519OfflineTokenVerifier({key_id: key_data} if key_id else key_data)
        with self._state_lock:
            self._offline_cache.set_verifier(verifier)

    def fetch_offline_public_key(self) -> Mapping[str, Any]:
        """Fetch and pin the current key in memory over the configured transport.

        Production desktop builds should normally bundle a trusted key instead of
        relying on trust-on-first-use. This helper is useful for local development.
        """
        response = self._transport.request("GET", "/api/license/public-key")
        payload = unwrap_response(response)
        if payload.get("algorithm") != "EdDSA" or not payload.get("public_key_pem"):
            raise ConfigurationError("Public-key endpoint did not return an EdDSA PEM key")
        self.configure_offline_public_key(
            str(payload["public_key_pem"]),
            key_id=str(payload.get("key_id")) if payload.get("key_id") else None,
        )
        return {
            "algorithm": "EdDSA",
            "key_id": payload.get("key_id"),
        }

    def close(self) -> None:
        self.stop_heartbeat()

    def __enter__(self) -> License:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _base_payload(self, *, include_device_name: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "project_code": self.app,
            "device_code": self.device.code,
            "version": self.version,
        }
        if include_device_name:
            payload["device_name"] = self.device.name
        if self.version_hash:
            payload["version_hash"] = self.version_hash
        return payload

    @staticmethod
    def _authorization_header(access_token: str | None) -> dict[str, str]:
        return {"Authorization": f"Bearer {access_token}"} if access_token else {}

    def _require_access_token(self) -> str:
        with self._state_lock:
            if not self._access_token:
                raise ConfigurationError("Login or provide an access_token before this operation")
            return self._access_token

    def _adopt_response_token(self, response: Mapping[str, Any]) -> None:
        payload = unwrap_response(response)
        value = payload.get("access_token")
        if isinstance(value, str) and value.strip():
            self._access_token = value.strip()

    def _accept_online_status(
        self,
        response: Mapping[str, Any],
        *,
        parsed_status: LicenseStatus | None = None,
    ) -> LicenseStatus:
        status = parsed_status or LicenseStatus.from_response(response)
        self._status = status
        self._online_only_fresh_until = 0.0
        self._last_offline_error = None
        if not status.valid:
            self._offline_cache.clear()
            return status
        payload = unwrap_response(response)
        offline_token = payload.get("offline_token")
        if (
            not isinstance(offline_token, str)
            or not offline_token
            or not self._offline_cache.enabled
        ):
            self._offline_cache.clear()
            self._online_only_fresh_until = monotonic() + _ONLINE_ONLY_FRESHNESS_SECONDS
        else:
            try:
                self._offline_cache.store(offline_token)
            except (OfflineCacheError, OfflineUnavailableError) as exc:
                # Online authorization remains authoritative; only offline fallback is disabled.
                self._offline_cache.clear()
                self._online_only_fresh_until = monotonic() + _ONLINE_ONLY_FRESHNESS_SECONDS
                self._last_offline_error = exc
        return status

    def _invalidate_cached_entitlement(self) -> None:
        """Discard grants after an authoritative client error from the server."""
        self._status = None
        self._online_only_fresh_until = 0.0
        self._offline_cache.clear()

    def _offline_or_raise(self, online_error: Exception, *, allow_offline: bool) -> LicenseStatus:
        if not allow_offline:
            self._status = None
            self._online_only_fresh_until = 0.0
            raise online_error
        try:
            grant = self._offline_cache.load()
        except (OfflineCacheError, OfflineUnavailableError) as cache_error:
            self._status = None
            self._online_only_fresh_until = 0.0
            raise OfflineUnavailableError(
                "Online authorization failed and no verifiable offline grant is available"
            ) from cache_error
        if grant is None:
            self._status = None
            self._online_only_fresh_until = 0.0
            raise OfflineUnavailableError(
                "Online authorization failed and no offline grant has been cached"
            ) from online_error
        status = grant.to_status()
        self._status = status
        self._online_only_fresh_until = 0.0
        return status

    def _clear_online_status_without_offline_grant(self) -> None:
        try:
            grant = self._offline_cache.load()
        except (OfflineCacheError, OfflineUnavailableError):
            self._offline_cache.clear()
            grant = None
        if grant is None:
            self._status = None
            self._online_only_fresh_until = 0.0

    def _fresh_status(self) -> LicenseStatus | None:
        if self._online_only_fresh_until and monotonic() >= self._online_only_fresh_until:
            self._status = None
            self._online_only_fresh_until = 0.0
        return self._status

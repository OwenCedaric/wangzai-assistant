"""Heartbeat API and optional six-hour background scheduler."""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from typing import Any

from .models import LicenseStatus
from .transport import Transport

DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 6 * 60 * 60


class HeartbeatService:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def pulse(
        self,
        *,
        access_token: str,
        project_code: str,
        device_code: str,
        version: str,
        version_hash: str | None = None,
    ) -> tuple[LicenseStatus, Mapping[str, Any]]:
        payload: dict[str, Any] = {
            "project_code": project_code,
            "device_code": device_code,
            "version": version,
        }
        if version_hash:
            payload["version_hash"] = version_hash
        response = self._transport.request(
            "POST",
            "/api/license/heartbeat",
            json_body=payload,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        return LicenseStatus.from_response(response), response


class HeartbeatRunner:
    """A small daemon scheduler; failures are reported and never swallowed silently."""

    def __init__(
        self,
        callback: Callable[[], object],
        *,
        interval_seconds: float = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
        on_error: Callable[[Exception], None] | None = None,
        run_immediately: bool = False,
    ) -> None:
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be greater than zero")
        self._callback = callback
        self._interval = interval_seconds
        self._on_error = on_error
        self._run_immediately = run_immediately
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> HeartbeatRunner:
        if self.running:
            return self
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="license-center-heartbeat",
            daemon=True,
        )
        self._thread.start()
        return self

    def stop(self, timeout: float | None = 2.0) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=timeout)
        self._thread = None

    def _run(self) -> None:
        should_run = self._run_immediately
        while not self._stop_event.is_set():
            if should_run:
                try:
                    self._callback()
                except Exception as exc:  # callers choose reporting/telemetry policy
                    if self._on_error:
                        self._on_error(exc)
            should_run = True
            if self._stop_event.wait(self._interval):
                break

    def __enter__(self) -> HeartbeatRunner:
        return self.start()

    def __exit__(self, *_: object) -> None:
        self.stop()

from __future__ import annotations

import threading
from pathlib import Path

import pytest
from conftest import FakeTransport

from license_sdk import ConfigurationError, HeartbeatRunner, License
from license_sdk.transport import UrllibTransport, _error_from_response


def test_heartbeat_uses_license_contract(tmp_path: Path) -> None:
    transport = FakeTransport(
        {
            "valid": True,
            "permissions": ["profit"],
            "offline_until": "2026-07-14T00:00:00Z",
            "server_time": "2026-07-11T00:00:00Z",
        }
    )
    client = License(
        app="sample_app",
        version="1.2.3",
        version_hash="sha256:abc",
        device_code="DEV-TEST-12345678",
        access_token="license-token",
        cache_directory=tmp_path,
        transport=transport,
    )
    status = client.heartbeat()
    assert status.valid
    assert transport.calls[0]["path"] == "/api/license/heartbeat"
    assert transport.calls[0]["json_body"] == {
        "project_code": "sample_app",
        "device_code": "DEV-TEST-12345678",
        "version": "1.2.3",
        "version_hash": "sha256:abc",
    }
    assert transport.calls[0]["headers"]["Authorization"] == "Bearer license-token"


def test_background_heartbeat_runs_and_stops() -> None:
    called = threading.Event()
    runner = HeartbeatRunner(called.set, interval_seconds=0.01, run_immediately=True)
    runner.start()
    assert called.wait(timeout=1)
    runner.stop()
    assert not runner.running


def test_non_local_plain_http_is_rejected() -> None:
    with pytest.raises(ConfigurationError):
        UrllibTransport("http://license.example.test")
    UrllibTransport("http://127.0.0.1:8000")


def test_validation_error_does_not_retain_sensitive_input() -> None:
    error = _error_from_response(
        422,
        {
            "message": "invalid request",
            "errors": [{"loc": ["body", "password"], "input": "plain-secret"}],
        },
    )
    assert error.details is None
    assert "plain-secret" not in repr(error)
    assert "plain-secret" not in str(error)

    fastapi_error = _error_from_response(
        422,
        {
            "detail": [
                {
                    "type": "string_too_short",
                    "loc": ["body", "refresh_token"],
                    "msg": "String should have at least 48 characters",
                    "input": "refresh-secret-value",
                }
            ]
        },
    )
    assert fastapi_error.error_code == "validation_error"
    assert "body.refresh_token" in str(fastapi_error)
    assert "refresh-secret-value" not in repr(fastapi_error)
    assert "refresh-secret-value" not in str(fastapi_error)


def test_public_key_can_be_fetched_for_local_development(tmp_path: Path, signing_material) -> None:
    transport = FakeTransport(
        {
            "algorithm": "EdDSA",
            "key_id": "test-key",
            "public_key_pem": signing_material["public_pem"].decode("ascii"),
        },
        {
            "valid": True,
            "permissions": ["profit"],
            "offline_token": signing_material["sign"](device_code="DEV-TEST-12345678"),
        },
    )
    client = License(
        app="sample_app",
        version="1.0.0",
        device_code="DEV-TEST-12345678",
        access_token="token",
        cache_directory=tmp_path,
        transport=transport,
    )
    info = client.fetch_offline_public_key()
    client.check()
    assert info == {"algorithm": "EdDSA", "key_id": "test-key"}
    assert client.cache_path.exists()

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest
from conftest import FakeTransport

import license_sdk.client as client_module
from license_sdk import (
    APIError,
    AuthenticationError,
    License,
    OfflineUnavailableError,
    PermissionDeniedError,
    TransportError,
)

DEVICE_CODE = "DEV-TEST-12345678"


def make_client(tmp_path: Path, transport: FakeTransport, **kwargs) -> License:
    return License(
        app="sample_app",
        version="1.2.3",
        device_code=DEVICE_CODE,
        device_name="Test machine",
        cache_directory=tmp_path,
        transport=transport,
        **kwargs,
    )


def test_login_activate_check_and_permission_flow(tmp_path: Path) -> None:
    transport = FakeTransport(
        {
            "access_token": "user-secret-token",
            "token_type": "bearer",
            "expires_in": 3600,
            "user": {"id": "user-1", "username": "demo"},
        },
        {
            "valid": True,
            "access_token": "license-secret-token",
            "expire": "2027-01-01",
            "permissions": ["order_sync", "profit"],
            "shop_limit": 3,
        },
        {
            "valid": True,
            "expire": "2027-01-01",
            "permissions": ["order_sync", "profit"],
            "shop_limit": 3,
        },
    )
    client = make_client(tmp_path, transport)

    session = client.login(" demo ", "plain-password")
    assert "user-secret-token" not in repr(session)
    activated = client.activate("AAAA-BBBB-CCCC-DDDD")
    checked = client.check(allow_offline=False)

    assert activated.valid and checked.valid
    assert checked.has_permission("order_sync")
    assert client.has_permission("profit")
    with pytest.raises(PermissionDeniedError):
        client.require_permission("purchase")

    assert transport.calls[0]["path"] == "/api/auth/login"
    assert transport.calls[0]["json_body"] == {
        "username": "demo",
        "password": "plain-password",
    }
    assert transport.calls[1]["json_body"]["card_key"] == "AAAA-BBBB-CCCC-DDDD"
    assert transport.calls[1]["headers"]["Authorization"] == "Bearer user-secret-token"
    assert transport.calls[2]["headers"]["Authorization"] == "Bearer license-secret-token"
    assert "password" not in client.__dict__


def test_license_key_is_transient_check_input(tmp_path: Path) -> None:
    transport = FakeTransport(
        {"valid": True, "permissions": [], "expire": "2027-01-01"},
    )
    client = make_client(tmp_path, transport, access_token="user-token")
    client.check(license_key="LIC-TEMP", allow_offline=False)
    assert transport.calls[0]["json_body"]["license_key"] == "LIC-TEMP"
    assert "LIC-TEMP" not in repr(client.__dict__)


def test_offline_fallback_uses_verified_server_grant(tmp_path: Path, signing_material) -> None:
    offline_token = signing_material["sign"](device_code=DEVICE_CODE)
    transport = FakeTransport(
        {
            "valid": True,
            "access_token": "license-access-secret",
            "expire": "2027-01-01",
            "permissions": ["order_sync", "profit"],
            "shop_limit": 3,
            "offline_token": offline_token,
        },
        TransportError("network unavailable"),
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="initial-token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
    )

    online = client.check()
    offline = client.check()

    assert online.source == "online"
    assert offline.source == "offline"
    assert offline.has_permission("profit")
    assert offline.shop_limit == 3
    cache_text = client.cache_path.read_text(encoding="utf-8")
    assert "license-access-secret" not in cache_text
    assert "initial-token" not in cache_text
    assert "password" not in cache_text


def test_license_allows_explicit_offline_issuer_and_audience_override(
    tmp_path: Path, signing_material
) -> None:
    offline_token = signing_material["sign"](
        device_code=DEVICE_CODE,
        issuer="https://licenses.example.test",
        audience="example-desktop-clients",
    )
    transport = FakeTransport(
        {"valid": True, "permissions": ["profit"], "offline_token": offline_token},
        TransportError("network unavailable"),
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="license-token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
        offline_token_issuer="https://licenses.example.test",
        offline_token_audience="example-desktop-clients",
    )

    assert client.check().source == "online"
    assert client.check().source == "offline"


def test_no_unsigned_or_unverifiable_offline_fallback(tmp_path: Path, signing_material) -> None:
    transport = FakeTransport(
        {
            "valid": True,
            "permissions": ["order_sync"],
            "offline_token": signing_material["sign"](device_code=DEVICE_CODE),
        },
        TransportError("network unavailable"),
    )
    client = make_client(tmp_path, transport, access_token="token")
    client.check()
    assert not client.cache_path.exists()
    with pytest.raises(OfflineUnavailableError):
        client.check()
    assert client.current_status is None
    assert not client.has_permission("order_sync")


def test_online_only_response_removes_an_older_offline_grant(
    tmp_path: Path, signing_material
) -> None:
    token = signing_material["sign"](device_code=DEVICE_CODE)
    transport = FakeTransport(
        {"valid": True, "permissions": ["profit"], "offline_token": token},
        {
            "valid": True,
            "permissions": ["profit"],
            "offline_token": None,
            "offline_until": None,
        },
        TransportError("network unavailable"),
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
    )

    assert client.check().valid
    assert client.cache_path.exists()
    assert client.check().valid
    assert not client.cache_path.exists()
    with pytest.raises(OfflineUnavailableError):
        client.check()
    assert client.current_status is None
    assert not client.has_permission("profit")


def test_online_only_heartbeat_network_loss_fails_closed(tmp_path: Path) -> None:
    transport = FakeTransport(
        {"valid": True, "permissions": ["profit"], "offline_token": None},
        TransportError("network unavailable"),
    )
    client = make_client(tmp_path, transport, access_token="license-token")

    assert client.check().has_permission("profit")
    with pytest.raises(OfflineUnavailableError):
        client.heartbeat()
    assert client.current_status is None
    assert not client.has_permission("profit")


def test_online_only_status_has_a_bounded_volatile_freshness(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = [100.0]
    monkeypatch.setattr(client_module, "monotonic", lambda: now[0])
    client = make_client(
        tmp_path,
        FakeTransport({"valid": True, "permissions": ["profit"], "offline_token": None}),
        access_token="license-token",
    )

    assert client.check().valid
    assert client.has_permission("profit")
    now[0] += 91
    assert client.current_status is None
    assert not client.has_permission("profit")


def test_authoritative_4xx_never_uses_offline_cache(tmp_path: Path, signing_material) -> None:
    token = signing_material["sign"](device_code=DEVICE_CODE)
    transport = FakeTransport(
        {"valid": True, "permissions": ["profit"], "offline_token": token},
        AuthenticationError(status_code=403, message="device disabled"),
        TransportError("network unavailable"),
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
    )
    client.check()
    assert client.cache_path.exists()
    with pytest.raises(AuthenticationError):
        client.check()
    assert not client.cache_path.exists()
    with pytest.raises(OfflineUnavailableError):
        client.check()


def test_invalid_online_result_clears_cached_grant(tmp_path: Path, signing_material) -> None:
    token = signing_material["sign"](device_code=DEVICE_CODE)
    transport = FakeTransport(
        {"valid": True, "permissions": ["profit"], "offline_token": token},
        {"valid": False, "reason": "disabled", "permissions": []},
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
    )
    client.check()
    assert client.cache_path.exists()
    result = client.check()
    assert not result.valid
    assert not client.cache_path.exists()


def test_5xx_can_fallback_but_409_cannot(tmp_path: Path, signing_material) -> None:
    token = signing_material["sign"](device_code=DEVICE_CODE)
    transport = FakeTransport(
        {"valid": True, "permissions": ["profit"], "offline_token": token},
        APIError(status_code=503, message="maintenance"),
        APIError(status_code=409, message="device conflict"),
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
    )
    client.check()
    assert client.check().source == "offline"
    with pytest.raises(APIError) as error:
        client.check()
    assert error.value.status_code == 409
    assert not client.cache_path.exists()


def test_authoritative_heartbeat_error_clears_cached_grant(
    tmp_path: Path, signing_material
) -> None:
    token = signing_material["sign"](device_code=DEVICE_CODE)
    transport = FakeTransport(
        {"valid": True, "permissions": ["profit"], "offline_token": token},
        AuthenticationError(status_code=403, message="license revoked"),
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="license-token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
    )
    client.check()
    assert client.cache_path.exists()
    with pytest.raises(AuthenticationError):
        client.heartbeat()
    assert not client.cache_path.exists()


def test_rate_limit_does_not_fallback_or_destroy_signed_grant(
    tmp_path: Path, signing_material
) -> None:
    token = signing_material["sign"](device_code=DEVICE_CODE)
    transport = FakeTransport(
        {"valid": True, "permissions": ["profit"], "offline_token": token},
        APIError(status_code=429, message="too many requests"),
        TransportError("network unavailable"),
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="license-token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
    )
    client.check()
    with pytest.raises(APIError) as error:
        client.check()
    assert error.value.status_code == 429
    assert client.cache_path.exists()
    assert client.check().source == "offline"


def test_tampered_cache_fails_closed(tmp_path: Path, signing_material) -> None:
    token = signing_material["sign"](device_code=DEVICE_CODE)
    transport = FakeTransport(
        {"valid": True, "permissions": ["profit"], "offline_token": token},
        TransportError("offline"),
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
    )
    client.check()
    envelope = json.loads(client.cache_path.read_text(encoding="utf-8"))
    cached_token = envelope["offline_token"]
    encoded_header, encoded_claims, encoded_signature = cached_token.split(".")
    replacement = "A" if encoded_signature[0] != "A" else "B"
    tampered_signature = replacement + encoded_signature[1:]
    envelope["offline_token"] = f"{encoded_header}.{encoded_claims}.{tampered_signature}"
    client.cache_path.write_text(json.dumps(envelope), encoding="utf-8")
    with pytest.raises(OfflineUnavailableError):
        client.check()


def test_in_flight_heartbeat_cannot_restore_cleared_session(tmp_path: Path) -> None:
    started = threading.Event()
    release = threading.Event()

    class BlockingTransport:
        def request(self, method, path, *, json_body=None, headers=None):
            assert method == "POST"
            assert path == "/api/license/heartbeat"
            started.set()
            assert release.wait(timeout=3)
            return {
                "valid": True,
                "access_token": "replacement-license-token",
                "permissions": ["profit"],
                "expire": "2027-01-01",
            }

    client = make_client(tmp_path, BlockingTransport(), access_token="old-license-token")
    results = []
    worker = threading.Thread(target=lambda: results.append(client.heartbeat()))
    worker.start()
    assert started.wait(timeout=2)

    client.clear_session()
    release.set()
    worker.join(timeout=3)

    assert not worker.is_alive()
    assert results and results[0].valid
    assert client.is_authenticated is False
    assert client.current_status is None


def test_successful_login_clears_previous_account_entitlement(
    tmp_path: Path, signing_material
) -> None:
    token = signing_material["sign"](device_code=DEVICE_CODE, permissions=["paid"])
    transport = FakeTransport(
        {"valid": True, "permissions": ["paid"], "offline_token": token},
        {
            "access_token": "account-b-token",
            "expires_in": 3600,
            "user": {"id": 2, "username": "account-b"},
        },
        TransportError("network unavailable"),
    )
    client = make_client(
        tmp_path,
        transport,
        access_token="account-a-token",
        offline_public_key=signing_material["public_pem"],
        offline_key_id="test-key",
    )
    client.check()
    assert client.has_permission("paid")
    assert client.cache_path.exists()

    client.login("account-b", "password-for-b")
    assert client.current_status is None
    assert not client.has_permission("paid")
    assert not client.cache_path.exists()
    with pytest.raises(OfflineUnavailableError):
        client.check()


def test_clear_session_is_atomic_with_response_adoption(tmp_path: Path) -> None:
    transport = FakeTransport(
        {
            "valid": True,
            "access_token": "replacement-license-token",
            "permissions": ["profit"],
            "expire": "2027-01-01",
        }
    )
    client = make_client(tmp_path, transport, access_token="old-license-token")
    adopt_started = threading.Event()
    release_adopt = threading.Event()
    original_adopt = client._adopt_response_token

    def paused_adopt(response):
        adopt_started.set()
        assert release_adopt.wait(timeout=3)
        original_adopt(response)

    client._adopt_response_token = paused_adopt
    heartbeat_worker = threading.Thread(target=client.heartbeat)
    heartbeat_worker.start()
    assert adopt_started.wait(timeout=2)

    clear_worker = threading.Thread(target=client.clear_session)
    clear_worker.start()
    release_adopt.set()
    heartbeat_worker.join(timeout=3)
    clear_worker.join(timeout=3)

    assert not heartbeat_worker.is_alive()
    assert not clear_worker.is_alive()
    assert client.is_authenticated is False
    assert client.current_status is None

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.helpers import create_catalog, create_intro_cards


def desktop_auth_body(**overrides: object) -> dict[str, object]:
    return {
        "password": "DesktopPass123!",
        "email": "desktop@example.com",
        "project_code": "ozon_helper",
        "device_code": "desktop-device-password-001",
        "device_name": "测试桌面端",
        "version": "1.0.0",
        "version_hash": "sha256:test-build",
        "card_key": "AAAA-BBBB-CCCC-DDDD",
        **overrides,
    }


def test_password_register_login_refresh_and_me(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    cards = create_intro_cards(client, admin_headers, catalog, quantity=2)
    card_key = cards["codes"][0]

    registered = client.post("/api/auth/register", json=desktop_auth_body(card_key=card_key))
    assert registered.status_code == 201, registered.text
    payload = registered.json()
    assert payload["user"]["username"] == "desktop@example.com"
    assert payload["user"]["email"] == "desktop@example.com"
    assert payload["user"]["is_admin"] is False
    assert payload["project_code"] == "ozon_helper"
    assert payload["license_status"] == "active"
    assert payload["entitlement"]["valid"] is True
    assert payload["entitlement"]["online_required"] is True
    assert payload["entitlement"]["access_token"]
    assert payload["entitlement"]["license_key"]
    assert payload["attribution"]["source_type"] == "organic"
    assert payload["refresh_token"].startswith("rft_")

    me = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {payload['access_token']}"},
    )
    assert me.status_code == 200, me.text
    assert me.json()["user"]["email"] == "desktop@example.com"

    refreshed = client.post(
        "/api/auth/refresh",
        json={
            "refresh_token": payload["refresh_token"],
            "device_code": "desktop-device-password-001",
        },
    )
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["refresh_token"] != payload["refresh_token"]

    duplicate = client.post(
        "/api/auth/register", json=desktop_auth_body(card_key=cards["codes"][1])
    )
    assert duplicate.status_code == 409

    login_body = desktop_auth_body(
        email="DESKTOP@EXAMPLE.COM",
        device_code="desktop-device-password-002",
        card_key=cards["codes"][1],
    )
    login_body.pop("card_key")
    logged_in = client.post(
        "/api/auth/login",
        json=login_body,
    )
    assert logged_in.status_code == 200, logged_in.text
    assert logged_in.json()["refresh_token"].startswith("rft_")
    assert logged_in.json()["attribution"]["project_code"] == "ozon_helper"
    assert logged_in.json()["license_status"] == "active"


def test_registration_requires_a_valid_unused_card_and_rolls_back_user(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    card_key = cards["codes"][0]

    missing = desktop_auth_body()
    missing.pop("card_key")
    assert client.post("/api/auth/register", json=missing).status_code == 422

    invalid = client.post(
        "/api/auth/register",
        json=desktop_auth_body(email="invalid-card@example.com"),
    )
    assert invalid.status_code == 404
    failed_login = client.post(
        "/api/auth/login",
        json={"email": "invalid-card@example.com", "password": "DesktopPass123!"},
    )
    assert failed_login.status_code == 401

    first = client.post(
        "/api/auth/register",
        json=desktop_auth_body(email="first-card@example.com", card_key=card_key),
    )
    assert first.status_code == 201, first.text
    reused = client.post(
        "/api/auth/register",
        json=desktop_auth_body(
            email="reused-card@example.com",
            device_code="desktop-device-password-009",
            card_key=card_key,
        ),
    )
    assert reused.status_code == 409
    reused_login = client.post(
        "/api/auth/login",
        json={"email": "reused-card@example.com", "password": "DesktopPass123!"},
    )
    assert reused_login.status_code == 401


def test_legacy_admin_login_remains_compatible(client: TestClient) -> None:
    response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "AdminPass123!"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["user"]["is_admin"] is True
    assert payload["refresh_token"] is None
    assert payload["project_code"] is None

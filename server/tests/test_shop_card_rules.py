from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.models import ActivationCode, License, PointWallet, ShopIntroRedemption
from app.services.identity_service import phone_hash
from tests.helpers import (
    create_cards,
    create_catalog,
    create_intro_cards,
    create_intro_plan,
    create_user,
    login_user,
)


def _registration_body(card_key: str, email: str = "shop-owner@example.com") -> dict[str, str]:
    return {
        "password": "ShopOwnerPass123!",
        "email": email,
        "project_code": "ozon_helper",
        "device_code": "register-device-001",
        "device_name": "注册电脑",
        "version": "1.0.0",
        "version_hash": "sha256:test-build",
        "card_key": card_key,
    }


def _activate(
    client: TestClient,
    headers: dict[str, str],
    card_key: str,
    device_code: str = "shop-device-002",
):
    return client.post(
        "/api/license/activate",
        headers=headers,
        json={
            "card_key": card_key,
            "project_code": "ozon_helper",
            "device_code": device_code,
            "device_name": "店铺电脑",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )


def _bind(
    client: TestClient,
    headers: dict[str, str],
    license_key: str,
    shop_id: str,
):
    return client.post(
        "/api/shops/bind",
        headers=headers,
        json={
            "license_key": license_key,
            "project_code": "ozon_helper",
            "platform": "ozon",
            "shop_name": f"Ozon {shop_id}",
            "shop_id": shop_id,
        },
    )


@pytest.mark.parametrize(
    ("name", "license_role", "sale_price_cent", "duration_days", "max_shops"),
    [
        ("错误首店价格", "shop_intro", 2000, 30, 1),
        ("错误首店周期", "shop_intro", 1990, 31, 1),
        ("错误月卡价格", "shop_standard_monthly", 4999, 30, 1),
        ("错误月卡店铺数", "shop_standard_monthly", 5000, 30, 2),
        ("错误年卡周期", "shop_standard_annual", 50000, 364, 1),
        ("错误年卡价格", "shop_standard_annual", 59999, 365, 1),
    ],
)
def test_shop_card_plan_rules_are_server_enforced(
    client: TestClient,
    admin_headers: dict[str, str],
    name: str,
    license_role: str,
    sale_price_cent: int,
    duration_days: int,
    max_shops: int,
) -> None:
    catalog = create_catalog(client, admin_headers)
    response = client.post(
        "/api/admin/plans",
        headers=admin_headers,
        json={
            "product_id": catalog["product"]["id"],
            "name": name,
            "price": f"{sale_price_cent / 100:.2f}",
            "sale_price_cent": sale_price_cent,
            "license_role": license_role,
            "duration_days": duration_days,
            "max_devices": 1,
            "max_shops": max_shops,
            "permission_ids": [],
        },
    )
    assert response.status_code == 422, response.text


def test_registration_requires_intro_card_and_records_offer_once(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    standard_cards = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=1)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=2)

    wrong_card = client.post(
        "/api/auth/register",
        json=_registration_body(standard_cards["codes"][0]),
    )
    assert wrong_card.status_code == 409
    assert (
        client.post(
            "/api/auth/login",
            json={"email": "shop-owner@example.com", "password": "ShopOwnerPass123!"},
        ).status_code
        == 401
    )

    registered = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][0]),
    )
    assert registered.status_code == 201, registered.text
    payload = registered.json()
    headers = {"Authorization": f"Bearer {payload['access_token']}"}
    second_intro = _activate(client, headers, intro_cards["codes"][1])
    assert second_intro.status_code == 409

    with client.app.state.session_factory() as db:
        assert db.scalar(select(func.count(ShopIntroRedemption.id))) == 1
        assert db.scalar(select(func.count(License.id))) == 1
        unused_standard = db.scalar(
            select(ActivationCode).where(ActivationCode.plan_id == catalog["plan"]["id"])
        )
        assert unused_standard is not None
        assert unused_standard.status == "unused"


def test_sms_registration_requires_intro_card_but_existing_user_can_login_without_it(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    body = {
        "phone": "13800138888",
        "scene": "login_or_register",
        "project_code": "ozon_helper",
        "device_code": "sms-register-device",
        "device_name": "短信注册电脑",
        "version": "1.0.0",
        "version_hash": "sha256:test-build",
    }

    first_code = client.post("/api/auth/sms/send", json=body).json()["development_code"]
    missing_card = client.post(
        "/api/auth/sms/verify",
        json={**body, "code": first_code},
    )
    assert missing_card.status_code == 422
    digest = phone_hash(client.app.state.settings, body["phone"])
    client.app.state.otp_service.store.cancel(f"{catalog['project']['id']}:{digest}")

    second_code = client.post("/api/auth/sms/send", json=body).json()["development_code"]
    registered = client.post(
        "/api/auth/sms/verify",
        json={
            **body,
            "code": second_code,
            "card_key": intro_cards["codes"][0],
        },
    )
    assert registered.status_code == 200, registered.text
    assert registered.json()["license_status"] == "active"
    assert registered.json()["entitlement"]["valid"] is True

    client.app.state.otp_service.store.cancel(f"{catalog['project']['id']}:{digest}")
    third_code = client.post("/api/auth/sms/send", json=body).json()["development_code"]
    logged_in = client.post(
        "/api/auth/sms/verify",
        json={**body, "code": third_code},
    )
    assert logged_in.status_code == 200, logged_in.text
    assert logged_in.json()["user"]["id"] == registered.json()["user"]["id"]
    assert logged_in.json()["entitlement"] is None


def test_self_unbind_stays_scoped_but_admin_delete_releases_card_and_shop(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    standard_cards = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=1)
    registered = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][0]),
    ).json()
    user_headers = {"Authorization": f"Bearer {registered['access_token']}"}
    first_license = registered["entitlement"]
    first_headers = {"Authorization": f"Bearer {first_license['access_token']}"}

    first_shop = _bind(client, first_headers, first_license["license_key"], "ozon-shop-1")
    assert first_shop.status_code == 201, first_shop.text
    assert (
        client.delete(f"/api/shops/{first_shop.json()['id']}", headers=first_headers).status_code
        == 204
    )
    switched = _bind(client, first_headers, first_license["license_key"], "ozon-shop-2")
    assert switched.status_code == 409
    rebound = _bind(client, first_headers, first_license["license_key"], "ozon-shop-1")
    assert rebound.status_code == 201, rebound.text
    hard_delete = client.delete(
        f"/api/admin/shops/{first_shop.json()['id']}", headers=admin_headers
    )
    assert hard_delete.status_code == 204

    second_license = _activate(client, user_headers, standard_cards["codes"][0])
    assert second_license.status_code == 200, second_license.text
    second_payload = second_license.json()
    second_headers = {"Authorization": f"Bearer {second_payload['access_token']}"}
    duplicate_shop = _bind(
        client,
        second_headers,
        second_payload["license_key"],
        "ozon-shop-1",
    )
    assert duplicate_shop.status_code == 201, duplicate_shop.text
    reassigned_first_card = _bind(
        client,
        first_headers,
        first_license["license_key"],
        "ozon-shop-2",
    )
    assert reassigned_first_card.status_code == 201, reassigned_first_card.text


def test_new_shop_activation_and_binding_are_atomic_and_duplicate_safe(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    standard_cards = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=2)
    registered = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][0]),
    ).json()
    user_headers = {"Authorization": f"Bearer {registered['access_token']}"}
    first_license = registered["entitlement"]
    first_headers = {"Authorization": f"Bearer {first_license['access_token']}"}
    assert (
        _bind(
            client,
            first_headers,
            first_license["license_key"],
            "ozon-shop-1",
        ).status_code
        == 201
    )

    request = {
        "card_key": standard_cards["codes"][0],
        "project_code": "ozon_helper",
        "device_code": "shop-device-002",
        "device_name": "新增店铺电脑",
        "version": "1.0.0",
        "version_hash": "sha256:test-build",
        "shop_name": "Ozon 第二店",
        "shop_id": "ozon-shop-2",
    }
    activated = client.post("/api/license/activate-shop", headers=user_headers, json=request)
    assert activated.status_code == 200, activated.text
    duplicate = client.post(
        "/api/license/activate-shop",
        headers=user_headers,
        json={
            **request,
            "card_key": standard_cards["codes"][1],
            "shop_id": "ozon-shop-1",
        },
    )
    assert duplicate.status_code == 409

    entitlements = client.get(
        "/api/license/entitlements?project_code=ozon_helper",
        headers=user_headers,
    )
    assert entitlements.status_code == 200, entitlements.text
    assert len(entitlements.json()) == 2
    assert {
        shop["shop_id"] for entitlement in entitlements.json() for shop in entitlement["shops"]
    } == {"ozon-shop-1", "ozon-shop-2"}
    with client.app.state.session_factory() as db:
        assert db.scalar(select(func.count(License.id))) == 2
        unused = db.scalar(
            select(ActivationCode).where(
                ActivationCode.plan_id == catalog["plan"]["id"],
                ActivationCode.status == "unused",
            )
        )
        assert unused is not None


def test_additional_shop_two_step_flow_consumes_card_before_owned_binding(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    standard_cards = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=1)
    registered = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][0]),
    ).json()
    user_headers = {"Authorization": f"Bearer {registered['access_token']}"}
    first_license = registered["entitlement"]
    first_headers = {"Authorization": f"Bearer {first_license['access_token']}"}
    assert (
        _bind(
            client,
            first_headers,
            first_license["license_key"],
            "ozon-shop-1",
        ).status_code
        == 201
    )

    activated = _activate(client, user_headers, standard_cards["codes"][0])
    assert activated.status_code == 200, activated.text
    entitlements = client.get(
        "/api/license/entitlements?project_code=ozon_helper",
        headers=user_headers,
    )
    assert entitlements.status_code == 200, entitlements.text
    pending = [
        item
        for item in entitlements.json()
        if item["license_role"] == "shop_standard_monthly" and not item["shops"]
    ]
    assert len(pending) == 1

    bound = client.post(
        "/api/license/bind-shop",
        headers=user_headers,
        json={
            "license_id": pending[0]["license_id"],
            "project_code": "ozon_helper",
            "shop_name": "Ozon 第二店",
            "shop_id": "ozon-shop-2",
        },
    )
    assert bound.status_code == 201, bound.text
    assert bound.json()["shop_id"] == "ozon-shop-2"

    replay = _activate(client, user_headers, standard_cards["codes"][0])
    assert replay.status_code == 409
    assert replay.json()["detail"] == "Activation code is unavailable"


def test_user_can_bind_only_their_own_unbound_license_by_id(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=2)
    first = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][0], "first-owner@example.com"),
    ).json()
    second = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][1], "second-owner@example.com"),
    ).json()
    first_headers = {"Authorization": f"Bearer {first['access_token']}"}
    second_headers = {"Authorization": f"Bearer {second['access_token']}"}
    first_license_id = client.get(
        "/api/license/entitlements?project_code=ozon_helper",
        headers=first_headers,
    ).json()[0]["license_id"]
    request = {
        "license_id": first_license_id,
        "project_code": "ozon_helper",
        "shop_name": "第一店",
        "shop_id": "client-first-shop",
    }

    forbidden = client.post("/api/license/bind-shop", headers=second_headers, json=request)
    assert forbidden.status_code == 404
    bound = client.post("/api/license/bind-shop", headers=first_headers, json=request)
    assert bound.status_code == 201, bound.text
    assert bound.json()["shop_id"] == "client-first-shop"
    switched = client.post(
        "/api/license/bind-shop",
        headers=first_headers,
        json={**request, "shop_id": "client-other-shop"},
    )
    assert switched.status_code == 409


def test_standard_shop_card_does_not_replace_the_desktop_account_license(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    standard_cards = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=1)
    registered = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][0]),
    ).json()
    user_headers = {"Authorization": f"Bearer {registered['access_token']}"}

    add_on = _activate(client, user_headers, standard_cards["codes"][0])
    assert add_on.status_code == 200, add_on.text
    assert add_on.json()["license_role"] == "shop_standard_monthly"

    checked = client.post(
        "/api/license/check",
        headers=user_headers,
        json={
            "project_code": "ozon_helper",
            "device_code": "register-device-001",
            "device_name": "注册电脑",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert checked.status_code == 200, checked.text
    assert checked.json()["license_role"] == "shop_intro"
    assert checked.json()["expire"] == registered["entitlement"]["expire"]


def test_standard_card_renews_the_same_shop_license_without_creating_another(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=2)
    standard_cards = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=1)
    registered = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][0]),
    ).json()
    headers = {"Authorization": f"Bearer {registered['access_token']}"}
    original = registered["entitlement"]
    original_expire = datetime.fromisoformat(original["expire"])
    renewal_body = {
        "license_key": original["license_key"],
        "card_key": standard_cards["codes"][0],
        "project_code": "ozon_helper",
        "device_code": "register-device-001",
        "device_name": "注册电脑",
        "version": "1.0.0",
        "version_hash": "sha256:test-build",
    }

    intro_renewal = client.post(
        "/api/license/renew",
        headers=headers,
        json={**renewal_body, "card_key": intro_cards["codes"][1]},
    )
    assert intro_renewal.status_code == 409

    renewed = client.post("/api/license/renew", headers=headers, json=renewal_body)
    assert renewed.status_code == 200, renewed.text
    renewed_payload = renewed.json()
    assert renewed_payload["license_key"] == original["license_key"]
    assert (datetime.fromisoformat(renewed_payload["expire"]) - original_expire).days == 30
    assert client.post("/api/license/renew", headers=headers, json=renewal_body).status_code == 409

    with client.app.state.session_factory() as db:
        licenses = db.scalars(select(License)).all()
        assert len(licenses) == 1
        assert licenses[0].plan_id == catalog["plan"]["id"]
        activated = db.scalar(
            select(ActivationCode).where(
                ActivationCode.activated_license_id == licenses[0].id,
                ActivationCode.plan_id == catalog["plan"]["id"],
            )
        )
        assert activated is not None
        assert activated.status == "activated"


def test_standard_annual_card_is_fixed_at_six_hundred_yuan_and_renews_365_days(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    annual = client.post(
        "/api/admin/plans",
        headers=admin_headers,
        json={
            "product_id": catalog["product"]["id"],
            "name": "标准店铺年卡",
            "price": "1.00",
            "sale_price_cent": 60000,
            "online_sale_enabled": True,
            "license_role": "shop_standard_annual",
            "duration_days": 365,
            "max_devices": 1,
            "max_shops": 1,
            "permission_ids": [],
        },
    )
    assert annual.status_code == 201, annual.text
    assert Decimal(annual.json()["price"]) == Decimal("600.00")
    annual_cards = create_cards(client, admin_headers, annual.json()["id"], quantity=1)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    registered = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][0]),
    ).json()
    original = registered["entitlement"]
    entitlements = client.get(
        "/api/license/entitlements?project_code=ozon_helper",
        headers={"Authorization": f"Bearer {registered['access_token']}"},
    ).json()
    renewed = client.post(
        "/api/license/renew",
        headers={"Authorization": f"Bearer {registered['access_token']}"},
        json={
            "license_id": entitlements[0]["license_id"],
            "card_key": annual_cards["codes"][0],
            "project_code": "ozon_helper",
            "device_code": "register-device-001",
            "device_name": "注册电脑",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert renewed.status_code == 200, renewed.text
    assert (
        datetime.fromisoformat(renewed.json()["expire"])
        - datetime.fromisoformat(original["expire"])
    ).days == 365


def test_account_has_one_shared_point_wallet_across_multiple_shop_cards(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_cards = create_intro_cards(client, admin_headers, catalog, quantity=1)
    standard_cards = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=2)
    registered = client.post(
        "/api/auth/register",
        json=_registration_body(intro_cards["codes"][0]),
    ).json()
    headers = {"Authorization": f"Bearer {registered['access_token']}"}
    assert (
        _activate(client, headers, standard_cards["codes"][0], "shop-device-002").status_code == 200
    )
    assert (
        _activate(client, headers, standard_cards["codes"][1], "shop-device-003").status_code == 200
    )

    first = client.get(
        "/api/points/wallet?project_code=ozon_helper",
        headers=headers,
    )
    second = client.get(
        "/api/points/wallet?project_code=ozon_helper",
        headers=headers,
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["wallet_id"] == second.json()["wallet_id"]
    assert first.json()["user_id"] == registered["user"]["id"]
    with client.app.state.session_factory() as db:
        assert db.scalar(select(func.count(License.id))) == 3
        assert db.scalar(select(func.count(PointWallet.id))) == 1


def test_intro_and_legacy_plans_are_never_exposed_in_the_account_store(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    intro_plan = create_intro_plan(client, admin_headers, catalog)
    assert (
        client.put(
            f"/api/admin/plans/{intro_plan['id']}",
            headers=admin_headers,
            json={"online_sale_enabled": True},
        ).status_code
        == 200
    )
    legacy = client.post(
        "/api/admin/plans",
        headers=admin_headers,
        json={
            "product_id": catalog["product"]["id"],
            "name": "历史兼容套餐",
            "price": "10.00",
            "sale_price_cent": 1000,
            "online_sale_enabled": True,
            "license_role": "legacy",
            "duration_days": 30,
            "max_devices": 1,
            "max_shops": 5,
            "permission_ids": [],
        },
    )
    assert legacy.status_code == 201, legacy.text
    assert (
        client.put(
            f"/api/admin/plans/{catalog['plan']['id']}",
            headers=admin_headers,
            json={"online_sale_enabled": True},
        ).status_code
        == 200
    )

    store = client.get("/api/store/plans?project_code=ozon_helper")
    assert store.status_code == 200, store.text
    assert [item["id"] for item in store.json()["items"]] == [catalog["plan"]["id"]]
    assert store.json()["items"][0]["sale_price_cent"] == 5000


def test_legacy_license_is_an_exact_shop_entitlement_only_after_shop_binding(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    legacy = client.post(
        "/api/admin/plans",
        headers=admin_headers,
        json={
            "product_id": catalog["product"]["id"],
            "name": "历史多店兼容年卡",
            "price": "600.00",
            "sale_price_cent": 60000,
            "license_role": "legacy",
            "duration_days": 365,
            "max_devices": 2,
            "max_shops": 5,
            "permission_ids": [],
        },
    )
    assert legacy.status_code == 201, legacy.text
    user = create_user(client, admin_headers)
    granted = client.post(
        "/api/admin/licenses",
        headers=admin_headers,
        json={"user_id": user["id"], "plan_id": legacy.json()["id"], "status": "active"},
    )
    assert granted.status_code == 201, granted.text
    user_headers = login_user(client)

    before = client.get(
        "/api/license/entitlements?project_code=ozon_helper",
        headers=user_headers,
    )
    assert before.status_code == 200, before.text
    assert all(item["license_id"] != granted.json()["id"] for item in before.json())

    bound = client.post(
        "/api/license/bind-shop",
        headers=user_headers,
        json={
            "license_id": granted.json()["id"],
            "project_code": "ozon_helper",
            "shop_name": "历史 Ozon 1店",
            "shop_id": "legacy-exact-client-1",
        },
    )
    assert bound.status_code == 201, bound.text

    after = client.get(
        "/api/license/entitlements?project_code=ozon_helper",
        headers=user_headers,
    )
    assert after.status_code == 200, after.text
    migrated = next(item for item in after.json() if item["license_id"] == granted.json()["id"])
    assert migrated["license_role"] == "legacy"
    assert migrated["shops"] == [
        {
            "id": bound.json()["id"],
            "shop_name": "历史 Ozon 1店",
            "shop_id": "legacy-exact-client-1",
            "status": "active",
        }
    ]


def test_shop_card_batch_cannot_override_entitlement_duration(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = create_catalog(client, admin_headers)
    response = client.post(
        "/api/admin/card-batches",
        headers=admin_headers,
        json={
            "plan_id": catalog["plan"]["id"],
            "quantity": 1,
            "validity_days": 31,
        },
    )
    assert response.status_code == 422, response.text

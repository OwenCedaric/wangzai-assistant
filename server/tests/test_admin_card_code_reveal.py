from __future__ import annotations

import json
from datetime import datetime

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from tests.helpers import create_cards, create_catalog, create_user, login_user


def test_revealed_codes_are_paginated_no_store_and_audited_without_secrets(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    batch = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=3)

    masked = client.get(f"/api/admin/card-batches/{batch['id']}/codes", headers=admin_headers)
    assert masked.status_code == 200
    assert all(card_key not in masked.text for card_key in batch["codes"])

    revealed = client.get(
        f"/api/admin/card-batches/{batch['id']}/codes/revealed?page=1&page_size=2",
        headers=admin_headers,
    )
    assert revealed.status_code == 200, revealed.text
    assert revealed.headers["cache-control"] == "no-store, private"
    assert revealed.headers["pragma"] == "no-cache"
    payload = revealed.json()
    assert payload["total"] == 3
    assert payload["page"] == 1
    assert payload["page_size"] == 2
    assert [item["card_key"] for item in payload["items"]] == batch["codes"][:2]
    assert "code_hash" not in revealed.text
    assert "code_ciphertext" not in revealed.text

    logs_response = client.get(
        "/api/admin/usage-logs?event=card_codes_revealed", headers=admin_headers
    )
    assert logs_response.status_code == 200
    logs = logs_response.json()
    assert logs["total"] == 1
    assert logs["items"][0]["details"] == {
        "batch_id": batch["id"],
        "page": 1,
        "page_size": 2,
        "revealed_count": 2,
    }
    serialized_logs = json.dumps(logs, ensure_ascii=False)
    assert all(card_key not in serialized_logs for card_key in batch["codes"])


def test_revealed_code_search_matches_exact_hash_and_fuzzy_prefix_without_leaks(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    batch = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=4)
    url = f"/api/admin/card-batches/{batch['id']}/codes/revealed"
    search_url = f"{url}/search"
    expected_code = batch["codes"][1]

    initial = client.get(url, headers=admin_headers, params={"page": 1, "page_size": 2})
    assert initial.status_code == 200, initial.text
    assert initial.json()["total"] == 4
    assert len(initial.json()["items"]) == 2

    exact = client.post(
        search_url,
        headers=admin_headers,
        json={"q": f"  {expected_code.lower()}  ", "page": 1, "page_size": 1},
    )
    assert exact.status_code == 200, exact.text
    assert expected_code.lower() not in str(exact.request.url)
    assert "q=" not in str(exact.request.url)
    assert exact.json()["total"] == 1
    assert [item["card_key"] for item in exact.json()["items"]] == [expected_code]

    prefix_fragment = expected_code[1:8].lower()
    prefix = client.post(
        search_url,
        headers=admin_headers,
        json={"q": f" {prefix_fragment} ", "page": 1, "page_size": 2},
    )
    assert prefix.status_code == 200, prefix.text
    assert prefix.json()["total"] >= 1
    assert expected_code in [item["card_key"] for item in prefix.json()["items"]]

    missing = client.post(
        search_url,
        headers=admin_headers,
        json={"q": "不存在的卡密", "page": 1, "page_size": 100},
    )
    assert missing.status_code == 200, missing.text
    assert missing.json()["total"] == 0
    assert missing.json()["items"] == []

    masked = client.get(
        f"/api/admin/card-batches/{batch['id']}/codes",
        headers=admin_headers,
    )
    assert masked.status_code == 200
    assert "card_key" not in masked.text
    assert "code_hash" not in masked.text
    assert "code_ciphertext" not in masked.text
    assert all(card_key not in masked.text for card_key in batch["codes"])

    logs_response = client.get(
        "/api/admin/usage-logs?event=card_codes_revealed", headers=admin_headers
    )
    assert logs_response.status_code == 200
    serialized_logs = json.dumps(logs_response.json(), ensure_ascii=False)
    assert expected_code not in serialized_logs
    assert expected_code.lower() not in serialized_logs
    assert prefix_fragment not in serialized_logs
    assert "不存在的卡密" not in serialized_logs
    assert all("q" not in item["details"] for item in logs_response.json()["items"])


def test_revealed_codes_require_admin_and_reject_unknown_batch(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    create_user(client, admin_headers)
    user_headers = login_user(client)
    url = "/api/admin/card-batches/999999/codes/revealed"

    assert client.get(url).status_code == 401
    assert client.get(url, headers=user_headers).status_code == 403
    assert client.get(url, headers=admin_headers).status_code == 404


def test_card_details_include_exact_bound_shop_and_license_expiry(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    create_user(client, admin_headers)
    user_headers = login_user(client)
    batch = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=1)

    activated = client.post(
        "/api/license/activate",
        headers=user_headers,
        json={
            "card_key": batch["codes"][0],
            "project_code": "ozon_helper",
            "device_code": "card-binding-device-0001",
            "device_name": "Card binding workstation",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert activated.status_code == 200, activated.text
    license_payload = activated.json()
    bound = client.post(
        "/api/shops/bind",
        headers={"Authorization": f"Bearer {license_payload['access_token']}"},
        json={
            "license_key": license_payload["license_key"],
            "project_code": "ozon_helper",
            "platform": "ozon",
            "shop_name": "Ozon 测试店",
            "shop_id": "4067587",
        },
    )
    assert bound.status_code == 201, bound.text

    masked = client.get(
        f"/api/admin/card-batches/{batch['id']}/codes",
        headers=admin_headers,
    )
    assert masked.status_code == 200, masked.text
    masked_code = masked.json()["items"][0]
    masked_expire = datetime.fromisoformat(masked_code["activated_license_expire_at"])
    activated_expire = datetime.fromisoformat(
        license_payload["expire"].replace("Z", "+00:00")
    ).replace(tzinfo=None)
    assert masked_expire == activated_expire
    assert masked_code["bound_shops"] == [
        {
            "id": bound.json()["id"],
            "license_id": bound.json()["license_id"],
            "platform": "ozon",
            "shop_name": "Ozon 测试店",
            "shop_id": "4067587",
            "status": "active",
        }
    ]
    assert batch["codes"][0] not in masked.text

    revealed = client.get(
        f"/api/admin/card-batches/{batch['id']}/codes/revealed",
        headers=admin_headers,
    )
    assert revealed.status_code == 200, revealed.text
    revealed_code = revealed.json()["items"][0]
    assert revealed_code["bound_shops"] == masked_code["bound_shops"]
    assert (
        revealed_code["activated_license_expire_at"]
        == masked_code["activated_license_expire_at"]
    )


def test_revealed_codes_report_missing_or_mismatched_encryption_key(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    batch = create_cards(client, admin_headers, catalog["plan"]["id"], quantity=1)
    url = f"/api/admin/card-batches/{batch['id']}/codes/revealed"
    settings = client.app.state.settings
    original_key = settings.card_encryption_key

    try:
        settings.card_encryption_key = None
        missing_key = client.get(url, headers=admin_headers)
        assert missing_key.status_code == 409
        assert "CARD_ENCRYPTION_KEY" in missing_key.json()["detail"]

        settings.card_encryption_key = Fernet.generate_key().decode("ascii")
        mismatched_key = client.get(url, headers=admin_headers)
        assert mismatched_key.status_code == 409
        assert "does not match" in mismatched_key.json()["detail"]
    finally:
        settings.card_encryption_key = original_key

    logs = client.get("/api/admin/usage-logs?event=card_codes_revealed", headers=admin_headers)
    assert logs.status_code == 200
    assert logs.json()["total"] == 0

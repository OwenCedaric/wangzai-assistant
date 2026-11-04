from __future__ import annotations

import base64
import hashlib
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.api.protected_compute import _has_capability_permission
from app.protected_compute.canonical import canonical_json, canonical_sha256
from app.protected_compute.registry import CapabilityContractError, get_capability
from scripts.build_protected_compute_public_config import (
    build_signed_public_config,
    write_desktop_bundle,
)
from tests.helpers import create_cards, create_catalog, create_user, login_user


def test_capability_permissions_are_exact_with_only_the_legacy_profit_alias() -> None:
    assert _has_capability_permission("profit.view", {"profit"}) is True
    assert _has_capability_permission("profit.view", {"profit.view"}) is True
    assert _has_capability_permission("profit.view", {"orders.view"}) is False
    assert _has_capability_permission("collection_pricing.use", {"collection_pricing.use"}) is True
    assert _has_capability_permission("collection_pricing.use", {"profit"}) is False
    assert _has_capability_permission("collection_pricing.use", {"profit.view"}) is False


def test_currency_contract_is_ascii_only_for_inputs_and_signed_results() -> None:
    profitability = get_capability("profitability.quote", 1)
    profitability_input = _request_payload()["input"]
    normalized = profitability.normalize({**profitability_input, "currency": " rub "})
    assert normalized["currency"] == "RUB"

    collection = get_capability("collection-pricing.quote", 1)
    collection_input = _collection_pricing_request_payload()["input"]
    assert collection.normalize({**collection_input, "currency": "cny"})["currency"] == "CNY"

    for descriptor, payload in (
        (profitability, profitability_input),
        (collection, collection_input),
    ):
        for currency in ("РУБ", "ＣＮＹ", "RÜB", "RUB1"):
            with pytest.raises(CapabilityContractError):
                descriptor.normalize({**payload, "currency": currency})

        result = descriptor.execute(descriptor.normalize(payload))
        with pytest.raises(CapabilityContractError):
            descriptor.validate_result({**result, "currency": "РУБ"})


def _activate_license(
    client: TestClient,
    admin_headers: dict[str, str],
    *,
    offline_hours: int = 24,
    permission_codes: tuple[str, ...] = ("profit",),
) -> dict[str, str]:
    catalog = create_catalog(client, admin_headers)
    imported = client.post(
        "/api/admin/projects/import",
        headers=admin_headers,
        json={
            "name": "Ozon助手",
            "code": "ozon_helper",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
            "modules": [
                {"code": "order_sync", "name": "订单同步"},
                {"code": "profit", "name": "利润分析"},
                {"code": "collection_pricing.use", "name": "采集核价"},
            ],
        },
    )
    assert imported.status_code == 200, imported.text
    permissions_response = client.get(
        f"/api/admin/permissions?project_id={catalog['project']['id']}",
        headers=admin_headers,
    )
    assert permissions_response.status_code == 200, permissions_response.text
    permissions = permissions_response.json()["items"]
    selected_permission_ids = [
        permission["id"] for permission in permissions if permission["code"] in permission_codes
    ]
    assert len(selected_permission_ids) == len(permission_codes)
    updated = client.put(
        f"/api/admin/plans/{catalog['plan']['id']}",
        headers=admin_headers,
        json={
            "offline_hours": offline_hours,
            "permission_ids": selected_permission_ids,
        },
    )
    assert updated.status_code == 200, updated.text
    create_user(client, admin_headers)
    cards = create_cards(client, admin_headers, catalog["plan"]["id"])
    user_headers = login_user(client)
    activated = client.post(
        "/api/license/activate",
        headers=user_headers,
        json={
            "card_key": cards["codes"][0],
            "project_code": "ozon_helper",
            "device_code": "protected-compute-device",
            "device_name": "Protected compute test",
            "version": "1.0.0",
            "version_hash": "sha256:test-build",
        },
    )
    assert activated.status_code == 200, activated.text
    return {"Authorization": f"Bearer {activated.json()['access_token']}"}


def _request_payload(**input_overrides: object) -> dict[str, object]:
    input_payload = {
        "acquiringBasisPoints": 150,
        "commissionBasisPoints": 1_700,
        "costMinor": 2_500,
        "currency": "RUB",
        "logisticsMinor": 600,
        "salePriceMinor": 5_516,
        "taxBasisPoints": 600,
        **input_overrides,
    }
    return {
        "capability": "profitability.quote",
        "contract": "protected-compute-request/v1",
        "input": input_payload,
        "inputHash": canonical_sha256(input_payload),
        "issuedAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "nonce": base64.urlsafe_b64encode(uuid4().bytes + uuid4().bytes).rstrip(b"=").decode(),
        "requestId": str(uuid4()),
        "version": 1,
    }


def _collection_pricing_request_payload(**input_overrides: object) -> dict[str, object]:
    input_payload = {
        "commissionBasisPoints": 1_700,
        "currency": "CNY",
        "currentPriceMinor": 5_516,
        "extraCostMinor": 100,
        "firstMileCostMinor": 600,
        "purchaseCostMinor": 2_500,
        "targetMarginBasisPoints": 2_000,
        **input_overrides,
    }
    return {
        "capability": "collection-pricing.quote",
        "contract": "protected-compute-request/v1",
        "input": input_payload,
        "inputHash": canonical_sha256(input_payload),
        "issuedAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "nonce": base64.urlsafe_b64encode(uuid4().bytes + uuid4().bytes).rstrip(b"=").decode(),
        "requestId": str(uuid4()),
        "version": 1,
    }


def test_protected_compute_returns_input_bound_ed25519_envelope(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    license_headers = _activate_license(client, admin_headers)
    public_keys = client.get("/api/protected-compute/public-keys")
    assert public_keys.status_code == 200, public_keys.text
    assert public_keys.json()["provisioningOnly"] is True
    public_key = serialization.load_pem_public_key(
        public_keys.json()["keys"][0]["publicKeyPem"].encode()
    )

    request_payload = _request_payload()
    response = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=request_payload,
    )
    assert response.status_code == 200, response.text
    envelope = response.json()
    signature = base64.urlsafe_b64decode(envelope.pop("signature") + "==")
    public_key.verify(signature, canonical_json(envelope))
    assert envelope["capability"] == "profitability.quote"
    assert envelope["version"] == 1
    assert envelope["requestId"] == request_payload["requestId"]
    assert envelope["nonce"] == request_payload["nonce"]
    assert envelope["inputHash"] == request_payload["inputHash"]
    assert envelope["offlinePolicy"] == {
        "allowed": True,
        "maxUses": 3,
        "scope": "input-hash",
    }
    assert set(envelope["result"]) == {
        "contributionMinor",
        "currency",
        "decision",
        "marginBasisPoints",
    }
    assert "reserve" not in str(envelope["result"]).lower()

    replay = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=request_payload,
    )
    assert replay.status_code == 409
    assert replay.json()["detail"]["code"] == "PROTECTED_COMPUTE_REQUEST_REPLAYED"


def test_collection_pricing_real_capability_returns_only_signed_typed_advice(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    license_headers = _activate_license(
        client,
        admin_headers,
        permission_codes=("collection_pricing.use",),
    )
    request_payload = _collection_pricing_request_payload()
    response = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=request_payload,
    )
    assert response.status_code == 200, response.text
    envelope = response.json()
    assert envelope["capability"] == "collection-pricing.quote"
    assert envelope["inputHash"] == request_payload["inputHash"]
    assert envelope["offlinePolicy"] == {
        "allowed": True,
        "maxUses": 3,
        "scope": "input-hash",
    }
    assert envelope["result"] == {
        "breakEvenPriceMinor": 3_856,
        "currency": "CNY",
        "currentMarginBasisPoints": 2_498,
        "currentProfitMinor": 1_378,
        "suggestedPriceMinor": 4_627,
        "totalCostMinor": 3_200,
    }
    serialized = str(envelope)
    assert "commissionCharge" not in serialized
    assert "denominator" not in serialized
    assert "_POLICY_" not in serialized

    forbidden_profitability = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=_request_payload(),
    )
    assert forbidden_profitability.status_code == 403
    assert (
        forbidden_profitability.json()["detail"]["code"] == "PROTECTED_COMPUTE_CAPABILITY_FORBIDDEN"
    )

    secret_request = _collection_pricing_request_payload(api_key="must-never-reach-pricing-core")
    rejected = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=secret_request,
    )
    assert rejected.status_code == 400
    assert rejected.json()["detail"]["code"] == "PROTECTED_COMPUTE_INPUT_REJECTED"
    assert "must-never" not in rejected.text

    extra_field_request = _collection_pricing_request_payload(arbitrary=1)
    rejected_extra = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=extra_field_request,
    )
    assert rejected_extra.status_code == 400
    assert rejected_extra.json()["detail"]["code"] == "PROTECTED_COMPUTE_INPUT_REJECTED"


def test_protected_compute_rejects_secrets_hash_mismatch_and_stale_requests(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    license_headers = _activate_license(client, admin_headers)

    secret_payload = _request_payload(api_key="must-never-reach-server-core")
    rejected_secret = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=secret_payload,
    )
    assert rejected_secret.status_code == 400
    assert rejected_secret.json()["detail"]["code"] == "PROTECTED_COMPUTE_INPUT_REJECTED"
    assert "must-never" not in rejected_secret.text

    mismatched = _request_payload()
    mismatched["inputHash"] = "sha256:" + "0" * 64
    rejected_hash = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=mismatched,
    )
    assert rejected_hash.status_code == 400
    assert rejected_hash.json()["detail"]["code"] == "PROTECTED_COMPUTE_INPUT_HASH_MISMATCH"

    stale = _request_payload()
    stale["issuedAt"] = (
        (datetime.now(UTC) - timedelta(minutes=10))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    rejected_stale = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=stale,
    )
    assert rejected_stale.status_code == 400
    assert rejected_stale.json()["detail"]["code"] == "PROTECTED_COMPUTE_REQUEST_TIME_INVALID"


def test_online_only_license_receives_no_offline_compute_grant(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    license_headers = _activate_license(client, admin_headers, offline_hours=0)
    response = client.post(
        "/api/protected-compute/execute",
        headers=license_headers,
        json=_request_payload(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["offlineUntil"] is None
    assert response.json()["offlinePolicy"] == {
        "allowed": False,
        "maxUses": 0,
        "scope": "input-hash",
    }


def test_deployment_builder_emits_verifiable_signed_public_config() -> None:
    configuration_key = Ed25519PrivateKey.generate()
    compute_key = Ed25519PrivateKey.generate()
    issued_at = datetime(2026, 7, 16, tzinfo=UTC)
    result = build_signed_public_config(
        configuration_private_key=configuration_key,
        configuration_key_id="config-root-v1",
        compute_public_key=compute_key.public_key(),
        compute_key_id="protected-compute-v1",
        server_base_url="https://license.wangzai.cn/",
        issued_at=issued_at,
        expires_at=issued_at + timedelta(days=30),
        config_version=3,
        revocation_epoch=8,
        revoked_key_ids=["old-key", "old-key"],
        revoked_capabilities=["old.capability@1"],
    )
    signature = base64.urlsafe_b64decode(result.pop("signature") + "==")
    configuration_key.public_key().verify(signature, canonical_json(result))
    assert result["serverBaseUrl"] == "https://license.wangzai.cn"
    assert result["configVersion"] == 3
    assert result["revokedKeyIds"] == ["old-key"]


def test_deployment_builder_writes_public_only_desktop_bundle(tmp_path) -> None:
    configuration_key = Ed25519PrivateKey.generate()
    compute_key = Ed25519PrivateKey.generate()
    issued_at = datetime(2026, 7, 16, tzinfo=UTC)
    signed_config = build_signed_public_config(
        configuration_private_key=configuration_key,
        configuration_key_id="protected-compute-config-v1",
        compute_public_key=compute_key.public_key(),
        compute_key_id="protected-compute-v1",
        server_base_url="https://license.wangzai.cn",
        issued_at=issued_at,
        expires_at=issued_at + timedelta(days=30),
        config_version=1,
        revocation_epoch=0,
        revoked_key_ids=[],
        revoked_capabilities=[],
    )
    metadata = write_desktop_bundle(
        bundle_root=tmp_path,
        signed_config=signed_config,
        configuration_public_key=configuration_key.public_key(),
        configuration_key_id="protected-compute-config-v1",
    )

    public_key_path = tmp_path / "protected-compute" / "configuration-public.pem"
    signed_path = tmp_path / "protected-compute" / "protected-compute.signed-public.json"
    assert public_key_path.is_file()
    assert signed_path.is_file()
    assert not list(tmp_path.rglob("*private*"))
    public_key = serialization.load_pem_public_key(public_key_path.read_bytes())
    public_der = public_key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    assert metadata["configurationKeySha256"] == hashlib.sha256(public_der).hexdigest()
    assert metadata["signedConfigSha256"] == hashlib.sha256(signed_path.read_bytes()).hexdigest()


@pytest.mark.parametrize(
    "server_base_url",
    [
        "https://license.invalid",
        "https://license.example",
        "https://license.example.test",
        "https://license.example.com",
        "https://localhost",
        "https://127.0.0.9",
        "https://[::1]",
        "https://[::ffff:127.0.0.1]",
    ],
)
def test_deployment_builder_requires_explicit_fixture_url_opt_in(
    server_base_url: str,
) -> None:
    configuration_key = Ed25519PrivateKey.generate()
    compute_key = Ed25519PrivateKey.generate()
    issued_at = datetime(2026, 7, 16, tzinfo=UTC)
    arguments = {
        "configuration_private_key": configuration_key,
        "configuration_key_id": "config-root-v1",
        "compute_public_key": compute_key.public_key(),
        "compute_key_id": "protected-compute-v1",
        "server_base_url": server_base_url,
        "issued_at": issued_at,
        "expires_at": issued_at + timedelta(days=30),
        "config_version": 3,
        "revocation_epoch": 8,
        "revoked_key_ids": [],
        "revoked_capabilities": [],
    }
    with pytest.raises(ValueError, match="placeholder|reserved|localhost|loopback"):
        build_signed_public_config(**arguments)
    with pytest.raises(ValueError, match="placeholder|reserved|localhost|loopback"):
        build_signed_public_config(**arguments, allow_test_fixture_urls=1)

    result = build_signed_public_config(
        **arguments,
        allow_test_fixture_urls=True,
    )
    assert result["serverBaseUrl"] == server_base_url

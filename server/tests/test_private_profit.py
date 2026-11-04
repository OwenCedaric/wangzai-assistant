from __future__ import annotations

import base64
import hashlib
import json
import shutil
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization

from app.protected_compute.canonical import canonical_json, canonical_sha256
from app.protected_compute.private_profit import (
    CALCULATION_VERSION,
    PrivateProfitFailure,
    execute_private_profit,
    normalize_private_profit_input,
)
from app.protected_compute.registry import CapabilityContractError, get_capability
from tests.test_protected_compute import _activate_license, _request_payload


def wire(value):
    if isinstance(value, list):
        return {"t": "array", "v": [wire(item) for item in value]}
    if isinstance(value, dict):
        return {"t": "object", "v": [[key, wire(item)] for key, item in value.items()]}
    return value


def payload(order=None):
    return {
        "calculationVersion": CALCULATION_VERSION,
        "callsJson": json.dumps(wire([{
            "id": "fixture", "operation": "ledger", "input": {"order": order or {}},
        }]), ensure_ascii=False),
    }


def test_private_contract_is_online_only_and_preserves_wire():
    descriptor = get_capability("profit.ledger-batch", 1)
    request = payload({"shopId": "fixture-shop", "amountValue": 1.23456789})
    assert descriptor.normalize(request) == request
    assert descriptor.offline_allowed is False
    assert descriptor.offline_max_uses == 0
    assert descriptor.required_permission == "profit.view"


@pytest.mark.parametrize("operation", ["merge-ledger", "migrate-ledger"])
def test_storage_operations_require_an_explicit_ledger(operation):
    request = payload()
    calls = [{"id": "fixture", "operation": operation, "input": {"order": {}, "ledger": None}}]
    request["callsJson"] = json.dumps(wire(calls))
    assert normalize_private_profit_input(request) == request
    del calls[0]["input"]["ledger"]
    request["callsJson"] = json.dumps(wire(calls))
    with pytest.raises(ValueError):
        normalize_private_profit_input(request)


@pytest.mark.parametrize("order", [
    {"apiKey": "not-real"}, {"nested": {"clientId": "not-real"}},
    {"note": "Bearer synthetic-credential-value"}, {"constructor": {}},
])
def test_private_contract_rejects_hidden_credentials(order):
    with pytest.raises(CapabilityContractError):
        get_capability("profit.ledger-batch", 1).normalize(payload(order))


@pytest.mark.parametrize("changes", [
    {"calculationVersion": "old"}, {"callsJson": "["},
    {"callsJson": " " * (1024 * 1024 + 1)}, {"extra": True},
])
def test_private_contract_rejects_malformed_and_oversized_calls(changes):
    with pytest.raises(ValueError):
        normalize_private_profit_input({**payload(), **changes})


def test_private_worker_requires_pinned_code_and_does_not_write_business_files(tmp_path):
    node = shutil.which("node")
    assert node, "Node is required for the real isolated worker test"
    core = tmp_path / "fixture-core.mjs"
    encoded_rows = json.dumps(json.dumps(wire([{"id": "fixture", "value": {}}])))
    core.write_text(
        "export function executeProfitBatch(p) { return {"
        f"calculationVersion:p.calculationVersion,resultsJson:{encoded_rows}}}; }}",
        encoding="utf8",
    )
    settings = SimpleNamespace(
        private_profit_core_file=str(core),
        private_profit_core_sha256=hashlib.sha256(core.read_bytes()).hexdigest(),
        private_profit_node_executable=node,
    )
    before = {file.name: file.read_bytes() for file in tmp_path.iterdir()}
    result = execute_private_profit(payload({"id": "synthetic-only"}), settings=settings)
    assert result == {
        "calculationVersion": CALCULATION_VERSION,
        "resultsJson": json.dumps(wire([{"id": "fixture", "value": {}}])),
    }
    assert {file.name: file.read_bytes() for file in tmp_path.iterdir()} == before
    core.write_text("throw new Error('changed');", encoding="utf8")
    with pytest.raises(PrivateProfitFailure, match="PRIVATE_PROFIT_CORE_UNVERIFIED"):
        execute_private_profit(payload(), settings=settings)
    settings.private_profit_core_file = None
    with pytest.raises(PrivateProfitFailure, match="PRIVATE_PROFIT_CORE_NOT_CONFIGURED"):
        execute_private_profit(payload(), settings=settings)


def test_private_profit_api_authenticates_and_signs_real_worker_result(
    client, admin_headers, tmp_path,
):
    settings = client.app.state.settings
    core = tmp_path / "api-fixture-core.mjs"
    encoded_rows = json.dumps(json.dumps(wire([{"id": "fixture", "value": {"amount": 12}}])))
    core.write_text(
        "export function executeProfitBatch(p) { return {"
        f"calculationVersion:p.calculationVersion,resultsJson:{encoded_rows}}}; }}",
        encoding="utf8",
    )
    settings.private_profit_core_file = str(core)
    settings.private_profit_core_sha256 = hashlib.sha256(core.read_bytes()).hexdigest()
    settings.private_profit_node_executable = shutil.which("node")
    assert settings.private_profit_node_executable
    license_headers = _activate_license(client, admin_headers)
    request = {
        **_request_payload(), "capability": "profit.ledger-batch", "input": payload(),
        "inputHash": canonical_sha256(payload()),
    }
    endpoint = "/api/protected-compute/execute"
    assert client.post(endpoint, json=request).status_code == 401
    assert client.post(endpoint, headers=admin_headers, json=request).status_code == 403
    response = client.post(endpoint, headers=license_headers, json=request)
    assert response.status_code == 200, response.text
    envelope = response.json()
    signature = base64.urlsafe_b64decode(envelope.pop("signature") + "==")
    public_keys = client.get("/api/protected-compute/public-keys").json()
    public_key = serialization.load_pem_public_key(public_keys["keys"][0]["publicKeyPem"].encode())
    public_key.verify(signature, canonical_json(envelope))
    assert envelope["capability"] == "profit.ledger-batch"
    assert envelope["inputHash"] == request["inputHash"]
    assert envelope["requestId"] == request["requestId"]
    assert envelope["offlinePolicy"]["allowed"] is False
    assert envelope["offlinePolicy"]["maxUses"] == 0
    assert client.post(endpoint, headers=license_headers, json=request).status_code == 409

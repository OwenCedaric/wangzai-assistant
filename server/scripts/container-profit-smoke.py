"""Run the actual Python-to-Node profit worker without networks or business storage."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.protected_compute.private_profit import (  # noqa: E402
    CALCULATION_VERSION, PrivateProfitFailure, execute_private_profit,
)


def wire(value):
    if isinstance(value, list):
        return {"t": "array", "v": [wire(item) for item in value]}
    if isinstance(value, dict):
        return {"t": "object", "v": [[key, wire(item)] for key, item in value.items()]}
    return value


def main() -> None:
    spec = importlib.util.spec_from_file_location("container_environment", Path(__file__).with_name("container-profit-environment.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    digest = module.verify_runtime()
    settings = SimpleNamespace(private_profit_core_file=os.environ["PRIVATE_PROFIT_CORE_FILE"],
        private_profit_core_sha256=digest, private_profit_node_executable=os.environ["PRIVATE_PROFIT_NODE_EXECUTABLE"])
    calls = [{"id": "isolated-container-order", "operation": "ledger", "input": {"order": {"id": "synthetic-only"}}}]
    request = {"calculationVersion": CALCULATION_VERSION, "callsJson": json.dumps(wire(calls))}
    result = execute_private_profit(request, settings=settings)
    assert result["calculationVersion"] == CALCULATION_VERSION
    rows = json.loads(result["resultsJson"])
    assert rows["t"] == "array" and len(rows["v"]) == 1
    assert dict(rows["v"][0]["v"])["id"] == "isolated-container-order"
    settings.private_profit_core_sha256 = "0" * 64
    try:
        execute_private_profit(request, settings=settings)
    except PrivateProfitFailure as error:
        assert error.code == "PRIVATE_PROFIT_CORE_UNVERIFIED"
    else:
        raise AssertionError("altered core hash was accepted")
    print(json.dumps({"ok": True, "realBundledWorker": True, "tamperedHashRejected": True,
                      "syntheticOrders": 1, "networkRequired": False}))


if __name__ == "__main__":
    main()

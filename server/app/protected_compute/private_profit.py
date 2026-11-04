from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import Any

from app.protected_compute.secret_guard import reject_secret_material

CALCULATION_VERSION = "profit-ledger-v16-partial-compensation-net-income"
OPERATIONS = {
    "ledger", "normalize", "rebuild-final", "manual-override", "merge-ledger", "migrate-ledger",
}
MAX_INPUT_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
_slots = threading.BoundedSemaphore(2)
_WORKER_ENV_KEYS = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TZ"}


class PrivateProfitFailure(Exception):
    def __init__(self, code: str, status: int = 503):
        self.code = code
        self.status = status
        super().__init__(code)


def inspect_wire(value: Any) -> Any:
    visited = 0

    def visit(item, depth=0):
        nonlocal visited
        visited += 1
        if visited > 100_000 or depth > 48:
            raise ValueError("wire limit")
        if item is None or isinstance(item, (str, bool, int)):
            if isinstance(item, str):
                reject_secret_material(item)
            return item
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError("nonfinite")
            return item
        if not isinstance(item, dict):
            raise ValueError("invalid wire")
        if item == {"t": "undefined"}:
            return None
        if set(item) != {"t", "v"}:
            raise ValueError("invalid wire fields")
        kind, content = item["t"], item["v"]
        if not isinstance(kind, str):
            raise ValueError("invalid tag")
        if kind in {"date", "bigint"}:
            if not isinstance(content, str) or len(content) > 40:
                raise ValueError("invalid scalar")
            return content
        if not isinstance(content, list):
            raise ValueError("invalid collection")
        if kind in {"array", "set"}:
            return [visit(part, depth + 1) for part in content]
        if kind in {"object", "map"}:
            result = {}
            map_entries = []
            seen_keys = set()
            for pair in content:
                if not isinstance(pair, list) or len(pair) != 2:
                    raise ValueError("invalid pair")
                key = pair[0] if kind == "object" else visit(pair[0], depth + 1)
                identity = json.dumps(pair[0], sort_keys=True, ensure_ascii=False)
                if not isinstance(key, (str, int, float, bool)) or identity in seen_keys:
                    raise ValueError("invalid or duplicate key")
                seen_keys.add(identity)
                if kind == "object":
                    if not isinstance(key, str) or key in {"__proto__", "constructor", "prototype"}:
                        raise ValueError("unsafe key")
                    reject_secret_material({key: None})
                decoded = visit(pair[1], depth + 1)
                if kind == "object":
                    result[key] = decoded
                else:
                    map_entries.append([key, decoded])
            return result if kind == "object" else {"wireMapEntries": map_entries}
        raise ValueError("invalid tag")

    return visit(value)


def normalize_private_profit_input(payload: dict) -> dict:
    if (
        not isinstance(payload, dict)
        or set(payload) != {"calculationVersion", "callsJson"}
        or payload["calculationVersion"] != CALCULATION_VERSION
        or not isinstance(payload["callsJson"], str)
        or len(payload["callsJson"].encode()) > MAX_INPUT_BYTES
    ):
        raise ValueError("invalid profit contract")
    calls = inspect_wire(json.loads(payload["callsJson"]))
    if not isinstance(calls, list) or not 1 <= len(calls) <= 64:
        raise ValueError("invalid batch size")
    seen = set()
    for call in calls:
        if (
            not isinstance(call, dict)
            or set(call) != {"id", "operation", "input"}
            or not isinstance(call["id"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", call["id"])
            or call["id"] in seen
            or not isinstance(call["operation"], str)
            or call["operation"] not in OPERATIONS
            or not isinstance(call["input"], dict)
            or not isinstance(call["input"].get("order"), dict)
            or (
                call["operation"] in {"merge-ledger", "migrate-ledger"}
                and "ledger" not in call["input"]
            )
        ):
            raise ValueError("invalid profit call")
        seen.add(call["id"])
    # Keep the original encoded string. No float/currency reserialization here.
    return dict(payload)


def validate_private_profit_result(result: dict) -> dict:
    if (
        not isinstance(result, dict)
        or set(result) != {"calculationVersion", "resultsJson"}
        or result["calculationVersion"] != CALCULATION_VERSION
        or not isinstance(result["resultsJson"], str)
        or len(result["resultsJson"].encode()) > MAX_OUTPUT_BYTES
    ):
        raise ValueError("invalid private result")
    rows = inspect_wire(json.loads(result["resultsJson"]))
    if not isinstance(rows, list) or not 1 <= len(rows) <= 64:
        raise ValueError("invalid private result rows")
    seen = set()
    for row in rows:
        if (
            not isinstance(row, dict)
            or set(row) != {"id", "value"}
            or not isinstance(row["id"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", row["id"])
            or row["id"] in seen
        ):
            raise ValueError("invalid private result identity")
        seen.add(row["id"])
    return result


def execute_private_profit(payload: dict, *, settings) -> dict:
    configured_file = settings.private_profit_core_file
    expected_hash = settings.private_profit_core_sha256
    node = settings.private_profit_node_executable
    if not configured_file or not re.fullmatch(r"[a-f0-9]{64}", expected_hash or "") or not node:
        raise PrivateProfitFailure("PRIVATE_PROFIT_CORE_NOT_CONFIGURED")
    file = Path(configured_file).absolute()
    try:
        if not file.is_file() or file.is_symlink() or file.resolve() != file:
            raise ValueError("invalid private core path")
        if hashlib.sha256(file.read_bytes()).hexdigest() != expected_hash:
            raise ValueError("private core changed")
    except (OSError, ValueError) as exc:
        raise PrivateProfitFailure("PRIVATE_PROFIT_CORE_UNVERIFIED") from exc
    if not _slots.acquire(blocking=False):
        raise PrivateProfitFailure("PRIVATE_PROFIT_CORE_BUSY", 429)
    script = (
        "import fs from 'node:fs';"
        f"import {{executeProfitBatch}} from {json.dumps(file.as_uri())};"
        "try { const request=JSON.parse(fs.readFileSync(0,'utf8'));"
        "const result=JSON.stringify(executeProfitBatch(request));"
        f"if(Buffer.byteLength(result)>{MAX_OUTPUT_BYTES})throw new Error('RESULT_TOO_LARGE');"
        "process.stdout.write(result); } catch { process.exitCode=1; }"
    )
    try:
        # New isolated worker, stdin/stdout only. No customer input/result file,
        # shell command interpolation, persistent queue or business-data log.
        result = subprocess.run(
            [node, "--input-type=module", "-e", script],
            input=json.dumps(payload, ensure_ascii=False).encode(),
            capture_output=True,
            timeout=30,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            env={
                key: value
                for key, value in os.environ.items()
                if key.upper() in _WORKER_ENV_KEYS
            },
        )
        if result.returncode != 0 or len(result.stdout) > MAX_OUTPUT_BYTES:
            raise PrivateProfitFailure("PRIVATE_PROFIT_CORE_EXECUTION_FAILED", 502)
        validated = validate_private_profit_result(json.loads(result.stdout))
        calls = inspect_wire(json.loads(payload["callsJson"]))
        rows = inspect_wire(json.loads(validated["resultsJson"]))
        if [row["id"] for row in rows] != [call["id"] for call in calls]:
            raise ValueError("private result coverage mismatch")
        return validated
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        raise PrivateProfitFailure("PRIVATE_PROFIT_CORE_EXECUTION_FAILED", 502) from exc
    finally:
        _slots.release()

from __future__ import annotations

import hashlib
import json
import unicodedata
from typing import Any


class CanonicalValueError(ValueError):
    pass


def _normalize(value: Any, *, depth: int = 0, nodes: list[int] | None = None) -> Any:
    if nodes is None:
        nodes = [0]
    nodes[0] += 1
    if depth > 32 or nodes[0] > 20_000:
        raise CanonicalValueError("canonical payload limit exceeded")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 9_007_199_254_740_991:
            raise CanonicalValueError("integer is outside JavaScript safe range")
        return value
    if isinstance(value, list):
        return [_normalize(item, depth=depth + 1, nodes=nodes) for item in value]
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for raw_key, child in value.items():
            if not isinstance(raw_key, str):
                raise CanonicalValueError("object keys must be strings")
            key = unicodedata.normalize("NFC", raw_key)
            if key in normalized:
                raise CanonicalValueError("canonically duplicate object key")
            normalized[key] = _normalize(child, depth=depth + 1, nodes=nodes)
        return {key: normalized[key] for key in sorted(normalized)}
    raise CanonicalValueError("unsupported canonical value")


def canonical_json(value: Any) -> bytes:
    normalized = _normalize(value)
    return json.dumps(
        normalized,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_json(value)).hexdigest()}"

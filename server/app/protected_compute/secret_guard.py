from __future__ import annotations

import re
from typing import Any

FORBIDDEN_KEY = re.compile(
    r"(?:^|[_-])(?:api[_-]?key|client[_-]?id|client[_-]?secret|password|passwd|cookie|"
    r"authorization|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"ozon[_-]?key|secret)(?:$|[_-])",
    re.IGNORECASE,
)
FORBIDDEN_VALUES = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?:^|\s)Bearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE),
    re.compile(r"(?:^|\n)(?:Api-Key|Client-Id|Cookie|Authorization)\s*:", re.IGNORECASE),
)


class SecretInputError(ValueError):
    pass


def reject_secret_material(value: Any) -> None:
    pending: list[tuple[str, Any]] = [("$", value)]
    seen: set[int] = set()
    visited = 0
    while pending:
        path, current = pending.pop()
        visited += 1
        if visited > 20_000:
            raise SecretInputError("input exceeds inspection limit")
        if isinstance(current, str):
            if any(pattern.search(current) for pattern in FORBIDDEN_VALUES):
                raise SecretInputError(f"secret material rejected at {path}")
            continue
        if isinstance(current, (dict, list)):
            identity = id(current)
            if identity in seen:
                raise SecretInputError("cyclic input rejected")
            seen.add(identity)
        if isinstance(current, dict):
            for key, child in current.items():
                if not isinstance(key, str):
                    raise SecretInputError("non-string input key rejected")
                child_path = f"{path}.{key}"
                if FORBIDDEN_KEY.search(key):
                    raise SecretInputError(f"secret field rejected at {child_path}")
                pending.append((child_path, child))
        elif isinstance(current, list):
            pending.extend((f"{path}[{index}]", child) for index, child in enumerate(current))

"""Permission primitives returned by License Center."""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass

from .errors import PermissionDeniedError


def _permission_code(item: object) -> str | None:
    if isinstance(item, str):
        code = item.strip()
        return code or None
    if isinstance(item, Mapping):
        value = item.get("code") or item.get("permission_code")
        if isinstance(value, str):
            code = value.strip()
            return code or None
    return None


@dataclass(frozen=True, slots=True)
class PermissionSet:
    """An immutable set of server-controlled permission codes."""

    _codes: frozenset[str]

    def __init__(self, permissions: Iterable[object] = ()) -> None:
        codes = (code for item in permissions if (code := _permission_code(item)))
        object.__setattr__(self, "_codes", frozenset(codes))

    def __contains__(self, permission: object) -> bool:
        return isinstance(permission, str) and permission in self._codes

    def __iter__(self) -> Iterator[str]:
        return iter(sorted(self._codes))

    def __len__(self) -> int:
        return len(self._codes)

    def has(self, permission: str) -> bool:
        return permission in self._codes

    def has_all(self, *permissions: str) -> bool:
        return all(permission in self._codes for permission in permissions)

    def has_any(self, *permissions: str) -> bool:
        return any(permission in self._codes for permission in permissions)

    def require(self, permission: str) -> None:
        if not self.has(permission):
            raise PermissionDeniedError(permission)

    def as_list(self) -> list[str]:
        return sorted(self._codes)

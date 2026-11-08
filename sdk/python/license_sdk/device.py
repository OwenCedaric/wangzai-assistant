"""Privacy-preserving device identity helpers."""

from __future__ import annotations

import hashlib
import os
import platform
import re
import socket
import uuid
from dataclasses import dataclass
from pathlib import Path

from .errors import ConfigurationError

_DEVICE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")


def _windows_machine_guid() -> str | None:
    if os.name != "nt":
        return None
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography") as key:
            value, _ = winreg.QueryValueEx(key, "MachineGuid")
            return str(value)
    except (OSError, ImportError):
        return None


def _unix_machine_id() -> str | None:
    for filename in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            value = Path(filename).read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value:
            return value
    return None


def _default_machine_parts() -> tuple[str, ...]:
    stable_id = _windows_machine_guid() or _unix_machine_id() or str(uuid.getnode())
    return (
        platform.system(),
        platform.machine(),
        stable_id,
    )


def generate_device_code(app: str, *, machine_parts: tuple[str, ...] | None = None) -> str:
    """Generate an app-scoped hash without exposing raw machine identifiers."""
    app_code = app.strip()
    if not app_code:
        raise ConfigurationError("app must not be empty")
    parts = machine_parts or _default_machine_parts()
    material = "\0".join(("license-center-device-v1", app_code, *parts)).encode("utf-8")
    digest = hashlib.sha256(material).hexdigest().upper()
    return f"DEV-{digest[:40]}"


def default_device_name() -> str:
    name = socket.gethostname().strip() or platform.node().strip() or platform.system()
    return name[:128]


@dataclass(frozen=True, slots=True)
class DeviceIdentity:
    """The only device fields sent to License Center."""

    code: str
    name: str

    @classmethod
    def detect(
        cls,
        app: str,
        *,
        device_code: str | None = None,
        device_name: str | None = None,
    ) -> DeviceIdentity:
        code = (device_code or generate_device_code(app)).strip()
        if not _DEVICE_CODE_PATTERN.fullmatch(code):
            raise ConfigurationError(
                "device_code must be 8-128 characters using letters, digits, '.', '_', ':', or '-'"
            )
        name = (device_name or default_device_name()).strip()[:128]
        if not name:
            raise ConfigurationError("device_name must not be empty")
        return cls(code=code, name=name)

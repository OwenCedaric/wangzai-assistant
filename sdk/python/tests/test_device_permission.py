from __future__ import annotations

import pytest

from license_sdk import DeviceIdentity, PermissionDeniedError, PermissionSet, generate_device_code
from license_sdk.errors import ConfigurationError


def test_device_code_is_stable_private_and_app_scoped() -> None:
    parts = ("Windows", "AMD64", "raw-machine-guid")
    first = generate_device_code("sample_app", machine_parts=parts)
    second = generate_device_code("sample_app", machine_parts=parts)
    other_app = generate_device_code("other_app", machine_parts=parts)

    assert first == second
    assert first != other_app
    assert "raw-machine-guid" not in first
    assert first.startswith("DEV-")


def test_explicit_device_identity_is_validated() -> None:
    identity = DeviceIdentity.detect(
        "sample_app",
        device_code="DEV-CUSTOM-12345678",
        device_name="QA workstation",
    )
    assert identity.name == "QA workstation"
    with pytest.raises(ConfigurationError):
        DeviceIdentity.detect("sample_app", device_code="bad", device_name="QA")


def test_permission_set_accepts_codes_and_api_objects() -> None:
    permissions = PermissionSet(
        ["order_sync", {"code": "profit"}, {"permission_code": "ai_analysis"}, ""]
    )
    assert permissions.has("order_sync")
    assert permissions.has_all("order_sync", "profit")
    assert permissions.has_any("missing", "ai_analysis")
    assert permissions.as_list() == ["ai_analysis", "order_sync", "profit"]

    with pytest.raises(PermissionDeniedError):
        permissions.require("purchase")

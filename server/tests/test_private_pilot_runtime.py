from __future__ import annotations

import json

import pytest
from pydantic import BaseModel, ConfigDict

from app.private_pilot_runtime import load_pilot_runtime_settings


class FixtureSettings(BaseModel):
    model_config = ConfigDict(extra="allow")
    database_url: str = "fixture-database-unchanged"
    jwt_secret_key: str = "fixture-auth-unchanged"
    private_profit_core_file: str | None = "old-core"
    client_updates_enabled: bool = True


def valid_settings(tmp_path):
    return {
        "private_profit_core_file": str(tmp_path / "profit-core.mjs"),
        "private_profit_core_sha256": "a" * 64,
        "private_profit_node_executable": str(tmp_path / "node.exe"),
        "client_updates_enabled": True,
        "client_update_bundle_file": str(tmp_path / "ui.json"),
        "client_update_project_code": "fixture-project",
        "client_update_app_id": "fixture-app",
        "client_update_channel": "pilot",
    }


def test_absent_optional_file_preserves_the_existing_service(tmp_path):
    base = FixtureSettings()
    assert load_pilot_runtime_settings(base, tmp_path / "missing.json") is base


def test_unreadable_overlay_cannot_break_the_ordinary_auth_service(caplog):
    class Unreadable:
        def lstat(self):
            raise PermissionError("never-log-this-detail")

    loaded = load_pilot_runtime_settings(FixtureSettings(), Unreadable())
    assert loaded.private_profit_core_file is None
    assert loaded.database_url == "fixture-database-unchanged"
    assert "never-log-this-detail" not in caplog.text


def test_valid_pilot_settings_never_change_database_or_auth_settings(tmp_path):
    file = tmp_path / "pilot.json"
    values = valid_settings(tmp_path)
    file.write_text(json.dumps(values), encoding="utf8")
    base = FixtureSettings()
    loaded = load_pilot_runtime_settings(base, file)
    assert loaded.database_url == base.database_url
    assert loaded.jwt_secret_key == base.jwt_secret_key
    assert loaded.private_profit_core_file == values["private_profit_core_file"]
    assert base.private_profit_core_file == "old-core"


@pytest.mark.parametrize("change", [
    {"database_url": "do-not-log-this-input"},
    {"private_profit_core_sha256": "wrong"},
    {"client_updates_enabled": "true"},
    {"private_profit_core_file": "relative-file.mjs"},
])
def test_bad_overlay_disables_pilot_only_and_never_logs_input(tmp_path, caplog, change):
    file = tmp_path / "pilot.json"
    file.write_text(json.dumps({**valid_settings(tmp_path), **change}), encoding="utf8")
    loaded = load_pilot_runtime_settings(FixtureSettings(), file)
    assert loaded.private_profit_core_file is None
    assert loaded.client_updates_enabled is False
    assert loaded.database_url == "fixture-database-unchanged"
    assert loaded.jwt_secret_key == "fixture-auth-unchanged"
    assert "do-not-log-this-input" not in caplog.text

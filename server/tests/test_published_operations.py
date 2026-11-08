from __future__ import annotations

import importlib.util
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
PREPARE = ROOT / "test-runtime/scripts/prepare_test_database.py"
SYNC = ROOT / "test-runtime/scripts/sync_primary_admin_to_test.py"


def load_prepare():
    spec = importlib.util.spec_from_file_location("prepare_isolated_runtime", PREPARE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_test_database_copy_rejects_source_alias_and_existing_target(tmp_path):
    module = load_prepare()
    source, target = tmp_path / "source.sqlite3", tmp_path / "copy.sqlite3"
    with sqlite3.connect(source) as db:
        db.execute("CREATE TABLE fixture(value TEXT)")
        db.execute("INSERT INTO fixture VALUES ('synthetic-only')")
    before = source.read_bytes()
    with pytest.raises(ValueError, match="SOURCE_AND_TARGET"):
        module._backup(source, source)
    module._backup(source, target)
    with sqlite3.connect(target) as db:
        assert db.execute("SELECT value FROM fixture").fetchone()[0] == "synthetic-only"
    with pytest.raises(FileExistsError, match="ALREADY_EXISTS"):
        module._backup(source, target)
    assert source.read_bytes() == before


@pytest.mark.parametrize("script,required", [(PREPARE, "--acknowledge-sensitive-copy"), (SYNC, "--confirm-admin-sync")])
def test_cloning_tools_never_touch_an_input_without_explicit_copy_confirmation(tmp_path, script, required):
    source = tmp_path / "source.sqlite3"
    source.write_bytes(b"not even a database: must not be opened")
    target = tmp_path / "target.sqlite3"
    result = subprocess.run([sys.executable, str(script), "--source", str(source), "--target", str(target)],
                            capture_output=True, text=True, cwd=tmp_path)
    assert result.returncode != 0
    assert required in result.stderr
    assert not target.exists()
    assert source.read_bytes() == b"not even a database: must not be opened"


def test_existing_credential_output_prevents_database_preparation(tmp_path):
    source, target, credentials = tmp_path / "source.sqlite3", tmp_path / "target.sqlite3", tmp_path / "credentials.csv"
    source.write_bytes(b"must not be opened")
    credentials.write_text("preserve-this-fixture", encoding="utf-8")
    result = subprocess.run([sys.executable, str(PREPARE), "--source", str(source), "--target", str(target),
                             "--credentials", str(credentials), "--admin", str(tmp_path / "admin.txt"),
                             "--acknowledge-sensitive-copy"], capture_output=True, text=True, cwd=tmp_path)
    assert result.returncode != 0
    assert "output already exists" in result.stderr
    assert not target.exists()
    assert credentials.read_text() == "preserve-this-fixture"

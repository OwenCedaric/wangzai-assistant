import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

spec = importlib.util.spec_from_file_location("self_host", Path(__file__).parents[1] / "scripts/self_host.py")
self_host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(self_host)


def test_independent_initialization_enforces_login_and_never_overwrites(tmp_path):
    workspace = Path(__file__).resolve().parents[2]
    client_root = tmp_path / "client"
    for relative in ["desktop/resources/project.example.json", "local-api/config/local-api.config.example.json"]:
        target = client_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((workspace / relative).read_bytes())
    state = tmp_path / "state"
    result = self_host.initialize(state, client_root)
    assert result["ready"] is True
    credentials = json.loads((state / "private/credentials.json").read_text(encoding="utf-8"))
    values = json.loads((state / "private/settings.json").read_text(encoding="utf-8"))
    manifest_path = state / "deployment.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tls_command = ["node", "--require", str(workspace / "desktop/src/runtime/selfHostedTls.cjs"), "-e", "process.exit(0)"]
    tls_environment = {**os.environ, "WANGZAI_SELFHOST_CA_FILE": str(state / "ca.pem")}
    assert subprocess.run(tls_command, env=tls_environment, capture_output=True).returncode == 0
    manifest_path.write_text(json.dumps({**manifest, "caSha256": "0" * 64}), encoding="utf-8")
    rejected_ca = subprocess.run(tls_command, env=tls_environment, capture_output=True)
    assert rejected_ca.returncode != 0
    assert b"SELF_HOST_CA_FINGERPRINT_MISMATCH" in rejected_ca.stderr
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with TestClient(create_app(Settings(_env_file=None, **values))) as client:
        assert client.get("/api/license/entitlements?project_code=wangzai_desktop").status_code == 401
        assert client.post("/api/auth/login", json={"username": credentials["username"], "password": "WrongPassword123!"}).status_code == 401
        response = client.post("/api/auth/login", json={"username": credentials["username"], "password": credentials["password"]})
        assert response.status_code == 200
        assert response.json()["access_token"]
    before = (state / "license.sqlite").read_bytes()
    with pytest.raises(ValueError, match="STATE_ALREADY_EXISTS"):
        self_host.initialize(state, client_root)
    assert (state / "license.sqlite").read_bytes() == before
    assert json.loads((client_root / "desktop/resources/distribution.json").read_text(encoding="utf-8"))["license_mode"] == "enforce"
    assert json.loads((client_root / "local-api/config/local-api.config.json").read_text(encoding="utf-8"))["ozon"]["enableRealWrite"] is False

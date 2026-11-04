import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from tests.helpers import login_user
from tests.test_protected_compute import _activate_license


def test_update_feed_requires_a_real_active_device_license_and_matching_project(
    client: TestClient, admin_headers, tmp_path
):
    url = "/api/client-updates/pilot/latest"
    assert client.get(url).status_code == 401
    headers = _activate_license(client, admin_headers)
    assert client.get(url, headers=login_user(client)).status_code == 403
    assert client.get(url, headers=headers).status_code == 204
    settings = client.app.state.settings
    settings.client_updates_enabled = True
    assert client.get(url, headers=headers).status_code == 503
    settings.client_update_project_code = "another-project"
    settings.client_update_app_id = "isolated-pilot"
    settings.client_update_bundle_file = str(tmp_path / "public-ui-update.json")
    assert client.get(url, headers=headers).status_code == 403
    settings.client_update_project_code = "ozon_helper"
    assert client.get("/api/client-updates/stable/latest", headers=headers).status_code == 404
    assert client.get(url, headers=headers).status_code == 503

    content = b"<html>isolated signed update</html>"
    manifest = {
        "contract": "wangzai-ui-update/v1",
        "appId": "isolated-pilot",
        "channel": "pilot",
        "sequence": 1,
        "shellApi": 1,
        "createdAt": datetime.now(UTC).isoformat(),
        "expiresAt": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
        "files": [
            {
                "path": "index.html",
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        ],
    }
    signing_bytes = (
        "wangzai-ui-update/v1\n" + json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
    ).encode()
    key = Ed25519PrivateKey.generate()
    bundle = {
        "manifest": manifest,
        "signature": base64.b64encode(key.sign(signing_bytes)).decode(),
        "contents": {"index.html": base64.b64encode(content).decode()},
    }
    file = tmp_path / "public-ui-update.json"
    file.write_text(json.dumps(bundle), encoding="utf-8")
    before = file.read_bytes()
    response = client.get(url, headers=headers)
    assert response.status_code == 200
    assert response.content == before
    assert response.headers["cache-control"] == "private, no-store"
    assert file.read_bytes() == before
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "license-center.db", "public-ui-update.json"
    ]

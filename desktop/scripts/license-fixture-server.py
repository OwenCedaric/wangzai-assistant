"""Isolated License Center using the real backend and its public admin APIs."""
from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import socket
import sys
import threading
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--directory", required=True)
parser.add_argument("--backend-root", required=True)
parser.add_argument("--project-file", required=True)
parser.add_argument("--port", type=int, required=True)
args = parser.parse_args()
directory = Path(args.directory).resolve()
assert directory.is_dir() and directory.name == "authorization"
assert directory.parent.name == "work" and directory.parent.parent.name.startswith("run-")
assert directory.parent.parent.parent.name == ".managed-dev-scratch"
assert not (directory / "license.sqlite").exists()
backend_root = Path(args.backend_root).resolve()
assert (backend_root / "app/main.py").is_file()
sys.path.insert(0, str(backend_root))

network_attempts = 0
original_connect = socket.socket.connect


def checked_connect(sock, address):
    global network_attempts
    if isinstance(address, tuple) and address[0] not in {"127.0.0.1", "::1", "localhost"}:
        network_attempts += 1
        raise RuntimeError("ISOLATED_LICENSE_EXTERNAL_NETWORK_BLOCKED")
    return original_connect(sock, address)


socket.socket.connect = checked_connect

import uvicorn  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402


def private_pem(key):
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()


key = Ed25519PrivateKey.generate()
admin_password = secrets.token_urlsafe(24)
user_password = secrets.token_urlsafe(24)
settings = Settings(
    _env_file=None, app_env="test", database_url=f"sqlite:///{(directory / 'license.sqlite').as_posix()}",
    auto_create_tables=True, redis_url=None, debug=False,
    jwt_secret_key=secrets.token_hex(32), card_hash_secret=secrets.token_hex(32),
    card_encryption_key=Fernet.generate_key().decode(), identity_hash_secret=secrets.token_hex(32),
    identity_encryption_key=Fernet.generate_key().decode(), otp_hash_secret=secrets.token_hex(32),
    refresh_token_secret=secrets.token_hex(32), channel_token_secret=secrets.token_hex(32),
    api_pool_hash_secret=secrets.token_hex(32), api_pool_encryption_key=Fernet.generate_key().decode(),
    offline_signing_private_key=private_pem(key), offline_signing_key_id="isolated-license-v1",
    protected_compute_signing_private_key=private_pem(Ed25519PrivateKey.generate()),
    bootstrap_admin_username="isolated_admin", bootstrap_admin_password=admin_password,
    cross_border_company_secret_file=None, paid_capability_enabled=False,
    payment_development_enabled=False, cors_origins="", trusted_hosts="localhost,127.0.0.1,testserver",
)
app = create_app(settings)
project = json.loads(Path(args.project_file).read_text(encoding="utf-8-sig"))


def checked(response, status=200):
    if response.status_code != status:
        raise RuntimeError(f"FIXTURE_ADMIN_API_FAILED:{response.request.url.path}:{response.status_code}")
    return response.json()


with TestClient(app) as client:
    auth = checked(client.post("/api/auth/login", json={"username": "isolated_admin", "password": admin_password}))
    headers = {"Authorization": f"Bearer {auth['access_token']}"}
    imported = checked(client.post("/api/admin/projects/import", headers=headers, json=project))
    project_id = imported["project"]["id"]
    product = checked(client.get(f"/api/admin/products?project_id={project_id}", headers=headers))["items"][0]
    permissions = checked(client.get(f"/api/admin/permissions?project_id={project_id}", headers=headers))["items"]
    plan = checked(client.post("/api/admin/plans", headers=headers, json={
        "product_id": product["id"], "name": "隔离测试月卡", "price": "50.00", "sale_price_cent": 5000,
        "license_role": "shop_standard_monthly", "duration_days": 30, "max_devices": 1,
        "max_shops": 1, "permission_ids": [item["id"] for item in permissions],
    }), 201)
    checked(client.put(f"/api/admin/plans/{plan['id']}", headers=headers, json={"offline_hours": 72}))
    checked(client.post("/api/admin/users", headers=headers,
                        json={"username": "isolated_customer", "password": user_password,
                              "email": "isolated-customer@fixture.invalid"}), 201)
    cards = checked(client.post("/api/admin/card-batches", headers=headers,
                                json={"plan_id": plan["id"], "quantity": 10}), 201)
    assert client.get(f"/api/license/entitlements?project_code={project['code']}").status_code == 401

resources = directory / "client" / "resources"
resources.mkdir(parents=True)
(resources / "project.json").write_text(json.dumps(project), encoding="utf-8")
public_der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
(resources / "distribution.json").write_text(json.dumps({
    "version": 1, "project_code": project["code"], "campaign_code": "test-fixture", "license_mode": "enforce",
    "license_center_url": f"http://127.0.0.1:{args.port}", "jwt_issuer": "license-center",
    "jwt_audience": "license-center-clients", "offline_key_sha256": hashlib.sha256(public_der).hexdigest(),
}), encoding="utf-8")
(directory / "credentials.private.json").write_text(json.dumps({
    "username": "isolated_customer", "email": "isolated-customer@fixture.invalid",
    "password": user_password, "cards": cards["codes"],
    "shopIds": [f"fixture-{index + 1}" for index in range(10)],
}), encoding="utf-8")
server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port, access_log=False, log_level="error"))


def stop_from_parent():
    sys.stdin.readline()
    server.should_exit = True


threading.Thread(target=stop_from_parent, daemon=True).start()
(directory / "prepared.json").write_text(json.dumps({"prepared": True, "shops": 10, "productionDataUsed": False}), encoding="utf-8")
server.run()
(directory / "stopped.json").write_text(json.dumps({"stopped": True, "externalNetworkAttempts": network_attempts}), encoding="utf-8")

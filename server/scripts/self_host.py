"""Create an independent, loopback-only deployment without touching existing data."""
from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import sys
from datetime import UTC, datetime, timedelta

BACKEND = Path(__file__).resolve().parents[1]
WORKSPACE = BACKEND.parent
sys.path.insert(0, str(BACKEND))


def write_new(path: Path, data: str | bytes, *, private: bool = True):
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600 if private else 0o644)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data.encode("utf-8") if isinstance(data, str) else data)
        handle.flush()
        os.fsync(handle.fileno())


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def initialize(state: Path, client_root: Path, port: int = 18443):
    from cryptography import x509
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
    from cryptography.x509.oid import NameOID
    from fastapi.testclient import TestClient
    from app.config import Settings
    from app.main import create_app
    from app.protected_compute.canonical import canonical_json

    state = state.resolve()
    client_root = client_root.resolve()
    if state.exists():
        raise ValueError("STATE_ALREADY_EXISTS: existing data and keys will not be overwritten")
    if not 1024 <= port <= 65535:
        raise ValueError("PORT_INVALID")
    resources = client_root / "desktop/resources"
    outputs = [resources / "project.json", resources / "distribution.json",
               resources / "protected-compute/configuration-public.pem",
               resources / "protected-compute/protected-compute.signed-public.json",
               client_root / "local-api/config/local-api.config.json"]
    if any(p.exists() for p in outputs):
        raise ValueError("CLIENT_CONFIGURATION_EXISTS: refusing to replace an existing installation")
    project = json.loads((client_root / "desktop/resources/project.example.json").read_text(encoding="utf-8"))
    project["version_hash"] = ""
    local_config = json.loads((client_root / "local-api/config/local-api.config.example.json").read_text(encoding="utf-8"))
    local_config["ozon"]["enableRealWrite"] = False
    local_config["sync"]["continuousEnabled"] = False
    state.mkdir(parents=True)
    private = state / "private"
    private.mkdir(mode=0o700)
    # A unique local CA is trusted only by the launched child processes, never
    # installed into the operating system or browser certificate store.
    now = datetime.now(UTC)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    tls_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Wangzai local deployment CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=3650))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .sign(ca_key, hashes.SHA256()))
    tls = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
           .issuer_name(ca_name).public_key(tls_key.public_key()).serial_number(x509.random_serial_number())
           .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=365))
           .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
           .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
           .sign(ca_key, hashes.SHA256()))
    def pem(key):
        return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    def public(key):
        return key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    def fingerprint(key):
        return hashlib.sha256(key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    for name, key in [("ca-private.pem", ca_key), ("tls-private.pem", tls_key)]:
        write_new(private / name, pem(key))
    write_new(state / "ca.pem", ca.public_bytes(serialization.Encoding.PEM), private=False)
    write_new(state / "tls.pem", tls.public_bytes(serialization.Encoding.PEM), private=False)
    offline, compute, configuration = [ed25519.Ed25519PrivateKey.generate() for _ in range(3)]
    for name, key in [("offline.pem", offline), ("compute.pem", compute), ("configuration.pem", configuration)]:
        write_new(private / name, pem(key))
    password = secrets.token_urlsafe(24)
    admin_password = secrets.token_urlsafe(32)
    settings_values = {
        "app_env": "development", "database_url": f"sqlite:///{(state / 'license.sqlite').as_posix()}",
        "auto_create_tables": True, "redis_url": None, "debug": False,
        "offline_signing_private_key_file": str(private / "offline.pem"), "offline_signing_key_id": "local-offline-v1",
        "protected_compute_signing_private_key_file": str(private / "compute.pem"), "protected_compute_signing_key_id": "local-compute-v1",
        "bootstrap_admin_username": "local_admin", "bootstrap_admin_password": admin_password,
        "cross_border_company_secret_file": None,
        "cross_border_token_state_file": str(private / "cross-border-token.enc"),
        "paid_capability_enabled": False, "payment_development_enabled": False,
        "sms_expose_development_code": False, "background_loops_enabled": False,
        "cors_origins": "", "trusted_hosts": "localhost,127.0.0.1,testserver",
    }
    for name in ["jwt_secret_key", "card_hash_secret", "identity_hash_secret", "otp_hash_secret", "refresh_token_secret", "channel_token_secret", "api_pool_hash_secret"]:
        settings_values[name] = secrets.token_hex(32)
    for name in ["card_encryption_key", "identity_encryption_key", "api_pool_encryption_key"]:
        settings_values[name] = Fernet.generate_key().decode()
    settings = Settings(_env_file=None, **settings_values)
    app = create_app(settings)
    def checked(response, expected=200):
        if response.status_code != expected:
            raise RuntimeError(f"SELF_HOST_SETUP_API_FAILED:{response.request.url.path}:{response.status_code}")
        return response.json()
    with TestClient(app) as client:
        auth = checked(client.post("/api/auth/login", json={"username": "local_admin", "password": admin_password}))
        headers = {"Authorization": f"Bearer {auth['access_token']}"}
        imported = checked(client.post("/api/admin/projects/import", headers=headers, json=project))
        project_id = imported["project"]["id"]
        product = checked(client.get(f"/api/admin/products?project_id={project_id}", headers=headers))["items"][0]
        permissions = checked(client.get(f"/api/admin/permissions?project_id={project_id}", headers=headers))["items"]
        plan = checked(client.post("/api/admin/plans", headers=headers, json={
            "product_id": product["id"], "name": "本地自行签发年授权", "price": "600.00", "sale_price_cent": 60000,
            "license_role": "shop_standard_annual", "duration_days": 365, "max_devices": 1, "max_shops": 1,
            "offline_hours": 72, "permission_ids": [item["id"] for item in permissions],
        }), 201)
        checked(client.post("/api/admin/users", headers=headers, json={
            "username": "local_owner", "password": password, "email": "local-owner@example.invalid",
        }), 201)
        cards = checked(client.post("/api/admin/card-batches", headers=headers, json={"plan_id": plan["id"], "quantity": 20}), 201)
        if client.get(f"/api/license/entitlements?project_code={project['code']}").status_code != 401:
            raise RuntimeError("AUTHENTICATION_NOT_ENFORCED")
    server_url = f"https://127.0.0.1:{port}"
    signed = {
        "computeKeys": [{"algorithm": "Ed25519", "keyId": "local-compute-v1", "publicKeyPem": public(compute)}],
        "configVersion": 1, "contract": "signed-public-protected-compute-config/v1",
        "expiresAt": (now + timedelta(days=364)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "issuedAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "revocationEpoch": 0, "revokedCapabilities": [], "revokedKeyIds": [],
        "serverBaseUrl": server_url, "signatureAlgorithm": "Ed25519", "signingKeyId": "local-configuration-v1",
    }
    signed["signature"] = base64.urlsafe_b64encode(configuration.sign(canonical_json(signed))).rstrip(b"=").decode()
    distribution = {
        "version": 1, "project_code": project["code"], "license_mode": "enforce", "local_self_hosting": True,
        "license_center_url": server_url, "jwt_issuer": "license-center", "jwt_audience": "license-center-clients",
        "channel_code": "", "campaign_code": "local-self-hosted", "distribution_token": "",
        "offline_key_sha256": fingerprint(offline),
        "protected_compute": {"configuration_key_id": "local-configuration-v1", "configuration_key_sha256": fingerprint(configuration),
            "configuration_public_key_path": "protected-compute/configuration-public.pem",
            "signed_config_path": "protected-compute/protected-compute.signed-public.json"},
    }
    write_new(private / "settings.json", json_text(settings_values))
    write_new(private / "credentials.json", json_text({"username": "local-owner@example.invalid", "email": "local-owner@example.invalid", "password": password,
              "activationCode": cards["codes"][0], "activationCodes": cards["codes"],
              "adminUsername": "local_admin", "adminPassword": admin_password}))
    for output, value in zip(outputs, [json_text(project), json_text(distribution), public(configuration), json_text(signed), json_text(local_config)], strict=True):
        write_new(output, value, private=False)
    write_new(state / "deployment.json", json_text({"schemaVersion": 1, "clientRoot": str(client_root), "serverUrl": server_url,
              "port": port, "caSha256": hashlib.sha256((state / "ca.pem").read_bytes()).hexdigest(),
              "createdAt": now.isoformat(), "ready": True}), private=False)
    return {"ready": True, "serverUrl": server_url, "credentialsFile": str(private / "credentials.json"), "stateDirectory": str(state)}


def serve(state: Path):
    import uvicorn
    from app.config import Settings
    from app.main import create_app
    state = state.resolve()
    manifest = json.loads((state / "deployment.json").read_text(encoding="utf-8"))
    values = json.loads((state / "private/settings.json").read_text(encoding="utf-8"))
    values["bootstrap_admin_password"] = None
    values["bootstrap_admin_username"] = None
    core = state / "profit-core/profit-core.mjs"
    core_manifest = state / "profit-core/source-manifest.json"
    if core.is_file() and core_manifest.is_file():
        expected = json.loads(core_manifest.read_text(encoding="utf-8"))["codeSha256"]
        if hashlib.sha256(core.read_bytes()).hexdigest() != expected:
            raise ValueError("PROFIT_CORE_HASH_MISMATCH")
        values.update(private_profit_core_file=str(core), private_profit_core_sha256=expected, private_profit_node_executable=shutil.which("node"))
    app = create_app(Settings(_env_file=None, **values))
    uvicorn.run(app, host="127.0.0.1", port=manifest["port"], ssl_keyfile=str(state / "private/tls-private.pem"),
                ssl_certfile=str(state / "tls.pem"), access_log=False, log_level="warning")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["init", "serve"])
    parser.add_argument("--state-dir", type=Path, default=WORKSPACE / ".selfhost")
    parser.add_argument("--client-root", type=Path, default=WORKSPACE)
    parser.add_argument("--port", type=int, default=18443)
    args = parser.parse_args()
    if args.command == "init":
        print(json_text(initialize(args.state_dir, args.client_root, args.port)))
    else:
        serve(args.state_dir)

from __future__ import annotations

from collections.abc import Iterator

import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    protected_compute_private_pem = (
        Ed25519PrivateKey.generate()
        .private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        .decode("utf-8")
    )
    database_path = (tmp_path / "license-center.db").as_posix()
    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url=f"sqlite:///{database_path}",
        auto_create_tables=True,
        jwt_secret_key="test-jwt-secret-that-is-long-enough-for-hs256",
        card_hash_secret="test-card-hash-secret-that-never-rotates",
        card_encryption_key=Fernet.generate_key().decode("ascii"),
        identity_hash_secret="test-identity-hash-secret-that-never-rotates",
        identity_encryption_key=Fernet.generate_key().decode("ascii"),
        otp_hash_secret="test-otp-hash-secret-that-never-rotates",
        refresh_token_secret="test-refresh-token-secret-that-never-rotates",
        channel_token_secret="test-channel-token-secret-that-never-rotates",
        api_pool_hash_secret="test-api-pool-hash-secret-that-never-rotates",
        api_pool_encryption_key=Fernet.generate_key().decode("ascii"),
        offline_signing_private_key=private_pem,
        protected_compute_signing_private_key=protected_compute_private_pem,
        bootstrap_admin_username="admin",
        bootstrap_admin_password="AdminPass123!",
        redis_url=None,
        cors_origins="http://localhost:5174",
    )
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def admin_headers(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/auth/login", json={"username": "admin", "password": "AdminPass123!"}
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}

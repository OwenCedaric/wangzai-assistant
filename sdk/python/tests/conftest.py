from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

UTC = timezone.utc


class FakeTransport:
    def __init__(self, *responses: object) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Mapping[str, Any]:
        self.calls.append(
            {
                "method": method,
                "path": path,
                "json_body": dict(json_body or {}),
                "headers": dict(headers or {}),
            }
        )
        if not self.responses:
            raise AssertionError(f"No fake response queued for {method} {path}")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if not isinstance(response, Mapping):
            raise AssertionError("Fake response must be a mapping or exception")
        return response


def _encode(value: Mapping[str, Any]) -> str:
    raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


@pytest.fixture
def signing_material():
    private_key = Ed25519PrivateKey.generate()
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    def sign(
        *,
        project_code: str = "sample_app",
        device_code: str = "DEV-TEST-12345678",
        now: datetime | None = None,
        hours: float = 72,
        permissions: list[str] | None = None,
        key_id: str = "test-key",
        issuer: str | None = "license-center",
        audience: str | None = "license-center-clients",
        extra: Mapping[str, Any] | None = None,
    ) -> str:
        issued_at = now or datetime.now(UTC)
        deadline = issued_at + timedelta(hours=hours)
        header = {"alg": "EdDSA", "kid": key_id, "typ": "JWT"}
        claims: dict[str, Any] = {
            "project_code": project_code,
            "device_code": device_code,
            "license_id": "lic-test",
            "permissions": permissions or ["order_sync", "profit"],
            "device_limit": 2,
            "shop_limit": 3,
            "iat": int(issued_at.timestamp()),
            "nbf": int(issued_at.timestamp()),
            "exp": int(deadline.timestamp()),
            "offline_until": deadline.isoformat().replace("+00:00", "Z"),
            "expire": (issued_at + timedelta(days=30)).date().isoformat(),
        }
        if issuer is not None:
            claims["iss"] = issuer
        if audience is not None:
            claims["aud"] = audience
        claims.update(extra or {})
        encoded_header = _encode(header)
        encoded_claims = _encode(claims)
        signing_input = f"{encoded_header}.{encoded_claims}".encode("ascii")
        signature = (
            base64.urlsafe_b64encode(private_key.sign(signing_input)).rstrip(b"=").decode("ascii")
        )
        return f"{encoded_header}.{encoded_claims}.{signature}"

    return {"private_key": private_key, "public_pem": public_pem, "sign": sign}

from __future__ import annotations

import base64
import json
import os
import re
import sys
import tempfile
from pathlib import Path

DEPLOY_DIR = Path(__file__).resolve().parent
SECRET_DIR = DEPLOY_DIR / "secrets"
APP_ID_PATTERN = re.compile(r"^[0-9]{12,24}$")


def _require_text(payload: dict[str, object], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} is required")
    return value.strip()


def _normalize_der_key(value: str, *, name: str, minimum_bytes: int) -> str:
    compact = "".join(value.split())
    try:
        decoded = base64.b64decode(compact, validate=True)
    except ValueError as exc:
        raise ValueError(f"{name} must be valid base64 DER") from exc
    if len(decoded) < minimum_bytes or not decoded.startswith(b"\x30"):
        raise ValueError(f"{name} is not a valid RSA DER key")
    return compact


def _write_secret(name: str, value: str) -> None:
    SECRET_DIR.mkdir(parents=True, exist_ok=True)
    target = SECRET_DIR / name
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{name}.", dir=SECRET_DIR)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temporary_name, 0o600)
        except OSError:
            pass
        os.replace(temporary_name, target)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def configure(payload: dict[str, object]) -> dict[str, object]:
    app_id = _require_text(payload, "app_id")
    if not APP_ID_PATTERN.fullmatch(app_id):
        raise ValueError("app_id has an invalid format")
    private_key = _normalize_der_key(
        _require_text(payload, "private_pkcs_key"),
        name="private_pkcs_key",
        minimum_bytes=1100,
    )
    alipay_public_key = _normalize_der_key(
        _require_text(payload, "alipay_public_key"),
        name="alipay_public_key",
        minimum_bytes=250,
    )
    _write_secret("alipay_sandbox_app_id", app_id)
    _write_secret("alipay_sandbox_private_pkcs_key", private_key)
    _write_secret("alipay_sandbox_alipay_public_key", alipay_public_key)
    return {
        "configured": True,
        "environment": "sandbox",
        "app_id_suffix": app_id[-4:],
        "secret_files": 3,
    }


def main() -> int:
    try:
        raw_payload = json.load(sys.stdin)
        if not isinstance(raw_payload, dict):
            raise ValueError("configuration payload must be an object")
        result = configure(raw_payload)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"configured": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

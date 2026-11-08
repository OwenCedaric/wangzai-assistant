from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

DEPLOY_DIR = Path(__file__).resolve().parent
DEFAULT_SECRET_DIR = DEPLOY_DIR / "secrets"
APP_ID_PATTERN = re.compile(r"^[0-9]{12,24}$")


def _atomic_write(secret_dir: Path, name: str, value: str) -> None:
    secret_dir.mkdir(parents=True, exist_ok=True)
    target = secret_dir / name
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{name}.", dir=secret_dir)
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


def generate_key_files(
    app_id: str,
    *,
    secret_dir: Path = DEFAULT_SECRET_DIR,
    overwrite: bool = False,
) -> dict[str, object]:
    app_id = app_id.strip()
    if not APP_ID_PATTERN.fullmatch(app_id):
        raise ValueError("app_id has an invalid format")

    names = (
        "alipay_production_app_id",
        "alipay_production_private_pkcs_key",
        "alipay_production_app_public_key",
    )
    existing = [name for name in names if (secret_dir / name).exists()]
    if existing and not overwrite:
        raise FileExistsError(
            "production key files already exist; use --force only for an intentional rotation"
        )

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_der = private_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_der = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    private_value = base64.b64encode(private_der).decode("ascii")
    public_value = base64.b64encode(public_der).decode("ascii")

    _atomic_write(secret_dir, names[0], app_id)
    _atomic_write(secret_dir, names[1], private_value)
    _atomic_write(secret_dir, names[2], public_value)

    fingerprint = hashlib.sha256(public_der).hexdigest()
    return {
        "generated": True,
        "environment": "production",
        "app_id_suffix": app_id[-4:],
        "key_size": private_key.key_size,
        "public_key_sha256": fingerprint,
        "secret_files": len(names),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate a production-only Alipay RSA2 key pair"
    )
    parser.add_argument("--app-id", required=True)
    parser.add_argument(
        "--secret-dir",
        type=Path,
        default=DEFAULT_SECRET_DIR,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="rotate and replace existing production key files",
    )
    args = parser.parse_args()
    try:
        result = generate_key_files(
            args.app_id,
            secret_dir=args.secret_dir,
            overwrite=args.force,
        )
    except (OSError, ValueError) as exc:
        print(json.dumps({"generated": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

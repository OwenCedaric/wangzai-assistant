from __future__ import annotations

import argparse
import base64
import hashlib
import secrets
from pathlib import Path

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parent
SECRETS = ROOT / "secrets"
CONFIGURATION_SECRETS = ROOT.parent / ".secrets"
ENV_EXAMPLE = ROOT / ".env.production.example"
ENV_OUTPUT = ROOT / ".env.production"


def _write_private(path: Path, value: bytes, *, force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(
            f"{path.name} already exists; use --force only for a new deployment"
        )
    path.write_bytes(value)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _url_safe_secret(length: int = 48) -> str:
    return (
        base64.urlsafe_b64encode(secrets.token_bytes(length))
        .decode("ascii")
        .rstrip("=")
    )


def _ed25519_material() -> tuple[bytes, bytes, bytes]:
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    public_der = public_key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_pem, public_pem, public_der


def generate(domain: str, *, force: bool) -> None:
    if not domain or "://" in domain or "/" in domain:
        raise ValueError("--domain must be a DNS name without scheme or path")
    SECRETS.mkdir(parents=True, exist_ok=True)
    CONFIGURATION_SECRETS.mkdir(parents=True, exist_ok=True)
    secret_names = (
        "jwt_secret",
        "card_hash_secret",
        "identity_hash_secret",
        "otp_hash_secret",
        "refresh_token_secret",
        "channel_token_secret",
        "api_pool_hash_secret",
        "ozon_notification_callback_token",
        "card_encryption_key",
        "identity_encryption_key",
        "api_pool_encryption_key",
        "offline_signing_private_key.pem",
        "offline_public_key.pem",
        "offline_public_key.sha256",
        "protected_compute_ed25519_private.pem",
        "protected_compute_ed25519_public.pem",
        "protected_compute_ed25519_public.sha256",
    )
    configuration_secret_names = (
        "protected_compute_configuration_private.pem",
        "protected_compute_configuration_public.pem",
        "protected_compute_configuration_public.sha256",
    )
    targets = [
        ENV_OUTPUT,
        *(SECRETS / name for name in secret_names),
        *(CONFIGURATION_SECRETS / name for name in configuration_secret_names),
    ]
    existing = [path for path in targets if path.exists()]
    if existing and not force:
        names = ", ".join(path.name for path in existing)
        raise FileExistsError(
            f"Refusing to overwrite existing production material: {names}"
        )

    for name in secret_names[:8]:
        _write_private(SECRETS / name, f"{_url_safe_secret()}\n".encode(), force=force)
    _write_private(
        SECRETS / "card_encryption_key", Fernet.generate_key() + b"\n", force=force
    )
    _write_private(
        SECRETS / "identity_encryption_key", Fernet.generate_key() + b"\n", force=force
    )
    _write_private(
        SECRETS / "api_pool_encryption_key", Fernet.generate_key() + b"\n", force=force
    )

    private_pem, public_pem, public_der = _ed25519_material()
    _write_private(
        SECRETS / "offline_signing_private_key.pem", private_pem, force=force
    )
    _write_private(SECRETS / "offline_public_key.pem", public_pem, force=force)
    _write_private(
        SECRETS / "offline_public_key.sha256",
        f"{hashlib.sha256(public_der).hexdigest()}\n".encode(),
        force=force,
    )

    compute_private_pem, compute_public_pem, compute_public_der = _ed25519_material()
    _write_private(
        SECRETS / "protected_compute_ed25519_private.pem",
        compute_private_pem,
        force=force,
    )
    _write_private(
        SECRETS / "protected_compute_ed25519_public.pem",
        compute_public_pem,
        force=force,
    )
    _write_private(
        SECRETS / "protected_compute_ed25519_public.sha256",
        f"{hashlib.sha256(compute_public_der).hexdigest()}\n".encode(),
        force=force,
    )

    configuration_private_pem, configuration_public_pem, configuration_public_der = (
        _ed25519_material()
    )
    _write_private(
        CONFIGURATION_SECRETS / "protected_compute_configuration_private.pem",
        configuration_private_pem,
        force=force,
    )
    _write_private(
        CONFIGURATION_SECRETS / "protected_compute_configuration_public.pem",
        configuration_public_pem,
        force=force,
    )
    _write_private(
        CONFIGURATION_SECRETS / "protected_compute_configuration_public.sha256",
        f"{hashlib.sha256(configuration_public_der).hexdigest()}\n".encode(),
        force=force,
    )

    environment = ENV_EXAMPLE.read_text(encoding="utf-8")
    environment = environment.replace("license.example.com", domain)
    environment = environment.replace(
        "replace-with-generated-url-safe-password", _url_safe_secret(32)
    )
    ENV_OUTPUT.write_text(environment, encoding="utf-8", newline="\n")
    try:
        ENV_OUTPUT.chmod(0o600)
    except OSError:
        pass


def generate_missing_paid_pool_secrets(*, secrets_dir: Path = SECRETS) -> list[str]:
    """Add only the API-pool secrets required by an existing deployment.

    This intentionally never rotates an existing value. Rotating the Fernet
    key without re-encrypting stored provider keys would make the API pool
    unusable.
    """
    secrets_dir.mkdir(parents=True, exist_ok=True)
    created: list[str] = []
    hash_path = secrets_dir / "api_pool_hash_secret"
    encryption_path = secrets_dir / "api_pool_encryption_key"
    if not hash_path.exists():
        _write_private(hash_path, f"{_url_safe_secret()}\n".encode(), force=False)
        created.append(hash_path.name)
    if not encryption_path.exists():
        _write_private(encryption_path, Fernet.generate_key() + b"\n", force=False)
        created.append(encryption_path.name)
    return created


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate License Center production secrets"
    )
    parser.add_argument(
        "--domain", help="Public DNS name, e.g. license.example.com"
    )
    parser.add_argument(
        "--force", action="store_true", help="Overwrite all generated secrets"
    )
    parser.add_argument(
        "--missing-paid-pool",
        action="store_true",
        help="Create only missing API-pool secrets without rotating existing material",
    )
    args = parser.parse_args()
    if args.missing_paid_pool:
        if args.force:
            parser.error("--missing-paid-pool cannot be combined with --force")
        created = generate_missing_paid_pool_secrets()
        print(
            "Paid API-pool secrets are ready"
            + (f"; created: {', '.join(created)}" if created else "; nothing changed")
        )
        return
    if not args.domain:
        parser.error("--domain is required unless --missing-paid-pool is used")
    generate(args.domain.strip().lower(), force=args.force)
    print(f"Generated production service files under {ROOT}")
    print(f"Generated offline configuration-root files under {CONFIGURATION_SECRETS}")
    print(
        "Next: add the real SMS secret and payment credentials, then run Docker Compose."
    )


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate License Center offline signing keys")
    parser.add_argument("--output-dir", type=Path, default=Path(".secrets"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    private_path = args.output_dir / "offline_ed25519_private.pem"
    public_path = args.output_dir / "offline_ed25519_public.pem"
    if not args.force and (private_path.exists() or public_path.exists()):
        raise SystemExit("Key file already exists; use --force to replace it")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    private_key = Ed25519PrivateKey.generate()
    private_path.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    private_path.chmod(0o600)
    public_path.write_bytes(
        private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )
    public_path.chmod(0o644)
    print(f"Private key: {private_path.resolve()}")
    print(f"Public key:  {public_path.resolve()}")
    print("Store the private key outside source control and configure its *_FILE path.")


if __name__ == "__main__":
    main()

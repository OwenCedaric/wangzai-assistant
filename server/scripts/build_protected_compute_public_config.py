from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from datetime import UTC, datetime, timedelta
from ipaddress import IPv6Address, ip_address
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.protected_compute.canonical import canonical_json  # noqa: E402

SIGNED_CONFIG_RELATIVE_PATH = Path(
    "protected-compute/protected-compute.signed-public.json"
)
CONFIGURATION_PUBLIC_KEY_RELATIVE_PATH = Path(
    "protected-compute/configuration-public.pem"
)
BUNDLE_METADATA_FILE = "desktop-protected-compute.json"
_KEY_ID_PATTERN = re.compile(r"[A-Za-z0-9._:-]{1,128}", flags=re.ASCII)
_CAPABILITY_PATTERN = re.compile(r"[a-z][a-z0-9.-]+(?:@[0-9]+)?", flags=re.ASCII)
_RESERVED_FIXTURE_TLDS = (".example", ".invalid", ".localhost", ".test")
_RESERVED_DOCUMENTATION_DOMAINS = ("example.com", "example.net", "example.org")


def _private_key(path: Path) -> Ed25519PrivateKey:
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError(f"{path} must contain an Ed25519 private key")
    return key


def _public_key(path: Path) -> Ed25519PublicKey:
    key = serialization.load_pem_public_key(path.read_bytes())
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError(f"{path} must contain an Ed25519 public key")
    return key


def _is_test_fixture_hostname(value: str) -> bool:
    hostname = value.strip().lower().rstrip(".")
    if not hostname:
        return False
    if (
        hostname == "localhost"
        or hostname.endswith(".localhost")
        or hostname == "localhost.localdomain"
        or hostname.endswith(".localhost.localdomain")
    ):
        return True
    if any(
        hostname == suffix[1:] or hostname.endswith(suffix)
        for suffix in _RESERVED_FIXTURE_TLDS
    ):
        return True
    if any(
        hostname == domain or hostname.endswith(f".{domain}")
        for domain in _RESERVED_DOCUMENTATION_DOMAINS
    ):
        return True
    try:
        address = ip_address(hostname)
    except ValueError:
        return False
    if address.is_loopback or address.is_unspecified:
        return True
    return (
        isinstance(address, IPv6Address)
        and address.ipv4_mapped is not None
        and address.ipv4_mapped.is_loopback
    )


def _validate_base_url(
    value: str, *, allow_test_fixture_urls: bool = False
) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("server base URL must be HTTPS without userinfo, query, or fragment")
    if allow_test_fixture_urls is not True and _is_test_fixture_hostname(
        parsed.hostname
    ):
        raise ValueError(
            "server base URL must not use placeholder, documentation-reserved, "
            "localhost, or loopback hosts"
        )
    return value.rstrip("/")


def _key_id(value: str, label: str) -> str:
    normalized = value.strip()
    if _KEY_ID_PATTERN.fullmatch(normalized) is None:
        raise ValueError(f"{label} must use the fixed ASCII key-id grammar")
    return normalized


def _revocations(values: list[str], *, capability: bool) -> list[str]:
    pattern = _CAPABILITY_PATTERN if capability else _KEY_ID_PATTERN
    normalized = sorted(set(values))
    if any(pattern.fullmatch(value) is None for value in normalized):
        label = "capability" if capability else "key ID"
        raise ValueError(f"revoked {label} is invalid")
    return normalized


def _positive_version(value: int, label: str, *, allow_zero: bool = False) -> int:
    minimum = 0 if allow_zero else 1
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_signed_public_config(
    *,
    configuration_private_key: Ed25519PrivateKey,
    configuration_key_id: str,
    compute_public_key: Ed25519PublicKey,
    compute_key_id: str,
    server_base_url: str,
    issued_at: datetime,
    expires_at: datetime,
    config_version: int,
    revocation_epoch: int,
    revoked_key_ids: list[str],
    revoked_capabilities: list[str],
    allow_test_fixture_urls: bool = False,
) -> dict[str, object]:
    configuration_key_id = _key_id(configuration_key_id, "configuration key ID")
    compute_key_id = _key_id(compute_key_id, "compute key ID")
    config_version = _positive_version(config_version, "config version")
    revocation_epoch = _positive_version(
        revocation_epoch, "revocation epoch", allow_zero=True
    )
    if issued_at.tzinfo is None or expires_at.tzinfo is None:
        raise ValueError("signed-public config times must be timezone-aware")
    if expires_at <= issued_at or expires_at - issued_at > timedelta(days=365):
        raise ValueError("signed-public config validity must be in (0, 365 days]")
    payload: dict[str, object] = {
        "computeKeys": [
            {
                "algorithm": "Ed25519",
                "keyId": compute_key_id,
                "publicKeyPem": compute_public_key.public_bytes(
                    serialization.Encoding.PEM,
                    serialization.PublicFormat.SubjectPublicKeyInfo,
                ).decode(),
            }
        ],
        "configVersion": config_version,
        "contract": "signed-public-protected-compute-config/v1",
        "expiresAt": _iso(expires_at),
        "issuedAt": _iso(issued_at),
        "revocationEpoch": revocation_epoch,
        "revokedCapabilities": _revocations(
            revoked_capabilities, capability=True
        ),
        "revokedKeyIds": _revocations(revoked_key_ids, capability=False),
        "serverBaseUrl": _validate_base_url(
            server_base_url,
            allow_test_fixture_urls=allow_test_fixture_urls is True,
        ),
        "signatureAlgorithm": "Ed25519",
        "signingKeyId": configuration_key_id,
    }
    signature = configuration_private_key.sign(canonical_json(payload))
    return {
        **payload,
        "signature": base64.urlsafe_b64encode(signature).rstrip(b"=").decode(),
    }


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _atomic_write(path: Path, value: bytes, *, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            temporary.chmod(mode)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_desktop_bundle(
    *,
    bundle_root: Path,
    signed_config: dict[str, object],
    configuration_public_key: Ed25519PublicKey,
    configuration_key_id: str,
) -> dict[str, object]:
    public_pem = configuration_public_key.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    public_der = configuration_public_key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    signed_bytes = (
        json.dumps(signed_config, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    configuration_sha256 = hashlib.sha256(public_der).hexdigest()
    metadata: dict[str, object] = {
        "configurationKeyId": configuration_key_id,
        "configurationKeySha256": configuration_sha256,
        "configurationPublicKeyPath": CONFIGURATION_PUBLIC_KEY_RELATIVE_PATH.as_posix(),
        "configExpiresAt": signed_config["expiresAt"],
        "configVersion": signed_config["configVersion"],
        "contract": "desktop-protected-compute-bundle/v1",
        "serverBaseUrl": signed_config["serverBaseUrl"],
        "signedConfigPath": SIGNED_CONFIG_RELATIVE_PATH.as_posix(),
        "signedConfigSha256": hashlib.sha256(signed_bytes).hexdigest(),
    }
    _atomic_write(bundle_root / SIGNED_CONFIG_RELATIVE_PATH, signed_bytes)
    _atomic_write(
        bundle_root / CONFIGURATION_PUBLIC_KEY_RELATIVE_PATH,
        public_pem,
    )
    _atomic_write(
        bundle_root / BUNDLE_METADATA_FILE,
        (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build signed-public protected-compute runtime configuration"
    )
    parser.add_argument("--configuration-private-key", type=Path, required=True)
    parser.add_argument(
        "--configuration-key-id", default="protected-compute-config-v1"
    )
    parser.add_argument("--compute-public-key", type=Path, required=True)
    parser.add_argument("--compute-key-id", default="protected-compute-v1")
    parser.add_argument("--server-base-url", required=True)
    parser.add_argument(
        "--allow-test-fixture-urls",
        action="store_true",
        help=(
            "tests only: allow placeholder/reserved or loopback server hosts; "
            "desktop seal/verify production gates still reject them"
        ),
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--desktop-bundle-dir",
        type=Path,
        help="write the public-only desktop release bundle under this directory",
    )
    parser.add_argument("--valid-days", type=int, default=30, choices=range(1, 366))
    parser.add_argument("--config-version", type=int, default=1)
    parser.add_argument("--revocation-epoch", type=int, default=0)
    parser.add_argument("--revoked-key-ids", default="")
    parser.add_argument("--revoked-capabilities", default="")
    args = parser.parse_args()
    if args.output is None and args.desktop_bundle_dir is None:
        parser.error("at least one of --output or --desktop-bundle-dir is required")
    configuration_private_key = _private_key(args.configuration_private_key)
    issued_at = datetime.now(UTC)
    result = build_signed_public_config(
        configuration_private_key=configuration_private_key,
        configuration_key_id=args.configuration_key_id,
        compute_public_key=_public_key(args.compute_public_key),
        compute_key_id=args.compute_key_id,
        server_base_url=args.server_base_url,
        issued_at=issued_at,
        expires_at=issued_at + timedelta(days=args.valid_days),
        config_version=args.config_version,
        revocation_epoch=args.revocation_epoch,
        revoked_key_ids=_csv(args.revoked_key_ids),
        revoked_capabilities=_csv(args.revoked_capabilities),
        allow_test_fixture_urls=args.allow_test_fixture_urls,
    )
    signed_bytes = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode(
        "utf-8"
    )
    if args.output is not None:
        _atomic_write(args.output, signed_bytes)
        print(f"Signed-public config: {args.output.resolve()}")
    if args.desktop_bundle_dir is not None:
        metadata = write_desktop_bundle(
            bundle_root=args.desktop_bundle_dir,
            signed_config=result,
            configuration_public_key=configuration_private_key.public_key(),
            configuration_key_id=_key_id(
                args.configuration_key_id, "configuration key ID"
            ),
        )
        print(
            "Desktop public bundle: "
            f"{args.desktop_bundle_dir.resolve()} "
            f"key={metadata['configurationKeyId']} "
            f"fingerprint={str(metadata['configurationKeySha256'])[:12]}"
        )


if __name__ == "__main__":
    main()

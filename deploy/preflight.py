from __future__ import annotations

import argparse
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
PLACEHOLDER_MARKERS = ("example.com", ".invalid", "replace-with", "change-me")


def load_environment(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def is_placeholder(value: str | None) -> bool:
    normalized = (value or "").strip().lower()
    return not normalized or any(marker in normalized for marker in PLACEHOLDER_MARKERS)


def valid_public_domain(value: str | None) -> bool:
    domain = (value or "").strip().lower().rstrip(".")
    if is_placeholder(domain) or len(domain) > 253 or "." not in domain:
        return False
    return all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in domain.split(".")
    )


def valid_https_url(value: str | None, *, domain: str | None = None) -> bool:
    try:
        parsed = urlsplit((value or "").strip())
    except ValueError:
        return False
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return False
    if is_placeholder(parsed.hostname):
        return False
    return domain is None or parsed.hostname.lower() == domain.lower()


def host_list(value: str | None) -> set[str]:
    return {
        item.strip().lower().rstrip(".")
        for item in (value or "").split(",")
        if item.strip()
    }


def valid_public_host(value: str) -> bool:
    return valid_public_domain(value)


def validate_paid_capability_configuration(
    blockers: list[str],
    environment: dict[str, str],
) -> None:
    allowed_hosts = host_list(environment.get("PAID_PROVIDER_ALLOWED_HOSTS"))
    if not allowed_hosts or any(not valid_public_host(host) for host in allowed_hosts):
        blockers.append("PAID_PROVIDER_ALLOWED_HOSTS must contain valid public DNS names")

    for variable in (
        "PAID_TEXT_BASE_URL",
        "PAID_IMAGE_BASE_URL",
        "PAID_SEERFAR_BASE_URL",
    ):
        value = environment.get(variable)
        if not valid_https_url(value):
            blockers.append(f"{variable} must be a real HTTPS URL")
            continue
        hostname = (urlsplit(value or "").hostname or "").lower()
        if hostname not in allowed_hosts:
            blockers.append(f"{variable} host must be present in PAID_PROVIDER_ALLOWED_HOSTS")

    approved_image_url = environment.get("WANGZAI_IMAGE_API_URL", "").strip().rstrip("/")
    if not valid_https_url(approved_image_url):
        blockers.append("WANGZAI_IMAGE_API_URL must explicitly configure the trusted HTTPS image provider")
    if environment.get("PAID_IMAGE_BASE_URL", "").strip().rstrip("/") != approved_image_url:
        blockers.append(
            "PAID_IMAGE_BASE_URL must match WANGZAI_IMAGE_API_URL"
        )

    source_hosts = host_list(environment.get("PAID_SOURCE_IMAGE_ALLOWED_HOSTS"))
    if not source_hosts or any(not valid_public_host(host) for host in source_hosts):
        blockers.append("PAID_SOURCE_IMAGE_ALLOWED_HOSTS must contain valid public DNS names")
    if "oss-accelerate.aliyuncs.com" in source_hosts:
        blockers.append(
            "PAID_SOURCE_IMAGE_ALLOWED_HOSTS must use the regional private OSS host, not OSS accelerate"
        )

    for variable in (
        "PAID_TEXT_API_KEY_FILE",
        "PAID_IMAGE_API_KEY_FILE",
        "PAID_SEERFAR_API_KEY_FILE",
        "API_POOL_HASH_SECRET_FILE",
        "API_POOL_ENCRYPTION_KEY_FILE",
    ):
        require_secret(blockers, variable, environment)


def require_secret(blockers: list[str], variable: str, environment: dict[str, str]) -> None:
    raw_path = environment.get(variable, "").strip()
    if not raw_path:
        blockers.append(f"{variable} is not configured")
        return
    path = (
        ROOT / "secrets" / Path(raw_path).name
        if raw_path.startswith("/run/secrets/")
        else Path(raw_path)
    )
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    if not path.is_file() or path.stat().st_size == 0:
        blockers.append(f"{variable} does not point to a non-empty secret file")


def run_preflight(environment_path: Path) -> tuple[list[str], list[str]]:
    blockers: list[str] = []
    warnings: list[str] = []
    if not environment_path.is_file():
        return [f"production environment file not found: {environment_path}"], warnings

    environment = load_environment(environment_path)
    domain = environment.get("LICENSE_DOMAIN")
    if not valid_public_domain(domain):
        blockers.append("LICENSE_DOMAIN must be a real public DNS name")

    if is_placeholder(environment.get("POSTGRES_PASSWORD")):
        blockers.append("POSTGRES_PASSWORD is empty or still a placeholder")

    required_service_secrets = (
        "JWT_SECRET_KEY_FILE",
        "CARD_HASH_SECRET_FILE",
        "CARD_ENCRYPTION_KEY_FILE",
        "IDENTITY_HASH_SECRET_FILE",
        "IDENTITY_ENCRYPTION_KEY_FILE",
        "OTP_HASH_SECRET_FILE",
        "REFRESH_TOKEN_SECRET_FILE",
        "CHANNEL_TOKEN_SECRET_FILE",
        "OFFLINE_SIGNING_PRIVATE_KEY_FILE",
        "PROTECTED_COMPUTE_SIGNING_PRIVATE_KEY_FILE",
        "OZON_NOTIFICATION_CALLBACK_TOKEN_FILE",
    )
    compose_defaults = {
        "JWT_SECRET_KEY_FILE": "/run/secrets/jwt_secret",
        "CARD_HASH_SECRET_FILE": "/run/secrets/card_hash_secret",
        "CARD_ENCRYPTION_KEY_FILE": "/run/secrets/card_encryption_key",
        "IDENTITY_HASH_SECRET_FILE": "/run/secrets/identity_hash_secret",
        "IDENTITY_ENCRYPTION_KEY_FILE": "/run/secrets/identity_encryption_key",
        "OTP_HASH_SECRET_FILE": "/run/secrets/otp_hash_secret",
        "REFRESH_TOKEN_SECRET_FILE": "/run/secrets/refresh_token_secret",
        "CHANNEL_TOKEN_SECRET_FILE": "/run/secrets/channel_token_secret",
        "OFFLINE_SIGNING_PRIVATE_KEY_FILE": "/run/secrets/offline_signing_private_key.pem",
        "PROTECTED_COMPUTE_SIGNING_PRIVATE_KEY_FILE": (
            "/run/secrets/protected_compute_ed25519_private.pem"
        ),
        "OZON_NOTIFICATION_CALLBACK_TOKEN_FILE": (
            "/run/secrets/ozon_notification_callback_token"
        ),
        "API_POOL_HASH_SECRET_FILE": "/run/secrets/api_pool_hash_secret",
        "API_POOL_ENCRYPTION_KEY_FILE": "/run/secrets/api_pool_encryption_key",
        "PAID_TEXT_API_KEY_FILE": "/run/secrets/paid_text_api_key",
        "PAID_IMAGE_API_KEY_FILE": "/run/secrets/paid_image_api_key",
        "PAID_SEERFAR_API_KEY_FILE": "/run/secrets/paid_seerfar_api_key",
    }
    merged_environment = {**compose_defaults, **environment}
    for variable in required_service_secrets:
        require_secret(blockers, variable, merged_environment)

    if environment.get("SMS_PROVIDER") not in {"aliyun", "tencent"}:
        blockers.append("SMS_PROVIDER must be aliyun or tencent in production")
    require_secret(blockers, "SMS_SECRET_KEY_FILE", environment)
    for variable in ("SMS_ACCESS_KEY", "SMS_SIGN_NAME", "SMS_TEMPLATE_CODE"):
        if is_placeholder(environment.get(variable)):
            blockers.append(f"{variable} is empty or still a placeholder")

    if environment.get("PAYMENT_DEVELOPMENT_ENABLED", "").lower() != "false":
        blockers.append("PAYMENT_DEVELOPMENT_ENABLED must be false")
    payment_mode = environment.get("PAYMENT_GATEWAY_MODE", "direct")
    default_provider = environment.get("PAYMENT_DEFAULT_PROVIDER", "development")
    if default_provider not in {"wechat", "alipay"}:
        blockers.append("PAYMENT_DEFAULT_PROVIDER must be wechat or alipay")
    if payment_mode == "jeepay":
        if environment.get("JEEPAY_ENABLED", "").lower() != "true":
            blockers.append("JEEPAY_ENABLED must be true when Jeepay is selected")
        if not valid_https_url(environment.get("JEEPAY_API_BASE_URL")):
            blockers.append("JEEPAY_API_BASE_URL must be a real HTTPS URL")
        for variable in ("JEEPAY_MCH_NO", "JEEPAY_APP_ID"):
            if is_placeholder(environment.get(variable)):
                blockers.append(f"{variable} is empty or still a placeholder")
        require_secret(blockers, "JEEPAY_API_KEY_FILE", environment)
        alipay_enabled = environment.get("JEEPAY_ALIPAY_ENABLED", "").lower() == "true"
        wechat_enabled = environment.get("JEEPAY_WECHAT_ENABLED", "").lower() == "true"
        if not (alipay_enabled or wechat_enabled):
            blockers.append("at least one Jeepay payment channel must be enabled")
        if default_provider == "alipay" and not alipay_enabled:
            blockers.append("JEEPAY_ALIPAY_ENABLED must be true for the default provider")
        if default_provider == "wechat" and not wechat_enabled:
            blockers.append("JEEPAY_WECHAT_ENABLED must be true for the default provider")
        for variable in ("JEEPAY_NOTIFY_URL", "JEEPAY_REFUND_NOTIFY_URL"):
            if not valid_https_url(environment.get(variable), domain=domain):
                blockers.append(f"{variable} must use the production License Center domain")
    elif payment_mode == "direct":
        if default_provider == "wechat":
            for variable in ("WECHAT_MCH_ID", "WECHAT_APP_ID", "WECHAT_MERCHANT_SERIAL_NO"):
                if is_placeholder(environment.get(variable)):
                    blockers.append(f"{variable} is empty or still a placeholder")
            for variable in (
                "WECHAT_API_V3_KEY_FILE",
                "WECHAT_PRIVATE_KEY_FILE",
                "WECHAT_PLATFORM_CERTIFICATE_FILE",
            ):
                require_secret(blockers, variable, environment)
            notify_variables = ("WECHAT_NOTIFY_URL", "WECHAT_REFUND_NOTIFY_URL")
        else:
            if is_placeholder(environment.get("ALIPAY_APP_ID")):
                blockers.append("ALIPAY_APP_ID is empty or still a placeholder")
            require_secret(blockers, "ALIPAY_PRIVATE_PKCS_KEY_FILE", environment)
            require_secret(blockers, "ALIPAY_ALIPAY_PUBLIC_KEY_FILE", environment)
            notify_variables = ("ALIPAY_NOTIFY_URL",)
        for variable in notify_variables:
            if not valid_https_url(environment.get(variable), domain=domain):
                blockers.append(f"{variable} must use the production License Center domain")
    else:
        blockers.append("PAYMENT_GATEWAY_MODE must be direct or jeepay")

    if environment.get("PAID_CAPABILITY_ENABLED", "false").lower() == "true":
        validate_paid_capability_configuration(blockers, merged_environment)

    if environment.get("BOOTSTRAP_ADMIN_USERNAME") or environment.get("BOOTSTRAP_ADMIN_PASSWORD"):
        warnings.append(
            "bootstrap admin credentials are still present; remove them after first login"
        )

    if shutil.which("docker"):
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--env-file",
                str(environment_path),
                "-f",
                str(PROJECT_ROOT / "compose.production.yaml"),
                "config",
                "--quiet",
            ],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            blockers.append("Docker Compose configuration validation failed")
    else:
        warnings.append("Docker is not installed here; Compose validation was skipped")
    return blockers, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate production deployment readiness")
    parser.add_argument(
        "--env-file",
        type=Path,
        default=ROOT / ".env.production",
        help="production environment file",
    )
    args = parser.parse_args()
    environment_path = args.env_file.resolve()
    blockers, warnings = run_preflight(environment_path)
    for warning in warnings:
        print(f"WARN: {warning}")
    for blocker in blockers:
        print(f"BLOCKER: {blocker}")
    if blockers:
        print(f"NOT READY: {len(blockers)} blocker(s), {len(warnings)} warning(s)")
        return 1
    print(f"READY: 0 blockers, {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

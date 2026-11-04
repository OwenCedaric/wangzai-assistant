from pathlib import Path

MANAGEMENT_ROOT = Path(__file__).resolve().parents[2]


def test_container_entrypoint_copies_every_runtime_secret_before_dropping_privileges() -> None:
    entrypoint = (MANAGEMENT_ROOT / "server" / "docker-entrypoint.sh").read_text(encoding="utf-8")
    required_variables = {
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
        "PAID_TEXT_API_KEY_FILE",
        "PAID_IMAGE_API_KEY_FILE",
        "PAID_SEERFAR_API_KEY_FILE",
        "API_POOL_HASH_SECRET_FILE",
        "API_POOL_ENCRYPTION_KEY_FILE",
        "SMS_SECRET_KEY_FILE",
        "WECHAT_API_V3_KEY_FILE",
        "WECHAT_PRIVATE_KEY_FILE",
        "WECHAT_PLATFORM_CERTIFICATE_FILE",
        "ALIPAY_APP_ID_FILE",
        "ALIPAY_PRIVATE_PKCS_KEY_FILE",
        "ALIPAY_ALIPAY_PUBLIC_KEY_FILE",
        "ALIPAY_PRIVATE_KEY_FILE",
        "ALIPAY_PUBLIC_KEY_FILE",
        "JEEPAY_API_KEY_FILE",
    }
    assert required_variables <= set(entrypoint.split())
    assert '--workers "${BACKEND_WORKERS:-2}"' in entrypoint
    # Migrations run once in the dedicated migrate role; API roles opt out.
    assert 'if [ "${BACKEND_ROLE:-api}" = "migrate" ]; then' in entrypoint
    assert 'if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then' in entrypoint


def test_production_compose_exposes_http3_and_keeps_data_services_private() -> None:
    compose = (MANAGEMENT_ROOT / "compose.production.yaml").read_text(encoding="utf-8")
    assert '"443:443/udp"' in compose
    assert "BACKEND_WORKERS: ${BACKEND_WORKERS:-4}" in compose
    assert "maxmemory-policy" in compose
    assert "noeviction" in compose
    assert "postgres-data:/var/lib/postgresql/data" in compose
    assert "redis-data:/data" in compose
    assert "ports:" not in compose.split("  postgres:", 1)[1].split("  redis:", 1)[0]
    assert "ports:" not in compose.split("  redis:", 1)[1].split("  admin:", 1)[0]


def test_production_compose_separates_light_heavy_and_worker_roles() -> None:
    import yaml

    compose = yaml.safe_load(
        (MANAGEMENT_ROOT / "compose.production.yaml").read_text(encoding="utf-8")
    )
    services = compose["services"]
    assert services["migrate"]["environment"]["BACKEND_ROLE"] == "migrate"
    assert services["migrate"]["restart"] == "no"
    for role in ("backend", "backend-heavy", "worker"):
        environment = services[role]["environment"]
        assert environment["RUN_MIGRATIONS"] == "false"
        assert services[role]["depends_on"]["migrate"]["condition"] == (
            "service_completed_successfully"
        )
        assert "ports" not in services[role]
    assert services["backend"]["environment"]["BACKGROUND_LOOPS_ENABLED"] == "false"
    assert services["backend-heavy"]["environment"]["BACKGROUND_LOOPS_ENABLED"] == "false"
    assert services["worker"]["environment"]["BACKGROUND_LOOPS_ENABLED"] == "true"
    caddyfile = (MANAGEMENT_ROOT / "deploy" / "Caddyfile").read_text(encoding="utf-8")
    heavy_block = caddyfile.split("handle @heavy {", 1)[1].split("@api path", 1)[0]
    assert "reverse_proxy backend-heavy:8000" in heavy_block
    assert "response_header_timeout 330s" in heavy_block
    assert caddyfile.index("handle @heavy {") < caddyfile.index("handle @api {")
    for path in (
        "/api/core-v2/*",
        "/api/protected-compute/*",
        "/api/paid-capabilities/*",
        "/api/recovery/objects/*",
    ):
        assert path in caddyfile.split("@heavy path", 1)[1].split("\n", 1)[0]

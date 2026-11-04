from __future__ import annotations

from importlib import util
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str, relative_path: str):
    spec = util.spec_from_file_location(name, PROJECT_ROOT / relative_path)
    assert spec is not None and spec.loader is not None
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


preflight = load_module("license_center_deploy_preflight", "deploy/preflight.py")
secret_generator = load_module(
    "license_center_deploy_generate_secrets",
    "deploy/generate_secrets.py",
)


def paid_environment(tmp_path: Path) -> dict[str, str]:
    environment = {
        "PAID_PROVIDER_ALLOWED_HOSTS": (
            "api.openai.com,api.seerfar.cn"
        ),
        "PAID_TEXT_BASE_URL": "https://api.openai.com/v1",
        "PAID_IMAGE_BASE_URL": "https://api.openai.com/v1",
        "WANGZAI_IMAGE_API_URL": "https://api.openai.com/v1",
        "PAID_SEERFAR_BASE_URL": "https://api.seerfar.cn",
        "PAID_SOURCE_IMAGE_ALLOWED_HOSTS": (
            "wangzai-product-images.example.cn.oss-cn-hongkong.aliyuncs.com"
        ),
    }
    for variable, filename in {
        "PAID_TEXT_API_KEY_FILE": "paid_text_api_key",
        "PAID_IMAGE_API_KEY_FILE": "paid_image_api_key",
        "PAID_SEERFAR_API_KEY_FILE": "paid_seerfar_api_key",
        "API_POOL_HASH_SECRET_FILE": "api_pool_hash_secret",
        "API_POOL_ENCRYPTION_KEY_FILE": "api_pool_encryption_key",
    }.items():
        path = tmp_path / filename
        path.write_text("test-secret-value\n", encoding="utf-8")
        environment[variable] = str(path)
    return environment


def test_paid_production_configuration_accepts_complete_https_routes(tmp_path: Path) -> None:
    blockers: list[str] = []
    preflight.validate_paid_capability_configuration(blockers, paid_environment(tmp_path))
    assert blockers == []


def test_paid_production_configuration_rejects_unlisted_provider_host(tmp_path: Path) -> None:
    environment = paid_environment(tmp_path)
    environment["PAID_IMAGE_BASE_URL"] = "https://unexpected.example.net/v1"
    blockers: list[str] = []
    preflight.validate_paid_capability_configuration(blockers, environment)
    assert "PAID_IMAGE_BASE_URL host must be present in PAID_PROVIDER_ALLOWED_HOSTS" in blockers


def test_paid_production_configuration_rejects_oss_accelerate_source(tmp_path: Path) -> None:
    environment = paid_environment(tmp_path)
    environment["PAID_SOURCE_IMAGE_ALLOWED_HOSTS"] = "oss-accelerate.aliyuncs.com"
    blockers: list[str] = []
    preflight.validate_paid_capability_configuration(blockers, environment)
    assert any("regional private OSS host" in blocker for blocker in blockers)


def test_missing_paid_pool_secret_generation_never_rotates_existing_value(
    tmp_path: Path,
) -> None:
    hash_path = tmp_path / "api_pool_hash_secret"
    hash_path.write_text("keep-existing-hash\n", encoding="utf-8")
    created = secret_generator.generate_missing_paid_pool_secrets(secrets_dir=tmp_path)
    assert created == ["api_pool_encryption_key"]
    assert hash_path.read_text(encoding="utf-8") == "keep-existing-hash\n"
    encryption_path = tmp_path / "api_pool_encryption_key"
    first_encryption_value = encryption_path.read_bytes()

    assert secret_generator.generate_missing_paid_pool_secrets(secrets_dir=tmp_path) == []
    assert encryption_path.read_bytes() == first_encryption_value

"""License Center v1.0 通用接入示例。

Ozon 助手只是 project.json 里的演示项目。脚本从清单和环境变量读取所有项目、服务和
凭据配置，复制到其他软件时不需要修改 SDK。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from license_sdk import APIError, License, LicenseSDKError, TransportError

HERE = Path(__file__).resolve().parent


def load_project() -> dict[str, Any]:
    manifest_path = Path(os.environ.get("LICENSE_PROJECT_FILE", HERE / "project.json"))
    with manifest_path.open("r", encoding="utf-8") as file:
        manifest = json.load(file)
    if not isinstance(manifest, dict) or not manifest.get("code") or not manifest.get("version"):
        raise ValueError("project.json 缺少 code 或 version")
    return manifest


def first_permission_code(manifest: dict[str, Any]) -> str | None:
    configured = os.environ.get("LICENSE_DEMO_PERMISSION")
    if configured:
        return configured
    for module in manifest.get("modules", []):
        if isinstance(module, dict) and isinstance(module.get("code"), str):
            return module["code"]
    return None


def main() -> int:
    manifest = load_project()
    public_key_path = os.environ.get("LICENSE_OFFLINE_PUBLIC_KEY_FILE")
    client = License(
        app=str(manifest["code"]),
        version=str(manifest["version"]),
        version_hash=manifest.get("version_hash"),
        base_url=os.environ.get("LICENSE_CENTER_URL", "http://127.0.0.1:8000"),
        offline_public_key=Path(public_key_path) if public_key_path else None,
        offline_key_id=os.environ.get("LICENSE_OFFLINE_KEY_ID"),
    )

    try:
        # 仅用于本地开发。生产包应通过上面的文件参数固定可信公钥。
        if not public_key_path and os.environ.get("LICENSE_FETCH_PUBLIC_KEY") == "1":
            client.fetch_offline_public_key()

        username = os.environ.get("LICENSE_USERNAME")
        password = os.environ.get("LICENSE_PASSWORD")
        card_key = os.environ.get("LICENSE_CARD_KEY")
        if username and password:
            try:
                client.login(username, password)
            except (TransportError, APIError) as exc:
                if isinstance(exc, APIError) and exc.status_code < 500:
                    raise
                if card_key:
                    raise
                # 重启且服务不可达/暂时5xx时，check仍可验证已缓存的签名离线grant。
                # 401/403 等认证拒绝会在上面重新抛出，继续 fail-closed。

        result = client.activate(card_key) if card_key else client.check()

        print(f"授权来源: {result.source}; 有效: {result.valid}; 到期: {result.expire}")
        print(f"店铺上限: {result.shop_limit}; 设备上限: {result.device_limit}")
        permission = first_permission_code(manifest)
        if permission:
            permission_status = "已授权" if result.has_permission(permission) else "未授权"
            print(f"权限 {permission}: {permission_status}")
        return 0 if result.valid else 2
    except LicenseSDKError as exc:
        # SDK 异常不包含密码或完整 token；业务日志仍应避免输出请求体。
        print(f"授权检查失败: {exc}")
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())

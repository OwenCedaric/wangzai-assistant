from __future__ import annotations

import base64
import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

DEPLOY_DIR = Path(__file__).resolve().parent
ENV_FILE = DEPLOY_DIR / ".env"
MANAGER_URL = "http://127.0.0.1:9217"
CAPTCHA_CODE = "6284"
CAPTCHA_TOKEN = "wangzai-initial-admin-hardening"


def compose_command() -> list[str]:
    if os.name != "nt":
        return ["docker", "compose"]
    # Resolve the checked-out deployment directory, not the author's drive.
    deployment_path = str(DEPLOY_DIR)
    linux_path = subprocess.check_output(
        ["wsl.exe", "-d", "Debian", "--", "wslpath", "-a", deployment_path],
        text=True,
    ).strip()
    if not linux_path.startswith("/") or "\n" in linux_path:
        raise RuntimeError("Jeepay deployment path is invalid")
    return ["wsl.exe", "-d", "Debian", "-u", "root", "--cd", linux_path, "--", "docker", "compose"]


def encoded(value: str) -> str:
    return base64.b64encode(value.encode()).decode()


def load_environment() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def load_admin_password() -> str:
    password = load_environment().get("JEEPAY_MANAGER_ADMIN_PASSWORD", "")
    if len(password) < 8:
        raise RuntimeError("Run prepare.py before hardening the Jeepay administrator")
    return password


def load_admin_username() -> str:
    return load_environment().get("JEEPAY_MANAGER_ADMIN_USERNAME", "jeepay")


def reset_captcha() -> None:
    redis_password = load_environment().get("JEEPAY_REDIS_PASSWORD", "")
    if not redis_password:
        raise RuntimeError("Jeepay Redis password is unavailable")
    subprocess.run(
        [
            *compose_command(),
            "exec",
            "-T",
            "-e",
            f"REDISCLI_AUTH={redis_password}",
            "redis",
            "redis-cli",
            "-n",
            "1",
            "SETEX",
            f"img_code_{CAPTCHA_TOKEN}",
            "60",
            CAPTCHA_CODE,
        ],
        check=True,
        cwd=DEPLOY_DIR,
        stdout=subprocess.DEVNULL,
    )


def api_request(path: str, method: str, payload: dict[str, str], token: str = "") -> dict:
    request = urllib.request.Request(
        MANAGER_URL + path,
        data=json.dumps(payload, separators=(",", ":")).encode(),
        headers={
            "Content-Type": "application/json",
            **({"iToken": token} if token else {}),
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read())
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError("Jeepay manager API is unavailable") from exc
    if not isinstance(result, dict) or result.get("code") != 0:
        raise RuntimeError("Jeepay manager rejected the hardening request")
    return result


def login(password: str, username: str | None = None) -> str | None:
    reset_captcha()
    try:
        result = api_request(
            "/api/anon/auth/validate",
            "POST",
            {
                "ia": encoded(username or load_admin_username()),
                "ip": encoded(password),
                "vc": encoded(CAPTCHA_CODE),
                "vt": encoded(CAPTCHA_TOKEN),
            },
        )
    except RuntimeError:
        return None
    data = result.get("data")
    return data.get("iToken") if isinstance(data, dict) else None


def main() -> None:
    new_password = load_admin_password()
    username = load_admin_username()
    if login(new_password):
        print("Jeepay administrator password is already hardened.")
        return
    token = login("jeepay123", username="jeepay")
    if not token:
        raise RuntimeError("Neither the generated nor the default administrator password works")
    api_request(
        "/api/current/modifyPwd",
        "PUT",
        {
            "originalPwd": encoded("jeepay123"),
            "confirmPwd": encoded(new_password),
        },
        token,
    )
    if not login(new_password, username=username):
        raise RuntimeError("Jeepay administrator password verification failed")
    print("Jeepay administrator password was changed and verified.")


if __name__ == "__main__":
    main()

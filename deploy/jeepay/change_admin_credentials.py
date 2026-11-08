from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

from harden_admin import (
    ENV_FILE,
    MANAGER_URL,
    DEPLOY_DIR,
    encoded,
    load_environment,
    load_admin_password,
    load_admin_username,
    login,
)

USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,64}$")


def linux_deploy_dir() -> str:
    drive = DEPLOY_DIR.drive[0].lower()
    rest = DEPLOY_DIR.as_posix()[2:].lstrip("/")
    return f"/mnt/{drive}/{rest}"


def sync_login_identifier(record_id: int, username: str) -> None:
    password = load_environment().get("JEEPAY_DB_PASSWORD", "")
    query = (
        "UPDATE t_sys_user_auth SET identifier="
        f"'{username}' WHERE user_id={record_id} AND sys_type='MGR' AND identity_type=1;"
        "SELECT ROW_COUNT();"
    )
    completed = subprocess.run(
        [
            "wsl.exe",
            "-d",
            "Debian",
            "-u",
            "root",
            "--cd",
            linux_deploy_dir(),
            "--",
            "docker",
            "compose",
            "exec",
            "-T",
            "-e",
            f"MYSQL_PWD={password}",
            "mysql",
            "mysql",
            "--batch",
            "--raw",
            "--skip-column-names",
            "-ujeepay",
            "jeepaydb",
            "-e",
            query,
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.stdout.strip() != "1":
        raise RuntimeError("Jeepay login identifier was not updated exactly once")


def authenticated_request(
    path: str,
    method: str,
    token: str,
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    body = (
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if payload is not None
        else None
    )
    request = urllib.request.Request(
        MANAGER_URL + path,
        data=body,
        headers={
            "Accept": "application/json",
            "iToken": token,
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read())
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError("Jeepay manager API is unavailable") from exc
    if not isinstance(result, dict) or result.get("code") != 0:
        raise RuntimeError("Jeepay manager rejected the credential change")
    return result


def replace_environment_values(updates: dict[str, str]) -> None:
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    seen: set[str] = set()
    output: list[str] = []
    for line in lines:
        if line and not line.startswith("#") and "=" in line:
            key, _ = line.split("=", 1)
            if key in updates:
                output.append(f"{key}={updates[key]}")
                seen.add(key)
                continue
        output.append(line)
    output.extend(f"{key}={value}" for key, value in updates.items() if key not in seen)
    temporary = Path(str(ENV_FILE) + ".tmp")
    temporary.write_text("\n".join(output) + "\n", encoding="utf-8")
    os.replace(temporary, ENV_FILE)


def main() -> None:
    new_username = os.environ.get("JEEPAY_NEW_MANAGER_USERNAME", "")
    new_password = os.environ.get("JEEPAY_NEW_MANAGER_PASSWORD", "")
    if not USERNAME_PATTERN.fullmatch(new_username):
        raise RuntimeError("The new Jeepay username is invalid")
    if not 8 <= len(new_password) <= 128:
        raise RuntimeError("The new Jeepay password must contain 8 to 128 characters")

    current_username = load_admin_username()
    current_password = load_admin_password()
    token = login(current_password, username=current_username)
    if not token:
        # Recover safely if Jeepay accepted the password update but its upstream
        # username/auth-identifier synchronization bug left a partial change.
        token = login(new_password, username=current_username)
    if not token:
        raise RuntimeError("The current Jeepay administrator cannot log in")
    current_result = authenticated_request("/api/current/user", "GET", token)
    current = current_result.get("data")
    if not isinstance(current, dict):
        raise RuntimeError("Jeepay returned an invalid administrator record")

    required_fields = ("sysUserId", "realname", "sex", "telphone", "userNo", "state", "isAdmin")
    if any(current.get(field) is None for field in required_fields):
        raise RuntimeError("Jeepay administrator record is incomplete")
    record_id = current["sysUserId"]
    payload = {
        "loginUsername": new_username,
        **{field: current[field] for field in required_fields if field != "sysUserId"},
        "resetPass": True,
        "defaultPass": False,
        "confirmPwd": encoded(new_password),
    }
    authenticated_request(f"/api/sysUsers/{record_id}", "PUT", token, payload)
    sync_login_identifier(int(record_id), new_username)
    if not login(new_password, username=new_username):
        raise RuntimeError("The new Jeepay administrator credentials cannot log in")
    replace_environment_values(
        {
            "JEEPAY_MANAGER_ADMIN_USERNAME": new_username,
            "JEEPAY_MANAGER_ADMIN_PASSWORD": new_password,
        }
    )
    print("Jeepay administrator credentials were changed and verified.")


if __name__ == "__main__":
    main()

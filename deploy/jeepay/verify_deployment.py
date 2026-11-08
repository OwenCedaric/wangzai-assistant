from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

from harden_admin import load_admin_password, load_environment, login

DEPLOY_DIR = Path(__file__).resolve().parent
EXPECTED_SERVICES = {
    "mysql",
    "redis",
    "rocketmq-namesrv",
    "rocketmq-broker",
    "payment",
    "manager",
    "merchant",
    "ui-payment",
    "ui-manager",
    "ui-merchant",
}
EXPECTED_PUBLISHED_PORTS = {
    "payment": 9216,
    "manager": 9217,
    "merchant": 9218,
    "ui-payment": 9226,
    "ui-manager": 9227,
    "ui-merchant": 9228,
}


def linux_deploy_dir() -> str:
    drive = DEPLOY_DIR.drive[0].lower()
    rest = DEPLOY_DIR.as_posix()[2:].lstrip("/")
    return f"/mnt/{drive}/{rest}"


def run_compose(*args: str, capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
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
            *args,
        ],
        check=True,
        capture_output=capture,
        text=True,
        encoding="utf-8",
    )


def verify_containers() -> None:
    output = run_compose("ps", "--format", "json").stdout
    records = [json.loads(line) for line in output.splitlines() if line.strip()]
    services = {record["Service"] for record in records}
    if services != EXPECTED_SERVICES:
        raise RuntimeError("Jeepay service set does not match the deployment manifest")
    for record in records:
        if record["State"] != "running":
            raise RuntimeError(f"Jeepay service is not running: {record['Service']}")
        if record.get("Health") and record["Health"] != "healthy":
            raise RuntimeError(f"Jeepay service is not healthy: {record['Service']}")
        published = [item for item in record.get("Publishers", []) if item["PublishedPort"]]
        expected_port = EXPECTED_PUBLISHED_PORTS.get(record["Service"])
        if expected_port is None and published:
            raise RuntimeError(f"Private Jeepay service exposes a host port: {record['Service']}")
        if expected_port is not None:
            if len(published) != 1:
                raise RuntimeError(f"Jeepay service has an invalid host binding: {record['Service']}")
            binding = published[0]
            if binding["URL"] != "127.0.0.1" or binding["PublishedPort"] != expected_port:
                raise RuntimeError(f"Jeepay service is not loopback-only: {record['Service']}")


def http_status(url: str) -> int:
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


def verify_http() -> None:
    for port in (9226, 9227, 9228):
        if http_status(f"http://127.0.0.1:{port}/") != 200:
            raise RuntimeError(f"Jeepay UI on port {port} is unavailable")
    for port in (9216, 9217, 9218):
        if http_status(f"http://127.0.0.1:{port}/v3/api-docs") == 200:
            raise RuntimeError(f"Jeepay API documentation is exposed on port {port}")
    if http_status("http://127.0.0.1:9217/api/anon/auth/vercode") != 200:
        raise RuntimeError("Jeepay manager API is unavailable")


def verify_channels_are_unconfigured() -> None:
    password = load_environment().get("JEEPAY_DB_PASSWORD", "")
    query = (
        "SELECT CONCAT("
        "(SELECT COUNT(*) FROM t_mch_app WHERE state=1), ':',"
        "(SELECT COUNT(*) FROM t_pay_interface_config WHERE state=1), ':',"
        "(SELECT COUNT(*) FROM t_mch_pay_passage WHERE state=1));"
    )
    result = run_compose(
        "exec",
        "-T",
        "-e",
        f"MYSQL_PWD={password}",
        "mysql",
        "mysql",
        "--batch",
        "--skip-column-names",
        "-ujeepay",
        "jeepaydb",
        "-e",
        query,
    )
    if result.stdout.strip() != "0:0:0":
        raise RuntimeError("Jeepay has an enabled merchant application or payment channel")


def verify_logs_do_not_contain_secrets() -> None:
    logs = run_compose(
        "logs",
        "--no-color",
        "manager",
        "merchant",
        "payment",
    ).stdout
    secret_values = [
        value
        for key, value in load_environment().items()
        if key.endswith(("PASSWORD", "SECRET")) and len(value) >= 12
    ]
    if any(secret in logs for secret in secret_values):
        raise RuntimeError("A generated Jeepay secret was found in container logs")
    if "signStr:" in logs:
        raise RuntimeError("Jeepay signing input was found in container logs")


def main() -> None:
    verify_containers()
    verify_http()
    verify_channels_are_unconfigured()
    verify_logs_do_not_contain_secrets()
    if not login(load_admin_password()):
        raise RuntimeError("The hardened Jeepay administrator cannot log in")
    print(
        json.dumps(
            {
                "containers": len(EXPECTED_SERVICES),
                "health": "ok",
                "published_ports": "loopback-only",
                "payment_channels": "disabled-until-configured",
                "api_docs": "disabled-or-blocked",
                "secret_log_scan": "ok",
                "hardened_admin_login": "ok",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

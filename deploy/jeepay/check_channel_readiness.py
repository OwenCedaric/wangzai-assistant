from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

from harden_admin import load_environment

DEPLOY_DIR = Path(__file__).resolve().parent
CHANNELS = {
    "alipay": ("alipay", "ALI_QR"),
    "wechat": ("wxpay", "WX_NATIVE"),
}
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def linux_deploy_dir() -> str:
    drive = DEPLOY_DIR.drive[0].lower()
    rest = DEPLOY_DIR.as_posix()[2:].lstrip("/")
    return f"/mnt/{drive}/{rest}"


def validate_scope(mch_no: str | None, app_id: str | None) -> tuple[str, str]:
    if bool(mch_no) != bool(app_id):
        raise ValueError("mchNo and appId must be supplied together")
    if not mch_no:
        return "", "all-enabled-applications"
    if not SAFE_IDENTIFIER.fullmatch(mch_no) or not SAFE_IDENTIFIER.fullmatch(app_id or ""):
        raise ValueError("mchNo or appId contains unsupported characters")
    return (
        f" AND m.mch_no = '{mch_no}' AND a.app_id = '{app_id}'",
        "exact-merchant-application",
    )


def channel_query(mch_no: str | None, app_id: str | None) -> tuple[str, str]:
    scope_sql, scope_name = validate_scope(mch_no, app_id)
    rows: list[str] = []
    for channel, (if_code, way_code) in CHANNELS.items():
        rows.append(
            "SELECT CONCAT_WS(CHAR(9), "
            f"'{channel}', "
            "EXISTS(SELECT 1 FROM t_mch_info m "
            "JOIN t_mch_app a ON a.mch_no=m.mch_no "
            f"WHERE m.state=1 AND a.state=1{scope_sql}), "
            "EXISTS(SELECT 1 FROM t_mch_info m "
            "JOIN t_mch_app a ON a.mch_no=m.mch_no "
            "JOIN t_pay_interface_config c ON "
            "((c.info_type=2 AND c.info_id=m.mch_no) OR "
            "(c.info_type=3 AND c.info_id=a.app_id)) "
            f"WHERE m.state=1 AND a.state=1 AND c.state=1 AND c.if_code='{if_code}'"
            f"{scope_sql}), "
            "EXISTS(SELECT 1 FROM t_mch_info m "
            "JOIN t_mch_app a ON a.mch_no=m.mch_no "
            "JOIN t_mch_pay_passage p ON p.mch_no=m.mch_no AND p.app_id=a.app_id "
            f"WHERE m.state=1 AND a.state=1 AND p.state=1 AND p.if_code='{if_code}' "
            f"AND p.way_code='{way_code}'{scope_sql}))"
        )
    return " UNION ALL ".join(rows) + ";", scope_name


def run_query(query: str) -> str:
    password = load_environment().get("JEEPAY_DB_PASSWORD", "")
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
    return completed.stdout


def parse_status(output: str) -> dict[str, dict[str, bool]]:
    result: dict[str, dict[str, bool]] = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) != 4 or fields[0] not in CHANNELS or fields[0] in result:
            raise RuntimeError("Jeepay returned an unexpected readiness result")
        if any(value not in {"0", "1"} for value in fields[1:]):
            raise RuntimeError("Jeepay returned an invalid readiness flag")
        application, interface, passage = (value == "1" for value in fields[1:])
        result[fields[0]] = {
            "merchant_application": application,
            "interface_config": interface,
            "payment_passage": passage,
            "ready_for_live_acceptance": application and interface and passage,
        }
    if set(result) != set(CHANNELS):
        raise RuntimeError("Jeepay readiness result is incomplete")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check Jeepay channel readiness without reading or printing channel secrets."
    )
    parser.add_argument("--mch-no")
    parser.add_argument("--app-id")
    parser.add_argument(
        "--require-ready",
        action="store_true",
        help="Return exit code 2 unless both reserved channels are configured.",
    )
    args = parser.parse_args()
    try:
        query, scope = channel_query(args.mch_no, args.app_id)
    except ValueError as exc:
        parser.error(str(exc))
    status = parse_status(run_query(query))
    print(
        json.dumps(
            {
                "scope": scope,
                "channels": status,
                "safe_to_enable_management_switches": all(
                    channel["ready_for_live_acceptance"] for channel in status.values()
                ),
                "secrets_printed": False,
            },
            ensure_ascii=False,
        )
    )
    if args.require_ready and not all(
        channel["ready_for_live_acceptance"] for channel in status.values()
    ):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

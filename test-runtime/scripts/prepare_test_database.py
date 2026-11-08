from __future__ import annotations

import argparse
import csv
import os
import secrets
import sqlite3
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

MANAGEMENT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = MANAGEMENT_ROOT / "server"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import select  # noqa: E402

from app.auth.security import hash_password  # noqa: E402
from app.config import Settings  # noqa: E402
from app.database.session import build_engine, build_session_factory  # noqa: E402
from app.models import Plan, Project, User  # noqa: E402
from app.schemas.licensing import LicenseGrantCreate  # noqa: E402
from app.services.license_service import grant_license  # noqa: E402
from app.services.point_service import credit_points  # noqa: E402

RUNTIME_ROOT = MANAGEMENT_ROOT / "test-runtime"
DEFAULT_SOURCE = BACKEND_ROOT / "license_center_demo.sqlite3"
DEFAULT_TARGET = RUNTIME_ROOT / "data" / "license_center_test.sqlite3"
DEFAULT_CREDENTIALS = RUNTIME_ROOT / "private" / "tester-accounts.csv"
DEFAULT_ADMIN = RUNTIME_ROOT / "private" / "admin-credentials.txt"

# These are server configuration tables. Everything else is rebuilt as isolated
# test data so the test service cannot expose development users, shops, devices,
# orders, logs, recovery objects, payment rows, or paid-capability history.
PRESERVED_TABLES = {
    "alembic_version",
    "api_pool_keys",
    "api_pool_models",
    "api_pool_providers",
    "paid_capability_rate_cards",
    "permissions",
    "plan_permissions",
    "plans",
    "products",
    "projects",
}


def _backup(source: Path, target: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"source database is missing: {source}")
    if source.resolve() == target.resolve():
        raise ValueError("SOURCE_AND_TARGET_MUST_DIFFER")
    if target.exists():
        raise FileExistsError("TEST_DATABASE_ALREADY_EXISTS")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(f"{target.suffix}.preparing")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    source_connection = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
    target_connection = sqlite3.connect(temporary)
    try:
        source_connection.backup(target_connection)
        target_connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        target_connection.close()
        source_connection.close()
    if target.exists():
        raise FileExistsError("TEST_DATABASE_APPEARED_DURING_PREPARATION")
    temporary.rename(target)


def _sanitize(target: Path) -> dict[str, int]:
    connection = sqlite3.connect(target)
    try:
        tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("BEGIN IMMEDIATE")
        try:
            for table in tables:
                if table not in PRESERVED_TABLES:
                    connection.execute(f'DELETE FROM "{table}"')
            connection.execute(
                "UPDATE api_pool_keys SET request_count=0, success_count=0, "
                "failure_count=0, consecutive_failures=0, last_used_at=NULL, "
                "last_success_at=NULL, last_failure_at=NULL, last_error_code=NULL, "
                "cooldown_until=NULL"
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        connection.execute("PRAGMA foreign_keys=ON")
        failures = connection.execute("PRAGMA foreign_key_check").fetchall()
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if failures or integrity != "ok":
            raise RuntimeError("sanitized database failed SQLite verification")
        return {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in tables
        }
    finally:
        connection.close()


def _password() -> str:
    return f"Wz!{secrets.token_urlsafe(12)}9a"


def _primary_admin(source: Path) -> tuple[str, str, str | None]:
    connection = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
    try:
        row = connection.execute(
            "SELECT username, password_hash, email FROM users "
            "WHERE is_admin=1 AND status='active' ORDER BY id LIMIT 1"
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        raise RuntimeError("active development admin is missing")
    return row


def _seed_accounts(
    source: Path,
    target: Path,
    *,
    account_count: int,
    points: int,
    credentials_path: Path,
    admin_path: Path,
) -> int:
    settings = Settings(
        database_url=f"sqlite:///{target.as_posix()}",
        bootstrap_admin_username=None,
        bootstrap_admin_password=None,
    )
    engine = build_engine(settings.database_url, echo=False)
    session_factory = build_session_factory(engine)
    credentials_path.parent.mkdir(parents=True, exist_ok=True)
    admin_path.parent.mkdir(parents=True, exist_ok=True)
    admin_password = _password()
    primary_admin_username, primary_admin_hash, primary_admin_email = _primary_admin(source)
    admin_count = 1
    credentials: list[tuple[str, str, str, int, int]] = []
    try:
        with session_factory() as db:
            project = db.scalar(select(Project).where(Project.code == "wangzai_desktop"))
            plan = db.scalar(
                select(Plan).where(
                    Plan.plan_kind == "license",
                    Plan.license_role == "shop_standard_annual",
                    Plan.status == "active",
                )
            )
            if project is None or plan is None:
                raise RuntimeError("required project or annual shop plan is missing")
            admin = User(
                username="test-admin",
                password_hash=hash_password(admin_password),
                email="test-admin@wangzai-test.local",
                status="active",
                is_admin=True,
            )
            db.add(admin)
            db.commit()

            if primary_admin_username != admin.username:
                db.add(
                    User(
                        username=primary_admin_username,
                        password_hash=primary_admin_hash,
                        email=primary_admin_email,
                        status="active",
                        is_admin=True,
                    )
                )
                db.commit()
                admin_count += 1

            for index in range(1, account_count + 1):
                email = f"tester{index:02d}@wangzai-test.local"
                password = _password()
                user = User(
                    username=email,
                    email=email,
                    password_hash=hash_password(password),
                    status="active",
                    is_admin=False,
                )
                db.add(user)
                db.commit()
                db.refresh(user)
                license_record = grant_license(
                    db,
                    LicenseGrantCreate(user_id=user.id, plan_id=plan.id),
                )
                credit_points(
                    db,
                    user_id=user.id,
                    project_id=project.id,
                    amount_points=points,
                    idempotency_key=f"test-release:{index}:initial-credit",
                    event_type="admin_credit",
                    reason="测试版初始积分",
                    expires_at=datetime.now(UTC) + timedelta(days=90),
                    reference_type="test_release",
                    reference_id=f"tester-{index:02d}",
                )
                db.commit()
                credentials.append(
                    (
                        email,
                        password,
                        license_record.expire_time.isoformat(),
                        points,
                        plan.max_shops,
                    )
                )
    finally:
        engine.dispose()

    with credentials_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["账号", "密码", "授权到期时间", "初始积分", "店铺上限"])
        writer.writerows(credentials)
    admin_path.write_text(
        f"管理地址：http://127.0.0.1:18000\n"
        "管理员账号：test-admin\n"
        f"管理员密码：{admin_password}\n",
        encoding="utf-8",
    )
    return admin_count


def _verify(target: Path, account_count: int, admin_count: int) -> None:
    connection = sqlite3.connect(f"file:{target.as_posix()}?mode=ro", uri=True)
    try:
        expected = {
            "users": account_count + admin_count,
            "licenses": account_count,
            "point_wallets": account_count,
            "shops": 0,
            "devices": 0,
            "orders": 0,
            "paid_capability_jobs": 0,
            "usage_logs": 0,
        }
        observed = {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in expected
        }
        if observed != expected:
            raise RuntimeError(f"test database counts are invalid: {observed}")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("test database integrity check failed")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("test database foreign-key check failed")
        print(
            "测试库已生成："
            f"users={observed['users']} licenses={observed['licenses']} "
            f"shops={observed['shops']} devices={observed['devices']} "
            f"points_wallets={observed['point_wallets']}"
        )
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare the isolated Wangzai test database")
    parser.add_argument("--source", type=Path, required=True, help="Explicit local source database; may contain provider credentials")
    parser.add_argument("--acknowledge-sensitive-copy", action="store_true", help="Allow copying provider configuration and administrator password hashes into the local test database")
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET)
    parser.add_argument("--accounts", type=int, default=10)
    parser.add_argument("--points", type=int, default=5_000)
    parser.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    parser.add_argument("--admin", type=Path, default=DEFAULT_ADMIN)
    args = parser.parse_args()
    if not args.acknowledge_sensitive_copy:
        parser.error("--acknowledge-sensitive-copy is required; this is a local cloning tool, not a publishable fixture generator")
    paths = [args.source.resolve(), args.target.resolve(), args.credentials.resolve(), args.admin.resolve()]
    if len(set(paths)) != len(paths):
        parser.error("source, target and credential output paths must be distinct")
    if any(path.exists() for path in paths[1:]):
        parser.error("output already exists; existing databases and credentials will not be overwritten")
    if not 1 <= args.accounts <= 100:
        parser.error("--accounts must be between 1 and 100")
    if not 1 <= args.points <= 10_000_000:
        parser.error("--points must be between 1 and 10,000,000")
    _backup(args.source.resolve(), args.target.resolve())
    counts = _sanitize(args.target.resolve())
    if counts.get("shops") != 0 or counts.get("devices") != 0:
        raise RuntimeError("shop or device data survived sanitization")
    admin_count = _seed_accounts(
        args.source.resolve(),
        args.target.resolve(),
        account_count=args.accounts,
        points=args.points,
        credentials_path=args.credentials.resolve(),
        admin_path=args.admin.resolve(),
    )
    _verify(args.target.resolve(), args.accounts, admin_count)


if __name__ == "__main__":
    main()

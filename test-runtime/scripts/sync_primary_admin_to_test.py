from __future__ import annotations

import argparse
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

MANAGEMENT_ROOT = Path(__file__).resolve().parents[2]
SOURCE = MANAGEMENT_ROOT / "server" / "license_center_demo.sqlite3"
TARGET = MANAGEMENT_ROOT / "test-runtime" / "data" / "license_center_test.sqlite3"
BACKUP_ROOT = MANAGEMENT_ROOT / "test-runtime" / "backups"


def _read_primary_admin(source: Path) -> tuple[str, str, str | None]:
    connection = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
    try:
        row = connection.execute(
            "SELECT username, password_hash, email FROM users "
            "WHERE is_admin=1 AND status='active' ORDER BY id LIMIT 1"
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        raise RuntimeError("开发库中没有可用的管理员账号")
    return row


def _backup_database(source: sqlite3.Connection, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    backup = sqlite3.connect(target)
    try:
        source.backup(backup)
    finally:
        backup.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Explicitly copy one administrator hash into an existing local test database")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, default=TARGET)
    parser.add_argument("--confirm-admin-sync", action="store_true")
    args = parser.parse_args()
    if not args.confirm_admin_sync:
        parser.error("--confirm-admin-sync is required")
    source, target = args.source.resolve(), args.target.resolve()
    if source == target or not source.is_file() or not target.is_file():
        parser.error("source and target must be different existing databases")
    username, password_hash, email = _read_primary_admin(source)
    connection = sqlite3.connect(f"file:{target.as_posix()}?mode=rw", uri=True)
    try:
        existing = connection.execute(
            "SELECT id, password_hash, status, is_admin FROM users WHERE username=?",
            (username,),
        ).fetchone()
        if existing and existing[1] == password_hash and existing[2] == "active" and existing[3]:
            print("当前管理账号已经接入测试库，无需修改")
            return

        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        backup_path = BACKUP_ROOT / f"{target.stem}-before-admin-sync-{stamp}.sqlite3"
        _backup_database(connection, backup_path)

        if email and connection.execute(
            "SELECT 1 FROM users WHERE email=? AND username<>?", (email, username)
        ).fetchone():
            email = None

        now = datetime.now(UTC).isoformat()
        connection.execute("BEGIN IMMEDIATE")
        if existing:
            connection.execute(
                "UPDATE users SET password_hash=?, email=COALESCE(?, email), "
                "status='active', is_admin=1, updated_at=? WHERE id=?",
                (password_hash, email, now, existing[0]),
            )
            action = "updated"
        else:
            connection.execute(
                "INSERT INTO users "
                "(username,password_hash,phone,email,status,is_admin,created_at,updated_at,"
                "phone_hash,phone_ciphertext,phone_masked,phone_verified_at) "
                "VALUES (?,?,NULL,?,'active',1,?,?,NULL,NULL,NULL,NULL)",
                (username, password_hash, email, now, now),
            )
            action = "inserted"
        connection.commit()

        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok" or connection.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("同步后测试数据库校验失败")
        print(f"当前管理账号已接入测试库：{action}，备份={backup_path}")
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    main()

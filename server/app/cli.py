from __future__ import annotations

import argparse
import getpass
import os
import re

from sqlalchemy import select

from app.auth.security import hash_password
from app.config import get_settings
from app.database import Base, build_engine, build_session_factory
from app.models import User  # noqa: F401
from app.services.recovery_service import purge_expired_staged_objects


def init_db() -> None:
    settings = get_settings()
    if settings.is_production:
        raise SystemExit("init-db/create_all is disabled outside development; use Alembic")
    engine = build_engine(settings.database_url, echo=settings.sql_echo)
    Base.metadata.create_all(engine)
    engine.dispose()
    print("Database schema created.")


def create_admin(username: str, password_env: str) -> None:
    if not (3 <= len(username) <= 64) or not re.fullmatch(r"[A-Za-z0-9_.-]+", username):
        raise SystemExit("Username must be 3-64 letters, digits, dot, underscore, or hyphen")
    password = os.getenv(password_env) or getpass.getpass("Admin password: ")
    if len(password) < 8:
        raise SystemExit("Password must contain at least 8 characters")
    settings = get_settings()
    engine = build_engine(settings.database_url, echo=settings.sql_echo)
    session_factory = build_session_factory(engine)
    with session_factory() as db:
        existing = db.scalar(select(User).where(User.username == username))
        if existing:
            existing.password_hash = hash_password(password)
            existing.is_admin = True
            existing.status = "active"
        else:
            db.add(
                User(
                    username=username,
                    password_hash=hash_password(password),
                    is_admin=True,
                    status="active",
                )
            )
        db.commit()
    engine.dispose()
    print(f"Administrator '{username}' is ready.")


def purge_recovery_staging() -> None:
    settings = get_settings()
    engine = build_engine(settings.database_url, echo=settings.sql_echo)
    session_factory = build_session_factory(engine)
    with session_factory() as db:
        try:
            deleted = purge_expired_staged_objects(db)
            db.commit()
        except Exception:
            db.rollback()
            raise
    engine.dispose()
    print(f"Purged {deleted} expired recovery staging object(s).")


def main() -> None:
    parser = argparse.ArgumentParser(description="License Center maintenance commands")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init-db", help="Create database tables (development only)")
    admin_parser = subparsers.add_parser("create-admin", help="Create or promote an admin")
    admin_parser.add_argument("--username", required=True)
    admin_parser.add_argument("--password-env", default="LICENSE_ADMIN_PASSWORD")
    subparsers.add_parser(
        "purge-recovery-staging",
        help="Delete expired, unreferenced encrypted recovery upload staging objects",
    )
    args = parser.parse_args()
    if args.command == "init-db":
        init_db()
    elif args.command == "create-admin":
        create_admin(args.username, args.password_env)
    elif args.command == "purge-recovery-staging":
        purge_recovery_staging()


if __name__ == "__main__":
    main()

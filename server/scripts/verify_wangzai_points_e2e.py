from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

import httpx

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.database import build_engine, build_session_factory  # noqa: E402
from app.licensing.shop_card_policy import SHOP_CARD_ROLES  # noqa: E402
from app.models import Plan, Product, Project, User  # noqa: E402
from app.schemas.admin import CardBatchCreate  # noqa: E402
from app.services.card_service import create_batch  # noqa: E402
from scripts.seed_wangzai_shop_card_plans import seed_shop_card_plans  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DATABASE = ROOT / "license_center_demo.sqlite3"
PORT = 18001
BASE_URL = f"http://127.0.0.1:{PORT}"


def clone_database(target: Path) -> None:
    source = sqlite3.connect(SOURCE_DATABASE)
    destination = sqlite3.connect(target)
    try:
        with destination:
            source.backup(destination)
        if destination.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("E2E database clone failed integrity_check")
    finally:
        source.close()
        destination.close()


def create_test_card(database_url: str) -> str:
    os.environ["DATABASE_URL"] = database_url
    get_settings.cache_clear()
    settings = get_settings()
    engine = build_engine(settings.database_url)
    session_factory = build_session_factory(engine)
    try:
        with session_factory() as db:
            seed_shop_card_plans(db)
            admin = db.scalar(select(User).where(User.is_admin.is_(True)).order_by(User.id))
            plan = db.scalar(
                select(Plan)
                .join(Product)
                .join(Project)
                .where(
                    Project.code == "wangzai_desktop",
                    Plan.plan_kind == "license",
                    Plan.license_role.in_(SHOP_CARD_ROLES),
                    Plan.status == "active",
                )
                .order_by(Plan.duration_days, Plan.id)
            )
            if admin is None or plan is None:
                raise RuntimeError("Admin or active wangzai_desktop license plan is missing")
            _, codes, _ = create_batch(
                db,
                settings,
                admin,
                CardBatchCreate(
                    plan_id=plan.id,
                    name=f"points-e2e-{uuid4().hex[:10]}",
                    quantity=1,
                    duration_days=plan.duration_days,
                ),
            )
            return codes[0]
    finally:
        engine.dispose()


def wait_for_health(client: httpx.Client, process: subprocess.Popen[str]) -> None:
    for _ in range(100):
        if process.poll() is not None:
            stderr = process.stderr.read()[-2000:] if process.stderr else ""
            raise RuntimeError(f"E2E backend exited before health check: {stderr}")
        try:
            if client.get("/health").status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    raise RuntimeError("E2E backend health check timed out")


def require(response: httpx.Response, status_code: int) -> dict[str, object]:
    if response.status_code != status_code:
        raise RuntimeError(
            f"{response.request.method} {response.request.url.path} "
            f"returned {response.status_code}: {response.text[:500]}"
        )
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"{response.request.url.path} did not return an object")
    return payload


def run_flow(client: httpx.Client, card_key: str) -> dict[str, object]:
    suffix = uuid4().hex[:12]
    registration = require(
        client.post(
            "/api/auth/register",
            json={
                "email": f"points-e2e-{suffix}@example.invalid",
                "password": "E2E-Desktop-Pass-2026!",
                "project_code": "wangzai_desktop",
                "device_code": f"points-e2e-device-{suffix}",
                "device_name": "旺崽积分联调",
                "version": "1.0.0",
                "card_key": card_key,
            },
        ),
        201,
    )
    entitlement = registration.get("entitlement")
    if not isinstance(entitlement, dict) or entitlement.get("valid") is not True:
        raise RuntimeError("Registration did not return an active entitlement")
    access_token = str(registration.get("access_token") or "")
    if not access_token:
        raise RuntimeError("Registration did not return a user access token")
    headers = {"Authorization": f"Bearer {access_token}"}

    packages = require(
        client.get(
            "/api/points/packages",
            params={"project_code": "wangzai_desktop", "page_size": 100},
            headers=headers,
        ),
        200,
    )
    items = packages.get("items")
    if not isinstance(items, list) or len(items) != 6:
        raise RuntimeError("Expected six active point packages")
    package = next((item for item in items if item.get("featured")), items[0])

    before = require(
        client.get(
            "/api/points/wallet",
            params={"project_code": "wangzai_desktop"},
            headers=headers,
        ),
        200,
    )
    if before.get("balance_points") != 0:
        raise RuntimeError("New E2E account did not start with an isolated zero balance")

    order = require(
        client.post(
            "/api/orders",
            headers=headers,
            json={
                "project_code": "wangzai_desktop",
                "plan_id": package["id"],
                "idempotency_key": f"points-e2e-order-{suffix}",
            },
        ),
        201,
    )
    require(
        client.post(
            f"/api/orders/{order['id']}/pay",
            headers=headers,
            json={"provider": "development"},
        ),
        200,
    )
    completed = require(
        client.post(
            f"/api/payments/development/{order['order_no']}/complete",
            headers=headers,
        ),
        200,
    )
    fulfillment = completed.get("fulfillment")
    expected_points = int(package["points_amount"])
    if (
        completed.get("status") != "fulfilled"
        or not isinstance(fulfillment, dict)
        or fulfillment.get("points_credited") != expected_points
    ):
        raise RuntimeError("Point order was not fulfilled exactly once")

    spent = require(
        client.post(
            "/api/points/spend",
            headers=headers,
            json={
                "project_code": "wangzai_desktop",
                "amount_points": 250,
                "idempotency_key": f"points-e2e-spend-{suffix}",
                "reason": "积分联调",
                "reference_type": "e2e",
                "reference_id": suffix,
            },
        ),
        200,
    )
    final_balance = spent["wallet"]["balance_points"]
    if final_balance != expected_points - 250:
        raise RuntimeError("Point spend balance did not match the credited package")

    ledger = require(
        client.get(
            "/api/points/ledger",
            params={"project_code": "wangzai_desktop", "page_size": 100},
            headers=headers,
        ),
        200,
    )
    event_types = {entry["event_type"] for entry in ledger["items"]}
    if not {"purchase_credit", "spent"}.issubset(event_types):
        raise RuntimeError("Point ledger is missing purchase or spend events")

    return {
        "registration": "activated",
        "packages": len(items),
        "purchased_points": expected_points,
        "spent_points": 250,
        "final_balance": final_balance,
        "ledger_events": len(ledger["items"]),
    }


def main() -> None:
    runtime_dir = ROOT / ".runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    database = runtime_dir / f"wangzai-points-e2e-{uuid4().hex}.sqlite3"
    process: subprocess.Popen[str] | None = None
    try:
        clone_database(database)
        database_url = f"sqlite:///{database.as_posix()}"
        card_key = create_test_card(database_url)
        environment = {
            **os.environ,
            "DATABASE_URL": database_url,
            "APP_ENV": "development",
            # The development provider is enabled only inside this disposable,
            # cloned E2E database. The live service keeps it disabled.
            "PAYMENT_DEVELOPMENT_ENABLED": "true",
        }
        creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(PORT),
            ],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=creation_flags,
        )
        with httpx.Client(base_url=BASE_URL, timeout=5) as client:
            wait_for_health(client, process)
            result = run_flow(client, card_key)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for suffix in ("", "-wal", "-shm"):
            target = Path(f"{database}{suffix}")
            for attempt in range(20):
                try:
                    target.unlink(missing_ok=True)
                    break
                except PermissionError:
                    if attempt == 19:
                        raise
                    time.sleep(0.1)


if __name__ == "__main__":
    main()

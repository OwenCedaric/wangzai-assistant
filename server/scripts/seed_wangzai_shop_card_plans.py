from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings  # noqa: E402
from app.database import build_engine, build_session_factory  # noqa: E402
from app.licensing.shop_card_policy import (  # noqa: E402
    ANNUAL_DURATION_DAYS,
    INTRO_PRICE_CENT,
    LICENSE_ROLE_LEGACY,
    LICENSE_ROLE_SHOP_ANNUAL,
    LICENSE_ROLE_SHOP_INTRO,
    LICENSE_ROLE_SHOP_MONTHLY,
    MONTHLY_DURATION_DAYS,
    STANDARD_ANNUAL_PRICE_CENT,
    STANDARD_MONTHLY_PRICE_CENT,
    validate_shop_card_plan,
)
from app.models import Permission, Plan, Product, Project  # noqa: E402

PLANS = (
    {
        "name": "首店首月卡",
        "license_role": LICENSE_ROLE_SHOP_INTRO,
        "sale_price_cent": INTRO_PRICE_CENT,
        "duration_days": MONTHLY_DURATION_DAYS,
        "customer_description": "每个账号仅限首次绑定第一家店铺使用一次",
        "featured": True,
        "display_order": 10,
    },
    {
        "name": "标准店铺月卡",
        "license_role": LICENSE_ROLE_SHOP_MONTHLY,
        "sale_price_cent": STANDARD_MONTHLY_PRICE_CENT,
        "duration_days": MONTHLY_DURATION_DAYS,
        "customer_description": "新增店铺或任一店铺到期续费，每店每月 50 元",
        "featured": False,
        "display_order": 20,
    },
    {
        "name": "标准店铺年卡",
        "license_role": LICENSE_ROLE_SHOP_ANNUAL,
        "sale_price_cent": STANDARD_ANNUAL_PRICE_CENT,
        "duration_days": ANNUAL_DURATION_DAYS,
        "customer_description": "单店一年授权，到期后需继续使用月卡或年卡续费",
        "featured": False,
        "display_order": 30,
    },
)


def seed_shop_card_plans(db: Session) -> tuple[int, int, int]:
    project = db.scalar(select(Project).where(Project.code == "wangzai_desktop"))
    if project is None:
        raise RuntimeError("Project wangzai_desktop does not exist")
    product = db.scalar(
        select(Product)
        .where(Product.project_id == project.id, Product.name == "旺崽三代目桌面端")
        .order_by(Product.id)
    )
    if product is None:
        raise RuntimeError("Product 旺崽三代目桌面端 does not exist")

    permissions = list(
        db.scalars(
            select(Permission)
            .where(Permission.project_id == project.id, Permission.status == "active")
            .order_by(Permission.id)
        ).all()
    )
    if not permissions:
        raise RuntimeError("No active wangzai_desktop permissions exist")

    created = 0
    updated = 0
    for spec in PLANS:
        matches = list(
            db.scalars(
                select(Plan).where(
                    Plan.product_id == product.id,
                    Plan.license_role == spec["license_role"],
                )
            ).all()
        )
        if len(matches) > 1:
            raise RuntimeError(f"Multiple plans use role {spec['license_role']}")
        plan = matches[0] if matches else None
        if plan is None:
            conflicting_name = db.scalar(
                select(Plan).where(Plan.product_id == product.id, Plan.name == spec["name"])
            )
            if conflicting_name is not None:
                raise RuntimeError(f"Plan name already belongs to another role: {spec['name']}")
            plan = Plan(product_id=product.id, name=spec["name"], plan_kind="license")
            db.add(plan)
            created += 1
        else:
            updated += 1

        plan.name = spec["name"]
        plan.plan_kind = "license"
        plan.license_role = spec["license_role"]
        plan.price = Decimal(spec["sale_price_cent"]) / Decimal(100)
        plan.sale_price_cent = spec["sale_price_cent"]
        plan.online_sale_enabled = True
        plan.points_amount = 0
        plan.customer_description = spec["customer_description"]
        plan.featured = spec["featured"]
        plan.display_order = spec["display_order"]
        plan.duration_days = spec["duration_days"]
        plan.max_devices = 1
        plan.max_shops = 1
        plan.offline_hours = 0
        plan.status = "active"
        plan.is_trial = False
        plan.permissions = permissions
        violation = validate_shop_card_plan(plan)
        if violation:
            raise RuntimeError(f"Invalid shop-card plan {spec['name']}: {violation}")

    legacy_plans = list(
        db.scalars(
            select(Plan).where(
                Plan.product_id == product.id,
                Plan.plan_kind == "license",
                Plan.license_role == LICENSE_ROLE_LEGACY,
                Plan.online_sale_enabled.is_(True),
            )
        ).all()
    )
    for plan in legacy_plans:
        plan.online_sale_enabled = False

    db.flush()
    active_count = len(
        db.scalars(
            select(Plan).where(
                Plan.product_id == product.id,
                Plan.plan_kind == "license",
                Plan.license_role != LICENSE_ROLE_LEGACY,
                Plan.status == "active",
                Plan.online_sale_enabled.is_(True),
            )
        ).all()
    )
    if active_count != len(PLANS):
        raise RuntimeError("Exact shop-card plan set was not produced")
    return created, updated, len(legacy_plans)


def main() -> None:
    settings = get_settings()
    engine = build_engine(settings.database_url, echo=settings.sql_echo)
    session_factory = build_session_factory(engine)
    try:
        with session_factory() as db:
            created, updated, legacy_disabled = seed_shop_card_plans(db)
            db.commit()
    finally:
        engine.dispose()
    print(
        "wangzai_desktop shop-card plans ready: "
        f"created={created}, updated={updated}, legacy_online_disabled={legacy_disabled}"
    )


if __name__ == "__main__":
    main()

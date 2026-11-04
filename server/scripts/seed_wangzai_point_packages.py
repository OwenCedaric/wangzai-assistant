from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.config import get_settings  # noqa: E402
from app.database import build_engine, build_session_factory  # noqa: E402
from app.models import Plan, Product, Project  # noqa: E402

PACKAGES = (
    {
        "name": "体验包",
        "sale_price_cent": 990,
        "points_amount": 10_395,
        "duration_days": 7,
        "customer_description": "适合先跑一批商品测试完整流程",
        "featured": False,
        "display_order": 10,
    },
    {
        "name": "入门月卡",
        "sale_price_cent": 1_990,
        "points_amount": 20_895,
        "duration_days": 30,
        "customer_description": "适合小批量上新和单店日常使用",
        "featured": False,
        "display_order": 20,
    },
    {
        "name": "轻量月卡",
        "sale_price_cent": 2_990,
        "points_amount": 31_395,
        "duration_days": 30,
        "customer_description": "适合稳定上新和多款商品测试",
        "featured": False,
        "display_order": 30,
    },
    {
        "name": "专业月卡",
        "sale_price_cent": 3_990,
        "points_amount": 41_895,
        "duration_days": 30,
        "customer_description": "适合常态化处理 Ozon 商品链接",
        "featured": True,
        "display_order": 40,
    },
    {
        "name": "Max 月卡",
        "sale_price_cent": 4_990,
        "points_amount": 52_395,
        "duration_days": 30,
        "customer_description": "适合高频上新与多店铺运营",
        "featured": False,
        "display_order": 50,
    },
    {
        "name": "专业季卡",
        "sale_price_cent": 14_900,
        "points_amount": 156_450,
        "duration_days": 90,
        "customer_description": "适合连续季度运营和团队协作",
        "featured": False,
        "display_order": 60,
    },
)


def main() -> None:
    settings = get_settings()
    engine = build_engine(settings.database_url, echo=settings.sql_echo)
    session_factory = build_session_factory(engine)
    created = 0
    updated = 0

    with session_factory() as db:
        project = db.scalar(select(Project).where(Project.code == "wangzai_desktop"))
        if project is None:
            raise SystemExit("Project wangzai_desktop does not exist")
        product = db.scalar(
            select(Product)
            .where(Product.project_id == project.id, Product.name == "旺崽三代目桌面端")
            .order_by(Product.id)
        )
        if product is None:
            raise SystemExit("Product 旺崽三代目桌面端 does not exist")

        for package in PACKAGES:
            plan = db.scalar(
                select(Plan).where(
                    Plan.product_id == product.id,
                    Plan.name == package["name"],
                )
            )
            if plan is not None and plan.plan_kind != "points":
                raise SystemExit(f"Refusing to overwrite license plan: {package['name']}")
            if plan is None:
                plan = Plan(product_id=product.id, name=package["name"], plan_kind="points")
                db.add(plan)
                created += 1
            else:
                updated += 1

            plan.price = Decimal(package["sale_price_cent"]) / Decimal(100)
            plan.sale_price_cent = package["sale_price_cent"]
            plan.online_sale_enabled = True
            plan.points_amount = package["points_amount"]
            plan.customer_description = package["customer_description"]
            plan.featured = package["featured"]
            plan.display_order = package["display_order"]
            plan.duration_days = package["duration_days"]
            plan.max_devices = 0
            plan.max_shops = 0
            plan.offline_hours = 0
            plan.status = "active"
            plan.is_trial = False
            plan.permissions = []

        db.commit()
        active_packages = db.scalars(
            select(Plan).where(
                Plan.product_id == product.id,
                Plan.plan_kind == "points",
                Plan.status == "active",
                Plan.online_sale_enabled.is_(True),
            )
        ).all()

    print(
        f"wangzai_desktop point packages ready: created={created}, "
        f"updated={updated}, active={len(active_packages)}"
    )


if __name__ == "__main__":
    main()

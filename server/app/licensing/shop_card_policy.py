from __future__ import annotations

from decimal import Decimal

LICENSE_ROLE_LEGACY = "legacy"
LICENSE_ROLE_SHOP_INTRO = "shop_intro"
LICENSE_ROLE_SHOP_MONTHLY = "shop_standard_monthly"
LICENSE_ROLE_SHOP_ANNUAL = "shop_standard_annual"

LICENSE_ROLES = frozenset(
    {
        LICENSE_ROLE_LEGACY,
        LICENSE_ROLE_SHOP_INTRO,
        LICENSE_ROLE_SHOP_MONTHLY,
        LICENSE_ROLE_SHOP_ANNUAL,
    }
)
SHOP_CARD_ROLES = frozenset(
    {
        LICENSE_ROLE_SHOP_INTRO,
        LICENSE_ROLE_SHOP_MONTHLY,
        LICENSE_ROLE_SHOP_ANNUAL,
    }
)
STANDARD_SHOP_CARD_ROLES = frozenset({LICENSE_ROLE_SHOP_MONTHLY, LICENSE_ROLE_SHOP_ANNUAL})

INTRO_PRICE_CENT = 1_990
STANDARD_MONTHLY_PRICE_CENT = 5_000
STANDARD_ANNUAL_PRICE_CENT = 60_000
MONTHLY_DURATION_DAYS = 30
ANNUAL_DURATION_DAYS = 365


def is_shop_card_role(value: str) -> bool:
    return value in SHOP_CARD_ROLES


def is_standard_shop_card_role(value: str) -> bool:
    return value in STANDARD_SHOP_CARD_ROLES


def validate_shop_card_plan(plan) -> str | None:
    role = str(plan.license_role or LICENSE_ROLE_LEGACY)
    if role not in LICENSE_ROLES:
        return "License role is invalid"
    if plan.plan_kind == "points":
        if role != LICENSE_ROLE_LEGACY:
            return "Point packages cannot use a shop-card role"
        return None
    if role == LICENSE_ROLE_LEGACY:
        return None
    if plan.max_shops != 1:
        return "Every shop-card plan must authorize exactly one shop"
    if plan.is_trial:
        return "Shop-card plans cannot be trial plans"
    expected_price: int | None = None
    expected_duration: int | None = None
    if role == LICENSE_ROLE_SHOP_INTRO:
        expected_price = INTRO_PRICE_CENT
        expected_duration = MONTHLY_DURATION_DAYS
    elif role == LICENSE_ROLE_SHOP_MONTHLY:
        expected_price = STANDARD_MONTHLY_PRICE_CENT
        expected_duration = MONTHLY_DURATION_DAYS
    elif role == LICENSE_ROLE_SHOP_ANNUAL:
        expected_price = STANDARD_ANNUAL_PRICE_CENT
        expected_duration = ANNUAL_DURATION_DAYS
    if expected_price is not None and plan.sale_price_cent != expected_price:
        return f"Shop-card price must be exactly {expected_price} cents"
    if expected_duration is not None and plan.duration_days != expected_duration:
        return f"Shop-card duration must be exactly {expected_duration} days"
    if Decimal(plan.price) != Decimal(plan.sale_price_cent) / Decimal(100):
        return "Shop-card display price must equal its sale price"
    return None

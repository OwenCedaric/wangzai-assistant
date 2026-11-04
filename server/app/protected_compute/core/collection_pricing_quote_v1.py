from __future__ import annotations

from typing import Any

# PROTECTED_CORE_ONLY::collection-pricing.quote@1
# The pricing formula, rounding policy and acceptance thresholds are server-only policy. Never
# copy them into the renderer, desktop proxy, local-api, SDK, installer or portable artifacts.
_POLICY_COLLECTION_PRICING_SCALE = 10_000
_POLICY_COLLECTION_PRICING_MAX_COMMISSION_BASIS_POINTS = 9_500
_POLICY_COLLECTION_PRICING_MAX_TARGET_MARGIN_BASIS_POINTS = 50_000
_POLICY_COLLECTION_PRICING_MIN_TOTAL_COST_MINOR = 1


def _ceil_ratio(numerator: int, denominator: int) -> int:
    return (numerator + denominator - 1) // denominator


def _truncate_ratio_toward_zero(numerator: int, denominator: int) -> int:
    magnitude = abs(numerator) // denominator
    return -magnitude if numerator < 0 else magnitude


def compute_collection_pricing_quote_v1(payload: dict[str, Any]) -> dict[str, Any]:
    total_cost = (
        payload["purchaseCostMinor"] + payload["firstMileCostMinor"] + payload["extraCostMinor"]
    )
    commission_basis_points = payload["commissionBasisPoints"]
    target_margin_basis_points = payload["targetMarginBasisPoints"]
    if total_cost < _POLICY_COLLECTION_PRICING_MIN_TOTAL_COST_MINOR:
        raise ValueError("total cost is below the protected pricing policy minimum")
    if commission_basis_points > _POLICY_COLLECTION_PRICING_MAX_COMMISSION_BASIS_POINTS:
        raise ValueError("commission exceeds the protected pricing policy")
    if target_margin_basis_points > _POLICY_COLLECTION_PRICING_MAX_TARGET_MARGIN_BASIS_POINTS:
        raise ValueError("target margin exceeds the protected pricing policy")

    denominator = _POLICY_COLLECTION_PRICING_SCALE - commission_basis_points
    break_even_price = _ceil_ratio(
        total_cost * _POLICY_COLLECTION_PRICING_SCALE,
        denominator,
    )
    suggested_price = _ceil_ratio(
        total_cost * (_POLICY_COLLECTION_PRICING_SCALE + target_margin_basis_points),
        denominator,
    )

    current_price = payload["currentPriceMinor"]
    current_profit: int | None = None
    current_margin_basis_points: int | None = None
    if current_price is not None:
        commission_charge = _ceil_ratio(
            current_price * commission_basis_points,
            _POLICY_COLLECTION_PRICING_SCALE,
        )
        current_profit = current_price - commission_charge - total_cost
        current_margin_basis_points = _truncate_ratio_toward_zero(
            current_profit * _POLICY_COLLECTION_PRICING_SCALE,
            current_price,
        )

    return {
        "breakEvenPriceMinor": break_even_price,
        "currency": payload["currency"],
        "currentMarginBasisPoints": current_margin_basis_points,
        "currentProfitMinor": current_profit,
        "suggestedPriceMinor": suggested_price,
        "totalCostMinor": total_cost,
    }

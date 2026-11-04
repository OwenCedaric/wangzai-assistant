from __future__ import annotations

from typing import Any

# PROTECTED_CORE_ONLY::profitability.quote@1
# These coefficients and thresholds are confidential server policy. They must never be copied to
# frontend, desktop, local-api, SDK, installer, portable, source-map, or diagnostic artifacts.
_POLICY_RESERVE_BASIS_POINTS = 137
_POLICY_LOGISTICS_MULTIPLIER_NUMERATOR = 103
_POLICY_LOGISTICS_MULTIPLIER_DENOMINATOR = 100
_POLICY_DECISION_THRESHOLDS = (450, 1_250, 2_100)


def _ceil_ratio(numerator: int, denominator: int) -> int:
    return (numerator + denominator - 1) // denominator


def compute_profitability_quote_v1(payload: dict[str, Any]) -> dict[str, Any]:
    sale_price = payload["salePriceMinor"]
    percentage_basis_points = (
        payload["commissionBasisPoints"]
        + payload["acquiringBasisPoints"]
        + payload["taxBasisPoints"]
    )
    variable_charge = _ceil_ratio(sale_price * percentage_basis_points, 10_000)
    protected_logistics = _ceil_ratio(
        payload["logisticsMinor"] * _POLICY_LOGISTICS_MULTIPLIER_NUMERATOR,
        _POLICY_LOGISTICS_MULTIPLIER_DENOMINATOR,
    )
    policy_reserve = _ceil_ratio(sale_price * _POLICY_RESERVE_BASIS_POINTS, 10_000)
    contribution = (
        sale_price - payload["costMinor"] - protected_logistics - variable_charge - policy_reserve
    )
    margin_basis_points = contribution * 10_000 // sale_price
    if margin_basis_points < _POLICY_DECISION_THRESHOLDS[0]:
        decision = "reject"
    elif margin_basis_points < _POLICY_DECISION_THRESHOLDS[1]:
        decision = "review"
    elif margin_basis_points < _POLICY_DECISION_THRESHOLDS[2]:
        decision = "acceptable"
    else:
        decision = "preferred"
    # Do not return confidential intermediate coefficients or reserve components.
    return {
        "contributionMinor": contribution,
        "currency": payload["currency"],
        "decision": decision,
        "marginBasisPoints": margin_basis_points,
    }

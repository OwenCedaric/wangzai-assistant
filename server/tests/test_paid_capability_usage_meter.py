from __future__ import annotations

from decimal import Decimal

import pytest

from app.paid_capabilities.usage_meter import (
    ProviderCostSnapshot,
    ProviderUsageMeterError,
    measured_provider_cost_micros,
    parse_provider_cost_snapshot,
    usage_endpoint,
)


def snapshot(requests: int, cost: str) -> ProviderCostSnapshot:
    return ProviderCostSnapshot(requests, Decimal(cost), "USD")


def test_usage_endpoint_is_same_origin_and_under_configured_v1() -> None:
    assert (
        usage_endpoint("https://text.example.invalid/v1")
        == "https://text.example.invalid/v1/usage"
    )


def test_parse_provider_cost_snapshot_uses_cumulative_actual_cost() -> None:
    parsed = parse_provider_cost_snapshot(
        {
            "unit": "USD",
            "usage": {"total": {"requests": 7, "actual_cost": 0.0271539}},
        }
    )
    assert parsed == snapshot(7, "0.0271539")


def test_measured_cost_uses_exact_decimal_delta_and_ceiling() -> None:
    assert measured_provider_cost_micros(
        snapshot(7, "0.0271539"),
        snapshot(8, "0.02815401"),
        cny_micros_per_credit=1_000_000,
    ) == 1001


@pytest.mark.parametrize(
    "before,after",
    [
        (snapshot(7, "1"), snapshot(7, "1")),
        (snapshot(7, "1"), snapshot(9, "1.1")),
        (snapshot(7, "1"), snapshot(8, "0.9")),
    ],
)
def test_unattributable_or_backwards_delta_fails_closed(
    before: ProviderCostSnapshot,
    after: ProviderCostSnapshot,
) -> None:
    with pytest.raises(ProviderUsageMeterError):
        measured_provider_cost_micros(
            before,
            after,
            cny_micros_per_credit=1_000_000,
        )

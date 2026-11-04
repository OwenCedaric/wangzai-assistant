from __future__ import annotations

import pytest

from app.paid_capabilities.pricing import (
    PricingPolicy,
    ProviderUsage,
    calculate_charge_points,
    calculate_charge_points_from_provider_cost,
    calculate_provider_cost_micros,
    calculate_reservation_points,
)


def text_policy(**overrides: int) -> PricingPolicy:
    values = {
        "input_micros_per_million": 750_000,
        "output_micros_per_million": 4_500_000,
        "cached_input_micros_per_million": 75_000,
        "fixed_cost_micros": 0,
        "unit_cost_micros": 0,
        "provider_multiplier_ppm": 1_000_000,
        "risk_buffer_basis_points": 0,
        "target_margin_basis_points": 1_800,
        "minimum_margin_basis_points": 1_500,
        "points_per_cny": 1_050,
    }
    values.update(overrides)
    return PricingPolicy(**values)


def image_policy(**overrides: int) -> PricingPolicy:
    values = {
        "input_micros_per_million": 0,
        "output_micros_per_million": 0,
        "cached_input_micros_per_million": 0,
        "fixed_cost_micros": 0,
        "unit_cost_micros": 13_740,
        "provider_multiplier_ppm": 1_000_000,
        "risk_buffer_basis_points": 0,
        "target_margin_basis_points": 1_800,
        "minimum_margin_basis_points": 1_500,
        "points_per_cny": 1_050,
    }
    values.update(overrides)
    return PricingPolicy(**values)


@pytest.mark.parametrize(
    "usage, expected_cost, expected_points",
    [
        (ProviderUsage(input_tokens=10_000, output_tokens=2_000), 16_500, 21),
        (ProviderUsage(input_tokens=8_000, output_tokens=1_000), 10_500, 13),
        (ProviderUsage(input_tokens=1, output_tokens=1), 6, 1),
        (ProviderUsage(input_tokens=0, output_tokens=1_000), 4_500, 6),
        (ProviderUsage(input_tokens=1_000, output_tokens=0), 750, 1),
        (ProviderUsage(cached_input_tokens=10_000), 750, 1),
        (ProviderUsage(input_tokens=10_000, cached_input_tokens=10_000), 8_250, 11),
        (ProviderUsage(units=1), 0, 0),
    ],
)
def test_text_pricing_exact_integer_results(
    usage: ProviderUsage, expected_cost: int, expected_points: int
) -> None:
    assert calculate_provider_cost_micros(text_policy(), usage) == expected_cost
    assert calculate_charge_points(text_policy(), usage) == expected_points


@pytest.mark.parametrize(
    "units, expected_cost, expected_points",
    [
        (1, 13_740, 18),
        (2, 27_480, 35),
        (3, 41_220, 53),
        (4, 54_960, 70),
        (8, 109_920, 141),
        (16, 219_840, 282),
    ],
)
def test_image_pricing_scales_by_successful_units(
    units: int, expected_cost: int, expected_points: int
) -> None:
    usage = ProviderUsage(units=units)
    assert calculate_provider_cost_micros(image_policy(), usage) == expected_cost
    assert calculate_charge_points(image_policy(), usage) == expected_points


def test_fixed_image_sell_price_ignores_provider_cost_for_customer_charge() -> None:
    policy = image_policy(
        unit_cost_micros=20_000,
        unit_sell_price_micros=50_000,
    )
    assert calculate_charge_points(policy, ProviderUsage(units=1)) == 53
    assert calculate_charge_points(policy, ProviderUsage(units=3)) == 158
    assert calculate_reservation_points(policy, ProviderUsage(units=3)) == 158


@pytest.mark.parametrize("input_tokens", [0, 1, 10, 100, 1_000, 5_000, 10_000, 50_000])
def test_input_token_price_is_monotonic(input_tokens: int) -> None:
    lower = calculate_charge_points(text_policy(), ProviderUsage(input_tokens=input_tokens))
    higher = calculate_charge_points(text_policy(), ProviderUsage(input_tokens=input_tokens + 1))
    assert higher >= lower


@pytest.mark.parametrize("output_tokens", [0, 1, 10, 100, 1_000, 2_000, 4_000, 8_000])
def test_output_token_price_is_monotonic(output_tokens: int) -> None:
    lower = calculate_charge_points(text_policy(), ProviderUsage(output_tokens=output_tokens))
    higher = calculate_charge_points(text_policy(), ProviderUsage(output_tokens=output_tokens + 1))
    assert higher >= lower


@pytest.mark.parametrize(
    "overrides",
    [
        {"target_margin_basis_points": 1_499},
        {"target_margin_basis_points": 10_000},
        {"minimum_margin_basis_points": 10_000},
        {"minimum_margin_basis_points": -1},
        {"risk_buffer_basis_points": -1},
        {"risk_buffer_basis_points": 10_001},
        {"provider_multiplier_ppm": 0},
        {"points_per_cny": 0},
        {"input_micros_per_million": -1},
        {"unit_cost_micros": -1},
    ],
)
def test_invalid_or_unprofitable_policy_fails_closed(overrides: dict[str, int]) -> None:
    with pytest.raises(ValueError):
        text_policy(**overrides)


@pytest.mark.parametrize(
    "usage",
    [
        ProviderUsage(input_tokens=-1),
        ProviderUsage(output_tokens=-1),
        ProviderUsage(cached_input_tokens=-1),
        ProviderUsage(units=-1),
    ],
)
def test_negative_usage_is_rejected(usage: ProviderUsage) -> None:
    with pytest.raises(ValueError):
        calculate_charge_points(text_policy(), usage)


def test_risk_buffer_applies_only_to_reservation() -> None:
    assert calculate_charge_points(image_policy(), ProviderUsage(units=1)) == 18
    buffered = image_policy(risk_buffer_basis_points=500)
    assert calculate_charge_points(buffered, ProviderUsage(units=1)) == 18
    assert calculate_reservation_points(buffered, ProviderUsage(units=1)) == 19


def test_provider_multiplier_uses_ceiling_and_never_undercharges() -> None:
    policy = image_policy(unit_cost_micros=1, provider_multiplier_ppm=500_001)
    assert calculate_provider_cost_micros(policy, ProviderUsage(units=1)) == 1


def test_customer_multiplier_applies_after_safe_margin_pricing() -> None:
    policy = image_policy(unit_cost_micros=100_000, customer_multiplier_ppm=1_250_000)
    base_policy = image_policy(unit_cost_micros=100_000)
    usage = ProviderUsage(units=1)
    base_points = calculate_charge_points(base_policy, usage)
    expected = (base_points * 1_250_000 + 999_999) // 1_000_000
    assert calculate_charge_points(policy, usage) == expected


def test_customer_multiplier_applies_to_fixed_image_sell_price() -> None:
    policy = image_policy(
        unit_cost_micros=20_000,
        unit_sell_price_micros=50_000,
        customer_multiplier_ppm=1_200_000,
    )
    assert calculate_charge_points(policy, ProviderUsage(units=1)) == 63


def test_customer_multiplier_is_stable_across_one_hundred_billing_scenarios() -> None:
    for index in range(1, 101):
        multiplier = 1_000_000 + index * 10_000
        policy = image_policy(
            unit_sell_price_micros=50_000,
            customer_multiplier_ppm=multiplier,
        )
        units = (index % 7) + 1
        expected = (
            units * 50_000 * multiplier * policy.points_per_cny
            + 1_000_000 * 1_000_000 - 1
        ) // (1_000_000 * 1_000_000)
        assert calculate_charge_points(policy, ProviderUsage(units=units)) == expected


def test_margin_rate_is_not_misread_as_simple_markup() -> None:
    policy = image_policy(unit_cost_micros=820_000)
    assert calculate_charge_points(policy, ProviderUsage(units=1)) == 1_050


def test_hundreds_of_costs_stay_inside_margin_band_when_integer_points_allow_it() -> None:
    policy = image_policy()
    for provider_cost in range(5_000, 500_001, 997):
        points = calculate_charge_points_from_provider_cost(policy, provider_cost)
        revenue_micros = points * 1_000_000 / policy.points_per_cny
        margin = (revenue_micros - provider_cost) / revenue_micros
        minimum_points = -(
            -(provider_cost * policy.points_per_cny * 10_000)
            // ((10_000 - policy.minimum_margin_basis_points) * 1_000_000)
        )
        maximum_points = (
            provider_cost * policy.points_per_cny * 10_000
        ) // ((10_000 - 2_000) * 1_000_000)
        if minimum_points <= maximum_points:
            assert 0.15 <= margin <= 0.20
        else:
            assert points == minimum_points

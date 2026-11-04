from __future__ import annotations

from dataclasses import dataclass


def _ceil_div(numerator: int, denominator: int) -> int:
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    if numerator < 0:
        raise ValueError("numerator must be non-negative")
    return (numerator + denominator - 1) // denominator


@dataclass(frozen=True, slots=True)
class ProviderUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    units: int = 0

    def validate(self) -> None:
        values = (
            self.input_tokens,
            self.output_tokens,
            self.cached_input_tokens,
            self.units,
        )
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values
        ):
            raise ValueError("provider usage values must be non-negative integers")


@dataclass(frozen=True, slots=True)
class PricingPolicy:
    input_micros_per_million: int
    output_micros_per_million: int
    cached_input_micros_per_million: int
    fixed_cost_micros: int
    unit_cost_micros: int
    provider_multiplier_ppm: int
    risk_buffer_basis_points: int
    target_margin_basis_points: int
    minimum_margin_basis_points: int
    points_per_cny: int
    unit_sell_price_micros: int = 0
    customer_multiplier_ppm: int = 1_000_000

    def __post_init__(self) -> None:
        non_negative = (
            self.input_micros_per_million,
            self.output_micros_per_million,
            self.cached_input_micros_per_million,
            self.fixed_cost_micros,
            self.unit_cost_micros,
            self.unit_sell_price_micros,
        )
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in non_negative
        ):
            raise ValueError("pricing costs must be non-negative integers")
        if self.provider_multiplier_ppm <= 0:
            raise ValueError("provider multiplier must be positive")
        if not 1_000_000 <= self.customer_multiplier_ppm <= 10_000_000:
            raise ValueError("customer multiplier must be between 100% and 1000%")
        if not 0 <= self.risk_buffer_basis_points <= 10_000:
            raise ValueError("risk buffer is outside the supported range")
        if not 0 <= self.minimum_margin_basis_points < 10_000:
            raise ValueError("minimum margin is outside the supported range")
        if not self.minimum_margin_basis_points <= self.target_margin_basis_points <= 2_000:
            raise ValueError("target margin is below the floor or outside the supported range")
        if self.points_per_cny <= 0:
            raise ValueError("points_per_cny must be positive")


def calculate_provider_cost_micros(policy: PricingPolicy, usage: ProviderUsage) -> int:
    usage.validate()
    raw_cost = (
        policy.fixed_cost_micros
        + usage.units * policy.unit_cost_micros
        + _ceil_div(usage.input_tokens * policy.input_micros_per_million, 1_000_000)
        + _ceil_div(usage.output_tokens * policy.output_micros_per_million, 1_000_000)
        + _ceil_div(
            usage.cached_input_tokens * policy.cached_input_micros_per_million,
            1_000_000,
        )
    )
    return _ceil_div(raw_cost * policy.provider_multiplier_ppm, 1_000_000)


def calculate_charge_points(policy: PricingPolicy, usage: ProviderUsage) -> int:
    if policy.unit_sell_price_micros:
        usage.validate()
        return _ceil_div(
            usage.units
            * policy.unit_sell_price_micros
            * policy.customer_multiplier_ppm
            * policy.points_per_cny,
            1_000_000 * 1_000_000,
        )
    provider_cost = calculate_provider_cost_micros(policy, usage)
    return calculate_charge_points_from_provider_cost(policy, provider_cost)


def calculate_charge_points_from_provider_cost(
    policy: PricingPolicy,
    provider_cost_micros: int,
) -> int:
    if isinstance(provider_cost_micros, bool) or not isinstance(provider_cost_micros, int):
        raise ValueError("provider cost must be a non-negative integer")
    if provider_cost_micros < 0:
        raise ValueError("provider cost must be a non-negative integer")
    if provider_cost_micros == 0:
        return 0
    numerator = provider_cost_micros * policy.points_per_cny * 10_000
    denominator = (10_000 - policy.target_margin_basis_points) * 1_000_000
    target_points = (numerator + denominator // 2) // denominator
    minimum_points = _ceil_div(
        numerator,
        (10_000 - policy.minimum_margin_basis_points) * 1_000_000,
    )
    maximum_points = numerator // ((10_000 - 2_000) * 1_000_000)
    if minimum_points <= maximum_points:
        base_points = max(minimum_points, min(target_points, maximum_points))
        return _ceil_div(base_points * policy.customer_multiplier_ppm, 1_000_000)
    # Point balances are integers. For sub-cent requests there may be no whole
    # point that satisfies both bounds; fail toward the 15% profit floor.
    return _ceil_div(minimum_points * policy.customer_multiplier_ppm, 1_000_000)


def calculate_reservation_points(policy: PricingPolicy, usage: ProviderUsage) -> int:
    if policy.unit_sell_price_micros:
        return calculate_charge_points(policy, usage)
    provider_cost = calculate_provider_cost_micros(policy, usage)
    if provider_cost == 0:
        return 0
    buffered_cost = _ceil_div(
        provider_cost * (10_000 + policy.risk_buffer_basis_points),
        10_000,
    )
    customer_price_micros = _ceil_div(
        buffered_cost * 10_000,
        10_000 - policy.target_margin_basis_points,
    )
    return _ceil_div(
        customer_price_micros * policy.points_per_cny * policy.customer_multiplier_ppm,
        1_000_000 * 1_000_000,
    )

from __future__ import annotations

from app.paid_capabilities.pricing import (
    PricingPolicy,
    ProviderUsage,
    calculate_charge_points,
    calculate_charge_points_from_provider_cost,
    calculate_provider_cost_micros,
)
from app.paid_capabilities.registry import public_paid_capability_contracts
from app.paid_capabilities.wangzai_rates import wangzai_rate_specs


def _policy(spec: dict[str, object]) -> PricingPolicy:
    return PricingPolicy(
        input_micros_per_million=int(spec["input_micros_per_million"]),
        output_micros_per_million=int(spec["output_micros_per_million"]),
        cached_input_micros_per_million=int(spec["cached_input_micros_per_million"]),
        fixed_cost_micros=int(spec["fixed_cost_micros"]),
        unit_cost_micros=int(spec["unit_cost_micros"]),
        provider_multiplier_ppm=int(spec["provider_multiplier_ppm"]),
        risk_buffer_basis_points=int(spec["risk_buffer_basis_points"]),
        target_margin_basis_points=int(spec["target_margin_basis_points"]),
        minimum_margin_basis_points=int(spec["minimum_margin_basis_points"]),
        points_per_cny=int(spec["points_per_cny"]),
        unit_sell_price_micros=int(spec["unit_sell_price_micros"]),
        customer_multiplier_ppm=int(spec["customer_multiplier_ppm"]),
    )


def test_wangzai_rate_catalog_covers_every_paid_capability_once() -> None:
    specs = wangzai_rate_specs()
    routes = [(str(spec["capability"]), str(spec["provider_model"])) for spec in specs]
    public = [str(item["capability"]) for item in public_paid_capability_contracts()]
    assert len(specs) == 19
    assert len(routes) == len(set(routes))
    assert {capability for capability, _model in routes} == set(public)

    text_models = {
        "gpt-5.6-sol",
        "gpt-5.6-terra",
    }
    image_models = {"gpt-image-2"}
    for capability in public:
        models = {model for item, model in routes if item == capability}
        if capability.startswith("text."):
            assert models == text_models
        elif capability.startswith("image."):
            assert models == image_models
        else:
            assert models == {""}


def test_wangzai_rate_catalog_keeps_realized_margin_between_fifteen_and_twenty_percent() -> None:
    for spec in wangzai_rate_specs():
        if str(spec["capability"]).startswith("image."):
            continue
        policy = _policy(spec)
        usage = (
            ProviderUsage(input_tokens=1_000_000, output_tokens=1_000_000)
            if str(spec["capability"]).startswith("text.")
            else ProviderUsage(units=100_000)
        )
        provider_cost = calculate_provider_cost_micros(policy, usage)
        charged_points = calculate_charge_points(policy, usage)
        customer_price_micros = charged_points * 1_000_000 / policy.points_per_cny
        realized_margin = 1 - provider_cost / customer_price_micros
        assert 0.15 <= realized_margin <= 0.20, spec["capability"]


def test_wangzai_image_rates_use_customer_approved_fixed_prices() -> None:
    prices = {
        str(spec["provider_model"]): (
            int(spec["unit_cost_micros"]),
            int(spec["unit_sell_price_micros"]),
        )
        for spec in wangzai_rate_specs()
        if spec["capability"] == "image.generate"
    }
    assert prices == {
        "gpt-image-2": (20_000, 50_000),
    }
    for spec in wangzai_rate_specs():
        if not str(spec["capability"]).startswith("image."):
            continue
        policy = _policy(spec)
        assert calculate_charge_points(policy, ProviderUsage(units=1)) == 53


def test_wangzai_rate_catalog_uses_server_owned_provider_models() -> None:
    for spec in wangzai_rate_specs():
        capability = str(spec["capability"])
        if capability.startswith("text."):
            assert spec["provider_model"] in {
                "gpt-5.6-sol",
                "gpt-5.6-terra",
            }
        elif capability.startswith("image."):
            assert spec["provider_model"] == "gpt-image-2"
        else:
            assert spec["provider_model"] == ""


def test_wangzai_text_rates_match_live_reconciled_provider_prices() -> None:
    expected = {
        "gpt-5.6-sol": (5_000_000, 30_000_000, 500_000, 200_000),
        "gpt-5.6-terra": (2_000_000, 12_000_000, 200_000, 200_000),
    }
    actual = {}
    for spec in wangzai_rate_specs():
        if spec["capability"] != "text.product-description":
            continue
        actual[str(spec["provider_model"])] = (
            int(spec["input_micros_per_million"]),
            int(spec["output_micros_per_million"]),
            int(spec["cached_input_micros_per_million"]),
            int(spec["provider_multiplier_ppm"]),
        )
    assert actual == expected


def test_wangzai_text_rates_charge_exactly_one_point_two_times_upstream_cost() -> None:
    text_specs = [
        spec
        for spec in wangzai_rate_specs()
        if str(spec["capability"]).startswith("text.")
    ]
    assert text_specs
    for spec in text_specs:
        policy = _policy(spec)
        assert policy.minimum_margin_basis_points == 0
        assert policy.target_margin_basis_points == 0
        assert policy.customer_multiplier_ppm == 1_200_000
        # CNY 10 of measured upstream cost is 10,500 internal cost points;
        # the customer charge is therefore exactly 12,600 points.
        assert calculate_charge_points_from_provider_cost(policy, 10_000_000) == 12_600


def test_wangzai_seerfar_rates_preserve_live_endpoint_credit_weights() -> None:
    costs = {
        str(spec["capability"]): int(spec["unit_cost_micros"])
        for spec in wangzai_rate_specs()
        if str(spec["capability"]).startswith("external.seerfar.")
    }
    assert costs == {
        "external.seerfar.shop": 499_000,
        "external.seerfar.product-detail": 149_700,
        "external.seerfar.category": 499_000,
        "external.seerfar.product-report": 499_000,
        "external.seerfar.market-keyword": 748_500,
        "external.seerfar.keyword-mining": 748_500,
        "external.seerfar.keyword-back": 748_500,
    }

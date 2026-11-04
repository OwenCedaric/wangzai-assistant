from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

WANGZAI_RATE_PRICE_VERSION = "wangzai-paid-2026-08-24-v5"
# Start before the local launch day so UTC conversion cannot leave the first
# hours of an Asia/Shanghai deployment without an active rate.
WANGZAI_RATE_EFFECTIVE_FROM = datetime(2026, 8, 4, tzinfo=UTC)

_COMMON = {
    "version": 1,
    "minimum_margin_basis_points": 1_500,
    "target_margin_basis_points": 1_800,
    # The most generous active package currently sells 1,050 points per CNY.
    "points_per_cny": 1_050,
    "currency": "CNY",
    "effective_from": WANGZAI_RATE_EFFECTIVE_FROM,
    "effective_until": None,
    "unit_sell_price_micros": 0,
    "customer_multiplier_ppm": 1_000_000,
}

# These rates were reconciled on 2026-08-06 with three deliberately different
# live requests per model (short output, long output and large uncached input).
# The provider's usage endpoint independently reported input, cache-read,
# output, list cost and actual cost, so the values below are measured billing
# inputs rather than model-name guesses. The two approved text models settled at
# 0.20x actual cost.
_TEXT_MODELS = {
    "gpt-5.6-sol": (5_000_000, 30_000_000, 500_000, 200_000),
    "gpt-5.6-terra": (2_000_000, 12_000_000, 200_000, 200_000),
}


def _text_rate(model: str) -> dict[str, Any]:
    input_rate, output_rate, cached_rate, multiplier = _TEXT_MODELS[model]
    return {
        **_COMMON,
        "price_version": f"{WANGZAI_RATE_PRICE_VERSION}-text-{model}",
        "provider_code": "builtin-text",
        "provider_model": model,
        "input_micros_per_million": input_rate,
        "output_micros_per_million": output_rate,
        "cached_input_micros_per_million": cached_rate,
        "fixed_cost_micros": 0,
        "unit_cost_micros": 0,
        "provider_multiplier_ppm": multiplier,
        # Text requests settle from the provider's measured before/after cost.
        # Keep the legacy margin layer at zero and apply one explicit 1.2x
        # customer multiplier so an upstream cost of 10 points settles at 12.
        "minimum_margin_basis_points": 0,
        "target_margin_basis_points": 0,
        "customer_multiplier_ppm": 1_200_000,
        # The provider labels the group as market-price variable. A 2% cost
        # buffer is used for reservation only; final settlement still uses the
        # exact measured upstream cost and the 1.2x customer multiplier.
        "risk_buffer_basis_points": 200,
    }


# Customer-approved fixed image prices. Provider task costs remain recorded for
# audit, but no longer move the customer charge for an already active version.
_IMAGE = {
    **_COMMON,
    "price_version": "wangzai-image-fixed-2026-08-06-v1",
    "provider_code": "builtin-image",
    "provider_model": "gpt-image-2",
    "input_micros_per_million": 0,
    "output_micros_per_million": 0,
    "cached_input_micros_per_million": 0,
    "fixed_cost_micros": 0,
    "unit_cost_micros": 20_000,
    "unit_sell_price_micros": 50_000,
    "provider_multiplier_ppm": 1_000_000,
    "risk_buffer_basis_points": 0,
}

# The live Seerfar key exposes a 10,000-credit allowance. The public
# professional plan is CNY 499, so one upstream credit costs CNY 0.0499.
# Live before/after quota probes show that endpoints consume different credit
# weights; each capability therefore gets its own immutable unit cost.
_SEERFAR_BASE = {
    **_COMMON,
    "price_version": "wangzai-paid-2026-08-05-v3",
    "provider_code": "seerfar",
    "provider_model": "",
    "input_micros_per_million": 0,
    "output_micros_per_million": 0,
    "cached_input_micros_per_million": 0,
    "fixed_cost_micros": 0,
    "provider_multiplier_ppm": 1_000_000,
    "risk_buffer_basis_points": 200,
}

_SEERFAR_CREDIT_COST_MICROS = 49_900
_SEERFAR_CREDIT_WEIGHTS = {
    "external.seerfar.shop": 10,
    "external.seerfar.product-detail": 3,
    "external.seerfar.category": 10,
    "external.seerfar.product-report": 10,
    # The live market endpoint currently returns an upstream 500 before
    # billing. Keep its card at the highest observed read weight so a future
    # upstream recovery cannot create an under-priced request.
    "external.seerfar.market-keyword": 15,
    "external.seerfar.keyword-mining": 15,
    "external.seerfar.keyword-back": 15,
}


def wangzai_rate_specs() -> tuple[dict[str, Any], ...]:
    text_capabilities = (
        "text.product-description",
        "text.image-plan",
        "text.data-analysis",
        "text.external-insight",
        "text.openclaw-chat",
    )
    image_capabilities = ("image.generate", "image.edit")
    text_specs = tuple(
        {**_text_rate(model), "capability": capability}
        for model in _TEXT_MODELS
        for capability in text_capabilities
    )
    image_specs = tuple(
        {**template, "capability": capability}
        for template in (_IMAGE,)
        for capability in image_capabilities
    )
    seerfar_specs = tuple(
        {
            **_SEERFAR_BASE,
            "capability": capability,
            "unit_cost_micros": _SEERFAR_CREDIT_COST_MICROS * credit_weight,
        }
        for capability, credit_weight in _SEERFAR_CREDIT_WEIGHTS.items()
    )
    return text_specs + image_specs + seerfar_specs

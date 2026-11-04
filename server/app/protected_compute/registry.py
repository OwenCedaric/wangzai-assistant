from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.protected_compute.core.collection_pricing_quote_v1 import (
    compute_collection_pricing_quote_v1,
)
from app.protected_compute.core.profitability_quote_v1 import (
    compute_profitability_quote_v1,
)
from app.protected_compute.private_profit import (
    execute_private_profit,
    normalize_private_profit_input,
    validate_private_profit_result,
)
from app.protected_compute.secret_guard import SecretInputError


class CapabilityContractError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class CapabilityDescriptor:
    capability: str
    version: int
    required_permission: str
    offline_allowed: bool
    offline_max_uses: int
    normalize: Callable[[dict[str, Any]], dict[str, Any]]
    execute: Callable[[dict[str, Any]], dict[str, Any]]
    validate_result: Callable[[dict[str, Any]], dict[str, Any]]
    uses_runtime_settings: bool = False


_PROFITABILITY_FIELDS = {
    "acquiringBasisPoints",
    "commissionBasisPoints",
    "costMinor",
    "currency",
    "logisticsMinor",
    "salePriceMinor",
    "taxBasisPoints",
}

_COLLECTION_PRICING_FIELDS = {
    "commissionBasisPoints",
    "currency",
    "currentPriceMinor",
    "extraCostMinor",
    "firstMileCostMinor",
    "purchaseCostMinor",
    "targetMarginBasisPoints",
}

_INPUT_CURRENCY_PATTERN = re.compile(r"[A-Za-z]{3}", flags=re.ASCII)
_RESULT_CURRENCY_PATTERN = re.compile(r"[A-Z]{3}", flags=re.ASCII)


def _normalize_currency(value: object) -> str:
    if not isinstance(value, str):
        raise CapabilityContractError("currency must be a three-letter ISO code")
    normalized = value.strip()
    if _INPUT_CURRENCY_PATTERN.fullmatch(normalized) is None:
        raise CapabilityContractError("currency must be a three-letter ASCII ISO code")
    return normalized.upper()


def _valid_result_currency(value: object) -> bool:
    return isinstance(value, str) and _RESULT_CURRENCY_PATTERN.fullmatch(value) is not None


def _integer(value: Any, field: str, *, minimum: int = 0, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CapabilityContractError(f"{field} must be an integer")
    if value < minimum or value > maximum:
        raise CapabilityContractError(f"{field} is outside the contract range")
    return value


def _normalize_profitability(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != _PROFITABILITY_FIELDS:
        raise CapabilityContractError("input fields do not match profitability.quote@1")
    currency = _normalize_currency(payload["currency"])
    return {
        "acquiringBasisPoints": _integer(
            payload["acquiringBasisPoints"], "acquiringBasisPoints", maximum=10_000
        ),
        "commissionBasisPoints": _integer(
            payload["commissionBasisPoints"], "commissionBasisPoints", maximum=10_000
        ),
        "costMinor": _integer(payload["costMinor"], "costMinor", maximum=300_000_000_000),
        "currency": currency,
        "logisticsMinor": _integer(
            payload["logisticsMinor"], "logisticsMinor", maximum=300_000_000_000
        ),
        "salePriceMinor": _integer(
            payload["salePriceMinor"],
            "salePriceMinor",
            minimum=1,
            maximum=300_000_000_000,
        ),
        "taxBasisPoints": _integer(payload["taxBasisPoints"], "taxBasisPoints", maximum=10_000),
    }


def _normalize_optional_positive_integer(value: Any, field: str) -> int | None:
    if value is None:
        return None
    return _integer(value, field, minimum=1, maximum=300_000_000_000)


def _normalize_collection_pricing(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != _COLLECTION_PRICING_FIELDS:
        raise CapabilityContractError("input fields do not match collection-pricing.quote@1")
    currency = _normalize_currency(payload["currency"])
    return {
        "commissionBasisPoints": _integer(
            payload["commissionBasisPoints"],
            "commissionBasisPoints",
            maximum=10_000,
        ),
        "currency": currency,
        "currentPriceMinor": _normalize_optional_positive_integer(
            payload["currentPriceMinor"], "currentPriceMinor"
        ),
        "extraCostMinor": _integer(
            payload["extraCostMinor"], "extraCostMinor", maximum=300_000_000_000
        ),
        "firstMileCostMinor": _integer(
            payload["firstMileCostMinor"],
            "firstMileCostMinor",
            maximum=300_000_000_000,
        ),
        "purchaseCostMinor": _integer(
            payload["purchaseCostMinor"],
            "purchaseCostMinor",
            maximum=300_000_000_000,
        ),
        "targetMarginBasisPoints": _integer(
            payload["targetMarginBasisPoints"],
            "targetMarginBasisPoints",
            maximum=1_000_000,
        ),
    }


def _validate_profitability_result(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {
        "contributionMinor",
        "currency",
        "decision",
        "marginBasisPoints",
    }:
        raise CapabilityContractError("profitability result fields are invalid")
    if (
        isinstance(payload["contributionMinor"], bool)
        or not isinstance(payload["contributionMinor"], int)
        or abs(payload["contributionMinor"]) > 9_007_199_254_740_991
        or isinstance(payload["marginBasisPoints"], bool)
        or not isinstance(payload["marginBasisPoints"], int)
        or abs(payload["marginBasisPoints"]) > 9_007_199_254_740_991
        or payload["decision"] not in {"reject", "review", "acceptable", "preferred"}
        or not _valid_result_currency(payload["currency"])
    ):
        raise CapabilityContractError("profitability result values are invalid")
    return payload


def _validate_collection_pricing_result(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {
        "breakEvenPriceMinor",
        "currency",
        "currentMarginBasisPoints",
        "currentProfitMinor",
        "suggestedPriceMinor",
        "totalCostMinor",
    }:
        raise CapabilityContractError("collection pricing result fields are invalid")
    non_negative_integer_fields = (
        "breakEvenPriceMinor",
        "suggestedPriceMinor",
        "totalCostMinor",
    )
    if any(
        isinstance(payload[field], bool)
        or not isinstance(payload[field], int)
        or payload[field] < 0
        or payload[field] > 9_007_199_254_740_991
        for field in non_negative_integer_fields
    ):
        raise CapabilityContractError("collection pricing result values are invalid")
    for field in ("currentMarginBasisPoints", "currentProfitMinor"):
        value = payload[field]
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, int)
            or abs(value) > 9_007_199_254_740_991
        ):
            raise CapabilityContractError("collection pricing result values are invalid")
    if not _valid_result_currency(payload["currency"]):
        raise CapabilityContractError("collection pricing result values are invalid")
    return payload


def _normalize_private_profit(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return normalize_private_profit_input(payload)
    except (ValueError, TypeError, KeyError, SecretInputError) as exc:
        raise CapabilityContractError("private profit input is invalid") from exc


_CAPABILITIES = {
    ("profitability.quote", 1): CapabilityDescriptor(
        capability="profitability.quote",
        version=1,
        required_permission="profit.view",
        offline_allowed=True,
        offline_max_uses=3,
        normalize=_normalize_profitability,
        execute=compute_profitability_quote_v1,
        validate_result=_validate_profitability_result,
    ),
    ("collection-pricing.quote", 1): CapabilityDescriptor(
        capability="collection-pricing.quote",
        version=1,
        required_permission="collection_pricing.use",
        offline_allowed=True,
        offline_max_uses=3,
        normalize=_normalize_collection_pricing,
        execute=compute_collection_pricing_quote_v1,
        validate_result=_validate_collection_pricing_result,
    ),
    ("profit.ledger-batch", 1): CapabilityDescriptor(
        capability="profit.ledger-batch",
        version=1,
        required_permission="profit.view",
        offline_allowed=False,
        offline_max_uses=0,
        normalize=_normalize_private_profit,
        execute=execute_private_profit,
        validate_result=validate_private_profit_result,
        uses_runtime_settings=True,
    ),
}


def get_capability(capability: str, version: int) -> CapabilityDescriptor:
    descriptor = _CAPABILITIES.get((capability, version))
    if descriptor is None:
        raise CapabilityContractError("unsupported capability/version")
    return descriptor


def public_capability_contracts() -> list[dict[str, Any]]:
    return [
        {
            "capability": item.capability,
            "version": item.version,
            "requiredPermission": item.required_permission,
        }
        for item in _CAPABILITIES.values()
    ]

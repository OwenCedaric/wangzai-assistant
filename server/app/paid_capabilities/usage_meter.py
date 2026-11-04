from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlsplit, urlunsplit


class ProviderUsageMeterError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class ProviderCostSnapshot:
    requests: int
    actual_cost_credits: Decimal
    unit: str


def usage_endpoint(base_url: str) -> str:
    parsed = urlsplit(base_url)
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, f"{path}/usage", "", ""))


def parse_provider_cost_snapshot(payload: Any) -> ProviderCostSnapshot:
    if not isinstance(payload, dict):
        raise ProviderUsageMeterError("provider usage payload is invalid")
    usage = payload.get("usage")
    total = usage.get("total") if isinstance(usage, dict) else None
    if not isinstance(total, dict):
        raise ProviderUsageMeterError("provider cumulative usage is missing")
    try:
        requests = int(total["requests"])
        actual_cost = Decimal(str(total["actual_cost"]))
    except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
        raise ProviderUsageMeterError("provider cumulative cost is invalid") from exc
    unit = str(payload.get("unit") or "").upper()
    if requests < 0 or not actual_cost.is_finite() or actual_cost < 0 or unit != "USD":
        raise ProviderUsageMeterError("provider cumulative cost is unsafe")
    return ProviderCostSnapshot(requests, actual_cost, unit)


def measured_provider_cost_micros(
    before: ProviderCostSnapshot,
    after: ProviderCostSnapshot,
    *,
    cny_micros_per_credit: int,
) -> int:
    if cny_micros_per_credit <= 0:
        raise ProviderUsageMeterError("provider credit conversion is invalid")
    if before.unit != after.unit:
        raise ProviderUsageMeterError("provider usage unit changed during request")
    if after.requests - before.requests != 1:
        raise ProviderUsageMeterError("provider request delta is not attributable")
    cost_delta = after.actual_cost_credits - before.actual_cost_credits
    if cost_delta < 0:
        raise ProviderUsageMeterError("provider cumulative cost moved backwards")
    return int(
        (cost_delta * Decimal(cny_micros_per_credit)).to_integral_value(
            rounding=ROUND_CEILING
        )
    )

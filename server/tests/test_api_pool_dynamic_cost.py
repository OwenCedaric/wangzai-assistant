from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from app.paid_capabilities import api_pool_provider as provider_module
from app.paid_capabilities.api_pool_provider import PooledPaidCapabilityProvider
from app.paid_capabilities.api_pool_service import AcquiredApiCredential
from app.paid_capabilities.pricing import ProviderUsage
from app.paid_capabilities.providers import (
    ApiPoolConnection,
    PaidProviderFailure,
    PaidProviderResult,
)
from app.paid_capabilities.registry import get_paid_capability
from app.paid_capabilities.usage_meter import ProviderCostSnapshot


class FakeHttpProvider:
    def __init__(self, snapshots: list[tuple[int, str]]) -> None:
        self.snapshots = iter(snapshots)
        self.client = httpx.Client(transport=httpx.MockTransport(self._usage))

    def _usage(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/usage"
        requests, cost = next(self.snapshots)
        return httpx.Response(
            200,
            json={
                "unit": "USD",
                "usage": {"total": {"requests": requests, "actual_cost": cost}},
            },
        )

    def execute_with_connection(self, *_args, **_kwargs) -> PaidProviderResult:
        return PaidProviderResult(
            result={"text": "ok"},
            usage=ProviderUsage(input_tokens=10, output_tokens=20),
        )


def acquired() -> AcquiredApiCredential:
    return AcquiredApiCredential(
        provider_id=1,
        provider_code="codesonline",
        key_id=1,
        lease_id="lease-1",
        connection=ApiPoolConnection(
            base_url="https://text.example.invalid/v1",
            api_key="sk-test-only",
            adapter="openai-compatible",
        ),
    )


def test_codesonline_result_carries_exact_before_after_cost(
    client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_http = FakeHttpProvider([(10, "1.000000"), (11, "1.003210")])
    releases: list[PaidProviderFailure | None] = []
    monkeypatch.setattr(provider_module, "acquire_api_credential", lambda *_a, **_k: acquired())
    monkeypatch.setattr(
        provider_module,
        "release_api_credential",
        lambda *_a, failure=None, **_k: releases.append(failure),
    )
    client.app.state.settings.paid_text_usage_poll_attempts = 1
    pooled = PooledPaidCapabilityProvider(
        client.app.state.settings,
        client.app.state.session_factory,
        http_provider=fake_http,
    )
    result = pooled.execute(
        get_paid_capability("text.product-description", 1),
        {"systemPrompt": "facts", "userPrompt": "item"},
        provider_code="codesonline",
        provider_model="gpt-5.6-sol",
    )
    assert result.actual_provider_cost_micros == 3_210
    assert result.provider_cost_source == "provider_usage_delta"
    assert releases == [None]


def test_codesonline_concurrent_or_external_usage_fails_closed(
    client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_http = FakeHttpProvider([(10, "1.000000"), (12, "1.003210")])
    releases: list[PaidProviderFailure | None] = []
    monkeypatch.setattr(provider_module, "acquire_api_credential", lambda *_a, **_k: acquired())
    monkeypatch.setattr(
        provider_module,
        "release_api_credential",
        lambda *_a, failure=None, **_k: releases.append(failure),
    )
    client.app.state.settings.paid_text_usage_poll_attempts = 1
    pooled = PooledPaidCapabilityProvider(
        client.app.state.settings,
        client.app.state.session_factory,
        http_provider=fake_http,
    )
    with pytest.raises(PaidProviderFailure) as error:
        pooled.execute(
            get_paid_capability("text.product-description", 1),
            {"systemPrompt": "facts", "userPrompt": "item"},
            provider_code="codesonline",
            provider_model="gpt-5.6-sol",
        )
    assert error.value.code == "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE"
    assert releases and releases[0] is error.value


def test_post_request_usage_endpoint_failure_is_never_marked_unbilled(
    client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_http = FakeHttpProvider([])
    releases: list[PaidProviderFailure | None] = []
    snapshots = iter(
        [
            ProviderCostSnapshot(10, Decimal("1"), "USD"),
            PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_PRICING_UNAVAILABLE",
                "temporary",
                False,
            ),
        ]
    )

    def read_snapshot(*_args, **_kwargs):
        value = next(snapshots)
        if isinstance(value, BaseException):
            raise value
        return value

    monkeypatch.setattr(provider_module, "read_provider_cost_snapshot", read_snapshot)
    monkeypatch.setattr(provider_module, "acquire_api_credential", lambda *_a, **_k: acquired())
    monkeypatch.setattr(
        provider_module,
        "release_api_credential",
        lambda *_a, failure=None, **_k: releases.append(failure),
    )
    client.app.state.settings.paid_text_usage_poll_attempts = 1
    pooled = PooledPaidCapabilityProvider(
        client.app.state.settings,
        client.app.state.session_factory,
        http_provider=fake_http,
    )
    with pytest.raises(PaidProviderFailure) as error:
        pooled.execute(
            get_paid_capability("text.product-description", 1),
            {"systemPrompt": "facts", "userPrompt": "item"},
            provider_code="codesonline",
            provider_model="gpt-5.6-sol",
        )
    assert error.value.code == "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE"
    assert error.value.billable is None
    assert releases and releases[0] is error.value


class FailoverHttpProvider:
    def __init__(self, first_failure: PaidProviderFailure) -> None:
        self.first_failure = first_failure
        self.calls: list[str] = []

    def execute_with_connection(
        self,
        *_args,
        provider_code: str,
        **_kwargs,
    ) -> PaidProviderResult:
        self.calls.append(provider_code)
        if len(self.calls) == 1:
            raise self.first_failure
        return PaidProviderResult(
            result={"text": "ok"},
            usage=ProviderUsage(input_tokens=1, output_tokens=1),
        )


def _candidate_credential(code: str, key_id: int) -> AcquiredApiCredential:
    return AcquiredApiCredential(
        provider_id=key_id,
        provider_code=code,
        key_id=key_id,
        lease_id=f"lease-{key_id}",
        connection=ApiPoolConnection(
            base_url=f"https://{code}.example/v1",
            api_key=f"secret-{key_id}",
            adapter="openai-compatible",
        ),
    )


def test_unbilled_provider_rejection_fails_over_without_exposing_credentials(
    client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_http = FailoverHttpProvider(
        PaidProviderFailure(
            "PAID_CAPABILITY_PROVIDER_REJECTED",
            "first provider rejected before work",
            False,
            upstream_status=401,
        )
    )
    releases: list[tuple[str, PaidProviderFailure | None]] = []
    monkeypatch.setattr(
        provider_module,
        "dispatch_provider_codes",
        lambda *_a, **_k: ("primary", "secondary"),
    )
    monkeypatch.setattr(
        provider_module,
        "acquire_api_credential",
        lambda *_a, provider_code, **_k: _candidate_credential(
            provider_code,
            1 if provider_code == "primary" else 2,
        ),
    )
    monkeypatch.setattr(
        provider_module,
        "release_api_credential",
        lambda _factory, item, failure=None: releases.append((item.provider_code, failure)),
    )
    pooled = PooledPaidCapabilityProvider(
        client.app.state.settings,
        client.app.state.session_factory,
        http_provider=fake_http,
    )
    result = pooled.execute(
        get_paid_capability("text.product-description", 1),
        {"systemPrompt": "facts", "userPrompt": "item"},
        provider_code="primary",
        provider_model="gpt-5.6-sol",
    )

    assert result.result == {"text": "ok"}
    assert result.provider_code == "secondary"
    assert fake_http.calls == ["primary", "secondary"]
    assert releases[0][0] == "primary" and releases[0][1] is not None
    assert releases[1] == ("secondary", None)
    assert "secret-" not in repr(result)


def test_unknown_provider_outcome_is_never_retried_on_another_address(
    client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_http = FailoverHttpProvider(
        PaidProviderFailure(
            "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN",
            "outcome unknown",
            None,
            upstream_status=429,
        )
    )
    monkeypatch.setattr(
        provider_module,
        "dispatch_provider_codes",
        lambda *_a, **_k: ("primary", "secondary"),
    )
    monkeypatch.setattr(
        provider_module,
        "acquire_api_credential",
        lambda *_a, provider_code, **_k: _candidate_credential(
            provider_code,
            1 if provider_code == "primary" else 2,
        ),
    )
    monkeypatch.setattr(provider_module, "release_api_credential", lambda *_a, **_k: None)
    pooled = PooledPaidCapabilityProvider(
        client.app.state.settings,
        client.app.state.session_factory,
        http_provider=fake_http,
    )
    with pytest.raises(PaidProviderFailure) as error:
        pooled.execute(
            get_paid_capability("text.product-description", 1),
            {"systemPrompt": "facts", "userPrompt": "item"},
            provider_code="primary",
            provider_model="gpt-5.6-sol",
        )
    assert error.value.provider_code == "primary"
    assert fake_http.calls == ["primary"]

from __future__ import annotations

import time
from dataclasses import replace

from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.paid_capabilities.api_pool_routing import dispatch_provider_codes
from app.paid_capabilities.api_pool_service import (
    ApiPoolDispatchError,
    acquire_api_credential,
    release_api_credential,
)
from app.paid_capabilities.providers import (
    HttpPaidCapabilityProvider,
    PaidProviderFailure,
    PaidProviderResult,
    read_provider_cost_snapshot,
)
from app.paid_capabilities.registry import PaidCapabilityDescriptor
from app.paid_capabilities.usage_meter import (
    ProviderCostSnapshot,
    ProviderUsageMeterError,
    measured_provider_cost_micros,
)


class PooledPaidCapabilityProvider:
    def __init__(
        self,
        settings: Settings,
        session_factory: sessionmaker[Session],
        *,
        http_provider: HttpPaidCapabilityProvider | None = None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.http_provider = http_provider or HttpPaidCapabilityProvider(settings)

    def _text_cost_snapshot(self, connection) -> ProviderCostSnapshot:
        last_error: PaidProviderFailure | None = None
        for attempt in range(self.settings.paid_text_usage_poll_attempts):
            try:
                return read_provider_cost_snapshot(self.http_provider.client, connection)
            except PaidProviderFailure as exc:
                last_error = exc
                if attempt + 1 < self.settings.paid_text_usage_poll_attempts:
                    time.sleep(self.settings.paid_text_usage_poll_interval_ms / 1000)
        assert last_error is not None
        raise last_error

    def _settled_text_cost(
        self,
        connection,
        before: ProviderCostSnapshot,
    ) -> int:
        after = before
        for attempt in range(self.settings.paid_text_usage_poll_attempts):
            try:
                after = read_provider_cost_snapshot(self.http_provider.client, connection)
            except PaidProviderFailure as exc:
                if attempt + 1 >= self.settings.paid_text_usage_poll_attempts:
                    raise PaidProviderFailure(
                        "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE",
                        "Provider request succeeded but cost evidence is unavailable",
                        None,
                        status_code=503,
                    ) from exc
                time.sleep(self.settings.paid_text_usage_poll_interval_ms / 1000)
                continue
            if after.requests != before.requests:
                break
            if attempt + 1 < self.settings.paid_text_usage_poll_attempts:
                time.sleep(self.settings.paid_text_usage_poll_interval_ms / 1000)
        try:
            return measured_provider_cost_micros(
                before,
                after,
                cny_micros_per_credit=self.settings.paid_text_credit_cny_micros,
            )
        except ProviderUsageMeterError as exc:
            raise PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE",
                "Provider cost cannot be attributed to exactly one request",
                None,
                status_code=503,
            ) from exc

    def execute(
        self,
        descriptor: PaidCapabilityDescriptor,
        payload: dict[str, object],
        *,
        provider_code: str,
        provider_model: str,
    ) -> PaidProviderResult:
        with self.session_factory() as routing_db:
            provider_codes = dispatch_provider_codes(
                routing_db,
                capability_kind=descriptor.provider_kind,
                model_code=provider_model,
                fallback_provider_code=provider_code,
            )
        last_failure: PaidProviderFailure | None = None
        for candidate_code in provider_codes:
            try:
                acquired = acquire_api_credential(
                    self.session_factory,
                    self.settings,
                    provider_code=candidate_code,
                    capability_kind=descriptor.provider_kind,
                    provider_model=provider_model,
                    exclusive=(
                        descriptor.provider_kind == "text"
                        and candidate_code == "codesonline"
                    ),
                )
            except ApiPoolDispatchError as exc:
                failure = PaidProviderFailure(
                    exc.code,
                    exc.message,
                    False,
                    status_code=503,
                    provider_code=candidate_code,
                )
                if exc.code == "PAID_CAPABILITY_API_POOL_MODEL_FORBIDDEN":
                    raise failure from exc
                last_failure = failure
                continue
            if acquired is None:
                if len(provider_codes) == 1:
                    return self.http_provider.execute(
                        descriptor,
                        payload,
                        provider_code=candidate_code,
                        provider_model=provider_model,
                    )
                continue
            try:
                return self._execute_acquired(
                    descriptor,
                    payload,
                    provider_code=candidate_code,
                    provider_model=provider_model,
                    acquired=acquired,
                )
            except PaidProviderFailure as exc:
                actual_failure = (
                    exc if exc.provider_code else replace(exc, provider_code=candidate_code)
                )
                if actual_failure.billable is False and candidate_code != provider_codes[-1]:
                    last_failure = actual_failure
                    continue
                if actual_failure is exc:
                    raise
                raise actual_failure from exc
        if last_failure is not None:
            raise last_failure
        raise PaidProviderFailure(
            "PAID_CAPABILITY_API_POOL_UNAVAILABLE",
            "No managed provider is currently available",
            False,
            status_code=503,
        )

    def _execute_acquired(
        self,
        descriptor: PaidCapabilityDescriptor,
        payload: dict[str, object],
        *,
        provider_code: str,
        provider_model: str,
        acquired,
    ) -> PaidProviderResult:
        before: ProviderCostSnapshot | None = None
        try:
            if descriptor.provider_kind == "text" and provider_code == "codesonline":
                before = self._text_cost_snapshot(acquired.connection)
            result = self.http_provider.execute_with_connection(
                descriptor,
                payload,
                provider_code=provider_code,
                provider_model=provider_model,
                connection=acquired.connection,
            )
        except PaidProviderFailure as exc:
            if before is not None and exc.billable is not False:
                try:
                    actual_cost = self._settled_text_cost(acquired.connection, before)
                    exc = replace(
                        exc,
                        billable=True,
                        actual_provider_cost_micros=actual_cost,
                        provider_cost_source="provider_usage_delta",
                    )
                except PaidProviderFailure:
                    exc = PaidProviderFailure(
                        "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE",
                        "本次模型调用结果与计费状态暂时无法核对，任务已进入安全对账",
                        None,
                        usage=exc.usage,
                        provider_request_id=exc.provider_request_id,
                        status_code=503,
                        upstream_status=exc.upstream_status,
                        retry_after_seconds=exc.retry_after_seconds,
                    )
            if not exc.provider_code:
                exc = replace(exc, provider_code=provider_code)
            release_api_credential(self.session_factory, acquired, failure=exc)
            raise exc
        except Exception as exc:
            failure = PaidProviderFailure(
                "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN",
                "Provider outcome is unknown",
                None,
                status_code=503,
                provider_code=provider_code,
            )
            release_api_credential(self.session_factory, acquired, failure=failure)
            raise failure from exc
        if before is not None:
            try:
                actual_cost = self._settled_text_cost(acquired.connection, before)
                result = replace(
                    result,
                    actual_provider_cost_micros=actual_cost,
                    provider_cost_source="provider_usage_delta",
                )
            except PaidProviderFailure as exc:
                if not exc.provider_code:
                    exc = replace(exc, provider_code=provider_code)
                release_api_credential(self.session_factory, acquired, failure=exc)
                raise exc
        release_api_credential(self.session_factory, acquired)
        return replace(result, provider_code=provider_code)

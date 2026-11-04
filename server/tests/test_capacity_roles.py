from __future__ import annotations

import anyio.to_thread
from fastapi.testclient import TestClient

from app.database import build_engine
from app.main import create_app
from app.services.worker_liveness import (
    SMART_REPLY_WORKER_ALIVE_KEY,
    liveness_ttl_seconds,
    mark_smart_reply_worker_alive,
    smart_reply_worker_alive,
)
from tests.helpers import create_user, login_user


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, tuple[bytes, int | None]] = {}

    def set(self, key: str, value: bytes, ex: int | None = None) -> None:
        self.values[key] = (value, ex)

    def exists(self, key: str) -> int:
        return int(key in self.values)


def _role_client(client: TestClient, **overrides: object) -> TestClient:
    settings = client.app.state.settings.model_copy(update=overrides)
    return TestClient(create_app(settings))


def test_background_loops_run_by_default_and_can_be_disabled_per_role(client: TestClient) -> None:
    # The default (pilot / single process) keeps running the loops in-process.
    assert client.app.state.smart_reply_worker_task is not None
    assert not client.app.state.smart_reply_worker_task.done()

    with _role_client(client, background_loops_enabled=False) as api_role:
        assert api_role.app.state.smart_reply_worker_task is None
        assert api_role.get("/health").status_code == 200


def test_threadpool_size_is_configurable(client: TestClient) -> None:
    with _role_client(client, threadpool_tokens=77) as tuned:
        tokens = tuned.portal.call(
            lambda: anyio.to_thread.current_default_thread_limiter().total_tokens
        )
    assert tokens == 77


def test_worker_liveness_is_shared_through_redis() -> None:
    redis = FakeRedis()
    assert smart_reply_worker_alive(redis) is False
    mark_smart_reply_worker_alive(redis, interval_seconds=5)
    assert smart_reply_worker_alive(redis) is True
    assert redis.values[SMART_REPLY_WORKER_ALIVE_KEY][1] == liveness_ttl_seconds(5) == 30
    assert liveness_ttl_seconds(20) == 120
    # Without Redis (pilot) only the in-process task can report liveness.
    assert smart_reply_worker_alive(None) is False
    mark_smart_reply_worker_alive(None, interval_seconds=5)


def test_outbound_provider_calls_do_not_hold_a_database_connection(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    create_user(client, admin_headers)
    headers = login_user(client)
    engine = client.app.state.session_factory.kw["bind"]
    observed: dict[str, int] = {}
    monkeypatch.setattr(
        "app.api.core_v2.get_active_principal_license",
        lambda _db, _principal: object(),
    )

    def provider_call(_payload, **_kwargs):
        # Stands in for a third-party request that can take minutes.
        observed["checked_out"] = engine.pool.checkedout()
        return {
            "updates": {
                "apiAlias": "主中转",
                "baseUrl": "https://relay.example/v1",
                "availableModels": [],
                "capabilities": [],
                "discoveryVerified": False,
            }
        }

    monkeypatch.setattr("app.api.core_v2.discover_model_api", provider_call)
    response = client.post(
        "/api/core-v2/model-api/discover",
        headers=headers,
        json={"website_url": "https://relay.example/dashboard", "api_key": "secret-value"},
    )
    assert response.status_code == 200, response.text
    assert observed == {"checked_out": 0}


def test_usage_logs_are_indexed_by_creation_time_like_the_migration() -> None:
    from pathlib import Path

    from app.models.tracking import UsageLog

    indexes = {index.name: [column.name for column in index.columns] for index in
               UsageLog.__table__.indexes}
    assert indexes["ix_usage_logs_created_at"] == ["created_at"]
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "versions"
        / "b7c3e1d9a520_usage_logs_created_at_index.py"
    ).read_text(encoding="utf-8")
    assert 'INDEX_NAME = "ix_usage_logs_created_at"' in migration
    assert 'op.create_index(INDEX_NAME, "usage_logs", ["created_at"])' in migration


def test_postgres_pool_is_sized_explicitly() -> None:
    engine = build_engine(
        "postgresql+psycopg://user:pass@127.0.0.1:1/db",
        pool_size=7,
        max_overflow=3,
        pool_timeout_seconds=11,
    )
    try:
        assert engine.pool.size() == 7
        assert engine.pool._max_overflow == 3
        assert engine.pool._timeout == 11
    finally:
        engine.dispose()


def test_default_pool_matches_previous_sqlalchemy_defaults() -> None:
    engine = build_engine("postgresql+psycopg://user:pass@127.0.0.1:1/db")
    try:
        assert engine.pool.size() == 5
        assert engine.pool._max_overflow == 10
        assert engine.pool._timeout == 30
    finally:
        engine.dispose()

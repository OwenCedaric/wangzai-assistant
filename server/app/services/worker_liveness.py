"""Cross-process liveness of the background loops.

When the smart-reply/maintenance loops run in a dedicated worker service, the API
processes no longer own the asyncio task, so they read a short-lived Redis marker
that the worker refreshes after every cycle.
"""

from __future__ import annotations

from redis import Redis
from redis.exceptions import RedisError

SMART_REPLY_WORKER_ALIVE_KEY = "license-center:smart-reply-worker:alive"


def liveness_ttl_seconds(interval_seconds: int) -> int:
    # A few missed cycles are tolerated before the worker is reported as stopped.
    return max(30, interval_seconds * 6)


def mark_smart_reply_worker_alive(redis_client: Redis | None, interval_seconds: int) -> None:
    if redis_client is None:
        return
    try:
        redis_client.set(
            SMART_REPLY_WORKER_ALIVE_KEY, b"1", ex=liveness_ttl_seconds(interval_seconds)
        )
    except RedisError:
        # Liveness is diagnostic only; the worker keeps processing durable tasks.
        pass


def smart_reply_worker_alive(redis_client: Redis | None) -> bool:
    if redis_client is None:
        return False
    try:
        return bool(redis_client.exists(SMART_REPLY_WORKER_ALIVE_KEY))
    except RedisError:
        return False

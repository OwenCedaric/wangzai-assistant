from __future__ import annotations

from collections import defaultdict, deque
from threading import Lock
from time import monotonic

from redis import Redis
from redis.exceptions import RedisError


class RateLimitExceeded(Exception):
    pass


class RateLimiterUnavailable(Exception):
    pass


class InMemoryRateLimiter:
    """Small single-process limiter; replace behind this interface with Redis in production."""

    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def hit(self, key: str, *, limit: int, window_seconds: int = 60) -> None:
        now = monotonic()
        cutoff = now - window_seconds
        with self._lock:
            events = self._events[key]
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= limit:
                raise RateLimitExceeded
            events.append(now)


class RedisRateLimiter:
    def __init__(self, client: Redis) -> None:
        self.client = client

    def hit(self, key: str, *, limit: int, window_seconds: int = 60) -> None:
        redis_key = f"license-center:rate:{key}"
        try:
            count = self.client.eval(
                "local n=redis.call('INCR',KEYS[1]); "
                "if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]); end; return n",
                1,
                redis_key,
                window_seconds,
            )
        except RedisError as exc:
            # Fail closed without pretending that the caller exceeded its quota.
            raise RateLimiterUnavailable from exc
        if int(count) > limit:
            raise RateLimitExceeded

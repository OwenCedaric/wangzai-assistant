from __future__ import annotations

import threading
import time
from typing import Any


class ProtectedComputeReplayGuard:
    _REDIS_SCRIPT = """
    if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then
      return 0
    end
    redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
    redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
    return 1
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._seen: dict[str, float] = {}

    def claim(self, request_id: str, nonce: str, *, ttl_seconds: int, redis: Any = None) -> bool:
        request_key = f"protected-compute:request:{request_id}"
        nonce_key = f"protected-compute:nonce:{nonce}"
        if redis is not None:
            return bool(
                redis.eval(
                    self._REDIS_SCRIPT,
                    2,
                    request_key,
                    nonce_key,
                    max(1, ttl_seconds),
                )
            )
        now = time.monotonic()
        with self._lock:
            self._seen = {key: expiry for key, expiry in self._seen.items() if expiry > now}
            if request_key in self._seen or nonce_key in self._seen:
                return False
            expiry = now + max(1, ttl_seconds)
            self._seen[request_key] = expiry
            self._seen[nonce_key] = expiry
            return True

from __future__ import annotations

from redis import Redis
from redis.exceptions import RedisError


class RedisPresence:
    def __init__(self, client: Redis, ttl_seconds: int = 15 * 60) -> None:
        self.client = client
        self.ttl_seconds = ttl_seconds

    def touch(self, user_id: int, license_id: int) -> None:
        key = f"license-center:online:user:{user_id}:license:{license_id}"
        try:
            self.client.setex(key, self.ttl_seconds, "1")
        except RedisError:
            # Database heartbeat remains the durable fallback.
            return

    def count_users(self) -> int | None:
        try:
            user_ids = {
                key.decode("utf-8").split(":")[3]
                for key in self.client.scan_iter("license-center:online:user:*", count=500)
            }
            return len(user_ids)
        except RedisError:
            return None

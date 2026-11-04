from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from dataclasses import asdict, dataclass
from typing import Protocol

from redis import Redis
from redis.exceptions import RedisError, WatchError

from app.config import Settings
from app.services.errors import DomainError
from app.services.sms.providers import SmsProvider


@dataclass(frozen=True, slots=True)
class OtpMetadata:
    project_id: int
    channel_id: int | None


@dataclass(slots=True)
class _OtpRecord:
    digest: str
    attempts: int
    metadata: OtpMetadata


class OtpStore(Protocol):
    def issue(self, key: str, digest: str, metadata: OtpMetadata) -> None: ...
    def verify(self, key: str, digest: str) -> OtpMetadata: ...
    def cancel(self, key: str) -> None: ...


class MemoryOtpStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.Lock()
        self._records: dict[str, tuple[_OtpRecord, float]] = {}
        self._cooldowns: dict[str, float] = {}
        self._hourly: dict[tuple[str, int], int] = {}

    def issue(self, key: str, digest: str, metadata: OtpMetadata) -> None:
        now = time.time()
        hour = int(now // 3600)
        with self._lock:
            if self._cooldowns.get(key, 0) > now:
                raise DomainError("Verification code was sent too recently", status_code=429)
            hourly_key = (key, hour)
            count = self._hourly.get(hourly_key, 0) + 1
            if count > self.settings.otp_max_sends_per_hour:
                raise DomainError("Verification code send limit exceeded", status_code=429)
            self._hourly[hourly_key] = count
            self._cooldowns[key] = now + self.settings.otp_send_cooldown_seconds
            self._records[key] = (
                _OtpRecord(digest=digest, attempts=0, metadata=metadata),
                now + self.settings.otp_ttl_seconds,
            )

    def verify(self, key: str, digest: str) -> OtpMetadata:
        now = time.time()
        with self._lock:
            stored = self._records.get(key)
            if stored is None or stored[1] <= now:
                self._records.pop(key, None)
                raise DomainError("Verification code is invalid or expired", status_code=401)
            record = stored[0]
            if not hmac.compare_digest(record.digest, digest):
                record.attempts += 1
                if record.attempts >= self.settings.otp_max_attempts:
                    self._records.pop(key, None)
                raise DomainError("Verification code is invalid or expired", status_code=401)
            self._records.pop(key, None)
            return record.metadata

    def cancel(self, key: str) -> None:
        with self._lock:
            self._records.pop(key, None)
            self._cooldowns.pop(key, None)


class RedisOtpStore:
    def __init__(self, redis: Redis, settings: Settings) -> None:
        self.redis = redis
        self.settings = settings

    @staticmethod
    def _record_key(key: str) -> str:
        return f"lc:otp:record:{key}"

    @staticmethod
    def _cooldown_key(key: str) -> str:
        return f"lc:otp:cooldown:{key}"

    @staticmethod
    def _hour_key(key: str) -> str:
        return f"lc:otp:hour:{key}:{int(time.time() // 3600)}"

    def issue(self, key: str, digest: str, metadata: OtpMetadata) -> None:
        cooldown_key = self._cooldown_key(key)
        try:
            acquired = self.redis.set(
                cooldown_key,
                b"1",
                ex=self.settings.otp_send_cooldown_seconds,
                nx=True,
            )
            if not acquired:
                raise DomainError("Verification code was sent too recently", status_code=429)
            hour_key = self._hour_key(key)
            count = self.redis.incr(hour_key)
            if count == 1:
                self.redis.expire(hour_key, 3700)
            if count > self.settings.otp_max_sends_per_hour:
                raise DomainError("Verification code send limit exceeded", status_code=429)
            payload = json.dumps(
                {
                    "digest": digest,
                    "attempts": 0,
                    "metadata": asdict(metadata),
                },
                separators=(",", ":"),
            )
            self.redis.set(
                self._record_key(key), payload.encode(), ex=self.settings.otp_ttl_seconds
            )
        except DomainError:
            raise
        except RedisError as exc:
            raise DomainError(
                "Verification service is temporarily unavailable", status_code=503
            ) from exc

    def verify(self, key: str, digest: str) -> OtpMetadata:
        record_key = self._record_key(key)
        for _ in range(3):
            try:
                with self.redis.pipeline() as pipe:
                    pipe.watch(record_key)
                    raw = pipe.get(record_key)
                    if raw is None:
                        pipe.unwatch()
                        raise DomainError(
                            "Verification code is invalid or expired", status_code=401
                        )
                    data = json.loads(raw)
                    if not hmac.compare_digest(str(data["digest"]), digest):
                        attempts = int(data["attempts"]) + 1
                        pipe.multi()
                        if attempts >= self.settings.otp_max_attempts:
                            pipe.delete(record_key)
                        else:
                            data["attempts"] = attempts
                            ttl = max(1, self.redis.ttl(record_key))
                            pipe.set(record_key, json.dumps(data).encode(), ex=ttl)
                        pipe.execute()
                        raise DomainError(
                            "Verification code is invalid or expired", status_code=401
                        )
                    pipe.multi()
                    pipe.delete(record_key)
                    pipe.execute()
                    metadata = data["metadata"]
                    return OtpMetadata(
                        project_id=int(metadata["project_id"]),
                        channel_id=(
                            int(metadata["channel_id"])
                            if metadata.get("channel_id") is not None
                            else None
                        ),
                    )
            except WatchError:
                continue
            except DomainError:
                raise
            except (RedisError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                raise DomainError(
                    "Verification service is temporarily unavailable", status_code=503
                ) from exc
        raise DomainError("Verification service is busy; retry", status_code=409)

    def cancel(self, key: str) -> None:
        try:
            self.redis.delete(self._record_key(key), self._cooldown_key(key))
        except RedisError:
            pass


class OtpService:
    def __init__(self, settings: Settings, store: OtpStore, provider: SmsProvider) -> None:
        self.settings = settings
        self.store = store
        self.provider = provider

    def _key(self, phone_digest: str, project_id: int) -> str:
        return f"{project_id}:{phone_digest}"

    def _digest(self, phone_digest: str, project_id: int, code: str) -> str:
        secret = self.settings.otp_hash_secret or self.settings.jwt_secret_key
        message = f"{project_id}:{phone_digest}:{code}"
        return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()

    def send(
        self,
        phone: str,
        phone_digest: str,
        project_id: int,
        channel_id: int | None,
    ) -> str | None:
        code = (
            self.settings.sms_development_code
            if self.settings.sms_provider == "development"
            else f"{secrets.randbelow(1_000_000):06d}"
        )
        key = self._key(phone_digest, project_id)
        self.store.issue(
            key,
            self._digest(phone_digest, project_id, code),
            OtpMetadata(project_id=project_id, channel_id=channel_id),
        )
        try:
            self.provider.send_verification_code(phone, code)
        except Exception:
            self.store.cancel(key)
            raise
        if (
            self.settings.sms_provider == "development"
            and self.settings.sms_expose_development_code
        ):
            return code
        return None

    def verify(self, phone_digest: str, project_id: int, code: str) -> OtpMetadata:
        key = self._key(phone_digest, project_id)
        return self.store.verify(key, self._digest(phone_digest, project_id, code))


def build_otp_store(settings: Settings, redis: Redis | None) -> OtpStore:
    if redis is not None:
        return RedisOtpStore(redis, settings)
    if settings.app_env in {"development", "test"}:
        return MemoryOtpStore(settings)
    raise RuntimeError("Redis is required for OTP outside development/test")

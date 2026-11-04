from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from datetime import UTC, datetime
from threading import Lock
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.models.ozon_notifications import OzonNotificationEvent


def utc_now() -> datetime:
    return datetime.now(UTC)


def utc_now_rfc3339() -> str:
    return utc_now().isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_payload(payload: dict[str, Any]) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def payload_seller_id(payload: dict[str, Any]) -> str | None:
    candidates = [
        payload.get("seller_id"),
        payload.get("sellerId"),
        payload.get("client_id"),
        payload.get("clientId"),
    ]
    data = payload.get("data")
    if isinstance(data, dict):
        candidates.extend(
            [data.get("seller_id"), data.get("sellerId"), data.get("client_id")]
        )
    for value in candidates:
        text = str(value or "").strip()
        if text:
            return text[:200]
    return None


def payload_posting_number(payload: dict[str, Any]) -> str | None:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    posting = (
        payload.get("posting") if isinstance(payload.get("posting"), dict) else {}
    )
    order = payload.get("order") if isinstance(payload.get("order"), dict) else {}
    candidates = [
        payload.get("posting_number"),
        payload.get("postingNumber"),
        payload.get("order_number"),
        data.get("posting_number"),
        data.get("postingNumber"),
        posting.get("posting_number"),
        posting.get("number"),
        order.get("posting_number"),
        order.get("order_number"),
    ]
    for value in candidates:
        text = str(value or "").strip()
        if text:
            return text[:160]
    return None


def minimal_event_payload(payload: dict[str, Any]) -> dict[str, str]:
    """Keep only routing metadata; never persist the callback's order cache."""

    result = {"message_type": str(payload["message_type"]).strip()[:80]}
    seller_id = payload_seller_id(payload)
    posting_number = payload_posting_number(payload)
    if seller_id:
        result["seller_id"] = seller_id
    if posting_number:
        result["posting_number"] = posting_number
    return result


def enqueue_event(
    db: Session,
    payload: dict[str, Any],
    *,
    received_at: datetime | None = None,
) -> OzonNotificationEvent:
    canonical = canonical_payload(payload)
    digest = hashlib.sha256(canonical).hexdigest()
    stored_payload = minimal_event_payload(payload)
    existing = db.scalar(
        select(OzonNotificationEvent).where(
            OzonNotificationEvent.payload_sha256 == digest
        )
    )
    if existing is not None:
        return existing
    event = OzonNotificationEvent(
        id=f"ozon_{secrets.token_hex(16)}",
        payload_sha256=digest,
        message_type=str(payload["message_type"]).strip()[:80],
        seller_id=payload_seller_id(payload),
        payload_json=canonical_payload(stored_payload).decode("utf-8"),
        received_at=received_at or utc_now(),
        delivery_state="pending",
        delivery_attempts=0,
    )
    db.add(event)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(
            select(OzonNotificationEvent).where(
                OzonNotificationEvent.payload_sha256 == digest
            )
        )
        if existing is None:
            raise
        return existing
    db.refresh(event)
    return event


def _validate_loopback_sink_url(value: str) -> str:
    parsed = urlparse(str(value or "").strip())
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.path != "/api/internal/ozon/push-notifications"
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("OZON_NOTIFICATION_SINK_URL_INVALID")
    return parsed.geturl()


def _signature(secret: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    return f"t={timestamp},v1={digest}"


def flush_pending_events(
    session_factory: sessionmaker[Session],
    *,
    sink_url: str | None,
    sink_secret: str | None,
    timeout_seconds: float = 5.0,
    limit: int = 100,
) -> dict[str, int]:
    if not sink_url or not sink_secret:
        return {"selected": 0, "delivered": 0}
    target = _validate_loopback_sink_url(sink_url)
    with session_factory() as db:
        rows = list(
            db.scalars(
                select(OzonNotificationEvent)
                .where(OzonNotificationEvent.delivery_state == "pending")
                .order_by(OzonNotificationEvent.received_at, OzonNotificationEvent.id)
                .limit(max(1, min(int(limit), 200)))
            )
        )
        if not rows:
            return {"selected": 0, "delivered": 0}
        envelope = {
            "events": [
                {
                    "id": row.id,
                    "message_type": row.message_type,
                    "seller_id": row.seller_id,
                    "received_at": (
                        row.received_at.replace(tzinfo=UTC)
                        if row.received_at.tzinfo is None
                        else row.received_at.astimezone(UTC)
                    ).isoformat().replace("+00:00", "Z"),
                    "payload": json.loads(row.payload_json),
                }
                for row in rows
            ]
        }
        body = canonical_payload(envelope)
        timestamp = str(int(utc_now().timestamp()))
        try:
            response = httpx.post(
                target,
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Wangzai-Ozon-Push-Signature": _signature(
                        sink_secret, timestamp, body
                    ),
                },
                timeout=timeout_seconds,
            )
            response.raise_for_status()
            result = response.json()
            delivered_ids = {
                str(value)
                for value in [
                    *(result.get("accepted") or []),
                    *(result.get("deduped") or []),
                ]
            }
            now = utc_now()
            delivered = 0
            for row in rows:
                row.delivery_attempts += 1
                if row.id in delivered_ids:
                    row.delivery_state = "delivered"
                    row.delivered_at = now
                    row.last_error_code = None
                    delivered += 1
                else:
                    row.last_error_code = "DESKTOP_EVENT_NOT_ACCEPTED"
            db.commit()
            return {"selected": len(rows), "delivered": delivered}
        except Exception as exc:
            code = str(getattr(exc, "__class__", type(exc)).__name__)[:120]
            for row in rows:
                row.delivery_attempts += 1
                row.last_error_code = code
            db.commit()
            return {"selected": len(rows), "delivered": 0}


class OzonNotificationReceiver:
    """Expose only a privacy-safe receipt summary for callback diagnostics."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._received_count = 0
        self._last_message_type: str | None = None
        self._last_received_at: str | None = None
        self._last_payload_sha256: str | None = None

    def record(self, payload: dict[str, Any], *, received_at: str) -> None:
        canonical = canonical_payload(payload)
        with self._lock:
            self._received_count += 1
            self._last_message_type = str(payload["message_type"])
            self._last_received_at = received_at
            self._last_payload_sha256 = hashlib.sha256(canonical).hexdigest()

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "ok": True,
                "service": "Wangzai Ozon Notifications",
                "version": "1.1.0",
                "received_count": self._received_count,
                "last_message_type": self._last_message_type,
                "last_received_at": self._last_received_at,
                "last_payload_sha256": self._last_payload_sha256,
            }

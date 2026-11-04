from __future__ import annotations

import json
import secrets
from datetime import datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import JSONResponse

from app.services.ozon_notification_receiver import (
    OzonNotificationReceiver,
    enqueue_event,
    flush_pending_events,
    utc_now_rfc3339,
)
from app.services.smart_reply_worker import process_notification_event

router = APIRouter(prefix="/ozon/notifications", tags=["ozon-notifications"])

MAX_NOTIFICATION_BYTES = 256 * 1024
SERVICE_NAME = "Wangzai Ozon Notifications"
SERVICE_VERSION = "1.1.0"


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "details": None}},
        headers={"Cache-Control": "no-store"},
    )


def _token_matches(request: Request, callback_token: str) -> bool:
    configured = request.app.state.settings.ozon_notification_callback_token
    return bool(configured) and secrets.compare_digest(callback_token, configured)


def _receiver(request: Request) -> OzonNotificationReceiver:
    receiver = getattr(request.app.state, "ozon_notification_receiver", None)
    if receiver is None:
        receiver = OzonNotificationReceiver()
        request.app.state.ozon_notification_receiver = receiver
    return receiver


@router.get("/{callback_token}")
def callback_status(request: Request, callback_token: str) -> JSONResponse:
    if not _token_matches(request, callback_token):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    return JSONResponse(
        status_code=200,
        content=_receiver(request).status(),
        headers={"Cache-Control": "no-store"},
    )


@router.post("/{callback_token}")
async def receive_notification(
    request: Request,
    callback_token: str,
    background_tasks: BackgroundTasks,
) -> JSONResponse:
    processing_started_at = utc_now_rfc3339()
    if not _token_matches(request, callback_token):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return _error(415, "ERROR_UNKNOWN", "Content-Type must be application/json")

    body = await request.body()
    if len(body) > MAX_NOTIFICATION_BYTES:
        return _error(413, "ERROR_UNKNOWN", "Notification body is too large")
    try:
        payload: Any = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _error(400, "ERROR_UNKNOWN", "Request body must be valid JSON")
    if not isinstance(payload, dict):
        return _error(400, "ERROR_UNKNOWN", "Request body must be a JSON object")

    message_type = payload.get("message_type")
    if not isinstance(message_type, str) or not message_type.strip():
        return _error(
            400,
            "ERROR_PARAMETER_VALUE_MISSED",
            "message_type is required",
        )

    _receiver(request).record(payload, received_at=processing_started_at)
    settings = request.app.state.settings

    def flush_pending() -> None:
        flush_pending_events(
            request.app.state.session_factory,
            sink_url=settings.ozon_notification_sink_url,
            sink_secret=settings.ozon_notification_sink_secret,
        )

    if message_type == "TYPE_PING":
        background_tasks.add_task(flush_pending)
        return JSONResponse(
            status_code=200,
            content={
                "version": SERVICE_VERSION,
                "name": SERVICE_NAME,
                "time": processing_started_at,
            },
            headers={"Cache-Control": "no-store"},
        )
    received_at = datetime.fromisoformat(processing_started_at.replace("Z", "+00:00"))
    with request.app.state.session_factory() as db:
        event = enqueue_event(db, payload, received_at=received_at)
    background_tasks.add_task(
        process_notification_event,
        request.app.state.session_factory,
        settings,
        event.id,
    )
    background_tasks.add_task(flush_pending)
    return JSONResponse(
        status_code=200,
        content={"result": True},
        headers={"Cache-Control": "no-store"},
    )

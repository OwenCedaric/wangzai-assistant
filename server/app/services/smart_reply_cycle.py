from __future__ import annotations

from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.services.smart_reply_claims import recover_stale_tasks
from app.services.smart_reply_worker import drain_due_tasks, drain_notification_events


def run_smart_reply_cycle(
    session_factory: sessionmaker[Session], settings: Settings
) -> dict[str, int]:
    stale = recover_stale_tasks(session_factory)
    events = drain_notification_events(session_factory, settings)
    tasks = drain_due_tasks(session_factory, settings)
    return {"stale": sum(stale.values()), **events, "due_tasks": tasks}

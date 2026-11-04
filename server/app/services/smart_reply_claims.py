from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.models import OzonNotificationEvent
from app.models.smart_reply import SmartReplyRuleShop, SmartReplyTask

WORK_LEASE = timedelta(minutes=5)


def utc_now() -> datetime:
    return datetime.now(UTC)


def claim_notification_event(db: Session, event_id: str) -> bool:
    now = utc_now()
    claimed = db.execute(
        update(OzonNotificationEvent)
        .where(
            OzonNotificationEvent.id == event_id,
            or_(
                OzonNotificationEvent.smart_reply_state == "pending",
                (
                    (OzonNotificationEvent.smart_reply_state == "retry_wait")
                    & (OzonNotificationEvent.smart_reply_retry_at <= now)
                ),
                (
                    (OzonNotificationEvent.smart_reply_state == "processing")
                    & (OzonNotificationEvent.smart_reply_retry_at <= now)
                ),
            ),
        )
        .values(
            smart_reply_state="processing",
            smart_reply_retry_at=now + WORK_LEASE,
        )
    )
    db.commit()
    return claimed.rowcount == 1


def claim_smart_reply_task(db: Session, task_id: str) -> str:
    now = utc_now()
    claimed_send = db.execute(
        update(SmartReplyTask)
        .where(
            SmartReplyTask.id == task_id,
            SmartReplyTask.scheduled_for <= now,
            or_(
                SmartReplyTask.status == "pending",
                (
                    (SmartReplyTask.status == "retry_wait")
                    & (SmartReplyTask.retry_at <= now)
                ),
            ),
        )
        .values(
            status="processing",
            attempts=SmartReplyTask.attempts + 1,
            retry_at=now + WORK_LEASE,
        )
    )
    claim_kind = "send" if claimed_send.rowcount == 1 else ""
    if not claim_kind:
        claimed_readback = db.execute(
            update(SmartReplyTask)
            .where(
                SmartReplyTask.id == task_id,
                SmartReplyTask.status == "sent_pending_readback",
                SmartReplyTask.retry_at <= now,
            )
            .values(status="readback_processing", retry_at=now + WORK_LEASE)
        )
        if claimed_readback.rowcount == 1:
            claim_kind = "readback"
    db.commit()
    return claim_kind


def rule_targets_shop(db: Session, rule_id: str, shop_id: int) -> bool:
    return bool(
        db.scalar(
            select(SmartReplyRuleShop.id).where(
                SmartReplyRuleShop.rule_id == rule_id,
                SmartReplyRuleShop.shop_id == shop_id,
            )
        )
    )


def recover_stale_tasks(session_factory: sessionmaker[Session]) -> dict[str, int]:
    cutoff = utc_now() - WORK_LEASE
    with session_factory() as db:
        ambiguous_tasks = list(
            db.scalars(
                select(SmartReplyTask).where(
                    SmartReplyTask.status.in_({"opening_chat", "sending"}),
                    SmartReplyTask.updated_at <= cutoff,
                )
            )
        )
        for task in ambiguous_tasks:
            task.status = "manual_review"
            task.retry_at = None
            task.last_error_code = "SMART_REPLY_INTERRUPTED_DURING_WRITE"
            task.last_error_message = "发送阶段被中断，为避免重复消息，已停止自动重试。"
        safe_retry_tasks = list(
            db.scalars(
                select(SmartReplyTask).where(
                    SmartReplyTask.status == "processing",
                    SmartReplyTask.updated_at <= cutoff,
                )
            )
        )
        for task in safe_retry_tasks:
            task.status = "retry_wait"
            task.retry_at = utc_now()
            task.last_error_code = "SMART_REPLY_INTERRUPTED_BEFORE_WRITE"
            task.last_error_message = "发送前检查被中断，任务已安全恢复并等待重试。"
        readback_tasks = list(
            db.scalars(
                select(SmartReplyTask).where(
                    SmartReplyTask.status == "readback_processing",
                    SmartReplyTask.updated_at <= cutoff,
                )
            )
        )
        for task in readback_tasks:
            task.status = "sent_pending_readback"
            task.retry_at = utc_now()
            task.last_error_code = "SMART_REPLY_READBACK_INTERRUPTED"
            task.last_error_message = "消息已提交，回读检查将在下一轮继续。"
        db.commit()
        return {
            "ambiguous": len(ambiguous_tasks),
            "safe_retry": len(safe_retry_tasks),
            "readback": len(readback_tasks),
        }

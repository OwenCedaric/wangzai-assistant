from __future__ import annotations

import json
import secrets
from datetime import timedelta

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.models import License, OzonNotificationEvent, Shop
from app.models.base import as_utc
from app.models.smart_reply import (
    SmartReplyCredential,
    SmartReplyRule,
    SmartReplyRuleShop,
    SmartReplyTask,
)
from app.services.client_service import validate_license_lifecycle
from app.services.errors import DomainError
from app.services.ozon_notification_receiver import payload_seller_id
from app.services.smart_reply_claims import (
    WORK_LEASE,
    claim_notification_event,
    claim_smart_reply_task,
    rule_targets_shop,
    utc_now,
)
from app.services.smart_reply_contract import (
    SCENE_REVIEW,
    SUPPORTED_NOTIFICATION_TYPES,
    detect_trigger_scene,
    missing_template_variables,
    notification_posting_number,
    posting_variables,
    render_template,
)
from app.services.smart_reply_ozon import (
    SmartReplyOzonClient,
    SmartReplyOzonFailure,
    history_confirms_message,
)
from app.services.smart_reply_rules import decrypt_ozon_api_key

EVENT_RETRY_DELAYS = (60, 300, 1800)
TASK_RETRY_DELAYS = (60, 300, 1800)

def _event_failure(
    db: Session,
    event: OzonNotificationEvent,
    *,
    code: str,
    retryable: bool,
) -> None:
    event.smart_reply_attempts += 1
    event.smart_reply_error_code = code[:120]
    if retryable and event.smart_reply_attempts <= len(EVENT_RETRY_DELAYS):
        delay = EVENT_RETRY_DELAYS[event.smart_reply_attempts - 1]
        event.smart_reply_state = "retry_wait"
        event.smart_reply_retry_at = utc_now() + timedelta(seconds=delay)
    else:
        event.smart_reply_state = "failed"
        event.smart_reply_retry_at = None
        event.smart_reply_processed_at = utc_now()
    db.commit()


def _finish_event(db: Session, event: OzonNotificationEvent, state: str) -> None:
    event.smart_reply_state = state
    event.smart_reply_attempts += 1
    event.smart_reply_retry_at = None
    event.smart_reply_processed_at = utc_now()
    event.smart_reply_error_code = None
    db.commit()


def _active_shop_context(
    db: Session, seller_id: str
) -> tuple[Shop, License, SmartReplyCredential] | None:
    rows = db.execute(
        select(Shop, License, SmartReplyCredential)
        .join(License, Shop.license_id == License.id)
        .join(SmartReplyCredential, SmartReplyCredential.shop_id == Shop.id)
        .where(
            Shop.platform == "ozon",
            Shop.shop_id == seller_id,
            Shop.status == "active",
            SmartReplyCredential.status.in_({"active", "error"}),
        )
        .limit(2)
    ).all()
    # A callback does not carry our project id. Never choose an arbitrary
    # tenant when the same seller id is bound in more than one project.
    if len(rows) != 1:
        return None
    shop, license_record, credential = rows[0]
    try:
        validate_license_lifecycle(license_record, utc_now())
    except DomainError:
        return None
    return shop, license_record, credential


def _shop_enabled_rules(db: Session, shop_id: int) -> list[SmartReplyRule]:
    return list(
        db.scalars(
            select(SmartReplyRule)
            .join(SmartReplyRuleShop, SmartReplyRuleShop.rule_id == SmartReplyRule.id)
            .where(
                SmartReplyRuleShop.shop_id == shop_id,
                SmartReplyRule.enabled.is_(True),
            )
            .order_by(SmartReplyRule.created_at, SmartReplyRule.id)
        )
    )


def _open_ozon(
    settings: Settings,
    shop: Shop,
    credential: SmartReplyCredential,
) -> SmartReplyOzonClient:
    return SmartReplyOzonClient(
        client_id=shop.shop_id,
        api_key=decrypt_ozon_api_key(settings, credential.api_key_ciphertext),
        base_url=settings.ozon_seller_api_base_url,
        timeout_seconds=settings.ozon_seller_api_timeout_seconds,
    )


def process_notification_event(
    session_factory: sessionmaker[Session],
    settings: Settings,
    event_id: str,
) -> dict[str, int]:
    with session_factory() as db:
        if not claim_notification_event(db, event_id):
            return {"events": 0, "tasks": 0}
        event = db.get(OzonNotificationEvent, event_id)
        if event is None:
            return {"events": 0, "tasks": 0}
        if event.message_type not in SUPPORTED_NOTIFICATION_TYPES:
            _finish_event(db, event, "ignored")
            return {"events": 1, "tasks": 0}
        try:
            payload = json.loads(event.payload_json)
        except (TypeError, json.JSONDecodeError):
            _event_failure(db, event, code="SMART_REPLY_EVENT_JSON_INVALID", retryable=False)
            return {"events": 1, "tasks": 0}
        posting_number = notification_posting_number(payload)
        seller_id = event.seller_id or payload_seller_id(payload)
        if not posting_number or not seller_id:
            _finish_event(db, event, "ignored")
            return {"events": 1, "tasks": 0}
        context = _active_shop_context(db, seller_id)
        if context is None:
            _finish_event(db, event, "ignored")
            return {"events": 1, "tasks": 0}
        shop, _license_record, credential = context
        rules = _shop_enabled_rules(db, shop.id)
        if not rules:
            _finish_event(db, event, "ignored")
            return {"events": 1, "tasks": 0}
        try:
            with _open_ozon(settings, shop, credential) as ozon:
                posting, _source = ozon.read_posting(posting_number)
        except SmartReplyOzonFailure as exc:
            if exc.code == "SMART_REPLY_OZON_AUTHENTICATION_FAILED":
                credential.status = "error"
                credential.last_error_code = exc.code
            _event_failure(
                db,
                event,
                code=exc.code,
                # Keep the event recoverable while the user reconnects a
                # revoked key. The bounded retry policy still prevents loops.
                retryable=(
                    exc.retryable
                    or exc.code == "SMART_REPLY_OZON_AUTHENTICATION_FAILED"
                ),
            )
            return {"events": 1, "tasks": 0}
        except DomainError:
            credential.status = "error"
            credential.last_error_code = "SMART_REPLY_CREDENTIAL_DECRYPTION_FAILED"
            _event_failure(
                db,
                event,
                code="SMART_REPLY_CREDENTIAL_DECRYPTION_FAILED",
                retryable=False,
            )
            return {"events": 1, "tasks": 0}

        scene, trigger_status = detect_trigger_scene(posting)
        matching_rules = [rule for rule in rules if rule.scene == scene]
        created = 0
        base_time = as_utc(event.received_at) or utc_now()
        for rule in matching_rules:
            idempotency_key = f"smart-reply:{shop.id}:{posting_number}:{rule.scene}"
            if db.scalar(
                select(SmartReplyTask.id).where(
                    SmartReplyTask.idempotency_key == idempotency_key
                )
            ):
                continue
            scheduled_for = base_time + timedelta(
                hours=rule.delay_hours if rule.send_time_type == "delayed" else 0
            )
            task = SmartReplyTask(
                id=f"srt_{secrets.token_hex(16)}",
                idempotency_key=idempotency_key,
                notification_event_id=event.id,
                rule_id=rule.id,
                shop_id=shop.id,
                posting_number=posting_number,
                scene=rule.scene,
                trigger_status=trigger_status or "unknown",
                scheduled_for=scheduled_for,
                status="pending",
                template_snapshot=json.dumps(
                    {
                        "templateId": rule.template_id,
                        "messageTemplate": rule.message_template,
                        "messageTemplateZh": rule.message_template_zh,
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
            )
            db.add(task)
            created += 1
        try:
            event.smart_reply_state = "processed"
            event.smart_reply_attempts += 1
            event.smart_reply_processed_at = utc_now()
            event.smart_reply_retry_at = None
            event.smart_reply_error_code = None
            db.commit()
        except IntegrityError:
            db.rollback()
            event = db.get(OzonNotificationEvent, event_id)
            if event:
                _finish_event(db, event, "processed")
        return {"events": 1, "tasks": created}


def drain_notification_events(
    session_factory: sessionmaker[Session],
    settings: Settings,
    *,
    limit: int = 20,
) -> dict[str, int]:
    now = utc_now()
    with session_factory() as db:
        event_ids = list(
            db.scalars(
                select(OzonNotificationEvent.id)
                .where(
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
                    )
                )
                .order_by(OzonNotificationEvent.received_at, OzonNotificationEvent.id)
                .limit(max(1, min(limit, 100)))
            )
        )
    summary = {"events": 0, "tasks": 0}
    for event_id in event_ids:
        result = process_notification_event(session_factory, settings, event_id)
        summary["events"] += result["events"]
        summary["tasks"] += result["tasks"]
    return summary


def _task_context(db: Session, task_id: str):
    return db.execute(
        select(
            SmartReplyTask,
            SmartReplyRule,
            Shop,
            License,
            SmartReplyCredential,
        )
        .join(SmartReplyRule, SmartReplyTask.rule_id == SmartReplyRule.id)
        .join(Shop, SmartReplyTask.shop_id == Shop.id)
        .join(License, Shop.license_id == License.id)
        .join(SmartReplyCredential, SmartReplyCredential.shop_id == Shop.id)
        .where(SmartReplyTask.id == task_id)
    ).one_or_none()


def _fail_task(
    session_factory: sessionmaker[Session],
    task_id: str,
    exc: SmartReplyOzonFailure | DomainError,
) -> None:
    with session_factory() as db:
        task = db.get(SmartReplyTask, task_id)
        if task is None:
            return
        code = getattr(exc, "code", None) or "SMART_REPLY_EXECUTION_FAILED"
        message = getattr(exc, "message", None) or str(exc)
        task.last_error_code = str(code)[:120]
        task.last_error_message = str(message)[:2000]
        if code == "SMART_REPLY_OZON_AUTHENTICATION_FAILED":
            credential = db.scalar(
                select(SmartReplyCredential).where(
                    SmartReplyCredential.shop_id == task.shop_id
                )
            )
            if credential is not None:
                credential.status = "error"
                credential.last_error_code = str(code)[:120]
        if getattr(exc, "ambiguous_write", False):
            task.status = "manual_review"
            task.retry_at = None
        elif getattr(exc, "retryable", False) and task.attempts <= len(TASK_RETRY_DELAYS):
            delay = TASK_RETRY_DELAYS[max(0, task.attempts - 1)]
            task.status = "retry_wait"
            task.retry_at = utc_now() + timedelta(seconds=delay)
        else:
            task.status = "failed"
            task.retry_at = None
        db.commit()


def _confirm_readback(
    session_factory: sessionmaker[Session],
    settings: Settings,
    task_id: str,
) -> None:
    with session_factory() as db:
        context = _task_context(db, task_id)
        if context is None:
            return
        task, _rule, shop, _license_record, credential = context
        if not task.chat_id or not task.rendered_message:
            task.status = "manual_review"
            task.last_error_code = "SMART_REPLY_READBACK_CONTEXT_MISSING"
            db.commit()
            return
        task.attempts += 1
        db.commit()
        try:
            with _open_ozon(settings, shop, credential) as ozon:
                messages = ozon.history(task.chat_id)
            confirmed, message_id = history_confirms_message(
                messages,
                message_id=task.ozon_message_id,
                text=task.rendered_message,
            )
        except (SmartReplyOzonFailure, DomainError) as exc:
            task = db.get(SmartReplyTask, task_id)
            task.last_error_code = getattr(exc, "code", "SMART_REPLY_READBACK_FAILED")
            task.last_error_message = str(getattr(exc, "message", exc))[:2000]
            task.status = "sent_pending_readback" if task.attempts < 3 else "sent_unconfirmed"
            task.retry_at = utc_now() + timedelta(minutes=5) if task.attempts < 3 else None
            if task.attempts >= 3:
                task.rendered_message = None
            db.commit()
            return
        task = db.get(SmartReplyTask, task_id)
        if confirmed:
            task.status = "sent"
            task.ozon_message_id = message_id
            task.sent_at = utc_now()
            task.rendered_message = None
            task.retry_at = None
            task.last_error_code = None
            task.last_error_message = None
        else:
            task.status = "sent_pending_readback" if task.attempts < 3 else "sent_unconfirmed"
            task.retry_at = utc_now() + timedelta(minutes=5) if task.attempts < 3 else None
            if task.attempts >= 3:
                task.rendered_message = None
            task.last_error_code = "SMART_REPLY_READBACK_NOT_FOUND"
            task.last_error_message = "Ozon 尚未在聊天记录中返回这条消息。"
        db.commit()


def execute_task(
    session_factory: sessionmaker[Session],
    settings: Settings,
    task_id: str,
) -> None:
    with session_factory() as db:
        claim_kind = claim_smart_reply_task(db, task_id)
        if not claim_kind:
            return
        if claim_kind == "readback":
            confirm_only = True
        else:
            confirm_only = False
        context = _task_context(db, task_id)
        if context is None:
            return
        task, rule, shop, license_record, credential = context
        if not confirm_only:
            if not rule_targets_shop(db, rule.id, task.shop_id):
                task.status = "cancelled"
                task.retry_at = None
                task.last_error_code = "SMART_REPLY_SHOP_REMOVED_FROM_RULE"
                task.last_error_message = "店铺已移出这条规则，任务没有发送。"
                db.commit()
                return
            if not rule.enabled:
                task.status = "cancelled"
                task.last_error_code = "SMART_REPLY_RULE_DISABLED"
                task.last_error_message = "用户已关闭该规则，任务没有发送。"
                db.commit()
                return
            try:
                validate_license_lifecycle(license_record, utc_now())
            except DomainError as exc:
                task.status = "cancelled"
                task.last_error_code = "SMART_REPLY_LICENSE_INACTIVE"
                task.last_error_message = str(exc)
                db.commit()
                return
            task.retry_at = utc_now() + WORK_LEASE
            db.commit()
    if confirm_only:
        _confirm_readback(session_factory, settings, task_id)
        return

    try:
        with session_factory() as db:
            context = _task_context(db, task_id)
            task, _rule, shop, shop_license, credential = context
            try:
                validate_license_lifecycle(shop_license, utc_now())
            except DomainError as exc:
                task.status = "cancelled"
                task.retry_at = None
                task.last_error_code = "SMART_REPLY_LICENSE_INACTIVE"
                task.last_error_message = str(exc)
                db.commit()
                return
            snapshot = json.loads(task.template_snapshot)
            with _open_ozon(settings, shop, credential) as ozon:
                posting, _source = ozon.read_posting(task.posting_number)
                current_scene, _status = detect_trigger_scene(posting)
                if current_scene != task.scene:
                    task.status = "skipped"
                    task.last_error_code = "SMART_REPLY_TRIGGER_NO_LONGER_MATCHES"
                    task.last_error_message = "发送前复核发现订单状态已经变化，任务已跳过。"
                    db.commit()
                    return
                if task.scene == SCENE_REVIEW and ozon.has_return_or_refund(
                    task.posting_number
                ):
                    task.status = "skipped"
                    task.retry_at = None
                    task.last_error_code = "SMART_REPLY_RETURN_OR_REFUND_EXISTS"
                    task.last_error_message = "订单已有退货或退款记录，没有发送索评消息。"
                    db.commit()
                    return
                template = snapshot.get("messageTemplate", "")
                variables = posting_variables(posting, task.posting_number)
                missing_variables = missing_template_variables(template, variables)
                if missing_variables:
                    raise SmartReplyOzonFailure(
                        "SMART_REPLY_ORDER_VARIABLES_NOT_READY",
                        f"订单数据尚未返回这些模板变量：{', '.join(missing_variables)}。",
                        retryable=True,
                    )
                message = render_template(template, variables)
                if not message or len(message) > 1000:
                    raise SmartReplyOzonFailure(
                        "SMART_REPLY_RENDERED_MESSAGE_INVALID",
                        "模板替换后的消息为空或超过 Ozon 长度限制。",
                        status_code=422,
                    )
                rule_still_enabled = db.scalar(
                    select(SmartReplyRule.enabled).where(SmartReplyRule.id == task.rule_id)
                )
                if not rule_still_enabled or not rule_targets_shop(
                    db, task.rule_id, task.shop_id
                ):
                    task.status = "cancelled"
                    task.retry_at = None
                    task.last_error_code = "SMART_REPLY_RULE_DISABLED"
                    task.last_error_message = "发送前检查发现规则已关闭，任务没有发送。"
                    db.commit()
                    return
                try:
                    validate_license_lifecycle(shop_license, utc_now())
                except DomainError as exc:
                    task.status = "cancelled"
                    task.retry_at = None
                    task.last_error_code = "SMART_REPLY_LICENSE_INACTIVE"
                    task.last_error_message = str(exc)
                    db.commit()
                    return
                task.rendered_message = message
                task.status = "opening_chat"
                db.commit()
                chat_id = ozon.start_chat(task.posting_number)
                task = db.get(SmartReplyTask, task_id)
                rule_still_enabled = db.scalar(
                    select(SmartReplyRule.enabled).where(SmartReplyRule.id == task.rule_id)
                )
                if not rule_still_enabled or not rule_targets_shop(
                    db, task.rule_id, task.shop_id
                ):
                    task.status = "cancelled"
                    task.retry_at = None
                    task.chat_id = chat_id
                    task.last_error_code = "SMART_REPLY_RULE_DISABLED"
                    task.last_error_message = "打开会话后规则已关闭，消息没有发送。"
                    db.commit()
                    return
                try:
                    validate_license_lifecycle(shop_license, utc_now())
                except DomainError as exc:
                    task.status = "cancelled"
                    task.retry_at = None
                    task.chat_id = chat_id
                    task.last_error_code = "SMART_REPLY_LICENSE_INACTIVE"
                    task.last_error_message = str(exc)
                    db.commit()
                    return
                task.chat_id = chat_id
                task.status = "sending"
                db.commit()
                message_id = ozon.send_message(chat_id, message)
                task = db.get(SmartReplyTask, task_id)
                task.ozon_message_id = message_id
                task.send_submitted_at = utc_now()
                task.status = "sent_pending_readback"
                task.retry_at = utc_now() + timedelta(minutes=1)
                db.commit()
    except (SmartReplyOzonFailure, DomainError) as exc:
        _fail_task(session_factory, task_id, exc)
        return
    _confirm_readback(session_factory, settings, task_id)


def drain_due_tasks(
    session_factory: sessionmaker[Session],
    settings: Settings,
    *,
    limit: int = 20,
) -> int:
    now = utc_now()
    with session_factory() as db:
        task_ids = list(
            db.scalars(
                select(SmartReplyTask.id)
                .where(
                    SmartReplyTask.scheduled_for <= now,
                    or_(
                        SmartReplyTask.status == "pending",
                        (
                            (SmartReplyTask.status == "retry_wait")
                            & (SmartReplyTask.retry_at <= now)
                        ),
                        (
                            (SmartReplyTask.status == "sent_pending_readback")
                            & (SmartReplyTask.retry_at <= now)
                        ),
                    ),
                )
                .order_by(SmartReplyTask.scheduled_for, SmartReplyTask.id)
                .limit(max(1, min(limit, 100)))
            )
        )
    for task_id in task_ids:
        execute_task(session_factory, settings, task_id)
    return len(task_ids)

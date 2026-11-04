from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.dependencies import CurrentPrincipal, get_current_user, get_principal
from app.database.session import get_db
from app.models import Shop, User
from app.models.smart_reply import SmartReplyCredential, SmartReplyRule, SmartReplyTask
from app.schemas.smart_reply import (
    SmartReplyCredentialRead,
    SmartReplyCredentialUpsert,
    SmartReplyRuleEnabledUpdate,
    SmartReplyRuleRead,
    SmartReplyRuleUpsert,
    SmartReplyRuntimeStatus,
    SmartReplyTaskList,
)
from app.services.client_service import get_active_principal_license
from app.services.smart_reply_rules import (
    active_account_shop_ids,
    configure_credential,
    credential_rows,
    list_rules,
    list_tasks,
    save_rule,
    set_rule_enabled,
)
from app.services.worker_liveness import smart_reply_worker_alive

router = APIRouter(prefix="/smart-reply", tags=["smart-reply"])


def _license(db: Session, principal: CurrentPrincipal):
    return get_active_principal_license(db, principal)


@router.get("/status", response_model=SmartReplyRuntimeStatus)
def runtime_status(
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    license_record = _license(db, principal)
    shop_ids = active_account_shop_ids(db, license_record)
    worker_task = getattr(request.app.state, "smart_reply_worker_task", None)
    local_worker_running = worker_task is not None and not worker_task.done()
    return {
        "ok": True,
        "mode": "server",
        # The loop may run in a dedicated worker service; it then reports via Redis.
        "worker_running": bool(
            local_worker_running
            or smart_reply_worker_alive(getattr(request.app.state, "redis", None))
        ),
        "callback_configured": bool(
            request.app.state.settings.ozon_notification_callback_token
        ),
        "configured_shop_count": db.scalar(
            select(func.count(SmartReplyCredential.id)).where(
                SmartReplyCredential.shop_id.in_(shop_ids or [-1]),
                SmartReplyCredential.status == "active",
            )
        )
        or 0,
        "enabled_rule_count": db.scalar(
            select(func.count(SmartReplyRule.id)).where(
                SmartReplyRule.user_id == license_record.user_id,
                SmartReplyRule.project_id == license_record.plan.product.project_id,
                SmartReplyRule.enabled.is_(True),
            )
        )
        or 0,
        "pending_task_count": db.scalar(
            select(func.count(SmartReplyTask.id)).where(
                SmartReplyTask.shop_id.in_(shop_ids or [-1]),
                SmartReplyTask.status.in_(
                    {
                        "pending",
                        "retry_wait",
                        "processing",
                        "sent_pending_readback",
                        "readback_processing",
                    }
                ),
            )
        )
        or 0,
    }


@router.get("/credentials", response_model=list[SmartReplyCredentialRead])
def list_credentials(
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return credential_rows(db, _license(db, principal))


@router.post("/credentials", response_model=SmartReplyCredentialRead)
def upsert_credential(
    payload: SmartReplyCredentialUpsert,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    license_record = _license(db, principal)
    configure_credential(
        db,
        request.app.state.settings,
        license_record,
        client_id=payload.client_id,
        api_key=payload.api_key.get_secret_value(),
    )
    return next(
        row for row in credential_rows(db, license_record) if row["client_id"] == payload.client_id
    )


@router.get("/rules", response_model=list[SmartReplyRuleRead])
def get_rules(
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return list_rules(db, _license(db, principal))


@router.post("/rules", response_model=SmartReplyRuleRead)
def upsert_rule(
    payload: SmartReplyRuleUpsert,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return save_rule(db, request.app.state.settings, _license(db, principal), payload)


@router.post("/rules/{rule_id}/enabled", response_model=SmartReplyRuleRead)
def update_rule_enabled(
    rule_id: str,
    payload: SmartReplyRuleEnabledUpdate,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return set_rule_enabled(
        db,
        request.app.state.settings,
        _license(db, principal),
        rule_id,
        payload.enabled,
    )


@router.get("/tasks", response_model=SmartReplyTaskList)
def get_tasks(
    limit: int = Query(default=100, ge=1, le=200),
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return list_tasks(db, _license(db, principal), limit=limit)


@router.post("/tasks/{task_id}/retry")
def retry_task(
    task_id: str,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    license_record = _license(db, principal)
    row = db.execute(
        select(SmartReplyTask, Shop)
        .join(Shop, SmartReplyTask.shop_id == Shop.id)
        .where(
            SmartReplyTask.id == task_id,
            Shop.user_id == license_record.user_id,
            Shop.project_id == license_record.plan.product.project_id,
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="没有找到这条发送任务。")
    task, shop = row
    if shop.id not in active_account_shop_ids(db, license_record):
        raise HTTPException(
            status_code=403,
            detail="当前店铺的软件授权无效或已到期，不能重试。",
        )
    credential_status = db.scalar(
        select(SmartReplyCredential.status).where(
            SmartReplyCredential.shop_id == shop.id
        )
    )
    if credential_status != "active":
        raise HTTPException(
            status_code=409,
            detail="请先重新接入当前店铺，再重试发送任务。",
        )
    if task.status != "failed" or task.send_submitted_at is not None:
        raise HTTPException(
            status_code=409,
            detail="只有尚未向 Ozon 提交消息的失败任务才能重试。",
        )
    task.status = "pending"
    task.attempts = 0
    task.scheduled_for = datetime.now(UTC)
    task.retry_at = None
    task.last_error_code = None
    task.last_error_message = None
    db.commit()
    return {"ok": True, "task_id": task.id, "status": task.status}

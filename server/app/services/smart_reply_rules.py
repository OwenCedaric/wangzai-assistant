from __future__ import annotations

import hashlib
import hmac
import secrets
from collections.abc import Callable
from datetime import UTC, datetime

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from app.config import Settings
from app.models import License, Shop
from app.models.smart_reply import (
    SmartReplyCredential,
    SmartReplyRule,
    SmartReplyRuleShop,
    SmartReplyTask,
)
from app.schemas.smart_reply import SmartReplyRuleUpsert
from app.services.client_service import validate_license_lifecycle
from app.services.errors import DomainError
from app.services.smart_reply_ozon import SmartReplyOzonClient, SmartReplyOzonFailure


def _cipher(settings: Settings) -> Fernet:
    if not settings.identity_encryption_key:
        raise DomainError("智能回复凭证加密尚未配置。", status_code=503)
    try:
        return Fernet(settings.identity_encryption_key.encode("ascii"))
    except (TypeError, ValueError) as exc:
        raise DomainError("智能回复凭证加密配置无效。", status_code=503) from exc


def encrypt_ozon_api_key(settings: Settings, api_key: str) -> str:
    return _cipher(settings).encrypt(api_key.strip().encode("utf-8")).decode("ascii")


def decrypt_ozon_api_key(settings: Settings, ciphertext: str) -> str:
    try:
        return _cipher(settings).decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError, ValueError, TypeError) as exc:
        raise DomainError(
            "已保存的 Ozon API Key 无法解密，请重新接入店铺。",
            status_code=503,
        ) from exc


def _fingerprint(settings: Settings, value: str) -> str:
    secret = (settings.identity_hash_secret or settings.jwt_secret_key).encode("utf-8")
    return "sha256:" + hmac.new(secret, value.encode("utf-8"), hashlib.sha256).hexdigest()


def resolve_license_shops(
    db: Session,
    license_record: License,
    client_ids: list[str],
) -> list[Shop]:
    rows = _active_account_shop_rows(db, license_record, client_ids=client_ids)
    by_client_id = {row.shop_id: row for row in rows}
    if any(client_id not in by_client_id for client_id in client_ids):
        raise DomainError(
            "所选 Ozon 店铺没有有效授权、授权已到期或不属于当前账号。",
            status_code=403,
        )
    return [by_client_id[client_id] for client_id in client_ids]


def _active_account_shop_rows(
    db: Session,
    license_record: License,
    *,
    client_ids: list[str] | None = None,
) -> list[Shop]:
    """Return every currently entitled Ozon shop owned by this account/project.

    A desktop session is authenticated by one active license token, while each
    Ozon shop can have its own independent shop card.  Treating the session
    license as the shop license incorrectly hides every other valid shop on the
    same account.  The selected shop's own license lifecycle is authoritative.
    """

    query = (
        select(Shop, License)
        .join(License, Shop.license_id == License.id)
        .where(
            Shop.user_id == license_record.user_id,
            Shop.project_id == license_record.plan.product.project_id,
            Shop.platform == "ozon",
            Shop.status == "active",
        )
        .order_by(Shop.id)
    )
    if client_ids is not None:
        query = query.where(Shop.shop_id.in_(client_ids or ["__none__"]))
    now = datetime.now(UTC)
    rows: list[Shop] = []
    for shop, shop_license in db.execute(query).all():
        try:
            validate_license_lifecycle(shop_license, now)
        except DomainError:
            continue
        rows.append(shop)
    return rows


def active_account_shop_ids(db: Session, license_record: License) -> list[int]:
    return [shop.id for shop in _active_account_shop_rows(db, license_record)]


def configure_credential(
    db: Session,
    settings: Settings,
    license_record: License,
    *,
    client_id: str,
    api_key: str,
    client_factory: Callable[..., SmartReplyOzonClient] | None = None,
) -> SmartReplyCredential:
    shop = resolve_license_shops(db, license_record, [client_id])[0]
    normalized_key = api_key.strip()
    try:
        with (client_factory or SmartReplyOzonClient)(
            client_id=client_id,
            api_key=normalized_key,
            base_url=settings.ozon_seller_api_base_url,
            timeout_seconds=settings.ozon_seller_api_timeout_seconds,
        ) as ozon:
            ozon.verify()
    except SmartReplyOzonFailure as exc:
        raise DomainError(exc.message, status_code=exc.status_code) from exc
    credential = db.scalar(
        select(SmartReplyCredential).where(SmartReplyCredential.shop_id == shop.id)
    )
    if credential is None:
        credential = SmartReplyCredential(
            shop_id=shop.id,
            api_key_ciphertext="",
            api_key_fingerprint="",
        )
        db.add(credential)
    credential.api_key_ciphertext = encrypt_ozon_api_key(settings, normalized_key)
    credential.api_key_fingerprint = _fingerprint(settings, normalized_key)
    credential.status = "active"
    credential.last_verified_at = datetime.now(UTC)
    credential.last_error_code = None
    db.commit()
    db.refresh(credential)
    return credential


def credential_rows(db: Session, license_record: License) -> list[dict]:
    shops = _active_account_shop_rows(db, license_record)
    credentials = {
        row.shop_id: row
        for row in db.scalars(
            select(SmartReplyCredential).where(
                SmartReplyCredential.shop_id.in_([shop.id for shop in shops] or [-1])
            )
        )
    }
    return [
        {
            "client_id": shop.shop_id,
            "shop_name": shop.shop_name,
            "configured": (
                shop.id in credentials and credentials[shop.id].status == "active"
            ),
            "status": credentials[shop.id].status if shop.id in credentials else "unconfigured",
            "last_verified_at": (
                credentials[shop.id].last_verified_at if shop.id in credentials else None
            ),
        }
        for shop in shops
    ]


def _rule_row(rule: SmartReplyRule) -> dict:
    return {
        "rule_id": rule.id,
        "scene": rule.scene,
        "shop_client_ids": [link.shop.shop_id for link in rule.shops],
        "send_time_type": rule.send_time_type,
        "delay_hours": rule.delay_hours,
        "content_generate_type": rule.content_generate_type,
        "template_id": rule.template_id,
        "message_template": rule.message_template,
        "message_template_zh": rule.message_template_zh,
        "enabled": rule.enabled,
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
    }


def _cancel_unsent_tasks(
    db: Session,
    rule_id: str,
    *,
    keep_shop_ids: set[int] | None = None,
) -> None:
    conditions = [
        SmartReplyTask.rule_id == rule_id,
        SmartReplyTask.status.in_({"pending", "retry_wait"}),
        SmartReplyTask.send_submitted_at.is_(None),
    ]
    if keep_shop_ids is not None:
        conditions.append(SmartReplyTask.shop_id.not_in(keep_shop_ids))
    db.execute(
        update(SmartReplyTask)
        .where(*conditions)
        .values(
            status="cancelled",
            retry_at=None,
            last_error_code="SMART_REPLY_RULE_DISABLED_OR_SHOP_REMOVED",
            last_error_message="规则已关闭或店铺已移出规则，任务没有发送。",
        )
    )


def list_rules(db: Session, license_record: License) -> list[dict]:
    rules = list(
        db.scalars(
            select(SmartReplyRule)
            .where(
                SmartReplyRule.user_id == license_record.user_id,
                SmartReplyRule.project_id == license_record.plan.product.project_id,
            )
            .options(
                selectinload(SmartReplyRule.shops).selectinload(SmartReplyRuleShop.shop)
            )
            .order_by(SmartReplyRule.created_at, SmartReplyRule.id)
        )
    )
    return [_rule_row(rule) for rule in rules]


def _assert_enabled_ready(
    db: Session,
    settings: Settings,
    *,
    rule_id: str,
    scene: str,
    shops: list[Shop],
) -> None:
    if not settings.ozon_notification_callback_token:
        raise DomainError(
            "请先在 Ozon 卖家后台开启消息推送，再开启自动发送。",
            status_code=409,
        )
    credential_shop_ids = set(
        db.scalars(
            select(SmartReplyCredential.shop_id).where(
                SmartReplyCredential.shop_id.in_([shop.id for shop in shops]),
                SmartReplyCredential.status == "active",
            )
        )
    )
    missing = [shop.shop_name for shop in shops if shop.id not in credential_shop_ids]
    if missing:
        raise DomainError(
            f"请先接入这些店铺的 Ozon API Key：{', '.join(missing)}",
            status_code=409,
        )
    conflict = db.scalar(
        select(SmartReplyRule.id)
        .join(SmartReplyRuleShop, SmartReplyRuleShop.rule_id == SmartReplyRule.id)
        .where(
            SmartReplyRule.enabled.is_(True),
            SmartReplyRule.scene == scene,
            SmartReplyRule.id != rule_id,
            SmartReplyRuleShop.shop_id.in_([shop.id for shop in shops]),
        )
        .limit(1)
    )
    if conflict:
        raise DomainError(
            "所选店铺已经开启了同场景规则，请先关闭原规则。",
            status_code=409,
        )


def save_rule(
    db: Session,
    settings: Settings,
    license_record: License,
    payload: SmartReplyRuleUpsert,
) -> dict:
    shops = resolve_license_shops(db, license_record, payload.shop_client_ids)
    rule = None
    if payload.rule_id:
        rule = db.scalar(
            select(SmartReplyRule)
            .where(
                SmartReplyRule.id == payload.rule_id,
                SmartReplyRule.user_id == license_record.user_id,
                SmartReplyRule.project_id == license_record.plan.product.project_id,
            )
            .options(selectinload(SmartReplyRule.shops))
        )
        if rule is None:
            raise DomainError("没有找到这条智能回复规则。", status_code=404)
    if rule is None:
        rule = SmartReplyRule(
            id=f"srr_{secrets.token_hex(16)}",
            user_id=license_record.user_id,
            license_id=license_record.id,
            project_id=license_record.plan.product.project_id,
            scene=payload.scene,
            template_id=payload.template_id,
            message_template=payload.message_template,
        )
        db.add(rule)
        db.flush()
    if payload.enabled:
        _assert_enabled_ready(
            db,
            settings,
            rule_id=rule.id,
            scene=payload.scene,
            shops=shops,
        )
    rule.scene = payload.scene
    rule.send_time_type = payload.send_time_type
    rule.delay_hours = payload.delay_hours
    rule.content_generate_type = payload.content_generate_type
    rule.template_id = payload.template_id
    rule.message_template = payload.message_template.strip()
    rule.message_template_zh = payload.message_template_zh.strip()
    rule.enabled = payload.enabled
    rule.shops.clear()
    rule.shops.extend(SmartReplyRuleShop(shop_id=shop.id) for shop in shops)
    if payload.enabled:
        _cancel_unsent_tasks(db, rule.id, keep_shop_ids={shop.id for shop in shops})
    else:
        _cancel_unsent_tasks(db, rule.id)
    db.commit()
    rule = db.scalar(
        select(SmartReplyRule)
        .where(SmartReplyRule.id == rule.id)
        .options(selectinload(SmartReplyRule.shops).selectinload(SmartReplyRuleShop.shop))
    )
    return _rule_row(rule)


def set_rule_enabled(
    db: Session,
    settings: Settings,
    license_record: License,
    rule_id: str,
    enabled: bool,
) -> dict:
    rule = db.scalar(
        select(SmartReplyRule)
        .where(
            SmartReplyRule.id == rule_id,
            SmartReplyRule.user_id == license_record.user_id,
            SmartReplyRule.project_id == license_record.plan.product.project_id,
        )
        .options(
            selectinload(SmartReplyRule.shops).selectinload(SmartReplyRuleShop.shop)
        )
    )
    if rule is None:
        raise DomainError("没有找到这条智能回复规则。", status_code=404)
    if enabled:
        entitled_shops = resolve_license_shops(
            db,
            license_record,
            [link.shop.shop_id for link in rule.shops],
        )
        _assert_enabled_ready(
            db,
            settings,
            rule_id=rule.id,
            scene=rule.scene,
            shops=entitled_shops,
        )
    rule.enabled = enabled
    if not enabled:
        _cancel_unsent_tasks(db, rule.id)
    db.commit()
    db.refresh(rule)
    return _rule_row(rule)


def list_tasks(
    db: Session,
    license_record: License,
    *,
    limit: int = 100,
) -> dict:
    conditions = (
        SmartReplyTask.shop_id == Shop.id,
        Shop.user_id == license_record.user_id,
        Shop.project_id == license_record.plan.product.project_id,
    )
    total = (
        db.scalar(
            select(func.count(SmartReplyTask.id))
            .join(Shop, SmartReplyTask.shop_id == Shop.id)
            .where(*conditions[1:])
        )
        or 0
    )
    rows = db.execute(
        select(SmartReplyTask, Shop)
        .join(Shop, SmartReplyTask.shop_id == Shop.id)
        .where(*conditions[1:])
        .order_by(SmartReplyTask.created_at.desc())
        .limit(max(1, min(limit, 200)))
    ).all()
    return {
        "items": [
            {
                "task_id": task.id,
                "rule_id": task.rule_id,
                "client_id": shop.shop_id,
                "shop_name": shop.shop_name,
                "posting_number": task.posting_number,
                "scene": task.scene,
                "trigger_status": task.trigger_status,
                "scheduled_for": task.scheduled_for,
                "status": task.status,
                "attempts": task.attempts,
                "chat_id": task.chat_id,
                "ozon_message_id": task.ozon_message_id,
                "sent_at": task.sent_at,
                "last_error_code": task.last_error_code,
                "last_error_message": task.last_error_message,
                "created_at": task.created_at,
            }
            for task, shop in rows
        ],
        "total": total,
    }

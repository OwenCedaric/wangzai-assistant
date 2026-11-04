from __future__ import annotations

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session

from app.models import (
    ActivationCode,
    CardBatch,
    CommissionRecord,
    Device,
    License,
    Order,
    OrderFulfillment,
    Payment,
    PaymentEvent,
    PointCreditLot,
    PointWallet,
    Refund,
    Shop,
    UsageLog,
    User,
)
from app.models.smart_reply import SmartReplyRule, SmartReplyRuleShop


def delete_license_record(db: Session, license_record: License) -> None:
    """Permanently remove one license and detach non-owned history references."""

    # Rules belong to the account/project and can target shops backed by
    # several independent cards. Re-parent a multi-shop rule before deleting
    # the card that happened to create it, or the FK cascade would remove the
    # rule for every still-valid shop.
    rules = db.scalars(
        select(SmartReplyRule).where(SmartReplyRule.license_id == license_record.id)
    ).all()
    for rule in rules:
        replacement_license_id = db.scalar(
            select(Shop.license_id)
            .join(SmartReplyRuleShop, SmartReplyRuleShop.shop_id == Shop.id)
            .where(
                SmartReplyRuleShop.rule_id == rule.id,
                Shop.license_id != license_record.id,
            )
            .order_by(Shop.id)
            .limit(1)
        )
        if replacement_license_id is not None:
            rule.license_id = replacement_license_id
    db.flush()

    db.execute(
        update(ActivationCode)
        .where(ActivationCode.activated_license_id == license_record.id)
        .values(activated_license_id=None)
    )
    db.execute(
        update(UsageLog).where(UsageLog.license_id == license_record.id).values(license_id=None)
    )
    db.execute(delete(Device).where(Device.license_id == license_record.id))
    db.execute(delete(Shop).where(Shop.license_id == license_record.id))
    db.delete(license_record)


def delete_activation_code_record(db: Session, activation_code: ActivationCode) -> None:
    """Permanently remove one card without deleting the license it once activated."""

    db.execute(
        update(OrderFulfillment)
        .where(OrderFulfillment.activation_code_id == activation_code.id)
        .values(activation_code_id=None)
    )
    db.delete(activation_code)


def delete_card_batch_record(db: Session, batch: CardBatch) -> None:
    codes = db.scalars(select(ActivationCode).where(ActivationCode.batch_id == batch.id)).all()
    for activation_code in codes:
        delete_activation_code_record(db, activation_code)
    db.flush()
    db.delete(batch)


def delete_order_record(db: Session, order: Order) -> None:
    """Remove an order graph while preserving any already credited wallet balance."""

    payment_ids = list(db.scalars(select(Payment.id).where(Payment.order_id == order.id)).all())
    payment_event_filter = PaymentEvent.order_id == order.id
    if payment_ids:
        payment_event_filter = or_(
            payment_event_filter,
            PaymentEvent.payment_id.in_(payment_ids),
        )
    db.execute(delete(PaymentEvent).where(payment_event_filter))
    db.execute(delete(Refund).where(Refund.order_id == order.id))
    db.execute(delete(Payment).where(Payment.order_id == order.id))
    db.execute(delete(CommissionRecord).where(CommissionRecord.order_id == order.id))
    db.execute(delete(OrderFulfillment).where(OrderFulfillment.order_id == order.id))
    db.execute(
        update(ActivationCode).where(ActivationCode.order_id == order.id).values(order_id=None)
    )
    db.execute(
        update(PointCreditLot)
        .where(PointCreditLot.source_order_id == order.id)
        .values(source_order_id=None)
    )
    db.delete(order)


def delete_user_record(db: Session, user: User, replacement_admin: User) -> None:
    """Permanently remove a user and every owned runtime record in dependency order."""

    db.execute(
        update(CardBatch)
        .where(CardBatch.created_by_user_id == user.id)
        .values(created_by_user_id=replacement_admin.id)
    )
    db.execute(
        update(ActivationCode)
        .where(ActivationCode.owner_user_id == user.id)
        .values(owner_user_id=None)
    )
    db.execute(
        update(ActivationCode)
        .where(ActivationCode.activated_by_user_id == user.id)
        .values(activated_by_user_id=None)
    )
    db.execute(update(UsageLog).where(UsageLog.user_id == user.id).values(user_id=None))

    orders = db.scalars(select(Order).where(Order.user_id == user.id)).all()
    for order in orders:
        delete_order_record(db, order)

    licenses = db.scalars(select(License).where(License.user_id == user.id)).all()
    for license_record in licenses:
        delete_license_record(db, license_record)

    # Clean legacy orphans before the users row is removed. Normal rows are already
    # removed together with their license above.
    db.execute(delete(Device).where(Device.user_id == user.id))
    db.execute(delete(Shop).where(Shop.user_id == user.id))
    db.execute(delete(PointWallet).where(PointWallet.user_id == user.id))
    db.flush()
    db.delete(user)

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta

from sqlalchemy import distinct, func, select
from sqlalchemy.orm import Session

from app.models import License, Plan, Project, Shop, UsageLog, User
from app.schemas.admin import DashboardStats


def dashboard_stats(db: Session, presence=None, online_window_minutes: int = 390) -> DashboardStats:
    now = datetime.now(UTC)
    day_start = datetime.combine(now.date(), time.min, tzinfo=UTC)
    online_cutoff = now - timedelta(minutes=online_window_minutes)

    users_total = db.scalar(select(func.count(User.id))) or 0
    paid_users = (
        db.scalar(
            select(func.count(distinct(License.user_id)))
            .join(Plan, Plan.id == License.plan_id)
            .where(
                License.status == "active",
                License.start_time <= now,
                License.expire_time > now,
                Plan.is_trial.is_(False),
            )
        )
        or 0
    )
    active_today = (
        db.scalar(
            select(func.count(distinct(UsageLog.user_id))).where(
                UsageLog.created_at >= day_start, UsageLog.user_id.is_not(None)
            )
        )
        or 0
    )
    online_users = presence.count_users() if presence is not None else None
    if online_users is None:
        online_users = (
            db.scalar(
                select(func.count(distinct(License.user_id))).where(
                    License.status == "active", License.last_heartbeat_at >= online_cutoff
                )
            )
            or 0
        )
    expired = db.scalar(select(func.count(License.id)).where(License.expire_time <= now)) or 0
    shop_rows = db.execute(
        select(Shop.platform, func.count(Shop.id))
        .where(Shop.status == "active")
        .group_by(Shop.platform)
    ).all()
    launches = (
        db.scalar(
            select(func.count(UsageLog.id)).where(
                UsageLog.event == "app_launch", UsageLog.created_at >= day_start
            )
        )
        or 0
    )
    feature_calls = (
        db.scalar(
            select(func.count(UsageLog.id)).where(
                UsageLog.event == "feature_call", UsageLog.created_at >= day_start
            )
        )
        or 0
    )
    active_projects = (
        db.scalar(select(func.count(Project.id)).where(Project.status == "active")) or 0
    )
    active_licenses = (
        db.scalar(
            select(func.count(License.id)).where(
                License.status == "active",
                License.start_time <= now,
                License.expire_time > now,
            )
        )
        or 0
    )
    return DashboardStats(
        users_total=users_total,
        paid_users=paid_users,
        active_users_today=active_today,
        online_users=online_users,
        expired_licenses=expired,
        shops_by_platform={platform: count for platform, count in shop_rows},
        launches_today=launches,
        feature_calls_today=feature_calls,
        active_projects=active_projects,
        active_licenses=active_licenses,
    )

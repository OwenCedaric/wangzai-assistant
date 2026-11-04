from __future__ import annotations

import hashlib
import hmac

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import AgentProjectScope, Channel, Project, User, UserProjectAttribution
from app.models.base import utcnow
from app.services.errors import DomainError


def _channel_secret(settings: Settings) -> str:
    return settings.channel_token_secret or settings.jwt_secret_key


def channel_token_hash(settings: Settings, token: str) -> str:
    return hmac.new(_channel_secret(settings).encode(), token.encode(), hashlib.sha256).hexdigest()


def resolve_distribution_channel(
    db: Session,
    settings: Settings,
    project: Project,
    channel_code: str | None,
    distribution_token: str | None,
) -> Channel | None:
    if not channel_code and not distribution_token:
        return None
    if not channel_code or not distribution_token:
        raise DomainError("Both channel_code and distribution_token are required", status_code=422)
    channel = db.scalar(select(Channel).where(Channel.code == channel_code))
    if (
        channel is None
        or channel.status != "active"
        or channel.project_id != project.id
        or not hmac.compare_digest(
            channel.token_hash, channel_token_hash(settings, distribution_token)
        )
        or channel.agent.status != "active"
    ):
        raise DomainError("Distribution channel is invalid", status_code=404)
    active_scope = db.scalar(
        select(AgentProjectScope.id).where(
            AgentProjectScope.agent_id == channel.agent_id,
            AgentProjectScope.project_id == project.id,
            AgentProjectScope.status == "active",
        )
    )
    if active_scope is None:
        raise DomainError("Distribution channel is not enabled for this project", status_code=409)
    return channel


def lock_user_project_attribution(
    db: Session,
    user: User,
    project: Project,
    channel: Channel | None,
) -> UserProjectAttribution:
    attribution = db.scalar(
        select(UserProjectAttribution)
        .where(
            UserProjectAttribution.user_id == user.id,
            UserProjectAttribution.project_id == project.id,
        )
        .with_for_update()
    )
    if attribution is not None:
        return attribution
    attribution = UserProjectAttribution(
        user_id=user.id,
        project_id=project.id,
        agent_id=channel.agent_id if channel else None,
        channel_id=channel.id if channel else None,
        source_type="channel" if channel else "organic",
        locked_at=utcnow(),
        status="active",
    )
    db.add(attribution)
    db.flush()
    return attribution

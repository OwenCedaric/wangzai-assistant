from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.database.session import get_db
from app.models import Agent, Channel, Project, UsageLog, User, UserProjectAttribution
from app.schemas.admin_commerce import AttributionAdminRead, AttributionReassign
from app.services.agent_service import validate_channel_scope
from app.services.errors import DomainError

router = APIRouter(
    prefix="/admin/attributions",
    tags=["admin-commerce"],
    dependencies=[Depends(require_admin)],
)


def _response(
    attribution: UserProjectAttribution,
    user: User,
    project: Project,
    channel: Channel | None,
) -> AttributionAdminRead:
    return AttributionAdminRead(
        attribution_id=attribution.id,
        user_id=user.id,
        username=user.username,
        email=user.email,
        phone_masked=user.phone_masked or user.phone,
        project_id=project.id,
        project_code=project.code,
        channel_id=channel.id if channel else None,
        channel_code=channel.code if channel else None,
        source_type=attribution.source_type,
        locked_at=attribution.locked_at,
        status=attribution.status,
    )


@router.post("/{attribution_id}/reassign", response_model=AttributionAdminRead)
def reassign_attribution(
    attribution_id: int,
    payload: AttributionReassign,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AttributionAdminRead:
    attribution = db.scalar(
        select(UserProjectAttribution)
        .where(UserProjectAttribution.id == attribution_id)
        .with_for_update()
    )
    if attribution is None:
        raise DomainError("Attribution not found", status_code=404)
    user = db.get(User, attribution.user_id)
    project = db.get(Project, attribution.project_id)
    if user is None or project is None:
        raise DomainError("Attribution references unavailable data", status_code=409)
    channel = None
    if payload.agent_id is not None:
        validate_channel_scope(db, payload.agent_id, project.id)
        agent = db.get(Agent, payload.agent_id)
        if agent is None or agent.status != "active":
            raise DomainError("Agent is not active", status_code=409)
        if payload.channel_id is not None:
            channel = db.get(Channel, payload.channel_id)
            if (
                channel is None
                or channel.status != "active"
                or channel.agent_id != agent.id
                or channel.project_id != project.id
            ):
                raise DomainError("Channel does not match agent and project", status_code=422)
    old_agent_id = attribution.agent_id
    old_channel_id = attribution.channel_id
    attribution.agent_id = payload.agent_id
    attribution.channel_id = channel.id if channel else None
    attribution.source_type = "admin_reassigned" if payload.agent_id else "admin_organic"
    db.add(
        UsageLog(
            user_id=user.id,
            project_id=project.id,
            event="attribution_reassigned",
            details={
                "admin_user_id": admin.id,
                "old_agent_id": old_agent_id,
                "old_channel_id": old_channel_id,
                "new_agent_id": attribution.agent_id,
                "new_channel_id": attribution.channel_id,
                "reason": payload.reason,
            },
        )
    )
    db.commit()
    db.refresh(attribution)
    return _response(attribution, user, project, channel)

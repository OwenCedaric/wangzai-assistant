from __future__ import annotations

import secrets

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    Agent,
    AgentProjectScope,
    Channel,
    Order,
    Plan,
    Product,
    Project,
    UserProjectAttribution,
)
from app.schemas.admin_commerce import AgentRead, ChannelRead
from app.services.attribution_service import channel_token_hash
from app.services.errors import DomainError


def sync_agent_projects(db: Session, agent: Agent, project_ids: list[int]) -> None:
    unique_ids = sorted(set(project_ids))
    projects = (
        db.scalars(select(Project).where(Project.id.in_(unique_ids))).all() if unique_ids else []
    )
    if len(projects) != len(unique_ids):
        raise DomainError("One or more projects do not exist", status_code=422)
    existing = {scope.project_id: scope for scope in agent.scopes}
    for project_id in unique_ids:
        scope = existing.get(project_id)
        if scope:
            scope.status = "active"
        else:
            db.add(AgentProjectScope(agent=agent, project_id=project_id, status="active"))
    for project_id, scope in existing.items():
        if project_id not in unique_ids:
            scope.status = "disabled"


def agent_read(db: Session, agent: Agent) -> AgentRead:
    project_ids = sorted(scope.project_id for scope in agent.scopes if scope.status == "active")
    user_count = (
        db.scalar(
            select(func.count(UserProjectAttribution.id)).where(
                UserProjectAttribution.agent_id == agent.id
            )
        )
        or 0
    )
    order_count = db.scalar(select(func.count(Order.id)).where(Order.agent_id == agent.id)) or 0
    return AgentRead(
        id=agent.id,
        code=agent.code,
        name=agent.name,
        contact_name=agent.contact_name,
        contact_phone=agent.contact_phone,
        status=agent.status,
        default_commission_rate_bps=agent.default_commission_rate_bps,
        project_ids=project_ids,
        user_count=user_count,
        order_count=order_count,
        created_at=agent.created_at,
        updated_at=agent.updated_at,
    )


def channel_read(channel: Channel) -> ChannelRead:
    return ChannelRead(
        id=channel.id,
        agent_id=channel.agent_id,
        project_id=channel.project_id,
        code=channel.code,
        name=channel.name,
        campaign=channel.campaign,
        status=channel.status,
        token_prefix=channel.token_prefix,
        created_at=channel.created_at,
        updated_at=channel.updated_at,
    )


def validate_channel_scope(db: Session, agent_id: int, project_id: int) -> None:
    agent = db.get(Agent, agent_id)
    project = db.get(Project, project_id)
    if agent is None:
        raise DomainError("Agent not found", status_code=404)
    if project is None:
        raise DomainError("Project not found", status_code=404)
    scope = db.scalar(
        select(AgentProjectScope).where(
            AgentProjectScope.agent_id == agent_id,
            AgentProjectScope.project_id == project_id,
            AgentProjectScope.status == "active",
        )
    )
    if scope is None:
        raise DomainError("Agent is not enabled for this project", status_code=422)


def generate_channel_token(settings: Settings) -> tuple[str, str, str]:
    token = f"dst_{secrets.token_urlsafe(48)}"
    return token, channel_token_hash(settings, token), token[:12]


def commission_rule_key(agent_id: int, project_id: int | None, plan_id: int | None) -> str:
    return f"agent:{agent_id}:project:{project_id or '*'}:plan:{plan_id or '*'}"


def validate_commission_scope(
    db: Session, agent_id: int, project_id: int | None, plan_id: int | None
) -> None:
    if db.get(Agent, agent_id) is None:
        raise DomainError("Agent not found", status_code=404)
    if project_id is not None and db.get(Project, project_id) is None:
        raise DomainError("Project not found", status_code=404)
    if plan_id is not None:
        plan = db.scalar(
            select(Plan).where(Plan.id == plan_id).join(Product, Product.id == Plan.product_id)
        )
        if plan is None:
            raise DomainError("Plan not found", status_code=404)
        product = db.get(Product, plan.product_id)
        if project_id is None or product is None or product.project_id != project_id:
            raise DomainError("Plan does not belong to project", status_code=422)

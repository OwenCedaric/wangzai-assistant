from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.auth.dependencies import require_admin
from app.database.session import get_db
from app.models import (
    Agent,
    AgentProjectScope,
    Channel,
    CommissionRecord,
    CommissionRule,
    Order,
    Project,
    User,
    UserProjectAttribution,
)
from app.schemas.admin_commerce import (
    AgentCreate,
    AgentDashboard,
    AgentRead,
    AgentUpdate,
    AttributionAdminRead,
    ChannelCreate,
    ChannelCreated,
    ChannelRead,
    ChannelUpdate,
    CommissionRuleCreate,
    CommissionRuleRead,
    CommissionRuleUpdate,
)
from app.schemas.common import Page
from app.services.agent_service import (
    agent_read,
    channel_read,
    commission_rule_key,
    generate_channel_token,
    sync_agent_projects,
    validate_channel_scope,
    validate_commission_scope,
)
from app.services.errors import DomainError

router = APIRouter(prefix="/admin", tags=["admin-commerce"], dependencies=[Depends(require_admin)])


def _commit(db: Session, detail: str) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise DomainError(detail, status_code=409) from exc


def _agent(db: Session, agent_id: int, *, lock: bool = False) -> Agent:
    query = select(Agent).where(Agent.id == agent_id).options(selectinload(Agent.scopes))
    if lock:
        query = query.with_for_update(of=Agent)
    agent = db.scalar(query)
    if agent is None:
        raise DomainError("Agent not found", status_code=404)
    return agent


@router.get("/agents/dashboard", response_model=AgentDashboard)
def agent_dashboard(db: Session = Depends(get_db)) -> AgentDashboard:
    paid_statuses = ("paid", "fulfilled", "refunding", "refunded")
    sums = dict(
        db.execute(
            select(
                CommissionRecord.status,
                func.coalesce(func.sum(CommissionRecord.commission_amount_cent), 0),
            ).group_by(CommissionRecord.status)
        ).all()
    )
    return AgentDashboard(
        agents_total=db.scalar(select(func.count(Agent.id))) or 0,
        active_agents=db.scalar(select(func.count(Agent.id)).where(Agent.status == "active")) or 0,
        channels_total=db.scalar(select(func.count(Channel.id))) or 0,
        attributed_users=db.scalar(
            select(func.count(UserProjectAttribution.id)).where(
                UserProjectAttribution.agent_id.is_not(None)
            )
        )
        or 0,
        paid_orders=db.scalar(select(func.count(Order.id)).where(Order.status.in_(paid_statuses)))
        or 0,
        gross_amount_cent=db.scalar(
            select(func.coalesce(func.sum(Order.amount_cent), 0)).where(
                Order.status.in_(paid_statuses)
            )
        )
        or 0,
        commission_pending_cent=int(sums.get("pending", 0)),
        commission_available_cent=int(sums.get("available", 0)),
        commission_settled_cent=int(sums.get("settled", 0)),
    )


@router.get("/agents", response_model=Page[AgentRead])
def list_agents(
    q: str | None = Query(default=None, max_length=128),
    agent_status: str | None = Query(default=None, alias="status", max_length=24),
    project_id: int | None = Query(default=None, gt=0),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[AgentRead]:
    filters = []
    if q:
        filters.append(or_(Agent.code.contains(q), Agent.name.contains(q)))
    if agent_status:
        filters.append(Agent.status == agent_status)
    query = select(Agent)
    count_query = select(func.count(func.distinct(Agent.id)))
    if project_id:
        query = query.join(AgentProjectScope)
        count_query = count_query.join(AgentProjectScope)
        filters.extend(
            (
                AgentProjectScope.project_id == project_id,
                AgentProjectScope.status == "active",
            )
        )
    total = db.scalar(count_query.where(*filters)) or 0
    agents = (
        db.scalars(
            query.where(*filters)
            .options(selectinload(Agent.scopes))
            .order_by(Agent.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .unique()
        .all()
    )
    return Page(
        items=[agent_read(db, agent) for agent in agents],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/agents", response_model=AgentRead, status_code=201)
def create_agent(payload: AgentCreate, db: Session = Depends(get_db)) -> AgentRead:
    agent = Agent(**payload.model_dump(exclude={"project_ids"}))
    db.add(agent)
    sync_agent_projects(db, agent, payload.project_ids)
    _commit(db, "Agent code already exists")
    return agent_read(db, _agent(db, agent.id))


@router.get("/agents/{agent_id}", response_model=AgentRead)
def get_agent(agent_id: int, db: Session = Depends(get_db)) -> AgentRead:
    return agent_read(db, _agent(db, agent_id))


@router.put("/agents/{agent_id}", response_model=AgentRead)
def update_agent(agent_id: int, payload: AgentUpdate, db: Session = Depends(get_db)) -> AgentRead:
    agent = _agent(db, agent_id, lock=True)
    data = payload.model_dump(exclude_unset=True, exclude={"project_ids"})
    for key, value in data.items():
        setattr(agent, key, value)
    if payload.project_ids is not None:
        sync_agent_projects(db, agent, payload.project_ids)
    _commit(db, "Agent update conflicts with existing data")
    return agent_read(db, _agent(db, agent.id))


@router.delete("/agents/{agent_id}", status_code=204)
def delete_agent(agent_id: int, db: Session = Depends(get_db)) -> None:
    agent = _agent(db, agent_id, lock=True)
    references = sum(
        (
            db.scalar(select(func.count(Channel.id)).where(Channel.agent_id == agent.id)) or 0,
            db.scalar(
                select(func.count(UserProjectAttribution.id)).where(
                    UserProjectAttribution.agent_id == agent.id
                )
            )
            or 0,
            db.scalar(select(func.count(Order.id)).where(Order.agent_id == agent.id)) or 0,
            db.scalar(
                select(func.count(CommissionRule.id)).where(CommissionRule.agent_id == agent.id)
            )
            or 0,
            db.scalar(select(func.count(Agent.id)).where(Agent.parent_agent_id == agent.id)) or 0,
        )
    )
    if references:
        raise DomainError(
            "Disable agents with channels, users, orders, rules, or child agents",
            status_code=409,
        )
    db.delete(agent)
    db.commit()


@router.get("/agents/{agent_id}/users", response_model=Page[AttributionAdminRead])
def list_agent_users(
    agent_id: int,
    q: str | None = Query(default=None, max_length=128),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[AttributionAdminRead]:
    if db.get(Agent, agent_id) is None:
        raise DomainError("Agent not found", status_code=404)
    filters = [UserProjectAttribution.agent_id == agent_id]
    if q:
        filters.append(
            or_(
                User.email.contains(q),
                User.username.contains(q),
                User.phone.contains(q),
                User.phone_masked.contains(q),
            )
        )
    base = (
        select(UserProjectAttribution, User, Project, Channel)
        .join(User, User.id == UserProjectAttribution.user_id)
        .join(Project, Project.id == UserProjectAttribution.project_id)
        .outerjoin(Channel, Channel.id == UserProjectAttribution.channel_id)
        .where(*filters)
    )
    total = (
        db.scalar(
            select(func.count(UserProjectAttribution.id))
            .join(User, User.id == UserProjectAttribution.user_id)
            .where(*filters)
        )
        or 0
    )
    rows = db.execute(
        base.order_by(UserProjectAttribution.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    items = [
        AttributionAdminRead(
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
        for attribution, user, project, channel in rows
    ]
    return Page(items=items, total=total, page=page, page_size=page_size)


@router.get("/channels", response_model=Page[ChannelRead])
def list_channels(
    agent_id: int | None = Query(default=None, gt=0),
    project_id: int | None = Query(default=None, gt=0),
    channel_status: str | None = Query(default=None, alias="status", max_length=24),
    q: str | None = Query(default=None, max_length=128),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[ChannelRead]:
    filters = []
    if agent_id:
        filters.append(Channel.agent_id == agent_id)
    if project_id:
        filters.append(Channel.project_id == project_id)
    if channel_status:
        filters.append(Channel.status == channel_status)
    if q:
        filters.append(or_(Channel.code.contains(q), Channel.name.contains(q)))
    total = db.scalar(select(func.count(Channel.id)).where(*filters)) or 0
    channels = db.scalars(
        select(Channel)
        .where(*filters)
        .order_by(Channel.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(
        items=[channel_read(channel) for channel in channels],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/channels", response_model=ChannelCreated, status_code=201)
def create_channel(
    payload: ChannelCreate, request: Request, db: Session = Depends(get_db)
) -> ChannelCreated:
    validate_channel_scope(db, payload.agent_id, payload.project_id)
    token, token_hash, token_prefix = generate_channel_token(request.app.state.settings)
    channel = Channel(**payload.model_dump(), token_hash=token_hash, token_prefix=token_prefix)
    db.add(channel)
    _commit(db, "Channel code already exists")
    return ChannelCreated(**channel_read(channel).model_dump(), distribution_token=token)


@router.get("/channels/{channel_id}", response_model=ChannelRead)
def get_channel(channel_id: int, db: Session = Depends(get_db)) -> ChannelRead:
    channel = db.get(Channel, channel_id)
    if channel is None:
        raise DomainError("Channel not found", status_code=404)
    return channel_read(channel)


@router.put("/channels/{channel_id}", response_model=ChannelRead)
def update_channel(
    channel_id: int, payload: ChannelUpdate, db: Session = Depends(get_db)
) -> ChannelRead:
    channel = db.scalar(select(Channel).where(Channel.id == channel_id).with_for_update())
    if channel is None:
        raise DomainError("Channel not found", status_code=404)
    data = payload.model_dump(exclude_unset=True)
    target_agent = data.get("agent_id", channel.agent_id)
    target_project = data.get("project_id", channel.project_id)
    if target_agent != channel.agent_id or target_project != channel.project_id:
        references = (
            db.scalar(
                select(func.count(UserProjectAttribution.id)).where(
                    UserProjectAttribution.channel_id == channel.id
                )
            )
            or 0
        )
        if references:
            raise DomainError("Attributed channels cannot change agent or project", status_code=409)
    validate_channel_scope(db, target_agent, target_project)
    for key, value in data.items():
        setattr(channel, key, value)
    _commit(db, "Channel update conflicts with existing data")
    return channel_read(channel)


@router.post("/channels/{channel_id}/rotate-token", response_model=ChannelCreated)
def rotate_channel_token(
    channel_id: int, request: Request, db: Session = Depends(get_db)
) -> ChannelCreated:
    channel = db.scalar(select(Channel).where(Channel.id == channel_id).with_for_update())
    if channel is None:
        raise DomainError("Channel not found", status_code=404)
    token, channel.token_hash, channel.token_prefix = generate_channel_token(
        request.app.state.settings
    )
    db.commit()
    return ChannelCreated(**channel_read(channel).model_dump(), distribution_token=token)


@router.delete("/channels/{channel_id}", status_code=204)
def delete_channel(channel_id: int, db: Session = Depends(get_db)) -> None:
    channel = db.scalar(select(Channel).where(Channel.id == channel_id).with_for_update())
    if channel is None:
        raise DomainError("Channel not found", status_code=404)
    references = (
        db.scalar(
            select(func.count(UserProjectAttribution.id)).where(
                UserProjectAttribution.channel_id == channel.id
            )
        )
        or 0
    )
    if references:
        raise DomainError("Disable channels with attributed users", status_code=409)
    db.delete(channel)
    db.commit()


@router.get("/commission-rules", response_model=Page[CommissionRuleRead])
def list_commission_rules(
    agent_id: int | None = Query(default=None, gt=0),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Page[CommissionRuleRead]:
    filters = [CommissionRule.agent_id == agent_id] if agent_id else []
    total = db.scalar(select(func.count(CommissionRule.id)).where(*filters)) or 0
    records = db.scalars(
        select(CommissionRule)
        .where(*filters)
        .order_by(CommissionRule.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(items=records, total=total, page=page, page_size=page_size)


@router.post("/commission-rules", response_model=CommissionRuleRead, status_code=201)
def create_commission_rule(
    payload: CommissionRuleCreate, db: Session = Depends(get_db)
) -> CommissionRule:
    validate_commission_scope(db, payload.agent_id, payload.project_id, payload.plan_id)
    rule = CommissionRule(
        **payload.model_dump(),
        rule_key=commission_rule_key(payload.agent_id, payload.project_id, payload.plan_id),
    )
    db.add(rule)
    _commit(db, "A commission rule already exists for this scope")
    return rule


@router.put("/commission-rules/{rule_id}", response_model=CommissionRuleRead)
def update_commission_rule(
    rule_id: int, payload: CommissionRuleUpdate, db: Session = Depends(get_db)
) -> CommissionRule:
    rule = db.get(CommissionRule, rule_id)
    if rule is None:
        raise DomainError("Commission rule not found", status_code=404)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(rule, key, value)
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/commission-rules/{rule_id}", status_code=204)
def delete_commission_rule(rule_id: int, db: Session = Depends(get_db)) -> None:
    rule = db.get(CommissionRule, rule_id)
    if rule is None:
        raise DomainError("Commission rule not found", status_code=404)
    db.delete(rule)
    db.commit()

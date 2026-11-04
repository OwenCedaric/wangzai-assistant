from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.config import Settings
from app.database.session import get_db
from app.models.account import User
from app.models.tracking import UsageLog
from app.schemas.oss_management import (
    OssConfigurationRead,
    OssConfigurationUpdate,
    OssUsageSummary,
)
from app.services.errors import DomainError
from app.services.managed_oss_image_sources import build_managed_oss_image_source_stager
from app.services.oss_management import (
    aggregate_usage,
    build_usage_client,
    configuration_public,
    get_configuration,
    save_configuration,
    usage_range,
)

router = APIRouter(
    prefix="/admin/oss",
    tags=["admin-oss"],
    dependencies=[Depends(require_admin)],
)


def _audit(db: Session, admin_id: int, event: str, details: dict[str, object]) -> None:
    db.add(UsageLog(user_id=admin_id, project_id=None, event=event, details=details))


def _client(request: Request, config, settings: Settings):
    factory = getattr(request.app.state, "oss_usage_client_factory", None)
    return factory(config, settings) if factory else build_usage_client(config, settings)


def _image_source_stager(request: Request, config, settings: Settings):
    factory = getattr(request.app.state, "oss_image_source_stager_factory", None)
    return (
        factory(config, settings)
        if factory
        else build_managed_oss_image_source_stager(
            config, settings, require_active=False
        )
    )


@router.get("/configuration", response_model=OssConfigurationRead)
def read_oss_configuration(db: Session = Depends(get_db)):
    return configuration_public(get_configuration(db))


@router.put("/configuration", response_model=OssConfigurationRead)
def update_oss_configuration(
    payload: OssConfigurationUpdate,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    settings: Settings = request.app.state.settings
    config = save_configuration(db, settings, payload)
    _audit(
        db,
        admin.id,
        "admin.oss.configuration_saved",
        {
            "bucket": config.bucket,
            "region": config.region,
            "acceleration_enabled": config.acceleration_enabled,
        },
    )
    db.commit()
    db.refresh(config)
    return configuration_public(config)


@router.post("/test", response_model=OssConfigurationRead)
def test_oss_configuration(
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    config = get_configuration(db)
    if config is None:
        raise DomainError("请先保存OSS配置", status_code=409)
    settings: Settings = request.app.state.settings
    start, end = usage_range(48)
    client = _client(request, config, settings)
    image_source_stager = None
    try:
        client.query_hourly(start, end)
        image_source_stager = _image_source_stager(request, config, settings)
        image_source_stager.verify_read_write_delete()
        config.status = "active"
        config.last_verified_at = datetime.now(UTC)
        config.last_error_code = None
        _audit(
            db,
            admin.id,
            "admin.oss.configuration_verified",
            {"bucket": config.bucket, "region": config.region},
        )
        db.commit()
        db.refresh(config)
        return configuration_public(config)
    except DomainError as exc:
        config.status = "invalid"
        config.last_error_code = "OSS_USAGE_VERIFICATION_FAILED"
        db.commit()
        raise exc
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()
        close_stager = getattr(image_source_stager, "close", None)
        if callable(close_stager):
            close_stager()


@router.get("/usage", response_model=OssUsageSummary)
def read_oss_usage(
    request: Request,
    hours: int = Query(default=24 * 7, ge=1, le=24 * 90),
    db: Session = Depends(get_db),
):
    config = get_configuration(db)
    if config is None:
        raise DomainError("请先保存OSS配置", status_code=409)
    settings: Settings = request.app.state.settings
    start, end = usage_range(hours)
    client = _client(request, config, settings)
    try:
        records = client.query_hourly(start, end)
        result = aggregate_usage(config, records, hours)
        config.last_usage_sync_at = datetime.now(UTC)
        config.status = "active"
        config.last_error_code = None
        db.commit()
        return result
    except DomainError as exc:
        config.last_error_code = "OSS_USAGE_QUERY_FAILED"
        db.commit()
        raise exc
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.config import Settings
from app.database.session import get_db
from app.schemas.oss_management import SignedOssRuntimeConfiguration
from app.services.errors import DomainError
from app.services.oss_management import get_configuration, signed_runtime_configuration

router = APIRouter(prefix="/oss", tags=["oss-runtime"])


@router.get("/runtime-configuration", response_model=SignedOssRuntimeConfiguration)
def runtime_configuration(request: Request, db: Session = Depends(get_db)):
    config = get_configuration(db)
    if config is None:
        raise DomainError("OSS运行配置尚未建立", status_code=404)
    settings: Settings = request.app.state.settings
    return signed_runtime_configuration(config, settings)

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.auth.dependencies import require_user_token
from app.database.session import get_db
from app.models import User
from app.paid_capabilities.model_presets import (
    ModelPresetError,
    build_model_preset_catalog,
    save_model_presets,
)
from app.schemas.model_presets import ModelPresetCatalogRead, ModelPresetUpdate
from app.services.point_service import project_by_code

router = APIRouter(prefix="/model-presets", tags=["model-presets"])


@router.get("", response_model=ModelPresetCatalogRead)
def get_model_presets(
    response: Response,
    project_code: str = Query(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=64),
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> ModelPresetCatalogRead:
    response.headers["Cache-Control"] = "no-store"
    project = project_by_code(db, project_code)
    return build_model_preset_catalog(
        db,
        user_id=user.id,
        project_id=project.id,
        project_code=project.code,
    )


@router.put("", response_model=ModelPresetCatalogRead)
def update_model_presets(
    payload: ModelPresetUpdate,
    response: Response,
    user: User = Depends(require_user_token),
    db: Session = Depends(get_db),
) -> ModelPresetCatalogRead:
    response.headers["Cache-Control"] = "no-store"
    project = project_by_code(db, payload.project_code)
    try:
        result = save_model_presets(
            db,
            user_id=user.id,
            project_id=project.id,
            project_code=project.code,
            groups=payload.groups,
        )
        db.commit()
        return result
    except ModelPresetError as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc

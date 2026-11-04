from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.auth.dependencies import require_admin
from app.config import Settings
from app.core_v2.cross_border import reset_enterprise_token_state

router = APIRouter(
    prefix="/admin/cross-border-provider",
    tags=["admin-cross-border-provider"],
    dependencies=[Depends(require_admin)],
)


class CrossBorderProviderSecretUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    company_secret: SecretStr = Field(min_length=16, max_length=4096)


def _secret_path(settings: Settings) -> Path:
    configured = str(settings.cross_border_company_secret_file or "").strip()
    if not configured:
        raise RuntimeError("CROSS_BORDER_COMPANY_SECRET_FILE_REQUIRED")
    return Path(configured).resolve()


def _atomic_secret_write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write(f"{value}\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            temporary.chmod(0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@router.get("/status")
def provider_status(request: Request):
    settings: Settings = request.app.state.settings
    return {
        "ok": True,
        "configured": bool(settings.cross_border_company_secret),
        "base_url": settings.cross_border_api_base_url,
        "token_state_present": Path(settings.cross_border_token_state_file).resolve().is_file(),
    }


@router.put("/secret")
def update_provider_secret(payload: CrossBorderProviderSecretUpdate, request: Request):
    settings: Settings = request.app.state.settings
    secret = payload.company_secret.get_secret_value().strip()
    _atomic_secret_write(_secret_path(settings), secret)
    object.__setattr__(settings, "cross_border_company_secret", secret)
    reset_enterprise_token_state(settings)
    return {
        "ok": True,
        "configured": True,
        "message": "跨境巴士企业 API 已保存到服务器。",
    }

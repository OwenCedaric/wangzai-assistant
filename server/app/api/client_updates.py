from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.api.helpers import rate_limit
from app.auth.dependencies import CurrentPrincipal, get_current_user, get_principal
from app.database.session import get_db
from app.models import User
from app.services.client_service import get_active_principal_license

router = APIRouter(prefix="/client-updates", tags=["client-updates"])
MAX_BUNDLE_BYTES = 142_000_000


@router.get("/{channel}/latest")
def latest_client_ui_update(
    channel: str,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    # Normal user login alone is insufficient: use the same active device-bound
    # license validation as protected compute. Card semantics are not changed.
    license_record = get_active_principal_license(db, principal)
    settings = request.app.state.settings
    if not settings.client_updates_enabled:
        return Response(status_code=204)
    if (
        not settings.client_update_project_code
        or not settings.client_update_app_id
        or not settings.client_update_bundle_file
    ):
        raise HTTPException(503, detail={"code": "CLIENT_UPDATE_NOT_CONFIGURED"})
    if license_record.plan.product.project.code != settings.client_update_project_code:
        raise HTTPException(403, detail={"code": "CLIENT_UPDATE_PROJECT_FORBIDDEN"})
    if channel != settings.client_update_channel:
        raise HTTPException(404, detail={"code": "CLIENT_UPDATE_CHANNEL_NOT_FOUND"})
    rate_limit(request, "client-updates:latest", str(principal.license_id), 10, bind_ip=False)

    # A fixed operator-configured file, never a path derived from the request.
    # This endpoint serves program resources only and writes no customer facts.
    file = Path(settings.client_update_bundle_file).absolute()
    try:
        metadata = file.stat()
        if (
            not file.is_file()
            or file.is_symlink()
            or os.path.normcase(str(file.resolve())) != os.path.normcase(str(file))
            or metadata.st_nlink != 1
            or metadata.st_size > MAX_BUNDLE_BYTES
        ):
            raise ValueError("unsafe bundle")
        with file.open("rb") as stream:
            content = stream.read(MAX_BUNDLE_BYTES + 1)
        if len(content) > MAX_BUNDLE_BYTES:
            raise ValueError("oversized bundle")
        bundle = json.loads(content)
        manifest = bundle["manifest"]
        if (
            set(bundle) != {"manifest", "signature", "contents"}
            or manifest["contract"] != "wangzai-ui-update/v1"
            or manifest["appId"] != settings.client_update_app_id
            or manifest["channel"] != channel
            or not isinstance(bundle["signature"], str)
            or not isinstance(bundle["contents"], dict)
        ):
            raise ValueError("wrong bundle")
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise HTTPException(503, detail={"code": "CLIENT_UPDATE_BUNDLE_UNAVAILABLE"}) from exc
    # Signature/content validation is enforced by the pinned client updater;
    # do not log or copy program contents into the management database.
    return Response(
        content=content,
        media_type="application/json",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )

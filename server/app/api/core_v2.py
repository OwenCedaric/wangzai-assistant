from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.helpers import rate_limit, release_db_before_outbound_call
from app.auth.dependencies import CurrentPrincipal, get_current_user, get_principal
from app.config import Settings
from app.core_v2.cross_border import (
    CrossBorderFailure,
)
from app.core_v2.cross_border import (
    authorize_user as authorize_cross_border_user,
)
from app.core_v2.cross_border import (
    confirm_write as confirm_cross_border_write,
)
from app.core_v2.cross_border import (
    create_write_preview as create_cross_border_write_preview,
)
from app.core_v2.cross_border import (
    public_endpoints as public_cross_border_endpoints,
)
from app.core_v2.cross_border import (
    request_endpoint as request_cross_border_endpoint,
)
from app.core_v2.cross_border import (
    revoke_user_authorization as revoke_cross_border_user_authorization,
)
from app.core_v2.image_model import (
    ImageModelExecutionFailure,
    execute_byok_image_model,
    execute_paid_image_model,
)
from app.core_v2.model_api import ModelApiDiscoveryFailure, discover_model_api
from app.core_v2.openclaw_chat import (
    execute_byok_openclaw_chat,
    execute_paid_openclaw_chat,
)
from app.core_v2.ozon import OzonConnectionFailure, execute_shop_connection_test
from app.core_v2.prompt_registry import PromptTemplateFailure
from app.core_v2.skill_source import SkillSourceFailure, resolve_github_skill_source
from app.core_v2.text_model import (
    TextModelExecutionFailure,
    execute_byok_text_model,
    execute_paid_text_model,
)
from app.database.session import get_db
from app.models import License, Shop, User
from app.paid_capabilities.registry import PaidCapabilityContractError, get_paid_capability
from app.paid_capabilities.service import PaidCapabilityFailure
from app.protected_compute.canonical import CanonicalValueError
from app.schemas.core_v2 import (
    CrossBorderAuthorizeRequest,
    CrossBorderAuthorizeResponse,
    CrossBorderReadRequest,
    CrossBorderRevokeRequest,
    CrossBorderWriteConfirmRequest,
    CrossBorderWritePreviewRequest,
    ImageModelExecutionRequest,
    ImageModelExecutionResponse,
    ModelApiDiscoveryRequest,
    ModelApiDiscoveryResponse,
    OpenClawChatExecutionRequest,
    OpenClawChatExecutionResponse,
    OzonShopConnectionTestRequest,
    OzonShopConnectionTestResponse,
    TextModelExecutionRequest,
    TextModelExecutionResponse,
)
from app.services.client_service import (
    get_active_principal_license,
    validate_license_lifecycle,
)
from app.services.errors import DomainError

router = APIRouter(prefix="/core-v2", tags=["core-v2"])
logger = logging.getLogger(__name__)


def _cross_border_context(db: Session, principal: CurrentPrincipal) -> tuple[int, str]:
    license_record = get_active_principal_license(db, principal)
    return principal.user_id, license_record.plan.product.project.code


def _raise_cross_border(error: CrossBorderFailure) -> None:
    logger.warning(
        "cross-border request rejected: code=%s status=%s message=%s",
        error.code,
        error.status_code,
        error.message,
    )
    raise HTTPException(
        status_code=error.status_code,
        detail=error.message,
        headers={"X-Wangzai-Error-Code": error.code},
    ) from error


def _assert_shop_entitled(
    db: Session,
    principal: CurrentPrincipal,
    client_id: str,
) -> None:
    session_license = get_active_principal_license(db, principal)
    row = db.execute(
        select(Shop, License)
        .join(License, Shop.license_id == License.id)
        .where(
            Shop.user_id == principal.user_id,
            Shop.project_id == session_license.plan.product.project_id,
            Shop.platform == "ozon",
            Shop.shop_id == client_id,
            Shop.status == "active",
        )
        .limit(1)
    ).one_or_none()
    if row is None:
        raise HTTPException(
            status_code=403,
            detail={"code": "OZON_SHOP_ENTITLEMENT_REQUIRED"},
        )
    _shop, shop_license = row
    try:
        # The desktop session and the selected shop can be backed by different
        # cards.  The selected shop's own license lifecycle is authoritative.
        validate_license_lifecycle(shop_license, datetime.now(UTC))
    except DomainError as exc:
        raise HTTPException(
            status_code=403,
            detail={"code": "OZON_SHOP_ENTITLEMENT_REQUIRED"},
        ) from exc


@router.api_route(
    "/legacy/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
)
async def execute_legacy_core_route(
    path: str,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Only explicitly implemented legacy handlers may return business success."""
    settings: Settings = request.app.state.settings
    get_active_principal_license(db, principal)
    rate_limit(
        request,
        f"core-v2:legacy:{path}",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    if request.method == "POST" and path.strip("/") == "api/prompt-library/skill-source/resolve":
        body = await request.body()
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=400,
                detail={"code": "CORE_V2_LEGACY_JSON_INVALID"},
            ) from exc
        try:
            return await run_in_threadpool(resolve_github_skill_source, payload)
        except SkillSourceFailure as exc:
            raise HTTPException(
                status_code=exc.status_code,
                detail={"code": exc.code, "message": exc.message},
            ) from exc
    raise HTTPException(
        status_code=501,
        detail={
            "code": "CORE_V2_ROUTE_NOT_IMPLEMENTED",
            "message": "此薄客户端功能尚未接入真实业务处理，未执行操作。",
        },
    )


@router.get("/cross-border/endpoints")
def list_cross_border_endpoints(
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _cross_border_context(db, principal)
    return {"ok": True, "endpoints": public_cross_border_endpoints()}


@router.post(
    "/cross-border/authorize",
    response_model=CrossBorderAuthorizeResponse,
)
def authorize_cross_border_account(
    payload: CrossBorderAuthorizeRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    user_id, project_code = _cross_border_context(db, principal)
    rate_limit(
        request,
        "core-v2:cross-border:authorize",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    release_db_before_outbound_call(db)
    try:
        return authorize_cross_border_user(
            settings,
            user_id=user_id,
            project_code=project_code,
            account_ref=payload.account_ref,
            user_name=payload.user_name,
            password=payload.password.get_secret_value(),
            previous_authorization_ref=payload.previous_authorization_ref,
            client=getattr(request.app.state, "cross_border_http_client", None),
        )
    except CrossBorderFailure as exc:
        _raise_cross_border(exc)


@router.post("/cross-border/revoke")
def revoke_cross_border_account(
    payload: CrossBorderRevokeRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    user_id, project_code = _cross_border_context(db, principal)
    rate_limit(
        request,
        "core-v2:cross-border:revoke",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    release_db_before_outbound_call(db)
    try:
        return revoke_cross_border_user_authorization(
            settings,
            user_id=user_id,
            project_code=project_code,
            account_ref=payload.account_ref,
            authorization_ref=payload.authorization_ref,
            client=getattr(request.app.state, "cross_border_http_client", None),
        )
    except CrossBorderFailure as exc:
        _raise_cross_border(exc)


@router.post("/cross-border/read")
def read_cross_border(
    payload: CrossBorderReadRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    user_id, project_code = _cross_border_context(db, principal)
    rate_limit(
        request,
        f"core-v2:cross-border:read:{payload.endpoint_key}",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    release_db_before_outbound_call(db)
    try:
        return request_cross_border_endpoint(
            settings,
            user_id=user_id,
            project_code=project_code,
            authorization_ref=payload.authorization_ref,
            endpoint_key=payload.endpoint_key,
            body=payload.body,
            expected_risk="read",
            client=getattr(request.app.state, "cross_border_http_client", None),
        )
    except CrossBorderFailure as exc:
        _raise_cross_border(exc)


@router.post("/cross-border/write/preview")
def preview_cross_border_write(
    payload: CrossBorderWritePreviewRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    user_id, project_code = _cross_border_context(db, principal)
    try:
        return create_cross_border_write_preview(
            settings,
            user_id=user_id,
            project_code=project_code,
            authorization_ref=payload.authorization_ref,
            endpoint_key=payload.endpoint_key,
            body=payload.body,
            request_id=payload.request_id,
        )
    except CrossBorderFailure as exc:
        _raise_cross_border(exc)


@router.post("/cross-border/write/confirm")
def execute_cross_border_write(
    payload: CrossBorderWriteConfirmRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    user_id, project_code = _cross_border_context(db, principal)
    rate_limit(
        request,
        "core-v2:cross-border:write",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    release_db_before_outbound_call(db)
    try:
        return confirm_cross_border_write(
            settings,
            user_id=user_id,
            project_code=project_code,
            authorization_ref=payload.authorization_ref,
            preview_token=payload.preview_token,
            client=getattr(request.app.state, "cross_border_http_client", None),
        )
    except CrossBorderFailure as exc:
        _raise_cross_border(exc)


@router.post(
    "/ozon/shop-connection-test",
    response_model=OzonShopConnectionTestResponse,
)
def test_ozon_shop_connection(
    payload: OzonShopConnectionTestRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    _assert_shop_entitled(db, principal, payload.client_id)
    rate_limit(
        request,
        "core-v2:ozon-shop-connection-test",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    release_db_before_outbound_call(db)
    try:
        return execute_shop_connection_test(
            payload,
            base_url=settings.ozon_seller_api_base_url,
            timeout_seconds=settings.ozon_seller_api_timeout_seconds,
        )
    except OzonConnectionFailure as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc


@router.post(
    "/model-api/discover",
    response_model=ModelApiDiscoveryResponse,
)
def discover_model_api_account(
    payload: ModelApiDiscoveryRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    get_active_principal_license(db, principal)
    rate_limit(
        request,
        "core-v2:model-api-discover",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    release_db_before_outbound_call(db)
    try:
        return discover_model_api(payload)
    except ModelApiDiscoveryFailure as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc


@router.post(
    "/text-model/execute",
    response_model=TextModelExecutionResponse,
)
def execute_text_model(
    payload: TextModelExecutionRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    license_record = get_active_principal_license(db, principal)
    try:
        descriptor = get_paid_capability(payload.capability, 1)
    except (PaidCapabilityContractError, CanonicalValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "TEXT_MODEL_CAPABILITY_REJECTED"},
        ) from exc
    permissions = {
        permission.code
        for permission in license_record.plan.permissions
        if permission.status == "active"
    }
    if descriptor.required_permission not in permissions:
        raise HTTPException(
            status_code=403,
            detail={"code": "TEXT_MODEL_CAPABILITY_FORBIDDEN"},
        )
    rate_limit(
        request,
        f"core-v2:text-model:{payload.capability}",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    try:
        if payload.byok is not None:
            release_db_before_outbound_call(db)
            return execute_byok_text_model(payload)
        if not settings.paid_capability_enabled:
            raise TextModelExecutionFailure(
                "PAID_CAPABILITY_DISABLED",
                "内置积分模型暂不可用。",
                status_code=503,
            )
        project = license_record.plan.product.project
        return execute_paid_text_model(
            payload,
            db=db,
            user_id=principal.user_id,
            project_id=project.id,
            settings=settings,
            provider=request.app.state.paid_capability_provider,
        )
    except (TextModelExecutionFailure, PromptTemplateFailure) as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except PaidCapabilityFailure as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message, "jobId": exc.job_id},
        ) from exc
    except (PaidCapabilityContractError, CanonicalValueError) as exc:
        db.rollback()
        raise HTTPException(
            status_code=422,
            detail={"code": "PAID_CAPABILITY_INPUT_REJECTED"},
        ) from exc
    except DomainError as exc:
        db.rollback()
        code = (
            "POINT_BALANCE_INSUFFICIENT"
            if exc.message == "Insufficient point balance"
            else "PAID_CAPABILITY_RESERVATION_REJECTED"
        )
        raise HTTPException(
            status_code=402 if code == "POINT_BALANCE_INSUFFICIENT" else exc.status_code,
            detail={"code": code, "message": exc.message},
        ) from exc


@router.post(
    "/openclaw/chat/completions",
    response_model=OpenClawChatExecutionResponse,
)
def execute_openclaw_chat(
    payload: OpenClawChatExecutionRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    license_record = get_active_principal_license(db, principal)
    descriptor = get_paid_capability("text.openclaw-chat", 1)
    permissions = {
        permission.code
        for permission in license_record.plan.permissions
        if permission.status == "active"
    }
    if descriptor.required_permission not in permissions:
        raise HTTPException(
            status_code=403,
            detail={"code": "TEXT_MODEL_CAPABILITY_FORBIDDEN"},
        )
    rate_limit(
        request,
        "core-v2:openclaw-chat",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    try:
        if payload.byok is not None:
            release_db_before_outbound_call(db)
            return execute_byok_openclaw_chat(payload)
        if not settings.paid_capability_enabled:
            raise TextModelExecutionFailure(
                "PAID_CAPABILITY_DISABLED", "内置积分模型暂不可用。", status_code=503
            )
        project = license_record.plan.product.project
        return execute_paid_openclaw_chat(
            payload,
            db=db,
            user_id=principal.user_id,
            project_id=project.id,
            settings=settings,
            provider=request.app.state.paid_capability_provider,
        )
    except TextModelExecutionFailure as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except PaidCapabilityFailure as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message, "jobId": exc.job_id},
        ) from exc
    except (PaidCapabilityContractError, CanonicalValueError) as exc:
        db.rollback()
        raise HTTPException(
            status_code=422, detail={"code": "PAID_CAPABILITY_INPUT_REJECTED"}
        ) from exc
    except DomainError as exc:
        db.rollback()
        code = (
            "POINT_BALANCE_INSUFFICIENT"
            if exc.message == "Insufficient point balance"
            else "PAID_CAPABILITY_RESERVATION_REJECTED"
        )
        raise HTTPException(
            status_code=402 if code == "POINT_BALANCE_INSUFFICIENT" else exc.status_code,
            detail={"code": code, "message": exc.message},
        ) from exc


@router.post(
    "/image-model/execute",
    response_model=ImageModelExecutionResponse,
)
def execute_image_model(
    payload: ImageModelExecutionRequest,
    request: Request,
    principal: CurrentPrincipal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    license_record = get_active_principal_license(db, principal)
    try:
        descriptor = get_paid_capability(payload.capability, 1)
    except (PaidCapabilityContractError, CanonicalValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "IMAGE_MODEL_CAPABILITY_REJECTED"},
        ) from exc
    permissions = {
        permission.code
        for permission in license_record.plan.permissions
        if permission.status == "active"
    }
    if descriptor.required_permission not in permissions:
        raise HTTPException(
            status_code=403,
            detail={"code": "IMAGE_MODEL_CAPABILITY_FORBIDDEN"},
        )
    rate_limit(
        request,
        f"core-v2:image-model:{payload.capability}",
        str(principal.license_id),
        settings.core_v2_rate_limit_per_minute,
        bind_ip=False,
    )
    try:
        if payload.byok is not None:
            release_db_before_outbound_call(db)
            return execute_byok_image_model(payload)
        if not settings.paid_capability_enabled:
            raise ImageModelExecutionFailure(
                "PAID_CAPABILITY_DISABLED",
                "内置积分图片模型暂不可用。",
                status_code=503,
            )
        project = license_record.plan.product.project
        return execute_paid_image_model(
            payload,
            db=db,
            user_id=principal.user_id,
            project_id=project.id,
            settings=settings,
            provider=request.app.state.paid_capability_provider,
        )
    except (ImageModelExecutionFailure, PromptTemplateFailure) as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except PaidCapabilityFailure as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message, "jobId": exc.job_id},
        ) from exc
    except (PaidCapabilityContractError, CanonicalValueError) as exc:
        db.rollback()
        raise HTTPException(
            status_code=422,
            detail={"code": "PAID_CAPABILITY_INPUT_REJECTED"},
        ) from exc
    except DomainError as exc:
        db.rollback()
        code = (
            "POINT_BALANCE_INSUFFICIENT"
            if exc.message == "Insufficient point balance"
            else "PAID_CAPABILITY_RESERVATION_REJECTED"
        )
        raise HTTPException(
            status_code=402 if code == "POINT_BALANCE_INSUFFICIENT" else exc.status_code,
            detail={"code": code, "message": exc.message},
        ) from exc

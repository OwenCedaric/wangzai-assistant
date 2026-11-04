from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.config import Settings
from app.database.session import get_db
from app.models import ActivationCode, CardBatch, License, Shop, UsageLog, User
from app.schemas.admin import (
    ActivationCodeBoundShopRead,
    ActivationCodeRead,
    ActivationCodeRevealedRead,
    ActivationCodeRevealSearch,
    ActivationCodeStatusUpdate,
    CardBatchCreate,
    CardBatchCreated,
    CardBatchRead,
    CardBatchStatusUpdate,
)
from app.schemas.common import Page
from app.services.admin_cleanup_service import (
    delete_activation_code_record,
    delete_card_batch_record,
)
from app.services.card_service import (
    create_batch,
    decrypt_card_code,
    export_batch,
    hash_card_code,
    normalize_card_code,
)

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _paged(db: Session, query, count_query, page: int, page_size: int):
    total = db.scalar(count_query) or 0
    items = db.scalars(query.offset((page - 1) * page_size).limit(page_size)).all()
    return Page(items=items, total=total, page=page, page_size=page_size)


def _activation_code_items(
    db: Session,
    codes: list[ActivationCode],
    *,
    settings: Settings | None = None,
) -> list[ActivationCodeRead | ActivationCodeRevealedRead]:
    """Attach exact card -> license -> shop bindings without exposing extra secrets."""
    license_ids = sorted(
        {
            code.activated_license_id
            for code in codes
            if code.activated_license_id is not None
        }
    )
    licenses_by_id = {
        license_record.id: license_record
        for license_record in (
            db.scalars(select(License).where(License.id.in_(license_ids))).all()
            if license_ids
            else []
        )
    }
    shops_by_license_id: dict[int, list[Shop]] = {license_id: [] for license_id in license_ids}
    if license_ids:
        for shop in db.scalars(
            select(Shop)
            .where(Shop.license_id.in_(license_ids))
            .order_by(Shop.license_id, Shop.platform, Shop.shop_name, Shop.id)
        ).all():
            shops_by_license_id.setdefault(shop.license_id, []).append(shop)

    items: list[ActivationCodeRead | ActivationCodeRevealedRead] = []
    for code in codes:
        license_record = licenses_by_id.get(code.activated_license_id or -1)
        payload = ActivationCodeRead.model_validate(code).model_dump()
        payload["activated_license_expire_at"] = (
            license_record.expire_time if license_record is not None else None
        )
        payload["bound_shops"] = [
            ActivationCodeBoundShopRead.model_validate(shop)
            for shop in shops_by_license_id.get(code.activated_license_id or -1, [])
        ]
        if settings is None:
            items.append(ActivationCodeRead(**payload))
        else:
            items.append(
                ActivationCodeRevealedRead(
                    **payload,
                    card_key=decrypt_card_code(settings, code),
                )
            )
    return items


@router.get("/card-batches", response_model=Page[CardBatchRead])
def list_card_batches(
    plan_id: int | None = Query(default=None, gt=0),
    q: str | None = Query(default=None, max_length=128),
    batch_status: str | None = Query(default=None, alias="status", max_length=24),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    filters = [CardBatch.plan_id == plan_id] if plan_id else []
    if q:
        filters.append(CardBatch.name.contains(q))
    if batch_status:
        filters.append(CardBatch.status == batch_status)
    return _paged(
        db,
        select(CardBatch).where(*filters).order_by(CardBatch.created_at.desc()),
        select(func.count(CardBatch.id)).where(*filters),
        page,
        page_size,
    )


@router.get("/card-batches/{batch_id}", response_model=CardBatchRead)
def get_card_batch(batch_id: int, db: Session = Depends(get_db)):
    batch = db.get(CardBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Card batch not found")
    return batch


@router.put("/card-batches/{batch_id}", response_model=CardBatchRead)
def update_card_batch(batch_id: int, payload: CardBatchStatusUpdate, db: Session = Depends(get_db)):
    batch = db.scalar(
        select(CardBatch).where(CardBatch.id == batch_id).with_for_update(of=CardBatch)
    )
    if batch is None:
        raise HTTPException(status_code=404, detail="Card batch not found")
    batch.status = payload.status
    db.commit()
    db.refresh(batch)
    return batch


@router.delete("/card-batches/{batch_id}", status_code=204)
def delete_card_batch(batch_id: int, db: Session = Depends(get_db)) -> None:
    batch = db.get(CardBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Card batch not found")
    delete_card_batch_record(db, batch)
    db.commit()


@router.post("/card-batches", response_model=CardBatchCreated, status_code=201)
def generate_card_batch(
    payload: CardBatchCreate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    batch, codes, export_available = create_batch(db, settings, admin, payload)
    return CardBatchCreated(
        **CardBatchRead.model_validate(batch).model_dump(),
        codes=codes,
        export_available=export_available,
    )


@router.get("/card-batches/{batch_id}/codes", response_model=Page[ActivationCodeRead])
def list_activation_codes(
    batch_id: int,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    if db.get(CardBatch, batch_id) is None:
        raise HTTPException(status_code=404, detail="Card batch not found")
    filters = [ActivationCode.batch_id == batch_id]
    total = db.scalar(select(func.count(ActivationCode.id)).where(*filters)) or 0
    codes = db.scalars(
        select(ActivationCode)
        .where(*filters)
        .order_by(ActivationCode.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(
        items=_activation_code_items(db, list(codes)),
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get(
    "/card-batches/{batch_id}/codes/revealed",
    response_model=Page[ActivationCodeRevealedRead],
)
def reveal_activation_codes(
    batch_id: int,
    request: Request,
    response: Response,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=500),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _set_revealed_response_headers(response)
    return _revealed_page(
        db=db,
        settings=request.app.state.settings,
        admin=admin,
        batch_id=batch_id,
        page=page,
        page_size=page_size,
    )


@router.post(
    "/card-batches/{batch_id}/codes/revealed/search",
    response_model=Page[ActivationCodeRevealedRead],
)
def search_revealed_activation_codes(
    batch_id: int,
    payload: ActivationCodeRevealSearch,
    request: Request,
    response: Response,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _set_revealed_response_headers(response)
    return _revealed_page(
        db=db,
        settings=request.app.state.settings,
        admin=admin,
        batch_id=batch_id,
        page=payload.page,
        page_size=payload.page_size,
        q=payload.q,
    )


def _set_revealed_response_headers(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Pragma"] = "no-cache"


def _revealed_page(
    *,
    db: Session,
    settings: Settings,
    admin: User,
    batch_id: int,
    page: int,
    page_size: int,
    q: str | None = None,
) -> Page[ActivationCodeRevealedRead]:
    if db.get(CardBatch, batch_id) is None:
        raise HTTPException(status_code=404, detail="Card batch not found")

    filters = [ActivationCode.batch_id == batch_id]
    normalized_query = normalize_card_code(q) if q else ""
    if normalized_query:
        # Full card keys are matched by their deterministic HMAC.  Prefix searches use only
        # the non-secret prefix column, so filtering never requires decrypting/scanning cards.
        try:
            exact_hash = hash_card_code(settings, normalized_query)
        except UnicodeEncodeError:
            exact_hash = None
        prefix_match = ActivationCode.code_prefix.contains(normalized_query, autoescape=True)
        filters.append(
            or_(ActivationCode.code_hash == exact_hash, prefix_match)
            if exact_hash
            else prefix_match
        )

    total = db.scalar(select(func.count(ActivationCode.id)).where(*filters)) or 0
    codes = db.scalars(
        select(ActivationCode)
        .where(*filters)
        .order_by(ActivationCode.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    items = _activation_code_items(db, list(codes), settings=settings)
    db.add(
        UsageLog(
            user_id=admin.id,
            event="card_codes_revealed",
            details={
                "batch_id": batch_id,
                "page": page,
                "page_size": page_size,
                "revealed_count": len(items),
            },
        )
    )
    db.commit()
    return Page(items=items, total=total, page=page, page_size=page_size)


@router.put("/card-batches/{batch_id}/codes/{code_id}", response_model=ActivationCodeRead)
def update_activation_code(
    batch_id: int,
    code_id: int,
    payload: ActivationCodeStatusUpdate,
    db: Session = Depends(get_db),
):
    activation_code = db.scalar(
        select(ActivationCode)
        .where(ActivationCode.id == code_id)
        .with_for_update(of=ActivationCode)
    )
    if activation_code is None or activation_code.batch_id != batch_id:
        raise HTTPException(status_code=404, detail="Activation code not found")
    if activation_code.status in {"activated", "expired"}:
        raise HTTPException(status_code=409, detail="Activated or expired codes are immutable")
    activation_code.status = payload.status
    db.commit()
    db.refresh(activation_code)
    return activation_code


@router.delete("/card-batches/{batch_id}/codes/{code_id}", status_code=204)
def delete_activation_code(batch_id: int, code_id: int, db: Session = Depends(get_db)) -> None:
    activation_code = db.get(ActivationCode, code_id)
    if activation_code is None or activation_code.batch_id != batch_id:
        raise HTTPException(status_code=404, detail="Activation code not found")
    delete_activation_code_record(db, activation_code)
    batch = db.get(CardBatch, batch_id)
    if batch is not None:
        batch.quantity = max(0, batch.quantity - 1)
    db.commit()


@router.get("/card-batches/{batch_id}/export")
def export_activation_codes(
    batch_id: int,
    request: Request,
    export_format: str = Query(default="csv", alias="format", pattern=r"^(csv|xlsx)$"),
    db: Session = Depends(get_db),
):
    settings: Settings = request.app.state.settings
    content = export_batch(db, settings, batch_id, export_format)
    media_type = (
        "text/csv; charset=utf-8"
        if export_format == "csv"
        else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="card-batch-{batch_id}.{export_format}"'
        },
    )

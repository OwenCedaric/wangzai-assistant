from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from app.auth.dependencies import require_admin
from app.database.session import get_db
from app.licensing.shop_card_policy import validate_shop_card_plan
from app.models import (
    ActivationCode,
    CardBatch,
    CommissionRule,
    License,
    Order,
    Permission,
    Plan,
    Product,
    Project,
    plan_permissions,
)
from app.schemas.catalog import (
    PermissionCreate,
    PermissionRead,
    PermissionUpdate,
    PlanCreate,
    PlanRead,
    PlanUpdate,
    ProductCreate,
    ProductRead,
    ProductUpdate,
    ProjectCreate,
    ProjectImport,
    ProjectImportResult,
    ProjectRead,
    ProjectUpdate,
)
from app.schemas.common import Page
from app.services.project_service import import_project

router = APIRouter(prefix="/admin", tags=["admin-catalog"], dependencies=[Depends(require_admin)])


def _commit(db: Session, duplicate_message: str) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=duplicate_message) from exc


def _page(db: Session, query, count_query, page: int, page_size: int):
    total = db.scalar(count_query) or 0
    items = db.scalars(query.offset((page - 1) * page_size).limit(page_size)).all()
    return items, total


@router.get("/projects", response_model=Page[ProjectRead])
def list_projects(
    q: str | None = Query(default=None, max_length=128),
    project_status: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    filters = []
    if q:
        filters.append(or_(Project.name.contains(q), Project.code.contains(q)))
    if project_status:
        filters.append(Project.status == project_status)
    items, total = _page(
        db,
        select(Project).where(*filters).order_by(Project.created_at.desc()),
        select(func.count(Project.id)).where(*filters),
        page,
        page_size,
    )
    return Page(items=items, total=total, page=page, page_size=page_size)


@router.post("/projects", response_model=ProjectRead, status_code=201)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)):
    project = Project(**payload.model_dump())
    db.add(project)
    _commit(db, "Project code already exists")
    db.refresh(project)
    return project


@router.get("/projects/{project_id}", response_model=ProjectRead)
def get_project(project_id: int, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.put("/projects/{project_id}", response_model=ProjectRead)
def update_project(project_id: int, payload: ProjectUpdate, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(project, key, value)
    _commit(db, "Project update conflicts with existing data")
    db.refresh(project)
    return project


@router.post("/projects/import", response_model=ProjectImportResult)
def import_project_json(payload: ProjectImport, db: Session = Depends(get_db)):
    project, created, permissions_created, permissions_updated = import_project(db, payload)
    return ProjectImportResult(
        project=ProjectRead.model_validate(project),
        created=created,
        permissions_created=permissions_created,
        permissions_updated=permissions_updated,
    )


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: int, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    products = (
        db.scalar(select(func.count(Product.id)).where(Product.project_id == project_id)) or 0
    )
    permissions = (
        db.scalar(select(func.count(Permission.id)).where(Permission.project_id == project_id)) or 0
    )
    if products or permissions:
        raise HTTPException(status_code=409, detail="Remove project products and permissions first")
    db.delete(project)
    db.commit()


@router.get("/products", response_model=Page[ProductRead])
def list_products(
    project_id: int | None = Query(default=None, gt=0),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    filters = [Product.project_id == project_id] if project_id else []
    items, total = _page(
        db,
        select(Product).where(*filters).order_by(Product.created_at.desc()),
        select(func.count(Product.id)).where(*filters),
        page,
        page_size,
    )
    return Page(items=items, total=total, page=page, page_size=page_size)


@router.post("/products", response_model=ProductRead, status_code=201)
def create_product(payload: ProductCreate, db: Session = Depends(get_db)):
    if db.get(Project, payload.project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    product = Product(**payload.model_dump())
    db.add(product)
    _commit(db, "Product already exists")
    db.refresh(product)
    return product


@router.get("/products/{product_id}", response_model=ProductRead)
def get_product(product_id: int, db: Session = Depends(get_db)):
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return product


@router.put("/products/{product_id}", response_model=ProductRead)
def update_product(product_id: int, payload: ProductUpdate, db: Session = Depends(get_db)):
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(product, key, value)
    _commit(db, "Product update conflicts with existing data")
    db.refresh(product)
    return product


@router.delete("/products/{product_id}", status_code=204)
def delete_product(product_id: int, db: Session = Depends(get_db)):
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    plans = db.scalar(select(func.count(Plan.id)).where(Plan.product_id == product_id)) or 0
    if plans:
        raise HTTPException(status_code=409, detail="Remove product plans first")
    db.delete(product)
    db.commit()


@router.get("/permissions", response_model=Page[PermissionRead])
def list_permissions(
    project_id: int | None = Query(default=None, gt=0),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    filters = [Permission.project_id == project_id] if project_id else []
    items, total = _page(
        db,
        select(Permission).where(*filters).order_by(Permission.code),
        select(func.count(Permission.id)).where(*filters),
        page,
        page_size,
    )
    return Page(items=items, total=total, page=page, page_size=page_size)


@router.post("/permissions", response_model=PermissionRead, status_code=201)
def create_permission(payload: PermissionCreate, db: Session = Depends(get_db)):
    if db.get(Project, payload.project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    permission = Permission(**payload.model_dump())
    db.add(permission)
    _commit(db, "Permission code already exists for this project")
    db.refresh(permission)
    return permission


@router.get("/permissions/{permission_id}", response_model=PermissionRead)
def get_permission(permission_id: int, db: Session = Depends(get_db)):
    permission = db.get(Permission, permission_id)
    if permission is None:
        raise HTTPException(status_code=404, detail="Permission not found")
    return permission


@router.put("/permissions/{permission_id}", response_model=PermissionRead)
def update_permission(permission_id: int, payload: PermissionUpdate, db: Session = Depends(get_db)):
    permission = db.get(Permission, permission_id)
    if permission is None:
        raise HTTPException(status_code=404, detail="Permission not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(permission, key, value)
    db.commit()
    db.refresh(permission)
    return permission


@router.delete("/permissions/{permission_id}", status_code=204)
def delete_permission(permission_id: int, db: Session = Depends(get_db)):
    permission = db.get(Permission, permission_id)
    if permission is None:
        raise HTTPException(status_code=404, detail="Permission not found")
    uses = (
        db.scalar(
            select(func.count())
            .select_from(plan_permissions)
            .where(plan_permissions.c.permission_id == permission_id)
        )
        or 0
    )
    if uses:
        raise HTTPException(status_code=409, detail="Permission is assigned to plans")
    db.delete(permission)
    db.commit()


def _set_plan_permissions(db: Session, plan: Plan, permission_ids: list[int]) -> None:
    product = db.scalar(
        select(Product).where(Product.id == plan.product_id).options(joinedload(Product.project))
    )
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    unique_ids = sorted(set(permission_ids))
    permissions = (
        db.scalars(select(Permission).where(Permission.id.in_(unique_ids))).all()
        if unique_ids
        else []
    )
    if len(permissions) != len(unique_ids):
        raise HTTPException(status_code=422, detail="One or more permissions do not exist")
    if any(permission.project_id != product.project_id for permission in permissions):
        raise HTTPException(
            status_code=422, detail="Permissions must belong to the product project"
        )
    plan.permissions = list(permissions)


def _validate_plan_configuration(plan: Plan) -> None:
    if plan.online_sale_enabled and plan.sale_price_cent <= 0:
        raise HTTPException(status_code=422, detail="Online sale price must be positive")
    if plan.plan_kind == "points":
        if plan.points_amount <= 0:
            raise HTTPException(status_code=422, detail="Point package amount must be positive")
        if plan.max_devices or plan.max_shops or plan.offline_hours or plan.permissions:
            raise HTTPException(
                status_code=422,
                detail="Point packages cannot include license limits or permissions",
            )
    elif plan.points_amount != 0:
        raise HTTPException(status_code=422, detail="License plans cannot include points")
    shop_card_error = validate_shop_card_plan(plan)
    if shop_card_error:
        raise HTTPException(status_code=422, detail=shop_card_error)


@router.get("/plans", response_model=Page[PlanRead])
def list_plans(
    product_id: int | None = Query(default=None, gt=0),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    filters = [Plan.product_id == product_id] if product_id else []
    total = db.scalar(select(func.count(Plan.id)).where(*filters)) or 0
    items = db.scalars(
        select(Plan)
        .where(*filters)
        .options(selectinload(Plan.permissions))
        .order_by(Plan.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(items=items, total=total, page=page, page_size=page_size)


@router.post("/plans", response_model=PlanRead, status_code=201)
def create_plan(payload: PlanCreate, db: Session = Depends(get_db)):
    data = payload.model_dump(exclude={"permission_ids"})
    if data["license_role"] != "legacy":
        data["price"] = Decimal(data["sale_price_cent"]) / Decimal(100)
    plan = Plan(**data)
    db.add(plan)
    _set_plan_permissions(db, plan, payload.permission_ids)
    _validate_plan_configuration(plan)
    _commit(db, "Plan already exists for this product")
    return db.scalar(select(Plan).where(Plan.id == plan.id).options(selectinload(Plan.permissions)))


@router.get("/plans/{plan_id}", response_model=PlanRead)
def get_plan(plan_id: int, db: Session = Depends(get_db)):
    plan = db.scalar(select(Plan).where(Plan.id == plan_id).options(selectinload(Plan.permissions)))
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return plan


@router.put("/plans/{plan_id}", response_model=PlanRead)
def update_plan(plan_id: int, payload: PlanUpdate, db: Session = Depends(get_db)):
    plan = db.scalar(select(Plan).where(Plan.id == plan_id).options(selectinload(Plan.permissions)))
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    data = payload.model_dump(exclude_unset=True, exclude={"permission_ids"})
    if payload.plan_kind is not None and payload.plan_kind != plan.plan_kind:
        raise HTTPException(status_code=409, detail="Plan kind cannot be changed after creation")
    if payload.license_role is not None and payload.license_role != plan.license_role:
        raise HTTPException(status_code=409, detail="License role cannot be changed after creation")
    for key, value in data.items():
        setattr(plan, key, value)
    if plan.license_role != "legacy":
        plan.price = Decimal(plan.sale_price_cent) / Decimal(100)
    if payload.offline_hours == 0:
        # Clear persisted windows immediately. Previously issued signed tokens
        # expire naturally; clients discard them after their next online check.
        db.execute(update(License).where(License.plan_id == plan.id).values(offline_until=None))
    if payload.permission_ids is not None:
        _set_plan_permissions(db, plan, payload.permission_ids)
    _validate_plan_configuration(plan)
    _commit(db, "Plan update conflicts with existing data")
    return plan


@router.post("/plans/{plan_id}/stop-sales", response_model=PlanRead)
def stop_plan_sales(plan_id: int, db: Session = Depends(get_db)):
    """Stop new online purchases without invalidating existing licenses."""
    plan = db.scalar(select(Plan).where(Plan.id == plan_id).options(selectinload(Plan.permissions)))
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    plan.online_sale_enabled = False
    db.commit()
    return plan


def _plan_dependency_counts(db: Session, plan_id: int) -> dict[str, int]:
    models = {
        "licenses": License,
        "card_batches": CardBatch,
        "activation_codes": ActivationCode,
        "orders": Order,
        "commission_rules": CommissionRule,
    }
    return {
        name: db.scalar(select(func.count(model.id)).where(model.plan_id == plan_id)) or 0
        for name, model in models.items()
    }


@router.delete("/plans/{plan_id}", status_code=204)
def delete_plan(plan_id: int, db: Session = Depends(get_db)):
    plan = db.get(Plan, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    dependencies = _plan_dependency_counts(db, plan_id)
    if any(dependencies.values()):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "PLAN_IN_USE",
                "message": (
                    "Plan is referenced by historical business data and cannot be deleted; "
                    "stop online sales instead"
                ),
                "dependencies": dependencies,
                "recommended_action": "STOP_ONLINE_SALES",
            },
        )
    db.delete(plan)
    db.commit()

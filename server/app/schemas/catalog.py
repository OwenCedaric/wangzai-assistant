from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated

from pydantic import Field, field_validator

from app.schemas.common import ORMModel, StrictModel

ProjectCode = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=64)]
PermissionCode = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_.-]*$", min_length=2, max_length=96)]


class ProjectCreate(StrictModel):
    name: str = Field(min_length=1, max_length=128)
    code: ProjectCode
    version: str = Field(default="1.0.0", min_length=1, max_length=32)
    version_hash: str | None = Field(default=None, max_length=128)
    description: str | None = Field(default=None, max_length=2000)
    status: str = Field(default="active", pattern=r"^(active|disabled)$")


class ProjectUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    version: str | None = Field(default=None, min_length=1, max_length=32)
    version_hash: str | None = Field(default=None, max_length=128)
    description: str | None = Field(default=None, max_length=2000)
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")


class ProjectRead(ORMModel):
    id: int
    name: str
    code: str
    version: str
    version_hash: str | None
    description: str | None
    status: str
    created_at: datetime
    updated_at: datetime


class ImportedModule(StrictModel):
    code: PermissionCode
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=1000)


class ProjectImport(StrictModel):
    name: str = Field(min_length=1, max_length=128)
    code: ProjectCode
    version: str = Field(min_length=1, max_length=32)
    version_hash: str | None = Field(default=None, max_length=128)
    description: str | None = Field(default=None, max_length=2000)
    modules: list[str | ImportedModule] = Field(default_factory=list, max_length=200)

    @field_validator("modules")
    @classmethod
    def validate_module_names(cls, value: list[str | ImportedModule]):
        for module in value:
            if isinstance(module, str) and not (1 <= len(module.strip()) <= 128):
                raise ValueError("module names must contain 1-128 characters")
        return value


class ProjectImportResult(StrictModel):
    project: ProjectRead
    created: bool
    permissions_created: int
    permissions_updated: int


class ProductCreate(StrictModel):
    project_id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=128)
    version: str = Field(default="1.0.0", min_length=1, max_length=32)
    description: str | None = Field(default=None, max_length=2000)
    status: str = Field(default="active", pattern=r"^(active|disabled)$")


class ProductUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    version: str | None = Field(default=None, min_length=1, max_length=32)
    description: str | None = Field(default=None, max_length=2000)
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")


class ProductRead(ORMModel):
    id: int
    project_id: int
    name: str
    version: str
    description: str | None
    status: str
    created_at: datetime
    updated_at: datetime


class PermissionCreate(StrictModel):
    project_id: int = Field(gt=0)
    code: PermissionCode
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=1000)
    status: str = Field(default="active", pattern=r"^(active|disabled)$")


class PermissionUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=1000)
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")


class PermissionRead(ORMModel):
    id: int
    project_id: int
    code: str
    name: str
    description: str | None
    status: str
    created_at: datetime
    updated_at: datetime


class PlanCreate(StrictModel):
    product_id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=128)
    price: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=2)
    sale_price_cent: int = Field(default=0, ge=0, le=999999999999)
    online_sale_enabled: bool = False
    plan_kind: str = Field(default="license", pattern=r"^(license|points)$")
    license_role: str = Field(
        default="legacy",
        pattern=r"^(legacy|shop_intro|shop_standard_monthly|shop_standard_annual)$",
    )
    points_amount: int = Field(default=0, ge=0, le=2_000_000_000)
    customer_description: str | None = Field(default=None, max_length=1000)
    featured: bool = False
    display_order: int = Field(default=0, ge=0, le=100000)
    duration_days: int = Field(default=30, ge=1, le=3650)
    max_devices: int = Field(default=1, ge=0, le=10000)
    max_shops: int = Field(default=1, ge=0, le=10000)
    # Zero is an explicit online-only policy. New plans must opt in before the
    # service will issue any offline grant.
    offline_hours: int = Field(default=0, ge=0, le=168)
    status: str = Field(default="active", pattern=r"^(active|disabled)$")
    is_trial: bool = False
    permission_ids: list[int] = Field(default_factory=list, max_length=500)


class PlanUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    price: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    sale_price_cent: int | None = Field(default=None, ge=0, le=999999999999)
    online_sale_enabled: bool | None = None
    plan_kind: str | None = Field(default=None, pattern=r"^(license|points)$")
    license_role: str | None = Field(
        default=None,
        pattern=r"^(legacy|shop_intro|shop_standard_monthly|shop_standard_annual)$",
    )
    points_amount: int | None = Field(default=None, ge=0, le=2_000_000_000)
    customer_description: str | None = Field(default=None, max_length=1000)
    featured: bool | None = None
    display_order: int | None = Field(default=None, ge=0, le=100000)
    duration_days: int | None = Field(default=None, ge=1, le=3650)
    max_devices: int | None = Field(default=None, ge=0, le=10000)
    max_shops: int | None = Field(default=None, ge=0, le=10000)
    offline_hours: int | None = Field(default=None, ge=0, le=168)
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")
    is_trial: bool | None = None
    permission_ids: list[int] | None = Field(default=None, max_length=500)


class PlanRead(ORMModel):
    id: int
    product_id: int
    name: str
    price: Decimal
    sale_price_cent: int
    online_sale_enabled: bool
    plan_kind: str
    license_role: str
    points_amount: int
    customer_description: str | None
    featured: bool
    display_order: int
    duration_days: int
    max_devices: int
    max_shops: int
    offline_hours: int
    status: str
    is_trial: bool
    permissions: list[PermissionRead]
    created_at: datetime
    updated_at: datetime

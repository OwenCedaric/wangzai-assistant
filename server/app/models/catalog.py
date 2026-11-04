from __future__ import annotations

from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.models.base import TimestampMixin

plan_permissions = Table(
    "plan_permissions",
    Base.metadata,
    Column("plan_id", ForeignKey("plans.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
)


class Project(TimestampMixin, Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    version: Mapped[str] = mapped_column(String(32), default="1.0.0")
    version_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    products = relationship("Product", back_populates="project", cascade="all, delete-orphan")
    permissions = relationship("Permission", back_populates="project", cascade="all, delete-orphan")


class Product(TimestampMixin, Base):
    __tablename__ = "products"
    __table_args__ = (UniqueConstraint("project_id", "name", "version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    version: Mapped[str] = mapped_column(String(32), default="1.0.0")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    project = relationship("Project", back_populates="products")
    plans = relationship("Plan", back_populates="product", cascade="all, delete-orphan")


class Permission(TimestampMixin, Base):
    __tablename__ = "permissions"
    __table_args__ = (UniqueConstraint("project_id", "code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    code: Mapped[str] = mapped_column(String(96), index=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)

    project = relationship("Project", back_populates="permissions")
    plans = relationship("Plan", secondary=plan_permissions, back_populates="permissions")


class Plan(TimestampMixin, Base):
    __tablename__ = "plans"
    __table_args__ = (
        UniqueConstraint("product_id", "name"),
        CheckConstraint("sale_price_cent >= 0", name="ck_plans_sale_price_cent_nonnegative"),
        CheckConstraint("plan_kind IN ('license', 'points')", name="ck_plans_kind"),
        CheckConstraint(
            "license_role IN ('legacy', 'shop_intro', 'shop_standard_monthly', "
            "'shop_standard_annual')",
            name="ck_plans_license_role",
        ),
        CheckConstraint("points_amount >= 0", name="ck_plans_points_amount_nonnegative"),
        CheckConstraint(
            "offline_hours >= 0 AND offline_hours <= 168",
            name="ck_plans_offline_hours_range",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    # Legacy display price retained for v1 compatibility. Every v1.1 order uses
    # the integer sale_price_cent snapshot exclusively.
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    sale_price_cent: Mapped[int] = mapped_column(Integer, default=0)
    online_sale_enabled: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    plan_kind: Mapped[str] = mapped_column(String(24), default="license", index=True)
    license_role: Mapped[str] = mapped_column(String(32), default="legacy", index=True)
    points_amount: Mapped[int] = mapped_column(Integer, default=0)
    customer_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    featured: Mapped[bool] = mapped_column(Boolean, default=False)
    display_order: Mapped[int] = mapped_column(Integer, default=0)
    duration_days: Mapped[int] = mapped_column(Integer, default=30)
    max_devices: Mapped[int] = mapped_column(Integer, default=1)
    max_shops: Mapped[int] = mapped_column(Integer, default=1)
    # Zero means online-only. Offline use is opt-in per plan.
    offline_hours: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    is_trial: Mapped[bool] = mapped_column(Boolean, default=False)

    product = relationship("Product", back_populates="plans")
    permissions = relationship("Permission", secondary=plan_permissions, back_populates="plans")
    licenses = relationship("License", back_populates="plan")
    orders = relationship("Order", back_populates="plan")

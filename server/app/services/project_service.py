from __future__ import annotations

import hashlib
import re

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Permission, Product, Project
from app.schemas.catalog import ImportedModule, ProjectImport
from app.services.errors import DomainError


def _module_code(project_code: str, module_name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", module_name.lower()).strip("_")
    if not slug or not slug[0].isalpha():
        digest = hashlib.sha1(module_name.encode("utf-8"), usedforsecurity=False).hexdigest()[:10]
        slug = f"module_{digest}"
    return f"{project_code}.{slug}"[:96]


def import_project(db: Session, payload: ProjectImport) -> tuple[Project, bool, int, int]:
    project = db.scalar(select(Project).where(Project.code == payload.code))
    created = project is None
    if project is None:
        project = Project(
            name=payload.name,
            code=payload.code,
            version=payload.version,
            version_hash=payload.version_hash,
            description=payload.description,
        )
        db.add(project)
        db.flush()
    else:
        project.name = payload.name
        project.version = payload.version
        project.version_hash = payload.version_hash
        project.description = payload.description

    default_product = db.scalar(
        select(Product).where(
            Product.project_id == project.id,
            Product.name == payload.name,
            Product.version == payload.version,
        )
    )
    if default_product is None:
        db.add(
            Product(
                project_id=project.id,
                name=payload.name,
                version=payload.version,
                description=payload.description,
            )
        )

    created_permissions = 0
    updated_permissions = 0
    seen_codes: set[str] = set()
    for module in payload.modules:
        if isinstance(module, str):
            name = module.strip()
            code = _module_code(payload.code, name)
            description = None
        else:
            assert isinstance(module, ImportedModule)
            name = module.name
            code = module.code
            description = module.description
        if code in seen_codes:
            raise DomainError(f"Duplicate module code: {code}", status_code=422)
        seen_codes.add(code)
        permission = db.scalar(
            select(Permission).where(Permission.project_id == project.id, Permission.code == code)
        )
        if permission is None:
            db.add(
                Permission(
                    project_id=project.id,
                    code=code,
                    name=name,
                    description=description,
                )
            )
            created_permissions += 1
        else:
            permission.name = name
            permission.description = description
            updated_permissions += 1
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise DomainError("Project import conflicts with existing data", status_code=409) from exc
    db.refresh(project)
    return project, created, created_permissions, updated_permissions

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.auth.security import decode_access_token
from app.config import Settings
from app.database.session import get_db
from app.models import User

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True, slots=True)
class CurrentPrincipal:
    user_id: int
    token_type: str
    license_id: int | None
    project_code: str | None
    device_code: str | None


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_principal(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    settings: Settings = Depends(get_app_settings),
) -> CurrentPrincipal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required"
        )
    try:
        claims = decode_access_token(settings, credentials.credentials)
        token_type = str(claims["type"])
        if token_type not in {"user", "license"}:
            raise ValueError("unsupported token type")
        license_id = int(claims["license_id"]) if claims.get("license_id") else None
        project_code = str(claims["project_code"]) if claims.get("project_code") else None
        device_code = str(claims["device_code"]) if claims.get("device_code") else None
        if token_type == "license" and not (license_id and project_code and device_code):
            raise ValueError("incomplete license token")
        return CurrentPrincipal(
            user_id=int(claims["user_id"]),
            token_type=token_type,
            license_id=license_id,
            project_code=project_code,
            device_code=device_code,
        )
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token"
        ) from exc


def get_current_user(
    principal: CurrentPrincipal = Depends(get_principal), db: Session = Depends(get_db)
) -> User:
    user = db.get(User, principal.user_id)
    if user is None or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User is not active")
    return user


def require_user_token(
    principal: CurrentPrincipal = Depends(get_principal),
    user: User = Depends(get_current_user),
) -> User:
    if principal.token_type != "user":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User token required")
    return user


def require_admin(user: User = Depends(require_user_token)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator required")
    return user

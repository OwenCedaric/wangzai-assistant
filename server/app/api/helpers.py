from __future__ import annotations

from fastapi import HTTPException, Request, status
from sqlalchemy.orm import Session

from app.services.rate_limit import RateLimiterUnavailable, RateLimitExceeded


def rate_limit(
    request: Request,
    category: str,
    subject: str,
    limit: int,
    *,
    bind_ip: bool = True,
) -> None:
    client_ip = request.client.host if request.client else "unknown"
    key = f"{category}:{client_ip}:{subject}" if bind_ip else f"{category}:{subject}"
    try:
        request.app.state.rate_limiter.hit(key, limit=limit)
    except RateLimitExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests",
            headers={"Retry-After": "60"},
        ) from exc
    except RateLimiterUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authorization rate limiter is temporarily unavailable",
            headers={"Retry-After": "5"},
        ) from exc


def release_db_before_outbound_call(db: Session) -> None:
    """Return the pooled connection before waiting on a third-party service.

    The authorization reads are done and these handlers write nothing, so ending the
    transaction now is what closing the session would do anyway after the (possibly
    minutes-long) provider call - without holding a connection "idle in transaction".
    """
    db.rollback()

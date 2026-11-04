from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, StrictInt

from app.schemas.common import StrictModel


class ProtectedComputeRequest(StrictModel):
    contract: Literal["protected-compute-request/v1"]
    capability: str = Field(min_length=1, max_length=96, pattern=r"^[a-z][a-z0-9.-]+$")
    version: StrictInt = Field(ge=1, le=1_000_000)
    requestId: str = Field(
        pattern=(
            r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
            r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
        )
    )
    nonce: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    issuedAt: str = Field(
        min_length=24,
        max_length=30,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$",
    )
    inputHash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    input: dict[str, Any]

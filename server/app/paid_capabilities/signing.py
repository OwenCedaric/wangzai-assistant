from __future__ import annotations

import base64

from app.config import Settings
from app.protected_compute.canonical import canonical_json
from app.protected_compute.service import load_protected_compute_private_key


def sign_paid_capability_payload(
    settings: Settings, payload: dict[str, object]
) -> dict[str, object]:
    private_key = load_protected_compute_private_key(settings)
    if private_key is None:
        raise RuntimeError("Paid capability signing key is unavailable")
    signature = (
        base64.urlsafe_b64encode(private_key.sign(canonical_json(payload))).rstrip(b"=").decode()
    )
    return {**payload, "signature": signature}

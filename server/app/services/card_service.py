from __future__ import annotations

import csv
import hashlib
import hmac
import io
import secrets
from datetime import UTC, datetime

from cryptography.fernet import Fernet, InvalidToken
from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.licensing.shop_card_policy import SHOP_CARD_ROLES
from app.models import ActivationCode, CardBatch, Plan, User
from app.schemas.admin import CardBatchCreate
from app.services.errors import DomainError

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def normalize_card_code(code: str) -> str:
    return code.strip().upper()


def hash_card_code(settings: Settings, code: str) -> str:
    normalized = normalize_card_code(code)
    secret = settings.card_hash_secret or settings.jwt_secret_key
    return hmac.new(secret.encode("utf-8"), normalized.encode("ascii"), hashlib.sha256).hexdigest()


def _cipher(settings: Settings) -> Fernet | None:
    if not settings.card_encryption_key:
        return None
    try:
        return Fernet(settings.card_encryption_key.encode("ascii"))
    except (ValueError, TypeError) as exc:
        raise RuntimeError("CARD_ENCRYPTION_KEY must be a valid Fernet key") from exc


def _new_code() -> str:
    return "-".join("".join(secrets.choice(ALPHABET) for _ in range(4)) for _ in range(4))


def order_card_code(settings: Settings, order_no: str) -> str:
    """Derive a stable order-bound code without storing recoverable plaintext."""
    secret = settings.card_hash_secret or settings.jwt_secret_key
    digest = hmac.new(secret.encode(), f"order:{order_no}".encode(), hashlib.sha256).digest()
    characters = "".join(ALPHABET[byte % len(ALPHABET)] for byte in digest[:16])
    return "-".join(characters[index : index + 4] for index in range(0, 16, 4))


def encrypt_card_code(settings: Settings, code: str) -> str | None:
    cipher = _cipher(settings)
    return cipher.encrypt(code.encode("ascii")).decode("ascii") if cipher else None


def decrypt_card_code(settings: Settings, activation_code: ActivationCode) -> str:
    cipher = _cipher(settings)
    if cipher is None:
        raise DomainError(
            "Encrypted card viewing is unavailable; configure CARD_ENCRYPTION_KEY",
            status_code=409,
        )
    if not activation_code.code_ciphertext:
        raise DomainError(
            "Card plaintext is unavailable because this code was not encrypted at generation",
            status_code=409,
        )
    try:
        return cipher.decrypt(activation_code.code_ciphertext.encode("ascii")).decode("ascii")
    except InvalidToken as exc:
        raise DomainError("Card encryption key does not match this batch", status_code=409) from exc


def create_batch(
    db: Session,
    settings: Settings,
    admin: User,
    payload: CardBatchCreate,
) -> tuple[CardBatch, list[str], bool]:
    plan = db.get(Plan, payload.plan_id)
    if plan is None:
        raise DomainError("Plan not found", status_code=404)
    if plan.plan_kind != "license":
        raise DomainError("Point packages cannot generate activation cards", status_code=409)
    if plan.license_role not in SHOP_CARD_ROLES:
        raise DomainError("Legacy plans cannot generate new activation cards", status_code=409)
    if plan.status != "active":
        raise DomainError("Plan is not active", status_code=409)
    expires_at = _aware(payload.expires_at) if payload.expires_at else None
    if expires_at and expires_at <= datetime.now(UTC):
        raise DomainError("Card batch expiry must be in the future")

    generated_suffix = f"-{datetime.now(UTC):%Y%m%d-%H%M%S}"
    batch_name = payload.name or f"{plan.name[: 128 - len(generated_suffix)]}{generated_suffix}"
    if payload.duration_days is not None and payload.duration_days != plan.duration_days:
        raise DomainError("Shop-card duration cannot override its plan", status_code=422)
    batch = CardBatch(
        plan_id=plan.id,
        name=batch_name,
        quantity=payload.quantity,
        duration_days=plan.duration_days,
        expires_at=expires_at,
        created_by_user_id=admin.id,
    )
    db.add(batch)
    db.flush()

    cipher = _cipher(settings)
    plaintext_codes: list[str] = []
    existing_hashes = set(db.scalars(select(ActivationCode.code_hash)).all())
    while len(plaintext_codes) < payload.quantity:
        code = _new_code()
        code_hash = hash_card_code(settings, code)
        if code_hash in existing_hashes:
            continue
        existing_hashes.add(code_hash)
        plaintext_codes.append(code)
        db.add(
            ActivationCode(
                batch_id=batch.id,
                plan_id=plan.id,
                code_hash=code_hash,
                code_prefix=code[:9],
                code_ciphertext=(
                    cipher.encrypt(code.encode("ascii")).decode("ascii") if cipher else None
                ),
                expires_at=expires_at,
            )
        )
    db.commit()
    db.refresh(batch)
    return batch, plaintext_codes, cipher is not None


def export_batch(db: Session, settings: Settings, batch_id: int, export_format: str) -> bytes:
    batch = db.get(CardBatch, batch_id)
    if batch is None:
        raise DomainError("Card batch not found", status_code=404)
    cipher = _cipher(settings)
    if cipher is None:
        raise DomainError(
            "Encrypted export is unavailable; configure CARD_ENCRYPTION_KEY before generation",
            status_code=409,
        )
    rows: list[tuple[str, str, str]] = []
    for activation_code in db.scalars(
        select(ActivationCode)
        .where(ActivationCode.batch_id == batch_id)
        .order_by(ActivationCode.id)
    ):
        if not activation_code.code_ciphertext:
            code = "UNAVAILABLE"
        else:
            code = decrypt_card_code(settings, activation_code)
        rows.append((code, activation_code.status, activation_code.code_prefix))

    if export_format == "csv":
        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer)
        writer.writerow(["card_key", "status", "prefix"])
        writer.writerows(rows)
        return "\ufeff".encode("utf-8") + buffer.getvalue().encode("utf-8")
    if export_format == "xlsx":
        workbook = Workbook(write_only=True)
        sheet = workbook.create_sheet("Activation Codes")
        sheet.append(["card_key", "status", "prefix"])
        for row in rows:
            sheet.append(list(row))
        binary = io.BytesIO()
        workbook.save(binary)
        return binary.getvalue()
    raise DomainError("format must be csv or xlsx")


def _aware(value: datetime) -> datetime:
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)

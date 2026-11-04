from __future__ import annotations

import hashlib
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.recovery import RecoveryGeneration, RecoveryObject
from app.schemas.recovery import RecoveryGenerationCommit
from app.services.errors import DomainError
from app.services.recovery_service import commit_generation
from tests.helpers import create_user, login_user


def _opaque_id(character: str) -> str:
    return character * 43


def _upload(
    client: TestClient, headers: dict[str, str], chunk_id: str, body: bytes
) -> dict[str, object]:
    response = client.put(
        f"/api/recovery/objects/{chunk_id}",
        headers={
            **headers,
            "Content-Type": "application/octet-stream",
            "X-Recovery-Cipher-Sha256": hashlib.sha256(body).hexdigest(),
            "X-Recovery-Cipher-Bytes": str(len(body)),
        },
        content=body,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _reference(chunk_id: str, body: bytes) -> dict[str, object]:
    return {
        "chunk_id": chunk_id,
        "cipher_bytes": len(body),
        "cipher_sha256": hashlib.sha256(body).hexdigest(),
    }


def _commit_payload(
    scope_key: str,
    manifest_chunk_id: str,
    refs: list[dict[str, object]],
    *,
    expected_generation_id: str | None | object = ...,
    owner_refs: list[str] | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "scope_key": scope_key,
        "key_envelope": {
            "format": "wangzai-recovery-key-envelope",
            "version": 1,
            "ciphertextB64u": "opaque-client-only-envelope",
        },
        "manifest_chunk_id": manifest_chunk_id,
        "logical_cipher_bytes": sum(int(ref["cipher_bytes"]) for ref in refs),
        "object_refs": refs,
        "owner_refs": list(owner_refs or []),
    }
    if expected_generation_id is not ...:
        payload["expected_generation_id"] = expected_generation_id
    return payload


def test_recovery_owner_purge_is_cas_fenced_and_blocks_stale_generation_republication(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    create_user(client, admin_headers)
    headers = login_user(client)
    target_ref = _opaque_id("t")
    keep_ref = _opaque_id("k")
    rebound_ref = _opaque_id("r")
    scope_key = _opaque_id("s")
    manifest_id = _opaque_id("m")
    manifest = b"m" * 96
    _upload(client, headers, manifest_id, manifest)
    first = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(
            scope_key,
            manifest_id,
            [_reference(manifest_id, manifest)],
            expected_generation_id=None,
            owner_refs=[target_ref, keep_ref],
        ),
    )
    assert first.status_code == 201, first.text
    first_id = first.json()["generation_id"]

    conflict = client.post(
        f"/api/recovery/owners/{target_ref}/purge",
        headers=headers,
        json={"expected_generation_ids": []},
    )
    assert conflict.status_code == 409
    assert client.get(
        f"/api/recovery/owners/{target_ref}/purge-status", headers=headers
    ).json() == {"owner_ref": target_ref, "tombstoned": False}

    purged = client.post(
        f"/api/recovery/owners/{target_ref}/purge",
        headers=headers,
        json={"expected_generation_ids": [first_id]},
    )
    assert purged.status_code == 200, purged.text
    assert purged.json() == {
        "owner_ref": target_ref,
        "tombstoned": True,
        "deleted_generation_ids": [first_id],
        "remaining_generation_count": 0,
    }
    assert client.get(f"/api/recovery/generations/{first_id}", headers=headers).status_code == 404
    assert client.get(
        f"/api/recovery/owners/{target_ref}/purge-status", headers=headers
    ).json() == {"owner_ref": target_ref, "tombstoned": True}

    stale_manifest_id = _opaque_id("n")
    stale_manifest = b"n" * 96
    _upload(client, headers, stale_manifest_id, stale_manifest)
    stale = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(
            scope_key,
            stale_manifest_id,
            [_reference(stale_manifest_id, stale_manifest)],
            expected_generation_id=None,
            owner_refs=[target_ref, keep_ref],
        ),
    )
    assert stale.status_code == 409
    assert stale.json() == {"detail": "Recovery owner was purged"}
    legacy = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(
            scope_key,
            stale_manifest_id,
            [_reference(stale_manifest_id, stale_manifest)],
            expected_generation_id=None,
        ),
    )
    assert legacy.status_code == 409
    assert legacy.json() == {"detail": "Recovery client owner metadata required"}
    rebound = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(
            scope_key,
            stale_manifest_id,
            [_reference(stale_manifest_id, stale_manifest)],
            expected_generation_id=None,
            owner_refs=[rebound_ref, keep_ref],
        ),
    )
    assert rebound.status_code == 201, rebound.text
    assert rebound.json()["owner_refs"] == sorted([rebound_ref, keep_ref])


def test_recovery_generation_is_opaque_deduplicated_and_atomically_replaced(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    create_user(client, admin_headers)
    headers = login_user(client)
    scope_key = _opaque_id("s")
    manifest_id = _opaque_id("m")
    data_id = _opaque_id("d")
    manifest = b"m" * 96
    data = b"d" * 128
    assert _upload(client, headers, manifest_id, manifest)["reused"] is False
    assert _upload(client, headers, data_id, data)["reused"] is False
    assert _upload(client, headers, data_id, data)["reused"] is True
    first_refs = [_reference(manifest_id, manifest), _reference(data_id, data)]
    first = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(
            scope_key,
            manifest_id,
            first_refs,
            expected_generation_id=None,
        ),
    )
    assert first.status_code == 201, first.text
    first_id = first.json()["generation_id"]
    assert re.fullmatch(r"[A-Za-z0-9_-]{20,128}", first_id)
    listed = client.get("/api/recovery/generations", headers=headers)
    assert listed.status_code == 200
    assert listed.json() == [first.json()]
    detail = client.get(f"/api/recovery/generations/{first_id}", headers=headers)
    assert detail.status_code == 200
    assert {item["chunk_id"] for item in detail.json()["object_refs"]} == {manifest_id, data_id}
    downloaded = client.get(
        f"/api/recovery/generations/{first_id}/objects/{data_id}", headers=headers
    )
    assert downloaded.status_code == 200
    assert downloaded.content == data
    assert downloaded.headers["x-recovery-cipher-sha256"] == hashlib.sha256(data).hexdigest()

    next_manifest_id = _opaque_id("n")
    next_manifest = b"n" * 128
    _upload(client, headers, next_manifest_id, next_manifest)
    second = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(
            scope_key,
            next_manifest_id,
            [_reference(next_manifest_id, next_manifest), _reference(data_id, data)],
            expected_generation_id=first_id,
        ),
    )
    assert second.status_code == 201, second.text
    assert second.json()["generation_id"] != first_id
    listed_after = client.get("/api/recovery/generations", headers=headers)
    assert listed_after.status_code == 200
    assert [item["generation_id"] for item in listed_after.json()] == [
        second.json()["generation_id"]
    ]
    assert client.get(f"/api/recovery/generations/{first_id}", headers=headers).status_code == 404
    current_data = client.get(
        f"/api/recovery/generations/{second.json()['generation_id']}/objects/{data_id}",
        headers=headers,
    )
    assert current_data.status_code == 200
    assert current_data.content == data


def test_recovery_generation_compare_and_swap_rejects_stale_device_without_replacing_current_backup(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    create_user(client, admin_headers)
    headers = login_user(client)
    scope_key = _opaque_id("c")
    first_manifest_id = _opaque_id("a")
    first_manifest = b"a" * 96
    _upload(client, headers, first_manifest_id, first_manifest)
    first = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(
            scope_key,
            first_manifest_id,
            [_reference(first_manifest_id, first_manifest)],
            expected_generation_id=None,
        ),
    )
    assert first.status_code == 201, first.text
    first_id = first.json()["generation_id"]

    current_manifest_id = _opaque_id("b")
    current_manifest = b"b" * 112
    _upload(client, headers, current_manifest_id, current_manifest)
    current = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(
            scope_key,
            current_manifest_id,
            [_reference(current_manifest_id, current_manifest)],
            expected_generation_id=first_id,
        ),
    )
    assert current.status_code == 201, current.text

    stale_manifest_id = _opaque_id("d")
    stale_manifest = b"d" * 128
    _upload(client, headers, stale_manifest_id, stale_manifest)
    stale = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(
            scope_key,
            stale_manifest_id,
            [_reference(stale_manifest_id, stale_manifest)],
            expected_generation_id=first_id,
        ),
    )
    assert stale.status_code == 409
    assert stale.json() == {"detail": "Recovery generation conflict"}
    listed = client.get("/api/recovery/generations", headers=headers)
    assert listed.status_code == 200
    assert [item["generation_id"] for item in listed.json()] == [current.json()["generation_id"]]


def test_recovery_generation_translates_first_generation_insert_race_to_conflict(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user = create_user(client, admin_headers)
    headers = login_user(client)
    scope_key = _opaque_id("i")
    manifest_id = _opaque_id("j")
    manifest = b"j" * 96
    _upload(client, headers, manifest_id, manifest)
    payload = RecoveryGenerationCommit.model_validate(
        _commit_payload(
            scope_key,
            manifest_id,
            [_reference(manifest_id, manifest)],
            expected_generation_id=None,
        )
    )
    with client.app.state.session_factory() as db:
        with patch.object(
            db,
            "flush",
            side_effect=IntegrityError("INSERT", {}, Exception("unique scope")),
        ):
            with pytest.raises(DomainError, match="Recovery generation conflict") as error:
                commit_generation(db, user_id=int(user["id"]), payload=payload)
    assert error.value.status_code == 409


def test_recovery_generation_first_commit_race_leaves_one_active_generation(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user = create_user(client, admin_headers)
    headers = login_user(client)
    scope_key = _opaque_id("r")
    manifest_id = _opaque_id("t")
    manifest = b"t" * 96
    _upload(client, headers, manifest_id, manifest)
    payload = RecoveryGenerationCommit.model_validate(
        _commit_payload(
            scope_key,
            manifest_id,
            [_reference(manifest_id, manifest)],
            expected_generation_id=None,
        )
    )
    session_factory = client.app.state.session_factory
    barrier = Barrier(2)

    def attempt_commit() -> tuple[str, int | str]:
        with session_factory() as db:
            barrier.wait(timeout=5)
            try:
                generation = commit_generation(db, user_id=int(user["id"]), payload=payload)
            except DomainError as exc:
                return ("conflict", exc.status_code)
            return ("success", generation.public_id)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _unused: attempt_commit(), range(2)))
    assert sorted(result[0] for result in results) == ["conflict", "success"]
    assert [result for result in results if result[0] == "conflict"] == [("conflict", 409)]
    with session_factory() as db:
        active = db.scalars(
            select(RecoveryGeneration).where(
                RecoveryGeneration.user_id == int(user["id"]),
                RecoveryGeneration.scope_key == scope_key,
                RecoveryGeneration.status == "active",
            )
        ).all()
    assert len(active) == 1


def test_recovery_generation_rejects_missing_and_mismatched_uploaded_objects(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    create_user(client, admin_headers)
    headers = login_user(client)
    chunk_id = _opaque_id("x")
    body = b"x" * 96
    missing = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(_opaque_id("q"), chunk_id, [_reference(chunk_id, body)]),
    )
    assert missing.status_code == 409
    response = client.put(
        f"/api/recovery/objects/{chunk_id}",
        headers={
            **headers,
            "Content-Type": "application/octet-stream",
            "X-Recovery-Cipher-Sha256": "0" * 64,
            "X-Recovery-Cipher-Bytes": str(len(body)),
        },
        content=body,
    )
    assert response.status_code == 422


def test_recovery_staged_objects_are_bounded_and_expired_staging_is_reclaimed_on_next_upload(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    user = create_user(client, admin_headers)
    headers = login_user(client)
    first_chunk = _opaque_id("u")
    first_body = b"u" * 80
    with patch("app.services.recovery_service.MAX_STAGED_OBJECT_BYTES_PER_USER", 120):
        assert _upload(client, headers, first_chunk, first_body)["reused"] is False
        blocked_body = b"v" * 64
        blocked = client.put(
            f"/api/recovery/objects/{_opaque_id('v')}",
            headers={
                **headers,
                "Content-Type": "application/octet-stream",
                "X-Recovery-Cipher-Sha256": hashlib.sha256(blocked_body).hexdigest(),
                "X-Recovery-Cipher-Bytes": str(len(blocked_body)),
            },
            content=blocked_body,
        )
        assert blocked.status_code == 413
        assert _upload(client, headers, first_chunk, first_body)["reused"] is True

        with client.app.state.session_factory() as db:
            staged = db.scalar(
                select(RecoveryObject).where(
                    RecoveryObject.user_id == int(user["id"]),
                    RecoveryObject.chunk_id == first_chunk,
                )
            )
            assert staged is not None
            staged.created_at = datetime.now(UTC) - timedelta(hours=25)
            db.commit()

        replacement_body = b"w" * 100
        assert _upload(client, headers, _opaque_id("w"), replacement_body)["reused"] is False
        with client.app.state.session_factory() as db:
            assert (
                db.scalar(
                    select(RecoveryObject).where(
                        RecoveryObject.user_id == int(user["id"]),
                        RecoveryObject.chunk_id == first_chunk,
                    )
                )
                is None
            )


def test_recovery_accepts_one_full_30_mib_encrypted_generation_without_relaxing_other_body_limits(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    create_user(client, admin_headers)
    headers = login_user(client)
    chunk_id = _opaque_id("z")
    body = b"z" * (30 * 1024 * 1024)
    uploaded = _upload(client, headers, chunk_id, body)
    assert uploaded["cipher_bytes"] == len(body)
    committed = client.post(
        "/api/recovery/generations",
        headers=headers,
        json=_commit_payload(_opaque_id("w"), chunk_id, [_reference(chunk_id, body)]),
    )
    assert committed.status_code == 201, committed.text
    assert committed.json()["logical_cipher_bytes"] == 30 * 1024 * 1024

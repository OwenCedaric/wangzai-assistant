from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from license_sdk import Ed25519OfflineTokenVerifier, OfflineCacheError, OfflineUnavailableError
from license_sdk.offline import OfflineGrantCache

DEVICE_CODE = "DEV-TEST-12345678"
UTC = timezone.utc


def test_offline_grant_is_clamped_to_72_hours(tmp_path: Path, signing_material) -> None:
    now = datetime(2026, 7, 11, 8, tzinfo=UTC)
    current = [now]
    token = signing_material["sign"](
        device_code=DEVICE_CODE,
        now=now,
        hours=120,
        extra={"expire": "2027-01-01"},
    )
    verifier = Ed25519OfflineTokenVerifier({"test-key": signing_material["public_pem"]})
    cache = OfflineGrantCache(
        project_code="sample_app",
        device_code=DEVICE_CODE,
        verifier=verifier,
        cache_directory=tmp_path,
        clock=lambda: current[0],
    )
    grant = cache.store(token)
    assert grant.offline_until == now + timedelta(hours=72)

    current[0] = now + timedelta(hours=72, seconds=1)
    with pytest.raises(OfflineUnavailableError):
        cache.load()


def test_grant_is_bound_to_exact_project_and_device(tmp_path: Path, signing_material) -> None:
    token = signing_material["sign"](device_code="DEV-OTHER-12345678")
    verifier = Ed25519OfflineTokenVerifier({"test-key": signing_material["public_pem"]})
    cache = OfflineGrantCache(
        project_code="sample_app",
        device_code=DEVICE_CODE,
        verifier=verifier,
        cache_directory=tmp_path,
    )
    with pytest.raises(OfflineCacheError):
        cache.store(token)


def test_clock_rollback_before_issue_time_is_rejected(tmp_path: Path, signing_material) -> None:
    issued_at = datetime.now(UTC) + timedelta(hours=1)
    token = signing_material["sign"](device_code=DEVICE_CODE, now=issued_at)
    verifier = Ed25519OfflineTokenVerifier({"test-key": signing_material["public_pem"]})
    cache = OfflineGrantCache(
        project_code="sample_app",
        device_code=DEVICE_CODE,
        verifier=verifier,
        cache_directory=tmp_path,
    )
    with pytest.raises(OfflineCacheError):
        cache.store(token)


@pytest.mark.parametrize(
    ("issuer", "audience"),
    [
        (None, "license-center-clients"),
        ("license-center", None),
        ("untrusted-issuer", "license-center-clients"),
        ("license-center", "untrusted-audience"),
    ],
)
def test_missing_or_mismatched_issuer_and_audience_are_rejected(
    tmp_path: Path,
    signing_material,
    issuer: str | None,
    audience: str | None,
) -> None:
    token = signing_material["sign"](
        device_code=DEVICE_CODE,
        issuer=issuer,
        audience=audience,
    )
    verifier = Ed25519OfflineTokenVerifier({"test-key": signing_material["public_pem"]})
    cache = OfflineGrantCache(
        project_code="sample_app",
        device_code=DEVICE_CODE,
        verifier=verifier,
        cache_directory=tmp_path,
    )
    with pytest.raises(OfflineCacheError):
        cache.store(token)


def test_custom_issuer_and_audience_are_accepted_when_explicitly_configured(
    tmp_path: Path, signing_material
) -> None:
    token = signing_material["sign"](
        device_code=DEVICE_CODE,
        issuer="https://licenses.example.test",
        audience="example-desktop-clients",
    )
    verifier = Ed25519OfflineTokenVerifier(
        {"test-key": signing_material["public_pem"]},
        issuer="https://licenses.example.test",
        audience="example-desktop-clients",
    )
    cache = OfflineGrantCache(
        project_code="sample_app",
        device_code=DEVICE_CODE,
        verifier=verifier,
        cache_directory=tmp_path,
    )
    assert cache.store(token).project_code == "sample_app"

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from urllib.parse import parse_qs

import httpx
from sqlalchemy import select

from app.auth.offline import load_offline_private_key
from app.models.oss_management import OssManagementConfiguration
from app.models.tracking import UsageLog
from app.services.oss_management import AliyunOssUsageClient


def configuration_payload(**overrides):
    value = {
        "name": "旺崽香港OSS",
        "region": "oss-cn-hongkong",
        "bucket": "wangzai-images",
        "endpoint": "https://oss-cn-hongkong.aliyuncs.com",
        "accelerate_endpoint": "https://oss-accelerate.aliyuncs.com",
        "acceleration_enabled": True,
        "access_key_id": "LTAI5tExampleAccessKey",
        "access_key_secret": "example-secret-value-123456",
        "object_access_key_id": "LTAI5tExampleObjectKey",
        "object_access_key_secret": "example-object-secret-value-123456",
        "storage_price_cny_per_gb_month": "0.136",
        "network_out_price_cny_per_gb": "0.75",
        "acceleration_price_cny_per_gb": "1.25",
    }
    value.update(overrides)
    return value


class FakeUsageClient:
    def __init__(self, records):
        self.records = records
        self.calls = []
        self.closed = False

    def query_hourly(self, start_time, end_time):
        self.calls.append((start_time, end_time))
        return self.records

    def close(self):
        self.closed = True


class FakeImageSourceStager:
    def __init__(self):
        self.verified = False
        self.closed = False

    def verify_read_write_delete(self):
        self.verified = True

    def close(self):
        self.closed = True


def test_admin_oss_configuration_encrypts_credentials_and_never_returns_them(
    client, admin_headers
):
    assert client.get("/api/admin/oss/configuration").status_code == 401
    empty = client.get("/api/admin/oss/configuration", headers=admin_headers)
    assert empty.status_code == 200
    assert empty.json() == {
        "configured": False,
        "name": None,
        "region": None,
        "bucket": None,
        "endpoint": None,
        "accelerate_endpoint": None,
        "acceleration_enabled": False,
        "runtime_revision": 0,
        "masked_access_key_id": None,
        "masked_object_access_key_id": None,
        "status": "unconfigured",
        "last_verified_at": None,
        "last_usage_sync_at": None,
        "last_error_code": None,
        "storage_price_cny_per_gb_month": "0.136",
        "network_out_price_cny_per_gb": "0.750",
        "acceleration_price_cny_per_gb": "1.250",
    }

    response = client.put(
        "/api/admin/oss/configuration",
        headers=admin_headers,
        json=configuration_payload(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["configured"] is True
    assert body["bucket"] == "wangzai-images"
    assert body["region"] == "oss-cn-hongkong"
    assert body["masked_access_key_id"].startswith("LTAI")
    assert body["masked_object_access_key_id"].startswith("LTAI")
    assert "access_key_id" not in body
    assert "access_key_secret" not in body
    assert "object_access_key_id" not in body
    assert "object_access_key_secret" not in body
    assert "example-secret" not in response.text
    assert client.get("/api/oss/runtime-configuration").status_code == 404

    with client.app.state.session_factory() as db:
        config = db.scalar(select(OssManagementConfiguration))
        assert config is not None
        assert config.access_key_id_ciphertext != "LTAI5tExampleAccessKey"
        assert config.access_key_secret_ciphertext != "example-secret-value-123456"
        assert config.object_access_key_id_ciphertext != "LTAI5tExampleObjectKey"
        assert (
            config.object_access_key_secret_ciphertext
            != "example-object-secret-value-123456"
        )
        log = db.scalar(
            select(UsageLog).where(UsageLog.event == "admin.oss.configuration_saved")
        )
        assert log is not None
        assert "secret" not in str(log.details).lower()
        assert "LTAI5tExampleAccessKey" not in str(log.details)

    preserved = configuration_payload(
        name="旺崽香港OSS新名称",
        access_key_id=None,
        access_key_secret=None,
        object_access_key_id=None,
        object_access_key_secret=None,
    )
    second = client.put(
        "/api/admin/oss/configuration", headers=admin_headers, json=preserved
    )
    assert second.status_code == 200
    assert second.json()["name"] == "旺崽香港OSS新名称"


def test_admin_oss_rejects_non_aliyun_or_unsafe_endpoints(client, admin_headers):
    for patch in (
        {"endpoint": "http://oss-cn-hongkong.aliyuncs.com"},
        {"endpoint": "https://example.com"},
        {"endpoint": "https://evil-oss.aliyuncs.com"},
        {"endpoint": "https://oss-cn-shanghai.aliyuncs.com"},
        {"endpoint": "https://oss-cn-hongkong.aliyuncs.com/path"},
        {"accelerate_endpoint": "https://evil.example.com"},
    ):
        response = client.put(
            "/api/admin/oss/configuration",
            headers=admin_headers,
            json=configuration_payload(**patch),
        )
        assert response.status_code == 422, (patch, response.text)


def test_admin_oss_test_and_usage_return_only_selected_bucket_metrics(
    client, admin_headers
):
    saved = client.put(
        "/api/admin/oss/configuration",
        headers=admin_headers,
        json=configuration_payload(),
    )
    assert saved.status_code == 200
    gib = 1024**3
    records = [
        {
            "Bucket": "wangzai-images",
            "Region": "cn-hongkong",
            "StartTime": "2026-08-28T00:00:00Z",
            "EndTime": "2026-08-28T01:00:00Z",
            "Storage": str(10 * gib),
            "NetworkIn": str(gib),
            "NetworkOut": str(2 * gib),
            "AccM2OIn": str(gib),
            "AccM2OOut": str(3 * gib),
            "GetRequest": "100",
            "PutRequest": "20",
            "ProcessImgSize": str(gib // 2),
        },
        {
            "Bucket": "wangzai-images",
            "Region": "cn-hongkong",
            "StartTime": "2026-08-28T01:00:00Z",
            "EndTime": "2026-08-28T02:00:00Z",
            "Storage": str(11 * gib),
            "NetworkOut": str(gib),
            "AccM2OOut": str(gib),
            "GetRequest": "50",
            "PutRequest": "10",
        },
        {
            "Bucket": "another-bucket",
            "Region": "cn-hongkong",
            "StartTime": "2026-08-28T01:00:00Z",
            "EndTime": "2026-08-28T02:00:00Z",
            "Storage": str(999 * gib),
            "NetworkOut": str(999 * gib),
        },
    ]
    fake = FakeUsageClient(records)
    fake_stager = FakeImageSourceStager()
    client.app.state.oss_usage_client_factory = lambda _config, _settings: fake
    client.app.state.oss_image_source_stager_factory = (
        lambda _config, _settings: fake_stager
    )

    verified = client.post("/api/admin/oss/test", headers=admin_headers)
    assert verified.status_code == 200
    assert verified.json()["status"] == "active"

    runtime = client.get("/api/oss/runtime-configuration")
    assert runtime.status_code == 200
    envelope = runtime.json()
    assert envelope["contract"] == "wangzai-oss-runtime-config/v1"
    assert envelope["config_version"] == verified.json()["runtime_revision"]
    assert "access_key" not in runtime.text.lower()
    signature = envelope.pop("signature")
    canonical = json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    padding = "=" * (-len(signature) % 4)
    private_key = load_offline_private_key(client.app.state.settings)
    assert private_key is not None
    private_key.public_key().verify(
        base64.urlsafe_b64decode(signature + padding), canonical.encode()
    )

    response = client.get(
        "/api/admin/oss/usage?hours=24", headers=admin_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sample_count"] == 2
    assert body["current_storage_bytes"] == 11 * gib
    assert body["network_out_bytes"] == 3 * gib
    assert body["acceleration_in_bytes"] == gib
    assert body["acceleration_out_bytes"] == 4 * gib
    assert body["get_requests"] == 150
    assert body["put_requests"] == 30
    assert body["estimated_storage_monthly_cny"] == "1.50"
    assert body["estimated_period_network_out_cny"] == "2.25"
    assert body["estimated_period_acceleration_cny"] == "6.25"
    assert body["estimated_total_cny"] == "10.00"
    assert len(body["points"]) == 2
    assert fake.closed is True
    assert fake_stager.verified is True
    assert fake_stager.closed is True


def test_admin_oss_normalizes_region_for_runtime_and_billing(client, admin_headers):
    saved = client.put(
        "/api/admin/oss/configuration",
        headers=admin_headers,
        json=configuration_payload(region="cn-hongkong"),
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["region"] == "oss-cn-hongkong"

    fake = FakeUsageClient(
        [{
            "Bucket": "wangzai-images",
            "Region": "cn-hongkong",
            "StartTime": "2026-08-28T00:00:00Z",
            "EndTime": "2026-08-28T01:00:00Z",
            "Storage": "1024",
        }]
    )
    client.app.state.oss_usage_client_factory = lambda _config, _settings: fake
    client.app.state.oss_image_source_stager_factory = (
        lambda _config, _settings: FakeImageSourceStager()
    )
    assert client.post("/api/admin/oss/test", headers=admin_headers).status_code == 200
    usage = client.get("/api/admin/oss/usage?hours=24", headers=admin_headers)
    assert usage.status_code == 200, usage.text
    assert usage.json()["sample_count"] == 1


def test_aliyun_usage_client_signs_and_paginates_without_exposing_secret():
    seen_bodies = []

    def handler(request: httpx.Request):
        params = parse_qs(request.content.decode())
        seen_bodies.append(params)
        marker = params.get("Marker", [""])[0]
        payload = {
            "Success": True,
            "Code": "Success",
            "Data": {
                "Marker": "next" if not marker else "",
                "OmsData": [{"Bucket": "bucket-a", "Region": "cn-hongkong"}],
            },
        }
        return httpx.Response(200, json=payload)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    usage = AliyunOssUsageClient(
        "LTAI5tExampleAccessKey",
        "never-serialize-this-secret",
        client=http,
    )
    rows = usage.query_hourly(
        datetime(2026, 8, 28, tzinfo=UTC),
        datetime(2026, 8, 29, tzinfo=UTC),
    )
    assert len(rows) == 2
    assert len(seen_bodies) == 2
    assert seen_bodies[0]["Action"] == ["QueryUserOmsData"]
    assert seen_bodies[0]["Version"] == ["2017-12-14"]
    assert "Signature" in seen_bodies[0]
    assert "never-serialize-this-secret" not in str(seen_bodies)
    assert seen_bodies[1]["Marker"] == ["next"]
    http.close()

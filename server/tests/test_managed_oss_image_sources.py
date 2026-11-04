from __future__ import annotations

import base64
from datetime import UTC, datetime
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest

from app.services.errors import DomainError
from app.services.managed_oss_image_sources import AliyunManagedOssImageSourceStager

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
FIXED_NOW = datetime(2026, 9, 2, 3, 4, 5, tzinfo=UTC)


def _stager(monkeypatch, handler, *, resolver=lambda _hostname: ["93.184.216.34"]):
    monkeypatch.setattr(
        "app.services.managed_oss_image_sources.configuration_object_credentials",
        lambda _config, _settings: ("LTAI5tExampleManagedOnly", "server-only-secret"),
    )
    config = SimpleNamespace(
        status="active",
        bucket="example-images",
        endpoint="https://oss-cn-hongkong.aliyuncs.com",
    )
    settings = SimpleNamespace(
        paid_source_image_allowed_host_set={
            "example-images.oss-cn-hongkong.aliyuncs.com"
        }
    )
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return (
        AliyunManagedOssImageSourceStager(
            config,
            settings,
            client=client,
            now=lambda: FIXED_NOW,
            resolver=resolver,
            sleep=lambda _seconds: None,
        ),
        client,
    )


def test_management_stages_bytes_to_its_regional_oss_and_deletes_them(monkeypatch):
    observed = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        if request.method == "PUT":
            assert request.content == PNG_1X1
            assert request.headers["content-type"] == "image/png"
            assert request.headers["authorization"].startswith("OSS LTAI5tExampleManagedOnly:")
            assert "server-only-secret" not in str(request.headers)
            return httpx.Response(200)
        if request.method == "DELETE":
            return httpx.Response(204)
        raise AssertionError(request.method)

    stager, client = _stager(monkeypatch, handler)
    staged = stager.stage(
        [f"data:image/png;base64,{base64.b64encode(PNG_1X1).decode()}"],
        user_id=101,
        project_id=202,
        shop_id="shop-303",
        request_id="request-404",
    )

    assert len(staged.object_keys) == 1
    assert staged.object_keys[0].startswith("wangzai/temp/model-sources/v1/")
    assert "shop-303" not in staged.object_keys[0]
    assert staged.urls[0].startswith(
        "https://example-images.oss-cn-hongkong.aliyuncs.com/"
    )
    query = parse_qs(staged.urls[0].split("?", 1)[1])
    assert query["OSSAccessKeyId"] == ["LTAI5tExampleManagedOnly"]
    assert "Signature" in query
    assert "server-only-secret" not in staged.urls[0]

    stager.cleanup(staged.object_keys)
    assert [request.method for request in observed] == ["PUT", "DELETE"]
    client.close()


def test_management_compatibly_downloads_an_old_client_url_then_stages_it(monkeypatch):
    methods = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append((request.method, request.url.host))
        if request.method == "GET" and request.url.host == "cbu01.alicdn.com":
            return httpx.Response(
                200,
                content=PNG_1X1,
                headers={"content-type": "image/png"},
            )
        if request.method == "PUT":
            return httpx.Response(200)
        if request.method == "DELETE":
            return httpx.Response(204)
        raise AssertionError(request.url)

    stager, client = _stager(monkeypatch, handler)
    staged = stager.stage(
        ["https://cbu01.alicdn.com/source.png"],
        user_id=1,
        project_id=2,
        shop_id="shop-3",
        request_id="request-4",
    )
    stager.cleanup(staged.object_keys)
    assert methods == [
        ("GET", "cbu01.alicdn.com"),
        ("PUT", "example-images.oss-cn-hongkong.aliyuncs.com"),
        ("DELETE", "example-images.oss-cn-hongkong.aliyuncs.com"),
    ]
    client.close()


def test_management_rejects_private_old_client_urls_before_fetch(monkeypatch):
    stager, client = _stager(
        monkeypatch,
        lambda request: (_ for _ in ()).throw(AssertionError(request.url)),
        resolver=lambda _hostname: ["127.0.0.1"],
    )
    with pytest.raises(DomainError, match="本机或内网"):
        stager.stage(
            ["https://internal.example/source.png"],
            user_id=1,
            project_id=2,
            shop_id="shop-3",
            request_id="request-4",
        )
    client.close()


def test_management_oss_verification_covers_put_get_and_delete(monkeypatch):
    methods = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        if request.method == "PUT":
            return httpx.Response(200)
        if request.method == "GET":
            return httpx.Response(200, content=PNG_1X1)
        if request.method == "DELETE":
            return httpx.Response(204)
        raise AssertionError(request.method)

    stager, client = _stager(monkeypatch, handler)
    stager.verify_read_write_delete()
    assert methods == ["PUT", "GET", "DELETE"]
    client.close()


def test_management_retries_transient_oss_upload_without_repeating_image_generation(monkeypatch):
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        if request.method == "PUT":
            attempts += 1
            if attempts == 1:
                raise httpx.ConnectError("temporary connect failure", request=request)
            if attempts == 2:
                return httpx.Response(503)
            return httpx.Response(200)
        if request.method == "DELETE":
            return httpx.Response(204)
        raise AssertionError(request.method)

    stager, client = _stager(monkeypatch, handler)
    staged = stager.stage(
        [f"data:image/png;base64,{base64.b64encode(PNG_1X1).decode()}"],
        user_id=1,
        project_id=2,
        shop_id="shop-3",
        request_id="retry-request",
    )

    assert attempts == 3
    assert len(staged.urls) == 1
    stager.cleanup(staged.object_keys)
    client.close()

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
from fastapi.testclient import TestClient

from app.core_v2.image_model import execute_byok_image_model, execute_paid_image_model
from app.schemas.core_v2 import ImageModelExecutionRequest


def _payload(**updates) -> ImageModelExecutionRequest:
    values = {
        "capability": "image.generate",
        "request_id": "image-request-12345678",
        "shop_id": "shop-1",
        "template_id": "product-image-generation.v1",
        "template_input": {
            "generationMode": "fast",
            "product": {"title": "黑色保温杯", "skuFacts": "黑色，500ml"},
            "image": {"group": "main", "sourceIndex": 0},
        },
        "size": "1008x1344",
        "quality": "2k",
        "byok": {
            "account_id": "model-image",
            "base_url": "https://images.example.invalid/v1",
            "api_key": "temporary-image-secret",
            "model": "gpt-image-2",
        },
    }
    values.update(updates)
    return ImageModelExecutionRequest(**values)


def test_byok_image_generation_uses_only_the_server_rendered_prompt() -> None:
    observed: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        assert request.headers["Authorization"] == "Bearer temporary-image-secret"
        body = json.loads(request.content)
        assert body["model"] == "gpt-image-2"
        assert "黑色保温杯" in body["prompt"]
        assert "商品外观以参考图为唯一视觉事实来源" in body["prompt"]
        assert "promptTemplateInput" not in body["prompt"]
        return httpx.Response(
            200,
            json={"data": [{"url": "https://images.example/generated.webp"}]},
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = execute_byok_image_model(
            _payload(),
            resolver=lambda _hostname: ["93.184.216.34"],
            client=client,
        )

    assert result == {
        "ok": True,
        "images": [{"url": "https://images.example/generated.webp", "b64_json": ""}],
        "model": "gpt-image-2",
        "account_id": "model-image",
        "billing": None,
    }
    assert [request.url.path for request in observed] == ["/v1/images/generations"]
    assert "temporary-image-secret" not in str(result)


def test_byok_image_edit_accepts_an_inline_source_without_persisting_it() -> None:
    observed: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        assert request.url.path == "/v1/images/edits"
        assert b"source-0.png" in request.content
        assert b"product-image-generation.v1" not in request.content
        assert "黑色保温杯".encode() in request.content
        return httpx.Response(200, json={"data": [{"b64_json": "aW1hZ2U="}]})

    payload = _payload(
        capability="image.edit",
        source_images=["data:image/png;base64,aW1hZ2U="],
    )
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = execute_byok_image_model(
            payload,
            resolver=lambda _hostname: ["93.184.216.34"],
            client=client,
        )

    assert result["images"] == [{"url": "", "b64_json": "aW1hZ2U="}]
    assert len(observed) == 1


def test_paid_image_execution_erases_the_provider_result_after_the_response(monkeypatch) -> None:
    observed = {}
    descriptor = SimpleNamespace(
        normalize=lambda value: {**value},
        capability="image.generate",
        version=1,
    )
    quote = SimpleNamespace(id="quote-image-1")
    job = SimpleNamespace(
        result_json={"images": [{"url": "https://images.example/paid.webp"}]},
        reservation=SimpleNamespace(settled_points=96),
    )

    class Database:
        commits = 0

        def commit(self):
            self.commits += 1

    database = Database()
    monkeypatch.setattr("app.core_v2.image_model.get_paid_capability", lambda *_args: descriptor)
    monkeypatch.setattr("app.core_v2.image_model.issue_quote", lambda *_args, **_kwargs: quote)
    monkeypatch.setattr("app.core_v2.image_model.paid_input_hash", lambda _value: "sha256:input")

    def execute(*_args, **kwargs):
        observed.update(kwargs)
        return job

    monkeypatch.setattr("app.core_v2.image_model.execute_paid_capability", execute)
    result = execute_paid_image_model(
        _payload(byok=None),
        db=database,
        user_id=10,
        project_id=20,
        settings=SimpleNamespace(
            paid_capability_quote_ttl_seconds=30,
            paid_text_reservation_multiplier_ppm=1_250_000,
            paid_image_reservation_multiplier_ppm=2_000_000,
        ),
        provider=object(),
    )

    assert result["images"] == [{"url": "https://images.example/paid.webp", "b64_json": ""}]
    assert result["billing"] == {"chargedPoints": 96, "source": "paid-cloud"}
    assert observed["idempotency_key"].startswith("core-v2-image:")
    assert database.commits == 1
    assert job.result_json["retained"] is False
    assert "https://images.example/paid.webp" not in str(job.result_json)


def test_paid_image_edit_uses_management_oss_and_cleans_the_temporary_source(
    monkeypatch,
) -> None:
    observed = {}
    cleaned = []
    descriptor = SimpleNamespace(
        normalize=lambda value: {**value},
        capability="image.edit",
        version=1,
    )
    quote = SimpleNamespace(id="quote-image-edit-1")
    job = SimpleNamespace(
        result_json={"images": [{"url": "https://images.example/paid-edit.webp"}]},
        reservation=SimpleNamespace(settled_points=96),
    )

    class Database:
        commits = 0

        def commit(self):
            self.commits += 1

    class SourceStager:
        def stage(self, values, **scope):
            observed["source_values"] = values
            observed["source_scope"] = scope
            return SimpleNamespace(
                urls=[
                    "https://example-images.oss-cn-hongkong.aliyuncs.com/"
                    "wangzai/temp/model-sources/v1/source.png?OSSAccessKeyId=test&Expires=1&Signature=x"
                ],
                object_keys=["wangzai/temp/model-sources/v1/source.png"],
            )

        def cleanup(self, object_keys):
            cleaned.extend(object_keys)

    monkeypatch.setattr("app.core_v2.image_model.get_paid_capability", lambda *_args: descriptor)
    monkeypatch.setattr("app.core_v2.image_model.issue_quote", lambda *_args, **_kwargs: quote)
    monkeypatch.setattr("app.core_v2.image_model.paid_input_hash", lambda _value: "sha256:input")

    def execute(*_args, **kwargs):
        observed["normalized_input"] = kwargs["normalized_input"]
        return job

    monkeypatch.setattr("app.core_v2.image_model.execute_paid_capability", execute)
    payload = _payload(
        capability="image.edit",
        byok=None,
        source_images=["data:image/png;base64,aW1hZ2U="],
    )
    result = execute_paid_image_model(
        payload,
        db=Database(),
        user_id=10,
        project_id=20,
        settings=SimpleNamespace(
            paid_capability_quote_ttl_seconds=30,
            paid_text_reservation_multiplier_ppm=1_250_000,
            paid_image_reservation_multiplier_ppm=2_000_000,
        ),
        provider=object(),
        source_stager=SourceStager(),
    )

    assert result["images"] == [
        {"url": "https://images.example/paid-edit.webp", "b64_json": ""}
    ]
    assert observed["source_scope"] == {
        "user_id": 10,
        "project_id": 20,
        "shop_id": "shop-1",
        "request_id": "image-request-12345678",
    }
    assert observed["normalized_input"]["sourceImageUrls"][0].startswith(
        "https://example-images.oss-cn-hongkong.aliyuncs.com/"
    )
    assert cleaned == ["wangzai/temp/model-sources/v1/source.png"]


def test_image_model_route_requires_login(client: TestClient) -> None:
    response = client.post(
        "/api/core-v2/image-model/execute",
        json=_payload(byok=None).model_dump(mode="json"),
    )
    assert response.status_code == 401

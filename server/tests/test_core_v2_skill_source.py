from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core_v2.skill_source import (
    SkillSourceFailure,
    parse_github_skill_url,
    resolve_github_skill_source,
)
from tests.helpers import create_user, login_user


def test_skill_source_parser_accepts_only_explicit_github_skill_paths() -> None:
    parsed = parse_github_skill_url("https://github.com/example/tools/tree/main/skills/listing")
    assert parsed == {
        "owner": "example",
        "repository": "tools",
        "ref": "main",
        "package_path": "skills/listing",
        "skill_path": "skills/listing/SKILL.md",
    }
    with pytest.raises(SkillSourceFailure) as captured:
        parse_github_skill_url("https://example.com/example/tools/SKILL.md")
    assert captured.value.code == "SKILL_INSTALL_URL_INVALID"


def test_skill_source_resolver_downloads_bounded_docs_and_flags_executables() -> None:
    markdown = "---\nname: listing\n---\n# Listing\n\n[Guide](guide.md)\n"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/example/tools":
            return httpx.Response(200, json={"default_branch": "main"})
        if request.url.path == "/example/tools/main/SKILL.md":
            return httpx.Response(200, text=markdown)
        if request.url.path == "/repos/example/tools/git/trees/main":
            assert request.url.params["recursive"] == "1"
            return httpx.Response(
                200,
                json={
                    "tree": [
                        {"type": "blob", "path": "SKILL.md", "size": len(markdown), "sha": "a"},
                        {"type": "blob", "path": "guide.md", "size": 20, "sha": "b"},
                        {"type": "blob", "path": "scripts/run.py", "size": 20, "sha": "c"},
                    ]
                },
            )
        if request.url.path == "/example/tools/main/guide.md":
            return httpx.Response(200, text="# Guide\nSafe reference.\n")
        return httpx.Response(404)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = resolve_github_skill_source(
            {"url": "https://github.com/example/tools"},
            client=client,
        )
    source = result["source"]
    assert source["repository"] == "example/tools"
    assert source["ref"] == "main"
    assert source["markdown"] == markdown
    assert source["referenceFiles"] == [
        {"path": "guide.md", "content": "# Guide\nSafe reference.\n"}
    ]
    assert source["executableFiles"] == ["scripts/run.py"]
    assert len(source["sourceHash"]) == 64


def test_skill_source_route_is_authenticated_and_does_not_persist_payload(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch,
) -> None:
    unauthenticated = client.post(
        "/api/core-v2/legacy/api/prompt-library/skill-source/resolve",
        json={"url": "https://github.com/example/tools"},
    )
    assert unauthenticated.status_code == 401

    create_user(client, admin_headers)
    headers = login_user(client)
    monkeypatch.setattr(
        "app.api.core_v2.get_active_principal_license",
        lambda _db, _principal: object(),
    )
    observed: list[object] = []

    def resolve(payload: object) -> dict[str, object]:
        observed.append(payload)
        return {"ok": True, "source": {"markdown": "---\n---\n# Test\n"}}

    monkeypatch.setattr("app.api.core_v2.resolve_github_skill_source", resolve)
    response = client.post(
        "/api/core-v2/legacy/api/prompt-library/skill-source/resolve",
        headers=headers,
        json={"url": "https://github.com/example/tools"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["source"]["markdown"].endswith("# Test\n")
    assert observed == [{"url": "https://github.com/example/tools"}]

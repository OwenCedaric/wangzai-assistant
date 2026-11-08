from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("container_profit_environment", ROOT / "server/scripts/container-profit-environment.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def fixture_runtime(tmp_path):
    core = tmp_path / "profit-core.mjs"
    core.write_text("export const fixture = true;", encoding="utf-8")
    digest = hashlib.sha256(core.read_bytes()).hexdigest()
    manifest = tmp_path / "source-manifest.json"
    manifest.write_text(json.dumps({"contract": "wangzai-private-profit-core-build/v1", "fullPipeline": True, "codeSha256": digest}), encoding="utf-8")
    return core, manifest, {"PRIVATE_PROFIT_CORE_FILE": str(core), "PRIVATE_PROFIT_CORE_MANIFEST": str(manifest), "PRIVATE_PROFIT_NODE_EXECUTABLE": "fixture-node"}


def test_runtime_requires_matching_full_pipeline_manifest_and_node24(tmp_path, monkeypatch):
    core, manifest, env = fixture_runtime(tmp_path)
    monkeypatch.setattr(runtime.subprocess, "check_output", lambda *a, **kw: "v24.16.0\n")
    digest = runtime.verify_runtime(env)
    assert digest == hashlib.sha256(core.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match="HASH_MISMATCH"):
        runtime.verify_runtime({**env, "PRIVATE_PROFIT_CORE_SHA256": "0" * 64})
    core.write_text("changed", encoding="utf-8")
    with pytest.raises(ValueError, match="HASH_MISMATCH"):
        runtime.verify_runtime(env)
    core.unlink()
    with pytest.raises(ValueError, match="FILE_INVALID"):
        runtime.verify_runtime(env)


def test_runtime_rejects_partial_bundle_and_unsupported_node(tmp_path, monkeypatch):
    _, manifest, env = fixture_runtime(tmp_path)
    monkeypatch.setattr(runtime.subprocess, "check_output", lambda *a, **kw: "v20.0.0\n")
    with pytest.raises(ValueError, match="NODE_24_REQUIRED"):
        runtime.verify_runtime(env)
    payload = json.loads(manifest.read_text())
    payload["fullPipeline"] = False
    manifest.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="MANIFEST_INVALID"):
        runtime.verify_runtime(env)


def test_container_and_compose_include_source_built_runtime_before_api_start():
    dockerfile = (ROOT / "server/Dockerfile").read_text(encoding="utf-8")
    entry = (ROOT / "server/docker-entrypoint.sh").read_text(encoding="utf-8")
    import yaml
    compose = yaml.safe_load((ROOT / "compose.production.yaml").read_text(encoding="utf-8"))
    for role in ("migrate", "backend", "backend-heavy", "worker"):
        assert compose["services"][role]["build"] == {"context": ".", "dockerfile": "server/Dockerfile"}
    assert "COPY --from=profit-build /usr/local/bin/node" in dockerfile
    assert "--full-pipeline" in dockerfile
    assert entry.index("container-profit-environment.py") < entry.index("alembic upgrade head")
    assert 'export PRIVATE_PROFIT_CORE_SHA256="$profit_runtime_hash"' in entry

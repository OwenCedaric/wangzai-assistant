"""Validate the image-built profit bundle; print only its SHA-256 for the entrypoint."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def verify_runtime(environment=None) -> str:
    env = os.environ if environment is None else environment
    core = Path(env.get("PRIVATE_PROFIT_CORE_FILE", "/opt/wangzai/profit-core/profit-core.mjs"))
    manifest_path = Path(env.get("PRIVATE_PROFIT_CORE_MANIFEST", "/opt/wangzai/profit-core/source-manifest.json"))
    node = env.get("PRIVATE_PROFIT_NODE_EXECUTABLE", "/usr/local/bin/node")
    for file in [core, manifest_path]:
        if not file.is_absolute() or not file.is_file() or file.is_symlink() or file.resolve() != file:
            raise ValueError("PROFIT_RUNTIME_FILE_INVALID")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("contract") != "wangzai-private-profit-core-build/v1" or manifest.get("fullPipeline") is not True:
        raise ValueError("PROFIT_RUNTIME_MANIFEST_INVALID")
    digest = hashlib.sha256(core.read_bytes()).hexdigest()
    expected = env.get("PRIVATE_PROFIT_CORE_SHA256") or manifest.get("codeSha256", "")
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or digest != expected or digest != manifest.get("codeSha256"):
        raise ValueError("PROFIT_RUNTIME_HASH_MISMATCH")
    version = subprocess.check_output([node, "--version"], text=True, timeout=10).strip()
    if not re.fullmatch(r"v24\.\d+\.\d+", version):
        raise ValueError("PROFIT_RUNTIME_NODE_24_REQUIRED")
    return digest


if __name__ == "__main__":
    print(verify_runtime())

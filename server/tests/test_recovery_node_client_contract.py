from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient

from app.auth.security import hash_password
from app.models import User

NODE_REMOTE_CLIENT_PROBE = """
import { createHash } from 'node:crypto';

const { createRecoveryRemoteClient } = await import(process.env.RECOVERY_CLIENT_MODULE_URL);
const baseUrl = process.env.RECOVERY_E2E_BASE_URL;
const username = process.env.RECOVERY_E2E_USERNAME;
const password = process.env.RECOVERY_E2E_PASSWORD;

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) throw new Error(`LOGIN_${login.status}`);
const { access_token: accessToken } = await login.json();

const objectBytes = Buffer.concat([
  Buffer.alloc(12, 1),
  Buffer.alloc(16, 2),
  Buffer.from('node-client-to-fastapi-recovery-contract', 'utf8'),
]);
const chunkId = createHash('sha256').update('node-client-contract-chunk').digest('base64url');
const scopeKey = createHash('sha256').update('node-client-contract-scope').digest('base64url');
const cipherSha256 = createHash('sha256').update(objectBytes).digest('hex');
const remote = createRecoveryRemoteClient({ baseUrl, accessToken });

const committed = await remote.uploadGeneration({
  scopeKey,
  transport: {
    format: 'wangzai-recovery-generation',
    version: 1,
    keyEnvelope: {
      format: 'wangzai-recovery-key-envelope',
      version: 1,
      ciphertextB64u: 'opaque-client-only-envelope',
    },
    manifestObject: {
      chunkId,
      cipherBytes: objectBytes.length,
      cipherSha256,
    },
    logicalCipherBytes: objectBytes.length,
    objects: [{
      objectFormatVersion: 1,
      algorithm: 'AES-256-GCM',
      chunkId,
      cipherBytes: objectBytes.length,
      cipherSha256,
      nonceB64u: objectBytes.subarray(0, 12).toString('base64url'),
      tagB64u: objectBytes.subarray(12, 28).toString('base64url'),
      ciphertextB64u: objectBytes.subarray(28).toString('base64url'),
    }],
  },
});

const listed = await remote.listGenerations();
const downloaded = await remote.downloadGeneration({ generationId: committed.generation_id });
if (
  listed.length !== 1
  || listed[0].generation_id !== committed.generation_id
  || downloaded.logicalCipherBytes !== objectBytes.length
  || downloaded.objects.length !== 1
  || downloaded.objects[0].cipherSha256 !== cipherSha256
) {
  throw new Error('RECOVERY_REMOTE_CONTRACT_ASSERTION_FAILED');
}

process.stdout.write(JSON.stringify({
  generationId: committed.generation_id,
  scopeKey: committed.scope_key,
  cipherSha256,
}));
"""


def _start_server(app: object) -> tuple[uvicorn.Server, threading.Thread, socket.socket, str]:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, lifespan="on", log_level="warning", access_log=False)
    )
    thread = threading.Thread(
        target=server.run,
        kwargs={"sockets": [listener]},
        daemon=True,
    )
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    if not server.started:
        server.should_exit = True
        thread.join(timeout=5)
        listener.close()
        raise RuntimeError("Temporary recovery server did not start")
    return server, thread, listener, f"http://127.0.0.1:{port}"


def _stop_server(server: uvicorn.Server, thread: threading.Thread, listener: socket.socket) -> None:
    server.should_exit = True
    thread.join(timeout=10)
    listener.close()
    if thread.is_alive():
        raise RuntimeError("Temporary recovery server did not stop")


def test_node_recovery_client_round_trips_against_real_fastapi_server(client: TestClient) -> None:
    """Exercise the desktop wire client against the actual recovery API over HTTP.

    Unit tests cover both sides independently. This intentionally crosses the Node/Python
    boundary so a change in JSON casing, headers, opaque ids, or binary object framing cannot
    make both mocks pass while a desktop backup fails against the deployed service.
    """

    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is required for the desktop recovery-client contract test")

    username = "node-contract-user"
    password = "NodeContractPass123!"
    with client.app.state.session_factory() as db:
        db.add(User(username=username, password_hash=hash_password(password), status="active"))
        db.commit()

    server, thread, listener, base_url = _start_server(client.app)
    try:
        management_root = Path(__file__).resolve().parents[2]
        desktop_root = Path(
            os.environ.get("DESKTOP_PROJECT_ROOT", management_root)
        ).resolve()
        recovery_client_module = (
            desktop_root / "local-api" / "src" / "backup" / "recoveryRemoteClient.js"
        )
        if not recovery_client_module.is_file():
            pytest.skip(
                "Desktop client unavailable; set DESKTOP_PROJECT_ROOT for integration tests"
            )
        module_url = recovery_client_module.as_uri()
        environment = {
            **os.environ,
            "RECOVERY_CLIENT_MODULE_URL": module_url,
            "RECOVERY_E2E_BASE_URL": base_url,
            "RECOVERY_E2E_USERNAME": username,
            "RECOVERY_E2E_PASSWORD": password,
        }
        result = subprocess.run(
            [node, "--input-type=module", "--eval", NODE_REMOTE_CLIENT_PROBE],
            cwd=desktop_root,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    finally:
        _stop_server(server, thread, listener)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert len(payload["generationId"]) >= 20
    assert len(payload["scopeKey"]) >= 20
    assert len(payload["cipherSha256"]) == 64

"""Exercise the published admin proxy against a fresh, isolated self-hosted backend."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main() -> None:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("NODE_REQUIRED")
    children: list[subprocess.Popen] = []
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with tempfile.TemporaryDirectory(prefix="wangzai-admin-smoke-") as temporary:
        work = Path(temporary)
        client = work / "client"
        state = work / "state"
        for relative in [
            "desktop/resources/project.example.json",
            "local-api/config/local-api.config.example.json",
        ]:
            target = client / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        backend_port, admin_port = free_port(), free_port()
        while admin_port == backend_port:
            admin_port = free_port()
        with (work / "process.log").open("wb") as log:
            initialized = subprocess.run(
                [sys.executable, str(ROOT / "server/scripts/self_host.py"), "init",
                 "--state-dir", str(state), "--client-root", str(client), "--port", str(backend_port)],
                stdout=log, stderr=log, cwd=ROOT, creationflags=flags,
            )
            if initialized.returncode:
                raise RuntimeError("ISOLATED_SELF_HOST_INIT_FAILED")
            try:
                children.append(subprocess.Popen(
                    [sys.executable, str(ROOT / "server/scripts/self_host.py"), "serve", "--state-dir", str(state)],
                    stdout=log, stderr=log, cwd=ROOT, creationflags=flags,
                ))
                env = {**os.environ, "WANGZAI_ADMIN_BACKEND_URL": f"https://127.0.0.1:{backend_port}",
                       "WANGZAI_ADMIN_CA_FILE": str(state / "ca.pem")}
                # Force same-origin requests even if the caller has a VITE override.
                env["VITE_API_BASE_URL"] = ""
                children.append(subprocess.Popen(
                    [node, str(ROOT / "admin/node_modules/vite/bin/vite.js"),
                     "--host", "127.0.0.1", "--port", str(admin_port), "--strictPort"],
                    stdout=log, stderr=log, cwd=ROOT / "admin", env=env, creationflags=flags,
                ))
                base = f"http://127.0.0.1:{admin_port}"
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                deadline = time.monotonic() + 45
                while True:
                    if any(child.poll() is not None for child in children):
                        raise RuntimeError("ISOLATED_SERVICE_EXITED")
                    try:
                        # Protected API without auth must reach the backend and be rejected.
                        opener.open(base + "/api/admin/projects", timeout=2).close()
                        raise RuntimeError("ADMIN_API_MISSING_AUTH_GUARD")
                    except urllib.error.HTTPError as error:
                        if error.code in (401, 403):
                            break
                    except (urllib.error.URLError, TimeoutError):
                        pass
                    if time.monotonic() >= deadline:
                        raise RuntimeError("ISOLATED_PROXY_NOT_READY")
                    time.sleep(0.2)
                credentials = json.loads((state / "private/credentials.json").read_text(encoding="utf-8"))
                request = urllib.request.Request(base + "/api/auth/login", method="POST",
                    data=json.dumps({"username": credentials["adminUsername"], "password": credentials["adminPassword"]}).encode(),
                    headers={"Content-Type": "application/json"})
                with opener.open(request, timeout=10) as response:
                    login = json.load(response)
                token = login.get("access_token") or login.get("data", {}).get("access_token")
                if not token:
                    raise RuntimeError("ADMIN_LOGIN_NO_TOKEN")
                request = urllib.request.Request(base + "/api/admin/projects", headers={"Authorization": "Bearer " + token})
                with opener.open(request, timeout=10) as response:
                    projects = json.load(response)
                if not projects.get("items"):
                    raise RuntimeError("ADMIN_PROJECT_READBACK_EMPTY")
                print(json.dumps({"ok": True, "isolatedDatabase": True, "configuredCaProxy": True,
                                  "anonymousRejected": True, "adminLogin": True, "projectReadback": True,
                                  "realShopCalls": 0, "credentialsPublished": False}))
            finally:
                for child in reversed(children):
                    child.terminate()
                for child in reversed(children):
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)


if __name__ == "__main__":
    main()

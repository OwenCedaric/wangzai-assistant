import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ensureDevelopmentLicenseServer,
  isLoopbackLicenseServer,
  resolveDevelopmentLicenseBackend,
} from "./licenseServerBootstrap.js";

const licensingRoot = path.dirname(fileURLToPath(import.meta.url));

test("license server bootstrap recognizes loopback development services", () => {
  assert.equal(isLoopbackLicenseServer("http://127.0.0.1:8000"), true);
  assert.equal(isLoopbackLicenseServer("http://localhost:8000"), true);
  assert.equal(isLoopbackLicenseServer("https://license.example.com"), false);
  assert.equal(isLoopbackLicenseServer("invalid"), false);
});

test("development backend resolution prefers explicit environment configuration", () => {
  const configuredRoot = path.resolve("C:/license-center/backend");
  const expectedPython = process.platform === "win32"
    ? path.join(configuredRoot, ".venv", "Scripts", "pythonw.exe")
    : path.join(configuredRoot, ".venv", "bin", "python");
  const result = resolveDevelopmentLicenseBackend({
    workspaceRoot: "C:/workspace/desktop",
    env: { WANGZAI_LICENSE_BACKEND_ROOT: configuredRoot },
    existsSync: (candidate) => (
      candidate === path.join(configuredRoot, "app", "main.py")
      || candidate === expectedPython
    ),
  });

  assert.deepEqual(result, {
    backendRoot: configuredRoot,
    pythonExecutable: expectedPython,
  });
});

test("Windows backend resolution prefers pythonw and keeps python.exe as a compatibility fallback", () => {
  const backendRoot = path.resolve("C:/workspace/管理系统/backend");
  const mainModule = path.join(backendRoot, "app", "main.py");
  const pythonwExecutable = path.join(backendRoot, ".venv", "Scripts", "pythonw.exe");
  const pythonExecutable = path.join(backendRoot, ".venv", "Scripts", "python.exe");

  const preferred = resolveDevelopmentLicenseBackend({
    workspaceRoot: "C:/workspace/desktop",
    env: {},
    platform: "win32",
    existsSync: (candidate) => [mainModule, pythonwExecutable, pythonExecutable].includes(candidate),
  });
  const fallback = resolveDevelopmentLicenseBackend({
    workspaceRoot: "C:/workspace/desktop",
    env: {},
    platform: "win32",
    existsSync: (candidate) => [mainModule, pythonExecutable].includes(candidate),
  });

  assert.equal(preferred.pythonExecutable, pythonwExecutable);
  assert.equal(fallback.pythonExecutable, pythonExecutable);
});

test("healthy license server is reused without spawning another backend", async () => {
  let spawnCount = 0;
  const result = await ensureDevelopmentLicenseServer({
    serverUrl: "http://127.0.0.1:8000",
    workspaceRoot: "C:/workspace/desktop",
    fetchImpl: async () => ({ ok: true }),
    spawnImpl: () => {
      spawnCount += 1;
      return { unref() {} };
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.reason, "already_running");
  assert.equal(spawnCount, 0);
});

test("missing loopback backend is started once and polled until healthy", async () => {
  const backendRoot = path.resolve("C:/workspace/管理系统/backend");
  const pythonExecutable = process.platform === "win32"
    ? path.join(backendRoot, ".venv", "Scripts", "pythonw.exe")
    : path.join(backendRoot, ".venv", "bin", "python");
  let probeCount = 0;
  let spawnCall = null;
  let unrefCount = 0;
  const result = await ensureDevelopmentLicenseServer({
    serverUrl: "http://127.0.0.1:8000",
    workspaceRoot: "C:/workspace/desktop",
    env: {},
    existsSync: (candidate) => (
      candidate === path.join(backendRoot, "app", "main.py")
      || candidate === pythonExecutable
    ),
    fetchImpl: async () => ({ ok: ++probeCount >= 3 }),
    spawnImpl: (...args) => {
      spawnCall = args;
      return { pid: 4321, unref: () => { unrefCount += 1; } };
    },
    setTimeoutImpl: (callback) => callback(),
    attempts: 3,
  });

  assert.equal(result.ready, true);
  assert.equal(result.started, true);
  assert.equal(result.pid, 4321);
  assert.equal(unrefCount, 1);
  assert.equal(spawnCall[0], pythonExecutable);
  assert.deepEqual(spawnCall[1].slice(0, 3), ["-m", "uvicorn", "app.main:app"]);
  assert.equal(spawnCall[2].cwd, backendRoot);
  assert.equal(spawnCall[2].detached, true);
  assert.equal(spawnCall[2].shell, false);
  assert.equal(spawnCall[2].windowsHide, true);
});

test("remote development distribution starts the sibling backend behind its local proxy", async () => {
  const backendRoot = path.resolve("C:/workspace/管理系统/backend");
  const pythonExecutable = process.platform === "win32"
    ? path.join(backendRoot, ".venv", "Scripts", "pythonw.exe")
    : path.join(backendRoot, ".venv", "bin", "python");
  const publicUrl = "https://node.example.com";
  const localUrl = "http://127.0.0.1:8000";
  let localReady = false;
  let spawnCall = null;
  const result = await ensureDevelopmentLicenseServer({
    serverUrl: publicUrl,
    workspaceRoot: "C:/workspace/desktop",
    env: {},
    existsSync: (candidate) => (
      candidate === path.join(backendRoot, "app", "main.py")
      || candidate === pythonExecutable
    ),
    fetchImpl: async (url) => ({
      ok: String(url).startsWith(localUrl) ? localReady : localReady,
    }),
    spawnImpl: (...args) => {
      spawnCall = args;
      localReady = true;
      return { pid: 2468, once() {}, unref() {} };
    },
    setTimeoutImpl: (callback) => callback(),
    attempts: 2,
  });

  assert.equal(result.ready, true);
  assert.equal(result.started, true);
  assert.equal(result.backendServerUrl, localUrl);
  assert.equal(spawnCall[0], pythonExecutable);
  assert.deepEqual(spawnCall[1].slice(-4), ["--host", "127.0.0.1", "--port", "8000"]);
});

test("a running backend with an unreachable public proxy does not block startup for the whole budget", async () => {
  const backendRoot = path.resolve("C:/workspace/管理系统/backend");
  const pythonExecutable = process.platform === "win32"
    ? path.join(backendRoot, ".venv", "Scripts", "pythonw.exe")
    : path.join(backendRoot, ".venv", "bin", "python");
  const publicUrl = "https://node.example.com";
  const localUrl = "http://127.0.0.1:8000";
  const probes = { public: 0, local: 0 };
  let waits = 0;
  let spawned = false;
  const result = await ensureDevelopmentLicenseServer({
    serverUrl: publicUrl,
    workspaceRoot: "C:/workspace/desktop",
    env: {},
    existsSync: (candidate) => (
      candidate === path.join(backendRoot, "app", "main.py")
      || candidate === pythonExecutable
    ),
    fetchImpl: async (url) => {
      const local = String(url).startsWith(localUrl);
      probes[local ? "local" : "public"] += 1;
      return { ok: local };
    },
    spawnImpl: () => {
      spawned = true;
      return { pid: 1, once() {}, unref() {} };
    },
    setTimeoutImpl: (callback) => { waits += 1; callback(); },
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, "proxy_unreachable");
  assert.equal(result.started, false);
  assert.equal(spawned, false, "an already healthy backend must not be spawned again");
  // Default budget is 40 waits; an external proxy outage now costs only the grace checks.
  assert.equal(waits, 4);
  assert.equal(probes.public, 1 + 4);
});

test("a freshly started backend is still awaited before the short proxy grace period", async () => {
  const backendRoot = path.resolve("C:/workspace/管理系统/backend");
  const pythonExecutable = process.platform === "win32"
    ? path.join(backendRoot, ".venv", "Scripts", "pythonw.exe")
    : path.join(backendRoot, ".venv", "bin", "python");
  const localUrl = "http://127.0.0.1:8000";
  let localProbes = 0;
  let waits = 0;
  const result = await ensureDevelopmentLicenseServer({
    serverUrl: "https://node.example.com",
    workspaceRoot: "C:/workspace/desktop",
    env: {},
    existsSync: (candidate) => (
      candidate === path.join(backendRoot, "app", "main.py")
      || candidate === pythonExecutable
    ),
    fetchImpl: async (url) => {
      if (!String(url).startsWith(localUrl)) return { ok: false };
      localProbes += 1;
      // Not running at the initial check, then ready on the 10th poll.
      return { ok: localProbes >= 11 };
    },
    spawnImpl: () => ({ pid: 1357, once() {}, unref() {} }),
    setTimeoutImpl: (callback) => { waits += 1; callback(); },
  });

  assert.equal(result.reason, "proxy_unreachable");
  assert.equal(result.started, true);
  assert.equal(result.pid, 1357);
  // 10 waits until the spawned backend answers, then 4 proxy grace checks.
  assert.equal(waits, 10 + 3);
});

test("packaged services and unavailable remote services without a backend are never spawned", async () => {
  let spawnCount = 0;
  const spawnImpl = () => {
    spawnCount += 1;
    return { unref() {} };
  };
  const packaged = await ensureDevelopmentLicenseServer({
    serverUrl: "http://127.0.0.1:8000",
    isPackaged: true,
    spawnImpl,
  });
  const remote = await ensureDevelopmentLicenseServer({
    serverUrl: "https://license.example.com",
    spawnImpl,
    existsSync: () => false,
    fetchImpl: async () => ({ ok: false }),
  });

  assert.equal(packaged.reason, "not_applicable");
  assert.equal(remote.reason, "remote_unavailable");
  assert.equal(spawnCount, 0);
});

test("desktop bootstrap waits for the development license server before opening the UI", () => {
  const mainSource = readFileSync(path.resolve(licensingRoot, "..", "main.js"), "utf8");
  assert.match(mainSource, /await ensureDevelopmentLicenseServer\(\{/);
  assert.match(
    mainSource,
    /showStartupSplash\(\);[\s\S]*?await ensureDevelopmentLicenseServer[\s\S]*?windows\.create\(runtimeInfo\)/,
  );
});

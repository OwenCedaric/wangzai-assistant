import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function normalizePath(value) {
  return String(value || "").trim();
}

function createHealthUrl(serverUrl) {
  const parsed = new URL(serverUrl);
  parsed.pathname = "/health";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function resolveDevelopmentBackendServerUrl(serverUrl, env = process.env) {
  const configured = normalizePath(env.WANGZAI_LICENSE_BACKEND_URL);
  const candidate = configured || (isLoopbackLicenseServer(serverUrl)
    ? serverUrl
    : "http://127.0.0.1:8000");
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("开发授权后端必须绑定本机 HTTP 地址");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

async function wait(delayMs, setTimeoutImpl) {
  await new Promise((resolve) => setTimeoutImpl(resolve, delayMs));
}

export function isLoopbackLicenseServer(serverUrl) {
  try {
    return LOOPBACK_HOSTS.has(new URL(serverUrl).hostname);
  } catch {
    return false;
  }
}

export function resolveDevelopmentLicenseBackend({
  workspaceRoot,
  env = process.env,
  existsSync = fs.existsSync,
  platform = process.platform,
} = {}) {
  const configuredRoot = normalizePath(env.WANGZAI_LICENSE_BACKEND_ROOT);
  const candidates = [
    configuredRoot,
    workspaceRoot
      ? path.resolve(workspaceRoot, "..", "管理系统", "backend")
      : "",
  ].filter(Boolean);

  for (const backendRoot of [...new Set(candidates.map((item) => path.resolve(item)))]) {
    if (!existsSync(path.join(backendRoot, "app", "main.py"))) continue;
    const pythonCandidates = platform === "win32"
      ? [
          path.join(backendRoot, ".venv", "Scripts", "pythonw.exe"),
          path.join(backendRoot, ".venv", "Scripts", "python.exe"),
        ]
      : [path.join(backendRoot, ".venv", "bin", "python")];
    const pythonExecutable = pythonCandidates.find((item) => existsSync(item));
    if (pythonExecutable) return { backendRoot, pythonExecutable };
  }
  return null;
}

export async function probeLicenseServer({
  serverUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 800,
} = {}) {
  if (typeof fetchImpl !== "function") return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(createHealthUrl(serverUrl), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return response?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureDevelopmentLicenseServer({
  serverUrl,
  workspaceRoot,
  isPackaged = false,
  isAutomationTest = false,
  env = process.env,
  existsSync = fs.existsSync,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  platform = process.platform,
  attempts = 40,
  proxyAttempts = 4,
  retryDelayMs = 250,
} = {}) {
  if (isPackaged || isAutomationTest) {
    return { ready: false, started: false, reason: "not_applicable" };
  }

  if (await probeLicenseServer({ serverUrl, fetchImpl })) {
    return { ready: true, started: false, reason: "already_running" };
  }

  const backend = resolveDevelopmentLicenseBackend({
    workspaceRoot,
    env,
    existsSync,
    platform,
  });
  if (!backend) {
    return {
      ready: false,
      started: false,
      reason: isLoopbackLicenseServer(serverUrl) ? "backend_not_found" : "remote_unavailable",
    };
  }

  let backendServerUrl;
  try {
    backendServerUrl = resolveDevelopmentBackendServerUrl(serverUrl, env);
  } catch (error) {
    return {
      ready: false,
      started: false,
      reason: "backend_url_invalid",
      error: error?.message || String(error),
    };
  }
  const backendAlreadyRunning = await probeLicenseServer({
    serverUrl: backendServerUrl,
    fetchImpl,
  });
  const parsedBackendUrl = new URL(backendServerUrl);
  const port = parsedBackendUrl.port || "80";
  let child;
  if (!backendAlreadyRunning) {
    try {
      child = spawnImpl(
        backend.pythonExecutable,
        [
          "-m",
          "uvicorn",
          "app.main:app",
          "--host",
          "127.0.0.1",
          "--port",
          port,
        ],
        {
          cwd: backend.backendRoot,
          detached: true,
          shell: false,
          windowsHide: true,
          stdio: "ignore",
          env: {
            ...env,
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
          },
        },
      );
      // Windows can report a spawn failure asynchronously after returning the
      // ChildProcess. Keep it inside the readiness polling contract instead of
      // turning it into an uncaught main-process exception.
      child.once?.("error", () => undefined);
      child.unref?.();
    } catch (error) {
      return {
        ready: false,
        started: false,
        reason: "spawn_failed",
        error: error?.message || String(error),
      };
    }
  }

  let backendReady = backendAlreadyRunning;
  let proxyChecks = 0;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    await wait(retryDelayMs, setTimeoutImpl);
    if (!backendReady) {
      backendReady = await probeLicenseServer({
        serverUrl: backendServerUrl,
        fetchImpl,
      });
      if (!backendReady) continue;
    }
    if (
      backendServerUrl !== String(serverUrl || "").replace(/\/$/u, "")
      && !await probeLicenseServer({ serverUrl, fetchImpl })
    ) {
      // The local backend is healthy but its public proxy (a Tailscale funnel
      // in development) is not answering. That proxy lives outside this app,
      // so waiting cannot fix it: allow a short grace period, then let the
      // desktop reach its login screen instead of blocking every launch for
      // the whole backend start budget (previously 15-40s).
      proxyChecks += 1;
      if (proxyChecks >= Math.max(1, proxyAttempts)) break;
      continue;
    }
    return {
      ready: true,
      started: !backendAlreadyRunning,
      reason: backendAlreadyRunning ? "proxy_restored" : "started",
      pid: Number(child?.pid) || null,
      backendRoot: backend.backendRoot,
      backendServerUrl,
    };
  }

  return {
    ready: false,
    started: !backendAlreadyRunning,
    reason: backendReady ? "proxy_unreachable" : "startup_timeout",
    pid: Number(child?.pid) || null,
    backendRoot: backend.backendRoot,
    backendServerUrl,
  };
}

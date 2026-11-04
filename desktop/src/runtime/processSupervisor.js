import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from 'node:url';

const PROCESS_LOG_NAMES = new Set([
  "desktop-main",
  "desktop-renderer",
  "local-api",
  "local-cache-agent-v2",
  "purchase-search-bridge",
  "wechat-assistant",
]);
const PRIVATE_KEY_RE = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const SECRET_BOX_RE = /\bsecretbox:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\b/gu;
const SECRET_PAIR_RE = /(["']?(?:api[-_]?key|apiKey|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|token|password|passwd|pwd|passphrase|secret|client[-_]?secret|clientSecret|companySecret|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(["']?)([^"'`,}\]\s&]+)(["']?)/giu;
const MAX_RECENT_OUTPUT_LENGTH = 8_192;
const MAX_LOG_FILE_BYTES = 32 * 1024 * 1024;
const LOG_ROTATION_COUNT = 3;

export function redactProcessLogText(value) {
  return String(value || "")
    .replace(PRIVATE_KEY_RE, "[REDACTED_PRIVATE_KEY]")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(JWT_RE, "[REDACTED_JWT]")
    .replace(SECRET_BOX_RE, "[REDACTED_SECRET_BOX]")
    .replace(SECRET_PAIR_RE, (_match, prefix, quote = "") => `${prefix}${quote}[REDACTED]${quote}`);
}

function normalizeLogName(value) {
  const name = String(value || "").trim();
  if (!PROCESS_LOG_NAMES.has(name)) throw new Error("DESKTOP_PROCESS_LOG_NAME_INVALID");
  return name;
}

export function createProcessSupervisor({
  getLogDirectory,
  selfHostedTlsEnabled = false,
  maxLogFileBytes = MAX_LOG_FILE_BYTES,
  logRotationCount = LOG_ROTATION_COUNT,
}) {
  if (!Number.isSafeInteger(maxLogFileBytes) || maxLogFileBytes < 4) {
    throw new TypeError("DESKTOP_PROCESS_LOG_BYTE_LIMIT_INVALID");
  }
  if (!Number.isSafeInteger(logRotationCount) || logRotationCount < 1 || logRotationCount > 10) {
    throw new TypeError("DESKTOP_PROCESS_LOG_ROTATION_COUNT_INVALID");
  }
  const childProcesses = new Map();
  const childDiagnostics = new Map();
  let logWriteChain = Promise.resolve();

  async function assertManagedLogPaths(logPath) {
    let directory = path.dirname(path.resolve(logPath));
    while (true) {
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("DESKTOP_PROCESS_LOG_DIRECTORY_UNSAFE");
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const managedPaths = [logPath];
    for (let index = 1; index <= logRotationCount; index += 1) {
      managedPaths.push(`${logPath}.${index}`);
    }
    for (const candidate of managedPaths) {
      let stat;
      try { stat = await fsp.lstat(candidate); } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
        throw new Error("DESKTOP_PROCESS_LOG_FILE_UNSAFE");
      }
    }
  }

  async function rotateLogIfNeeded(logPath, incomingBytes) {
    let size = 0;
    try { size = (await fsp.stat(logPath)).size; } catch { return; }
    if (size + incomingBytes <= maxLogFileBytes) return;
    await fsp.rm(`${logPath}.${logRotationCount}`, { force: true });
    for (let index = logRotationCount - 1; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`;
      const target = `${logPath}.${index + 1}`;
      try {
        await fsp.rm(target, { force: true });
        await fsp.rename(source, target);
      } catch { /* missing rotation slot */ }
    }
    await fsp.rm(`${logPath}.1`, { force: true });
    await fsp.rename(logPath, `${logPath}.1`);
  }

  function rememberOutput(name, redacted) {
    const current = childDiagnostics.get(name);
    if (!current) return;
    const nextOutput = `${current.recentOutput || ""}${redacted}`;
    current.recentOutput = nextOutput.slice(-MAX_RECENT_OUTPUT_LENGTH);
  }

  function appendLog(inputName, chunk) {
    const name = normalizeLogName(inputName);
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk || "");
    if (!text) return logWriteChain;
    const logPath = path.join(getLogDirectory(), `${name}.log`);
    const redacted = redactProcessLogText(text);
    rememberOutput(name, redacted);
    logWriteChain = logWriteChain
      .then(async () => {
        await assertManagedLogPaths(logPath);
        // Rotation before one unbounded append does not cap a single very
        // large console/child-process message. Split after redaction and keep
        // UTF-8 code points intact in every independently readable log file.
        const bytes = Buffer.from(redacted, "utf8");
        for (let offset = 0; offset < bytes.length;) {
          let end = Math.min(offset + maxLogFileBytes, bytes.length);
          while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
          const chunkBytes = bytes.subarray(offset, end);
          await rotateLogIfNeeded(logPath, chunkBytes.length);
          await fsp.appendFile(logPath, chunkBytes);
          offset = end;
        }
      })
      .catch(() => undefined);
    return logWriteChain;
  }

  async function flushLogs() {
    await logWriteChain;
  }

  function spawnElectronNodeScript(name, scriptPath, options = {}) {
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`${name} 脚本不存在：${scriptPath}`);
    }

    childDiagnostics.set(name, {
      name,
      status: "starting",
      startedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      error: "",
      recentOutput: "",
    });

    const args = selfHostedTlsEnabled
      ? ['--require', fileURLToPath(new URL('./selfHostedTls.cjs', import.meta.url)), scriptPath]
      : [scriptPath];
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || path.dirname(scriptPath),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    childProcesses.set(name, child);
    child.stdout?.on("data", (chunk) => appendLog(name, chunk));
    child.stderr?.on("data", (chunk) => appendLog(name, chunk));
    child.on("exit", (code, signal) => {
      const diagnostic = childDiagnostics.get(name);
      if (diagnostic) {
        diagnostic.status = "exited";
        diagnostic.exitCode = code;
        diagnostic.signal = signal || null;
        diagnostic.exitedAt = new Date().toISOString();
      }
      appendLog(
        name,
        `[desktop] exited code=${code ?? ""} signal=${signal ?? ""}\n`,
      );
      if (childProcesses.get(name) === child) childProcesses.delete(name);
    });
    child.on("error", (error) => {
      const diagnostic = childDiagnostics.get(name);
      if (diagnostic) {
        diagnostic.status = "failed";
        diagnostic.error = redactProcessLogText(
          error?.stack || error?.message || String(error),
        );
        diagnostic.exitedAt = new Date().toISOString();
      }
      appendLog(
        name,
        `[desktop] failed: ${error?.stack || error?.message || String(error)}\n`,
      );
      if (childProcesses.get(name) === child) childProcesses.delete(name);
    });

    return child;
  }

  function getChildDiagnostic(inputName) {
    const name = normalizeLogName(inputName);
    const diagnostic = childDiagnostics.get(name);
    return diagnostic ? { ...diagnostic } : null;
  }

  function waitForChildExit(child, timeoutMs) {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function stopChildProcesses({ timeoutMs = 5_000 } = {}) {
    const children = [...childProcesses.entries()];
    for (const [name, child] of children) {
      appendLog(name, "[desktop] stopping child process\n");
      child.kill();
    }
    await Promise.all(children.map(([, child]) => waitForChildExit(child, timeoutMs)));
    for (const [name, child] of children) {
      if (child.exitCode === null) {
        appendLog(name, "[desktop] force stopping child process after timeout\n");
        child.kill("SIGKILL");
      }
    }
    childProcesses.clear();
    await flushLogs();
  }

  return Object.freeze({
    appendLog,
    flushLogs,
    getChildDiagnostic,
    spawnElectronNodeScript,
    stopChildProcesses,
  });
}

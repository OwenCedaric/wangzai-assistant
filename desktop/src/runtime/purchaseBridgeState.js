import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MODES = new Set(["pending", "off", "observe", "enforce"]);
const TRANSIENT_REPLACE_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "ENOTEMPTY",
  "EPERM",
]);
const DEFAULT_REPLACE_RETRY_DELAYS_MS = Object.freeze([15, 40, 100, 200]);
const DEFAULT_CLEANUP_RETRY_DELAYS_MS = Object.freeze([1000, 3000, 10000, 30000]);

async function waitForFileRetry(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

// The initial fail-closed file must exist before the store is handed out, so the
// one-time startup write keeps a bounded blocking wait. Later updates never block
// the main process.
function waitForFileRetryBlocking(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  } catch {
    const deadline = Date.now() + delay;
    while (Date.now() < deadline) {
      // The fallback is used only when the runtime does not expose Atomics.wait.
    }
  }
}

function scheduleFileCleanup(callback, delayMs) {
  const timer = setTimeout(() => {
    Promise.resolve(callback()).catch(() => undefined);
  }, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  return timer;
}

async function removeTemporaryStateFile({
  fileSystem,
  temporaryPath,
  retryDelaysMs,
  waitForRetry,
}) {
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      fileSystem.rmSync(temporaryPath, { force: true });
      return true;
    } catch (error) {
      const canRetry = TRANSIENT_REPLACE_ERROR_CODES.has(String(error?.code || ""));
      if (!canRetry || attempt >= retryDelaysMs.length) return false;
      await waitForRetry(retryDelaysMs[attempt]);
    }
  }
  return false;
}

async function cleanupTemporaryStateFile({
  fileSystem,
  temporaryPath,
  retryDelaysMs,
  waitForRetry,
  cleanupRetryDelaysMs,
  scheduleCleanup,
}) {
  if (
    await removeTemporaryStateFile({
      fileSystem,
      temporaryPath,
      retryDelaysMs,
      waitForRetry,
    })
  ) {
    return;
  }

  let delayedAttempt = 0;
  const removeLater = async () => {
    if (
      await removeTemporaryStateFile({
        fileSystem,
        temporaryPath,
        retryDelaysMs: [],
        waitForRetry: waitForFileRetryBlocking,
      })
    ) {
      return;
    }
    const delay = cleanupRetryDelaysMs[delayedAttempt];
    delayedAttempt += 1;
    if (delay === undefined) return;
    scheduleCleanup(removeLater, delay);
  };

  const firstDelay = cleanupRetryDelaysMs[delayedAttempt];
  delayedAttempt += 1;
  if (firstDelay !== undefined) scheduleCleanup(removeLater, firstDelay);
}

async function pruneStaleTemporaryStateFiles({
  fileSystem,
  directory,
  statePath,
  retryDelaysMs,
  waitForRetry,
  cleanupRetryDelaysMs,
  scheduleCleanup,
}) {
  const prefix = `${path.basename(statePath)}.`;
  let names = [];
  try {
    names = fileSystem.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names.filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))) {
    await cleanupTemporaryStateFile({
      fileSystem,
      temporaryPath: path.join(directory, name),
      retryDelaysMs,
      waitForRetry,
      cleanupRetryDelaysMs,
      scheduleCleanup,
    });
  }
}

async function replaceLicenseStateFile({
  fileSystem,
  temporaryPath,
  statePath,
  serialized,
  retryDelaysMs,
  waitForRetry,
}) {
  let renameError = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      fileSystem.renameSync(temporaryPath, statePath);
      return;
    } catch (error) {
      renameError = error;
      const canRetry = TRANSIENT_REPLACE_ERROR_CODES.has(String(error?.code || ""));
      if (!canRetry || attempt >= retryDelaysMs.length) break;
      await waitForRetry(retryDelaysMs[attempt]);
    }
  }

  // Some Windows scanners briefly prevent MoveFileEx/rename while still allowing
  // a normal overwrite. Keep this bounded fallback after the atomic retries.
  try {
    fileSystem.writeFileSync(statePath, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (writeError) {
    if (renameError && !writeError.cause) writeError.cause = renameError;
    throw writeError;
  }
}

function cleanTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

export function sanitizePurchaseBridgeLicenseState(snapshot = {}) {
  const mode = String(snapshot.mode || "pending").toLowerCase();
  return {
    version: 1,
    mode: MODES.has(mode) ? mode : "pending",
    authorized: snapshot.authorized === true,
    permissions: Array.isArray(snapshot.permissions)
      ? [...new Set(snapshot.permissions.map(String).filter(Boolean))]
      : [],
    expire: cleanTimestamp(snapshot.expire),
    offline_until: cleanTimestamp(snapshot.offline_until),
    updated_at: new Date().toISOString(),
  };
}

export function createPurchaseBridgeStateStore({
  directory,
  fileSystem = fs,
  retryDelaysMs = DEFAULT_REPLACE_RETRY_DELAYS_MS,
  waitForRetry = waitForFileRetry,
  cleanupRetryDelaysMs = DEFAULT_CLEANUP_RETRY_DELAYS_MS,
  scheduleCleanup = scheduleFileCleanup,
} = {}) {
  fileSystem.mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, "purchase-bridge-license.json");
  const authToken = crypto.randomBytes(32).toString("base64url");
  pruneStaleTemporaryStateFiles({
    fileSystem,
    directory,
    statePath,
    retryDelaysMs,
    waitForRetry: waitForFileRetryBlocking,
    cleanupRetryDelaysMs,
    scheduleCleanup,
  }).catch(() => undefined);

  async function writeLicenseState(snapshot = {}) {
    const state = sanitizePurchaseBridgeLicenseState(snapshot);
    const temporaryPath = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(state)}\n`;
    try {
      fileSystem.writeFileSync(temporaryPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
      });
      await replaceLicenseStateFile({
        fileSystem,
        temporaryPath,
        statePath,
        serialized,
        retryDelaysMs,
        waitForRetry,
      });
    } finally {
      await cleanupTemporaryStateFile({
        fileSystem,
        temporaryPath,
        retryDelaysMs,
        waitForRetry,
        cleanupRetryDelaysMs,
        scheduleCleanup,
      });
    }
    return state;
  }

  // Startup stays synchronous: the fail-closed file must exist before the store
  // is returned to its caller. It performs a single attempt with no waiting, so
  // it cannot stall the main process; the later direct-overwrite fallback still
  // covers a scanner that briefly blocks the rename.
  function writeLicenseStateBlocking(snapshot = {}) {
    const state = sanitizePurchaseBridgeLicenseState(snapshot);
    const temporaryPath = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(state)}\n`;
    try {
      fileSystem.writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      try {
        fileSystem.renameSync(temporaryPath, statePath);
      } catch (renameError) {
        try {
          fileSystem.writeFileSync(statePath, serialized, { encoding: "utf8", mode: 0o600 });
        } catch (writeError) {
          if (!writeError.cause) writeError.cause = renameError;
          throw writeError;
        }
      }
    } finally {
      try {
        fileSystem.rmSync(temporaryPath, { force: true });
      } catch {
        // A leftover temp file is pruned on the next start.
      }
    }
    return state;
  }

  writeLicenseStateBlocking({ mode: "pending" });
  return Object.freeze({ authToken, statePath, updateLicenseState: writeLicenseState });
}

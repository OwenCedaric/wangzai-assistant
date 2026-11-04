const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function normalizeInterval(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval < 60_000) return DEFAULT_INTERVAL_MS;
  return Math.floor(interval);
}

/**
 * Runs only after a user has enrolled recovery once. The caller owns authentication and never
 * exposes its remote token to the renderer; overlapping background uploads are coalesced.
 */
export function createRecoveryAutoBackupScheduler({
  runBackup,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof runBackup !== 'function') throw new Error('createRecoveryAutoBackupScheduler requires runBackup.');
  let timer = null;
  let running = false;
  let status = {
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastResult: null,
  };

  async function runNow(reason = 'manual') {
    if (running) return { ok: false, skipped: 'already-running' };
    running = true;
    status = { ...status, running: true, lastAttemptAt: now(), lastError: null };
    try {
      const result = await runBackup({ reason });
      status = {
        ...status,
        running: false,
        lastSuccessAt: now(),
        lastResult: result || null,
      };
      return { ok: true, result };
    } catch (error) {
      status = {
        ...status,
        running: false,
        lastError: error instanceof Error ? error.message : String(error),
      };
      return { ok: false, error: status.lastError };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { runNow('interval').catch(() => undefined); }, normalizeInterval(intervalMs));
    timer.unref?.();
    runNow('startup').catch(() => undefined);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, runNow, getStatus: () => ({ ...status, running }) };
}

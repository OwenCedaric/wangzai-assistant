function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createProductImageLifecycleScheduler({
  service,
  config = {},
  logger = console,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  now = () => new Date(),
} = {}) {
  const enabled = config.enabled !== false;
  const startupDelayMs = positiveInteger(config.startupDelayMs, 60_000);
  const intervalMs = Math.max(1_000, positiveInteger(config.intervalMs, 15 * 60_000));
  const batchSize = Math.max(1, positiveInteger(config.batchSize, 100));
  const retryDelaySeconds = positiveInteger(config.retryDelaySeconds, 300);
  let startupTimer = null;
  let intervalTimer = null;
  let inFlight = null;
  let started = false;
  const state = {
    enabled,
    running: false,
    status: enabled ? 'idle' : 'disabled',
    lastTrigger: '',
    lastStartedAt: null,
    lastFinishedAt: null,
    lastScanned: 0,
    lastDeleted: 0,
    lastFailed: 0,
    nextRunAt: null,
    lastError: '',
  };

  const getStatus = () => ({ ...state, started, intervalMs, batchSize, retryDelaySeconds });

  async function runOnce(trigger = 'manual') {
    if (!enabled) return { ok: true, skipped: true, reason: 'disabled' };
    if (inFlight) return inFlight;
    state.running = true;
    state.status = 'running';
    state.lastTrigger = trigger;
    state.lastStartedAt = now().toISOString();
    state.lastError = '';
    inFlight = Promise.resolve()
      .then(() => service.cleanupExpiredAssets({ limit: batchSize, retryDelaySeconds }))
      .then((result) => {
        state.status = Number(result?.failed || 0) > 0 ? 'retry_pending' : 'idle';
        state.lastScanned = Number(result?.scanned || 0);
        state.lastDeleted = Number(result?.deleted || 0);
        state.lastFailed = Number(result?.failed || 0);
        return result;
      })
      .catch((error) => {
        state.status = 'failed';
        state.lastError = String(error?.message || error);
        logger.error?.('[local-api][product-images] lifecycle cleanup failed', error);
        return { ok: false, error: { code: 'PRODUCT_IMAGE_LIFECYCLE_FAILED', message: state.lastError } };
      })
      .finally(() => {
        state.running = false;
        state.lastFinishedAt = now().toISOString();
        state.nextRunAt = started ? new Date(now().getTime() + intervalMs).toISOString() : null;
        inFlight = null;
      });
    return inFlight;
  }

  function start() {
    if (!enabled || started) return getStatus();
    started = true;
    state.status = 'scheduled';
    state.nextRunAt = new Date(now().getTime() + startupDelayMs).toISOString();
    startupTimer = setTimeoutImpl(() => {
      startupTimer = null;
      void runOnce('startup');
    }, startupDelayMs);
    startupTimer?.unref?.();
    intervalTimer = setIntervalImpl(() => { void runOnce('interval'); }, intervalMs);
    intervalTimer?.unref?.();
    return getStatus();
  }

  function stop() {
    started = false;
    if (startupTimer) clearTimeoutImpl(startupTimer);
    if (intervalTimer) clearIntervalImpl(intervalTimer);
    startupTimer = null;
    intervalTimer = null;
    state.running = Boolean(inFlight);
    state.status = inFlight ? 'stopping' : enabled ? 'idle' : 'disabled';
    state.nextRunAt = null;
    return getStatus();
  }

  return { start, stop, runOnce, getStatus };
}

/** Coordinates only an explicitly supplied, safe transient-cache worker.
 * This is not a profile/database/backup deletion scheduler. */
export function createIdleCacheMaintenance({
  run,
  isIdle = () => false,
  prepare = async () => undefined,
  onResult = () => undefined,
  now = Date.now,
  checkIntervalMs = 60 * 60 * 1000,
  minimumIntervalMs = 6 * 60 * 60 * 1000,
  idleQuietMs = 60 * 1000,
  retryDelayMs = 60 * 1000,
  maxRetryDelayMs = 15 * 60 * 1000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  for (const [name, value] of Object.entries({ checkIntervalMs, minimumIntervalMs, idleQuietMs, retryDelayMs, maxRetryDelayMs })) {
    if (!Number.isSafeInteger(value) || value < (name === 'idleQuietMs' ? 0 : 1) || value > 2_147_483_647) {
      throw new Error(`CACHE_MAINTENANCE_INVALID_INTERVAL:${name}`);
    }
  }
  if (maxRetryDelayMs < retryDelayMs) throw new Error('CACHE_MAINTENANCE_INVALID_RETRY_RANGE');
  let enabled = typeof run === 'function';
  let stopped = false, accessGeneration = 0;
  let timer = null, running = null, controller = null, accesses = 0, started = false;
  let scheduledTimer = null, scheduledAt = null, scheduleGeneration = 0, idleNotBefore = null;
  let lastAttemptAt = null, lastSuccessAt = null, retryAt = null, consecutiveFailures = 0;
  let state = { status: enabled ? 'idle' : 'disabled', lastResult: null };
  const snapshot = () => ({ ...state, enabled, active: Boolean(running), opening: accesses,
    lastAttemptAt, lastSuccessAt, retryAt, consecutiveFailures, scheduledAt, idleNotBefore });

  function runtimeIsIdle() {
    try { return !accesses && isIdle() === true; } catch { return false; }
  }
  function clearScheduledCheck() {
    scheduleGeneration += 1;
    if (scheduledTimer !== null) clearTimeoutImpl(scheduledTimer);
    scheduledTimer = null; scheduledAt = null;
  }
  function nextEligibleAt() {
    return Math.max(lastSuccessAt === null ? -Infinity : lastSuccessAt + minimumIntervalMs,
      retryAt ?? -Infinity, idleNotBefore ?? -Infinity);
  }
  function scheduleCheck(reason = 'idle-check') {
    if (!started || !enabled || stopped || running || !runtimeIsIdle()) return;
    const dueAt = Math.max(now(), nextEligibleAt());
    if (scheduledTimer !== null && scheduledAt === dueAt) return;
    clearScheduledCheck();
    const generation = scheduleGeneration;
    scheduledAt = dueAt;
    scheduledTimer = setTimeoutImpl(() => {
      if (generation !== scheduleGeneration) return;
      scheduledTimer = null; scheduledAt = null;
      return request({ reason });
    }, Math.max(0, dueAt - now()));
    scheduledTimer?.unref?.();
  }
  function notifyIdle({ reason = 'runtime-became-idle' } = {}) {
    if (!enabled || stopped) return snapshot();
    clearScheduledCheck();
    idleNotBefore = runtimeIsIdle() ? now() + idleQuietMs : null;
    if (idleNotBefore !== null) scheduleCheck(reason);
    return snapshot();
  }
  function recordOutcome(result, aborted = false) {
    // The actual transient-cache wrapper resolves only after worker exit and
    // supplies exitVerified even when there was no cache to remove.
    const succeeded = result?.ok === true && result?.exitVerified === true && !result?.cancelled && !aborted;
    if (succeeded) {
      lastSuccessAt = now(); retryAt = null; consecutiveFailures = 0;
    } else {
      consecutiveFailures = Math.min(31, consecutiveFailures + 1);
      retryAt = now() + Math.min(maxRetryDelayMs, retryDelayMs * 2 ** (consecutiveFailures - 1));
    }
    return succeeded;
  }

  function request({ force = false, reason = 'idle-check' } = {}) {
    if (!enabled) return Promise.resolve(snapshot());
    if (running) return running;
    if (!runtimeIsIdle()) {
      clearScheduledCheck(); idleNotBefore = null;
      state = { ...state, status: 'deferred', reason: 'active-runtime' };
      return Promise.resolve(snapshot());
    }
    if (!force && now() < nextEligibleAt()) {
      scheduleCheck(reason);
      return Promise.resolve({ ...snapshot(), due: false });
    }
    clearScheduledCheck(); idleNotBefore = null;
    const ownedController = new AbortController();
    controller = ownedController;
    lastAttemptAt = now();
    state = { ...state, status: 'running', reason };
    running = Promise.resolve().then(async () => {
      if (ownedController.signal.aborted) return { ok: false, cancelled: true, started: false, exitVerified: true };
      await prepare();
      if (ownedController.signal.aborted) return { ok: false, cancelled: true, started: false, exitVerified: true };
      return await run({ signal: ownedController.signal });
    }).then(result => {
      const succeeded = recordOutcome(result, ownedController.signal.aborted);
      state = { ...state, status: result?.cancelled || ownedController.signal.aborted ? 'cancelled' : succeeded ? 'completed' : 'deferred', lastResult: result };
      return result;
    }, error => {
      recordOutcome(null, ownedController.signal.aborted);
      state = { ...state, status: 'failed', lastResult: { ok: false, code: error?.code || 'CACHE_MAINTENANCE_FAILED' } };
      return state.lastResult;
    }).then(result => {
      try { onResult(result); } catch { /* diagnostics cannot break a browser open */ }
      return { ...snapshot(), active: false };
    }).finally(() => {
      running = null; if (controller === ownedController) controller = null;
      scheduleCheck(retryAt === null ? 'success-interval' : 'retry-backoff');
    });
    return running;
  }

  async function withAccess(work, { interrupt = true } = {}) {
    // Reserve synchronously, before the first await, so an idle timer cannot
    // slip into an opening whose native session is not registered yet.
    accesses += 1;
    clearScheduledCheck(); idleNotBefore = null;
    const admittedGeneration = accessGeneration;
    try {
      if (stopped) throw Object.assign(new Error('CACHE_MAINTENANCE_ACCESS_CANCELLED'), { code: 'CACHE_MAINTENANCE_ACCESS_CANCELLED' });
      if (interrupt) controller?.abort();
      if (running) await running;
      if (stopped || admittedGeneration !== accessGeneration) throw Object.assign(new Error('CACHE_MAINTENANCE_ACCESS_CANCELLED'), { code: 'CACHE_MAINTENANCE_ACCESS_CANCELLED' });
      return await work();
    } finally {
      accesses -= 1;
      if (!accesses) notifyIdle({ reason: 'access-settled-idle' });
    }
  }

  function start() {
    if (enabled && timer === null) {
      started = true;
      timer = setIntervalImpl(() => { void request(); }, checkIntervalMs);
      timer?.unref?.();
      notifyIdle({ reason: 'startup-idle' });
    }
    return snapshot();
  }
  function cancel() {
    clearScheduledCheck(); idleNotBefore = null;
    controller?.abort(); return running || Promise.resolve(snapshot());
  }
  function stop() {
    stopped = true;
    accessGeneration += 1;
    enabled = false;
    started = false;
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    return cancel();
  }
  return Object.freeze({ request, withAccess, start, cancel, stop, notifyIdle, snapshot });
}

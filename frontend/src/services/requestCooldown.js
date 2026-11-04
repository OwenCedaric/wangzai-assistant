export function createRequestCooldownState(options = {}) {
  return {
    records: new Map(),
    now: options.now || (() => Date.now()),
    baseCooldownMs: options.baseCooldownMs ?? 30_000,
    maxCooldownMs: options.maxCooldownMs ?? 5 * 60_000,
  };
}

function getRecord(state, key) {
  return state.records.get(String(key));
}

export function shouldAttemptRequest(state, key, now = state.now()) {
  const record = getRecord(state, key);
  if (!record) return true;
  return now >= record.failedUntil;
}

export function recordRequestFailure(state, key, options = {}) {
  const now = options.now ?? state.now();
  const previous = getRecord(state, key);
  const attemptCount = (previous?.attemptCount ?? 0) + 1;
  const baseCooldownMs = options.cooldownMs ?? state.baseCooldownMs;
  const failedUntil = now + Math.min(state.maxCooldownMs, baseCooldownMs * 2 ** Math.max(0, attemptCount - 1));
  const next = {
    attemptCount,
    failedUntil,
    lastFailedAt: now,
    lastError: options.error ? String(options.error?.message || options.error) : '',
  };
  state.records.set(String(key), next);
  return next;
}

export function recordRequestSuccess(state, key) {
  state.records.delete(String(key));
}

export function getRequestCooldownSnapshot(state) {
  return Array.from(state.records.entries()).map(([key, record]) => ({ key, ...record }));
}

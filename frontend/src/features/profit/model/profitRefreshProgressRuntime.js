const profitRefreshProgressListeners = new Set();

let profitRefreshProgressSnapshot = {
  active: false,
  stage: 'idle',
  label: '利润核算',
  message: '利润核算待刷新',
  total: 0,
  done: 0,
  cached: 0,
  missing: 0,
  failed: 0,
  updatedAt: '',
};

function normalizeProgressNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function emitProfitRefreshProgress() {
  const snapshot = getProfitRefreshProgressSnapshot();
  profitRefreshProgressListeners.forEach((listener) => listener(snapshot));
}

export function getProfitRefreshProgressSnapshot() {
  return { ...profitRefreshProgressSnapshot };
}

export function publishProfitRefreshProgress(event = {}) {
  const nextEvent = event && typeof event === 'object' ? event : {};
  profitRefreshProgressSnapshot = {
    ...profitRefreshProgressSnapshot,
    ...nextEvent,
    total: normalizeProgressNumber(nextEvent.total ?? profitRefreshProgressSnapshot.total),
    done: normalizeProgressNumber(nextEvent.done ?? profitRefreshProgressSnapshot.done),
    cached: normalizeProgressNumber(nextEvent.cached ?? profitRefreshProgressSnapshot.cached),
    missing: normalizeProgressNumber(nextEvent.missing ?? profitRefreshProgressSnapshot.missing),
    failed: normalizeProgressNumber(nextEvent.failed ?? profitRefreshProgressSnapshot.failed),
    active: nextEvent.active === undefined ? profitRefreshProgressSnapshot.active : Boolean(nextEvent.active),
    updatedAt: new Date().toISOString(),
  };
  emitProfitRefreshProgress();
  return getProfitRefreshProgressSnapshot();
}

export function clearProfitRefreshProgress() {
  profitRefreshProgressSnapshot = {
    active: false,
    stage: 'idle',
    label: '利润核算',
    message: '利润核算待刷新',
    total: 0,
    done: 0,
    cached: 0,
    missing: 0,
    failed: 0,
    updatedAt: new Date().toISOString(),
  };
  emitProfitRefreshProgress();
}

export function subscribeProfitRefreshProgress(listener) {
  profitRefreshProgressListeners.add(listener);
  listener(getProfitRefreshProgressSnapshot());
  return () => profitRefreshProgressListeners.delete(listener);
}

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 700;
const DEFAULT_MAX_DELAY_MS = 12_000;

function createAbortError() {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
  });
}

function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(createAbortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return 0;
  return Math.max(0, retryAt - now);
}

export class OzonHttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'OzonHttpError';
    this.endpoint = options.endpoint || '';
    this.status = options.status || 0;
    this.retryAfterMs = options.retryAfterMs || 0;
  }
}

export function createOzonHttpError({ endpoint, status, message, retryAfter, retryAfterMs }) {
  const parsedRetryAfterMs = retryAfterMs ?? parseRetryAfter(retryAfter);
  return new OzonHttpError(`${endpoint} 请求失败：${message || `HTTP ${status}`}`, {
    endpoint,
    status,
    retryAfterMs: parsedRetryAfterMs,
  });
}

export function classifyOzonRequestError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(error?.status) || Number(message.match(/HTTP\s*(\d+)/i)?.[1]) || 0;
  if (status === 429) return { retryable: true, type: 'rate-limit', status };
  if (status >= 500) return { retryable: true, type: 'server', status };
  if (/timeout|超时/i.test(message)) return { retryable: true, type: 'timeout', status };
  if (/AbortError|aborted|已中断/i.test(message)) return { retryable: false, type: 'abort', status };
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return { retryable: true, type: 'network', status };
  return { retryable: false, type: status ? 'http' : 'unknown', status };
}

function nextBackoffMs(attempt, options, error) {
  const retryAfterMs = Number(error?.retryAfterMs) || 0;
  if (retryAfterMs > 0) return retryAfterMs;
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = options.jitterMs === 0 ? 0 : Math.floor(Math.random() * (options.jitterMs ?? 200));
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1) + jitter);
}

export function createOzonRequestControl(options = {}) {
  const maxConcurrentPerShop = options.maxConcurrentPerShop ?? options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const queuesByShop = new Map();
  const activeByShop = new Map();
  const inFlightByDedupeKey = new Map();
  const activeIssues = new Map();
  const listeners = new Set();
  const stats = {
    active: 0,
    queued: 0,
    total: 0,
    deduped: 0,
    completed: 0,
    failed: 0,
    retries: 0,
    rateLimited: 0,
    timeouts: 0,
    byEndpoint: {},
    byShop: {},
    currentIssues: [],
  };

  const snapshot = () => ({
    ...stats,
    isolationMode: 'per-shop',
    activeByShop: Object.fromEntries(activeByShop.entries()),
    queuedByShop: Object.fromEntries(
      [...queuesByShop.entries()].map(([shopKey, queue]) => [shopKey, queue.length])
    ),
    byEndpoint: { ...stats.byEndpoint },
    byShop: { ...stats.byShop },
    currentIssues: stats.currentIssues.map((item) => ({ ...item })),
  });

  const emit = () => {
    stats.active = [...activeByShop.values()].reduce((sum, value) => sum + value, 0);
    stats.queued = [...queuesByShop.values()].reduce((sum, queue) => sum + queue.length, 0);
    const next = snapshot();
    listeners.forEach((listener) => listener(next));
  };

  const syncActiveIssues = () => {
    stats.currentIssues = [...activeIssues.values()].sort((left, right) =>
      String(right.lastFailedAt || '').localeCompare(String(left.lastFailedAt || ''))
    );
  };

  const getIssueKey = (endpoint, shopKey) => `${shopKey || 'unknown-shop'}::${endpoint || 'unknown-endpoint'}`;

  const rememberOzonIssue = ({ endpoint, shopKey, error, classification, attempt, willRetry, retryDelayMs }) => {
    if (classification.type === 'abort') return;
    const issueKey = getIssueKey(endpoint, shopKey);
    const previousIssue = activeIssues.get(issueKey);
    const failedAt = new Date().toISOString();
    activeIssues.set(issueKey, {
      id: `ozon:${issueKey}`,
      source: 'ozon',
      endpoint,
      shopKey,
      status: classification.status || Number(error?.status) || 0,
      type: classification.type || 'unknown',
      message: error instanceof Error ? error.message : String(error || 'Ozon 请求失败'),
      attempt,
      willRetry: willRetry === true,
      retryDelayMs: willRetry === true ? Math.max(0, Number(retryDelayMs) || 0) : 0,
      nextRetryAt: willRetry === true
        ? new Date(Date.now() + Math.max(0, Number(retryDelayMs) || 0)).toISOString()
        : null,
      failureCount: (previousIssue?.failureCount || 0) + 1,
      firstFailedAt: previousIssue?.firstFailedAt || failedAt,
      lastFailedAt: failedAt,
    });
    syncActiveIssues();
  };

  const clearOzonIssue = (endpoint, shopKey) => {
    const issueKey = getIssueKey(endpoint, shopKey);
    if (!activeIssues.delete(issueKey)) return;
    syncActiveIssues();
  };

  const runNext = (shopKey) => {
    const queue = queuesByShop.get(shopKey) || [];
    let active = activeByShop.get(shopKey) || 0;
    while (active < maxConcurrentPerShop && queue.length) {
      const item = queue.shift();
      if (item.abortQueued) item.signal?.removeEventListener?.('abort', item.abortQueued);
      active += 1;
      activeByShop.set(shopKey, active);
      emit();
      item
        .run()
        .then(item.resolve, item.reject)
        .finally(() => {
          const nextActive = Math.max(0, (activeByShop.get(shopKey) || 0) - 1);
          if (nextActive > 0) activeByShop.set(shopKey, nextActive);
          else activeByShop.delete(shopKey);
          stats.completed += 1;
          emit();
          runNext(shopKey);
        });
    }
    if (!queue.length) queuesByShop.delete(shopKey);
  };

  const enqueue = (shopKey, run, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }
      const item = { run, resolve, reject, signal, abortQueued: null };
      item.abortQueued = () => {
        const queue = queuesByShop.get(shopKey) || [];
        const index = queue.indexOf(item);
        if (index === -1) return;
        queue.splice(index, 1);
        if (!queue.length) queuesByShop.delete(shopKey);
        stats.failed += 1;
        emit();
        reject(createAbortError());
      };
      signal?.addEventListener('abort', item.abortQueued, { once: true });
      const queue = queuesByShop.get(shopKey) || [];
      queue.push(item);
      queuesByShop.set(shopKey, queue);
      emit();
      runNext(shopKey);
    });

  async function runControlledRequest(task = {}) {
    const endpoint = task.endpoint || 'unknown-endpoint';
    const shopKey = String(task.shopKey || '').trim();
    if (!shopKey) throw new Error('runOzonControlledRequest requires an exact shopKey');
    const dedupeKey = task.dedupeKey ? String(task.dedupeKey) : '';
    const scopedDedupeKey = dedupeKey ? `${shopKey}::${dedupeKey}` : '';
    if (scopedDedupeKey && inFlightByDedupeKey.has(scopedDedupeKey)) {
      stats.deduped += 1;
      emit();
      return raceWithAbort(inFlightByDedupeKey.get(scopedDedupeKey), task.signal);
    }

    stats.total += 1;
    stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] ?? 0) + 1;
    stats.byShop[shopKey] = (stats.byShop[shopKey] ?? 0) + 1;
    emit();

    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;
    const execute = task.execute;
    if (typeof execute !== 'function') throw new Error('runOzonControlledRequest requires execute');

    const promise = enqueue(shopKey, async () => {
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          const result = await execute(task.signal);
          clearOzonIssue(endpoint, shopKey);
          return result;
        } catch (error) {
          const classification = classifyOzonRequestError(error);
          if (classification.type === 'rate-limit') stats.rateLimited += 1;
          if (classification.type === 'timeout') stats.timeouts += 1;
          const willRetry = classification.retryable && attempt <= maxRetries;
          const retryDelayMs = willRetry ? nextBackoffMs(attempt, task, error) : 0;
          rememberOzonIssue({ endpoint, shopKey, error, classification, attempt, willRetry, retryDelayMs });
          if (!willRetry) {
            stats.failed += 1;
            emit();
            throw error;
          }
          stats.retries += 1;
          emit();
          await sleep(retryDelayMs, task.signal);
        }
      }
    }, task.signal);
    if (!scopedDedupeKey) return promise;

    const clearDedupe = () => {
      if (inFlightByDedupeKey.get(scopedDedupeKey) === promise) {
        inFlightByDedupeKey.delete(scopedDedupeKey);
      }
    };
    inFlightByDedupeKey.set(scopedDedupeKey, promise);
    promise.then(clearDedupe, clearDedupe);
    return promise;
  }

  return {
    runControlledRequest,
    getStats: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
}

export const defaultOzonRequestControl = createOzonRequestControl();

export function runOzonControlledRequest(task) {
  return defaultOzonRequestControl.runControlledRequest(task);
}

export function getOzonRequestControlStats() {
  return defaultOzonRequestControl.getStats();
}

export function subscribeOzonRequestStats(listener) {
  return defaultOzonRequestControl.subscribe(listener);
}

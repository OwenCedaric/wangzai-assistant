import {
  confirmDomainWrite,
  getDomainCache,
  getSyncJob,
  previewDomainWrite,
  requestLocalApi,
  startDomainSync,
} from '../api/localApiClient.js';

export function readMarketingActivityCache(query = {}, options = {}) {
  return getDomainCache('marketing', { ...query, scope: 'activities' }, options);
}

export function readMarketingProductPoolCache(query = {}, options = {}) {
  return getDomainCache('marketing', { ...query, scope: 'products' }, options);
}

export function readMarketingSummaryCache(query = {}, options = {}) {
  return getDomainCache('marketing', { ...query, scope: 'summary' }, options);
}

/**
 * The page-entry cache is one SQLite snapshot, rather than a collection of
 * browser/local-data fallbacks.  Keeping this route in the service layer is
 * intentional: UI/model code must never know the local-api path.
 */
export async function readMarketingActivitySnapshotCache(query = {}, options = {}) {
  const payload = await getDomainCache('marketing', { ...query, scope: 'snapshot' }, options);
  if (payload?.ok === false) {
    const error = new Error(payload?.error?.message || '营销活动 SQLite 快照读取失败。');
    error.payload = payload;
    throw error;
  }
  return payload;
}

/**
 * Historical one-time retirement bridge. Production startup no longer calls it.
 * This endpoint only imports into SQLite; it does not start a sync task or
 * contact Ozon.  The caller must independently GET the snapshot and compare
 * it before clearing any legacy source.
 */
export function importLegacyMarketingActivitySnapshot(payload = {}, options = {}) {
  return requestLocalApi('/api/cache/marketing/legacy-import', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

/** Persist only the small user view state. Marketing facts stay in SQLite fact tables. */
export function saveMarketingActivityViewState(payload = {}, options = {}) {
  return requestLocalApi('/api/cache/marketing/view-state', {
    method: 'PUT',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function startMarketingActivitySync(payload = {}, options = {}) {
  return startDomainSync('marketing', {
    action: 'sync-marketing-activities',
    forceRefresh: true,
    scope: 'activities',
    fastAck: true,
    includeCacheSnapshot: false,
    waitForResult: false,
    ...payload,
  }, options);
}

export function startMarketingProductPoolSync(payload = {}, options = {}) {
  return startDomainSync('marketing', {
    action: 'sync-marketing-products',
    forceRefresh: true,
    scope: 'products',
    fastAck: true,
    includeCacheSnapshot: false,
    waitForResult: false,
    ...payload,
  }, options);
}

export function startMarketingSummarySync(payload = {}, options = {}) {
  return startDomainSync('marketing', {
    action: 'sync-marketing-summary',
    forceRefresh: true,
    scope: 'summary',
    fastAck: true,
    includeCacheSnapshot: false,
    waitForResult: false,
    ...payload,
  }, options);
}

export function getMarketingActivitySyncJob(jobId, options = {}) {
  return getSyncJob(jobId, options);
}

function sleep(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, ms));
  });
}

export async function pollMarketingActivitySyncJob(jobId, options = {}) {
  const intervalMs = Math.max(Number(options.intervalMs) || 1000, 100);
  const timeoutMs = Math.max(Number(options.timeoutMs) || 60_000, intervalMs);
  const startedAt = Date.now();
  const finalStatuses = new Set(['success', 'partial', 'failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open']);

  while (Date.now() - startedAt <= timeoutMs) {
    const job = await getMarketingActivitySyncJob(jobId, options);
    const status = job?.job?.status || job?.status;
    if (finalStatuses.has(status)) return job;
    await sleep(intervalMs);
  }

  return {
    ok: false,
    jobId,
    status: 'timeout',
    error: {
      code: 'MARKETING_SYNC_POLL_TIMEOUT',
      message: '营销活动同步轮询超时，页面可继续读取本地缓存。',
    },
  };
}

export function previewMarketingWrite(payload = {}, options = {}) {
  return previewDomainWrite('marketing', {
    requestedBy: 'marketing-activity-page',
    ...payload,
  }, options);
}

export function confirmMarketingWrite(payload = {}, options = {}) {
  return confirmDomainWrite('marketing', {
    requestedBy: 'marketing-activity-page',
    ...payload,
  }, options);
}

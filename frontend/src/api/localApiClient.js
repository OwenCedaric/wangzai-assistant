import {
  clearOrderDomainCache,
  isSharedOrderCacheDomain,
  readOrderDomainCache,
} from '../services/orderCanonicalCacheRuntime.js';
export { LocalApiError } from "./localApiError.js";
import { LocalApiError } from "./localApiError.js";
import {
  buildLocalProductCommissions,
  buildLocalProductFinancialData,
  buildLocalProductPriceEvidence,
  countLocalProductIdentityValues,
  createLocalLogisticsSyncError,
  createLocalLogisticsSyncSubmitError,
  createLocalOrderSyncSubmitError,
  createLocalReturnsSyncSubmitError,
  getFinanceDateRangeFromBody,
  getLocalLogisticsSyncParams,
  getLocalOrderSyncJob,
  getLocalOrderSyncJobId,
  getLocalOrderSyncParams,
  getLocalOrderSyncStatus,
  getLocalOzonShopId,
  getLocalOzonShopName,
  getLocalProductV4StockItems,
  getLogisticsEndpointMeta,
  getLogisticsPayloadItems,
  getOrderEndpointMeta,
  getProductDisplayCurrencyCode,
  getProductSoftwareCategoryText,
  getRatingPenaltyDateRangeFromBody,
  getReturnsDateRangeFromBody,
  getReturnsEndpointMeta,
  normalizeOzonEndpoint,
  parseLocalProductOffsetCursor,
  sleepLocalOrderSync,
  toOzonFinanceOperation,
  toOzonOrderPosting,
  toOzonProductInfoItem,
  toOzonProductListItem,
  toOzonReturnItem,
} from "./localApiOzonCacheMapping.js";
export { isLocalApiTransportError } from "./localApiOzonCacheMapping.js";
import { isLocalApiTransportError } from "./localApiOzonCacheMapping.js";
import {
  createSharedCatalogQuery,
  normalizeSharedCatalogDto,
  normalizeSharedCatalogTreePayload,
} from "./localApiSharedCatalogDto.js";

const DEFAULT_LOCAL_API_BASE_URL = 'http://127.0.0.1:3790';
const DEFAULT_TIMEOUT_MS = 10000;
const LOCAL_API_GET_TRANSPORT_ATTEMPTS = 3;
const LOCAL_API_EXPLICIT_TRANSPORT_ATTEMPTS = 4;
const LOCAL_API_TRANSPORT_RETRY_DELAYS_MS = [180, 520, 1200];
const LOCAL_API_RECENT_FAILURE_LIMIT = 8;
const LOCAL_API_SYNC_JOB_LIMIT = 8;

function getViteEnvValue(key) {
  // Keep the `import.meta.env` access statically recognizable to Vite. Using
  // optional chaining on `import.meta` prevents Vite from injecting VITE_* at
  // build/dev time, which silently falls back to the production default URL.
  return import.meta.env?.[key];
}

export function getLocalApiBaseUrl() {
  return (
    getViteEnvValue('VITE_LOCAL_API_BASE_URL') ||
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ ||
    DEFAULT_LOCAL_API_BASE_URL
  ).replace(/\/+$/u, '');
}

function readLocalApiErrorMessage(payload, fallback) {
  if (payload && typeof payload === 'object') {
    const message = String(payload?.error?.message || payload?.message || '').trim();
    if (message) return message;
  }
  return String(fallback || 'local-api 请求失败');
}

function isRetryableLocalApiBridgeFailure(result = {}) {
  if ((Number(result?.status) || 0) !== 0) return false;
  const payload = result?.data ?? result?.payload ?? null;
  const message = readLocalApiErrorMessage(payload, result?.error || '');
  if (!message || /(?:超时|timeout|timed\s*out|abort)/iu.test(message)) return false;
  return /(?:无法连接本地\s*API|ECONNREFUSED|ECONNRESET|EPIPE|socket\s*hang\s*up|fetch\s*failed|network\s*error|connection\s*(?:refused|reset))/iu.test(message);
}

function createQueryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function parseLocalApiResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

const localApiRequestListeners = new Set();
const localApiActiveIssues = new Map();
const localApiSyncJobs = new Map();
const sharedOrderSyncJobDomains = new Map();
const localApiRequestStats = {
  active: 0,
  total: 0,
  completed: 0,
  failed: 0,
  timeouts: 0,
  byPath: {},
  currentIssues: [],
  recentFailures: [],
  syncJobs: [],
};

function normalizeLocalApiObservePath(path = '') {
  const text = String(path || '').trim();
  const pathname = text.split('?')[0] || '/';
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function getLocalApiFailureMessage(error) {
  const message = error instanceof Error ? error.message : String(error || '本地接口请求失败');
  return message.length > 120 ? `${message.slice(0, 120)}...` : message;
}

function getLocalApiStatsSnapshot() {
  return {
    ...localApiRequestStats,
    byPath: { ...localApiRequestStats.byPath },
    currentIssues: localApiRequestStats.currentIssues.map((item) => ({ ...item })),
    recentFailures: localApiRequestStats.recentFailures.map((item) => ({ ...item })),
    syncJobs: localApiRequestStats.syncJobs.map((item) => ({ ...item })),
  };
}

function emitLocalApiRequestStats() {
  const snapshot = getLocalApiStatsSnapshot();
  localApiRequestListeners.forEach((listener) => listener(snapshot));
}

function syncLocalApiActiveIssues() {
  const currentIssues = [...localApiActiveIssues.values()]
    .sort((left, right) => String(right.lastFailedAt || '').localeCompare(String(left.lastFailedAt || '')))
    .slice(0, LOCAL_API_RECENT_FAILURE_LIMIT);
  localApiRequestStats.currentIssues = currentIssues;
  localApiRequestStats.recentFailures = currentIssues;
}

function getNumberValue(...values) {
  for (const value of values) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return 0;
}

function normalizeLocalApiSyncJob(job = {}) {
  const progress = job.progress && typeof job.progress === 'object' ? job.progress : {};
  const jobId = String(job.jobId || job.id || '').trim();
  if (!jobId) return null;
  return {
    id: jobId,
    jobId,
    domain: String(job.domain || '').trim(),
    status: String(job.status || '').trim(),
    stage: String(job.stage || '').trim(),
    message: String(job.message || '').trim(),
    progressDone: getNumberValue(job.progressDone, progress.done),
    progressTotal: getNumberValue(job.progressTotal, progress.total),
    itemsDone: getNumberValue(progress.itemsDone, job.itemsDone),
    itemsTotal: getNumberValue(progress.itemsTotal, job.itemsTotal),
    failedCount: getNumberValue(job.failedCount),
    updatedAt: job.updatedAt || job.finishedAt || job.startedAt || job.createdAt || new Date().toISOString(),
  };
}

function collectLocalApiSyncJobs(payload, result = []) {
  if (!payload || typeof payload !== 'object') return result;
  if (Array.isArray(payload)) {
    payload.forEach((item) => collectLocalApiSyncJobs(item, result));
    return result;
  }
  if (Array.isArray(payload.jobs)) collectLocalApiSyncJobs(payload.jobs, result);
  if (payload.job) collectLocalApiSyncJobs(payload.job, result);
  if (payload.syncJob) collectLocalApiSyncJobs(payload.syncJob, result);
  if (payload.readBackJobs) collectLocalApiSyncJobs(payload.readBackJobs, result);
  if (payload.jobId || payload.id) {
    const normalizedJob = normalizeLocalApiSyncJob(payload);
    if (normalizedJob) result.push(normalizedJob);
  }
  return result;
}

function syncLocalApiSyncJobs() {
  localApiRequestStats.syncJobs = [...localApiSyncJobs.values()]
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, LOCAL_API_SYNC_JOB_LIMIT);
}

function rememberLocalApiSyncJobs(payload) {
  const jobs = collectLocalApiSyncJobs(payload);
  if (!jobs.length) return;
  jobs.forEach((job) => localApiSyncJobs.set(job.jobId, job));
  syncLocalApiSyncJobs();
}

function observeLocalApiRequest(path) {
  const observedPath = normalizeLocalApiObservePath(path);
  let closed = false;
  localApiRequestStats.active += 1;
  localApiRequestStats.total += 1;
  localApiRequestStats.byPath[observedPath] = (localApiRequestStats.byPath[observedPath] || 0) + 1;
  emitLocalApiRequestStats();

  return {
    cancel() {
      if (closed) return;
      closed = true;
      localApiRequestStats.active = Math.max(0, localApiRequestStats.active - 1);
      emitLocalApiRequestStats();
    },
    complete(payload) {
      if (closed) return;
      closed = true;
      localApiRequestStats.active = Math.max(0, localApiRequestStats.active - 1);
      localApiRequestStats.completed += 1;
      rememberLocalApiSyncJobs(payload);
      localApiActiveIssues.delete(observedPath);
      syncLocalApiActiveIssues();
      emitLocalApiRequestStats();
    },
    fail(error) {
      if (closed) return;
      closed = true;
      const code = error?.code || 'LOCAL_API_ERROR';
      localApiRequestStats.active = Math.max(0, localApiRequestStats.active - 1);
      localApiRequestStats.failed += 1;
      if (code === 'LOCAL_API_TIMEOUT' || /超时|timeout/i.test(String(error?.message || ''))) {
        localApiRequestStats.timeouts += 1;
      }
      const previousIssue = localApiActiveIssues.get(observedPath);
      const failedAt = new Date().toISOString();
      localApiActiveIssues.set(observedPath, {
        id: `local:${observedPath}`,
        source: 'local',
        path: observedPath,
        status: Number(error?.status) || 0,
        code,
        message: getLocalApiFailureMessage(error),
        failureCount: (previousIssue?.failureCount || 0) + 1,
        firstFailedAt: previousIssue?.firstFailedAt || failedAt,
        lastFailedAt: failedAt,
      });
      syncLocalApiActiveIssues();
      emitLocalApiRequestStats();
    },
  };
}

export function getLocalApiRequestStats() {
  return getLocalApiStatsSnapshot();
}

export function subscribeLocalApiRequestStats(listener) {
  localApiRequestListeners.add(listener);
  listener(getLocalApiStatsSnapshot());
  return () => localApiRequestListeners.delete(listener);
}

export async function requestLocalApi(path, options = {}) {
  const observer =
    options.observe === false
      ? {
          cancel() {},
          complete() {},
          fail() {},
        }
      : observeLocalApiRequest(path);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const method = String(options.method || 'GET').toUpperCase();
  const bridge = globalThis.window?.wangzaiDesktop?.localApiRequest;
  const explicitTransportRetry = options.transportRetry === true;
  const transportAttempts = bridge && explicitTransportRetry
    ? LOCAL_API_EXPLICIT_TRANSPORT_ATTEMPTS
    : bridge && method === 'GET' && options.transportRetry !== false
      ? LOCAL_API_GET_TRANSPORT_ATTEMPTS
      : 1;
  const totalTimeoutMs = timeoutMs * transportAttempts
    + LOCAL_API_TRANSPORT_RETRY_DELAYS_MS.slice(0, transportAttempts - 1)
      .reduce((total, value) => total + value, 0);
  const requestId = globalThis.crypto?.randomUUID?.()
    || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let abortSource = '';
  const cancelBridgeRequest = () => {
    const cancel = globalThis.window?.wangzaiDesktop?.cancelLocalApiRequest;
    if (typeof cancel === 'function') void cancel(requestId).catch?.(() => undefined);
  };
  const abortFromExternalSignal = () => {
    if (controller.signal.aborted) return;
    abortSource = 'external';
    controller.abort();
    cancelBridgeRequest();
  };
  if (options.signal?.aborted) {
    abortFromExternalSignal();
  } else {
    options.signal?.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
  const timeoutId = globalThis.setTimeout(() => {
    if (controller.signal.aborted) return;
    abortSource = 'timeout';
    controller.abort();
    cancelBridgeRequest();
  }, totalTimeoutMs);

  const waitForTransportRetry = async (attemptIndex) => {
    const waitMs = LOCAL_API_TRANSPORT_RETRY_DELAYS_MS[attemptIndex] || 0;
    if (!waitMs) return;
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException('请求已取消', 'AbortError'));
      };
      const timer = globalThis.setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, waitMs);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  try {
    let payload;
    if (bridge) {
      for (let attemptIndex = 0; attemptIndex < transportAttempts; attemptIndex += 1) {
        if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        const result = await bridge({
          requestId,
          path: path.startsWith('/') ? path : `/${path}`,
          method,
          headers: options.headers || {},
          body: options.body,
          timeoutMs,
        });
        if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        payload = result?.data ?? null;
        if (result?.ok) break;
        const status = Number(result?.status) || 0;
        const mayRetry = isRetryableLocalApiBridgeFailure(result)
          && attemptIndex + 1 < transportAttempts;
        if (mayRetry) {
          await waitForTransportRetry(attemptIndex);
          continue;
        }
        throw new LocalApiError(readLocalApiErrorMessage(
          payload,
          result?.error || `local-api 请求失败：${status}`,
        ), { status, payload });
      }
    } else {
      const response = await fetch(`${getLocalApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-wangzai-local-api': 'frontend',
          ...(options.headers || {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      payload = await parseLocalApiResponse(response);
      if (!response.ok) {
        throw new LocalApiError(readLocalApiErrorMessage(payload, `local-api 请求失败：${response.status}`), {
          status: response.status,
          payload,
        });
      }
    }
    observer.complete(payload);
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      if (abortSource === 'external') {
        observer.cancel();
        throw error;
      }
      const timeoutError = new LocalApiError(`local-api 请求超时：${totalTimeoutMs}ms`, {
        status: 0,
        code: 'LOCAL_API_TIMEOUT',
      });
      observer.fail(timeoutError);
      throw timeoutError;
    }
    observer.fail(error);
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', abortFromExternalSignal);
  }
}

export function getLocalApiHealth() {
  return requestLocalApi('/health');
}

export function getLocalStorageAudit(options = {}) {
  return requestLocalApi('/api/app/storage-audit', {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getLocalDataConsistencyAudit(options = {}) {
  return requestLocalApi('/api/app/data-consistency-audit', {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getDatabaseCompactionPreview(options = {}) {
  return requestLocalApi('/api/app/database-compaction-preview', {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function confirmDatabaseCompaction(previewFingerprint, options = {}) {
  const fingerprint = String(previewFingerprint || '').trim();
  if (!fingerprint) {
    throw new LocalApiError('缺少数据库压缩预览指纹，请先重新检查。', {
      status: 400,
      code: 'DATABASE_COMPACTION_PREVIEW_REQUIRED',
    });
  }
  if (options.backupAcknowledged !== true) {
    throw new LocalApiError('请先确认已创建可恢复保护副本。', {
      status: 400,
      code: 'DATABASE_COMPACTION_BACKUP_ACK_REQUIRED',
    });
  }
  return requestLocalApi('/api/app/database-compaction/confirm', {
    method: 'POST',
    body: {
      confirmation: 'APPLY_DATABASE_COMPACTION',
      previewFingerprint: fingerprint,
      backupAcknowledged: true,
    },
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getShopScopeRepairPreview(options = {}) {
  return requestLocalApi('/api/app/shop-scope-preview', {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function confirmShopScopeRepair(previewFingerprint, options = {}) {
  const fingerprint = String(previewFingerprint || '').trim();
  if (!fingerprint) {
    throw new LocalApiError('缺少数据归属预览指纹，请先重新检查。', {
      status: 400,
      code: 'SHOP_SCOPE_REPAIR_PREVIEW_REQUIRED',
    });
  }
  return requestLocalApi('/api/app/shop-scope-repair/confirm', {
    method: 'POST',
    body: {
      confirmation: 'APPLY_SHOP_SCOPE_REPAIR',
      previewFingerprint: fingerprint,
    },
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getManualShopScopeResolutionPreview(options = {}) {
  return requestLocalApi('/api/app/shop-scope-manual-preview', {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function confirmManualShopScopeResolution(previewFingerprint, assignments, options = {}) {
  const fingerprint = String(previewFingerprint || '').trim();
  if (!fingerprint) {
    throw new LocalApiError('缺少多店数据归属预览指纹，请先重新检查。', {
      status: 400,
      code: 'SHOP_SCOPE_MANUAL_RESOLUTION_PREVIEW_REQUIRED',
    });
  }
  const normalizedAssignments = Array.isArray(assignments)
    ? assignments
        .map((assignment) => ({
          candidateId: String(assignment?.candidateId || '').trim(),
          targetShopId: String(assignment?.targetShopId || '').trim(),
        }))
        .filter((assignment) => assignment.candidateId && assignment.targetShopId)
    : [];
  if (!normalizedAssignments.length) {
    throw new LocalApiError('请先为至少一条多店数据明确选择归属店铺。', {
      status: 400,
      code: 'SHOP_SCOPE_MANUAL_RESOLUTION_ASSIGNMENTS_REQUIRED',
    });
  }
  if (
    new Set(normalizedAssignments.map((assignment) => assignment.candidateId)).size !== normalizedAssignments.length
  ) {
    throw new LocalApiError('同一条多店数据只能选择一个归属店铺。', {
      status: 400,
      code: 'SHOP_SCOPE_MANUAL_RESOLUTION_DUPLICATE_ASSIGNMENT',
    });
  }
  return requestLocalApi('/api/app/shop-scope-manual-resolution/confirm', {
    method: 'POST',
    body: {
      confirmation: 'APPLY_MANUAL_SHOP_SCOPE_RESOLUTION',
      previewFingerprint: fingerprint,
      assignments: normalizedAssignments,
    },
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getTechnicalRetentionPreview(options = {}) {
  return requestLocalApi('/api/app/technical-retention-preview', {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getTechnicalRetentionStatus(options = {}) {
  return requestLocalApi('/api/app/technical-retention/status', {
    timeoutMs: options.timeoutMs || 45000,
    signal: options.signal,
  });
}

export function confirmTechnicalRetention(previewFingerprint, options = {}) {
  const fingerprint = String(previewFingerprint || '').trim();
  if (!fingerprint) {
    throw new LocalApiError('缺少技术清理预览指纹，请先重新检查。', {
      status: 400,
      code: 'TECHNICAL_RETENTION_PREVIEW_REQUIRED',
    });
  }
  if (options.backupAcknowledged !== true) {
    throw new LocalApiError('请先确认已创建可恢复保护副本。', {
      status: 400,
      code: 'TECHNICAL_RETENTION_BACKUP_ACK_REQUIRED',
    });
  }
  return requestLocalApi('/api/app/technical-retention/confirm', {
    method: 'POST',
    body: {
      confirmation: 'APPLY_TECHNICAL_RETENTION',
      previewFingerprint: fingerprint,
      backupAcknowledged: true,
    },
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getRubCnyRealtimeRate(options = {}) {
  return requestLocalApi('/api/exchange-rate/rub-cny/realtime', {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function listRubCnyRateCache(options = {}) {
  return requestLocalApi(`/api/exchange-rate/rub-cny/cache${createQueryString({ limit: options.limit })}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function saveRubCnyRateCache(records = [], options = {}) {
  return requestLocalApi('/api/exchange-rate/rub-cny/cache', {
    method: 'POST',
    body: { records: Array.isArray(records) ? records : [] },
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getRubCnyDailyRate(date, options = {}) {
  return requestLocalApi(
    `/api/exchange-rate/rub-cny/daily${createQueryString({
      date,
      allowNearest: options.allowNearest === false ? 'false' : undefined,
      maxLookbackDays: options.maxLookbackDays,
    })}`,
    {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    }
  );
}

export function getRubCnyDailyRates(dates = [], options = {}) {
  return requestLocalApi('/api/exchange-rate/rub-cny/daily-batch', {
    method: 'POST',
    body: {
      dates: Array.isArray(dates) ? dates : [],
      allowNearest: options.allowNearest !== false,
      maxLookbackDays: options.maxLookbackDays,
    },
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

async function ensureLocalOzonShopSaved(shop = {}, body = {}, options = {}) {
  const shopId = getLocalOzonShopId(shop, body);
  if (!shopId) return null;

  const clientId = String(shop?.clientId || shop?.client_id || body?.clientId || body?.client_id || '').trim();
  const apiKey = String(shop?.apiKey || shop?.api_key || body?.apiKey || body?.api_key || '').trim();
  if (!clientId || !apiKey) return null;

  return saveLocalShop(
    {
      id: shopId,
      name: getLocalOzonShopName(shop, shopId),
      alias: String(shop?.shopAlias || shop?.alias || '').trim(),
      clientId,
      apiKey,
      status: 'active',
    },
    {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    }
  );
}

async function readLocalProductCacheForOzon(endpoint, shop, body = {}, options = {}) {
  const shopId = getLocalOzonShopId(shop, body);
  if (!shopId) {
    throw new LocalApiError('商品列表本地缓存读取需要 shopId。', {
      status: 400,
      code: 'LOCAL_PRODUCT_SHOP_ID_REQUIRED',
    });
  }

  const filter = body?.filter && typeof body.filter === 'object' ? body.filter : {};
  const productIds = body?.product_id || filter.product_id || body?.productIds || filter.productIds;
  const offerIds = body?.offer_id || filter.offer_id || body?.offerIds || filter.offerIds;
  const identityCount = Math.max(
    countLocalProductIdentityValues(productIds),
    countLocalProductIdentityValues(offerIds)
  );
  const explicitLimit = Number(body?.limit ?? body?.pageSize);
  const requestedLimit = Number.isFinite(explicitLimit) && explicitLimit > 0 ? explicitLimit : identityCount || 20;
  const projection = String(body?.projection || '').trim();
  const maximumLimit = projection === 'warehouse-picker' ? 5000 : 1000;
  const limit = Math.max(1, Math.min(requestedLimit, maximumLimit));
  const offset = parseLocalProductOffsetCursor(body?.last_id || body?.lastId);
  const explicitVisibility = filter.visibility || body?.visibility || '';
  const visibility = String(explicitVisibility || 'ALL')
    .trim()
    .toUpperCase();

  // 列表读取只读 SQLite。只有用户明确触发 forceRefresh 时，才允许额外提交同步任务。
  // 正常打开/切换页面的预热由 local-api continuousSyncService 统一完成。
  if (endpoint === '/v3/product/list' && limit >= 1000 && body?.forceRefresh === true && body?.autoSync !== false) {
    startDomainSync(
      'products',
      {
        shopId,
        visibility,
        pageSize: Math.min(limit, 1000),
        maxPages: 'all',
        hydrate: true,
        allStatuses: visibility === 'ALL',
        forceRefresh: true,
        requestedBy: 'frontend-product-list-refresh',
      },
      { timeoutMs: 3000 }
    ).catch(() => undefined);
  }

  const cacheQuery = {
    shopId,
    scope: visibility === 'ALL' ? 'software_all' : 'status',
    sort: 'stable',
    pageSize: limit,
    offset,
    productIds: Array.isArray(productIds) ? productIds.join(',') : productIds,
    offerIds: Array.isArray(offerIds) ? offerIds.join(',') : offerIds,
  };
  if (endpoint === '/v3/product/list' || explicitVisibility) cacheQuery.visibility = visibility;
  if (endpoint === '/v3/product/list' && projection) cacheQuery.projection = projection;

  const cache = await getDomainCache('products', cacheQuery, options);
  const rows = Array.isArray(cache?.rows) ? cache.rows : [];

  if (endpoint === '/v3/product/list') {
    const nextOffset = offset + rows.length;
    return {
      result: {
        items: rows.map(toOzonProductListItem),
        total: Number(cache?.total) || rows.length,
        last_id: nextOffset < (Number(cache?.total) || 0) ? `offset:${nextOffset}` : '',
      },
      localApiCache: {
        source: cache?.source || 'sqlite',
        durationMs: cache?.durationMs,
        stale: Boolean(cache?.stale),
      },
    };
  }

  if (endpoint === '/v3/product/info/list') {
    return { items: rows.map(toOzonProductInfoItem) };
  }

  if (endpoint === '/v4/product/info/attributes') {
    return {
      result: rows.map((row) => ({
        product_id: row.productId ? Number(row.productId) || row.productId : undefined,
        offer_id: row.offerId || '',
        sku: row.sku || '',
        name: row.name || '',
        primary_image: row.primaryImageUrl || row.images?.[0] || '',
        images: Array.isArray(row.images) ? row.images : row.primaryImageUrl ? [row.primaryImageUrl] : [],
        category_name: getProductSoftwareCategoryText(row) || '',
        description_category_id: row.categoryId || '',
        type_id: row.typeId || row.type_id || '',
        attributes: Array.isArray(row.attributes) ? row.attributes : [],
        weight: row.weightKg ?? undefined,
        width: row.widthCm ?? undefined,
        height: row.heightCm ?? undefined,
        depth: row.depthCm ?? undefined,
        weight_unit: 'kg',
        dimension_unit: 'cm',
      })),
    };
  }

  if (endpoint === '/v2/product/pictures/info') {
    return {
      items: rows.map((row) => ({
        product_id: row.productId ? Number(row.productId) || row.productId : undefined,
        offer_id: row.offerId || '',
        primary_image: row.primaryImageUrl || row.images?.[0] || '',
        images: Array.isArray(row.images) ? row.images : row.primaryImageUrl ? [row.primaryImageUrl] : [],
        pictures: Array.isArray(row.images) ? row.images : row.primaryImageUrl ? [row.primaryImageUrl] : [],
      })),
    };
  }

  if (endpoint === '/v5/product/info/prices') {
    return {
      items: rows.map((row) => ({
        product_id: row.productId ? Number(row.productId) || row.productId : undefined,
        offer_id: row.offerId || '',
        price: buildLocalProductPriceEvidence(row, getProductDisplayCurrencyCode(row)),
        acquiring: row.acquiringFeeValue ?? undefined,
        acquiring_amount: row.acquiringFeeValue ?? undefined,
        acquiring_status: row.acquiringStatus || 'pending',
        acquiring_provenance: row.acquiringProvenance || null,
        financial_data: buildLocalProductFinancialData(row),
        commissions: buildLocalProductCommissions(row),
        commission_status: row.commissionStatus || 'pending',
        commission_provenance: row.commissionProvenance || null,
      })),
    };
  }

  if (endpoint === '/v4/product/info/stocks') {
    return {
      items: rows.map((row) => ({
        product_id: row.productId ? Number(row.productId) || row.productId : undefined,
        offer_id: row.offerId || '',
        stocks: getLocalProductV4StockItems(row),
        present: row.stockValue ?? row.stock_value ?? undefined,
      })),
    };
  }

  return null;
}

const ORDER_SYNC_FINAL_STATUSES = new Set([
  'success',
  'partial',
  'failed',
  'canceled',
  'blocked',
  'rate_limited',
  'circuit_open',
]);

const ORDER_SYNC_FAILED_STATUSES = new Set(['failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open']);

function emitLocalOrderSyncProgress(options = {}, event = {}) {
  if (typeof options.onSyncProgress !== 'function') return;
  try {
    options.onSyncProgress({
      domain: options.domain || event.domain || 'orders',
      endpointKey: options.endpointKey || event.endpointKey || '',
      endpointLabel: options.endpointLabel || event.endpointLabel || '',
      source: options.source || event.source || '',
      shopId: options.shopId || event.shopId || '',
      shopLabel: options.shopLabel || event.shopLabel || '',
      ...event,
    });
  } catch {
    // Progress callbacks must never interrupt order sync.
  }
}

export async function waitForLocalOrderSyncJob(syncPayload = {}, options = {}) {
  const jobId = getLocalOrderSyncJobId(syncPayload);
  if (!jobId) return { ok: true, jobId: '', status: '', timedOut: false, job: null };

  const timeoutMs = Math.max(Number(options.timeoutMs) || 180_000, 1_000);
  const intervalMs = Math.max(Number(options.intervalMs) || 1_000, 100);
  const startedAt = Date.now();
  let lastPayload = syncPayload;
  let consecutiveTransportFailures = 0;
  const maxTransportPollFailures = Math.max(Number(options.maxTransportPollFailures) || 2, 1);
  emitLocalOrderSyncProgress(options, {
    phase: 'submitted',
    jobId,
    status: getLocalOrderSyncStatus(syncPayload) || 'queued',
    job: getLocalOrderSyncJob(syncPayload),
  });

  while (Date.now() - startedAt <= timeoutMs) {
    const remainingMs = Math.max(timeoutMs - (Date.now() - startedAt), 1_000);
    try {
      lastPayload = await getSyncJob(jobId, {
        timeoutMs: Math.min(Math.max(remainingMs, 1_000), 5_000),
        signal: options.signal,
        transportRetry: false,
      });
      consecutiveTransportFailures = 0;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (isLocalApiTransportError(error)) consecutiveTransportFailures += 1;
      emitLocalOrderSyncProgress(options, {
        phase: 'poll_error',
        jobId,
        status: getLocalOrderSyncStatus(lastPayload) || 'running',
        job: getLocalOrderSyncJob(lastPayload),
        error: error?.message || String(error),
      });
      if (consecutiveTransportFailures >= maxTransportPollFailures) {
        return {
          ok: false,
          jobId,
          status: getLocalOrderSyncStatus(lastPayload) || 'transport_failed',
          timedOut: false,
          transportFailed: true,
          transportFailureCount: consecutiveTransportFailures,
          job: getLocalOrderSyncJob(lastPayload),
          payload: lastPayload,
          error,
        };
      }
      await sleepLocalOrderSync(intervalMs);
      continue;
    }
    const status = getLocalOrderSyncStatus(lastPayload);
    const final = ORDER_SYNC_FINAL_STATUSES.has(status);
    emitLocalOrderSyncProgress(options, {
      phase: final ? 'completed' : 'running',
      jobId,
      status,
      job: getLocalOrderSyncJob(lastPayload),
    });
    if (final) {
      return {
        ok: !ORDER_SYNC_FAILED_STATUSES.has(status),
        jobId,
        status,
        timedOut: false,
        job: getLocalOrderSyncJob(lastPayload),
        payload: lastPayload,
      };
    }
    await sleepLocalOrderSync(intervalMs);
  }

  emitLocalOrderSyncProgress(options, {
    phase: 'timeout',
    jobId,
    status: getLocalOrderSyncStatus(lastPayload) || 'timeout',
    job: getLocalOrderSyncJob(lastPayload),
  });

  return {
    ok: false,
    jobId,
    status: getLocalOrderSyncStatus(lastPayload) || 'timeout',
    timedOut: true,
    job: getLocalOrderSyncJob(lastPayload),
    payload: lastPayload,
  };
}

function createLocalOrderSyncError(syncWaitResult = {}, options = {}) {
  if (syncWaitResult.transportFailed) {
    return new LocalApiError('本地服务连接中断，已停止本批剩余店铺读取并保留当前缓存。', {
      status: 0,
      code: 'LOCAL_API_TRANSPORT_FAILED',
      payload: syncWaitResult,
    });
  }
  if (syncWaitResult.timedOut) {
    return new LocalApiError('订单已提交 Ozon 同步，但后台确认超时，请稍后刷新核对。', {
      status: 0,
      code: 'LOCAL_ORDER_SYNC_TIMEOUT',
      payload: syncWaitResult,
    });
  }
  const message =
    syncWaitResult?.job?.lastError ||
    syncWaitResult?.payload?.error?.message ||
    syncWaitResult?.error?.message ||
    '订单 Ozon 同步未完成，已保留当前本地缓存。';
  const companyBlocked = /OZON_COMPANY_BLOCKED|REASON=COMPANY_BLOCKED|Company is blocked|被\s*Ozon\s*封禁/iu.test(
    [
      message,
      syncWaitResult?.job?.lastError,
      syncWaitResult?.payload?.error?.code,
      syncWaitResult?.payload?.error?.message,
      syncWaitResult?.error?.code,
      syncWaitResult?.error?.message,
    ].filter(Boolean).join(' ')
  );
  if (companyBlocked) {
    const shopLabel = String(options.shopLabel || '当前店铺').trim() || '当前店铺';
    const blockedMessage = `${shopLabel}被 Ozon 封禁，无法刷新订单。`;
    return new LocalApiError(blockedMessage, {
      status: 403,
      code: 'OZON_COMPANY_BLOCKED',
      payload: {
        ...syncWaitResult,
        errorMessage: blockedMessage,
      },
    });
  }
  return new LocalApiError('订单 Ozon 同步未完成，已保留当前本地缓存。', {
    status: 0,
    code: 'LOCAL_ORDER_SYNC_FAILED',
    payload: {
      ...syncWaitResult,
      errorMessage: message,
    },
  });
}

function emitLocalReturnsSyncProgress(options = {}, event = {}) {
  emitLocalOrderSyncProgress({ ...options, domain: 'returns' }, event);
}

function createLocalReturnsSyncError(syncWaitResult = {}) {
  if (syncWaitResult.timedOut) {
    return new LocalApiError('售后同步已提交 Ozon，但后台确认超时，已保留当前本地缓存。', {
      status: 0,
      code: 'LOCAL_RETURNS_SYNC_TIMEOUT',
      payload: syncWaitResult,
    });
  }
  return new LocalApiError('售后 Ozon 同步未完成，已保留当前本地缓存。', {
    status: 0,
    code: 'LOCAL_RETURNS_SYNC_FAILED',
    payload: syncWaitResult,
  });
}

async function readLocalOrderCacheForOzon(endpoint, shop, body = {}, options = {}) {
  const shopId = getLocalOzonShopId(shop, body);
  if (!shopId) {
    throw new LocalApiError('订单本地缓存读取需要 shopId。', {
      status: 400,
      code: 'LOCAL_ORDER_SHOP_ID_REQUIRED',
    });
  }

  const meta = getOrderEndpointMeta(endpoint);
  const filter = body?.filter && typeof body.filter === 'object' ? body.filter : {};
  const limit = Math.max(1, Math.min(Number(body.limit || body.pageSize) || 100, 1000));
  const offset = Math.max(Number(body.offset) || 0, 0);
  const postingNumber = body.posting_number || body.postingNumber || filter.posting_number || '';
  const cacheQuery = {
    shopId,
    source: meta.source,
    postingNumber,
    status: Array.isArray(filter.status) ? filter.status[0] : filter.status || '',
    since: filter.since || filter.cutoff_from || body.since || '',
    to: filter.to || filter.cutoff_to || body.to || '',
    pageSize: limit,
    offset,
  };
  let cache = await getDomainCache('orders', cacheQuery, options);
  let rows = Array.isArray(cache?.rows) ? cache.rows : [];
  let syncWaitResult = null;
  let syncError = null;

  if (body?.forceRefresh === true && body?.autoSync !== false) {
    const syncMaxPages = meta.detail ? 1 : Math.max(1, Math.floor(Number(body.syncMaxPages || body.maxPages) || 1));
    const syncPayload = await startDomainSync(
      'orders',
      {
        shopId,
        endpointKey: meta.endpointKey,
        action: meta.detail ? 'sync-order-detail' : 'sync-orders-list',
        params: getLocalOrderSyncParams(body),
        pageSize: limit,
        maxPages: syncMaxPages,
        forceRefresh: body.forceRefresh === true,
        priority: body.priority || 'P1',
        profile: body.profile || body.schedulerProfile || 'foreground',
        schedulerProfile: body.schedulerProfile || body.profile || 'foreground',
        source: body.syncSource || 'manual-order-refresh',
        syncSource: body.syncSource || 'manual-order-refresh',
        requestedBy: body.requestedBy || 'frontend-orders-manual-refresh',
      },
      { timeoutMs: 3000 }
    ).catch((submitError) => ({ accepted: false, submitError }));

    if (body.forceRefresh === true && !syncPayload?.accepted) {
      syncError = createLocalOrderSyncSubmitError(syncPayload);
    }

    if (body.forceRefresh === true && syncPayload?.accepted) {
      const progressOptions = {
        ...options,
        endpointKey: meta.endpointKey,
        source: meta.source,
        shopId,
        shopLabel: options.shopLabel || getLocalOzonShopName(shop, shopId),
      };
      emitLocalOrderSyncProgress(progressOptions, {
        phase: 'accepted',
        jobId: getLocalOrderSyncJobId(syncPayload),
        status: getLocalOrderSyncStatus(syncPayload) || 'queued',
        job: getLocalOrderSyncJob(syncPayload),
      });
      syncWaitResult = await waitForLocalOrderSyncJob(syncPayload, {
        ...progressOptions,
        timeoutMs: options.orderSyncTimeoutMs || 180_000,
        intervalMs: options.orderSyncPollIntervalMs || 1_000,
        signal: options.signal,
      });
      if (!syncWaitResult.ok) syncError = createLocalOrderSyncError(syncWaitResult, progressOptions);
      cache = await getDomainCache('orders', cacheQuery, options);
      rows = Array.isArray(cache?.rows) ? cache.rows : [];
    }
    if (syncError && rows.length === 0) throw syncError;
  }

  if (meta.detail) {
    return { result: rows.length ? toOzonOrderPosting(rows[0]) : null };
  }

  const total = Number(cache?.total) || rows.length;
  return {
    result: {
      postings: rows.map(toOzonOrderPosting),
      total,
      has_next: offset + rows.length < total,
    },
    localApiCache: {
      source: cache?.source || 'sqlite',
      durationMs: cache?.durationMs,
      stale: Boolean(cache?.stale),
      syncJob: syncWaitResult
        ? {
            jobId: syncWaitResult.jobId,
            status: syncWaitResult.status,
            timedOut: Boolean(syncWaitResult.timedOut),
          }
        : null,
      syncError: syncError
        ? {
            code: syncError.code || syncError.payload?.code || 'LOCAL_ORDER_SYNC_FAILED',
            message:
              syncError.payload?.errorMessage ||
              syncError.payload?.job?.lastError ||
              syncError.message ||
              '订单同步未完成，已使用 SQLite 本地缓存。',
          }
        : null,
    },
  };
}

async function readLocalFinanceCacheForOzon(endpoint, shop, body = {}, options = {}) {
  const shopId = getLocalOzonShopId(shop, body);
  if (!shopId) {
    throw new LocalApiError('财务流水本地缓存读取需要 shopId。', {
      status: 400,
      code: 'LOCAL_FINANCE_SHOP_ID_REQUIRED',
    });
  }

  const filter = body?.filter && typeof body.filter === 'object' ? body.filter : {};
  const dateRange = getFinanceDateRangeFromBody(body);
  const postingNumber = filter.posting_number || body.postingNumber || body.posting_number || '';
  const pageSize = Math.max(1, Math.min(Number(body?.page_size || body?.pageSize) || 1000, 1000));
  const page = Math.max(Number(body?.page) || 1, 1);

  if (
    endpoint === '/v3/finance/transaction/list' &&
    page === 1 &&
    body?.forceRefresh === true &&
    body?.autoSync !== false
  ) {
    startDomainSync(
      'finance',
      {
        shopId,
        endpointKey: 'finance.transactionList',
        action: 'sync-finance-transactions',
        params: body,
        postingNumber,
        from: dateRange.from,
        to: dateRange.to,
        pageSize,
        maxPages: body.maxPages || 1,
        forceRefresh: body.forceRefresh === true,
        requestedBy: 'frontend-finance-legacy-adapter',
      },
      { timeoutMs: 3000 }
    ).catch(() => undefined);
  }

  const cache = await getDomainCache(
    'finance',
    {
      shopId,
      postingNumber,
      from: dateRange.from,
      to: dateRange.to,
      page,
      pageSize,
    },
    options
  );
  const rows = Array.isArray(cache?.rows) ? cache.rows : [];
  const total = Number(cache?.total) || rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return {
    result: {
      operations: rows.map(toOzonFinanceOperation),
      page_count: pageCount,
      row_count: total,
    },
    localApiCache: {
      source: cache?.source || 'sqlite',
      durationMs: cache?.durationMs,
      stale: Boolean(cache?.stale),
    },
  };
}

async function readLocalReturnsCacheForOzon(endpoint, shop, body = {}, options = {}) {
  const shopId = getLocalOzonShopId(shop, body);
  if (!shopId) {
    throw new LocalApiError('售后本地缓存读取需要 shopId。', {
      status: 400,
      code: 'LOCAL_RETURNS_SHOP_ID_REQUIRED',
    });
  }

  const meta = getReturnsEndpointMeta(endpoint);
  const dateRange = getReturnsDateRangeFromBody(body);
  const limit = Math.max(1, Math.min(Number(body.limit || body.pageSize) || 100, 1000));
  const offset = Math.max(Number(body.offset) || 0, 0);
  const returnId = body.return_id || body.returnId || body.id || '';
  const cacheQuery = {
    shopId,
    source: meta.source,
    returnId,
    since: dateRange.since,
    to: dateRange.to,
    pageSize: limit,
    offset,
  };
  let cache = await getDomainCache('returns', cacheQuery, options);
  let rows = Array.isArray(cache?.rows) ? cache.rows : [];
  let syncWaitResult = null;

  if (body?.forceRefresh === true && body?.autoSync !== false) {
    const syncPayload = await startDomainSync(
      'returns',
      {
        shopId,
        endpointKey: meta.endpointKey,
        action: meta.detail ? 'sync-rfbs-return-detail' : 'sync-returns-list',
        params: body,
        pageSize: limit,
        maxPages: meta.detail ? 1 : body.syncMaxPages || body.maxPages || 1,
        forceRefresh: body.forceRefresh === true,
        recordNotifications: body.recordNotifications === true,
        profile: body.profile,
        schedulerProfile: body.schedulerProfile,
        source: body.syncSource,
        syncSource: body.syncSource,
        requestedBy: body.requestedBy || 'frontend-returns-legacy-adapter',
      },
      { timeoutMs: 3000 }
    ).catch(() => null);

    if (body.forceRefresh === true && !syncPayload?.accepted) {
      throw createLocalReturnsSyncSubmitError(syncPayload);
    }

    if (body.forceRefresh === true && syncPayload?.accepted) {
      const progressOptions = {
        ...options,
        domain: 'returns',
        endpointKey: meta.endpointKey,
        source: meta.source,
        shopId,
        shopLabel: options.shopLabel || getLocalOzonShopName(shop, shopId),
      };
      emitLocalReturnsSyncProgress(progressOptions, {
        phase: 'accepted',
        jobId: getLocalOrderSyncJobId(syncPayload),
        status: getLocalOrderSyncStatus(syncPayload) || 'queued',
        job: getLocalOrderSyncJob(syncPayload),
      });
      syncWaitResult = await waitForLocalOrderSyncJob(syncPayload, {
        ...progressOptions,
        timeoutMs: options.orderSyncTimeoutMs || 180_000,
        intervalMs: options.orderSyncPollIntervalMs || 1_000,
        signal: options.signal,
      });
      if (!syncWaitResult.ok) throw createLocalReturnsSyncError(syncWaitResult);
      cache = await getDomainCache('returns', cacheQuery, options);
      rows = Array.isArray(cache?.rows) ? cache.rows : [];
    }
  }

  if (meta.detail) {
    return {
      result: rows.length ? toOzonReturnItem(rows[0]) : null,
      localApiCache: {
        source: cache?.source || 'sqlite',
        durationMs: cache?.durationMs,
        stale: Boolean(cache?.stale),
        syncJob: syncWaitResult
          ? {
              jobId: syncWaitResult.jobId,
              status: syncWaitResult.status,
              timedOut: Boolean(syncWaitResult.timedOut),
            }
          : null,
      },
    };
  }

  const total = Number(cache?.total) || rows.length;
  const items = rows.map(toOzonReturnItem);
  if (meta.source === 'conditional') {
    return {
      result: {
        conditional_cancellations: items,
        total,
        has_next: offset + rows.length < total,
      },
      localApiCache: {
        source: cache?.source || 'sqlite',
        durationMs: cache?.durationMs,
        stale: Boolean(cache?.stale),
        syncJob: syncWaitResult
          ? {
              jobId: syncWaitResult.jobId,
              status: syncWaitResult.status,
              timedOut: Boolean(syncWaitResult.timedOut),
            }
          : null,
      },
    };
  }
  return {
    returns: items,
    result: {
      returns: items,
      total,
      has_next: offset + rows.length < total,
    },
    localApiCache: {
      source: cache?.source || 'sqlite',
      durationMs: cache?.durationMs,
      stale: Boolean(cache?.stale),
      syncJob: syncWaitResult
        ? {
            jobId: syncWaitResult.jobId,
            status: syncWaitResult.status,
            timedOut: Boolean(syncWaitResult.timedOut),
          }
        : null,
    },
  };
}

async function readLocalLogisticsCacheForOzon(endpoint, shop, body = {}, options = {}) {
  const shopId = getLocalOzonShopId(shop, body);
  if (!shopId) {
    throw new LocalApiError('物流/仓库本地缓存读取需要 shopId。', {
      status: 400,
      code: 'LOCAL_LOGISTICS_SHOP_ID_REQUIRED',
    });
  }

  const meta = getLogisticsEndpointMeta(endpoint);
  const cacheKey = `logistics:${shopId}:${meta.endpointKey}`;
  const shouldForegroundSync = body?.forceRefresh === true && body?.autoSync !== false;
  const shouldBackgroundSync = shouldForegroundSync && body?.backgroundRefresh === true;
  let cache = null;
  let syncWaitResult = null;
  let syncError = null;

  if (shouldBackgroundSync) {
    const syncParams = getLocalLogisticsSyncParams(body, meta);
    startDomainSync(
      'logistics',
      {
        shopId,
        endpointKey: meta.endpointKey,
        type: meta.type,
        params: syncParams,
        forceRefresh: true,
        requestedBy: 'frontend-logistics-background-refresh',
      },
      { timeoutMs: 3000 }
    ).catch(() => undefined);
    cache = await getDomainCache('logistics', { shopId, cacheKey, pageSize: 1 }, options);
  } else if (shouldForegroundSync) {
    const syncParams = getLocalLogisticsSyncParams(body, meta);
    const syncPayload = await startDomainSync(
      'logistics',
      {
        shopId,
        endpointKey: meta.endpointKey,
        type: meta.type,
        params: syncParams,
        forceRefresh: body.forceRefresh === true,
        requestedBy: 'frontend-logistics-legacy-adapter',
      },
      { timeoutMs: 3000 }
    ).catch(() => null);

    if (!syncPayload?.accepted) {
      syncError = createLocalLogisticsSyncSubmitError(syncPayload);
    } else {
      syncWaitResult = await waitForLocalOrderSyncJob(syncPayload, {
        ...options,
        domain: 'logistics',
        endpointKey: meta.endpointKey,
        source: meta.type,
        shopId,
        shopLabel: options.shopLabel || getLocalOzonShopName(shop, shopId),
        timeoutMs: options.logisticsSyncTimeoutMs || 15_000,
        intervalMs: options.logisticsSyncPollIntervalMs || 500,
        signal: options.signal,
      });
      if (!syncWaitResult.ok) syncError = createLocalLogisticsSyncError(syncWaitResult);
    }
    cache = await getDomainCache('logistics', { shopId, cacheKey, pageSize: 2 }, options);
    if (syncError && (!Array.isArray(cache?.rows) || cache.rows.length === 0)) throw syncError;
  } else {
    cache = await getDomainCache('logistics', { shopId, cacheKey, pageSize: 1 }, options);
  }

  const row = Array.isArray(cache?.rows) ? cache.rows[0] : null;
  const payload = row?.payload || {};
  const localApiCache = {
    source: cache?.source || 'sqlite',
    durationMs: cache?.durationMs,
    stale: Boolean(cache?.stale),
    syncJob: syncWaitResult
      ? {
          jobId: syncWaitResult.jobId,
          status: syncWaitResult.status,
          timedOut: Boolean(syncWaitResult.timedOut),
        }
      : null,
    syncError: syncError
      ? {
          code: syncError.code || syncError.payload?.code || 'LOCAL_LOGISTICS_SYNC_FAILED',
          message:
            syncError.payload?.errorMessage ||
            syncError.payload?.job?.lastError ||
            syncError.message ||
            '仓库物流同步未完成，已使用本地缓存。',
        }
      : null,
  };

  const items = getLogisticsPayloadItems(payload, meta.type);
  if (meta.type === 'warehouses') {
    return {
      result: items,
      warehouses: items,
      localApiCache,
    };
  }
  return {
    result: items,
    delivery_methods: items,
    methods: items,
    localApiCache,
  };
}

async function readLocalRatingPenaltyCacheForOzon(endpoint, shop, body = {}, options = {}) {
  const shopId = getLocalOzonShopId(shop, body);
  if (!shopId) {
    throw new LocalApiError('错误指数本地缓存读取需要 shopId。', {
      status: 400,
      code: 'LOCAL_RATING_SHOP_ID_REQUIRED',
    });
  }

  const filter = body?.filter && typeof body.filter === 'object' ? body.filter : {};
  const dateRange = getRatingPenaltyDateRangeFromBody(body);
  const limit = Math.max(1, Math.min(Number(body.limit || body.pageSize) || 1000, 1000));
  const offset = Math.max(Number(body.offset) || 0, 0);
  const postingNumber = filter.posting_number || body.posting_number || body.postingNumber || '';
  const cacheQuery = {
    scope: 'rating-penalties',
    shopId,
    postingNumber,
    since: dateRange.since,
    to: dateRange.to,
    pageSize: limit,
    offset,
  };
  let cache = await getDomainCache('profit', cacheQuery, options);
  let syncWaitResult = null;

  if ((body?.forceRefresh === true || cache?.complete !== true) && body?.autoSync !== false) {
    const syncPayload = await startDomainSync(
      'profit',
      {
        shopId,
        endpointKey: 'rating.fbsPostingList',
        action: 'sync-rating-penalties',
        params: body,
        pageSize: limit,
        maxPages: body.syncMaxPages || body.maxPages || 50,
        forceRefresh: true,
        requestedBy: 'frontend-profit-rating-legacy-adapter',
      },
      { timeoutMs: 3000, signal: options.signal }
    );
    if (!syncPayload?.accepted || !getLocalOrderSyncJobId(syncPayload)) {
      throw new LocalApiError('罚款同步未成功提交，不能把旧缓存当作最新费用。', {
        status: 502, code: 'LOCAL_RATING_SYNC_NOT_ACCEPTED', payload: syncPayload,
      });
    }
    syncWaitResult = await waitForLocalOrderSyncJob(syncPayload, {
      ...options, domain: 'profit', shopId,
      timeoutMs: options.orderSyncTimeoutMs || 180_000,
      intervalMs: options.orderSyncPollIntervalMs || 1_000,
    });
    if (!syncWaitResult.ok || syncWaitResult.status !== 'success') {
      throw new LocalApiError('罚款没有完整同步，费用暂不能确认为最新，请重试。', {
        status: 502, code: 'LOCAL_RATING_SYNC_INCOMPLETE', payload: syncWaitResult,
      });
    }
    cache = await getDomainCache('profit', cacheQuery, options);
  }
  if (cache?.complete !== true) {
    throw new LocalApiError('罚款缓存缺少当前范围的完整同步回执，请刷新后重试。', {
      status: 409, code: 'LOCAL_RATING_CACHE_INCOMPLETE', payload: cache,
    });
  }

  const rows = Array.isArray(cache?.rows) ? cache.rows : [];
  const total = Number(cache?.total) || rows.length;
  return {
    result: {
      postings: rows,
      total,
      has_next: offset + rows.length < total,
    },
    localApiCache: { source: cache?.source || 'sqlite', durationMs: cache?.durationMs,
      stale: Boolean(cache?.stale), complete: cache?.complete, syncJob: syncWaitResult },
  };
}
async function readLocalShopConnectionForOzon(endpoint, shop = {}, body = {}, options = {}) {
  const shopId = getLocalOzonShopId(shop, body);
  if (!shopId) {
    throw new LocalApiError('Ozon 店铺测试连接需要 shopId。', {
      status: 400,
      code: 'LOCAL_OZON_SHOP_ID_REQUIRED',
    });
  }

  await ensureLocalOzonShopSaved(shop, body, options);
  let result = null;
  try {
    result = await testLocalShopConnection(shopId, options);
  } catch (error) {
    if (error instanceof LocalApiError && error.payload?.error?.message) {
      throw new LocalApiError(error.payload.error.message, {
        status: error.status,
        code: error.payload.error.code || error.code,
        payload: error.payload,
      });
    }
    throw error;
  }
  if (!result?.ok) {
    throw new LocalApiError(result?.error?.message || 'Ozon 店铺连接测试失败。', {
      status: 502,
      code: result?.error?.code || 'SHOP_CONNECTION_TEST_FAILED',
      payload: result,
    });
  }

  if (endpoint === '/v1/roles') {
    return result.roles || result.checks?.roles?.data || { result: { roles: [] } };
  }

  return result.sellerInfo || result.checks?.sellerInfo?.data || { result: { name: result.shop?.name || '' } };
}

async function requestRegisteredOzonViaLocalApi(input = {}, options = {}) {
  const payload = {
    endpoint: normalizeOzonEndpoint(input.endpoint || input.path || ''),
    method: input.method || 'POST',
    access: input.access || 'read',
    body: input.body || {},
    shop: input.shop || {},
    confirmed: input.confirmed === true,
    realWrite: input.realWrite === true,
    dryRun: input.dryRun === true,
    fastAck: input.fastAck === true,
    asyncWrite: input.asyncWrite === true,
    waitForResult: input.waitForResult !== false,
    requestedBy: input.requestedBy || 'frontend-legacy-ozon-adapter',
  };
  const result = await requestLocalApi('/api/ozon/request', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (!result?.ok) {
    throw new LocalApiError(result?.error?.message || 'local-api 真实 Ozon 请求失败。', {
      status: 502,
      code: result?.error?.code || 'LOCAL_OZON_REQUEST_FAILED',
      payload: result,
    });
  }
  const data = result.data ?? result.schedulerResult?.data ?? null;
  if (payload.access === 'write') {
    return {
      ...(data && typeof data === 'object' ? data : { result: data }),
      localApiWrite: {
        endpointKey: result.endpointKey,
        schedulerResult: result.schedulerResult,
        realWrite: result.schedulerResult?.realWrite === true,
        dryRun: result.schedulerResult?.dryRun === true,
      },
    };
  }
  return data ?? result;
}

// Explicit remote verification. The legacy finance adapter below intentionally
// reads SQLite and must not be used to certify an empty official response.
export async function readLiveProfitFinancePostings(shopId, postingNumbers, options = {}) {
  if (!shopId || !Array.isArray(postingNumbers) || postingNumbers.length < 1 || postingNumbers.length > 20) {
    throw new LocalApiError('流水批量核验缺少店铺或准确单号。', { code: 'FINANCE_VERIFY_SCOPE_REQUIRED' });
  }
  const result = await requestLocalApi('/api/ozon/request', {
    method: 'POST', signal: options.signal, timeoutMs: 90000,
    body: { endpointKey: 'finance.transactionList', access: 'read', shopId, postingNumbers,
      forceRefresh: true, allowStale: false, requestedBy: 'profit-empty-finance-verification' },
  });
  const entries = result?.data?.postingResults;
  const keys = [...new Set(postingNumbers)];
  if (result?.ok !== true || !Array.isArray(entries) || entries.length !== keys.length
    || entries.some(row => !row || typeof row !== 'object')
    || new Set(entries.map(row => row.postingNumber)).size !== keys.length
    || entries.some(row => !keys.includes(row.postingNumber))) {
    throw new LocalApiError('财务批量核验结果未完整返回。', { code: 'FINANCE_VERIFY_NOT_COMPLETE' });
  }
  return new Map(entries.map(row => [row.postingNumber, row]));
}

export async function readLiveProfitFinancePosting(shopId, postingNumber, page = 1, options = {}) {
  if (!shopId || !/^\d{6,}-\d{3,}(?:-\d+)?$/.test(String(postingNumber))) {
    throw new LocalApiError('流水核验缺少准确店铺或单号。', { code: 'FINANCE_VERIFY_SCOPE_REQUIRED' });
  }
  // The local scheduler requires a date window; Ozon's posting-number filter
  // returns posting history independently of this date (live control verified).
  // Keep it to one window so the scheduler does not repeat the same lookup.
  const to = new Date();
  const from = new Date(to); from.setUTCHours(0, 0, 0, 0);
  const result = await requestLocalApi('/api/ozon/request', {
    method: 'POST', signal: options.signal, timeoutMs: 30000,
    body: { endpointKey: 'finance.transactionList', access: 'read', shopId,
      forceRefresh: true, allowStale: false, requestedBy: 'profit-empty-finance-verification',
      params: { filter: { posting_number: postingNumber, transaction_type: 'all', operation_type: [],
        date: { from: from.toISOString(), to: to.toISOString() } }, page, page_size: 1000 } },
  });
  if (result?.ok !== true || result.schedulerResult?.status !== 'success' || !result.data) {
    throw new LocalApiError('官方流水尚未完整核验，请稍后重试。', { code: 'FINANCE_VERIFY_NOT_COMPLETE' });
  }
  return result.data;
}

export async function requestLocalOzon(input = {}, options = {}) {
  const endpoint = normalizeOzonEndpoint(input.endpoint || input.path || '');
  const shopTestReadEndpoints = new Set(['/v1/roles', '/v1/seller/info']);
  if (shopTestReadEndpoints.has(endpoint)) {
    return readLocalShopConnectionForOzon(endpoint, input.shop || {}, input.body || {}, options);
  }

  const productReadEndpoints = new Set([
    '/v3/product/list',
    '/v3/product/info/list',
    '/v4/product/info/attributes',
    '/v2/product/pictures/info',
    '/v5/product/info/prices',
    '/v4/product/info/stocks',
  ]);
  if (productReadEndpoints.has(endpoint)) {
    return readLocalProductCacheForOzon(endpoint, input.shop || {}, input.body || {}, options);
  }

  if (endpoint === '/v3/finance/transaction/list') {
    return readLocalFinanceCacheForOzon(endpoint, input.shop || {}, input.body || {}, options);
  }

  const orderReadEndpoints = new Set([
    '/v3/posting/fbs/list',
    '/v3/posting/fbs/unfulfilled/list',
    '/v2/posting/fbo/list',
    '/v3/posting/fbs/get',
    '/v2/posting/fbo/get',
  ]);
  if (orderReadEndpoints.has(endpoint)) {
    return readLocalOrderCacheForOzon(endpoint, input.shop || {}, input.body || {}, options);
  }

  const returnsReadEndpoints = new Set([
    '/v1/returns/list',
    '/v2/returns/rfbs/list',
    '/v2/returns/rfbs/get',
    '/v2/conditional-cancellation/list',
  ]);
  if (returnsReadEndpoints.has(endpoint)) {
    return readLocalReturnsCacheForOzon(endpoint, input.shop || {}, input.body || {}, options);
  }

  const logisticsReadEndpoints = new Set(['/v2/warehouse/list', '/v2/delivery-method/list']);
  if (logisticsReadEndpoints.has(endpoint)) {
    return readLocalLogisticsCacheForOzon(endpoint, input.shop || {}, input.body || {}, options);
  }

  if (endpoint === '/v1/rating/index/fbs/posting/list') {
    return readLocalRatingPenaltyCacheForOzon(endpoint, input.shop || {}, input.body || {}, options);
  }

  return requestRegisteredOzonViaLocalApi(input, options);
}

export function readLocalOzonWarehouseList(shopId, options = {}) {
  const normalizedShopId = String(shopId || '').trim();
  if (!normalizedShopId) return Promise.resolve({ warehouses: [], result: [] });
  const refresh = options.refresh === true;
  return requestLocalOzon({
    endpoint: '/v2/warehouse/list',
    shop: { id: normalizedShopId, name: options.shopLabel || normalizedShopId },
    body: {
      limit: 100,
      ...(refresh ? { forceRefresh: true, autoSync: true } : {}),
    },
  }, options);
}

export function getDomainCache(domain, query = {}, options = {}) {
  const requestQuery = options.bypassHotCache === true
    ? { ...query, _bypassHotCache: 1 }
    : query;
  const loader = () => requestLocalApi(`/api/cache/${encodeURIComponent(domain)}${createQueryString(requestQuery)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    observe: options.observe,
  });
  return readOrderDomainCache(domain, query, options, loader);
}

export function saveDataAnalysisSnapshot(snapshot = {}, options = {}) {
  return requestLocalApi('/api/cache/data-analysis/snapshot', {
    method: 'POST',
    body: snapshot,
    timeoutMs: options.timeoutMs || 8000,
    signal: options.signal,
    observe: options.observe,
  });
}

export function deleteDataAnalysisSnapshot(query = {}, options = {}) {
  return requestLocalApi('/api/cache/data-analysis/snapshot', {
    method: 'DELETE',
    body: query,
    timeoutMs: options.timeoutMs || 8000,
    signal: options.signal,
    observe: options.observe,
  });
}

export function saveDataAnalysisSyncState(state = {}, options = {}) {
  return requestLocalApi('/api/cache/data-analysis/sync-state', {
    method: 'POST',
    body: state,
    timeoutMs: options.timeoutMs || 8000,
    signal: options.signal,
    observe: options.observe,
  });
}

export function getProfitLedgerSnapshot(snapshotKeys = [], options = {}) {
  const keys = Array.isArray(snapshotKeys) ? snapshotKeys.filter(Boolean).join(',') : String(snapshotKeys || '');
  return requestLocalApi(`/api/profit/ledger-snapshot${createQueryString({ keys, shopId: options.shopId, sharedOnly: options.sharedOnly, layoutOnly: options.layoutOnly })}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function getProfitLedgerStorageLayout(options = {}) {
  return getProfitLedgerSnapshot([], { ...options, layoutOnly: true });
}

export function getProfitOrderReview(query = {}, options = {}) {
  return requestLocalApi(`/api/profit/order-review${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function saveProfitLedgerSnapshot(snapshotKey, snapshot, options = {}) {
  return requestLocalApi('/api/profit/ledger-snapshot', {
    method: 'PUT',
    body: {
      snapshotKey,
      snapshot,
      ...(options.shopId ? { shopId: options.shopId } : {}),
      ...(options.sharedOnly ? { sharedOnly: true } : {}),
      ...(options.chunks ? { chunks: options.chunks } : {}),
      ...(options.chunkOf ? {
        chunkOf: options.chunkOf,
        writeId: options.writeId,
        chunkIndex: options.chunkIndex,
        chunkCount: options.chunkCount,
      } : {}),
    },
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function clearProfitLedgerSnapshots(snapshotKeys = [], options = {}) {
  const keys = Array.isArray(snapshotKeys) ? snapshotKeys.filter(Boolean) : [snapshotKeys].filter(Boolean);
  return requestLocalApi('/api/profit/ledger-snapshot', {
    method: 'DELETE',
    body: { snapshotKeys: keys, ...(options.shopId ? { shopId: options.shopId } : {}), ...(options.sharedOnly ? { sharedOnly: true } : {}) },
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function getProductSummary(query = {}, options = {}) {
  return requestLocalApi(`/api/products/summary${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function hydrateProductSummary(payload = {}, options = {}) {
  return requestLocalApi('/api/products/summary/hydrate', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function getProductMaterialProfiles(query = {}, options = {}) {
  return requestLocalApi(`/api/products/material${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

/** One-time typed legacy migration; normal single writes stay on /api/products/material. */
export function importLegacyProductMaterialProfiles(profiles = [], options = {}) {
  return requestLocalApi('/api/products/material/legacy-import', {
    method: 'POST',
    body: { profiles: Array.isArray(profiles) ? profiles : [] },
    timeoutMs: options.timeoutMs || 60000,
    signal: options.signal,
  });
}

export function getProductSourceLinks(query = {}, options = {}) {
  return requestLocalApi(`/api/products/source-links${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

/** One-time typed legacy migration; the desktop proxy must whitelist only this exact POST route. */
export function importLegacyProductSourceLinks(records = [], options = {}) {
  return requestLocalApi('/api/products/source-links/legacy-import', {
    method: 'POST',
    body: { records: Array.isArray(records) ? records : [] },
    timeoutMs: options.timeoutMs || 60000,
    signal: options.signal,
  });
}

export function getPurchaseOrderOverrides(query = {}, options = {}) {
  return requestLocalApi(`/api/purchase/orders/overrides${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function savePurchaseOrderOverride(payload = {}, options = {}) {
  return requestLocalApi('/api/purchase/orders/overrides', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

/** One-time typed legacy migration; normal single writes stay on /overrides. */
export function importLegacyPurchaseOrderOverrides(overrides = [], options = {}) {
  return requestLocalApi('/api/purchase/orders/overrides/legacy-import', {
    method: 'POST',
    body: { overrides: Array.isArray(overrides) ? overrides : [] },
    timeoutMs: options.timeoutMs || 60000,
    signal: options.signal,
  });
}

export function deletePurchaseOrderOverride(payload = {}, options = {}) {
  return requestLocalApi('/api/purchase/orders/overrides', {
    method: 'DELETE',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function previewPurchaseBrowserCapture(payload = {}, options = {}) {
  return requestLocalApi('/api/purchase/browser-capture/preview', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 15000,
    signal: options.signal,
  });
}

export function confirmPurchaseBrowserCapture(payload = {}, options = {}) {
  return requestLocalApi('/api/purchase/browser-capture/confirm', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 15000,
    signal: options.signal,
  });
}

export function readPurchaseBrowserCapture(target = {}, options = {}) {
  return requestLocalApi(`/api/purchase/browser-capture/readback${createQueryString({
    targetId: target.targetId,
    shopId: target.shopId,
    orderKey: target.orderKey,
    ozonOrderId: target.ozonOrderId,
    sku: target.sku,
    offerId: target.offerId,
    purchaseRecordId: target.purchaseRecordId,
  })}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
  });
}

export function simulateOrderTestSplit(payload = {}, options = {}) {
  return requestLocalApi('/api/orders/test-split-simulation', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getPurchaseSourceLinks(query = {}, options = {}) {
  return requestLocalApi(`/api/purchase/source-links${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function savePurchaseSourceLinks(payload = {}, options = {}) {
  return requestLocalApi('/api/purchase/source-links', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

/** One-time typed legacy migration; normal single writes stay on /source-links. */
export function importLegacyPurchaseSourceLinks(records = [], options = {}) {
  return requestLocalApi('/api/purchase/source-links/legacy-import', {
    method: 'POST',
    body: { records: Array.isArray(records) ? records : [] },
    timeoutMs: options.timeoutMs || 60000,
    signal: options.signal,
  });
}

export function deletePurchaseSourceLinks(payload = {}, options = {}) {
  return requestLocalApi('/api/purchase/source-links', {
    method: 'DELETE',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getSalesSourceLinks(query = {}, options = {}) {
  return requestLocalApi(`/api/sales/source-links${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function saveSalesSourceLinks(payload = {}, options = {}) {
  return requestLocalApi('/api/sales/source-links', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

/** One-time typed legacy migration; normal single writes stay on /source-links. */
export function importLegacySalesSourceLinks(records = [], options = {}) {
  return requestLocalApi('/api/sales/source-links/legacy-import', {
    method: 'POST',
    body: { records: Array.isArray(records) ? records : [] },
    timeoutMs: options.timeoutMs || 60000,
    signal: options.signal,
  });
}

export function deleteSalesSourceLinks(payload = {}, options = {}) {
  return requestLocalApi('/api/sales/source-links', {
    method: 'DELETE',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getCrossBorderOrderRecords(query = {}, options = {}) {
  return requestLocalApi(`/api/logistics/cross-border/orders${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function saveCrossBorderOrderRecord(payload = {}, options = {}) {
  return requestLocalApi('/api/logistics/cross-border/orders', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function deleteCrossBorderOrderRecord(payload = {}, options = {}) {
  return requestLocalApi('/api/logistics/cross-border/orders', {
    method: 'DELETE',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getCrossBorderAccounts(options = {}) {
  return requestLocalApi('/api/logistics/cross-border/accounts', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function saveCrossBorderAccount(payload = {}, options = {}) {
  return requestLocalApi('/api/logistics/cross-border/accounts', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function deleteCrossBorderAccount(accountId, options = {}) {
  void accountId;
  void options;
  return Promise.reject(
    new LocalApiError('账号删除必须使用统一预览、确认和回读流程。', {
      code: 'ACCOUNT_REMOVAL_UNIFIED_FLOW_REQUIRED',
    })
  );
}

export function testCrossBorderAccount(accountId, options = {}) {
  return requestLocalApi(`/api/logistics/cross-border/accounts/${encodeURIComponent(accountId)}/test`, {
    method: 'POST',
    body: options.body,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function authorizeCrossBorderAccount(accountId, options = {}) {
  return requestLocalApi(`/api/logistics/cross-border/accounts/${encodeURIComponent(accountId)}/authorize`, {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getCrossBorderEndpoints(options = {}) {
  return requestLocalApi('/api/logistics/cross-border/endpoints', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function requestCrossBorderRead(payload = {}, options = {}) {
  return requestLocalApi('/api/logistics/cross-border/read', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function previewCrossBorderWrite(payload = {}, options = {}) {
  return requestLocalApi('/api/logistics/cross-border/write/preview', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function confirmCrossBorderWrite(payload = {}, options = {}) {
  return requestLocalApi('/api/logistics/cross-border/write/confirm', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function startDomainSync(domain, payload = {}, options = {}) {
  if (isSharedOrderCacheDomain(domain)) clearOrderDomainCache(domain);
  return requestLocalApi(`/api/sync/${encodeURIComponent(domain)}`, {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  }).then((result) => {
    if (isSharedOrderCacheDomain(domain)) {
      clearOrderDomainCache(domain);
      collectLocalApiSyncJobs(result).forEach((job) => {
        sharedOrderSyncJobDomains.set(job.jobId, String(domain).trim().toLowerCase());
      });
    }
    return result;
  });
}

export function getSyncJob(jobId, options = {}) {
  return requestLocalApi(`/api/sync/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    transportRetry: options.transportRetry,
  }).then((result) => {
    const normalizedJobId = String(jobId || '').trim();
    const trackedDomain = sharedOrderSyncJobDomains.get(normalizedJobId);
    const terminal = collectLocalApiSyncJobs(result).some((job) => ORDER_SYNC_FINAL_STATUSES.has(job.status));
    if (trackedDomain && terminal) {
      clearOrderDomainCache(trackedDomain);
      sharedOrderSyncJobDomains.delete(normalizedJobId);
    }
    return result;
  });
}

export function getSyncJobs(jobIds = [], options = {}) {
  const ids = Array.isArray(jobIds) ? jobIds.map((item) => String(item || '').trim()).filter(Boolean) : [];
  return requestLocalApi(`/api/sync/jobs/status${createQueryString({ ids: ids.join(',') })}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  }).then((result) => {
    collectLocalApiSyncJobs(result).forEach((job) => {
      const trackedDomain = sharedOrderSyncJobDomains.get(job.jobId);
      if (trackedDomain && ORDER_SYNC_FINAL_STATUSES.has(job.status)) {
        clearOrderDomainCache(trackedDomain);
        sharedOrderSyncJobDomains.delete(job.jobId);
      }
    });
    return result;
  });
}

export function cancelSyncJob(jobId, reason = 'canceled_by_frontend', options = {}) {
  return requestLocalApi(`/api/sync/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    body: { reason },
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getSyncState(domain, query = {}, options = {}) {
  return requestLocalApi(`/api/sync/state/${encodeURIComponent(domain)}${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getSchedulerStatus(options = {}) {
  return requestLocalApi('/api/ozon/scheduler/status', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    observe: options.observe ?? false,
  });
}

export function getContinuousSyncStatus(options = {}) {
  return requestLocalApi('/api/app/continuous-sync-status', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    observe: options.observe ?? false,
  });
}

export function getMaintenanceStatus(options = {}) {
  return requestLocalApi('/api/app/maintenance-status', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    observe: options.observe ?? false,
  });
}

export function getRecoveryBackupPreview(query = {}, options = {}) {
  return requestLocalApi(`/api/app/recovery-backup-preview${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    observe: options.observe ?? false,
  });
}

export function listOzonNotifications(query = {}, options = {}) {
  return requestLocalApi(`/api/ozon/notifications${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function pollLocalSmartReplyNotifications(options = {}) {
  return requestLocalApi('/api/smart-reply/local/notification-poll', {
    method: 'POST',
    body: {},
    timeoutMs: options.timeoutMs ?? 5000,
    signal: options.signal,
    observe: options.observe ?? false,
  });
}

export function listOzonPushBindings(query = {}, options = {}) {
  return requestLocalApi(`/api/ozon/push-bindings${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function waitForOzonPushRealtimeEvent(
  { shopId = '', afterSequence = null, timeoutMs = 25_000 } = {},
  options = {}
) {
  const waitTimeoutMs = Math.max(1_000, Math.min(Number(timeoutMs) || 25_000, 30_000));
  const query = new globalThis.URLSearchParams({ shopId: String(shopId || '').trim() });
  if (
    afterSequence !== null &&
    afterSequence !== '' &&
    Number.isSafeInteger(Number(afterSequence)) &&
    Number(afterSequence) >= 0
  ) {
    query.set('afterSequence', String(Number(afterSequence)));
  }
  query.set('timeoutMs', String(waitTimeoutMs));
  return requestLocalApi(`/api/ozon/push-realtime/wait?${query.toString()}`, {
    method: 'GET',
    timeoutMs: waitTimeoutMs + 5_000,
    signal: options.signal,
    transportRetry: false,
    observe: false,
  });
}

export function markOzonNotificationsRead(payload = {}, options = {}) {
  return requestLocalApi('/api/ozon/notifications/read', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function clearOzonNotifications(payload = {}, options = {}) {
  return requestLocalApi('/api/ozon/notifications/clear', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function listOzonNotificationSettings(query = {}, options = {}) {
  return requestLocalApi(`/api/ozon/notification-settings${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function saveOzonNotificationSetting(payload = {}, options = {}) {
  return requestLocalApi('/api/ozon/notification-settings', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getRateLimitStatus(query = {}, options = {}) {
  return requestLocalApi(`/api/ozon/rate-limit/status${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function getOzonErrors(query = {}, options = {}) {
  return requestLocalApi(`/api/ozon/errors${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function previewDomainWrite(domain, payload = {}, options = {}) {
  return requestLocalApi(`/api/write/${encodeURIComponent(domain)}/preview`, {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    // Preview only records an isolated local confirmation snapshot and never
    // executes an Ozon write. It can therefore recover from a short-lived
    // Electron -> local-api transport break without making the user click twice.
    transportRetry: Boolean(String(payload?.idempotencyKey || '').trim()) && options.transportRetry !== false,
  });
}

export function confirmDomainWrite(domain, payload = {}, options = {}) {
  if (isSharedOrderCacheDomain(domain)) clearOrderDomainCache(domain);
  return requestLocalApi(`/api/write/${encodeURIComponent(domain)}/confirm`, {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  }).then((result) => {
    if (isSharedOrderCacheDomain(domain)) {
      clearOrderDomainCache(domain);
      collectLocalApiSyncJobs(result).forEach((job) => {
        sharedOrderSyncJobDomains.set(job.jobId, String(domain).trim().toLowerCase());
      });
    }
    return result;
  });
}

export function releaseDomainWritePreview(domain, payload = {}, options = {}) {
  return requestLocalApi(`/api/write/${encodeURIComponent(domain)}/preview/release`, {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 5_000,
    signal: options.signal,
    observe: options.observe,
    transportRetry: options.transportRetry === true,
  });
}

export function getLocalShops(options = {}) {
  const query = {};
  if (options.cursorMode) query.cursorMode = options.cursorMode;
  if (options.cursor) query.cursor = options.cursor;
  if (options.limit) query.limit = options.limit;
  return requestLocalApi(`/api/shops${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    transportRetry: options.transportRetry,
  });
}

export function saveLocalShop(shop, options = {}) {
  return requestLocalApi('/api/shops', { method: 'POST', body: shop, timeoutMs: options.timeoutMs });
}

/** One-time typed browser/file migration; normal interactive writes stay on /api/shops. */
export function importLegacyOzonShopSettings(payload = {}, options = {}) {
  return requestLocalApi('/api/shops/legacy-import', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 60000,
    signal: options.signal,
  });
}

export function deleteLocalShop(shopId, options = {}) {
  void shopId;
  void options;
  return Promise.reject(
    new LocalApiError('账号删除必须使用统一预览、确认和回读流程。', {
      code: 'ACCOUNT_REMOVAL_UNIFIED_FLOW_REQUIRED',
    })
  );
}

export async function testLocalShopConnection(shopId, options = {}) {
  try {
    return await requestLocalApi(`/api/shops/${encodeURIComponent(shopId)}/test`, {
      method: 'POST',
      body: options.body,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof LocalApiError && error.payload?.error?.message) {
      throw new LocalApiError(error.payload.error.message, {
        status: error.status,
        code: error.payload.error.code || error.code,
        payload: error.payload,
      });
    }
    throw error;
  }
}

export function listPurchaseAccounts(options = {}) {
  return requestLocalApi('/api/purchase/accounts', {
    method: 'GET',
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
  });
}

export function savePurchaseAccount(payload = {}, options = {}) {
  return requestLocalApi('/api/purchase/accounts', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function deletePurchaseAccount(accountId, options = {}) {
  void accountId;
  void options;
  return Promise.reject(
    new LocalApiError('账号删除必须使用统一预览、确认和回读流程。', {
      code: 'ACCOUNT_REMOVAL_UNIFIED_FLOW_REQUIRED',
    })
  );
}

export function listModelApiAccounts(options = {}) {
  return requestLocalApi('/api/model-api/accounts', {
    method: 'GET',
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
  });
}

export function saveModelApiAccount(payload = {}, options = {}) {
  return requestLocalApi('/api/model-api/accounts', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function deleteModelApiAccount(accountId, options = {}) {
  void accountId;
  void options;
  return Promise.reject(
    new LocalApiError('账号删除必须使用统一预览、确认和回读流程。', {
      code: 'ACCOUNT_REMOVAL_UNIFIED_FLOW_REQUIRED',
    })
  );
}

export function getProfileSetting(namespace, options = {}) {
  return requestLocalApi(`/api/profile-settings/${encodeURIComponent(namespace)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
    transportRetry: options.transportRetry,
  });
}

export function saveProfileSetting(namespace, value, options = {}) {
  return requestLocalApi(`/api/profile-settings/${encodeURIComponent(namespace)}`, {
    method: 'PUT',
    body: { value },
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function deleteProfileSetting(namespace, options = {}) {
  return requestLocalApi(`/api/profile-settings/${encodeURIComponent(namespace)}`, {
    method: 'DELETE',
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function saveProfileAsset(payload = {}, options = {}) {
  return requestLocalApi('/api/profile-assets', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function getProfileAsset(assetId, options = {}) {
  return requestLocalApi(`/api/profile-assets/${encodeURIComponent(assetId)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function listIntegrationProfiles(options = {}) {
  return requestLocalApi('/api/integrations/profiles', {
    method: 'GET',
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
  });
}

export async function getSeerfarCategoryTree(options = {}) {
  const query = createQueryString({
    query: options.query,
    parentId: options.parentId || '0',
    limit: options.limit || 80,
    refresh: options.forceRefresh ? 1 : undefined,
  });
  const payload = await requestLocalApi(`/api/integrations/seerfar/category-tree${query}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
  if (!payload || payload.ok !== true || !Array.isArray(payload.nodes)) {
    throw new LocalApiError(payload?.message || 'Seerfar 类目树返回了无效数据。', {
      code: payload?.code || 'SEERFAR_CATEGORY_TREE_INVALID',
      payload,
    });
  }
  return {
    ok: true,
    source: 'local-api',
    fetchedAt: String(payload.fetchedAt || ''),
    count: Number(payload.count) || payload.nodes.length,
    totalCount: Number(payload.totalCount) || payload.nodes.length,
    query: String(payload.query || ''),
    parentId: String(payload.parentId || '0'),
    nodes: payload.nodes.map((node) => ({
      id: String(node?.id || '').trim(),
      parentId: String(node?.parentId || '').trim(),
      level: Number(node?.level) || 0,
      cnTitle: String(node?.cnTitle || '').trim(),
      title: String(node?.title || '').trim(),
      enTitle: String(node?.enTitle || '').trim(),
      pathText: String(node?.pathText || '').trim(),
      hasChildren: node?.hasChildren === true,
    })).filter((node) => node.id && (node.cnTitle || node.title)),
  };
}

export function saveIntegrationProfile(payload = {}, options = {}) {
  return requestLocalApi('/api/integrations/profiles', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function verifyOzonBrowserShopIdentity(profileId, shopId, options = {}) {
  return requestLocalApi(
    `/api/integrations/profiles/${encodeURIComponent(profileId)}/verify-ozon-shop-identity`,
    {
      method: 'POST',
      body: { shopId },
      timeoutMs: options.timeoutMs || 60_000,
      signal: options.signal,
    },
  );
}

export function deleteIntegrationProfile(profileId, options = {}) {
  void profileId;
  void options;
  return Promise.reject(
    new LocalApiError('账号删除必须使用统一预览、确认和回读流程。', {
      code: 'ACCOUNT_REMOVAL_UNIFIED_FLOW_REQUIRED',
    })
  );
}

export function testPlatformIntegration(payload = {}, options = {}) {
  return requestLocalApi('/api/integrations/test', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function readExternalIntegration(payload = {}, options = {}) {
  return requestLocalApi('/api/integrations/read', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 120000,
    signal: options.signal,
  });
}

export function listPerformanceAccounts(options = {}) {
  return requestLocalApi('/api/performance/accounts', {
    method: 'GET',
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
  });
}

export function savePerformanceAccount(payload = {}, options = {}) {
  return requestLocalApi('/api/performance/accounts', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function deletePerformanceAccount(accountId, options = {}) {
  void accountId;
  void options;
  return Promise.reject(
    new LocalApiError('账号删除必须使用统一预览、确认和回读流程。', {
      code: 'ACCOUNT_REMOVAL_UNIFIED_FLOW_REQUIRED',
    })
  );
}

export function testPerformanceAccount(accountId, options = {}) {
  return requestLocalApi(`/api/performance/accounts/${encodeURIComponent(accountId)}/test`, {
    method: 'POST',
    timeoutMs: options.timeoutMs || 45000,
    signal: options.signal,
  });
}

export function readPerformanceOverview(payload = {}, options = {}) {
  return requestLocalApi('/api/performance/overview', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function readPerformanceProducts(payload = {}, options = {}) {
  return requestLocalApi('/api/performance/products', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function readPerformanceAdvancedReport(payload = {}, options = {}) {
  return requestLocalApi('/api/performance/reports', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 120000,
    signal: options.signal,
  });
}

export function readPerformanceOrders(payload = {}, options = {}) {
  return requestLocalApi('/api/performance/overview', {
    method: 'POST',
    body: {
      ...payload,
      values: {
        ...(payload.values || {}),
        readDepth: 'orders',
      },
    },
    timeoutMs: options.timeoutMs || 120000,
    signal: options.signal,
  });
}

export function executePerformanceAction(payload = {}, options = {}) {
  return requestLocalApi('/api/performance/action', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
}

export function getCatalogCacheKeyRule(options = {}) {
  return requestLocalApi('/api/cache/catalog/key-rule', { method: 'GET', timeoutMs: options.timeoutMs });
}

export function getCatalogCacheStatus(options = {}) {
  return requestLocalApi('/api/cache/catalog/status', { method: 'GET', timeoutMs: options.timeoutMs });
}

export function getCatalogCacheKeys(options = {}) {
  return requestLocalApi('/api/cache/catalog/keys', { method: 'GET', timeoutMs: options.timeoutMs });
}

export function createCatalogCacheKey(payload, options = {}) {
  return requestLocalApi('/api/cache/catalog/keys', { method: 'POST', body: payload, timeoutMs: options.timeoutMs });
}

export function getCatalogCategoryNodes(options = {}) {
  const query = {};
  if (options.cacheKey) query.cacheKey = options.cacheKey;
  if (options.shopId) query.shopId = options.shopId;
  if (options.parentCategoryId) query.parentCategoryId = options.parentCategoryId;
  if (options.categoryId) query.categoryId = options.categoryId;
  if (options.typeId) query.typeId = options.typeId;
  if (options.limit) query.limit = options.limit;
  return requestLocalApi(`/api/cache/catalog/nodes${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
  });
}

export async function getSharedCatalogCategoryTree(options = {}) {
  const payload = await requestLocalApi(
    `/api/catalog/shared/tree${createQueryString(createSharedCatalogQuery(options))}`,
    { method: 'GET', timeoutMs: options.timeoutMs, signal: options.signal }
  );
  return normalizeSharedCatalogTreePayload(payload);
}

export async function getSharedCatalogs(options = {}) {
  const payload = await requestLocalApi(
    `/api/catalog/shared/catalogs${createQueryString(createSharedCatalogQuery(options))}`,
    { method: 'GET', timeoutMs: options.timeoutMs, signal: options.signal }
  );
  if (!payload || payload.ok !== true || !Array.isArray(payload.catalogs)) {
    throw new LocalApiError('共享类目版本接口返回了无效数据。', {
      code: 'SHARED_CATALOG_DTO_INVALID',
      payload,
    });
  }
  const catalogs = payload.catalogs.map(normalizeSharedCatalogDto).filter(Boolean);
  return { ok: true, source: 'sqlite-shared-catalog', count: catalogs.length, catalogs };
}

export async function resolveSharedCatalogCategoryPath(ids = {}, options = {}) {
  const query = {
    ...createSharedCatalogQuery(options),
    descriptionCategoryId: ids.descriptionCategoryId ?? ids.categoryId,
    typeId: ids.typeId,
  };
  const payload = await requestLocalApi(`/api/catalog/shared/path${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (!payload || payload.ok !== true || !Array.isArray(payload.path)) {
    throw new LocalApiError('共享类目路径接口返回了无效数据。', {
      code: 'SHARED_CATALOG_DTO_INVALID',
      payload,
    });
  }
  return {
    ok: true,
    source: 'sqlite-shared-catalog',
    catalog: normalizeSharedCatalogDto(payload.catalog),
    path: payload.path.map((item) => String(item || '')).filter(Boolean),
    pathText: String(payload.pathText || ''),
  };
}

export function getCatalogCategoryTreeCache(options = {}) {
  return getSharedCatalogCategoryTree({ ...options, limit: options.limit || 10000 });
}

export function requestCatalogCacheSync(payload, options = {}) {
  return requestLocalApi('/api/cache/catalog/sync', { method: 'POST', body: payload, timeoutMs: options.timeoutMs });
}


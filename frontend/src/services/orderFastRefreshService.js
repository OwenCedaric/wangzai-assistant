import { getJobStatus, startDomainRefresh } from './ozonSyncClient.js';
import { OZON_PUSH_REALTIME_BROWSER_EVENT } from './ozonPushRealtime.js';

const FINAL_STATUSES = new Set([
  'success',
  'partial',
  'failed',
  'canceled',
  'blocked',
  'rate_limited',
  'circuit_open',
]);
const FAILED_STATUSES = new Set(['failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open']);
const HOUR_MS = 60 * 60 * 1000;

function normalizeText(value) {
  return String(value ?? '').trim();
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function getJobId(payload = {}) {
  return normalizeText(payload.jobId || payload.job?.jobId || payload.job?.id || payload.id);
}

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function publishDomainRefresh(task = {}, domain, job = {}) {
  const shopId = normalizeText(task.shop?.id || job.shopId);
  if (!shopId || !globalThis.window?.dispatchEvent) return;
  globalThis.window.dispatchEvent(new CustomEvent(OZON_PUSH_REALTIME_BROWSER_EVENT, {
    detail: {
      sequence: Date.now(),
      shopId,
      stage: 'refreshed',
      domain,
      source: normalizeText(job.source) || `${domain}-fast-refresh`,
      requestedBy: normalizeText(job.requestedBy),
      jobId: normalizeText(job.jobId || job.id),
      status: normalizeText(job.status),
      changedCount: Number(job.changedCount) || 0,
      unchangedCount: Number(job.unchangedCount) || 0,
      failedCount: Number(job.failedCount) || 0,
      postingNumbers: [],
      productRefs: [],
      occurredAt: new Date().toISOString(),
    },
  }));
}

export function createFastOrderRefreshRange(timeScope = {}, options = {}) {
  const now = parseDate(options.now) || new Date();
  const scopeStart = parseDate(timeScope.since || timeScope.apiRange?.since);
  const scopeEnd = parseDate(timeScope.to || timeScope.apiRange?.to) || now;
  const overlapHours = Math.max(1, Math.min(Number(options.overlapHours) || 72, 24 * 14));
  const deltaStart = new Date(scopeEnd.getTime() - overlapHours * HOUR_MS);
  return {
    since: new Date(Math.max(scopeStart?.getTime() || Number.NEGATIVE_INFINITY, deltaStart.getTime())).toISOString(),
    to: scopeEnd.toISOString(),
  };
}

export function createFastOrderRefreshTasks(shops = [], timeScope = {}, options = {}) {
  const range = createFastOrderRefreshRange(timeScope, options);
  return (Array.isArray(shops) ? shops : []).flatMap((shop) => [
    {
      shop,
      endpointKey: 'orders.fbsList',
      label: 'FBS/rFBS 最新订单',
      params: { filter: range, dir: 'DESC' },
    },
    {
      shop,
      endpointKey: 'orders.fboList',
      label: 'FBO 最新订单',
      params: { filter: range, dir: 'DESC' },
    },
  ]);
}

export function createFastReturnsRefreshTasks(shops = [], timeScope = {}, options = {}) {
  const range = createFastOrderRefreshRange(timeScope, {
    ...options,
    overlapHours: options.overlapHours || 24 * 7,
  });
  return (Array.isArray(shops) ? shops : []).flatMap((shop) => [
    {
      shop,
      endpointKey: 'returns.list',
      label: '最新退货列表',
      params: { filter: range },
    },
    {
      shop,
      endpointKey: 'returns.rfbsList',
      label: '最新 rFBS 售后',
      params: { filter: { created_since: range.since, created_to: range.to } },
      enrichRfbsDetails: true,
    },
    {
      shop,
      endpointKey: 'returns.conditionalCancellationList',
      label: '最新条件取消',
      params: { filter: { created_since: range.since, created_to: range.to } },
    },
  ]);
}

async function runFastDomainRefresh({
  domain,
  tasks,
  requestedBy,
  source,
  foregroundWaitMs = 15_000,
  onProgress,
} = {}) {
  const rows = Array.isArray(tasks) ? tasks : [];
  if (!rows.length) return { ok: true, completed: 0, total: 0, pending: 0, errors: [] };
  onProgress?.({ running: true, completed: 0, total: rows.length, errors: [] });
  const submitted = await Promise.allSettled(rows.map((task) => startDomainRefresh(domain, {
    shopId: task.shop?.id,
    endpointKey: task.endpointKey,
    action: domain === 'returns' ? 'sync-returns-list' : 'sync-orders-list',
    params: task.params,
    pageSize: 100,
    maxPages: 5,
    forceRefresh: true,
    enrichRfbsDetails: task.enrichRfbsDetails,
    priority: 'P1',
    profile: 'foreground',
    schedulerProfile: 'foreground',
    requestedBy,
    source,
    syncSource: source,
  }, { timeoutMs: 4_000 })));
  const jobs = submitted.map((result, index) => ({
    label: rows[index].label,
    task: rows[index],
    jobId: result.status === 'fulfilled' ? getJobId(result.value) : '',
    error: result.status === 'rejected'
      ? result.reason
      : result.value?.accepted === false || result.value?.ok === false
        ? result.value?.error || result.value?.reason
        : null,
  }));
  const pending = new Map(jobs.filter((job) => job.jobId).map((job) => [job.jobId, job]));
  const errors = jobs
    .filter((job) => !job.jobId && job.error)
    .map((job) => `${job.label}：${job.error?.message || job.error}`);
  let completed = jobs.length - pending.size;
  const publishedSignatures = new Map();
  const deadline = Date.now() + Math.max(1_000, Number(foregroundWaitMs) || 15_000);

  while (pending.size && Date.now() < deadline) {
    const jobIds = [...pending.keys()];
    const statuses = await Promise.all(jobIds.map((jobId) =>
      getJobStatus(jobId, { timeoutMs: 3_000 }).catch(() => null)
    ));
    statuses.forEach((payload, index) => {
      const jobId = jobIds[index];
      const job = payload?.job || payload || {};
      const status = normalizeText(job.status);
      const signature = [
        status,
        Number(job.progressDone) || 0,
        Number(job.changedCount) || 0,
        Number(job.unchangedCount) || 0,
        normalizeText(job.updatedAt || job.finishedAt),
      ].join('|');
      if (publishedSignatures.get(jobId) !== signature && (
        FINAL_STATUSES.has(status) ||
        Number(job.progressDone) > 0 ||
        Number(job.changedCount) > 0
      )) {
        publishedSignatures.set(jobId, signature);
        publishDomainRefresh(pending.get(jobId)?.task, domain, job);
      }
      if (!FINAL_STATUSES.has(status)) return;
      const pendingJob = pending.get(jobId);
      pending.delete(jobId);
      completed += 1;
      if (FAILED_STATUSES.has(status)) {
        errors.push(`${pendingJob?.label || '订单同步'}：${job.lastError || '读取失败'}`);
      }
    });
    onProgress?.({
      running: pending.size > 0,
      completed,
      total: jobs.length,
      errors: errors.slice(0, 3),
    });
    if (pending.size) await sleep(300);
  }

  const result = {
    ok: errors.length === 0,
    completed,
    total: jobs.length,
    pending: pending.size,
    background: pending.size > 0,
    errors,
    jobIds: jobs.map((job) => job.jobId).filter(Boolean),
  };
  onProgress?.({ ...result, running: pending.size > 0 });
  return result;
}

export function refreshOrderCacheFast(shops = [], timeScope = {}, options = {}) {
  return runFastDomainRefresh({
    domain: 'orders',
    tasks: createFastOrderRefreshTasks(shops, timeScope, options),
    requestedBy: options.requestedBy || 'frontend-orders-fast-refresh',
    source: options.source || 'orders-fast-refresh',
    foregroundWaitMs: options.foregroundWaitMs,
    onProgress: options.onProgress,
  });
}

export function refreshAfterSalesCacheFast(shops = [], timeScope = {}, options = {}) {
  return runFastDomainRefresh({
    domain: 'returns',
    tasks: createFastReturnsRefreshTasks(shops, timeScope, options),
    requestedBy: options.requestedBy || 'frontend-after-sales-fast-refresh',
    source: options.source || 'after-sales-fast-refresh',
    foregroundWaitMs: options.foregroundWaitMs,
    onProgress: options.onProgress,
  });
}


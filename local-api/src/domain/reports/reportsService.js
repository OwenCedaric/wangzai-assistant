import { createAnalyticsRepository } from '../../db/repositories/analyticsRepository.js';
import { createSyncJobService, SYNC_JOB_STATUS } from '../../sync/syncJobService.js';
import { createSyncStateService } from '../../sync/syncStateService.js';
import { createStableHash } from '../../utils/stableHash.js';

const ANALYTICS_METRICS = Object.freeze([
  'revenue',
  'ordered_units',
  'hits_view',
  'hits_tocart',
  'session_view',
]);

const METRIC_SIGNATURE = ANALYTICS_METRICS.join(',');
const OZON_BUSINESS_TIME_ZONE = 'Europe/Moscow';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = '') {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function normalizeDate(value) {
  const text = normalizeText(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : '';
}

export function getOzonBusinessDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OZON_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, days) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function resolveReportsDateRange(input = {}, now = new Date()) {
  const currentOzonDate = getOzonBusinessDate(now);
  const requestedEndDate = normalizeDate(input.endDate ?? input.dateTo ?? input.to);
  const endDate = requestedEndDate && requestedEndDate < currentOzonDate
    ? requestedEndDate
    : currentOzonDate;
  const requestedStartDate = normalizeDate(input.startDate ?? input.dateFrom ?? input.from);
  const startDate = requestedStartDate
    ? (requestedStartDate <= endDate ? requestedStartDate : endDate)
    : shiftDate(endDate, -29);
  return { startDate, endDate };
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toInteger(value) {
  const number = toFiniteNumber(value);
  return number === null ? null : Math.round(number);
}

function hasAnalyticsTable(db) {
  try {
    return Boolean(db?.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'ozon_analytics_daily'").get()?.found);
  } catch {
    return false;
  }
}

function createJobId() {
  return `analytics_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function publicJobPayload(job, extra = {}) {
  return {
    ok: true,
    accepted: true,
    domain: 'reports',
    jobId: job?.jobId || job?.id,
    job,
    status: job?.status || 'queued',
    ...extra,
  };
}

function getSchedulerData(result = {}) {
  return result.data ?? result.cache?.payload ?? null;
}

function isSchedulerOk(result = {}) {
  return Boolean(result.ok || ['success', 'partial', 'cache_hit'].includes(result.status));
}

function getSchedulerError(result, fallback = '官方流量数据读取失败。') {
  return result?.errors?.[0]?.message || result?.job?.lastError || result?.error?.message || fallback;
}

function normalizeAnalyticsRows(payload = {}) {
  const items = Array.isArray(payload?.result?.data)
    ? payload.result.data
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  return items
    .map((item) => {
      const date = normalizeDate(item?.dimensions?.[0]?.id ?? item?.date);
      const metrics = Array.isArray(item?.metrics) ? item.metrics : [];
      if (!date || metrics.length < ANALYTICS_METRICS.length) return null;
      const [revenueRub, orderedUnits, productViews, cartAdds, visitorSessions] = metrics;
      return {
        date,
        revenueRub: toFiniteNumber(revenueRub),
        orderedUnits: toInteger(orderedUnits),
        productViews: toInteger(productViews),
        cartAdds: toInteger(cartAdds),
        visitorSessions: toInteger(visitorSessions),
        metricSignature: METRIC_SIGNATURE,
        rawMetrics: {
          metrics: Object.fromEntries(ANALYTICS_METRICS.map((metric, index) => [metric, metrics[index] ?? null])),
          dimensions: item?.dimensions || [],
          sourceCurrency: 'RUB',
        },
      };
    })
    .filter(Boolean);
}

function buildRequestFingerprint({ shopId, dateRange, forceRefresh }) {
  return createStableHash(
    {
      domain: 'reports',
      endpointKey: 'analytics.data',
      shopId,
      dateRange,
      metricSignature: METRIC_SIGNATURE,
      forceRefresh: forceRefresh === true,
    },
    { length: 32 },
  );
}

export function createReportsService({
  db,
  ozonScheduler,
  backgroundRunner = (task) => setImmediate(task),
  clock = () => new Date(),
} = {}) {
  const repository = db && hasAnalyticsTable(db) ? createAnalyticsRepository(db) : null;
  const jobService = db ? createSyncJobService(db) : null;
  const stateService = db ? createSyncStateService(db) : null;

  function readCache(query = {}) {
    const startedAt = Date.now();
    if (!repository) {
      return { ok: false, domain: 'reports', error: { code: 'ANALYTICS_CACHE_NOT_CONNECTED', message: '官方流量缓存未接入。' } };
    }
    const payload = repository.listDailyRows(query);
    return {
      ...payload,
      syncState: stateService?.listStates('reports', { shopId: query.shopId || query.shop_id, limit: 5 }) || [],
      metricSignature: METRIC_SIGNATURE,
      note: '流量、浏览、加购、下单件数和销售额来自平台官方分析接口的日粒度快照。',
      durationMs: Date.now() - startedAt,
    };
  }

  async function runAnalyticsSyncJob(job, input = {}) {
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const dateRange = resolveReportsDateRange(input, clock());
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by, 'reports-domain-service');
    jobService.updateJob(job.jobId, {
      status: SYNC_JOB_STATUS.running,
      startedAt: nowIso(),
      progressTotal: 1,
      stage: '读取官方流量分析',
    });
    stateService.upsertState({
      domain: 'reports',
      shopId,
      scopeKey: `analytics:${dateRange.startDate}:${dateRange.endDate}`,
      status: 'running',
      lastAttemptAt: nowIso(),
    });

    try {
      const scheduled = await ozonScheduler.executeReadOnly({
        shopId,
        domain: 'reports',
        endpointKey: 'analytics.data',
        action: 'sync-analytics-daily',
        priority: input.priority || 'P2',
        params: {
          date_from: dateRange.startDate,
          date_to: dateRange.endDate,
          metrics: ANALYTICS_METRICS,
          dimension: ['day'],
          filters: [],
          sort: [],
          limit: 1000,
          offset: 0,
        },
        cacheKey: `reports:analytics:${shopId}:${dateRange.startDate}:${dateRange.endDate}:${METRIC_SIGNATURE}`,
        idempotencyKey: `${job.jobId}:analytics.data`,
        requestedBy,
        forceRefresh: input.forceRefresh === true,
        allowStale: true,
        waitForResult: true,
      });
      if (!isSchedulerOk(scheduled)) throw new Error(getSchedulerError(scheduled));
      const rows = normalizeAnalyticsRows(getSchedulerData(scheduled));
      if (!rows.length) throw new Error('官方流量接口没有返回可用的日粒度指标。');
      const merge = repository.upsertDailyRows({ shopId, rows });
      const finalJob = jobService.updateJob(job.jobId, {
        status: SYNC_JOB_STATUS.success,
        progressDone: 1,
        progressTotal: 1,
        changedCount: merge.changed,
        unchangedCount: merge.unchanged,
        failedCount: 0,
        stage: '已写入官方流量快照',
        finishedAt: nowIso(),
      });
      stateService.upsertState({
        domain: 'reports',
        shopId,
        scopeKey: `analytics:${dateRange.startDate}:${dateRange.endDate}`,
        status: 'success',
        lastSuccessAt: nowIso(),
        lastAttemptAt: nowIso(),
        changedCount: merge.changed,
        unchangedCount: merge.unchanged,
      });
      return { job: finalJob, rows: merge.total };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finalJob = jobService.updateJob(job.jobId, {
        status: SYNC_JOB_STATUS.failed,
        progressDone: 1,
        progressTotal: 1,
        failedCount: 1,
        lastError: message,
        stage: '读取失败',
        finishedAt: nowIso(),
      });
      stateService.upsertState({
        domain: 'reports',
        shopId,
        scopeKey: `analytics:${dateRange.startDate}:${dateRange.endDate}`,
        status: 'failed',
        lastAttemptAt: nowIso(),
        lastError: message,
      });
      return { job: finalJob, error: message };
    }
  }

  function startSync(input = {}) {
    if (!repository || !jobService || !ozonScheduler?.executeReadOnly) {
      return { ok: false, domain: 'reports', error: { code: 'ANALYTICS_SYNC_NOT_CONNECTED', message: '官方流量同步服务未接入。' } };
    }
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    if (!shopId) return { ok: false, domain: 'reports', error: { code: 'ANALYTICS_SHOP_ID_REQUIRED', message: '同步官方流量数据需要店铺。' } };
    const dateRange = resolveReportsDateRange(input, clock());
    const requestFingerprint = buildRequestFingerprint({ shopId, dateRange, forceRefresh: input.forceRefresh });
    const reusable = jobService.findReusableJob({ requestFingerprint, idempotencyKey: input.idempotencyKey ?? input.idempotency_key });
    if (reusable?.job) return publicJobPayload(reusable.job, { reused: true, reason: reusable.reason, dateRange });
    const job = jobService.createJob({
      id: createJobId(),
      domain: 'reports',
      shopId,
      endpointKey: 'analytics.data',
      action: 'sync-analytics-daily',
      priority: input.priority || 'P2',
      requestedBy: input.requestedBy || input.requested_by || 'reports-domain-service',
      cacheKey: `reports:analytics:${shopId}:${dateRange.startDate}:${dateRange.endDate}`,
      idempotencyKey: input.idempotencyKey || input.idempotency_key || null,
      requestFingerprint,
      dedupeUntil: new Date(Date.now() + 60_000).toISOString(),
      progressTotal: 1,
      stage: '等待读取官方流量分析',
    });
    backgroundRunner(() => (
      runAnalyticsSyncJob(job, { ...input, shopId, ...dateRange }).catch((error) => {
        jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.failed,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
        });
      })
    ));
    return publicJobPayload(job, { reused: false, dateRange, metricSignature: METRIC_SIGNATURE });
  }

  return { domain: 'reports', readCache, startSync, runAnalyticsSyncJob };
}

export const reportsAnalyticsMetrics = ANALYTICS_METRICS;

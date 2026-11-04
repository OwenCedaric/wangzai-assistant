import {
  createProfitReportRepository,
  normalizeFinanceBalanceReportDetail,
} from '../../db/repositories/profitReportRepository.js';
import { createSyncJobService, SYNC_JOB_STATUS } from '../../sync/syncJobService.js';
import { createSyncStateService } from '../../sync/syncStateService.js';
import { createStableHash } from '../../utils/stableHash.js';
import { createShopScopedRepositoryRouter } from '../../db/shopScopedRepositoryRouter.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 50;

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeId(value) {
  const result = text(value);
  return result && result !== '0' ? result : '';
}

function parseDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
}

function resolveDateRange(input = {}) {
  const from = parseDate(input.from ?? input.since ?? input.dateFrom ?? input.date?.from);
  const to = parseDate(input.to ?? input.dateTo ?? input.date?.to);
  const fallback = defaultDateRange();
  return { from: from?.toISOString() || fallback.from, to: to?.toISOString() || fallback.to };
}

function dateOnly(value = '') {
  return text(value).slice(0, 10);
}

function schedulerData(result = {}) {
  return result.data ?? result.cache?.payload ?? null;
}

function schedulerOk(result = {}) {
  return Boolean(result.ok || result.status === 'success' || result.status === 'partial' || result.status === 'cache_hit');
}

function schedulerError(result = {}, fallback = 'Ozon 利润报表接口调用失败') {
  return result?.errors?.[0]?.message || result?.job?.lastError || result?.error?.message || fallback;
}

function statementRows(payload = {}) {
  const details = payload?.result?.details ?? payload?.details ?? payload?.result ?? payload;
  if (Array.isArray(details)) return details;
  if (details && typeof details === 'object' && Object.keys(details).length) return [details];
  return [];
}

function statementPageCount(payload = {}) {
  const value = payload?.result?.page_count ?? payload?.page_count ?? payload?.result?.pageCount ?? payload?.pageCount;
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}

function hasTables(db) {
  try {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ozon_finance_statement_reports', 'ozon_finance_balance_snapshots')").all().map((row) => row.name));
    return names.size === 2;
  } catch {
    return false;
  }
}

function publicJob(job, extra = {}) {
  return { ok: true, accepted: true, domain: 'profit-report', jobId: job?.jobId || job?.id, status: job?.status || 'queued', job, ...extra };
}

export function createProfitReportService({
  db,
  readDb = db,
  ozonScheduler,
  shopOperationalStorage = null,
  backgroundRunner = (task) => setImmediate(task),
} = {}) {
  const canonicalRepository = db && hasTables(db) ? createProfitReportRepository(db) : null;
  const repository = canonicalRepository && shopOperationalStorage?.resolveDirectWriteSession
    ? createShopScopedRepositoryRouter({
        canonicalRepository,
        createRepository: createProfitReportRepository,
        storage: shopOperationalStorage,
        aggregateRepository: readDb !== db ? createProfitReportRepository(db, { readDb }) : null,
        writeMethods: ['upsertBalance', 'upsertStatements'],
        readMethods: ['readReport'],
      })
    : canonicalRepository;
  const jobs = db ? createSyncJobService(db) : null;
  const states = db ? createSyncStateService(db) : null;
  if (repository && !shopOperationalStorage?.snapshot?.().directWriteAllShops) {
    try {
      repository.repairCachedBalanceReports();
    } catch {
      // Existing cache repair is best-effort; a fresh explicit sync remains available.
    }
  }

  function readCache(query = {}) {
    if (!repository) return { ok: false, error: { code: 'PROFIT_REPORT_CACHE_NOT_CONNECTED', message: '利润报表 SQLite 缓存尚未连接。' } };
    const payload = repository.readReport(query);
    payload.syncState = states?.listStates('profit-report', { shopId: query.shopId || query.shop_id, limit: 10 }) ?? [];
    return payload;
  }

  async function runSync(job, input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const dateRange = resolveDateRange(input);
    const pageSize = Math.min(Math.max(Number(input.pageSize ?? input.page_size) || DEFAULT_PAGE_SIZE, 1), 1000);
    const requestedBy = text(input.requestedBy ?? input.requested_by) || 'profit-report-page';
    const forceRefresh = input.forceRefresh !== false;
    const errors = [];
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let progressDone = 0;
    let progressTotal = 2;
    let balancePayload = null;
    let statementRowCount = 0;
    const scopeKey = `profit-report:${dateRange.from.slice(0, 10)}:${dateRange.to.slice(0, 10)}`;

    jobs.updateJob(job.jobId, { status: SYNC_JOB_STATUS.running, startedAt: nowIso(), progressTotal });
    states.upsertState({ domain: 'profit-report', shopId, scopeKey, status: 'running', lastAttemptAt: nowIso() });

    try {
      const balanceResult = await ozonScheduler.executeReadOnly({
        shopId,
        domain: 'profit-report',
        endpointKey: 'profitReport.balance',
        action: 'sync-profit-report-balance',
        priority: input.priority || 'P2',
        profile: input.profile || input.schedulerProfile,
        params: { date_from: dateOnly(dateRange.from), date_to: dateOnly(dateRange.to) },
        cacheKey: `profit-report:balance:${shopId}:${dateOnly(dateRange.from)}:${dateOnly(dateRange.to)}`,
        idempotencyKey: `${job.jobId}:balance`,
        requestedBy,
        forceRefresh,
        allowStale: true,
      });
      if (schedulerOk(balanceResult)) {
        balancePayload = schedulerData(balanceResult) || {};
        repository.upsertBalance({ shopId, payload: balancePayload, from: dateRange.from, to: dateRange.to });
        changedCount += 1;
      } else {
        failedCount += 1;
        errors.push(schedulerError(balanceResult, 'Ozon 店铺余额读取失败'));
      }
    } catch (error) {
      failedCount += 1;
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      progressDone += 1;
      jobs.updateJob(job.jobId, { progressDone, progressTotal, changedCount, unchangedCount, failedCount });
    }

    let pageCount = 1;
    for (let page = 1; page <= Math.min(pageCount, MAX_PAGES); page += 1) {
      if (page > 1) progressTotal = Math.max(progressTotal, pageCount + 1);
      try {
        const statementResult = await ozonScheduler.executeReadOnly({
          shopId,
          domain: 'profit-report',
          endpointKey: 'profitReport.cashFlowStatement',
          action: 'sync-profit-report-statement',
          priority: input.priority || 'P2',
          profile: input.profile || input.schedulerProfile,
          params: { page, page_size: pageSize, date: dateRange, with_details: true },
          cacheKey: `profit-report:statement:${shopId}:${dateRange.from}:${dateRange.to}:${page}`,
          idempotencyKey: `${job.jobId}:statement:${page}`,
          requestedBy,
          forceRefresh,
          allowStale: true,
        });
        if (!schedulerOk(statementResult)) {
          failedCount += 1;
          errors.push(schedulerError(statementResult, `Ozon 财务报告第 ${page} 页读取失败`));
          break;
        }
        const payload = schedulerData(statementResult) || {};
        const rows = statementRows(payload);
        statementRowCount += rows.length;
        const merge = repository.upsertStatements({ shopId, rows });
        changedCount += merge.changed || 0;
        unchangedCount += merge.unchanged || 0;
        pageCount = Math.min(statementPageCount(payload), MAX_PAGES);
        progressTotal = Math.max(progressTotal, pageCount + 1);
        if (!rows.length || page >= pageCount) break;
      } catch (error) {
        failedCount += 1;
        errors.push(error instanceof Error ? error.message : String(error));
        break;
      } finally {
        progressDone += 1;
        jobs.updateJob(job.jobId, { progressDone, progressTotal, changedCount, unchangedCount, failedCount });
      }
    }

    if (!statementRowCount && balancePayload) {
      const fallbackDetail = normalizeFinanceBalanceReportDetail(balancePayload, {
        shopId,
        from: dateRange.from,
        to: dateRange.to,
      });
      const merge = repository.upsertStatements({ shopId, rows: [fallbackDetail] });
      changedCount += merge.changed || 0;
      unchangedCount += merge.unchanged || 0;
    }

    const finalStatus = failedCount === 0
      ? SYNC_JOB_STATUS.success
      : changedCount + unchangedCount > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
    const finalJob = jobs.updateJob(job.jobId, {
      status: finalStatus,
      progressDone,
      progressTotal,
      changedCount,
      unchangedCount,
      failedCount,
      lastError: errors[0] || null,
      finishedAt: nowIso(),
    });
    states.upsertState({
      domain: 'profit-report', shopId, scopeKey, status: finalStatus,
      lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(),
      lastAttemptAt: nowIso(), lastError: errors[0] || null, changedCount, unchangedCount,
    });
    return { job: finalJob, errors };
  }

  function startSync(input = {}) {
    if (!repository || !jobs || !ozonScheduler) {
      return { ok: false, accepted: false, domain: 'profit-report', error: { code: 'PROFIT_REPORT_SYNC_NOT_CONNECTED', message: '利润报表同步服务尚未连接。' } };
    }
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    if (!shopId) return { ok: false, accepted: false, domain: 'profit-report', error: { code: 'PROFIT_REPORT_SHOP_ID_REQUIRED', message: '请选择需要读取的 Ozon 店铺。' } };
    const dateRange = resolveDateRange(input);
    const fingerprint = createStableHash({ shopId, dateRange, requestedBy: input.requestedBy, mode: 'profit-report-v1' }, { length: 32 });
    const reusable = jobs.findReusableJob({ requestFingerprint: fingerprint, idempotencyKey: input.idempotencyKey ?? input.idempotency_key });
    if (reusable?.job) return publicJob(reusable.job, { reused: true, dateRange });
    const job = jobs.createJob({
      id: `profit_report_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      domain: 'profit-report', shopId, endpointKey: 'profitReport.cashFlowStatement',
      action: 'sync-profit-report', priority: input.priority || 'P2', profile: input.profile || input.schedulerProfile || null,
      source: input.source || 'profit-report-page', requestedBy: input.requestedBy || 'profit-report-page',
      cacheKey: `profit-report:${shopId}:${dateRange.from}:${dateRange.to}`,
      idempotencyKey: input.idempotencyKey || input.idempotency_key || null,
      requestFingerprint: fingerprint, dedupeUntil: new Date(Date.now() + 60_000).toISOString(), progressTotal: 2,
    });
    backgroundRunner(() => runSync(job, { ...input, shopId, ...dateRange }).catch((error) => {
      jobs.updateJob(job.jobId, { status: SYNC_JOB_STATUS.failed, lastError: error instanceof Error ? error.message : String(error), finishedAt: nowIso() });
    }));
    return publicJob(job, { reused: false, dateRange });
  }

  return { domain: 'profit-report', readCache, startSync, runSync };
}

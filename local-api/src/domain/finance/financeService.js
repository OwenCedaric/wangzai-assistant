import { createFinanceRepository } from '../../db/repositories/financeRepository.js';
import { createSyncJobService, SYNC_JOB_STATUS } from '../../sync/syncJobService.js';
import { createSyncStateService } from '../../sync/syncStateService.js';
import { createStableHash } from '../../utils/stableHash.js';
import { createShopScopedRepositoryRouter } from '../../db/shopScopedRepositoryRouter.js';
import {
  buildFinanceJobCacheKey,
  buildFinanceRunScopeKey,
  buildFinanceTransactionCacheKey,
  isContinuousFinanceSync,
} from './financeCacheScope.js';
import { compactFinanceCacheScopes } from './financeCacheScopeCompaction.js';

const DEFAULT_FINANCE_PAGE_SIZE = 1000;
const DEFAULT_FINANCE_MAX_PAGES = 1;
const DEFAULT_FINANCE_WINDOW_DAYS = 7;

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== '0' && text !== '未返回' ? text : '';
}

function splitIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(normalizeId).filter(Boolean))];
  return [...new Set(normalizeText(value).split(',').map((item) => item.trim()).filter(Boolean))];
}

function toPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function parseDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 14);
  return { from: from.toISOString(), to: to.toISOString() };
}

function resolveDateRange(input = {}) {
  const filterDate = input.params?.filter?.date || input.filter?.date || input.date || {};
  const from = normalizeText(input.from ?? input.since ?? input.dateFrom ?? filterDate.from);
  const to = normalizeText(input.to ?? input.dateTo ?? filterDate.to);
  const fallback = defaultDateRange();
  return {
    from: parseDate(from)?.toISOString() || fallback.from,
    to: parseDate(to)?.toISOString() || fallback.to,
  };
}

function dateChunks({ from, to }, windowDays = DEFAULT_FINANCE_WINDOW_DAYS) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end || start > end) return [defaultDateRange()];
  const chunks = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + Math.max(1, Number(windowDays) || DEFAULT_FINANCE_WINDOW_DAYS) - 1);
    const safeEnd = chunkEnd > end ? end : chunkEnd;
    chunks.push({ from: chunkStart.toISOString(), to: safeEnd.toISOString() });
    cursor.setTime(safeEnd.getTime() + 1);
  }
  return chunks.length ? chunks : [{ from: start.toISOString(), to: end.toISOString() }];
}

function extractOperations(data = {}) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.operations)) return data.operations;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.result?.operations)) return data.result.operations;
  if (Array.isArray(data.result?.items)) return data.result.items;
  if (Array.isArray(data.result)) return data.result;
  return [];
}

function getPageCount(data = {}) {
  const value = data.page_count ?? data.result?.page_count ?? data.total_pages ?? data.result?.total_pages;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function getSchedulerData(result = {}) {
  return result.data ?? result.cache?.payload ?? null;
}

function isSchedulerOk(result = {}) {
  return Boolean(result.ok || result.status === 'success' || result.status === 'partial' || result.status === 'cache_hit');
}

function schedulerErrorMessage(result, fallback = 'Ozon 财务流水接口调用失败') {
  const first = result?.errors?.[0];
  return first?.message || result?.job?.lastError || result?.error?.message || fallback;
}

function hasFinanceTable(db) {
  try {
    return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ozon_finance_transactions'").get());
  } catch {
    return false;
  }
}

function createFinanceJobId() {
  return `finance_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function publicJobPayload(job, extra = {}) {
  return {
    ok: true,
    accepted: true,
    domain: 'finance',
    jobId: job?.jobId || job?.id,
    job,
    status: job?.status || 'queued',
    ...extra,
  };
}

function buildRequestFingerprint(input = {}) {
  const continuous = isContinuousFinanceSync(input);
  return createStableHash({
    domain: 'finance',
    shopId: input.shopId,
    endpointKey: 'finance.transactionList',
    postingNumbers: input.postingNumbers,
    dateRange: continuous
      ? buildFinanceRunScopeKey({ ...input.dateRange, continuous: true })
      : input.dateRange,
    pageSize: input.pageSize,
    maxPages: input.maxPages,
    forceRefresh: input.forceRefresh !== false,
    syncMode: normalizeText(input.syncMode ?? input.sync_mode),
    recoveryRestoreId: normalizeText(
      input.recoveryRestoreId ?? input.recovery_restore_id,
    ),
  }, { length: 32 });
}

export function createFinanceService({
  db,
  readDb = db,
  ozonScheduler,
  shopOperationalStorage = null,
  backgroundRunner = (task) => setImmediate(task),
} = {}) {
  const canonicalRepository = db && hasFinanceTable(db) ? createFinanceRepository(db) : null;
  const repository = canonicalRepository && shopOperationalStorage?.resolveDirectWriteSession
    ? createShopScopedRepositoryRouter({
        canonicalRepository,
        createRepository: createFinanceRepository,
        storage: shopOperationalStorage,
        aggregateRepository: readDb !== db ? createFinanceRepository(readDb) : null,
        writeMethods: ['upsertOperations'],
        readMethods: ['listOperations'],
      })
    : canonicalRepository;
  const jobService = db ? createSyncJobService(db) : null;
  const stateService = db ? createSyncStateService(db) : null;

  function readCache(query = {}) {
    if (!repository) {
      return { ok: false, error: { code: 'FINANCE_CACHE_NOT_CONNECTED', message: 'finance SQLite cache is not connected.' } };
    }
    const started = Date.now();
    const payload = repository.listOperations(query);
    payload.durationMs = Date.now() - started;
    payload.syncState = stateService?.listStates('finance', { shopId: query.shopId || query.shop_id, limit: 5 }) ?? [];
    return payload;
  }

  async function runFinanceSyncJob(job, input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const postingNumbers = splitIds(input.postingNumbers ?? input.posting_number ?? input.postingNumber ?? input.params?.filter?.posting_number);
    const lookupPostingNumbers = postingNumbers.length ? postingNumbers : [''];
    const dateRange = resolveDateRange(input);
    const continuous = isContinuousFinanceSync(input);
    const chunks = dateChunks(dateRange, input.windowDays || DEFAULT_FINANCE_WINDOW_DAYS);
    const pageSize = toPositiveInteger(input.pageSize ?? input.page_size ?? input.params?.page_size, DEFAULT_FINANCE_PAGE_SIZE, 1000);
    const maxPages = toPositiveInteger(input.maxPages, DEFAULT_FINANCE_MAX_PAGES, 50);
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || 'finance-domain-service';
    const syncSource = normalizeText(input.source ?? input.syncSource) || requestedBy;
    const syncMode = normalizeText(input.syncMode ?? input.sync_mode) || null;
    const recoveryRestoreId = normalizeText(
      input.recoveryRestoreId ?? input.recovery_restore_id,
    ) || null;
    const recoveryGenerationId = normalizeText(
      input.recoveryGenerationId ?? input.recovery_generation_id,
    ) || null;
    const recoveryOverlapMinutes = Number.isFinite(
      Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes),
    )
      ? Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes)
      : null;
    const forceRefresh = input.forceRefresh !== false;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let done = 0;
    const errors = [];
    const totalPlanned = lookupPostingNumbers.length * chunks.length * maxPages;

    jobService.updateJob(job.jobId, { status: SYNC_JOB_STATUS.running, startedAt: nowIso(), progressTotal: totalPlanned });
    stateService.upsertState({
      domain: 'finance',
      shopId,
      scopeKey: buildFinanceRunScopeKey({ ...dateRange, continuous }),
      status: 'running',
      lastAttemptAt: nowIso(),
    });

    for (const postingNumber of lookupPostingNumbers) {
      for (const chunk of chunks) {
        let pageCount = null;
        for (let page = 1; page <= maxPages; page += 1) {
          const filter = {
            date: { from: chunk.from, to: chunk.to },
            operation_type: Array.isArray(input.operationTypes) ? input.operationTypes : [],
            transaction_type: input.transactionType || 'all',
          };
          if (postingNumber) filter.posting_number = postingNumber;
          try {
            const scheduled = await ozonScheduler.executeReadOnly({
              shopId,
              domain: 'finance',
              endpointKey: 'finance.transactionList',
              action: 'sync-finance-transactions',
              priority: input.priority || 'P2',
              profile: input.profile ?? input.schedulerProfile,
              source: syncSource,
              syncMode,
              recoveryRestoreId,
              recoveryGenerationId,
              recoveryOverlapMinutes,
              params: { filter, page, page_size: pageSize },
              cacheKey: buildFinanceTransactionCacheKey({
                shopId,
                postingNumber,
                ...chunk,
                page,
                continuous,
              }),
              idempotencyKey: `${job.jobId}:finance.transactionList:${postingNumber || 'all'}:${chunk.from}:${page}`,
              requestedBy,
              forceRefresh,
              allowStale: true,
            });
            if (!isSchedulerOk(scheduled)) {
              failedCount += 1;
              errors.push(`${postingNumber || 'all'} page ${page}: ${schedulerErrorMessage(scheduled)}`);
              break;
            }
            const data = getSchedulerData(scheduled);
            const rows = extractOperations(data);
            const merge = repository.upsertOperations({ shopId, rows });
            changedCount += merge.changed || 0;
            unchangedCount += merge.unchanged || 0;
            pageCount = getPageCount(data);
            if ((pageCount !== null && page >= pageCount) || rows.length < pageSize) break;
          } catch (error) {
            failedCount += 1;
            errors.push(`${postingNumber || 'all'} page ${page}: ${error instanceof Error ? error.message : String(error)}`);
            break;
          } finally {
            done += 1;
            jobService.updateJob(job.jobId, { progressDone: done, changedCount, unchangedCount, failedCount });
          }
        }
      }
    }

    const finalStatus = failedCount === 0 ? SYNC_JOB_STATUS.success : changedCount + unchangedCount > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
    const lastError = errors[0] || null;
    const finalJob = jobService.updateJob(job.jobId, {
      status: finalStatus,
      progressDone: done,
      progressTotal: totalPlanned,
      changedCount,
      unchangedCount,
      failedCount,
      lastError,
      finishedAt: nowIso(),
    });
    stateService.upsertState({
      domain: 'finance',
      shopId,
      scopeKey: buildFinanceRunScopeKey({ ...dateRange, continuous }),
      status: finalStatus,
      lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(),
      lastAttemptAt: nowIso(),
      lastError,
      changedCount,
      unchangedCount,
    });
    let cacheCompaction = null;
    if (finalStatus !== SYNC_JOB_STATUS.failed && continuous) {
      try {
        cacheCompaction = compactFinanceCacheScopes(db, { shopId });
      } catch {
        // Cache compaction is best-effort and must not turn a verified Ozon/fact merge into a failed sync.
        cacheCompaction = { ok: false };
      }
    }
    return { job: finalJob, errors, cacheCompaction };
  }

  function startSync(input = {}) {
    if (!repository || !jobService) {
      return {
        ok: false,
        domain: 'finance',
        error: { code: 'FINANCE_SYNC_NOT_CONNECTED', message: 'finance domain service is not connected to SQLite cache.' },
      };
    }
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    if (!shopId) {
      return { ok: false, domain: 'finance', error: { code: 'FINANCE_SHOP_ID_REQUIRED', message: 'shopId is required for finance sync.' } };
    }

    const dateRange = resolveDateRange(input);
    const continuous = isContinuousFinanceSync(input);
    const requestFingerprint = buildRequestFingerprint({ ...input, shopId, dateRange });
    const reusable = jobService.findReusableJob({ requestFingerprint, idempotencyKey: input.idempotencyKey ?? input.idempotency_key });
    if (reusable?.job) {
      return publicJobPayload(reusable.job, { reused: true, reusedFromJobId: reusable.job.jobId, reason: reusable.reason });
    }
    const job = jobService.createJob({
      id: createFinanceJobId(),
      domain: 'finance',
      shopId,
      endpointKey: 'finance.transactionList',
      action: 'sync-finance-transactions',
      priority: input.priority || 'P2',
      profile: input.profile ?? input.schedulerProfile ?? null,
      source: input.source ?? input.syncSource ?? null,
      requestedBy: input.requestedBy || input.requested_by || 'finance-domain-service',
      cacheKey: buildFinanceJobCacheKey({ shopId, ...dateRange, continuous }),
      idempotencyKey: input.idempotencyKey || input.idempotency_key || null,
      requestFingerprint,
      dedupeUntil: new Date(Date.now() + 60_000).toISOString(),
      progressTotal: 0,
    });
    backgroundRunner(() => {
      runFinanceSyncJob(job, { ...input, shopId, dateRange }).catch((error) => {
        jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.failed,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
        });
      });
    });
    return publicJobPayload(job, { reused: false, dateRange });
  }

  return {
    domain: 'finance',
    readCache,
    startSync,
    runFinanceSyncJob,
  };
}

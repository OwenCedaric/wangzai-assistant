import { createRatingPenaltyRepository } from '../../db/repositories/ratingPenaltyRepository.js';
import { createProfitLedgerSnapshotRepository } from '../../db/repositories/profitLedgerSnapshotRepository.js';
import { createProfitOrderReviewReadModel } from './profitOrderReviewReadModel.js';
import { createSyncJobService, SYNC_JOB_STATUS } from '../../sync/syncJobService.js';
import { createSyncStateService } from '../../sync/syncStateService.js';
import { createStableHash } from '../../utils/stableHash.js';
import { createShopScopedRepositoryRouter } from '../../db/shopScopedRepositoryRouter.js';

const DEFAULT_RATING_PAGE_SIZE = 1000;
const DEFAULT_RATING_MAX_PAGES = 50;
export const PROFIT_SYNC_ENDPOINT_KEYS = Object.freeze([
  'rating.fbsPostingList',
]);
const PROFIT_SYNC_ENDPOINT_SET = new Set(PROFIT_SYNC_ENDPOINT_KEYS);

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

function toPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(number), max));
}

function hasRatingPenaltyTable(db) {
  try {
    return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ozon_rating_penalties'").get());
  } catch {
    return false;
  }
}

function hasProfitLedgerSnapshotTable(db) {
  try {
    return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profit_ledger_snapshots'").get());
  } catch {
    return false;
  }
}

function getSchedulerData(result = {}) {
  return result.data ?? result.cache?.payload ?? null;
}

function isSchedulerOk(result = {}) {
  if (result.ok === false || result.partial === true || result.stale === true || result.cache?.stale === true
    || result.status === 'partial' || result.errors?.length) return false;
  return Boolean(result.ok || result.status === 'success' || result.status === 'cache_hit');
}

function ratingPage(payload, repository) {
  const source = payload?.result ?? payload;
  if (payload?.partial === true || source?.partial === true) throw new Error('PROFIT_RATING_PAGE_PARTIAL: 罚款页面只返回了部分数据');
  const valid = Array.isArray(source) || Array.isArray(source?.postings) || Array.isArray(source?.items)
    || Boolean(source?.posting_number || source?.operation_id);
  if (!valid) throw new Error('PROFIT_RATING_PAYLOAD_INVALID: 罚款接口未返回可识别的订单列表');
  const rows = repository.extractPenaltyRows(payload);
  const flag = source?.has_next ?? source?.hasNext ?? payload?.has_next ?? payload?.hasNext;
  if (flag != null && ![true, false, 'true', 'false'].includes(flag)) throw new Error('PROFIT_RATING_PAGINATION_INVALID: 下一页标志无效');
  const hasNext = flag === true || flag === 'true' ? true : flag === false || flag === 'false' ? false : null;
  return { rows, hasNext };
}

function schedulerErrorMessage(result, fallback = 'Ozon 错误指数接口调用失败') {
  const first = result?.errors?.[0];
  return first?.message || result?.job?.lastError || result?.error?.message || fallback;
}

function createProfitJobId() {
  return `profit_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function buildRequestFingerprint(input = {}) {
  return createStableHash({
    domain: 'profit',
    shopId: input.shopId,
    endpointKey: input.endpointKey,
    params: input.params,
    pageSize: input.pageSize,
    maxPages: input.maxPages,
    forceRefresh: input.forceRefresh !== false,
    syncMode: normalizeText(input.syncMode ?? input.sync_mode),
    recoveryRestoreId: normalizeText(input.recoveryRestoreId ?? input.recovery_restore_id),
  }, { length: 32 });
}

function withOffsetParams(params = {}, { limit, offset } = {}) {
  return { ...(params || {}), limit, offset };
}

function ratingScope(input = {}) {
  const filter = input.filter && typeof input.filter === 'object' ? input.filter : {};
  const date = value => {
    const text = normalizeText(value);
    const timestamp = Date.parse(text);
    return text && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : text;
  };
  return {
    since: date(filter.date_from || filter.from || input.from || input.since),
    to: date(filter.date_to || filter.to || input.to || input.dateTo),
    postingNumber: normalizeText(filter.posting_number || input.posting_number || input.postingNumber),
  };
}

function ratingScopeKey(scope) {
  return `profit:rating.fbsPostingList:scope:${createStableHash(scope, { length: 32 })}`;
}

function scopeCovers(stored = {}, query = {}) {
  if (!stored || !['since', 'to', 'postingNumber'].every(key => typeof stored[key] === 'string')) return false;
  const wanted = ratingScope(query);
  if (stored.postingNumber && stored.postingNumber !== wanted.postingNumber) return false;
  if (stored.since && (!wanted.since || !(Date.parse(stored.since) <= Date.parse(wanted.since)))) return false;
  if (stored.to && (!wanted.to || !(Date.parse(stored.to) >= Date.parse(wanted.to)))) return false;
  return true;
}

export function createProfitService({ ozonScheduler, db, readDb = db, shopOperationalStorage = null, shopProfitLedgerStorage = null, backgroundRunner = (task) => setImmediate(task) } = {}) {
  const canonicalRatingRepository = db && hasRatingPenaltyTable(db) ? createRatingPenaltyRepository(db) : null;
  const ratingRepository = canonicalRatingRepository && shopOperationalStorage?.resolveDirectWriteSession
    ? createShopScopedRepositoryRouter({
        canonicalRepository: canonicalRatingRepository,
        createRepository: createRatingPenaltyRepository,
        storage: shopOperationalStorage,
        aggregateRepository: readDb !== db ? createRatingPenaltyRepository(readDb) : null,
        writeMethods: ['upsertPenalties'],
        readMethods: ['listPenalties'],
      })
    : canonicalRatingRepository;
  const ledgerSnapshotRepository = shopProfitLedgerStorage || (db && hasProfitLedgerSnapshotTable(db) ? createProfitLedgerSnapshotRepository(db) : null);
  const orderReviewReadModel = readDb ? createProfitOrderReviewReadModel(readDb) : null;
  const jobService = db ? createSyncJobService(db) : null;
  const stateService = db ? createSyncStateService(db) : null;

  function readCache(query = {}) {
    const scope = normalizeText(query.scope ?? query.entity ?? query.type);
    if (scope === 'ledger-snapshot' || scope === 'ledger_snapshot') {
      if (!ledgerSnapshotRepository) {
        return { ok: false, error: { code: 'PROFIT_LEDGER_CACHE_NOT_CONNECTED', message: 'profit ledger SQLite cache is not connected.' } };
      }
      return ledgerSnapshotRepository.readSnapshot(query);
    }
    if (scope === 'rating-penalties' || scope === 'rating_penalties') {
      if (!ratingRepository) {
        return { ok: false, error: { code: 'PROFIT_RATING_CACHE_NOT_CONNECTED', message: 'profit rating penalty cache is not connected.' } };
      }
      const started = Date.now();
      const payload = ratingRepository.listPenalties(query);
      payload.durationMs = Date.now() - started;
      payload.syncState = stateService?.listStates('profit', { shopId: query.shopId || query.shop_id, limit: 5 }) ?? [];
      const state = stateService?.getState('profit', ratingScopeKey(ratingScope(query)), query.shopId || query.shop_id)
        || stateService?.getState('profit', 'profit:rating.fbsPostingList', query.shopId || query.shop_id);
      let receipt = null;
      try { receipt = JSON.parse(state?.remoteCursor || 'null'); } catch { /* legacy receipt is unverified */ }
      payload.complete = Boolean(state?.status === SYNC_JOB_STATUS.success && receipt?.version === 1
        && receipt.complete === true && scopeCovers(receipt.scope, query));
      payload.partial = !payload.complete;
      return payload;
    }
    if (!ozonScheduler?.readCache) {
      return { ok: false, error: { code: 'DOMAIN_CACHE_NOT_CONNECTED', message: 'profit cache reader is not connected.' } };
    }
    return ozonScheduler.readCache('profit', query);
  }

  function readLedgerSnapshot(query = {}) {
    if (query.layoutOnly === '1' || query.layoutOnly === 'true' || query.layoutOnly === true) {
      return shopProfitLedgerStorage?.layout() || { ok: true, partitioned: false, independentShopIds: [] };
    }
    if (!ledgerSnapshotRepository) {
      return { ok: false, error: { code: 'PROFIT_LEDGER_CACHE_NOT_CONNECTED', message: 'profit ledger SQLite cache is not connected.' } };
    }
    return ledgerSnapshotRepository.readSnapshot(query);
  }

  function saveLedgerSnapshot(input = {}) {
    if (!ledgerSnapshotRepository) {
      return { ok: false, error: { code: 'PROFIT_LEDGER_CACHE_NOT_CONNECTED', message: 'profit ledger SQLite cache is not connected.' } };
    }
    return ledgerSnapshotRepository.saveSnapshot(input);
  }

  function clearLedgerSnapshots(input = {}) {
    if (!ledgerSnapshotRepository) {
      return { ok: false, error: { code: 'PROFIT_LEDGER_CACHE_NOT_CONNECTED', message: 'profit ledger SQLite cache is not connected.' } };
    }
    return ledgerSnapshotRepository.clearSnapshots(input);
  }

  function readOrderReview(query = {}) {
    if (!orderReviewReadModel) {
      return {
        ok: false,
        error: { code: 'PROFIT_REVIEW_NOT_CONNECTED', message: '订单利润复核读取器没有连接本机数据库。' },
      };
    }
    return orderReviewReadModel.read(query);
  }

  async function runRatingPenaltySyncJob(job, input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const endpointKey = 'rating.fbsPostingList';
    const rawParams = input.params && typeof input.params === 'object' ? input.params : {};
    const controls = new Set(['forceRefresh', 'autoSync', 'maxPages', 'syncMaxPages']);
    const baseParams = Object.fromEntries(Object.entries(rawParams).filter(([key]) => !controls.has(key)));
    const pageSize = toPositiveInteger(input.pageSize ?? input.limit ?? baseParams.limit, DEFAULT_RATING_PAGE_SIZE, 1000);
    const maxPages = toPositiveInteger(input.maxPages, DEFAULT_RATING_MAX_PAGES, 50);
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || 'profit-domain-service';
    const syncSource = normalizeText(input.source ?? input.syncSource) || requestedBy;
    const syncMode = normalizeText(input.syncMode ?? input.sync_mode) || null;
    const recoveryRestoreId = normalizeText(input.recoveryRestoreId ?? input.recovery_restore_id) || null;
    const recoveryGenerationId = normalizeText(input.recoveryGenerationId ?? input.recovery_generation_id) || null;
    const recoveryOverlapMinutes = Number.isFinite(Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes))
      ? Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes)
      : null;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let done = 0;
    let offset = 0;
    let complete = false;
    let canceled = false;
    const errors = [];
    const seenPages = new Set();
    const scope = ratingScope(baseParams);
    const scopeKey = ratingScopeKey(scope);
    const priorState = stateService.getState('profit', scopeKey, shopId);
    const writeState = patch => {
      stateService.upsertState({ ...patch, domain: 'profit', shopId, scopeKey: `profit:${endpointKey}` });
      stateService.upsertState({ ...patch, domain: 'profit', shopId, scopeKey });
    };
    const isCanceled = () => {
      const current = jobService.getJob(job.jobId);
      return input.signal?.aborted || !current || current.status === SYNC_JOB_STATUS.canceled;
    };

    if (isCanceled()) return { job: jobService.getJob(job.jobId), errors, complete: false };

    jobService.updateJob(job.jobId, { status: SYNC_JOB_STATUS.running, startedAt: nowIso(), progressTotal: maxPages });
    writeState({ status: 'running',
      lastSuccessAt: priorState?.lastSuccessAt, lastAttemptAt: nowIso() });

    for (let page = 1; page <= maxPages; page += 1) {
      if (isCanceled()) { canceled = true; break; }
      try {
        const scheduled = await ozonScheduler.executeReadOnly({
          shopId,
          domain: 'profit',
          endpointKey,
          action: 'sync-rating-penalties',
          priority: input.priority || 'P2',
          profile: input.profile ?? input.schedulerProfile,
          source: syncSource,
          syncMode,
          recoveryRestoreId,
          recoveryGenerationId,
          recoveryOverlapMinutes,
          params: withOffsetParams(baseParams, { limit: pageSize, offset }),
          cacheKey: `profit:${shopId}:${scopeKey}:offset:${offset}:limit:${pageSize}`,
          idempotencyKey: `${job.jobId}:${endpointKey}:page:${page}`,
          requestedBy,
          forceRefresh: input.forceRefresh !== false,
          allowStale: false,
        });
        if (isCanceled()) { canceled = true; break; }
        if (!isSchedulerOk(scheduled)) {
          failedCount += 1;
          errors.push(`page ${page}: ${schedulerErrorMessage(scheduled)}`);
          break;
        }
        const { rows, hasNext } = ratingPage(getSchedulerData(scheduled), ratingRepository);
        if (!rows.length && hasNext === true) throw new Error('PROFIT_RATING_PAGE_NO_PROGRESS: 接口声明还有下一页但没有返回记录');
        const pageKey = createStableHash(rows, { length: 40 });
        if (rows.length && seenPages.has(pageKey)) throw new Error('PROFIT_RATING_PAGE_REPEATED: 罚款接口重复返回同一页');
        seenPages.add(pageKey);
        const merge = ratingRepository.upsertPenalties({ shopId, rows });
        if (merge?.ok !== true || merge.missing > 0) throw new Error('PROFIT_RATING_PERSISTENCE_INCOMPLETE: 罚款没有全部持久化');
        changedCount += merge.changed || 0;
        unchangedCount += merge.unchanged || 0;
        offset += rows.length;
        if (hasNext === false || (hasNext === null && rows.length < pageSize)) { complete = true; break; }
      } catch (error) {
        failedCount += 1;
        errors.push(`page ${page}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      } finally {
        done += 1;
        jobService.updateJob(job.jobId, { progressDone: done, changedCount, unchangedCount, failedCount });
      }
    }

    if (!complete && !canceled && !failedCount) {
      failedCount += 1;
      errors.push('PROFIT_RATING_PAGE_LIMIT: 已达到本次分页上限，罚款尚未读取完整');
    }
    const finalStatus = canceled ? SYNC_JOB_STATUS.canceled : complete && failedCount === 0 ? SYNC_JOB_STATUS.success
      : changedCount + unchangedCount > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
    const lastError = errors[0] || null;
    const finalJob = jobService.updateJob(job.jobId, {
      status: finalStatus,
      progressDone: done,
      progressTotal: complete ? done : maxPages,
      changedCount,
      unchangedCount,
      failedCount,
      lastError,
      finishedAt: nowIso(),
    });
    // A removed/canceled job must never resurrect account state or produce a
    // synthetic completion receipt from the job service's delayed-write fallback.
    const persistedJob = jobService.getJob(job.jobId);
    if (!persistedJob) return { job: null, errors, complete: false };
    if (persistedJob.status !== finalStatus || persistedJob.finishedAt !== finalJob?.finishedAt) {
      throw new Error('PROFIT_RATING_JOB_NOT_PERSISTED: 同步结果尚未持久化');
    }
    writeState({
      status: finalStatus,
      lastSuccessAt: finalStatus === SYNC_JOB_STATUS.success ? nowIso() : priorState?.lastSuccessAt,
      lastAttemptAt: nowIso(),
      lastError,
      changedCount,
      unchangedCount,
      remoteCursor: JSON.stringify({ version: 1, complete: finalStatus === SYNC_JOB_STATUS.success, offset, scope }),
    });
    return { job: finalJob, errors, complete: finalStatus === SYNC_JOB_STATUS.success };
  }

  function startSync(input = {}) {
    const endpointKey = normalizeText(input.endpointKey ?? input.endpoint_key) || 'rating.fbsPostingList';
    if (!PROFIT_SYNC_ENDPOINT_SET.has(endpointKey)) {
      return {
        ok: false,
        domain: 'profit',
        endpointKey,
        supportedEndpointKeys: PROFIT_SYNC_ENDPOINT_KEYS,
        error: {
          code: 'PROFIT_ENDPOINT_NOT_SUPPORTED',
          message: '该利润同步项目不属于已登记的 Ozon 利润数据接口。',
        },
      };
    }
    if (!ratingRepository || !jobService) {
      return { ok: false, domain: 'profit', error: { code: 'PROFIT_RATING_SYNC_NOT_CONNECTED', message: 'profit rating penalty sync is not connected to SQLite cache.' } };
    }
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    if (!shopId) {
      return { ok: false, domain: 'profit', error: { code: 'PROFIT_SHOP_ID_REQUIRED', message: 'shopId is required for profit sync.' } };
    }
    const requestFingerprint = buildRequestFingerprint({ ...input, shopId, endpointKey });
    const reusable = jobService.findReusableJob({ requestFingerprint, idempotencyKey: input.idempotencyKey ?? input.idempotency_key });
    if (reusable?.job) {
      return { ok: true, accepted: true, domain: 'profit', jobId: reusable.job.jobId, job: reusable.job, status: reusable.job.status, reused: true, reusedFromJobId: reusable.job.jobId, reason: reusable.reason };
    }
    const job = jobService.createJob({
      id: createProfitJobId(),
      domain: 'profit',
      shopId,
      endpointKey,
      action: 'sync-rating-penalties',
      priority: input.priority || 'P2',
      profile: input.profile ?? input.schedulerProfile ?? null,
      source: input.source ?? input.syncSource ?? null,
      requestedBy: input.requestedBy || input.requested_by || 'profit-domain-service',
      cacheKey: `profit:${shopId}:${endpointKey}`,
      idempotencyKey: input.idempotencyKey || input.idempotency_key || null,
      requestFingerprint,
      dedupeUntil: new Date(Date.now() + 60_000).toISOString(),
      progressTotal: 0,
    });
    backgroundRunner(() => {
      runRatingPenaltySyncJob(job, { ...input, shopId, endpointKey }).catch((error) => {
        jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.failed,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
        });
      });
    });
    return { ok: true, accepted: true, domain: 'profit', jobId: job.jobId, job, status: job.status, reused: false, endpointKey };
  }

  return {
    domain: 'profit',
    readCache,
    readLedgerSnapshot,
    saveLedgerSnapshot,
    clearLedgerSnapshots,
    readOrderReview,
    startSync,
    runRatingPenaltySyncJob,
  };
}

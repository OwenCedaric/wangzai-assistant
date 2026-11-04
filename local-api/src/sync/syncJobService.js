import { randomUUID } from 'node:crypto';

export const SYNC_JOB_STATUS = Object.freeze({
  queued: 'queued',
  running: 'running',
  success: 'success',
  partial: 'partial',
  failed: 'failed',
  canceled: 'canceled',
  blocked: 'blocked',
  rateLimited: 'rate_limited',
  circuitOpen: 'circuit_open',
});

const VALID_STATUSES = new Set(Object.values(SYNC_JOB_STATUS));
const ACTIVE_STATUSES = ['queued', 'running', 'rate_limited', 'circuit_open'];
const OPTIONAL_JOB_COLUMNS = Object.freeze({
  profile: 'profile',
  source: 'source',
  stage: 'stage',
  message: 'message',
  itemsDone: 'items_done',
  itemsTotal: 'items_total',
  retryCount: 'retry_count',
  nextRetryAt: 'next_retry_at',
  lastRetryAfterMs: 'last_retry_after_ms',
  lastEndpointKey: 'last_endpoint_key',
  lastAttemptId: 'last_attempt_id',
  snapshotId: 'snapshot_id',
});
const DEFAULT_BUSY_RETRY_DELAYS_MS = Object.freeze([100, 250, 500, 1_000, 2_000, 5_000]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(status) {
  return VALID_STATUSES.has(status) ? status : SYNC_JOB_STATUS.queued;
}

export function isSqliteBusyError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  return error?.errcode === 5
    || code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || code === 'ERR_SQLITE_BUSY'
    || /database (?:is )?(?:locked|busy)/iu.test(message);
}

function toPublicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.id,
    domain: row.domain,
    shopId: row.shop_id || null,
    endpointKey: row.endpoint_key || null,
    action: row.action || null,
    priority: row.priority,
    profile: row.profile || null,
    source: row.source || null,
    status: row.status,
    stage: row.stage || null,
    message: row.message || null,
    requestedBy: row.requested_by || null,
    cacheKey: row.cache_key || null,
    idempotencyKey: row.idempotency_key || null,
    requestFingerprint: row.request_fingerprint || null,
    dedupeUntil: row.dedupe_until || null,
    reusedFromJobId: row.reused_from_job_id || null,
    lockKey: row.lock_key || null,
    progress: {
      done: row.progress_done,
      total: row.progress_total,
      itemsDone: row.items_done || 0,
      itemsTotal: row.items_total || 0,
    },
    retry: {
      count: row.retry_count || 0,
      nextRetryAt: row.next_retry_at || null,
      lastRetryAfterMs: row.last_retry_after_ms || null,
    },
    trace: {
      lastEndpointKey: row.last_endpoint_key || row.endpoint_key || null,
      lastAttemptId: row.last_attempt_id || null,
    },
    snapshotId: row.snapshot_id || null,
    changedCount: row.changed_count,
    unchangedCount: row.unchanged_count,
    failedCount: row.failed_count,
    staleCount: row.stale_count,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  };
}

export function createSyncJobPlaceholder(moduleName) {
  return {
    module: moduleName,
    status: SYNC_JOB_STATUS.queued,
    note: '统一同步任务底座已建立；具体业务域需要通过 syncJobService 写入 job/status。',
  };
}

function readJobColumns(db) {
  try {
    return new Set(db.prepare('PRAGMA table_info(ozon_request_jobs)').all().map((row) => row.name));
  } catch (_error) {
    return new Set();
  }
}

export function createSyncJobService(db, options = {}) {
  const jobColumns = readJobColumns(db);
  const pendingBusyUpdates = new Map();
  const configuredRetryDelays = Array.isArray(options.busyRetryDelaysMs)
    ? options.busyRetryDelaysMs
      .map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0)
      .map((value) => Math.floor(value))
    : [];
  const busyRetryDelaysMs = configuredRetryDelays.length
    ? configuredRetryDelays
    : DEFAULT_BUSY_RETRY_DELAYS_MS;
  const logBusyRetry = typeof options.logBusyRetry === 'function'
    ? options.logBusyRetry
    : (event) => console.warn(`[sync-job] ${event.code} job=${event.jobId} attempt=${event.attempt}`);

  function updateOptionalJobFields(jobId, patch = {}) {
    const assignments = [];
    const values = [];
    for (const [patchKey, columnName] of Object.entries(OPTIONAL_JOB_COLUMNS)) {
      if (!jobColumns.has(columnName) || patch[patchKey] === undefined) continue;
      assignments.push(`${columnName} = ?`);
      values.push(patch[patchKey]);
    }
    if (!assignments.length) return;
    assignments.push('updated_at = ?');
    values.push(nowIso(), jobId);
    db.prepare(`UPDATE ozon_request_jobs SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  }

  function patchedJobRow(existing, patch = {}, timestamp = nowIso()) {
    const next = {
      ...existing,
      status: normalizeStatus(patch.status || existing.status),
      progress_done: Number.isFinite(Number(patch.progressDone)) ? Number(patch.progressDone) : existing.progress_done,
      progress_total: Number.isFinite(Number(patch.progressTotal)) ? Number(patch.progressTotal) : existing.progress_total,
      changed_count: Number.isFinite(Number(patch.changedCount)) ? Number(patch.changedCount) : existing.changed_count,
      unchanged_count: Number.isFinite(Number(patch.unchangedCount)) ? Number(patch.unchangedCount) : existing.unchanged_count,
      failed_count: Number.isFinite(Number(patch.failedCount)) ? Number(patch.failedCount) : existing.failed_count,
      stale_count: Number.isFinite(Number(patch.staleCount)) ? Number(patch.staleCount) : existing.stale_count,
      last_error: patch.lastError === undefined ? existing.last_error : patch.lastError,
      started_at: patch.startedAt === undefined ? existing.started_at : patch.startedAt,
      finished_at: patch.finishedAt === undefined ? existing.finished_at : patch.finishedAt,
      request_fingerprint: patch.requestFingerprint === undefined ? existing.request_fingerprint : patch.requestFingerprint,
      dedupe_until: patch.dedupeUntil === undefined ? existing.dedupe_until : patch.dedupeUntil,
      reused_from_job_id: patch.reusedFromJobId === undefined ? existing.reused_from_job_id : patch.reusedFromJobId,
      lock_key: patch.lockKey === undefined ? existing.lock_key : patch.lockKey,
      updated_at: timestamp,
    };
    for (const [patchKey, columnName] of Object.entries(OPTIONAL_JOB_COLUMNS)) {
      if (jobColumns.has(columnName) && patch[patchKey] !== undefined) next[columnName] = patch[patchKey];
    }
    return next;
  }

  function persistJobUpdate(jobId, patch = {}) {
    const existing = db.prepare('SELECT * FROM ozon_request_jobs WHERE id = ?').get(jobId);
    if (!existing) return { job: null, existing: null };
    const timestamp = nowIso();
    const next = patchedJobRow(existing, patch, timestamp);
    db.prepare(`
      UPDATE ozon_request_jobs SET
        status = ?, progress_done = ?, progress_total = ?, changed_count = ?,
        unchanged_count = ?, failed_count = ?, stale_count = ?, last_error = ?,
        started_at = ?, finished_at = ?, request_fingerprint = ?, dedupe_until = ?,
        reused_from_job_id = ?, lock_key = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.status,
      next.progress_done,
      next.progress_total,
      next.changed_count,
      next.unchanged_count,
      next.failed_count,
      next.stale_count,
      next.last_error,
      next.started_at,
      next.finished_at,
      next.request_fingerprint,
      next.dedupe_until,
      next.reused_from_job_id,
      next.lock_key,
      timestamp,
      jobId,
    );
    updateOptionalJobFields(jobId, patch);
    return { job: toPublicJob(next), existing };
  }

  function clearPendingBusyUpdate(jobId) {
    const pending = pendingBusyUpdates.get(jobId);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingBusyUpdates.delete(jobId);
  }

  function scheduleBusyUpdate(jobId, patch = {}) {
    const current = pendingBusyUpdates.get(jobId);
    if (current) {
      current.patch = { ...current.patch, ...patch };
      return;
    }

    const pending = { patch: { ...patch }, attempt: 0, timer: null };
    const run = () => {
      const live = pendingBusyUpdates.get(jobId);
      if (!live) return;
      try {
        persistJobUpdate(jobId, live.patch);
        clearPendingBusyUpdate(jobId);
      } catch (error) {
        if (!isSqliteBusyError(error) || live.attempt >= busyRetryDelaysMs.length - 1) {
          clearPendingBusyUpdate(jobId);
          logBusyRetry({
            code: isSqliteBusyError(error) ? 'SQLITE_BUSY_RETRY_EXHAUSTED' : 'SQLITE_BUSY_RETRY_FAILED',
            jobId,
            attempt: live.attempt + 1,
          });
          return;
        }
        live.attempt += 1;
        logBusyRetry({ code: 'SQLITE_BUSY_RETRY_PENDING', jobId, attempt: live.attempt + 1 });
        live.timer = setTimeout(run, busyRetryDelaysMs[live.attempt]);
        live.timer.unref?.();
      }
    };

    pendingBusyUpdates.set(jobId, pending);
    logBusyRetry({ code: 'SQLITE_BUSY_RETRY_SCHEDULED', jobId, attempt: 1 });
    pending.timer = setTimeout(run, busyRetryDelaysMs[0]);
    pending.timer.unref?.();
  }

  return {
    createJob(input = {}) {
      const timestamp = nowIso();
      const id = input.id || input.jobId || `ozon_job_${randomUUID()}`;
      db.prepare(`
        INSERT INTO ozon_request_jobs (
          id, domain, shop_id, endpoint_key, action, priority, status,
          requested_by, cache_key, idempotency_key, request_fingerprint,
          dedupe_until, reused_from_job_id, lock_key, progress_total,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.domain || 'unknown',
        input.shopId || null,
        input.endpointKey || null,
        input.action || null,
        input.priority || 'P2',
        normalizeStatus(input.status || SYNC_JOB_STATUS.queued),
        input.requestedBy || null,
        input.cacheKey || null,
        input.idempotencyKey || null,
        input.requestFingerprint || null,
        input.dedupeUntil || null,
        input.reusedFromJobId || null,
        input.lockKey || null,
        Number(input.progressTotal) || 0,
        timestamp,
        timestamp,
      );
      updateOptionalJobFields(id, {
        profile: input.profile,
        source: input.source,
        stage: input.stage,
        message: input.message,
        itemsDone: input.itemsDone,
        itemsTotal: input.itemsTotal,
        retryCount: input.retryCount,
        nextRetryAt: input.nextRetryAt,
        lastRetryAfterMs: input.lastRetryAfterMs,
        lastEndpointKey: input.lastEndpointKey,
        lastAttemptId: input.lastAttemptId,
        snapshotId: input.snapshotId,
      });
      return this.getJob(id);
    },

    getJob(jobId) {
      const row = db.prepare('SELECT * FROM ozon_request_jobs WHERE id = ?').get(jobId);
      return toPublicJob(row);
    },

    findReusableJob({ requestFingerprint, idempotencyKey, now = nowIso() } = {}) {
      if (requestFingerprint) {
        const row = db.prepare(`
          SELECT * FROM ozon_request_jobs
          WHERE request_fingerprint = ? AND status IN ('queued', 'running', 'rate_limited', 'circuit_open')
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(requestFingerprint);
        if (row) return { reason: 'request_fingerprint_active', job: toPublicJob(row) };
      }

      if (idempotencyKey) {
        const row = db.prepare(`
          SELECT * FROM ozon_request_jobs
          WHERE idempotency_key = ?
            AND (dedupe_until IS NULL OR dedupe_until >= ?)
            AND status IN ('queued', 'running', 'rate_limited', 'circuit_open', 'success', 'partial')
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(idempotencyKey, now);
        if (row) return { reason: 'idempotency_key_dedupe', job: toPublicJob(row) };
      }

      return null;
    },

    updateJob(jobId, patch = {}) {
      const pendingPatch = pendingBusyUpdates.get(jobId)?.patch || {};
      const mergedPatch = { ...pendingPatch, ...patch };
      try {
        const result = persistJobUpdate(jobId, mergedPatch);
        clearPendingBusyUpdate(jobId);
        return result.job;
      } catch (error) {
        if (!isSqliteBusyError(error)) throw error;
        let existing = null;
        try {
          existing = db.prepare('SELECT * FROM ozon_request_jobs WHERE id = ?').get(jobId);
        } catch (readError) {
          if (!isSqliteBusyError(readError)) throw readError;
        }
        scheduleBusyUpdate(jobId, mergedPatch);
        return existing ? toPublicJob(patchedJobRow(existing, mergedPatch)) : null;
      }
    },

    cancelJob(jobId, reason = 'canceled_by_request') {
      const job = this.getJob(jobId);
      if (!job) return null;
      if (['success', 'failed', 'canceled'].includes(job.status)) return job;
      return this.updateJob(jobId, {
        status: SYNC_JOB_STATUS.canceled,
        finishedAt: nowIso(),
        lastError: reason,
      });
    },

    listJobs(filters = {}) {
      const rows = db.prepare(`
        SELECT * FROM ozon_request_jobs
        WHERE (? IS NULL OR domain = ?)
          AND (? IS NULL OR status = ?)
        ORDER BY created_at DESC
        LIMIT ?
      `).all(
        filters.domain || null,
        filters.domain || null,
        filters.status || null,
        filters.status || null,
        Math.min(Number(filters.limit) || 100, 500),
      );
      return rows.map(toPublicJob);
    },

    activeStatuses: ACTIVE_STATUSES,
  };
}

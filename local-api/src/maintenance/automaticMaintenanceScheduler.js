import { existsSync, statSync } from 'node:fs';
import { TECHNICAL_RETENTION_CONFIRMATION } from './technicalRetentionPreview.js';

export const AUTOMATIC_MAINTENANCE_POLICY = Object.freeze({
  startupDelayMs: 60_000,
  busyRetryMs: 60_000,
  checkIntervalMs: 60 * 60 * 1_000,
  timeTriggerMs: 24 * 60 * 60 * 1_000,
  sizeTriggerBytes: 2 * 1_000 * 1_000 * 1_000,
  minimumReclaimableBytes: 64 * 1_024 * 1_024,
  maximumIncrementalVacuumPages: 262_144,
  retentionWaitTimeoutMs: 30 * 60 * 1_000,
});

function numberPragma(db, name) {
  return Number(db.prepare(`PRAGMA ${name}`).get()?.[name]) || 0;
}

function archiveBytes(value) {
  if (value === null || value === undefined || value === '') return null;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

function storageStats(db, databasePath) {
  const pageSize = numberPragma(db, 'page_size');
  const pageCount = numberPragma(db, 'page_count');
  const freePages = numberPragma(db, 'freelist_count');
  return {
    pageSize,
    pageCount,
    freePages,
    logicalBytes: pageSize * pageCount,
    reclaimableBytes: pageSize * freePages,
    databaseBytes: databasePath && existsSync(databasePath)
      ? statSync(databasePath).size
      : pageSize * pageCount,
    autoVacuumMode: numberPragma(db, 'auto_vacuum'),
  };
}

function publicState(state) {
  return {
    ok: state.status !== 'failed',
    mode: 'automatic-technical-maintenance',
    enabled: state.enabled,
    active: state.status === 'running',
    status: state.status,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastTrigger: state.lastTrigger,
    lastArchivedRecords: state.lastArchivedRecords,
    lastExpiredArchives: state.lastExpiredArchives,
    lastArchiveBytes: state.lastArchiveBytes,
    lastArchiveByteLimit: state.lastArchiveByteLimit,
    lastArchiveCapacitySatisfied: state.lastArchiveCapacitySatisfied,
    lastArchiveCapacityReason: state.lastArchiveCapacityReason,
    lastArchiveMeasuredAt: state.lastArchiveMeasuredAt,
    archiveCapacityCheckStatus: state.archiveCapacityCheckStatus,
    lastCandidateRows: state.lastCandidateRows,
    lastDeletedRows: state.lastDeletedRows,
    lastCompactedProductStageBatches: state.lastCompactedProductStageBatches,
    lastReclaimedBytes: state.lastReclaimedBytes,
    nextCheckAt: state.nextCheckAt,
    policy: state.policy,
    ...(state.code ? { code: state.code } : {}),
  };
}

function iso(value) {
  return new Date(value).toISOString();
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Runs only the registry-approved runtime retention plan. Business facts are
 * outside this service. Full VACUUM stays explicit; once the profile has been
 * bootstrapped to incremental auto-vacuum, this scheduler reclaims bounded
 * free-page slices after each successful cleanup.
 */
export function createAutomaticMaintenanceScheduler({
  db,
  databasePath = null,
  retentionService,
  retentionRunner,
  archiveService = null,
  stageCompactor = null,
  activityProbe = null,
  enabled = true,
  policy: policyOverrides = {},
  now = () => new Date(),
  sleep = delay,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
} = {}) {
  if (!db || !retentionService?.inspect || !retentionRunner?.start || !retentionRunner?.getStatus) {
    throw new Error('createAutomaticMaintenanceScheduler requires db and retention services');
  }
  const policy = Object.freeze({ ...AUTOMATIC_MAINTENANCE_POLICY, ...policyOverrides });
  const state = {
    enabled: enabled === true,
    status: enabled === true ? 'idle' : 'disabled',
    lastStartedAt: null,
    lastFinishedAt: null,
    lastTrigger: null,
    lastArchivedRecords: 0,
    lastExpiredArchives: 0,
    lastArchiveBytes: null,
    lastArchiveByteLimit: null,
    lastArchiveCapacitySatisfied: null,
    lastArchiveCapacityReason: null,
    lastArchiveMeasuredAt: null,
    archiveCapacityCheckStatus: enabled === true ? 'unknown' : 'disabled',
    lastCandidateRows: 0,
    lastDeletedRows: 0,
    lastReclaimedBytes: 0,
    lastCompactedProductStageBatches: 0,
    nextCheckAt: null,
    code: null,
    policy: {
      startupDelayMs: policy.startupDelayMs,
      busyRetryMs: policy.busyRetryMs,
      checkIntervalMs: policy.checkIntervalMs,
      timeTriggerMs: policy.timeTriggerMs,
      sizeTriggerBytes: policy.sizeTriggerBytes,
      minimumReclaimableBytes: policy.minimumReclaimableBytes,
    },
  };
  let startupTimer = null;
  let deferredTimer = null;
  let intervalTimer = null;
  let running = null;

  function scheduleDeferredCheck() {
    if (deferredTimer || !state.enabled) return;
    state.nextCheckAt = iso(now().getTime() + policy.busyRetryMs);
    deferredTimer = setTimeoutImpl(() => {
      deferredTimer = null;
      void execute();
    }, policy.busyRetryMs);
    deferredTimer.unref?.();
  }

  function backgroundRuntimeBusy() {
    let probeBusy = false;
    if (typeof activityProbe === 'function') {
      try {
        const activity = activityProbe();
        probeBusy = activity === false
          || activity?.busy === true
          || Number(activity?.pending) > 0
          || Number(activity?.active) > 0;
      } catch (error) {
        logger.warn?.('[local-api][maintenance] activity probe failed; checking durable jobs instead', {
          code: String(error?.code || ''),
          message: String(error?.message || error),
        });
      }
    }
    if (probeBusy) return true;
    try {
      const jobsTable = db.prepare(`
        SELECT 1 AS present FROM sqlite_master
        WHERE type = 'table' AND name = 'ozon_request_jobs'
      `).get();
      if (!jobsTable?.present) return false;
      return Boolean(db.prepare(`
        SELECT 1 AS busy
        FROM ozon_request_jobs
        WHERE profile = 'background'
          AND status IN ('queued', 'running', 'rate_limited', 'circuit_open')
        LIMIT 1
      `).get()?.busy);
    } catch (error) {
      logger.warn?.('[local-api][maintenance] durable background-job probe failed; maintenance remains enabled', {
        code: String(error?.code || ''),
        message: String(error?.message || error),
      });
      return false;
    }
  }

  function reclaimIncrementally() {
    let before = storageStats(db, databasePath);
    try {
      db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      before = storageStats(db, databasePath);
      if (before.autoVacuumMode === 2 && before.reclaimableBytes >= policy.minimumReclaimableBytes) {
        const pages = Math.min(before.freePages, policy.maximumIncrementalVacuumPages);
        db.exec(`PRAGMA incremental_vacuum(${pages})`);
      }
      // Incremental vacuum and retention deletes can both leave a large WAL.
      // Truncate only after the main database has accepted every committed page.
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch (error) {
      logger.warn?.('[local-api][maintenance] incremental vacuum deferred', {
        code: String(error?.code || ''),
        message: String(error?.message || error),
      });
    }
    const after = storageStats(db, databasePath);
    return {
      before,
      after,
      reclaimedBytes: Math.max(0, before.logicalBytes - after.logicalBytes),
    };
  }

  function recordArchiveCapacity(archive) {
    state.lastArchiveBytes = archiveBytes(archive.archiveBytes);
    state.lastArchiveByteLimit = archiveBytes(archive.archiveByteLimit);
    const measured = state.lastArchiveBytes !== null && state.lastArchiveByteLimit !== null
      ? state.lastArchiveBytes <= state.lastArchiveByteLimit : null;
    state.lastArchiveCapacitySatisfied = archive.archiveCapacitySatisfied === false || measured === false
      ? false : measured;
    state.lastArchiveCapacityReason = state.lastArchiveCapacitySatisfied === false
      ? Number(archive.invalidArchives) > 0
        ? 'TECHNICAL_ARCHIVE_UNVERIFIED_PACKAGES_PRESERVED'
        : 'TECHNICAL_ARCHIVE_CAPACITY_NOT_SATISFIED'
      : null;
    state.archiveCapacityCheckStatus = measured === null ? 'unknown' : 'measured';
    state.lastArchiveMeasuredAt = measured === null ? null : now().toISOString();
    if (state.lastArchiveCapacityReason) {
      logger.warn?.('[local-api][maintenance] archive capacity remains above its limit', {
        code: state.lastArchiveCapacityReason,
        bytes: state.lastArchiveBytes,
        limit: state.lastArchiveByteLimit,
      });
    }
  }

  async function execute({ force = false } = {}) {
    if (!state.enabled) return publicState(state);
    if (running) return running;
    running = (async () => {
      const started = now();
      if (!force && backgroundRuntimeBusy()) {
        state.status = 'idle';
        state.lastTrigger = 'deferred-runtime-busy';
        state.archiveCapacityCheckStatus = 'deferred';
        scheduleDeferredCheck();
        return publicState(state);
      }
      const stats = storageStats(db, databasePath);
      const lastFinishedMs = state.lastFinishedAt ? new Date(state.lastFinishedAt).getTime() : 0;
      const dueBySize = stats.databaseBytes >= policy.sizeTriggerBytes;
      const dueByTime = !lastFinishedMs || started.getTime() - lastFinishedMs >= policy.timeTriggerMs;
      if (!force && !dueBySize && !dueByTime) {
        state.status = 'idle';
        state.lastTrigger = 'not-due';
        state.archiveCapacityCheckStatus = 'not-due';
        return publicState(state);
      }

      state.status = 'running';
      // Keep the last measured history, but never present it as a new check
      // while this cycle is pending, failed, or deferred by business activity.
      state.archiveCapacityCheckStatus = 'checking';
      state.lastStartedAt = started.toISOString();
      state.lastTrigger = force ? 'forced' : dueBySize ? 'database-size' : 'daily-retention';
      state.code = null;
      const stageCompaction = stageCompactor?.compactExpiredTerminalStagePayloads
        ? stageCompactor.compactExpiredTerminalStagePayloads({ at: started.toISOString() })
        : { compactedBatches: 0 };
      state.lastCompactedProductStageBatches = Number(stageCompaction?.compactedBatches) || 0;
      const archive = archiveService?.runCycleBatched
        ? await archiveService.runCycleBatched()
        : archiveService?.runCycle
          ? await archiveService.runCycle()
        : { ok: true, archivedRecords: 0, deletedHotRows: 0, expiredArchives: 0 };
      if (!archive?.ok) throw new Error(archive?.code || 'AUTOMATIC_MAINTENANCE_ARCHIVE_FAILED');
      state.lastArchivedRecords = Number(archive.archivedRecords) || 0;
      state.lastExpiredArchives = Number(archive.expiredArchives) || 0;
      recordArchiveCapacity(archive);
      const preview = retentionService.inspect();
      if (!preview?.ok) throw new Error('AUTOMATIC_MAINTENANCE_SCHEMA_DRIFT');
      state.lastCandidateRows = Number(preview.maximumCandidateRows) || 0;
      const startedJob = retentionRunner.start({
        confirmation: TECHNICAL_RETENTION_CONFIRMATION,
        previewFingerprint: preview.previewFingerprint,
        // The automatic plan is restricted to backup=excluded/rebuildable
        // runtime domains and is explicitly enabled by desktop policy.
        backupAcknowledged: true,
      });
      if (!startedJob?.ok) throw new Error(startedJob?.code || 'AUTOMATIC_MAINTENANCE_RETENTION_START_FAILED');

      const waitStartedAt = started.getTime();
      let job = retentionRunner.getStatus();
      while (job?.active) {
        if (now().getTime() - waitStartedAt > policy.retentionWaitTimeoutMs) {
          throw new Error('AUTOMATIC_MAINTENANCE_RETENTION_TIMEOUT');
        }
        await sleep(100);
        job = retentionRunner.getStatus();
      }
      if (!job?.ok || job?.status === 'failed') {
        throw new Error(job?.code || 'AUTOMATIC_MAINTENANCE_RETENTION_FAILED');
      }

      state.lastDeletedRows = (Number(archive.deletedHotRows) || 0) + (Number(job?.processedRows) || 0);
      const reclaimed = reclaimIncrementally();
      state.lastReclaimedBytes = reclaimed.reclaimedBytes;
      state.lastFinishedAt = now().toISOString();
      state.status = 'completed';
      return publicState(state);
    })().catch((error) => {
      state.status = 'failed';
      if (state.archiveCapacityCheckStatus === 'checking') state.archiveCapacityCheckStatus = 'failed';
      state.code = String(error?.message || error || 'AUTOMATIC_MAINTENANCE_FAILED');
      state.lastFinishedAt = iso(now());
      logger.error?.('[local-api][maintenance] automatic cleanup failed', { code: state.code });
      return publicState(state);
    }).finally(() => {
      running = null;
    });
    return running;
  }

  function start() {
    if (!state.enabled || startupTimer || intervalTimer) return publicState(state);
    state.nextCheckAt = iso(now().getTime() + policy.startupDelayMs);
    startupTimer = setTimeoutImpl(() => {
      startupTimer = null;
      void execute();
    }, policy.startupDelayMs);
    startupTimer.unref?.();
    intervalTimer = setIntervalImpl(() => {
      state.nextCheckAt = iso(now().getTime() + policy.checkIntervalMs);
      void execute();
    }, policy.checkIntervalMs);
    intervalTimer.unref?.();
    return publicState(state);
  }

  function stop() {
    if (startupTimer) clearTimeoutImpl(startupTimer);
    if (deferredTimer) clearTimeoutImpl(deferredTimer);
    if (intervalTimer) clearIntervalImpl(intervalTimer);
    startupTimer = null;
    deferredTimer = null;
    intervalTimer = null;
    state.nextCheckAt = null;
  }

  return Object.freeze({ start, stop, runOnce: execute, getStatus: () => publicState(state) });
}

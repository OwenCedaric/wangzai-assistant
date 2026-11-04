import { randomUUID } from 'node:crypto';
import {
  TECHNICAL_RETENTION_BATCH_ROWS,
  TECHNICAL_RETENTION_CONFIRMATION,
} from './technicalRetentionPreview.js';

function totalDeleted(deleted = []) {
  return deleted.reduce((total, item) => total + (Number(item?.rows) || 0), 0);
}

function mergeDeleted(existing = [], next = []) {
  const totals = new Map(existing.map((item) => [item.table, Number(item.rows) || 0]));
  next.forEach((item) => totals.set(item.table, (totals.get(item.table) || 0) + (Number(item.rows) || 0)));
  return [...totals.entries()].map(([table, rows]) => ({ table, rows }));
}

function publicJob(job) {
  if (!job) return { ok: true, mode: 'idle', active: false };
  return {
    ok: job.status !== 'failed',
    mode: 'background-retention',
    id: job.id,
    active: job.status === 'queued' || job.status === 'running',
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    totalCandidateRows: job.totalCandidateRows,
    processedRows: totalDeleted(job.deleted),
    remainingCandidateRows: job.remainingCandidateRows,
    batchesCompleted: job.batchesCompleted,
    deleted: job.deleted,
    ...(job.code ? { code: job.code } : {}),
  };
}

/**
 * Executes only confirmed technical-retention batches. Each batch commits before
 * yielding to the event loop, so a large runtime-log cleanup never monopolises
 * the local API for the full history-delete duration.
 */
export function createTechnicalRetentionRunner({
  service,
  batchRows = TECHNICAL_RETENTION_BATCH_ROWS,
  schedule = (callback) => setTimeout(callback, 50),
} = {}) {
  if (!service?.inspect || !service?.applyConfirmed) {
    throw new Error('createTechnicalRetentionRunner requires a retention service');
  }

  let job = null;

  function applyBatch() {
    return service.applyConfirmed({
      confirmation: TECHNICAL_RETENTION_CONFIRMATION,
      previewFingerprint: job.previewFingerprint,
      backupAcknowledged: true,
      maxDeleteRows: batchRows,
    });
  }

  function scheduleNext() {
    schedule(() => {
      if (!job || job.status !== 'queued') return;
      job.status = 'running';
      let result;
      try {
        result = applyBatch();
        if (result?.code === 'TECHNICAL_RETENTION_PREVIEW_STALE'
          && result.preview?.ok !== false && result.preview?.previewFingerprint
          && Number(result.preview.maximumCandidateRows) > 0) {
          // A fresh log arriving between every scheduled slice must not starve
          // this already-confirmed runtime-only job. Retry the service's exact
          // fresh fingerprint once in this turn; the service still validates it
          // under its transaction. Further contention yields to the next slice.
          job.previewFingerprint = result.preview.previewFingerprint;
          job.remainingCandidateRows = result.preview.maximumCandidateRows;
          result = applyBatch();
        }
      } catch (error) {
        job.status = 'failed';
        const code = String(error?.code || '');
        job.code = /^[A-Z][A-Z0-9_]{0,119}$/u.test(code) ? code : 'TECHNICAL_RETENTION_BACKGROUND_FAILED';
        job.finishedAt = new Date().toISOString();
        return;
      }

      if (!result?.ok) {
        // A newly generated runtime row can make the prior batch fingerprint
        // stale. The user has already confirmed this runtime-only cleanup, so
        // continue from the fresh preview rather than freezing the job.
        if (result?.code === 'TECHNICAL_RETENTION_PREVIEW_STALE' && result?.preview?.previewFingerprint) {
          job.previewFingerprint = result.preview.previewFingerprint;
          job.remainingCandidateRows = result.preview.maximumCandidateRows;
          if (Number(job.remainingCandidateRows) === 0) {
            job.status = 'completed';
            job.finishedAt = new Date().toISOString();
            return;
          }
          job.status = 'queued';
          scheduleNext();
          return;
        }
        job.status = 'failed';
        job.code = result?.code || 'TECHNICAL_RETENTION_BACKGROUND_FAILED';
        job.finishedAt = new Date().toISOString();
        return;
      }

      job.deleted = mergeDeleted(job.deleted, result.deleted);
      job.batchesCompleted += 1;
      job.remainingCandidateRows = Number(result.remainingCandidateRows) || 0;
      job.previewFingerprint = result.preview?.previewFingerprint || job.previewFingerprint;
      if (result.complete) {
        job.status = 'completed';
        job.finishedAt = new Date().toISOString();
        return;
      }
      job.status = 'queued';
      scheduleNext();
    });
  }

  function start({ confirmation, previewFingerprint, backupAcknowledged } = {}) {
    if (job?.status === 'queued' || job?.status === 'running') {
      return { ok: false, code: 'TECHNICAL_RETENTION_ALREADY_RUNNING', job: publicJob(job) };
    }
    if (confirmation !== TECHNICAL_RETENTION_CONFIRMATION || backupAcknowledged !== true) {
      return { ok: false, code: 'TECHNICAL_RETENTION_CONFIRMATION_REQUIRED' };
    }
    const preview = service.inspect();
    if (!preview.ok) return { ok: false, code: 'TECHNICAL_RETENTION_SCHEMA_DRIFT', preview };
    if (String(previewFingerprint || '') !== preview.previewFingerprint) {
      return { ok: false, code: 'TECHNICAL_RETENTION_PREVIEW_STALE', preview };
    }
    job = {
      id: `retention-${randomUUID()}`,
      status: 'queued',
      startedAt: new Date().toISOString(),
      totalCandidateRows: preview.maximumCandidateRows,
      remainingCandidateRows: preview.maximumCandidateRows,
      previewFingerprint: preview.previewFingerprint,
      batchesCompleted: 0,
      deleted: [],
    };
    if (!preview.maximumCandidateRows) {
      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      return publicJob(job);
    }
    scheduleNext();
    return publicJob(job);
  }

  return Object.freeze({ start, getStatus: () => publicJob(job) });
}

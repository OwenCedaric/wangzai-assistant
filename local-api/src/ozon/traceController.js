import { randomUUID } from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function tableExists(db, tableName) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
  } catch (_error) {
    return false;
  }
}

function nullableInteger(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.floor(numberValue) : null;
}

function nullableText(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function normalizeStatus(value) {
  return nullableText(value) || 'info';
}

function toPublicTrace(row) {
  return {
    id: row.id,
    jobId: row.job_id || null,
    requestId: row.request_id || null,
    attemptId: row.attempt_id || null,
    snapshotId: row.snapshot_id || null,
    domain: row.domain || null,
    shopId: row.shop_id || null,
    endpointKey: row.endpoint_key || null,
    batchIndex: row.batch_index,
    batchTotal: row.batch_total,
    priority: row.priority || null,
    source: row.source || null,
    phase: row.phase,
    status: row.status,
    queueWaitMs: row.queue_wait_ms,
    permitWaitMs: row.permit_wait_ms,
    requestDurationMs: row.request_duration_ms,
    mergeDurationMs: row.merge_duration_ms,
    retryCount: row.retry_count,
    retryAfterMs: row.retry_after_ms,
    statusCode: row.status_code,
    ozonCode: row.ozon_code || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
  };
}

export function createTraceController(db, {
  archiveReader = null,
  flushBatchSize = 200,
  flushIntervalMs = 25,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const enabled = Boolean(db) && tableExists(db, 'ozon_scheduler_trace_events');
  const batchSize = Math.max(1, Math.min(Number(flushBatchSize) || 200, 2_000));
  const intervalMs = Math.max(1, Math.min(Number(flushIntervalMs) || 25, 1_000));
  const pending = [];
  let flushTimer = null;
  let droppedEvents = 0;

  let insertStatement = null;
  function getInsertStatement() {
    if (!enabled) return null;
    if (!insertStatement) {
      insertStatement = db.prepare(`
      INSERT INTO ozon_scheduler_trace_events (
        id, job_id, request_id, attempt_id, snapshot_id, domain, shop_id,
        endpoint_key, batch_index, batch_total, priority, source, phase, status,
        queue_wait_ms, permit_wait_ms, request_duration_ms, merge_duration_ms,
        retry_count, retry_after_ms, status_code, ozon_code, error_message,
        source_file, source_function, source_line, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    return insertStatement;
  }
  const insertBatch = enabled
    ? (events) => {
        const ownsTransaction = db.isTransaction !== true;
        if (ownsTransaction) db.exec('BEGIN');
        try {
          const statement = getInsertStatement();
          for (const event of events) statement.run(...event.values);
          if (ownsTransaction) db.exec('COMMIT');
        } catch (error) {
          if (ownsTransaction) {
            try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
          }
          throw error;
        }
      }
    : null;

  function cancelFlushTimer() {
    if (!flushTimer) return;
    clearTimeoutImpl(flushTimer);
    flushTimer = null;
  }

  function flush() {
    if (!enabled || !pending.length) return { written: 0, dropped: droppedEvents };
    cancelFlushTimer();
    const events = pending.splice(0, pending.length);
    try {
      insertBatch(events);
      return { written: events.length, dropped: droppedEvents };
    } catch (_error) {
      // Scheduler telemetry is diagnostic-only. A trace write failure must not
      // block the Ozon request, and failed rows must not stay in memory forever.
      droppedEvents += events.length;
      return { written: 0, dropped: droppedEvents };
    }
  }

  function scheduleFlush() {
    if (flushTimer || !enabled) return;
    flushTimer = setTimeoutImpl(() => {
      flushTimer = null;
      flush();
    }, intervalMs);
    flushTimer?.unref?.();
  }

  function record(event = {}) {
    if (!enabled) return null;
    const id = event.id || `trace_${randomUUID()}`;
    pending.push({
      id,
      values: [
        id,
        nullableText(event.jobId),
        nullableText(event.requestId),
        nullableText(event.attemptId),
        nullableText(event.snapshotId),
        nullableText(event.domain),
        nullableText(event.shopId),
        nullableText(event.endpointKey),
        nullableInteger(event.batchIndex),
        nullableInteger(event.batchTotal),
        nullableText(event.priority),
        nullableText(event.source),
        nullableText(event.phase) || 'event',
        normalizeStatus(event.status),
        nullableInteger(event.queueWaitMs),
        nullableInteger(event.permitWaitMs),
        nullableInteger(event.requestDurationMs),
        nullableInteger(event.mergeDurationMs),
        nullableInteger(event.retryCount),
        nullableInteger(event.retryAfterMs),
        nullableInteger(event.statusCode),
        nullableText(event.ozonCode),
        nullableText(event.errorMessage),
        nullableText(event.sourceFile),
        nullableText(event.sourceFunction),
        nullableInteger(event.sourceLine),
        event.createdAt || nowIso(),
      ],
    });
    if (pending.length >= batchSize) flush();
    else scheduleFlush();
    return id;
  }

  function listByJob(jobId, options = {}) {
    if (!enabled || !jobId) return [];
    // Preserve read-after-record semantics for diagnostics while ordinary
    // request traffic keeps using batched transactions.
    flush();
    const limit = Math.min(Number(options.limit) || 500, 2000);
    let rows = db.prepare(`
      SELECT *
      FROM ozon_scheduler_trace_events
      WHERE job_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(jobId, limit);
    // Active/recent jobs stay on the SQLite hot path. A diagnostic lookup for
    // an older job falls back to the encrypted day archive only when the hot
    // table has no rows, so normal scheduler latency is unchanged.
    if (!rows.length && archiveReader?.listTraceEventsByJob) {
      rows = archiveReader.listTraceEventsByJob(jobId, { limit });
    }
    return rows.map(toPublicTrace);
  }

  function getLastForJob(jobId) {
    const rows = listByJob(jobId, { limit: 500 });
    return rows.at(-1) || null;
  }

  return {
    enabled,
    record,
    flush,
    listByJob,
    getLastForJob,
    getStatus() {
      return {
        enabled,
        bufferedEvents: pending.length,
        droppedEvents,
        flushBatchSize: batchSize,
        flushIntervalMs: intervalMs,
      };
    },
    close() {
      cancelFlushTimer();
      return flush();
    },
  };
}

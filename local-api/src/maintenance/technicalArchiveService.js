import { createTechnicalArchiveStore } from './technicalArchiveStore.js';

export const TECHNICAL_ARCHIVE_POLICY = Object.freeze({
  // Product stage batches carry full normalized response JSON and can grow by
  // several gigabytes per day. Keep one complete hot day in SQLite; older
  // runtime evidence is still zstd-compressed, encrypted and read back before
  // its hot rows are removed.
  hotRetentionDays: 1,
  totalRetentionDays: 7,
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  traceRowsPerPackage: 10_000,
  tracePackagesPerCycle: 20,
  // Normal operation currently creates roughly 30-40 terminal product runs an
  // hour. A 100-run slice catches up after busy periods without monopolising
  // SQLite during active business refreshes.
  productRunsPerCycle: 100,
});

const DAY_MS = 86_400_000;
const PRODUCT_TERMINAL_STATUSES = Object.freeze([
  'completed',
  'completed_with_source_gaps',
  'partial',
  'failed',
  'interrupted',
  'invalid',
  'canceled',
]);

function startOfUtcDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('TECHNICAL_ARCHIVE_NOW_INVALID');
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBefore(reference, days) {
  return new Date(startOfUtcDay(reference).getTime() - days * DAY_MS).toISOString();
}

function addDays(value, days) {
  return new Date(new Date(value).getTime() + days * DAY_MS).toISOString();
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.present);
}

function archiveRecords(rows, keyForRow) {
  return rows.map((row) => ({ key: keyForRow(row), value: { ...row } }));
}

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction was already closed */ }
    throw error;
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createTechnicalArchiveService({
  db,
  archiveDirectory,
  store: providedStore,
  enabled = true,
  now = () => new Date(),
  policy: policyOverrides = {},
  logger = console,
} = {}) {
  if (!db) throw new Error('createTechnicalArchiveService requires db.');
  const policy = Object.freeze({ ...TECHNICAL_ARCHIVE_POLICY, ...policyOverrides });
  const active = enabled === true && Boolean(providedStore || String(archiveDirectory || '').trim());
  const store = active
    ? (providedStore || createTechnicalArchiveStore({ archiveDirectory, logger }))
    : null;
  const hasProductTables = ['product_sync_runs', 'product_sync_stage_batches', 'product_sync_page_proofs']
    .every((table) => tableExists(db, table));
  const hasTraceTable = tableExists(db, 'ozon_scheduler_trace_events');

  function retentionWindow() {
    const reference = now();
    return {
      reference,
      hotCutoff: daysBefore(reference, policy.hotRetentionDays),
      totalCutoff: daysBefore(reference, policy.totalRetentionDays),
    };
  }

  function findProductRun(window) {
    if (!hasProductTables) return null;
    const statusPlaceholders = PRODUCT_TERMINAL_STATUSES.map(() => '?').join(', ');
    return db.prepare(`
      SELECT *
      FROM product_sync_runs AS run
      WHERE run.finished_at >= ?
        AND run.finished_at < ?
        AND run.status IN (${statusPlaceholders})
        AND (
          EXISTS (SELECT 1 FROM product_sync_stage_batches AS stage WHERE stage.run_id = run.id)
          OR EXISTS (SELECT 1 FROM product_sync_page_proofs AS proof WHERE proof.run_id = run.id)
        )
      ORDER BY run.finished_at ASC, run.id ASC
      LIMIT 1
    `).get(window.totalCutoff, window.hotCutoff, ...PRODUCT_TERMINAL_STATUSES) || null;
  }

  function archiveOneProductRun(window) {
    const run = findProductRun(window);
    if (!run) return null;
    const stages = db.prepare(`
      SELECT * FROM product_sync_stage_batches
      WHERE run_id = ?
      ORDER BY stage_kind ASC, batch_index ASC, batch_key ASC
    `).all(run.id);
    const proofs = db.prepare(`
      SELECT * FROM product_sync_page_proofs
      WHERE run_id = ?
      ORDER BY visibility ASC, page_index ASC
    `).all(run.id);
    if (!stages.length && !proofs.length) return null;
    const records = [
      { key: `run-summary:${run.id}`, value: { ...run } },
      ...archiveRecords(stages, (row) => `stage:${row.run_id}:${row.batch_key}`),
      ...archiveRecords(proofs, (row) => `proof:${row.run_id}:${row.visibility}:${row.page_index}`),
    ];
    const sourceAt = new Date(run.finished_at).toISOString();
    const published = store.publish({
      archiveType: 'product-sync-runtime',
      sourceFrom: sourceAt,
      sourceTo: sourceAt,
      expiresAt: addDays(sourceAt, policy.totalRetentionDays),
      records,
    });

    const deletedRows = transaction(db, () => {
      const deleteStage = db.prepare('DELETE FROM product_sync_stage_batches WHERE run_id = ? AND batch_key = ?');
      const deleteProof = db.prepare(`
        DELETE FROM product_sync_page_proofs
        WHERE run_id = ? AND visibility = ? AND page_index = ?
      `);
      let deleted = 0;
      for (const row of stages) deleted += Number(deleteStage.run(row.run_id, row.batch_key).changes) || 0;
      for (const row of proofs) deleted += Number(deleteProof.run(row.run_id, row.visibility, row.page_index).changes) || 0;
      if (deleted !== stages.length + proofs.length) throw new Error('TECHNICAL_ARCHIVE_PRODUCT_DELETE_MISMATCH');
      return deleted;
    });
    return {
      archiveId: published.archiveId,
      archiveCreated: published.created,
      archivedRecords: records.length,
      deletedRows,
      sourceFrom: sourceAt,
      sourceTo: sourceAt,
    };
  }

  function findTraceBatch(window) {
    if (!hasTraceTable) return [];
    const oldest = db.prepare(`
      SELECT created_at
      FROM ozon_scheduler_trace_events
      WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(window.totalCutoff, window.hotCutoff);
    if (!oldest?.created_at) return [];
    const bucketStart = startOfUtcDay(oldest.created_at).toISOString();
    const bucketEnd = new Date(Math.min(
      new Date(bucketStart).getTime() + DAY_MS,
      new Date(window.hotCutoff).getTime(),
    )).toISOString();
    return db.prepare(`
      SELECT *
      FROM ozon_scheduler_trace_events
      WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(bucketStart, bucketEnd, Math.max(1, Number(policy.traceRowsPerPackage) || 10_000));
  }

  function archiveOneTraceBatch(window) {
    const rows = findTraceBatch(window);
    if (!rows.length) return null;
    const sourceFrom = new Date(rows[0].created_at).toISOString();
    const sourceTo = new Date(rows.at(-1).created_at).toISOString();
    const records = archiveRecords(rows, (row) => `trace:${row.id}`);
    const published = store.publish({
      archiveType: 'scheduler-trace',
      sourceFrom,
      sourceTo,
      expiresAt: addDays(sourceTo, policy.totalRetentionDays),
      records,
    });
    const deletedRows = transaction(db, () => {
      const statement = db.prepare('DELETE FROM ozon_scheduler_trace_events WHERE id = ?');
      let deleted = 0;
      for (const row of rows) deleted += Number(statement.run(row.id).changes) || 0;
      if (deleted !== rows.length) throw new Error('TECHNICAL_ARCHIVE_TRACE_DELETE_MISMATCH');
      return deleted;
    });
    return {
      archiveId: published.archiveId,
      archiveCreated: published.created,
      archivedRecords: records.length,
      deletedRows,
      sourceFrom,
      sourceTo,
    };
  }

  function runCycle() {
    if (!active) return { ok: true, enabled: false, archivedRecords: 0, deletedHotRows: 0, expiredArchives: 0 };
    const window = retentionWindow();
    const pruned = store.pruneExpired(window.reference, {
      maxSourceAgeDays: policy.totalRetentionDays,
      maxTotalBytes: policy.maxArchiveBytes,
    });
    const productPackages = [];
    const tracePackages = [];
    for (let index = 0; index < Math.max(0, Number(policy.productRunsPerCycle) || 0); index += 1) {
      const archived = archiveOneProductRun(window);
      if (!archived) break;
      productPackages.push(archived);
    }
    for (let index = 0; index < Math.max(0, Number(policy.tracePackagesPerCycle) || 0); index += 1) {
      const archived = archiveOneTraceBatch(window);
      if (!archived) break;
      tracePackages.push(archived);
    }
    return finishCycle({ window, pruned, productPackages, tracePackages });
  }

  function finishCycle({ window, pruned, productPackages, tracePackages }) {
    // The initial sweep cannot account for packages published during this
    // cycle. Enforce the same authenticated archive retention policy after all
    // publications have completed readback and their SQLite deletions committed.
    // Active .tmp files and recovery packages remain outside the store policy.
    if (!productPackages.length && !tracePackages.length) {
      return buildCycleResult({ pruned, productPackages, tracePackages });
    }
    const current = store.pruneExpired(window.reference, {
      maxSourceAgeDays: policy.totalRetentionDays,
      maxTotalBytes: policy.maxArchiveBytes,
    });
    const errors = new Map([...(pruned.errors || []), ...(current.errors || [])]
      .map(error => [JSON.stringify([error.filePath, error.code]), error]));
    return buildCycleResult({
      pruned: { ...current, deleted: [...pruned.deleted, ...current.deleted], errors: [...errors.values()] },
      productPackages,
      tracePackages,
    });
  }

  function buildCycleResult({ pruned, productPackages, tracePackages }) {
    const packages = [...productPackages, ...tracePackages];
    return {
      ok: true,
      enabled: true,
      hotRetentionDays: policy.hotRetentionDays,
      totalRetentionDays: policy.totalRetentionDays,
      archivedPackages: packages.length,
      archivedRecords: packages.reduce((total, item) => total + item.archivedRecords, 0),
      deletedHotRows: packages.reduce((total, item) => total + item.deletedRows, 0),
      expiredArchives: pruned.deleted.length,
      expiredBytes: pruned.deleted.reduce((total, item) => total + item.bytes, 0),
      invalidArchives: pruned.errors.length,
      archiveBytes: pruned.remainingBytes ?? null,
      archiveByteLimit: pruned.maximumBytes ?? policy.maxArchiveBytes,
      archiveCapacitySatisfied: pruned.capacitySatisfied ?? true,
      productPackages,
      tracePackages,
    };
  }

  async function runCycleBatched({
    yieldEveryPackages = 1,
    yieldImpl = yieldToEventLoop,
  } = {}) {
    if (!active) return { ok: true, enabled: false, archivedRecords: 0, deletedHotRows: 0, expiredArchives: 0 };
    const window = retentionWindow();
    const pruned = store.pruneExpired(window.reference, {
      maxSourceAgeDays: policy.totalRetentionDays,
      maxTotalBytes: policy.maxArchiveBytes,
    });
    const productPackages = [];
    const tracePackages = [];
    const yieldEvery = Math.max(1, Number(yieldEveryPackages) || 1);
    let completedSinceYield = 0;
    const maybeYield = async () => {
      completedSinceYield += 1;
      if (completedSinceYield < yieldEvery) return;
      completedSinceYield = 0;
      await yieldImpl();
    };
    for (let index = 0; index < Math.max(0, Number(policy.productRunsPerCycle) || 0); index += 1) {
      const archived = archiveOneProductRun(window);
      if (!archived) break;
      productPackages.push(archived);
      await maybeYield();
    }
    for (let index = 0; index < Math.max(0, Number(policy.tracePackagesPerCycle) || 0); index += 1) {
      const archived = archiveOneTraceBatch(window);
      if (!archived) break;
      tracePackages.push(archived);
      await maybeYield();
    }
    return finishCycle({ window, pruned, productPackages, tracePackages });
  }

  function listTraceEventsByJob(jobId, { limit = 500 } = {}) {
    const normalizedJobId = String(jobId || '').trim();
    if (!active || !normalizedJobId) return [];
    return store.findRecords({
      archiveType: 'scheduler-trace',
      limit,
      predicate: (value) => String(value?.job_id || '') === normalizedJobId,
    }).sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  }

  function inspect() {
    if (!active) return { enabled: false, directory: null, packages: [], errors: [] };
    const result = store.inspectDirectory();
    return {
      enabled: true,
      directory: store.directory,
      packages: result.packages.map((item) => ({ ...item.metadata, bytes: item.bytes })),
      errors: result.errors,
    };
  }

  return Object.freeze({ enabled: active, runCycle, runCycleBatched, listTraceEventsByJob, inspect });
}

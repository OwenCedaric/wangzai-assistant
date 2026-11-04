import { createHash } from 'node:crypto';

export const DEFAULT_TECHNICAL_RETENTION_POLICIES = Object.freeze([
  // Days 2-7 of the large stage/proof payloads are moved to encrypted local
  // archives before this final seven-day parent cleanup can cascade them.
  {
    table: 'product_sync_runs',
    timestamp: 'finished_at',
    maxAgeDays: 7,
    maxRows: Number.MAX_SAFE_INTEGER,
    batchRows: 10,
    terminalStatuses: [
      'completed',
      'completed_with_source_gaps',
      'partial',
      'failed',
      'interrupted',
      'invalid',
      'canceled',
    ],
  },
  { table: 'ozon_scheduler_trace_events', timestamp: 'created_at', maxAgeDays: 7, maxRows: 150_000 },
  { table: 'ozon_request_attempts', timestamp: 'created_at', maxAgeDays: 7, maxRows: 150_000 },
  { table: 'ozon_sync_snapshots', timestamp: 'finished_at', maxAgeDays: 7, maxRows: 50_000 },
  // Child runtime rows are retained before their request-job parent. Keep the
  // parent batch deliberately small: deleting a job can cascade only the few
  // still-linked child rows without making one maintenance slice unbounded.
  {
    table: 'ozon_request_jobs',
    timestamp: 'created_at',
    maxAgeDays: 7,
    maxRows: 100_000,
    batchRows: 1_000,
    terminalStatuses: ['success', 'partial', 'failed', 'canceled', 'blocked'],
  },
  { table: 'ozon_cache_merge_log', timestamp: 'created_at', maxAgeDays: 7, maxRows: 100_000 },
  { table: 'ozon_sync_locks', timestamp: 'released_at', maxAgeDays: 7, maxRows: 20_000 },
]);

export const TECHNICAL_RETENTION_CONFIRMATION = 'APPLY_TECHNICAL_RETENTION';
export const TECHNICAL_RETENTION_BATCH_ROWS = 20_000;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function startOfUtcDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('TECHNICAL_RETENTION_NOW_INVALID');
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDaysAgo(now, days) {
  return new Date(startOfUtcDay(now).getTime() - days * 86_400_000).toISOString();
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((row) => row.name));
}

function hasTable(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName)?.present);
}

function timestampPresentCondition(timestamp) {
  const quoted = quoteIdentifier(timestamp);
  return `${quoted} IS NOT NULL AND TRIM(CAST(${quoted} AS TEXT)) <> ''`;
}

function terminalStatusCondition(policy = {}) {
  const statuses = Array.isArray(policy.terminalStatuses)
    ? [...new Set(policy.terminalStatuses.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  if (!statuses.length) return '';
  if (statuses.some((status) => !/^[a-z_]+$/u.test(status))) {
    throw new Error(`TECHNICAL_RETENTION_TERMINAL_STATUS_INVALID:${policy.table || 'unknown'}`);
  }
  return ` AND "status" IN (${statuses.map((status) => `'${status}'`).join(', ')})`;
}

function candidateRowIdSql(policy) {
  const table = quoteIdentifier(policy.table);
  const timestamp = quoteIdentifier(policy.timestamp);
  const present = timestampPresentCondition(policy.timestamp);
  const terminal = terminalStatusCondition(policy);
  return `
    SELECT row_id FROM (
      SELECT rowid AS row_id FROM ${table}
      WHERE ${present}${terminal} AND ${timestamp} < ?
      UNION
      SELECT rowid AS row_id FROM (
        SELECT rowid FROM ${table}
        WHERE ${present}${terminal}
        ORDER BY ${timestamp} ASC, rowid ASC
        LIMIT ?
      )
    )
    ORDER BY row_id ASC
  `;
}

function candidateCount(db, policy, cutoff, eligibleByRowLimit) {
  const rows = db.prepare(`SELECT COUNT(*) AS count FROM (${candidateRowIdSql(policy)})`)
    .get(cutoff, eligibleByRowLimit);
  return Number(rows?.count) || 0;
}

function candidateDigest(db, policy, cutoff, eligibleByRowLimit) {
  const table = quoteIdentifier(policy.table);
  const timestamp = quoteIdentifier(policy.timestamp);
  const digest = createHash('sha256');
  const statement = db.prepare(`
    SELECT rowid AS row_id, CAST(${timestamp} AS TEXT) AS timestamp_value
    FROM ${table}
    WHERE rowid IN (${candidateRowIdSql(policy)})
    ORDER BY rowid ASC
  `);
  for (const row of statement.iterate(cutoff, eligibleByRowLimit)) {
    digest.update(`${row.row_id}:${String(row.timestamp_value).length}:${row.timestamp_value}\n`);
  }
  return digest.digest('base64url');
}

function normalizeBatchRows(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return TECHNICAL_RETENTION_BATCH_ROWS;
  return Math.min(parsed, TECHNICAL_RETENTION_BATCH_ROWS);
}

function plannedBatchDeleteRows(tables, policiesByTable, batchRows) {
  let remaining = batchRows;
  let planned = 0;
  for (const table of tables) {
    if (remaining <= 0) break;
    const policy = policiesByTable.get(table.table);
    const policyLimit = Math.min(
      remaining,
      normalizeBatchRows(policy?.batchRows || remaining),
    );
    const rows = Math.min(table.candidateRows, policyLimit);
    planned += rows;
    remaining -= rows;
  }
  return planned;
}

function deletePolicyCandidates(db, policy, previewTable, batchRows) {
  const table = quoteIdentifier(policy.table);
  const timestamp = quoteIdentifier(policy.timestamp);
  const present = timestampPresentCondition(policy.timestamp);
  const terminal = terminalStatusCondition(policy);

  // Do not materialize the potentially very large union of rowids again for
  // deletion. Remove expired rows first, then trim the remaining dated rows to
  // the configured cap. The two phases are equivalent to the preview union,
  // while letting SQLite use the retention time index for both write paths.
  let remainingBudget = Math.min(batchRows, previewTable.candidateRows);
  const expired = remainingBudget > 0
    ? db.prepare(`
      DELETE FROM ${table}
      WHERE rowid IN (
        SELECT rowid FROM ${table}
        WHERE ${present}${terminal} AND ${timestamp} < ?
        ORDER BY ${timestamp} ASC, rowid ASC
        LIMIT ?
      )
    `).run(previewTable.ageCutoff, remainingBudget)
    : { changes: 0 };
  remainingBudget -= Number(expired?.changes) || 0;

  const remainingDated = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${table}
    WHERE ${present}${terminal}
  `).get()?.count) || 0;
  const rowsToTrim = Math.min(Math.max(0, remainingDated - policy.maxRows), remainingBudget);
  const trimmed = rowsToTrim > 0
    ? db.prepare(`
      DELETE FROM ${table}
      WHERE rowid IN (
        SELECT rowid FROM ${table}
        WHERE ${present}${terminal}
        ORDER BY ${timestamp} ASC, rowid ASC
        LIMIT ?
      )
    `).run(rowsToTrim)
    : { changes: 0 };

  const changes = (Number(expired?.changes) || 0) + (Number(trimmed?.changes) || 0);
  const expectedChanges = Math.min(batchRows, previewTable.candidateRows);
  if (changes !== expectedChanges) {
    throw new Error(`TECHNICAL_RETENTION_ROW_COUNT_MISMATCH:${policy.table}`);
  }
  return changes;
}

function inspectPolicy(db, policy, referenceNow) {
  if (!hasTable(db, policy.table)) {
    return { table: policy.table, schemaStatus: 'missing-table', totalRows: 0, candidateRows: 0 };
  }
  const columns = tableColumns(db, policy.table);
  if (!columns.has(policy.timestamp)) {
    return { table: policy.table, schemaStatus: 'missing-timestamp', totalRows: 0, candidateRows: 0 };
  }
  if (Array.isArray(policy.terminalStatuses) && policy.terminalStatuses.length && !columns.has('status')) {
    return { table: policy.table, schemaStatus: 'missing-status', totalRows: 0, candidateRows: 0 };
  }
  const table = quoteIdentifier(policy.table);
  const timestamp = quoteIdentifier(policy.timestamp);
  const present = timestampPresentCondition(policy.timestamp);
  const terminal = terminalStatusCondition(policy);
  const totalRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count) || 0;
  const datedRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${present}${terminal}`).get()?.count) || 0;
  const cutoff = isoDaysAgo(referenceNow, policy.maxAgeDays);
  const byAge = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${table}
    WHERE ${present}${terminal} AND ${timestamp} < ?
  `).get(cutoff)?.count) || 0;
  // Undated rows may be live locks/runs. They never satisfy age or row-limit cleanup.
  const byRowLimit = Math.max(0, datedRows - policy.maxRows);
  const candidateRows = candidateCount(db, policy, cutoff, byRowLimit);
  const result = {
    table: policy.table,
    schemaStatus: 'ready',
    totalRows,
    datedRows,
    maxAgeDays: policy.maxAgeDays,
    maxRows: policy.maxRows,
    ageCutoff: cutoff,
    eligibleByAge: byAge,
    eligibleByRowLimit: byRowLimit,
    // Kept as a compatibility alias; this now means exact union candidates, not a loose upper bound.
    maximumCandidateRows: candidateRows,
    candidateRows,
  };
  // The digest is deliberately not serialized in the user-facing preview. It makes the
  // confirmation fingerprint sensitive to a replacement candidate with the same count.
  Object.defineProperty(result, 'candidateDigest', {
    value: candidateDigest(db, policy, cutoff, byRowLimit),
    enumerable: false,
  });
  return result;
}

function retentionPlanFingerprint(plan) {
  const material = {
    version: 1,
    tables: plan.tables.map((table) => ({
      table: table.table,
      schemaStatus: table.schemaStatus,
      totalRows: table.totalRows,
      datedRows: table.datedRows,
      ageCutoff: table.ageCutoff,
      candidateRows: table.candidateRows,
      candidateDigest: table.candidateDigest,
    })).sort((left, right) => left.table.localeCompare(right.table)),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('base64url');
}

function createPlan(db, policies, now) {
  const referenceNow = startOfUtcDay(now());
  const tables = policies.map((policy) => inspectPolicy(db, policy, referenceNow));
  const schemaIssues = tables
    .filter((table) => table.schemaStatus !== 'ready')
    .map(({ table, schemaStatus }) => ({ table, schemaStatus }));
  const plan = {
    ok: schemaIssues.length === 0,
    mode: 'read-only-preview',
    generatedAt: referenceNow.toISOString(),
    tables,
    schemaIssues,
    maximumCandidateRows: tables.reduce((total, table) => total + (table.candidateRows || 0), 0),
    automaticDeletionAllowed: false,
    requiredConfirmation: true,
    requiredBeforeCleanup: [
      '生成可恢复保护副本',
      '人工确认技术保留预览',
      '清理后执行 SQLite 完整性和容量验证',
    ],
  };
  return { ...plan, previewFingerprint: retentionPlanFingerprint(plan) };
}

/**
 * Runtime-only retention maintenance. It is deliberately separate from business data,
 * Ozon synchronization and backup export. No cleanup runs unless the exact preview is confirmed.
 */
export function createTechnicalRetentionPreviewService(db, { now = () => new Date(), policies = DEFAULT_TECHNICAL_RETENTION_POLICIES } = {}) {
  if (!db) throw new Error('createTechnicalRetentionPreviewService requires db.');

  function inspect() {
    return createPlan(db, policies, now);
  }

  function applyConfirmed({ confirmation, previewFingerprint, backupAcknowledged, maxDeleteRows } = {}) {
    if (confirmation !== TECHNICAL_RETENTION_CONFIRMATION || backupAcknowledged !== true) {
      return { ok: false, code: 'TECHNICAL_RETENTION_CONFIRMATION_REQUIRED', preview: inspect() };
    }

    let preview = null;
    const deleted = [];
    try {
      // Lock before building the fresh plan so fingerprint validation and deletion observe one state.
      db.exec('BEGIN IMMEDIATE');
      preview = inspect();
      if (!preview.ok) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'TECHNICAL_RETENTION_SCHEMA_DRIFT', preview };
      }
      if (String(previewFingerprint || '') !== preview.previewFingerprint) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'TECHNICAL_RETENTION_PREVIEW_STALE', preview };
      }
      const policiesByTable = new Map(policies.map((policy) => [policy.table, policy]));
      const executable = preview.tables.filter((table) => table.candidateRows > 0);
      if (!executable.length) {
        db.exec('COMMIT');
        return { ok: true, mode: 'confirmed-noop', complete: true, remainingCandidateRows: 0,
          batchRows: 0, previewFingerprint: preview.previewFingerprint, deleted, preview };
      }
      const batchRows = normalizeBatchRows(maxDeleteRows);
      const expectedRows = plannedBatchDeleteRows(executable, policiesByTable, batchRows);
      let remainingBudget = batchRows;
      for (const table of executable) {
        if (remainingBudget <= 0) break;
        const policy = policiesByTable.get(table.table);
        const policyBatchRows = Math.min(
          remainingBudget,
          normalizeBatchRows(policy?.batchRows || remainingBudget),
        );
        const changes = deletePolicyCandidates(db, policy, table, policyBatchRows);
        deleted.push({ table: table.table, rows: changes });
        remainingBudget -= changes;
      }
      const readback = createPlan(db, policies, now);
      const deletedRows = deleted.reduce((total, item) => total + item.rows, 0);
      if (!readback.ok || deletedRows !== expectedRows || readback.maximumCandidateRows >= preview.maximumCandidateRows) {
        throw new Error('TECHNICAL_RETENTION_READBACK_FAILED');
      }
      db.exec('COMMIT');
      return {
        ok: true,
        mode: readback.maximumCandidateRows === 0 ? 'confirmed-transaction' : 'confirmed-batch',
        previewFingerprint: preview.previewFingerprint,
        batchRows: deletedRows,
        complete: readback.maximumCandidateRows === 0,
        remainingCandidateRows: readback.maximumCandidateRows,
        deleted,
        preview: readback,
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
      return {
        ok: false,
        code: 'TECHNICAL_RETENTION_TRANSACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        ...(preview ? { preview } : {}),
      };
    }
  }

  return { inspect, applyConfirmed };
}

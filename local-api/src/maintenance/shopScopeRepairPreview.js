import { createHash } from 'node:crypto';
import { DATA_DOMAIN_REGISTRY } from '../data/dataDomainRegistry.js';

const USER_OWNED_CLASSES = new Set(['fact', 'config', 'secret']);
export const SHOP_SCOPE_REPAIR_CONFIRMATION = 'APPLY_SHOP_SCOPE_REPAIR';
export const SHOP_SCOPE_MANUAL_RESOLUTION_CONFIRMATION = 'APPLY_MANUAL_SHOP_SCOPE_RESOLUTION';
const MANUAL_RESOLUTION_PAGE_LIMIT = 100;

/** Every physical shop-scoped table must be classified from the one data-domain registry. */
export const SHOP_SCOPE_REPAIR_POLICIES = Object.freeze(
  DATA_DOMAIN_REGISTRY.filter(
    (policy) => policy.scopeType === 'shop' && !String(policy.canonicalTable).includes(':'),
  ),
);

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizedPolicy(value, table) {
  return value || {
    domain: String(table || '').trim() || 'unknown',
    dataClass: 'fact',
    source: 'user',
    backup: 'required',
  };
}

function scopeClass(policy) {
  if (policy.source === 'user' && USER_OWNED_CLASSES.has(policy.dataClass)) return 'user-owned';
  if (policy.dataClass === 'runtime' || policy.source === 'system') return 'system-runtime';
  return 'rehydratable';
}

function repairAction({ policy, emptyRows, shopIds, schemaStatus }) {
  if (schemaStatus !== 'ready') return { action: 'schema-repair-required', suggestedShopId: null };
  if (!emptyRows) return { action: 'none', suggestedShopId: null };
  const classification = scopeClass(policy);
  if (classification === 'system-runtime') {
    return { action: 'purge-runtime-after-confirmation', suggestedShopId: null };
  }
  if (classification === 'rehydratable') {
    return { action: 'rehydrate-from-source-after-confirmation', suggestedShopId: null };
  }
  if (shopIds.length === 1) {
    return { action: 'assign-after-confirmation', suggestedShopId: shopIds[0] };
  }
  return { action: 'isolate-for-manual-resolution', suggestedShopId: null };
}

function existingTableNames(db) {
  return new Set(
    db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => row.name),
  );
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((column) => column.name));
}

function emptyShopWhere() {
  return `(shop_id IS NULL OR TRIM(CAST(shop_id AS TEXT)) = '')`;
}

function emptyShopRowCount(db, table) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}
    WHERE ${emptyShopWhere()}
  `).get()?.count) || 0;
}

function appendFingerprintValue(hash, value) {
  if (value === null || value === undefined) {
    hash.update('null\n');
    return;
  }
  const normalized = String(value);
  hash.update(`${normalized.length}:${normalized}\n`);
}

function emptyShopCandidateDigest(db, table, policy) {
  const identityColumns = policy.primaryKey.map((column, index) => (
    `CAST(${quoteIdentifier(column)} AS TEXT) AS identity_${index}`
  ));
  const statement = db.prepare(`
    SELECT rowid AS row_id, ${identityColumns.join(', ')}
    FROM ${quoteIdentifier(table)}
    WHERE ${emptyShopWhere()}
    ORDER BY rowid ASC
  `);
  const hash = createHash('sha256');
  for (const row of statement.iterate()) {
    appendFingerprintValue(hash, row.row_id);
    for (const [index] of policy.primaryKey.entries()) appendFingerprintValue(hash, row[`identity_${index}`]);
  }
  return hash.digest('base64url');
}

function inspectPolicyTable(db, tableNames, policy) {
  const table = policy.canonicalTable;
  if (!tableNames.has(table)) {
    return { table, policy, emptyRows: 0, schemaStatus: 'missing-table' };
  }
  const columns = tableColumns(db, table);
  if (!columns.has('shop_id')) {
    return { table, policy, emptyRows: 0, schemaStatus: 'missing-shop-id' };
  }
  const missingIdentityColumn = policy.primaryKey.find((column) => !columns.has(column));
  if (missingIdentityColumn) {
    return { table, policy, emptyRows: 0, schemaStatus: `missing-primary-key:${missingIdentityColumn}` };
  }
  const emptyRows = emptyShopRowCount(db, table);
  return {
    table,
    policy,
    emptyRows,
    candidateDigest: emptyShopCandidateDigest(db, table, policy),
    schemaStatus: 'ready',
  };
}

function repairPlanFingerprint(plan) {
  const material = {
    version: 1,
    shopIds: [...plan.shopIds].sort(),
    registeredShopTables: plan.registeredShopTables,
    tables: plan.tables
      .map((table) => ({
        table: table.table,
        schemaStatus: table.schemaStatus,
        scopeClass: table.scopeClass,
        action: table.action,
        suggestedShopId: table.suggestedShopId,
        emptyRows: table.emptyRows,
        candidateDigest: table.candidateDigest,
      }))
      .sort((left, right) => left.table.localeCompare(right.table)),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('base64url');
}

function repairableAction(table) {
  if (table.action === 'assign-after-confirmation') return 'assign-shop';
  if (table.action === 'purge-runtime-after-confirmation') return 'purge-runtime';
  return null;
}

function listScopeShops(db) {
  return db.prepare(`
    SELECT id, name, alias, status
    FROM shops
    WHERE TRIM(COALESCE(id, '')) <> ''
    ORDER BY id ASC
  `).all().map((shop) => ({
    id: String(shop.id),
    name: String(shop.name || ''),
    alias: String(shop.alias || ''),
    status: String(shop.status || 'inactive'),
  }));
}

function manualResolutionTables(scopePreview) {
  return scopePreview.tables.filter((table) => (
    table.scopeClass === 'user-owned' && table.action === 'isolate-for-manual-resolution'
  ));
}

function policyByTable(tableName) {
  return SHOP_SCOPE_REPAIR_POLICIES.find((policy) => policy.canonicalTable === tableName) || null;
}

function identityColumns(policy) {
  return policy.primaryKey.map((column, index) => ({ column, alias: `identity_${index}` }));
}

function candidateId(table, policy, row) {
  const hash = createHash('sha256');
  hash.update(`shop-scope-manual-candidate:v1:${table}:`);
  appendFingerprintValue(hash, row.row_id);
  for (const { alias } of identityColumns(policy)) appendFingerprintValue(hash, row[alias]);
  return hash.digest('base64url');
}

function readManualCandidates(db, tableEntries, limit) {
  const candidates = [];
  for (const entry of tableEntries) {
    if (candidates.length >= limit) break;
    const policy = policyByTable(entry.table);
    if (!policy) continue;
    const columns = identityColumns(policy);
    const statement = db.prepare(`
      SELECT rowid AS row_id, ${columns.map(({ column, alias }) => (
        `CAST(${quoteIdentifier(column)} AS TEXT) AS ${quoteIdentifier(alias)}`
      )).join(', ')}
      FROM ${quoteIdentifier(entry.table)}
      WHERE ${emptyShopWhere()}
      ORDER BY rowid ASC
      LIMIT ?
    `);
    const remaining = limit - candidates.length;
    for (const row of statement.iterate(remaining)) {
      const candidate = {
        id: candidateId(entry.table, policy, row),
        table: entry.table,
        domain: entry.domain,
        identity: columns
          .filter(({ column }) => column !== 'shop_id')
          .map(({ column, alias }) => ({ column, value: row[alias] === null ? null : String(row[alias]) })),
      };
      Object.defineProperty(candidate, 'rowId', { value: row.row_id, enumerable: false });
      candidates.push(candidate);
    }
  }
  return candidates;
}

function manualResolutionFingerprint({ shops, tables, schemaIssues }) {
  const material = {
    version: 1,
    shops: shops.map((shop) => shop.id).sort(),
    tables: tables.map((table) => ({
      table: table.table,
      emptyRows: table.emptyRows,
      candidateDigest: table.candidateDigest,
    })).sort((left, right) => left.table.localeCompare(right.table)),
    schemaIssues,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('base64url');
}

function normalizeManualAssignments(assignments) {
  if (!Array.isArray(assignments)) return [];
  return assignments.map((assignment) => ({
    candidateId: String(assignment?.candidateId || assignment?.candidate_id || '').trim(),
    targetShopId: String(assignment?.targetShopId || assignment?.target_shop_id || '').trim(),
  })).filter((assignment) => assignment.candidateId && assignment.targetShopId);
}

/**
 * Read-only classification. It never guesses the owner of Ozon/cache/runtime rows:
 * only user-owned data in a single-shop profile can be proposed for assignment.
 */
export function createShopScopeRepairPlan({ shopIds = [], tableCounts = [] }) {
  const normalizedShopIds = [...new Set(shopIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const tables = tableCounts.map((item) => {
    const policy = normalizedPolicy(item.policy, item.table);
    const emptyRows = Number(item.emptyRows) || 0;
    const schemaStatus = item.schemaStatus || 'ready';
    const repair = repairAction({ policy, emptyRows, shopIds: normalizedShopIds, schemaStatus });
    const table = {
      table: item.table,
      domain: policy.domain,
      dataClass: policy.dataClass,
      source: policy.source,
      backup: policy.backup,
      scopeClass: scopeClass(policy),
      emptyRows,
      schemaStatus,
      ...repair,
    };
    // Candidate identity is hashed into the preview fingerprint, never returned to the renderer.
    Object.defineProperty(table, 'candidateDigest', {
      value: String(item.candidateDigest || ''),
      enumerable: false,
    });
    return table;
  });
  const schemaIssues = tables
    .filter((table) => table.schemaStatus !== 'ready')
    .map(({ table, schemaStatus }) => ({ table, schemaStatus }));
  const plan = {
    ok: schemaIssues.length === 0,
    mode: 'read-only-preview',
    shopCount: normalizedShopIds.length,
    shopIds: normalizedShopIds,
    registeredShopTables: tables.length,
    tables,
    schemaIssues,
    totalEmptyRows: tables.reduce((total, table) => total + table.emptyRows, 0),
    automaticWriteAllowed: false,
    requiredConfirmation: true,
  };
  return { ...plan, previewFingerprint: repairPlanFingerprint(plan) };
}

export function createShopScopeRepairPreviewService(db) {
  if (!db) throw new Error('createShopScopeRepairPreviewService requires db.');

  function inspect() {
    const shopIds = listScopeShops(db).map((shop) => shop.id);
    const tableNames = existingTableNames(db);
    const tableCounts = SHOP_SCOPE_REPAIR_POLICIES.map((policy) =>
      inspectPolicyTable(db, tableNames, policy),
    );
    return createShopScopeRepairPlan({ shopIds, tableCounts });
  }

  function inspectManualResolution() {
    const scopePreview = inspect();
    const shops = listScopeShops(db);
    const tables = manualResolutionTables(scopePreview);
    const schemaIssues = scopePreview.tables
      .filter((table) => table.scopeClass === 'user-owned' && table.schemaStatus !== 'ready')
      .map(({ table, schemaStatus }) => ({ table, schemaStatus }));
    const totalCandidates = tables.reduce((total, table) => total + table.emptyRows, 0);
    const candidates = readManualCandidates(db, tables, MANUAL_RESOLUTION_PAGE_LIMIT);
    const plan = {
      ok: schemaIssues.length === 0,
      mode: 'read-only-manual-resolution-preview',
      shopCount: shops.length,
      shops,
      tables: tables.map(({ table, domain, emptyRows }) => ({ table, domain, emptyRows })),
      schemaIssues,
      totalCandidates,
      candidates,
      pageLimit: MANUAL_RESOLUTION_PAGE_LIMIT,
      truncated: totalCandidates > candidates.length,
      automaticWriteAllowed: false,
      requiredConfirmation: true,
    };
    return {
      ...plan,
      previewFingerprint: manualResolutionFingerprint({ shops, tables, schemaIssues }),
    };
  }

  /**
   * The only write path for safe scope repair. A caller must confirm the exact
   * read-only preview; a changed row count/schema invalidates that confirmation.
   */
  function applyConfirmed({ confirmation, previewFingerprint } = {}) {
    if (confirmation !== SHOP_SCOPE_REPAIR_CONFIRMATION) {
      return {
        ok: false,
        code: 'SHOP_SCOPE_REPAIR_CONFIRMATION_REQUIRED',
        preview: inspect(),
      };
    }

    let preview = null;
    const applied = [];
    try {
      // The lock starts before the fresh inspection: a matching preview and its write set
      // must be observed from the same SQLite state.
      db.exec('BEGIN IMMEDIATE');
      preview = inspect();
      if (!preview.ok) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'SHOP_SCOPE_REPAIR_SCHEMA_DRIFT', preview };
      }
      if (String(previewFingerprint || '') !== preview.previewFingerprint) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'SHOP_SCOPE_REPAIR_PREVIEW_STALE', preview };
      }
      const executable = preview.tables
        .map((table) => ({ table, operation: repairableAction(table) }))
        .filter((entry) => entry.operation && entry.table.emptyRows > 0);
      const deferred = preview.tables
        .filter((table) => table.emptyRows > 0 && !repairableAction(table))
        .map((table) => ({ table: table.table, action: table.action, emptyRows: table.emptyRows }));
      if (!executable.length) {
        db.exec('COMMIT');
        return {
          ok: true,
          mode: 'confirmed-noop',
          previewFingerprint: preview.previewFingerprint,
          applied,
          deferred,
          preview,
        };
      }
      for (const { table, operation } of executable) {
        const quotedTable = quoteIdentifier(table.table);
        const result = operation === 'assign-shop'
          ? db.prepare(`UPDATE ${quotedTable} SET shop_id = ? WHERE ${emptyShopWhere()}`).run(table.suggestedShopId)
          : db.prepare(`DELETE FROM ${quotedTable} WHERE ${emptyShopWhere()}`).run();
        const changed = Number(result?.changes) || 0;
        if (changed !== table.emptyRows) {
          throw new Error(`SHOP_SCOPE_REPAIR_ROW_COUNT_MISMATCH:${table.table}`);
        }
        if (emptyShopRowCount(db, table.table) !== 0) {
          throw new Error(`SHOP_SCOPE_REPAIR_READBACK_FAILED:${table.table}`);
        }
        applied.push({
          table: table.table,
          action: table.action,
          operation,
          shopId: operation === 'assign-shop' ? table.suggestedShopId : null,
          changed,
        });
      }
      const after = inspect();
      db.exec('COMMIT');
      return {
        ok: true,
        mode: 'confirmed-transaction',
        previewFingerprint: preview.previewFingerprint,
        applied,
        deferred,
        preview: after,
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
      return {
        ok: false,
        code: 'SHOP_SCOPE_REPAIR_TRANSACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        ...(preview ? { preview } : {}),
      };
    }
  }

  function applyManualResolution({ confirmation, previewFingerprint, assignments } = {}) {
    if (confirmation !== SHOP_SCOPE_MANUAL_RESOLUTION_CONFIRMATION) {
      return {
        ok: false,
        code: 'SHOP_SCOPE_MANUAL_RESOLUTION_CONFIRMATION_REQUIRED',
        preview: inspectManualResolution(),
      };
    }

    let preview = null;
    try {
      db.exec('BEGIN IMMEDIATE');
      preview = inspectManualResolution();
      if (!preview.ok) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'SHOP_SCOPE_MANUAL_RESOLUTION_SCHEMA_DRIFT', preview };
      }
      if (String(previewFingerprint || '') !== preview.previewFingerprint) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'SHOP_SCOPE_MANUAL_RESOLUTION_PREVIEW_STALE', preview };
      }
      const normalizedAssignments = normalizeManualAssignments(assignments);
      if (!normalizedAssignments.length) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'SHOP_SCOPE_MANUAL_RESOLUTION_ASSIGNMENTS_REQUIRED', preview };
      }
      const uniqueCandidateIds = new Set(normalizedAssignments.map((assignment) => assignment.candidateId));
      if (uniqueCandidateIds.size !== normalizedAssignments.length) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'SHOP_SCOPE_MANUAL_RESOLUTION_DUPLICATE_ASSIGNMENT', preview };
      }
      const candidatesById = new Map(preview.candidates.map((candidate) => [candidate.id, candidate]));
      const shopIds = new Set(preview.shops.map((shop) => shop.id));
      for (const assignment of normalizedAssignments) {
        if (!candidatesById.has(assignment.candidateId)) {
          db.exec('ROLLBACK');
          return { ok: false, code: 'SHOP_SCOPE_MANUAL_RESOLUTION_CANDIDATE_INVALID', preview };
        }
        if (!shopIds.has(assignment.targetShopId)) {
          db.exec('ROLLBACK');
          return { ok: false, code: 'SHOP_SCOPE_MANUAL_RESOLUTION_TARGET_INVALID', preview };
        }
      }

      const applied = [];
      for (const assignment of normalizedAssignments) {
        const candidate = candidatesById.get(assignment.candidateId);
        const result = db.prepare(`
          UPDATE ${quoteIdentifier(candidate.table)}
          SET shop_id = ?
          WHERE rowid = ? AND ${emptyShopWhere()}
        `).run(assignment.targetShopId, candidate.rowId);
        if ((Number(result?.changes) || 0) !== 1) {
          throw new Error(`SHOP_SCOPE_MANUAL_RESOLUTION_ROW_MISMATCH:${candidate.table}`);
        }
        const readback = db.prepare(`
          SELECT shop_id FROM ${quoteIdentifier(candidate.table)} WHERE rowid = ?
        `).get(candidate.rowId);
        if (readback?.shop_id !== assignment.targetShopId) {
          throw new Error(`SHOP_SCOPE_MANUAL_RESOLUTION_READBACK_FAILED:${candidate.table}`);
        }
        applied.push({
          candidateId: candidate.id,
          table: candidate.table,
          targetShopId: assignment.targetShopId,
        });
      }
      const after = inspectManualResolution();
      db.exec('COMMIT');
      return {
        ok: true,
        mode: 'confirmed-manual-resolution-transaction',
        previewFingerprint: preview.previewFingerprint,
        applied,
        preview: after,
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
      return {
        ok: false,
        code: 'SHOP_SCOPE_MANUAL_RESOLUTION_TRANSACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        ...(preview ? { preview } : {}),
      };
    }
  }

  return { inspect, applyConfirmed, inspectManualResolution, applyManualResolution };
}

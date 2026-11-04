import {
  DATA_DOMAIN_REGISTRY,
  getStorageTableClassificationForPolicy,
} from '../data/dataDomainRegistry.js';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableNames(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => String(row.name));
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((column) => String(column.name)));
}

function countEmptyShopRows(db, tableName) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}
    WHERE shop_id IS NULL OR TRIM(CAST(shop_id AS TEXT)) = ''
  `).get()?.count) || 0;
}

function countDuplicateKeyGroups(db, tableName, primaryKey) {
  const columns = primaryKey.map(quoteIdentifier).join(', ');
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM ${quoteIdentifier(tableName)}
      GROUP BY ${columns}
      HAVING COUNT(*) > 1
    )
  `).get()?.count) || 0;
}

function integrityAudit(db) {
  const messages = db.prepare('PRAGMA integrity_check')
    .all()
    .map((row) => String(row.integrity_check ?? Object.values(row)[0] ?? ''));
  const failures = messages.filter((message) => message.toLowerCase() !== 'ok');
  return { ok: failures.length === 0, messages: failures };
}

function foreignKeyAudit(db) {
  const rows = db.prepare('PRAGMA foreign_key_check').all();
  return {
    ok: rows.length === 0,
    violations: rows.length,
    tables: [...new Set(rows.map((row) => String(row.table || 'unknown')))].sort(),
  };
}

function policyAudit(db, policy, existingTables) {
  const table = policy.canonicalTable;
  const classification = getStorageTableClassificationForPolicy(policy);
  if (!existingTables.has(table)) {
    return {
      table,
      ...classification,
      present: false,
      primaryKey: [...policy.primaryKey],
      missingPrimaryKeyColumns: [],
      duplicateKeyGroups: 0,
      keyCheck: 'not-present',
      emptyShopRows: 0,
    };
  }

  const columns = tableColumns(db, table);
  const missingPrimaryKeyColumns = policy.primaryKey.filter((column) => !columns.has(column));
  const canCheckKey = missingPrimaryKeyColumns.length === 0
    && classification.lifecycle === 'preserve';
  const duplicateKeyGroups = canCheckKey ? countDuplicateKeyGroups(db, table, policy.primaryKey) : 0;
  const emptyShopRows = classification.ownerScope === 'shop' && columns.has('shop_id')
    ? countEmptyShopRows(db, table)
    : 0;

  return {
    table,
    ...classification,
    present: true,
    primaryKey: [...policy.primaryKey],
    missingPrimaryKeyColumns,
    duplicateKeyGroups,
    keyCheck: missingPrimaryKeyColumns.length ? 'schema-drift' : canCheckKey ? 'checked' : 'not-required',
    emptyShopRows,
  };
}

/**
 * Explicit, read-only migration preflight. It verifies database integrity and the
 * registered preserve domains without returning any row values or issuing Ozon work.
 */
export function createDataConsistencyAuditService(db, { registry = DATA_DOMAIN_REGISTRY } = {}) {
  if (!db) throw new Error('createDataConsistencyAuditService requires db.');

  return {
    inspect() {
      const physicalTables = tableNames(db);
      const existingTables = new Set(physicalTables);
      const policyByTable = new Map(registry.map((policy) => [policy.canonicalTable, policy]));
      const domains = registry
        .map((policy) => policyAudit(db, policy, existingTables))
        .filter((domain) => domain.present)
        .sort((left, right) => left.table.localeCompare(right.table));
      const unclassifiedTables = physicalTables.filter((table) => !policyByTable.has(table));
      const integrity = integrityAudit(db);
      const foreignKeys = foreignKeyAudit(db);
      const schemaDriftTables = domains
        .filter((domain) => domain.missingPrimaryKeyColumns.length > 0)
        .map((domain) => domain.table);
      const duplicateKeyGroups = domains.reduce((total, domain) => total + domain.duplicateKeyGroups, 0);
      const emptyShopRows = domains.reduce((total, domain) => total + domain.emptyShopRows, 0);
      const structuralOk = integrity.ok
        && foreignKeys.ok
        && unclassifiedTables.length === 0
        && schemaDriftTables.length === 0
        && duplicateKeyGroups === 0;

      return {
        ok: true,
        mode: 'read-only-data-consistency-audit',
        structuralOk,
        readyForMigration: structuralOk && emptyShopRows === 0,
        integrity,
        foreignKeys,
        registry: {
          physicalTables: physicalTables.length,
          registeredTables: domains.length,
          unclassifiedTables,
          schemaDriftTables,
        },
        keys: {
          checkedTables: domains.filter((domain) => domain.keyCheck === 'checked').length,
          duplicateKeyGroups,
        },
        scopes: {
          emptyShopRows,
          requiresExplicitResolution: emptyShopRows > 0,
        },
        domains,
        actions: {
          automaticRepairAllowed: false,
          automaticOzonRequestAllowed: false,
          requiredBeforeMigration: [
            '处理结构错误、外键错误或重复业务键',
            '通过预览和人工确认处理空店铺作用域',
            '创建可恢复保护副本后再执行任何写入迁移',
          ],
        },
      };
    },
  };
}

import {
  classifyStorageTable,
  getStorageTableClassification,
} from '../data/dataDomainRegistry.js';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function categoryFor(tableName) {
  return classifyStorageTable(tableName);
}

function tableNames(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function hasShopId(db, tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .some((column) => column.name === 'shop_id');
}

function tableAudit(db, tableName) {
  const rows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get()?.count) || 0;
  const scoped = hasShopId(db, tableName);
  const emptyShopId = scoped
    ? Number(db.prepare(`
      SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}
      WHERE shop_id IS NULL OR TRIM(CAST(shop_id AS TEXT)) = ''
    `).get()?.count) || 0
    : 0;
  return {
    name: tableName,
    category: categoryFor(tableName),
    ...getStorageTableClassification(tableName),
    rows,
    hasShopId: scoped,
    emptyShopId,
  };
}

function summarizeTables(tables, key) {
  return Object.fromEntries(
    [...new Set(tables.map((table) => table[key]))]
      .sort()
      .map((value) => {
        const items = tables.filter((table) => table[key] === value);
        return [value, {
          tables: items.length,
          rows: items.reduce((total, table) => total + table.rows, 0),
          emptyShopId: items.reduce((total, table) => total + table.emptyShopId, 0),
        }];
      }),
  );
}

export function createStorageAuditService(db) {
  if (!db) throw new Error('createStorageAuditService requires db.');

  return {
    inspect() {
      const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size) || 0;
      const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count) || 0;
      const freePages = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count) || 0;
      const tables = tableNames(db).map((tableName) => tableAudit(db, tableName));
      const categories = summarizeTables(tables, 'category');
      return {
        ok: true,
        mode: 'read-only',
        sqlite: {
          pageSize,
          pageCount,
          logicalBytes: pageSize * pageCount,
          freePages,
          freeBytes: pageSize * freePages,
        },
        categories,
        classificationSummary: {
          registeredTables: tables.filter((table) => table.registered).length,
          unclassifiedTables: tables.filter((table) => !table.registered).length,
          // ownerScope answers where data belongs; lifecycle says whether it must survive a backup.
          byOwnerScope: summarizeTables(tables, 'ownerScope'),
          byLifecycle: summarizeTables(tables, 'lifecycle'),
          byBackup: summarizeTables(tables, 'backup'),
        },
        tables,
        actions: {
          automaticDeletionAllowed: false,
          requiredBeforeCompaction: [
            '生成可恢复保护副本',
            '按保留策略生成删除预览',
            '人工确认后才执行清理',
            '单独预览并确认本机 SQLite 物理压缩（WAL checkpoint 后执行 VACUUM）',
          ],
        },
      };
    },
  };
}

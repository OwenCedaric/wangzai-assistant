import { isDeepStrictEqual } from 'node:util';

export const SHOP_OPERATIONAL_TABLES = Object.freeze([
  'ozon_finance_transactions',
  'ozon_returns',
  'ozon_rating_penalties',
  'ozon_finance_statement_reports',
  'ozon_finance_balance_snapshots',
]);

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function requiredShopId(value) {
  const shopId = normalizeText(value);
  if (!shopId) {
    const error = new Error('SHOP_OPERATIONAL_STORAGE_SHOP_ID_REQUIRED');
    error.code = 'SHOP_OPERATIONAL_STORAGE_SHOP_ID_REQUIRED';
    throw error;
  }
  return shopId;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function columnsFor(db, tableName, scopeColumn = 'shop_id') {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((column) => ({
    name: String(column.name),
    type: normalizeText(column.type) || 'BLOB',
    notNull: Number(column.notnull) === 1,
    defaultValue: column.dflt_value === undefined ? null : column.dflt_value,
    primaryKey: Number(column.pk) || 0,
  }));
  if (!columns.length || !columns.some((column) => column.name === scopeColumn)) {
    const error = new Error('SHOP_OPERATIONAL_STORAGE_SCHEMA_INVALID');
    error.code = 'SHOP_OPERATIONAL_STORAGE_SCHEMA_INVALID';
    error.tableName = tableName;
    throw error;
  }
  return columns;
}

function descriptorFor(db, tableName, scopeColumn = 'shop_id') {
  const columns = columnsFor(db, tableName, scopeColumn);
  const primaryKey = columns.filter((column) => column.primaryKey > 0)
    .sort((left, right) => left.primaryKey - right.primaryKey)
    .map((column) => column.name);
  if (!primaryKey.length) {
    const error = new Error('SHOP_OPERATIONAL_STORAGE_PRIMARY_KEY_REQUIRED');
    error.code = 'SHOP_OPERATIONAL_STORAGE_PRIMARY_KEY_REQUIRED';
    error.tableName = tableName;
    throw error;
  }
  const indexes = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
    ORDER BY name ASC
  `).all(tableName).map((row) => normalizeText(row.sql)).filter(Boolean);
  const uniqueIndexes = db.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all()
    .filter((index) => Number(index.unique) === 1 && normalizeText(index.origin) === 'u')
    .map((index) => db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all()
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((column) => normalizeText(column.name))
      .filter(Boolean))
    .filter((items) => items.length > 0);
  return Object.freeze({ tableName, scopeColumn, columns, primaryKey, indexes, uniqueIndexes });
}

function createTableSql(descriptor) {
  const definitions = descriptor.columns.map((column) => {
    const defaultValue = normalizeText(column.defaultValue);
    const defaultSql = !defaultValue
      ? ''
      : /^(?:[-+]?\d+(?:\.\d+)?|NULL|CURRENT_(?:TIME|DATE|TIMESTAMP)|'(?:[^']|'')*')$/iu.test(defaultValue)
        ? ` DEFAULT ${defaultValue}`
        : ` DEFAULT (${defaultValue})`;
    return `${quoteIdentifier(column.name)} ${column.type}${column.notNull ? ' NOT NULL' : ''}${defaultSql}`;
  });
  definitions.push(`PRIMARY KEY (${descriptor.primaryKey.map(quoteIdentifier).join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(descriptor.tableName)} (${definitions.join(', ')});`;
}

function readRows(db, descriptor, shopId) {
  const columns = descriptor.columns.map((column) => quoteIdentifier(column.name)).join(', ');
  return db.prepare(`
    SELECT ${columns} FROM ${quoteIdentifier(descriptor.tableName)}
    WHERE ${quoteIdentifier(descriptor.scopeColumn)} = ?
    ORDER BY ${descriptor.primaryKey.map(quoteIdentifier).join(', ')}
  `).all(shopId);
}

export function createShopOperationalStorage({
  canonicalDb,
  shopDatabaseRouter,
  directWriteAllShops = false,
} = {}) {
  if (!canonicalDb?.prepare) throw new Error('SHOP_OPERATIONAL_STORAGE_CANONICAL_REQUIRED');
  if (!shopDatabaseRouter?.open) throw new Error('SHOP_OPERATIONAL_STORAGE_ROUTER_REQUIRED');
  const descriptors = [
    descriptorFor(canonicalDb, 'shops', 'id'),
    ...SHOP_OPERATIONAL_TABLES.map((tableName) => descriptorFor(canonicalDb, tableName)),
  ];
  const counters = { migratedShops: 0, migratedRows: 0, verifiedRows: 0, directWrites: 0, failures: 0, lastShopId: '', lastErrorCode: '' };

  function isDirectWriteShop(shopId) {
    return Boolean(normalizeText(shopId) && directWriteAllShops === true);
  }

  function ensureSchema(session) {
    for (const descriptor of descriptors) {
      session.db.exec(createTableSql(descriptor));
      for (const indexSql of descriptor.indexes) {
        const sql = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+/iu.test(indexSql)
          ? indexSql
          : indexSql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/iu, (_match, unique = '') => `CREATE ${unique || ''}INDEX IF NOT EXISTS `);
        session.db.exec(`${sql};`);
      }
      descriptor.uniqueIndexes.forEach((columns, index) => session.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`uq_shop_operational_${descriptor.tableName}_${index + 1}`)}
        ON ${quoteIdentifier(descriptor.tableName)} (${columns.map(quoteIdentifier).join(', ')});
      `));
    }
    session.db.exec(`
      CREATE TABLE IF NOT EXISTS shop_operational_storage_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        shop_incarnation TEXT NOT NULL,
        status TEXT NOT NULL,
        write_mode TEXT NOT NULL,
        source_total INTEGER NOT NULL DEFAULT 0,
        target_total INTEGER NOT NULL DEFAULT 0,
        direct_write_revision INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        last_error_code TEXT
      );
    `);
    session.db.prepare(`
      INSERT INTO shop_operational_storage_state (
        singleton, shop_incarnation, status, write_mode, updated_at
      ) VALUES (1, ?, 'pending', 'migration', ?)
      ON CONFLICT(singleton) DO NOTHING
    `).run(session.route.shopIncarnation, new Date().toISOString());
    const state = session.db.prepare(`
      SELECT shop_incarnation FROM shop_operational_storage_state WHERE singleton = 1
    `).get();
    if (state?.shop_incarnation !== session.route.shopIncarnation) {
      const error = new Error('SHOP_OPERATIONAL_STORAGE_SCOPE_MISMATCH');
      error.code = 'SHOP_OPERATIONAL_STORAGE_SCOPE_MISMATCH';
      throw error;
    }
  }

  function initializeDirectShop(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (!isDirectWriteShop(shopId)) return Object.freeze({ ok: true, shopId, initialized: false, reason: 'direct_write_not_enabled' });
    const session = shopDatabaseRouter.open(shopId, { expectedScopeToken: input.expectedScopeToken });
    ensureSchema(session);
    const current = session.db.prepare(`SELECT status, write_mode FROM shop_operational_storage_state WHERE singleton = 1`).get();
    if (current?.status === 'completed' && current?.write_mode === 'direct') {
      return Object.freeze({ ok: true, shopId, initialized: false, ready: true, reason: 'direct_write_ready' });
    }
    const sourceRows = new Map(descriptors.map((descriptor) => [descriptor.tableName, readRows(canonicalDb, descriptor, shopId)]));
    const sourceTotal = [...sourceRows.values()].reduce((total, rows) => total + rows.length, 0);
    session.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const descriptor of descriptors) {
        session.db.prepare(`DELETE FROM ${quoteIdentifier(descriptor.tableName)}`).run();
        const columns = descriptor.columns.map((column) => column.name);
        const insert = session.db.prepare(`
          INSERT INTO ${quoteIdentifier(descriptor.tableName)} (${columns.map(quoteIdentifier).join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})
        `);
        for (const row of sourceRows.get(descriptor.tableName)) insert.run(...columns.map((column) => row[column]));
        const targetRows = readRows(session.db, descriptor, shopId);
        if (!isDeepStrictEqual(sourceRows.get(descriptor.tableName), targetRows)) {
          const error = new Error('SHOP_OPERATIONAL_STORAGE_COPY_MISMATCH');
          error.code = 'SHOP_OPERATIONAL_STORAGE_COPY_MISMATCH';
          error.tableName = descriptor.tableName;
          throw error;
        }
      }
      const timestamp = new Date().toISOString();
      session.db.prepare(`
        UPDATE shop_operational_storage_state
        SET status = 'completed', write_mode = 'direct', source_total = ?, target_total = ?,
            direct_write_revision = 0, completed_at = ?, updated_at = ?, last_error_code = NULL
        WHERE singleton = 1
      `).run(sourceTotal, sourceTotal, timestamp, timestamp);
      session.db.exec('COMMIT;');
      counters.migratedShops += 1;
      counters.migratedRows += sourceTotal;
      counters.verifiedRows += sourceTotal;
      counters.lastShopId = shopId;
      return Object.freeze({ ok: true, shopId, initialized: true, ready: true, migratedRows: sourceTotal });
    } catch (error) {
      try { session.db.exec('ROLLBACK;'); } catch { /* original error wins */ }
      counters.failures += 1;
      counters.lastShopId = shopId;
      counters.lastErrorCode = normalizeText(error?.code || error?.message) || 'SHOP_OPERATIONAL_STORAGE_FAILED';
      throw error;
    }
  }

  function resolveDirectWriteSession(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (!isDirectWriteShop(shopId)) {
      const error = new Error('SHOP_OPERATIONAL_DIRECT_WRITE_NOT_ENABLED');
      error.code = 'SHOP_OPERATIONAL_DIRECT_WRITE_NOT_ENABLED';
      throw error;
    }
    let session;
    try {
      session = shopDatabaseRouter.open(shopId, { expectedScopeToken: input.expectedScopeToken, createIfMissing: false });
      ensureSchema(session);
    } catch (cause) {
      const error = new Error('SHOP_OPERATIONAL_DIRECT_WRITE_NOT_READY');
      error.code = 'SHOP_OPERATIONAL_DIRECT_WRITE_NOT_READY';
      error.cause = cause;
      throw error;
    }
    const state = session.db.prepare(`
      SELECT status, write_mode, direct_write_revision, last_error_code
      FROM shop_operational_storage_state WHERE singleton = 1
    `).get();
    if (state?.status !== 'completed' || state?.write_mode !== 'direct' || state?.last_error_code) {
      const error = new Error('SHOP_OPERATIONAL_DIRECT_WRITE_NOT_READY');
      error.code = 'SHOP_OPERATIONAL_DIRECT_WRITE_NOT_READY';
      throw error;
    }
    return Object.freeze({ db: session.db, route: session.route, shopId, state });
  }

  function recordDirectWrite(input = {}) {
    const session = resolveDirectWriteSession(input);
    session.db.prepare(`
      UPDATE shop_operational_storage_state
      SET direct_write_revision = direct_write_revision + 1, updated_at = ?, last_error_code = NULL
      WHERE singleton = 1 AND write_mode = 'direct'
    `).run(new Date().toISOString());
    counters.directWrites += 1;
    return Object.freeze({ ok: true, shopId: session.shopId });
  }

  function snapshot() {
    return Object.freeze({
      mode: 'per-shop-operational-direct-write',
      directWriteAllShops: directWriteAllShops === true,
      tables: SHOP_OPERATIONAL_TABLES,
      ...counters,
    });
  }

  return Object.freeze({ initializeDirectShop, resolveDirectWriteSession, recordDirectWrite, isDirectWriteShop, snapshot });
}

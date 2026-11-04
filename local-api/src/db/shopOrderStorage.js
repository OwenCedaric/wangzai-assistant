import { isDeepStrictEqual } from 'node:util';
import { createShopOrderAuxiliaryStorage } from './shopOrderAuxiliaryStorage.js';

const ORDER_STORAGE_SCHEMA_VERSION = 1;
const MIRROR_BATCH_SIZE = 300;
const REQUIRED_ORDER_COLUMNS = Object.freeze([
  'id',
  'shop_id',
  'order_key',
  'posting_number',
  'order_id',
  'remote_hash',
  'is_stale',
  'last_seen_at',
  'created_at',
  'updated_at',
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requiredShopId(value) {
  const shopId = normalizeText(value);
  if (!shopId) {
    const error = new Error('SHOP_ORDER_STORAGE_SHOP_ID_REQUIRED');
    error.code = 'SHOP_ORDER_STORAGE_SHOP_ID_REQUIRED';
    throw error;
  }
  return shopId;
}

function normalizeOrderKeys(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeText(value))
    .filter(Boolean))];
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function safeColumnType(value) {
  const type = normalizeText(value).toUpperCase() || 'BLOB';
  if (!/^[A-Z0-9_ ()]+$/u.test(type)) {
    const error = new Error('SHOP_ORDER_STORAGE_COLUMN_TYPE_INVALID');
    error.code = 'SHOP_ORDER_STORAGE_COLUMN_TYPE_INVALID';
    throw error;
  }
  return type;
}

function safeDefaultValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (
    /^[-+]?\d+(?:\.\d+)?$/u.test(text)
    || /^NULL$/iu.test(text)
    || /^CURRENT_(?:TIME|DATE|TIMESTAMP)$/iu.test(text)
    || /^'(?:[^']|'')*'$/u.test(text)
  ) return ` DEFAULT ${text}`;
  const error = new Error('SHOP_ORDER_STORAGE_COLUMN_DEFAULT_INVALID');
  error.code = 'SHOP_ORDER_STORAGE_COLUMN_DEFAULT_INVALID';
  throw error;
}

function readOrderColumns(db) {
  const columns = db.prepare("PRAGMA table_info('ozon_orders')").all().map((column) => Object.freeze({
    name: String(column.name),
    type: safeColumnType(column.type),
    notNull: Number(column.notnull) === 1,
    defaultValue: column.dflt_value === undefined ? null : column.dflt_value,
    primaryKey: Number(column.pk) || 0,
  }));
  if (!columns.length || REQUIRED_ORDER_COLUMNS.some((name) => !columns.some((column) => column.name === name))) {
    const error = new Error('SHOP_ORDER_STORAGE_CANONICAL_SCHEMA_INVALID');
    error.code = 'SHOP_ORDER_STORAGE_CANONICAL_SCHEMA_INVALID';
    throw error;
  }
  if (columns.filter((column) => column.primaryKey > 0).length !== 1) {
    const error = new Error('SHOP_ORDER_STORAGE_PRIMARY_KEY_INVALID');
    error.code = 'SHOP_ORDER_STORAGE_PRIMARY_KEY_INVALID';
    throw error;
  }
  return Object.freeze(columns);
}

function columnSignature(columns) {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    notNull: column.notNull,
    defaultValue: column.defaultValue,
    primaryKey: column.primaryKey,
  }));
}

function createOrderTableSql(columns) {
  const definitions = columns.map((column) => [
    quoteIdentifier(column.name),
    column.type,
    column.primaryKey ? ' PRIMARY KEY' : '',
    column.notNull ? ' NOT NULL' : '',
    safeDefaultValue(column.defaultValue),
  ].join(''));
  return `CREATE TABLE IF NOT EXISTS ozon_orders (${definitions.join(', ')});`;
}

function createPlaceholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function chunk(values, size = MIRROR_BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function assertExactRows(columns, sourceRows, targetRows) {
  const sourceByKey = new Map(sourceRows.map((row) => [row.order_key, row]));
  const targetByKey = new Map(targetRows.map((row) => [row.order_key, row]));
  if (sourceByKey.size !== targetByKey.size) {
    const error = new Error('SHOP_ORDER_STORAGE_ROW_COUNT_MISMATCH');
    error.code = 'SHOP_ORDER_STORAGE_ROW_COUNT_MISMATCH';
    throw error;
  }
  for (const [orderKey, sourceRow] of sourceByKey) {
    const targetRow = targetByKey.get(orderKey);
    if (!targetRow) {
      const error = new Error('SHOP_ORDER_STORAGE_ROW_MISSING');
      error.code = 'SHOP_ORDER_STORAGE_ROW_MISSING';
      throw error;
    }
    for (const column of columns) {
      if (!isDeepStrictEqual(sourceRow[column.name], targetRow[column.name])) {
        const error = new Error('SHOP_ORDER_STORAGE_FIELD_MISMATCH');
        error.code = 'SHOP_ORDER_STORAGE_FIELD_MISMATCH';
        error.column = column.name;
        error.orderKey = orderKey;
        throw error;
      }
    }
  }
}

export function createShopOrderStorage({
  canonicalDb,
  shopDatabaseRouter,
  directWriteAllShops = false,
  backgroundRunner = (task) => setImmediate(task),
  onError = () => undefined,
} = {}) {
  if (!canonicalDb?.prepare || !canonicalDb?.exec) throw new Error('SHOP_ORDER_STORAGE_CANONICAL_DB_REQUIRED');
  if (!shopDatabaseRouter?.resolve || !shopDatabaseRouter?.open) throw new Error('SHOP_ORDER_STORAGE_ROUTER_REQUIRED');
  if (typeof backgroundRunner !== 'function') throw new Error('SHOP_ORDER_STORAGE_BACKGROUND_RUNNER_REQUIRED');

  const columns = readOrderColumns(canonicalDb);
  const auxiliaryStorage = createShopOrderAuxiliaryStorage(canonicalDb);
  const quotedColumns = columns.map((column) => quoteIdentifier(column.name));
  const columnList = quotedColumns.join(', ');
  const insertValues = createPlaceholders(columns.length);
  const updateColumns = columns
    .filter((column) => !column.primaryKey)
    .map((column) => `${quoteIdentifier(column.name)} = excluded.${quoteIdentifier(column.name)}`)
    .join(', ');
  const lanes = new Map();
  const indexedDatabases = new WeakSet();
  function ensurePaymentReadIndex(db) {
    if (indexedDatabases.has(db)) return;
    db.exec(`CREATE INDEX IF NOT EXISTS idx_shop_ozon_orders_stale_payment_display_order
      ON ozon_orders(shop_id, is_stale,
        COALESCE(payment_at, in_process_at, updated_at) DESC,
        posting_number ASC, order_id ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_shop_ozon_orders_owner_watermark
        ON ozon_orders(shop_id, updated_at)`);
    // Do not remember DDL that a caller's transaction can still roll back.
    if (db.isTransaction === false) indexedDatabases.add(db);
  }
  const counters = {
    queuedBatches: 0,
    mirroredBatches: 0,
    mirroredRows: 0,
    deletedRows: 0,
    verifiedRows: 0,
    failures: 0,
    lastErrorCode: '',
  };

  function isDirectWriteShop(shopId) {
    return Boolean(normalizeText(shopId) && directWriteAllShops === true);
  }

  function ensureSchema(session) {
    const { db, route } = session;
    db.exec(createOrderTableSql(columns));
    auxiliaryStorage.ensureSchema(db);
    const localColumns = readOrderColumns(db);
    if (!isDeepStrictEqual(columnSignature(columns), columnSignature(localColumns))) {
      const error = new Error('SHOP_ORDER_STORAGE_SCHEMA_MISMATCH');
      error.code = 'SHOP_ORDER_STORAGE_SCHEMA_MISMATCH';
      throw error;
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_ozon_orders_order_key
        ON ozon_orders(shop_id, order_key);
      CREATE INDEX IF NOT EXISTS idx_shop_ozon_orders_status
        ON ozon_orders(status, is_stale, in_process_at);
      CREATE INDEX IF NOT EXISTS idx_shop_ozon_orders_date
        ON ozon_orders(in_process_at, is_stale);
      CREATE INDEX IF NOT EXISTS idx_shop_ozon_orders_updated
        ON ozon_orders(updated_at);
      CREATE TABLE IF NOT EXISTS shop_order_storage_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        mode TEXT NOT NULL,
        last_mirror_at TEXT,
        last_verified_at TEXT,
        last_source_row_count INTEGER NOT NULL DEFAULT 0,
        last_target_row_count INTEGER NOT NULL DEFAULT 0,
        direct_write_revision INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS shop_order_backfill_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        shop_incarnation TEXT NOT NULL,
        status TEXT NOT NULL,
        cursor_order_key TEXT NOT NULL DEFAULT '',
        source_total INTEGER NOT NULL DEFAULT 0,
        source_watermark TEXT NOT NULL DEFAULT '',
        mirrored_rows INTEGER NOT NULL DEFAULT 0,
        verified_rows INTEGER NOT NULL DEFAULT 0,
        batch_count INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        last_error_code TEXT
      );
      CREATE TRIGGER IF NOT EXISTS trg_shop_ozon_orders_scope_insert
      BEFORE INSERT ON ozon_orders
      WHEN COALESCE((SELECT shop_id FROM shop_database_metadata WHERE singleton = 1), '') <> NEW.shop_id
      BEGIN
        SELECT RAISE(ABORT, 'SHOP_ORDER_SCOPE_MISMATCH');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_shop_ozon_orders_scope_update
      BEFORE UPDATE OF shop_id ON ozon_orders
      WHEN COALESCE((SELECT shop_id FROM shop_database_metadata WHERE singleton = 1), '') <> NEW.shop_id
      BEGIN
        SELECT RAISE(ABORT, 'SHOP_ORDER_SCOPE_MISMATCH');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_shop_ozon_orders_identity_insert
      BEFORE INSERT ON ozon_orders
      WHEN TRIM(COALESCE(NEW.posting_number, '')) = ''
       AND TRIM(COALESCE(NEW.order_id, '')) = ''
      BEGIN
        SELECT RAISE(ABORT, 'OZON_ORDER_IDENTITY_REQUIRED');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_shop_ozon_orders_identity_update
      BEFORE UPDATE OF posting_number, order_id ON ozon_orders
      WHEN TRIM(COALESCE(NEW.posting_number, '')) = ''
       AND TRIM(COALESCE(NEW.order_id, '')) = ''
      BEGIN
        SELECT RAISE(ABORT, 'OZON_ORDER_IDENTITY_REQUIRED');
      END;
    `);
    const storageStateColumns = db.prepare("PRAGMA table_info('shop_order_storage_state')").all();
    if (!storageStateColumns.some((column) => column.name === 'direct_write_revision')) {
      db.exec('ALTER TABLE shop_order_storage_state ADD COLUMN direct_write_revision INTEGER NOT NULL DEFAULT 0;');
    }
    db.prepare(`
      INSERT INTO shop_order_storage_state (
        singleton, schema_version, mode, last_source_row_count, last_target_row_count
      ) VALUES (1, ?, 'shadow-write-verified', 0, 0)
      ON CONFLICT(singleton) DO UPDATE SET
        schema_version = excluded.schema_version,
        mode = CASE
          WHEN shop_order_storage_state.mode = 'direct' THEN shop_order_storage_state.mode
          ELSE excluded.mode
        END
    `).run(ORDER_STORAGE_SCHEMA_VERSION);
    const metadata = db.prepare(`
      SELECT shop_id, profile_id, shop_incarnation
      FROM shop_database_metadata
      WHERE singleton = 1
    `).get();
    if (
      metadata?.shop_id !== route.shopId
      || metadata?.profile_id !== route.profileId
      || metadata?.shop_incarnation !== route.shopIncarnation
    ) {
      const error = new Error('SHOP_ORDER_STORAGE_METADATA_MISMATCH');
      error.code = 'SHOP_ORDER_STORAGE_METADATA_MISMATCH';
      throw error;
    }
    db.prepare(`
      INSERT INTO shop_order_backfill_state (
        singleton, schema_version, shop_incarnation, status, updated_at
      ) VALUES (1, ?, ?, 'pending', ?)
      ON CONFLICT(singleton) DO NOTHING
    `).run(ORDER_STORAGE_SCHEMA_VERSION, route.shopIncarnation, new Date().toISOString());
    const backfillIdentity = db.prepare(`
      SELECT schema_version, shop_incarnation
      FROM shop_order_backfill_state
      WHERE singleton = 1
    `).get();
    if (
      Number(backfillIdentity?.schema_version) !== ORDER_STORAGE_SCHEMA_VERSION
      || backfillIdentity?.shop_incarnation !== route.shopIncarnation
    ) {
      const error = new Error('SHOP_ORDER_BACKFILL_SCOPE_MISMATCH');
      error.code = 'SHOP_ORDER_BACKFILL_SCOPE_MISMATCH';
      throw error;
    }
    return localColumns;
  }

  function mirrorBatch({ shopId, orderKeys, expectedScopeToken }) {
    const keys = normalizeOrderKeys(orderKeys);
    if (!keys.length) return Object.freeze({ ok: true, mirrored: 0, deleted: 0, verified: 0 });
    const session = shopDatabaseRouter.open(shopId, { expectedScopeToken });
    ensureSchema(session);
    const sourceRows = canonicalDb.prepare(`
      SELECT ${columnList}
      FROM ozon_orders
      WHERE shop_id = ? AND order_key IN (${createPlaceholders(keys.length)})
      ORDER BY order_key ASC
    `).all(shopId, ...keys);
    if (sourceRows.some((row) => row.shop_id !== shopId)) {
      const error = new Error('SHOP_ORDER_STORAGE_SOURCE_SCOPE_MISMATCH');
      error.code = 'SHOP_ORDER_STORAGE_SOURCE_SCOPE_MISMATCH';
      throw error;
    }
    const sourceKeys = new Set(sourceRows.map((row) => row.order_key));
    const missingKeys = keys.filter((key) => !sourceKeys.has(key));
    const upsert = session.db.prepare(`
      INSERT INTO ozon_orders (${columnList})
      VALUES (${insertValues})
      ON CONFLICT(id) DO UPDATE SET ${updateColumns}
    `);
    session.db.exec('BEGIN IMMEDIATE;');
    let deleted = 0;
    try {
      for (const row of sourceRows) upsert.run(...columns.map((column) => row[column.name]));
      if (missingKeys.length) {
        deleted = Number(session.db.prepare(`
          DELETE FROM ozon_orders
          WHERE shop_id = ? AND order_key IN (${createPlaceholders(missingKeys.length)})
        `).run(shopId, ...missingKeys).changes) || 0;
      }
      const targetRows = session.db.prepare(`
        SELECT ${columnList}
        FROM ozon_orders
        WHERE shop_id = ? AND order_key IN (${createPlaceholders(keys.length)})
        ORDER BY order_key ASC
      `).all(shopId, ...keys);
      assertExactRows(columns, sourceRows, targetRows);
      const timestamp = new Date().toISOString();
      session.db.prepare(`
        UPDATE shop_order_storage_state
        SET last_mirror_at = ?, last_verified_at = ?,
            last_source_row_count = ?, last_target_row_count = ?, last_error_code = NULL
        WHERE singleton = 1
      `).run(timestamp, timestamp, sourceRows.length, targetRows.length);
      session.db.exec('COMMIT;');
      return Object.freeze({
        ok: true,
        mirrored: sourceRows.length,
        deleted,
        verified: targetRows.length,
      });
    } catch (error) {
      try { session.db.exec('ROLLBACK;'); } catch { /* original error wins */ }
      throw error;
    }
  }

  function mirrorCanonicalRows(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (isDirectWriteShop(shopId)) {
      const readiness = resolveVerifiedReadSession({ shopId, expectedScopeToken: input.expectedScopeToken });
      if (readiness.ready && readiness.writeMode === 'direct') {
        return Object.freeze({ ok: true, shopId, mirrored: 0, deleted: 0, verified: 0, skipped: true, reason: 'direct_write_ready' });
      }
    }
    const keys = normalizeOrderKeys(input.orderKeys);
    let mirrored = 0;
    let deleted = 0;
    let verified = 0;
    for (const keyBatch of chunk(keys)) {
      const result = mirrorBatch({
        shopId,
        orderKeys: keyBatch,
        expectedScopeToken: input.expectedScopeToken,
      });
      mirrored += result.mirrored;
      deleted += result.deleted;
      verified += result.verified;
      counters.mirroredBatches += 1;
    }
    counters.mirroredRows += mirrored;
    counters.deletedRows += deleted;
    counters.verifiedRows += verified;
    refreshCompletedReadState({
      shopId,
      expectedScopeToken: input.expectedScopeToken,
    });
    return Object.freeze({ ok: true, shopId, mirrored, deleted, verified });
  }

  function recordBackgroundError(error, context) {
    counters.failures += 1;
    counters.lastErrorCode = String(error?.code || error?.message || 'SHOP_ORDER_STORAGE_MIRROR_FAILED');
    try { onError(error, context); } catch { /* observers cannot break the queue */ }
  }

  function drainLane(laneKey) {
    const lane = lanes.get(laneKey);
    if (!lane) return Object.freeze({ ok: true, mirrored: 0, deleted: 0, verified: 0 });
    lanes.delete(laneKey);
    try {
      return mirrorCanonicalRows({
        shopId: lane.shopId,
        orderKeys: [...lane.orderKeys],
        expectedScopeToken: lane.expectedScopeToken,
      });
    } catch (error) {
      recordBackgroundError(error, { action: 'mirror-orders', shopId: lane.shopId });
      return Object.freeze({ ok: false, mirrored: 0, deleted: 0, verified: 0, errorCode: counters.lastErrorCode });
    }
  }

  function enqueueCanonicalRows(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (isDirectWriteShop(shopId)) {
      const readiness = resolveVerifiedReadSession({ shopId, expectedScopeToken: input.expectedScopeToken });
      if (readiness.ready && readiness.writeMode === 'direct') {
        return Object.freeze({ ok: true, accepted: 0, pending: 0, reason: 'direct_write_ready' });
      }
    }
    const orderKeys = normalizeOrderKeys(input.orderKeys);
    if (!orderKeys.length) return Object.freeze({ ok: true, accepted: 0, pending: 0 });
    const route = shopDatabaseRouter.resolve(shopId, { expectedScopeToken: input.expectedScopeToken });
    const laneKey = route.scopeDigest;
    let lane = lanes.get(laneKey);
    let createdLane = false;
    if (!lane) {
      lane = {
        shopId,
        expectedScopeToken: route.scopeToken,
        orderKeys: new Set(),
      };
      lanes.set(laneKey, lane);
      createdLane = true;
    }
    orderKeys.forEach((orderKey) => lane.orderKeys.add(orderKey));
    if (createdLane) backgroundRunner(() => drainLane(laneKey));
    counters.queuedBatches += 1;
    return Object.freeze({ ok: true, accepted: orderKeys.length, pending: lane.orderKeys.size });
  }

  function flush(shopIdInput = '') {
    const shopId = normalizeText(shopIdInput);
    const laneKeys = [...lanes.entries()]
      .filter(([, lane]) => !shopId || lane.shopId === shopId)
      .map(([laneKey]) => laneKey);
    const summary = { ok: true, mirrored: 0, deleted: 0, verified: 0, failures: 0 };
    for (const laneKey of laneKeys) {
      const result = drainLane(laneKey);
      summary.ok = summary.ok && result.ok !== false;
      summary.mirrored += Number(result.mirrored) || 0;
      summary.deleted += Number(result.deleted) || 0;
      summary.verified += Number(result.verified) || 0;
      if (result.ok === false) summary.failures += 1;
    }
    return Object.freeze(summary);
  }

  function toBackfillState(row = {}) {
    return Object.freeze({
      status: row.status || 'pending',
      cursorOrderKey: row.cursor_order_key || '',
      sourceTotal: Number(row.source_total) || 0,
      sourceWatermark: row.source_watermark || '',
      mirroredRows: Number(row.mirrored_rows) || 0,
      verifiedRows: Number(row.verified_rows) || 0,
      batchCount: Number(row.batch_count) || 0,
      retryCount: Number(row.retry_count) || 0,
      startedAt: row.started_at || null,
      updatedAt: row.updated_at || null,
      completedAt: row.completed_at || null,
      lastErrorCode: row.last_error_code || '',
    });
  }

  function openBackfillSession(shopId, expectedScopeToken) {
    const route = shopDatabaseRouter.resolve(shopId, { expectedScopeToken });
    const session = shopDatabaseRouter.open(shopId, { expectedScopeToken: route.scopeToken });
    ensureSchema(session);
    return session;
  }

  function getBackfillState(input = {}) {
    const shopId = requiredShopId(input.shopId);
    const session = openBackfillSession(shopId, input.expectedScopeToken);
    const row = session.db.prepare('SELECT * FROM shop_order_backfill_state WHERE singleton = 1').get();
    return Object.freeze({ shopId, ...toBackfillState(row) });
  }

  function recordBackfillFailure(input = {}) {
    const shopId = requiredShopId(input.shopId);
    const errorCode = normalizeText(input.errorCode) || 'SHOP_ORDER_BACKFILL_FAILED';
    const session = openBackfillSession(shopId, input.expectedScopeToken);
    session.db.prepare(`
      UPDATE shop_order_backfill_state
      SET retry_count = retry_count + 1, updated_at = ?, last_error_code = ?
      WHERE singleton = 1
    `).run(new Date().toISOString(), errorCode);
    return getBackfillState({ shopId, expectedScopeToken: session.route.scopeToken });
  }

  function readSourceSummary(shopId) {
    const row = canonicalDb.prepare(`
      SELECT COUNT(*) AS total, COALESCE(MAX(updated_at), '') AS watermark
      FROM ozon_orders
      WHERE shop_id = ?
    `).get(shopId);
    return Object.freeze({
      total: Number(row?.total) || 0,
      watermark: row?.watermark || '',
    });
  }

  function refreshCompletedReadState(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (isDirectWriteShop(shopId)) {
      const readiness = resolveVerifiedReadSession({ shopId, expectedScopeToken: input.expectedScopeToken });
      if (readiness.ready && readiness.writeMode === 'direct') {
        return Object.freeze({ ok: true, refreshed: false, reason: 'direct_write_ready' });
      }
    }
    const session = openBackfillSession(shopId, input.expectedScopeToken);
    const state = session.db.prepare(`
      SELECT status FROM shop_order_backfill_state WHERE singleton = 1
    `).get();
    if (state?.status !== 'completed') {
      return Object.freeze({ ok: true, refreshed: false, reason: 'backfill_not_completed' });
    }
    const source = readSourceSummary(shopId);
    const target = session.db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(MAX(updated_at), '') AS watermark
      FROM ozon_orders WHERE shop_id = ?
    `).get(shopId);
    const targetTotal = Number(target?.total) || 0;
    const targetWatermark = target?.watermark || '';
    const foreignTotal = Number(session.db.prepare(`
      SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id <> ?
    `).get(shopId)?.total) || 0;
    if (
      targetTotal !== source.total
      || targetWatermark !== source.watermark
      || foreignTotal !== 0
    ) {
      return Object.freeze({ ok: true, refreshed: false, reason: 'local_copy_stale' });
    }
    const timestamp = new Date().toISOString();
    session.db.prepare(`
      UPDATE shop_order_backfill_state
      SET source_total = ?, source_watermark = ?, mirrored_rows = ?, verified_rows = ?,
          updated_at = ?, completed_at = COALESCE(completed_at, ?), last_error_code = NULL
      WHERE singleton = 1 AND status = 'completed'
    `).run(source.total, source.watermark, source.total, source.total, timestamp, timestamp);
    return Object.freeze({ ok: true, refreshed: true, sourceTotal: source.total });
  }

  function initializeEmptyShop(input = {}) {
    const shopId = requiredShopId(input.shopId);
    const session = openBackfillSession(shopId, input.expectedScopeToken);
    const source = readSourceSummary(shopId);
    const targetTotal = Number(session.db.prepare(`
      SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id = ?
    `).get(shopId)?.total) || 0;
    const foreignTotal = Number(session.db.prepare(`
      SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id <> ?
    `).get(shopId)?.total) || 0;
    if (source.total !== 0 || targetTotal !== 0 || foreignTotal !== 0) {
      return Object.freeze({
        ok: true,
        initialized: false,
        requiresBackfill: source.total !== targetTotal || source.total > 0,
        sourceTotal: source.total,
        targetTotal,
        foreignTotal,
      });
    }
    const timestamp = new Date().toISOString();
    session.db.prepare(`
      UPDATE shop_order_backfill_state
      SET status = 'completed', cursor_order_key = '', source_total = 0,
          source_watermark = '', mirrored_rows = 0, verified_rows = 0,
          batch_count = 0, retry_count = 0, started_at = ?, updated_at = ?,
          completed_at = ?, last_error_code = NULL
      WHERE singleton = 1
    `).run(timestamp, timestamp, timestamp);
    return Object.freeze({
      ok: true,
      initialized: true,
      requiresBackfill: false,
      sourceTotal: 0,
      targetTotal: 0,
      foreignTotal: 0,
    });
  }

  function beginBackfillRun(session, summary) {
    const timestamp = new Date().toISOString();
    session.db.prepare(`
      UPDATE shop_order_backfill_state
      SET status = 'running', cursor_order_key = '', source_total = ?, source_watermark = ?,
          mirrored_rows = 0, verified_rows = 0, batch_count = 0, retry_count = 0,
          started_at = ?, updated_at = ?, completed_at = NULL, last_error_code = NULL
      WHERE singleton = 1
    `).run(summary.total, summary.watermark, timestamp, timestamp);
  }

  function persistBackfillProgress(session, input = {}) {
    const timestamp = new Date().toISOString();
    session.db.prepare(`
      UPDATE shop_order_backfill_state
      SET status = ?, cursor_order_key = ?, source_total = ?, source_watermark = ?,
          mirrored_rows = mirrored_rows + ?, verified_rows = verified_rows + ?,
          batch_count = batch_count + 1, updated_at = ?, completed_at = ?,
          last_error_code = NULL
      WHERE singleton = 1
    `).run(
      input.status,
      input.cursorOrderKey || '',
      input.sourceTotal,
      input.sourceWatermark || '',
      Number(input.mirrored) || 0,
      Number(input.verified) || 0,
      timestamp,
      input.status === 'completed' ? timestamp : null,
    );
  }

  function pruneDeletedCanonicalRowsBatch(shopId, session, afterOrderKey, batchSize) {
    const rows = session.db.prepare(`
      SELECT order_key FROM ozon_orders
      WHERE shop_id = ? AND order_key > ?
      ORDER BY order_key ASC
      LIMIT ?
    `).all(shopId, afterOrderKey, batchSize + 1);
    const pageRows = rows.slice(0, batchSize);
    const keys = pageRows.map((row) => row.order_key);
    if (!keys.length) {
      return Object.freeze({ deleted: 0, hasMore: false, nextCursor: afterOrderKey });
    }
    const canonicalKeys = new Set(canonicalDb.prepare(`
      SELECT order_key FROM ozon_orders
      WHERE shop_id = ? AND order_key IN (${createPlaceholders(keys.length)})
    `).all(shopId, ...keys).map((row) => row.order_key));
    const missingKeys = keys.filter((key) => !canonicalKeys.has(key));
    const deleted = missingKeys.length
      ? Number(session.db.prepare(`
          DELETE FROM ozon_orders
          WHERE shop_id = ? AND order_key IN (${createPlaceholders(missingKeys.length)})
        `).run(shopId, ...missingKeys).changes) || 0
      : 0;
    counters.deletedRows += deleted;
    return Object.freeze({
      deleted,
      hasMore: rows.length > batchSize,
      nextCursor: keys.at(-1),
    });
  }

  function verifyBackfillRowsBatch(shopId, session, afterOrderKey, batchSize) {
    const rows = canonicalDb.prepare(`
      SELECT order_key FROM ozon_orders
      WHERE shop_id = ? AND order_key > ?
      ORDER BY order_key ASC
      LIMIT ?
    `).all(shopId, afterOrderKey, batchSize + 1);
    const pageRows = rows.slice(0, batchSize);
    const orderKeys = pageRows.map((row) => row.order_key);
    if (!orderKeys.length) {
      return Object.freeze({ verified: 0, hasMore: false, nextCursor: afterOrderKey });
    }
    const sourceRows = canonicalDb.prepare(`
      SELECT ${columnList} FROM ozon_orders
      WHERE shop_id = ? AND order_key IN (${createPlaceholders(orderKeys.length)})
      ORDER BY order_key ASC
    `).all(shopId, ...orderKeys);
    const targetRows = session.db.prepare(`
      SELECT ${columnList} FROM ozon_orders
      WHERE shop_id = ? AND order_key IN (${createPlaceholders(orderKeys.length)})
      ORDER BY order_key ASC
    `).all(shopId, ...orderKeys);
    assertExactRows(columns, sourceRows, targetRows);
    return Object.freeze({
      verified: sourceRows.length,
      hasMore: rows.length > batchSize,
      nextCursor: orderKeys.at(-1),
    });
  }

  function backfillNextBatch(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (isDirectWriteShop(shopId)) {
      const readiness = resolveVerifiedReadSession({ shopId, expectedScopeToken: input.expectedScopeToken });
      if (readiness.ready && readiness.writeMode === 'direct') {
        return Object.freeze({
          ok: true,
          shopId,
          mirrored: 0,
          deleted: 0,
          verified: readiness.targetTotal,
          hasMore: false,
          completed: true,
          alreadyComplete: true,
          nextCursor: '',
          reason: 'direct_write_ready',
        });
      }
    }
    const batchSize = Math.min(Math.max(Number(input.batchSize) || 200, 1), MIRROR_BATCH_SIZE);
    const session = openBackfillSession(shopId, input.expectedScopeToken);
    let state = toBackfillState(
      session.db.prepare('SELECT * FROM shop_order_backfill_state WHERE singleton = 1').get(),
    );
    const sourceSummary = readSourceSummary(shopId);
    const targetTotal = Number(
      session.db.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id = ?').get(shopId)?.total,
    ) || 0;
    if (
      state.status === 'completed'
      && state.sourceTotal === sourceSummary.total
      && state.sourceWatermark === sourceSummary.watermark
      && targetTotal === sourceSummary.total
    ) {
      return Object.freeze({
        ok: true,
        shopId,
        mirrored: 0,
        deleted: 0,
        verified: sourceSummary.total,
        hasMore: false,
        completed: true,
        alreadyComplete: true,
        nextCursor: state.cursorOrderKey,
      });
    }
    if (state.status === 'pending' || state.status === 'completed') {
      beginBackfillRun(session, sourceSummary);
      state = toBackfillState(
        session.db.prepare('SELECT * FROM shop_order_backfill_state WHERE singleton = 1').get(),
      );
    }
    const afterOrderKey = Object.prototype.hasOwnProperty.call(input, 'afterOrderKey')
      ? normalizeText(input.afterOrderKey)
      : state.cursorOrderKey;

    if (state.status === 'pruning') {
      const result = pruneDeletedCanonicalRowsBatch(shopId, session, afterOrderKey, batchSize);
      persistBackfillProgress(session, {
        status: result.hasMore ? 'pruning' : 'verifying',
        cursorOrderKey: result.hasMore ? result.nextCursor : '',
        sourceTotal: state.sourceTotal,
        sourceWatermark: state.sourceWatermark,
      });
      return Object.freeze({
        ok: true,
        shopId,
        mirrored: 0,
        deleted: result.deleted,
        verified: 0,
        phase: result.hasMore ? 'pruning' : 'verifying',
        hasMore: true,
        completed: false,
        alreadyComplete: false,
        nextCursor: result.hasMore ? result.nextCursor : '',
      });
    }

    if (state.status === 'verifying') {
      const result = verifyBackfillRowsBatch(shopId, session, afterOrderKey, batchSize);
      if (result.hasMore) {
        persistBackfillProgress(session, {
          status: 'verifying',
          cursorOrderKey: result.nextCursor,
          sourceTotal: state.sourceTotal,
          sourceWatermark: state.sourceWatermark,
          verified: result.verified,
        });
        return Object.freeze({
          ok: true,
          shopId,
          mirrored: 0,
          deleted: 0,
          verified: result.verified,
          phase: 'verifying',
          hasMore: true,
          completed: false,
          alreadyComplete: false,
          nextCursor: result.nextCursor,
        });
      }
      const finalSummary = readSourceSummary(shopId);
      const finalTargetTotal = Number(
        session.db.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id = ?').get(shopId)?.total,
      ) || 0;
      const foreignTotal = Number(
        session.db.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id <> ?').get(shopId)?.total,
      ) || 0;
      const totalVerified = state.verifiedRows + result.verified;
      if (
        finalSummary.total !== state.sourceTotal
        || finalSummary.watermark !== state.sourceWatermark
      ) {
        beginBackfillRun(session, finalSummary);
        return Object.freeze({
          ok: true,
          shopId,
          mirrored: 0,
          deleted: 0,
          verified: result.verified,
          phase: 'running',
          hasMore: true,
          completed: false,
          alreadyComplete: false,
          restarted: true,
          nextCursor: '',
        });
      }
      if (finalTargetTotal !== finalSummary.total || foreignTotal !== 0 || totalVerified !== finalSummary.total) {
        const error = new Error('SHOP_ORDER_BACKFILL_VERIFY_MISMATCH');
        error.code = 'SHOP_ORDER_BACKFILL_VERIFY_MISMATCH';
        throw error;
      }
      persistBackfillProgress(session, {
        status: 'completed',
        cursorOrderKey: result.nextCursor,
        sourceTotal: finalSummary.total,
        sourceWatermark: finalSummary.watermark,
        verified: result.verified,
      });
      return Object.freeze({
        ok: true,
        shopId,
        mirrored: 0,
        deleted: 0,
        verified: result.verified,
        phase: 'completed',
        hasMore: false,
        completed: true,
        alreadyComplete: false,
        nextCursor: result.nextCursor,
      });
    }

    const rows = canonicalDb.prepare(`
      SELECT order_key
      FROM ozon_orders
      WHERE shop_id = ? AND order_key > ?
      ORDER BY order_key ASC
      LIMIT ?
    `).all(shopId, afterOrderKey, batchSize + 1);
    const pageRows = rows.slice(0, batchSize);
    const result = mirrorCanonicalRows({
      shopId,
      orderKeys: pageRows.map((row) => row.order_key),
      expectedScopeToken: session.route.scopeToken,
    });
    const hasMoreInCopy = rows.length > batchSize;
    const nextCursor = pageRows.at(-1)?.order_key || afterOrderKey;
    persistBackfillProgress(session, {
      status: hasMoreInCopy ? 'running' : 'pruning',
      cursorOrderKey: hasMoreInCopy ? nextCursor : '',
      sourceTotal: state.sourceTotal,
      sourceWatermark: state.sourceWatermark,
      mirrored: result.mirrored,
    });
    return Object.freeze({
      ...result,
      phase: hasMoreInCopy ? 'running' : 'pruning',
      hasMore: true,
      completed: false,
      alreadyComplete: false,
      nextCursor: hasMoreInCopy ? nextCursor : '',
    });
  }

  function verifyShop(input = {}) {
    const shopId = requiredShopId(input.shopId);
    const route = shopDatabaseRouter.resolve(shopId, { expectedScopeToken: input.expectedScopeToken });
    const session = shopDatabaseRouter.open(shopId, {
      expectedScopeToken: route.scopeToken,
      createIfMissing: false,
    });
    ensureSchema(session);
    const source = canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id = ?').get(shopId);
    const target = session.db.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id = ?').get(shopId);
    const foreign = session.db.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id <> ?').get(shopId);
    const sourceTotal = Number(source?.total) || 0;
    const targetTotal = Number(target?.total) || 0;
    const foreignTotal = Number(foreign?.total) || 0;
    let verified = 0;
    let afterOrderKey = '';
    while (verified < sourceTotal) {
      const keyRows = canonicalDb.prepare(`
        SELECT order_key
        FROM ozon_orders
        WHERE shop_id = ? AND order_key > ?
        ORDER BY order_key ASC
        LIMIT ?
      `).all(shopId, afterOrderKey, MIRROR_BATCH_SIZE);
      if (!keyRows.length) break;
      const orderKeys = keyRows.map((row) => row.order_key);
      const sourceRows = canonicalDb.prepare(`
        SELECT ${columnList} FROM ozon_orders
        WHERE shop_id = ? AND order_key IN (${createPlaceholders(orderKeys.length)})
        ORDER BY order_key ASC
      `).all(shopId, ...orderKeys);
      const targetRows = session.db.prepare(`
        SELECT ${columnList} FROM ozon_orders
        WHERE shop_id = ? AND order_key IN (${createPlaceholders(orderKeys.length)})
        ORDER BY order_key ASC
      `).all(shopId, ...orderKeys);
      assertExactRows(columns, sourceRows, targetRows);
      verified += sourceRows.length;
      afterOrderKey = orderKeys.at(-1);
    }
    return Object.freeze({
      ok: sourceTotal === targetTotal && foreignTotal === 0 && verified === sourceTotal,
      shopId,
      sourceTotal,
      targetTotal,
      foreignTotal,
      verified,
    });
  }

  function resolveVerifiedReadSession(input = {}) {
    const shopId = requiredShopId(input.shopId);
    try {
      const route = shopDatabaseRouter.resolve(shopId, {
        expectedScopeToken: input.expectedScopeToken,
      });
      const session = shopDatabaseRouter.open(shopId, {
        expectedScopeToken: route.scopeToken,
        createIfMissing: false,
      });
      const state = session.db.prepare(`
        SELECT schema_version, shop_incarnation, status, source_total,
               source_watermark, verified_rows, last_error_code
        FROM shop_order_backfill_state
        WHERE singleton = 1
      `).get();
      const storageState = session.db.prepare(`
        SELECT mode, direct_write_revision
        FROM shop_order_storage_state
        WHERE singleton = 1
      `).get();
      const writeMode = normalizeText(storageState?.mode) || 'shadow-write-verified';
      let source = readSourceSummary(shopId);
      const targetRow = session.db.prepare(`
        SELECT COUNT(*) AS total, COALESCE(MAX(updated_at), '') AS watermark
        FROM ozon_orders
        WHERE shop_id = ?
      `).get(shopId);
      const foreignTotal = Number(session.db.prepare(`
        SELECT COUNT(*) AS total
        FROM ozon_orders
        WHERE shop_id <> ?
      `).get(shopId)?.total) || 0;
      const pendingRows = [...lanes.values()]
        .filter((lane) => lane.shopId === shopId)
        .reduce((total, lane) => total + lane.orderKeys.size, 0);
      const target = Object.freeze({
        total: Number(targetRow?.total) || 0,
        watermark: targetRow?.watermark || '',
      });
      if (writeMode === 'direct') source = target;
      let reason = '';
      if (!state || state.status !== 'completed') reason = 'backfill_not_completed';
      else if (
        Number(state.schema_version) !== ORDER_STORAGE_SCHEMA_VERSION
        || state.shop_incarnation !== session.route.shopIncarnation
      ) reason = 'scope_or_schema_mismatch';
      else if (state.last_error_code) reason = 'backfill_has_error';
      else if (writeMode !== 'direct' && (
        Number(state.source_total) !== source.total
        || (state.source_watermark || '') !== source.watermark
        || Number(state.verified_rows) !== source.total
      )) reason = 'canonical_changed_since_verification';
      else if (writeMode !== 'direct' && (target.total !== source.total || target.watermark !== source.watermark)) reason = 'local_copy_stale';
      else if (foreignTotal !== 0) reason = 'foreign_rows_detected';
      else if (pendingRows !== 0) reason = 'mirror_pending';
      // Existing direct shops bypass ensureSchema at startup. Only upgrade a
      // verified owner, so old installations benefit as well as fresh fixtures.
      if (!reason) ensurePaymentReadIndex(session.db);
      return Object.freeze({
        ready: !reason,
        reason,
        shopId,
        db: reason ? null : session.db,
        route: session.route,
        sourceTotal: source.total,
        targetTotal: target.total,
        sourceWatermark: source.watermark,
        targetWatermark: target.watermark,
        foreignTotal,
        pendingRows,
        writeMode,
        directWriteRevision: Number(storageState?.direct_write_revision) || 0,
      });
    } catch (error) {
      return Object.freeze({
        ready: false,
        reason: String(error?.code || error?.message || 'readiness_check_failed'),
        shopId,
        db: null,
        route: null,
        sourceTotal: 0,
        targetTotal: 0,
        sourceWatermark: '',
        targetWatermark: '',
        foreignTotal: 0,
        pendingRows: 0,
      });
    }
  }

  function initializeDirectShop(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (!isDirectWriteShop(shopId)) {
      return Object.freeze({ ok: true, shopId, initialized: false, reason: 'direct_write_not_enabled' });
    }
    const current = resolveVerifiedReadSession({ shopId, expectedScopeToken: input.expectedScopeToken });
    if (current.ready && current.writeMode === 'direct') {
      return Object.freeze({ ok: true, shopId, initialized: false, ready: true, reason: 'direct_write_ready' });
    }
    if (!current.ready) {
      return Object.freeze({
        ok: true,
        shopId,
        initialized: false,
        ready: false,
        requiresBackfill: true,
        reason: current.reason,
      });
    }
    const session = shopDatabaseRouter.open(shopId, { expectedScopeToken: current.route.scopeToken });
    ensureSchema(session);
    session.db.exec('BEGIN IMMEDIATE;');
    try {
      const copiedAuxiliaryRows = auxiliaryStorage.copyShopRows(session.db, shopId);
      session.db.prepare(`
        UPDATE shop_order_storage_state
        SET mode = 'direct', direct_write_revision = 0,
            last_error_code = NULL, last_verified_at = ?
        WHERE singleton = 1
      `).run(new Date().toISOString());
      session.db.exec('COMMIT;');
      return Object.freeze({ ok: true, shopId, initialized: true, ready: true, copiedAuxiliaryRows });
    } catch (error) {
      try { session.db.exec('ROLLBACK;'); } catch { /* original error wins */ }
      throw error;
    }
  }

  function resolveDirectWriteSession(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (!isDirectWriteShop(shopId)) {
      const error = new Error('SHOP_ORDER_DIRECT_WRITE_NOT_ENABLED');
      error.code = 'SHOP_ORDER_DIRECT_WRITE_NOT_ENABLED';
      throw error;
    }
    const readiness = resolveVerifiedReadSession({ shopId, expectedScopeToken: input.expectedScopeToken });
    if (!readiness.ready || readiness.writeMode !== 'direct' || !readiness.db) {
      const error = new Error('SHOP_ORDER_DIRECT_WRITE_NOT_READY');
      error.code = 'SHOP_ORDER_DIRECT_WRITE_NOT_READY';
      error.reason = readiness.reason || 'write_mode_not_direct';
      throw error;
    }
    return Object.freeze({ db: readiness.db, route: readiness.route, shopId, writeMode: 'direct' });
  }

  function recordDirectWrite(input = {}) {
    const shopId = requiredShopId(input.shopId);
    const session = resolveDirectWriteSession({ shopId, expectedScopeToken: input.expectedScopeToken });
    const timestamp = new Date().toISOString();
    session.db.prepare(`
      UPDATE shop_order_storage_state
      SET direct_write_revision = direct_write_revision + 1,
          last_verified_at = ?, last_error_code = NULL
      WHERE singleton = 1 AND mode = 'direct'
    `).run(timestamp);
    return Object.freeze({ ok: true, shopId, updatedAt: timestamp });
  }

  function snapshot() {
    const pendingRows = [...lanes.values()].reduce((total, lane) => total + lane.orderKeys.size, 0);
    return Object.freeze({
      mode: 'shadow-write-verified-canonical-read',
      schemaVersion: ORDER_STORAGE_SCHEMA_VERSION,
      canonicalReadUnchanged: true,
      directWriteAllShops: directWriteAllShops === true,
      pendingShops: lanes.size,
      pendingRows,
      ...counters,
    });
  }

  return Object.freeze({
    enqueueCanonicalRows,
    mirrorCanonicalRows,
    backfillNextBatch,
    getBackfillState,
    recordBackfillFailure,
    verifyShop,
    resolveVerifiedReadSession,
    resolveDirectWriteSession,
    initializeDirectShop,
    recordDirectWrite,
    isDirectWriteShop,
    initializeEmptyShop,
    refreshCompletedReadState,
    flush,
    snapshot,
  });
}

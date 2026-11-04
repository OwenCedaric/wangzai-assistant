import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { createStableHash } from '../utils/stableHash.js';

const PRODUCT_STORAGE_SCHEMA_VERSION = 1;
const PRODUCT_TABLES = Object.freeze([
  'ozon_products',
  'product_identities',
  'product_status_facts',
  'product_detail_facts',
  'product_dimension_facts',
  'product_price_facts',
  'product_stock_facts',
  'product_warehouse_stock_facts',
  'product_commission_facts',
  'product_acquiring_facts',
  'product_image_facts',
  'product_attribute_facts',
  'product_facet_observations',
  'product_material_profiles',
  'product_source_links',
  'product_image_health',
  'product_manual_cost_profiles',
]);

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeIds(values) {
  const source = Array.isArray(values) ? values : normalizeText(values).split(',');
  return [...new Set(source.map(normalizeText).filter(Boolean))];
}

function resolveDatabaseFile(db) {
  try {
    const rows = db.prepare('PRAGMA database_list;').all();
    return normalizeText(rows.find((row) => normalizeText(row.name) === 'main')?.file);
  } catch {
    return '';
  }
}

function deserializeWorkerError(payload = {}) {
  const error = new Error(normalizeText(payload.message) || 'SHOP_PRODUCT_STORAGE_WORKER_FAILED');
  error.name = normalizeText(payload.name) || 'Error';
  error.code = normalizeText(payload.code) || 'SHOP_PRODUCT_STORAGE_WORKER_FAILED';
  if (payload.tableName) error.tableName = payload.tableName;
  if (payload.column) error.column = payload.column;
  if (Number.isFinite(Number(payload.rowIndex))) error.rowIndex = Number(payload.rowIndex);
  return error;
}

function runDefaultMirrorWorker(input = {}, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./shopProductMirrorWorker.js', import.meta.url), {
      workerData: input,
    });
    let settled = false;
    let outcome = null;
    let abortError = null;
    const abort = () => {
      if (abortError) return;
      abortError = Object.assign(new Error('SHOP_PRODUCT_STORAGE_STOPPED'), { code: 'SHOP_PRODUCT_STORAGE_STOPPED' });
      // Only the exit event proves the worker released its SQLite file handles.
      void worker.terminate().catch(() => undefined);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    worker.once('message', (message) => {
      outcome = message?.ok === true ? { value: message.result } : { error: deserializeWorkerError(message?.error) };
    });
    worker.once('error', (error) => { outcome = { error }; });
    worker.once('exit', (code) => {
      if (!settled) {
        if (abortError) return finish(reject, abortError);
        if (outcome?.error) return finish(reject, outcome.error);
        if (outcome && code === 0) return finish(resolve, outcome.value);
        const error = new Error(`shop product mirror worker exited with code ${code}`);
        error.code = 'SHOP_PRODUCT_STORAGE_WORKER_EXITED';
        finish(reject, error);
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function requiredShopId(value) {
  const shopId = normalizeText(value);
  if (!shopId) {
    const error = new Error('SHOP_PRODUCT_STORAGE_SHOP_ID_REQUIRED');
    error.code = 'SHOP_PRODUCT_STORAGE_SHOP_ID_REQUIRED';
    throw error;
  }
  return shopId;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableColumns(db, tableName) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all()
    .map((column) => Object.freeze({
      name: String(column.name),
      type: normalizeText(column.type) || 'BLOB',
      notNull: Number(column.notnull) === 1,
      defaultValue: column.dflt_value === undefined ? null : column.dflt_value,
      primaryKey: Number(column.pk) || 0,
    }));
  if (!columns.length || !columns.some((column) => column.name === 'shop_id')) {
    const error = new Error('SHOP_PRODUCT_STORAGE_CANONICAL_SCHEMA_INVALID');
    error.code = 'SHOP_PRODUCT_STORAGE_CANONICAL_SCHEMA_INVALID';
    error.tableName = tableName;
    throw error;
  }
  if (!columns.some((column) => column.primaryKey > 0)) {
    const error = new Error('SHOP_PRODUCT_STORAGE_PRIMARY_KEY_REQUIRED');
    error.code = 'SHOP_PRODUCT_STORAGE_PRIMARY_KEY_REQUIRED';
    error.tableName = tableName;
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

function createTableSql(tableName, columns) {
  const definitions = columns.map((column) => {
    const defaultSql = column.defaultValue === null || column.defaultValue === undefined
      ? ''
      : ` DEFAULT ${column.defaultValue}`;
    return `${quoteIdentifier(column.name)} ${column.type}${column.notNull ? ' NOT NULL' : ''}${defaultSql}`;
  });
  const primaryKey = columns
    .filter((column) => column.primaryKey > 0)
    .sort((left, right) => left.primaryKey - right.primaryKey)
    .map((column) => quoteIdentifier(column.name));
  definitions.push(`PRIMARY KEY (${primaryKey.join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${definitions.join(', ')});`;
}

function readTableDescriptor(canonicalDb, tableName) {
  const columns = tableColumns(canonicalDb, tableName);
  const primaryKey = columns
    .filter((column) => column.primaryKey > 0)
    .sort((left, right) => left.primaryKey - right.primaryKey)
    .map((column) => column.name);
  const indexes = canonicalDb.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
    ORDER BY name ASC
  `).all(tableName).map((row) => normalizeText(row.sql)).filter(Boolean);
  const uniqueIndexes = canonicalDb.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all()
    .filter((index) => Number(index.unique) === 1 && normalizeText(index.origin) === 'u')
    .map((index) => canonicalDb.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all()
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((column) => normalizeText(column.name))
      .filter(Boolean))
    .filter((indexColumns) => indexColumns.length > 0);
  return Object.freeze({ tableName, columns, primaryKey, indexes, uniqueIndexes });
}

function rowOrderSql(descriptor) {
  return descriptor.primaryKey.map(quoteIdentifier).join(', ');
}

function tableSummary(db, descriptor, shopId) {
  const updatedColumn = descriptor.columns.some((column) => column.name === 'updated_at')
    ? 'updated_at'
    : descriptor.primaryKey[0];
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(MAX(${quoteIdentifier(updatedColumn)}), '') AS watermark
    FROM ${quoteIdentifier(descriptor.tableName)}
    WHERE shop_id = ?
  `).get(shopId);
  return Object.freeze({
    tableName: descriptor.tableName,
    total: Number(row?.total) || 0,
    watermark: normalizeText(row?.watermark),
  });
}

function buildSummary(db, descriptors, shopId) {
  const tables = descriptors.map((descriptor) => tableSummary(db, descriptor, shopId));
  return Object.freeze({
    tables,
    totalRows: tables.reduce((total, table) => total + table.total, 0),
    signature: createStableHash(tables, { length: 64 }),
  });
}

function readRows(db, descriptor, shopId) {
  const columnSql = descriptor.columns.map((column) => quoteIdentifier(column.name)).join(', ');
  return db.prepare(`
    SELECT ${columnSql}
    FROM ${quoteIdentifier(descriptor.tableName)}
    WHERE shop_id = ?
    ORDER BY ${rowOrderSql(descriptor)}
  `).all(shopId);
}

function assertExactTableRows(descriptor, sourceRows, targetRows) {
  if (sourceRows.length !== targetRows.length) {
    const error = new Error('SHOP_PRODUCT_STORAGE_ROW_COUNT_MISMATCH');
    error.code = 'SHOP_PRODUCT_STORAGE_ROW_COUNT_MISMATCH';
    error.tableName = descriptor.tableName;
    throw error;
  }
  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
    for (const column of descriptor.columns) {
      if (!isDeepStrictEqual(sourceRows[rowIndex][column.name], targetRows[rowIndex][column.name])) {
        const error = new Error('SHOP_PRODUCT_STORAGE_FIELD_MISMATCH');
        error.code = 'SHOP_PRODUCT_STORAGE_FIELD_MISMATCH';
        error.tableName = descriptor.tableName;
        error.column = column.name;
        error.rowIndex = rowIndex;
        throw error;
      }
    }
  }
}

export function createShopProductStorage({
  canonicalDb,
  shopDatabaseRouter,
  enabledShopIds = [],
  directWriteShopIds = [],
  directWriteAllShops = false,
  backgroundRunner = (task) => setImmediate(task),
  mirrorWorkerRunner = runDefaultMirrorWorker,
  maxMirrorAttempts = 3,
  manageCanonicalRevisions = true,
  onCommitted = () => undefined,
  onError = () => undefined,
} = {}) {
  if (!canonicalDb?.prepare || !canonicalDb?.exec) throw new Error('SHOP_PRODUCT_STORAGE_CANONICAL_DB_REQUIRED');
  if (!shopDatabaseRouter?.resolve || !shopDatabaseRouter?.open) throw new Error('SHOP_PRODUCT_STORAGE_ROUTER_REQUIRED');
  if (typeof backgroundRunner !== 'function') throw new Error('SHOP_PRODUCT_STORAGE_BACKGROUND_RUNNER_REQUIRED');

  const enabledIds = new Set(normalizeIds(enabledShopIds));
  const directIds = new Set(normalizeIds(directWriteShopIds));
  const canonicalDatabasePath = resolveDatabaseFile(canonicalDb);
  const workerMirrorEnabled = Boolean(canonicalDatabasePath && typeof mirrorWorkerRunner === 'function');
  const descriptors = PRODUCT_TABLES.map((tableName) => readTableDescriptor(canonicalDb, tableName));
  const lanes = new Map();
  const ownerFences = new Set();
  const activeWork = new Map();
  const lifecycle = new AbortController();
  const counters = {
    queued: 0,
    mirroredShops: 0,
    mirroredRows: 0,
    verifiedRows: 0,
    skippedDisabled: 0,
    coalesced: 0,
    reruns: 0,
    workerRuns: 0,
    activeWorkers: 0,
    workerFailures: 0,
    failures: 0,
    lastShopId: '',
    lastErrorCode: '',
  };

  function ensureCanonicalRevisionTracking() {
    canonicalDb.exec(`
      CREATE TABLE IF NOT EXISTS shop_product_storage_revisions (
        shop_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    for (const descriptor of descriptors) {
      const tableName = descriptor.tableName;
      const triggerPrefix = `trg_shop_product_revision_${tableName}`;
      canonicalDb.exec(`
        CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${triggerPrefix}_insert`)}
        AFTER INSERT ON ${quoteIdentifier(tableName)}
        BEGIN
          INSERT INTO shop_product_storage_revisions (shop_id, revision, updated_at)
          VALUES (NEW.shop_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(shop_id) DO UPDATE SET
            revision = shop_product_storage_revisions.revision + 1,
            updated_at = excluded.updated_at;
        END;
        CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${triggerPrefix}_update`)}
        AFTER UPDATE ON ${quoteIdentifier(tableName)}
        BEGIN
          INSERT INTO shop_product_storage_revisions (shop_id, revision, updated_at)
          VALUES (NEW.shop_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(shop_id) DO UPDATE SET
            revision = shop_product_storage_revisions.revision + 1,
            updated_at = excluded.updated_at;
        END;
        CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${triggerPrefix}_delete`)}
        AFTER DELETE ON ${quoteIdentifier(tableName)}
        BEGIN
          INSERT INTO shop_product_storage_revisions (shop_id, revision, updated_at)
          VALUES (OLD.shop_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(shop_id) DO UPDATE SET
            revision = shop_product_storage_revisions.revision + 1,
            updated_at = excluded.updated_at;
        END;
      `);
    }
  }

  function ensureCanonicalRevisionRow(shopId) {
    if (!manageCanonicalRevisions) return;
    canonicalDb.prepare(`
      INSERT INTO shop_product_storage_revisions (shop_id, revision, updated_at)
      VALUES (?, 0, ?)
      ON CONFLICT(shop_id) DO NOTHING
    `).run(shopId, new Date().toISOString());
  }

  function readCanonicalRevision(shopId) {
    return Number(canonicalDb.prepare(`
      SELECT revision FROM shop_product_storage_revisions WHERE shop_id = ?
    `).get(shopId)?.revision) || 0;
  }

  if (manageCanonicalRevisions) ensureCanonicalRevisionTracking();

  function isEnabledShop(shopId) {
    const normalizedShopId = normalizeText(shopId);
    return Boolean(normalizedShopId && (
      directWriteAllShops === true || enabledIds.has(normalizedShopId) || directIds.has(normalizedShopId)
    ));
  }

  function isDirectWriteShop(shopId) {
    const normalizedShopId = normalizeText(shopId);
    return Boolean(normalizedShopId && (directWriteAllShops === true || directIds.has(normalizedShopId)));
  }

  function ensureSchema(session) {
    for (const descriptor of descriptors) {
      session.db.exec(createTableSql(descriptor.tableName, descriptor.columns));
      const localColumns = tableColumns(session.db, descriptor.tableName);
      if (!isDeepStrictEqual(columnSignature(descriptor.columns), columnSignature(localColumns))) {
        const error = new Error('SHOP_PRODUCT_STORAGE_SCHEMA_MISMATCH');
        error.code = 'SHOP_PRODUCT_STORAGE_SCHEMA_MISMATCH';
        error.tableName = descriptor.tableName;
        throw error;
      }
      for (const indexSql of descriptor.indexes) {
        const idempotentIndexSql = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+/iu.test(indexSql)
          ? indexSql
          : indexSql.replace(
              /^CREATE\s+(UNIQUE\s+)?INDEX\s+/iu,
              (_match, unique = '') => `CREATE ${unique || ''}INDEX IF NOT EXISTS `,
            );
        session.db.exec(`${idempotentIndexSql};`);
      }
      descriptor.uniqueIndexes.forEach((indexColumns, index) => {
        const indexName = `uq_shop_product_${descriptor.tableName}_${index + 1}`;
        session.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)}
          ON ${quoteIdentifier(descriptor.tableName)} (${indexColumns.map(quoteIdentifier).join(', ')});
        `);
      });
      // Enforce ownership at the write boundary, including callers outside the router.
      for (const event of ['INSERT', 'UPDATE']) {
        session.db.exec(`
          CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`trg_product_owner_${descriptor.tableName}_${event.toLowerCase()}`)}
          BEFORE ${event} ON ${quoteIdentifier(descriptor.tableName)}
          WHEN NEW.shop_id <> COALESCE((SELECT shop_id FROM shop_database_metadata WHERE singleton = 1), '')
          BEGIN SELECT RAISE(ABORT, 'SHOP_PRODUCT_ROW_SCOPE_MISMATCH'); END;
        `);
      }
    }
    session.db.exec(`
      CREATE TABLE IF NOT EXISTS shop_product_storage_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        shop_incarnation TEXT NOT NULL,
        status TEXT NOT NULL,
        source_signature TEXT NOT NULL DEFAULT '',
        target_signature TEXT NOT NULL DEFAULT '',
        source_total INTEGER NOT NULL DEFAULT 0,
        target_total INTEGER NOT NULL DEFAULT 0,
        source_revision INTEGER NOT NULL DEFAULT 0,
        write_mode TEXT NOT NULL DEFAULT 'shadow_mirror',
        direct_write_revision INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        last_error_code TEXT
      );
    `);
    const stateColumns = session.db.prepare("PRAGMA table_info('shop_product_storage_state')").all();
    if (!stateColumns.some((column) => column.name === 'source_revision')) {
      session.db.exec('ALTER TABLE shop_product_storage_state ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;');
    }
    if (!stateColumns.some((column) => column.name === 'write_mode')) {
      session.db.exec("ALTER TABLE shop_product_storage_state ADD COLUMN write_mode TEXT NOT NULL DEFAULT 'shadow_mirror';");
    }
    if (!stateColumns.some((column) => column.name === 'direct_write_revision')) {
      session.db.exec('ALTER TABLE shop_product_storage_state ADD COLUMN direct_write_revision INTEGER NOT NULL DEFAULT 0;');
    }
    const timestamp = new Date().toISOString();
    session.db.prepare(`
      INSERT INTO shop_product_storage_state (
        singleton, schema_version, shop_incarnation, status, updated_at
      ) VALUES (1, ?, ?, 'pending', ?)
      ON CONFLICT(singleton) DO NOTHING
    `).run(PRODUCT_STORAGE_SCHEMA_VERSION, session.route.shopIncarnation, timestamp);
    const state = session.db.prepare(`
      SELECT schema_version, shop_incarnation
      FROM shop_product_storage_state
      WHERE singleton = 1
    `).get();
    if (
      Number(state?.schema_version) !== PRODUCT_STORAGE_SCHEMA_VERSION
      || state?.shop_incarnation !== session.route.shopIncarnation
    ) {
      const error = new Error('SHOP_PRODUCT_STORAGE_SCOPE_MISMATCH');
      error.code = 'SHOP_PRODUCT_STORAGE_SCOPE_MISMATCH';
      throw error;
    }
  }

  function persistFailure(session, error) {
    const errorCode = String(error?.code || error?.message || 'SHOP_PRODUCT_STORAGE_MIRROR_FAILED');
    try {
      session.db.prepare(`
        UPDATE shop_product_storage_state
        SET status = 'failed', updated_at = ?, last_error_code = ?
        WHERE singleton = 1
      `).run(new Date().toISOString(), errorCode);
    } catch {
      // The original storage error is more useful than a diagnostics write failure.
    }
    return errorCode;
  }

  function mirrorShop(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (ownerFences.has(shopId)) throw Object.assign(new Error('SHOP_PRODUCT_STORAGE_OWNER_FENCED'), { code: 'SHOP_PRODUCT_STORAGE_OWNER_FENCED' });
    if (!isEnabledShop(shopId)) {
      counters.skippedDisabled += 1;
      return Object.freeze({ ok: true, shopId, skipped: true, reason: 'shop_not_enabled' });
    }
    const session = shopDatabaseRouter.open(shopId, { expectedScopeToken: input.expectedScopeToken });
    ensureSchema(session);
    const mode = session.db.prepare('SELECT write_mode FROM shop_product_storage_state WHERE singleton = 1').get();
    if (mode?.write_mode === 'direct') {
      const error = new Error('SHOP_PRODUCT_STORAGE_DIRECT_MIRROR_FORBIDDEN');
      error.code = 'SHOP_PRODUCT_STORAGE_DIRECT_MIRROR_FORBIDDEN';
      throw error;
    }
    for (const descriptor of descriptors) {
      const foreign = session.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(descriptor.tableName)} WHERE shop_id <> ?`).get(shopId);
      if (Number(foreign.n)) {
        const error = new Error('SHOP_PRODUCT_STORAGE_FOREIGN_ROWS_DETECTED');
        error.code = 'SHOP_PRODUCT_STORAGE_FOREIGN_ROWS_DETECTED';
        throw error;
      }
    }
    ensureCanonicalRevisionRow(shopId);
    const startedAt = new Date().toISOString();
    session.db.prepare(`
      UPDATE shop_product_storage_state
      SET status = 'copying', started_at = ?, completed_at = NULL,
          updated_at = ?, last_error_code = NULL
      WHERE singleton = 1
    `).run(startedAt, startedAt);
    const sourceRevisionBefore = readCanonicalRevision(shopId);
    const sourceBefore = buildSummary(canonicalDb, descriptors, shopId);
    const sourceRows = new Map(descriptors.map((descriptor) => [
      descriptor.tableName,
      readRows(canonicalDb, descriptor, shopId),
    ]));
    const sourceAfterRead = buildSummary(canonicalDb, descriptors, shopId);
    const sourceRevisionAfter = readCanonicalRevision(shopId);
    if (
      sourceRevisionBefore !== sourceRevisionAfter
      || sourceBefore.signature !== sourceAfterRead.signature
    ) {
      const error = new Error('SHOP_PRODUCT_STORAGE_SOURCE_CHANGED_DURING_COPY');
      error.code = 'SHOP_PRODUCT_STORAGE_SOURCE_CHANGED_DURING_COPY';
      persistFailure(session, error);
      throw error;
    }

    session.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const descriptor of [...descriptors].reverse()) {
        session.db.prepare(`DELETE FROM ${quoteIdentifier(descriptor.tableName)}`).run();
      }
      for (const descriptor of descriptors) {
        const rows = sourceRows.get(descriptor.tableName) || [];
        const columnSql = descriptor.columns.map((column) => quoteIdentifier(column.name)).join(', ');
        const placeholders = descriptor.columns.map(() => '?').join(', ');
        const insert = session.db.prepare(`
          INSERT INTO ${quoteIdentifier(descriptor.tableName)} (${columnSql})
          VALUES (${placeholders})
        `);
        for (const row of rows) insert.run(...descriptor.columns.map((column) => row[column.name]));
      }
      const targetSummary = buildSummary(session.db, descriptors, shopId);
      if (
        targetSummary.signature !== sourceAfterRead.signature
        || targetSummary.totalRows !== sourceAfterRead.totalRows
      ) {
        const error = new Error('SHOP_PRODUCT_STORAGE_SUMMARY_MISMATCH');
        error.code = 'SHOP_PRODUCT_STORAGE_SUMMARY_MISMATCH';
        throw error;
      }
      for (const descriptor of descriptors) {
        const targetRows = readRows(session.db, descriptor, shopId);
        assertExactTableRows(descriptor, sourceRows.get(descriptor.tableName) || [], targetRows);
        const foreignTotal = Number(session.db.prepare(`
          SELECT COUNT(*) AS total
          FROM ${quoteIdentifier(descriptor.tableName)}
          WHERE shop_id <> ?
        `).get(shopId)?.total) || 0;
        if (foreignTotal !== 0) {
          const error = new Error('SHOP_PRODUCT_STORAGE_FOREIGN_ROWS_DETECTED');
          error.code = 'SHOP_PRODUCT_STORAGE_FOREIGN_ROWS_DETECTED';
          error.tableName = descriptor.tableName;
          throw error;
        }
      }
      const completedAt = new Date().toISOString();
      session.db.prepare(`
        UPDATE shop_product_storage_state
        SET status = 'completed', source_signature = ?, target_signature = ?,
            source_total = ?, target_total = ?, source_revision = ?, completed_at = ?, updated_at = ?,
            write_mode = ?, last_error_code = NULL
        WHERE singleton = 1
      `).run(
        sourceAfterRead.signature,
        targetSummary.signature,
        sourceAfterRead.totalRows,
        targetSummary.totalRows,
        sourceRevisionAfter,
        completedAt,
        completedAt,
        isDirectWriteShop(shopId) ? 'direct' : 'shadow_mirror',
      );
      shopDatabaseRouter.resolve(shopId, { expectedScopeToken: input.expectedScopeToken });
      session.db.exec('COMMIT;');
      counters.mirroredShops += 1;
      counters.mirroredRows += sourceAfterRead.totalRows;
      counters.verifiedRows += sourceAfterRead.totalRows;
      counters.lastShopId = shopId;
      try { onCommitted({ shopId, totalRows: sourceAfterRead.totalRows, signature: sourceAfterRead.signature }); } catch { /* observer only */ }
      return Object.freeze({
        ok: true,
        shopId,
        mirrored: sourceAfterRead.totalRows,
        verified: sourceAfterRead.totalRows,
        signature: sourceAfterRead.signature,
        sourceRevision: sourceRevisionAfter,
      });
    } catch (error) {
      try { session.db.exec('ROLLBACK;'); } catch { /* original error wins */ }
      persistFailure(session, error);
      throw error;
    }
  }

  function recordMirrorFailure(shopId, error, { worker = false } = {}) {
    counters.failures += 1;
    if (worker) counters.workerFailures += 1;
    counters.lastShopId = shopId;
    counters.lastErrorCode = String(error?.code || error?.message || 'SHOP_PRODUCT_STORAGE_MIRROR_FAILED');
    try { onError(error, { shopId }); } catch { /* observer only */ }
    return Object.freeze({ ok: false, shopId, errorCode: counters.lastErrorCode });
  }

  function drainInline(shopId) {
    const lane = lanes.get(shopId);
    if (!lane) return Object.freeze({ ok: true, skipped: true, reason: 'not_queued' });
    if (lane.running) return Object.freeze({ ok: true, shopId, skipped: true, reason: 'worker_running' });
    lanes.delete(shopId);
    try {
      return mirrorShop(lane);
    } catch (error) {
      return recordMirrorFailure(shopId, error);
    }
  }

  async function drainInBackground(shopId) {
    const lane = lanes.get(shopId);
    if (lifecycle.signal.aborted || ownerFences.has(shopId) || !lane || lane.running) return;
    lane.running = true;
    lane.attempts = (lane.attempts || 0) + 1;
    let result = null;
    let error = null;
    try {
      if (workerMirrorEnabled) {
        counters.workerRuns += 1;
        counters.activeWorkers += 1;
        result = await mirrorWorkerRunner({
          canonicalDatabasePath,
          targetDatabasePath: lane.route.databasePath,
          shopId,
          shopIncarnation: lane.route.shopIncarnation,
          expectedScopeToken: lane.expectedScopeToken,
          directWrite: isDirectWriteShop(shopId),
        }, { signal: AbortSignal.any([lifecycle.signal, lane.controller.signal]) });
        counters.mirroredShops += 1;
        counters.mirroredRows += Number(result?.mirrored) || 0;
        counters.verifiedRows += Number(result?.verified) || 0;
        counters.lastShopId = shopId;
        counters.lastErrorCode = '';
        try {
          if (!lifecycle.signal.aborted && !ownerFences.has(shopId) && !lane.controller.signal.aborted) onCommitted({
            shopId,
            totalRows: Number(result?.mirrored) || 0,
            signature: result?.signature || '',
          });
        } catch { /* observer only */ }
      } else {
        result = mirrorShop(lane);
      }
    } catch (caught) {
      error = caught;
      recordMirrorFailure(shopId, caught, { worker: workerMirrorEnabled });
    } finally {
      if (workerMirrorEnabled) counters.activeWorkers = Math.max(0, counters.activeWorkers - 1);
    }

    const currentLane = lanes.get(shopId);
    if (currentLane !== lane) return;
    lane.running = false;
    if (ownerFences.has(shopId) || lane.controller.signal.aborted) { lanes.delete(shopId); return; }
    const canonicalChangedAfterWorker = Boolean(
      workerMirrorEnabled
      && result?.ok === true
      && Number(result?.sourceRevision) !== readCanonicalRevision(shopId)
    );
    const retrySourceChange = String(error?.code || '') === 'SHOP_PRODUCT_STORAGE_SOURCE_CHANGED_DURING_COPY';
    // Once cut over, a legacy source update must never overwrite direct writes.
    if (result?.ok === true && isDirectWriteShop(shopId)) {
      lanes.delete(shopId);
      return;
    }
    if ((lane.rerunRequested || canonicalChangedAfterWorker || retrySourceChange)
      && lane.attempts < Math.max(1, Number(maxMirrorAttempts) || 3)) {
      lane.rerunRequested = false;
      counters.reruns += 1;
      backgroundRunner(() => { startBackgroundLane(shopId); });
      return;
    }
    lanes.delete(shopId);
  }

  function startBackgroundLane(shopId) {
    if (activeWork.has(shopId)) return;
    const task = drainInBackground(shopId);
    activeWork.set(shopId, task);
    const settled = () => { if (activeWork.get(shopId) === task) activeWork.delete(shopId); };
    task.then(settled, settled);
  }

  function enqueueShopSnapshot(input = {}) {
    if (lifecycle.signal.aborted) throw new Error('SHOP_PRODUCT_STORAGE_STOPPED');
    const shopId = requiredShopId(input.shopId);
    if (ownerFences.has(shopId)) return Object.freeze({ ok: true, shopId, accepted: 0, reason: 'owner_fenced' });
    if (!isEnabledShop(shopId)) {
      counters.skippedDisabled += 1;
      return Object.freeze({ ok: true, shopId, accepted: 0, reason: 'shop_not_enabled' });
    }
    if (isDirectWriteShop(shopId)) {
      const readiness = resolveVerifiedReadSession({
        shopId,
        expectedScopeToken: input.expectedScopeToken,
      });
      if (readiness.ready && readiness.writeMode === 'direct') {
        return Object.freeze({ ok: true, shopId, accepted: 0, pending: 0, reason: 'direct_write_ready' });
      }
      if (readiness.writeMode === 'direct') {
        const error = new Error('SHOP_PRODUCT_DIRECT_RECOVERY_REQUIRED');
        error.code = 'SHOP_PRODUCT_DIRECT_RECOVERY_REQUIRED';
        error.reason = readiness.reason;
        throw error;
      }
    }
    const existingLane = lanes.get(shopId);
    if (existingLane) {
      existingLane.rerunRequested ||= existingLane.running;
      counters.coalesced += 1;
      return Object.freeze({ ok: true, shopId, accepted: 0, pending: 1 });
    }
    const session = shopDatabaseRouter.open(shopId, { expectedScopeToken: input.expectedScopeToken });
    const route = session.route;
    lanes.set(shopId, {
      shopId,
      expectedScopeToken: route.scopeToken,
      route,
      running: false,
      controller: new AbortController(),
      rerunRequested: false,
    });
    counters.queued += 1;
    backgroundRunner(() => { startBackgroundLane(shopId); });
    return Object.freeze({ ok: true, shopId, accepted: 1, pending: 1 });
  }

  function flush(shopIdInput = '') {
    const shopId = normalizeText(shopIdInput);
    const targets = shopId ? [shopId] : [...lanes.keys()];
    const results = targets.map((target) => drainInline(target));
    return Object.freeze({
      ok: results.every((result) => result.ok !== false),
      results: Object.freeze(results),
    });
  }

  async function quiesceOwner(shopIdInput, { timeoutMs = 30_000 } = {}) {
    const shopId = requiredShopId(shopIdInput);
    ownerFences.add(shopId);
    const lane = lanes.get(shopId);
    lane?.controller?.abort();
    if (lane && !lane.running) lanes.delete(shopId);
    const pending = activeWork.get(shopId);
    if (pending) {
      let timer;
      try {
        await Promise.race([pending.catch(() => undefined), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('SHOP_PRODUCT_STORAGE_QUIESCE_TIMEOUT'), { code: 'SHOP_PRODUCT_STORAGE_QUIESCE_TIMEOUT' })), Math.max(1, Number(timeoutMs) || 30_000));
        })]);
      } finally { clearTimeout(timer); }
    }
    return getOwnerStatus(shopId);
  }

  function getOwnerStatus(shopIdInput) {
    const shopId = normalizeText(shopIdInput);
    return { fenced: ownerFences.has(shopId), active: activeWork.has(shopId) ? 1 : 0, queued: lanes.has(shopId) ? 1 : 0 };
  }

  function releaseOwner(shopIdInput) {
    const shopId = requiredShopId(shopIdInput);
    if (activeWork.has(shopId)) throw Object.assign(new Error('SHOP_PRODUCT_STORAGE_QUIESCE_TIMEOUT'), { code: 'SHOP_PRODUCT_STORAGE_QUIESCE_TIMEOUT' });
    ownerFences.delete(shopId);
    return getOwnerStatus(shopId);
  }

  function verifyShop(input = {}) {
    const shopId = requiredShopId(input.shopId);
    const session = shopDatabaseRouter.open(shopId, {
      expectedScopeToken: input.expectedScopeToken,
      createIfMissing: false,
    });
    ensureSchema(session);
    let verifiedRows = 0;
    for (const descriptor of descriptors) {
      const sourceRows = readRows(canonicalDb, descriptor, shopId);
      const targetRows = readRows(session.db, descriptor, shopId);
      assertExactTableRows(descriptor, sourceRows, targetRows);
      const foreignTotal = Number(session.db.prepare(`
        SELECT COUNT(*) AS total FROM ${quoteIdentifier(descriptor.tableName)} WHERE shop_id <> ?
      `).get(shopId)?.total) || 0;
      if (foreignTotal !== 0) {
        const error = new Error('SHOP_PRODUCT_STORAGE_FOREIGN_ROWS_DETECTED');
        error.code = 'SHOP_PRODUCT_STORAGE_FOREIGN_ROWS_DETECTED';
        error.tableName = descriptor.tableName;
        throw error;
      }
      verifiedRows += sourceRows.length;
    }
    const source = buildSummary(canonicalDb, descriptors, shopId);
    const target = buildSummary(session.db, descriptors, shopId);
    return Object.freeze({
      ok: source.signature === target.signature && source.totalRows === target.totalRows,
      shopId,
      sourceTotal: source.totalRows,
      targetTotal: target.totalRows,
      verifiedRows,
      sourceSignature: source.signature,
      targetSignature: target.signature,
    });
  }

  function resolveVerifiedReadSession(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (!isEnabledShop(shopId)) {
      return Object.freeze({ ready: false, reason: 'shop_not_enabled', shopId, db: null });
    }
    try {
      const session = shopDatabaseRouter.open(shopId, {
        expectedScopeToken: input.expectedScopeToken,
        createIfMissing: false,
      });
      const state = session.db.prepare(`
        SELECT schema_version, shop_incarnation, status, source_signature,
               target_signature, source_total, target_total, source_revision,
               write_mode, direct_write_revision, last_error_code
        FROM shop_product_storage_state
        WHERE singleton = 1
      `).get();
      let reason = '';
      if (!state || state.status !== 'completed') reason = 'product_copy_not_completed';
      else if (
        Number(state.schema_version) !== PRODUCT_STORAGE_SCHEMA_VERSION
        || state.shop_incarnation !== session.route.shopIncarnation
      ) reason = 'scope_or_schema_mismatch';
      else if (state.last_error_code) reason = 'product_copy_has_error';
      else if (lanes.has(shopId)) reason = 'product_copy_pending';
      const writeMode = normalizeText(state?.write_mode) || 'shadow_mirror';
      const canonicalRevision = reason || writeMode === 'direct' ? 0 : readCanonicalRevision(shopId);
      if (!reason && writeMode !== 'direct' && canonicalRevision !== Number(state.source_revision)) {
        reason = 'canonical_changed_since_verification';
      }
      return Object.freeze({
        ready: !reason,
        reason,
        shopId,
        db: reason ? null : session.db,
        route: session.route,
        sourceTotal: Number(state?.source_total) || 0,
        targetTotal: Number(state?.target_total) || 0,
        sourceRevision: Number(state?.source_revision) || 0,
        directWriteRevision: Number(state?.direct_write_revision) || 0,
        writeMode,
        canonicalRevision,
      });
    } catch (error) {
      return Object.freeze({
        ready: false,
        reason: String(error?.code || error?.message || 'product_readiness_check_failed'),
        shopId,
        db: null,
      });
    }
  }

  function initializeDirectShop(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (!isDirectWriteShop(shopId)) {
      return Object.freeze({ ok: true, shopId, initialized: false, reason: 'direct_write_not_enabled' });
    }
    const session = shopDatabaseRouter.open(shopId, { expectedScopeToken: input.expectedScopeToken });
    ensureSchema(session);
    const state = session.db.prepare('SELECT * FROM shop_product_storage_state WHERE singleton = 1').get();
    if (state.write_mode === 'direct') {
      return Object.freeze({ ok: true, shopId, initialized: false, reason: 'already_direct', route: session.route });
    }
    const sourceTotal = buildSummary(canonicalDb, descriptors, shopId).totalRows;
    const targetTotal = descriptors.reduce((total, descriptor) => total + Number(
      session.db.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(descriptor.tableName)}`).get().total,
    ), 0);
    if (sourceTotal || targetTotal || lanes.has(shopId)) {
      return Object.freeze({ ok: true, shopId, initialized: false, requiresBackfill: true, sourceTotal, targetTotal });
    }
    const timestamp = new Date().toISOString();
    session.db.prepare(`
      UPDATE shop_product_storage_state
      SET status = 'completed', source_signature = '', target_signature = '',
          source_total = 0, target_total = 0, source_revision = 0,
          write_mode = 'direct', direct_write_revision = 0,
          started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ?, last_error_code = NULL
      WHERE singleton = 1
    `).run(timestamp, timestamp, timestamp);
    return Object.freeze({ ok: true, shopId, initialized: true, route: session.route });
  }

  function resolveDirectWriteSession(input = {}) {
    const shopId = requiredShopId(input.shopId);
    if (!isDirectWriteShop(shopId)) {
      const error = new Error('SHOP_PRODUCT_DIRECT_WRITE_NOT_ENABLED');
      error.code = 'SHOP_PRODUCT_DIRECT_WRITE_NOT_ENABLED';
      throw error;
    }
    const readiness = resolveVerifiedReadSession({ shopId, expectedScopeToken: input.expectedScopeToken });
    if (!readiness.ready || readiness.writeMode !== 'direct' || !readiness.db) {
      const error = new Error('SHOP_PRODUCT_DIRECT_WRITE_NOT_READY');
      error.code = 'SHOP_PRODUCT_DIRECT_WRITE_NOT_READY';
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
      UPDATE shop_product_storage_state
      SET direct_write_revision = direct_write_revision + 1,
          updated_at = ?, last_error_code = NULL
      WHERE singleton = 1 AND write_mode = 'direct' AND status = 'completed'
    `).run(timestamp);
    return Object.freeze({ ok: true, shopId, updatedAt: timestamp });
  }

  function snapshot() {
    return Object.freeze({
      mode: 'one-shop-product-copy-with-verified-read-cutover',
      schemaVersion: PRODUCT_STORAGE_SCHEMA_VERSION,
      workerMirrorEnabled,
      canonicalDatabasePath: canonicalDatabasePath || null,
      enabledShopIds: Object.freeze([...enabledIds]),
      directWriteShopIds: Object.freeze([...directIds]),
      directWriteAllShops: directWriteAllShops === true,
      pendingShops: lanes.size,
      tableCount: descriptors.length,
      ...counters,
    });
  }

  return Object.freeze({
    stop() { lanes.clear(); lifecycle.abort(); },
    quiesceOwner,
    getOwnerStatus,
    releaseOwner,
    enqueueShopSnapshot,
    mirrorShop,
    verifyShop,
    resolveVerifiedReadSession,
    resolveDirectWriteSession,
    initializeDirectShop,
    recordDirectWrite,
    isEnabledShop,
    isDirectWriteShop,
    flush,
    snapshot,
  });
}

export const shopProductStorageInternals = Object.freeze({
  PRODUCT_TABLES,
  PRODUCT_STORAGE_SCHEMA_VERSION,
});

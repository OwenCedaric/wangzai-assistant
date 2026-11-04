import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createProfitLedgerSnapshotRepository, readPublishedProfitSnapshots } from './repositories/profitLedgerSnapshotRepository.js';

const text = (value) => value == null ? '' : String(value).trim();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keys = (value) => [...new Set((Array.isArray(value) ? value : [value]).flatMap((v) => text(v).split(',')).filter(Boolean))];
const owner = (row) => text(row?.shopId || row?.orderSnapshot?.shopId);
const prefix = (shopId) => `shop-profit:${encodeURIComponent(shopId)}:`;
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const isChunk = (snapshot) => snapshot.persistenceFormat === 'profit-ledger-chunk-v1';

// Partition data only. Amount objects, exchange rates, formulas and results
// are copied verbatim; no calculation function belongs in this module.
function sliceSnapshot(snapshot, shopId, independent) {
  const matches = (row) => independent ? owner(row) === shopId : owner(row) !== shopId;
  const rows = (snapshot.rows || []).filter(matches);
  const next = { ...snapshot, rows, total: rows.length, rowCount: rows.length };
  for (const field of ['penaltyDetails', 'profitPenaltyDetails']) {
    if (!snapshot[field] || Array.isArray(snapshot[field])) continue;
    next[field] = Object.fromEntries(Object.entries(snapshot[field]).filter(([, record]) => matches(record)));
  }
  if (independent) {
    next.ownerShopId = shopId;
    next.errors = (snapshot.errors || []).filter((entry) => owner(entry) === shopId);
  } else if (Array.isArray(snapshot.errors)) {
    next.errors = snapshot.errors.filter((entry) => owner(entry) !== shopId);
  }
  return next;
}

function copyTable(db, name, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const statement = db.prepare(`INSERT INTO ${name} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (const row of rows) statement.run(...columns.map((key) => row[key]));
}

export function createShopProfitLedgerStorage({ canonicalDb, shopDatabaseRouter, shopRepository, directShopIds = [], backupRoot } = {}) {
  const enabled = new Set(keys(directShopIds));
  const shared = createProfitLedgerSnapshotRepository(canonicalDb);
  const databasePath = canonicalDb.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
  const backups = backupRoot || (databasePath ? join(dirname(databasePath), 'backups', 'profit-shop-migrations') : '');
  if (enabled.size && (!shopDatabaseRouter?.open || !shopRepository || !backups)) fail('SHOP_PROFIT_STORAGE_CONFIGURATION_REQUIRED');
  if (enabled.size) canonicalDb.exec(`CREATE TABLE IF NOT EXISTS profit_ledger_owner_routes (
    shop_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, shop_incarnation TEXT NOT NULL,
    status TEXT NOT NULL, backup_path TEXT NOT NULL, source_hash TEXT NOT NULL,
    migrated_rows INTEGER NOT NULL, migrated_at TEXT NOT NULL
  )`);
  if (enabled.size) {
    for (const [name, event] of [['insert', 'INSERT'], ['update', 'UPDATE OF snapshot_json']]) canonicalDb.exec(`
      CREATE TRIGGER IF NOT EXISTS profit_shared_owner_${name} BEFORE ${event} ON profit_ledger_snapshots
      WHEN EXISTS (SELECT 1 FROM json_each(NEW.snapshot_json,'$.rows') row
        JOIN profit_ledger_owner_routes route ON route.shop_id=json_extract(row.value,'$.shopId') WHERE route.status='active')
      BEGIN SELECT RAISE(ABORT,'SHOP_PROFIT_INDEPENDENT_PARTITION_REQUIRED'); END`);
  }
  const schema = canonicalDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='profit_ledger_snapshots'").get()?.sql;

  function ensureTarget(session) {
    session.db.exec(schema.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
    const sourceColumns = canonicalDb.prepare('PRAGMA table_info(profit_ledger_snapshots)').all().map((column) => column.name);
    const targetColumns = session.db.prepare('PRAGMA table_info(profit_ledger_snapshots)').all().map((column) => column.name);
    if (!isDeepStrictEqual(sourceColumns, targetColumns)) fail('SHOP_PROFIT_TARGET_SCHEMA_MISMATCH');
    session.db.exec(`CREATE INDEX IF NOT EXISTS idx_profit_ledger_snapshots_scope_updated ON profit_ledger_snapshots(logical_scope,updated_at DESC)`);
    session.db.exec(`CREATE TRIGGER IF NOT EXISTS profit_owner_insert BEFORE INSERT ON profit_ledger_snapshots
      WHEN EXISTS (SELECT 1 FROM json_each(NEW.snapshot_json,'$.rows')
        WHERE COALESCE(json_extract(value,'$.shopId'),'') <> (SELECT shop_id FROM shop_database_metadata WHERE singleton=1))
      BEGIN SELECT RAISE(ABORT,'SHOP_PROFIT_ROW_OWNER_MISMATCH'); END`);
    session.db.exec(`CREATE TRIGGER IF NOT EXISTS profit_owner_update BEFORE UPDATE OF snapshot_json ON profit_ledger_snapshots
      WHEN EXISTS (SELECT 1 FROM json_each(NEW.snapshot_json,'$.rows')
        WHERE COALESCE(json_extract(value,'$.shopId'),'') <> (SELECT shop_id FROM shop_database_metadata WHERE singleton=1))
      BEGIN SELECT RAISE(ABORT,'SHOP_PROFIT_ROW_OWNER_MISMATCH'); END`);
  }

  function routeRecord(shopId) {
    return canonicalDb.prepare('SELECT * FROM profit_ledger_owner_routes WHERE shop_id=?').get(shopId);
  }

  function migrateShop(shopId) {
    if (!enabled.has(shopId)) fail('SHOP_PROFIT_PILOT_NOT_ENABLED');
    const current = routeRecord(shopId);
    const route = shopDatabaseRouter.resolve(shopId);
    const session = shopDatabaseRouter.open(shopId, { createIfMissing: current?.shop_incarnation !== route.shopIncarnation });
    if (current?.shop_incarnation === route.shopIncarnation
      && !session.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profit_ledger_snapshots'").get()) fail('SHOP_PROFIT_ACTIVE_TABLE_MISSING');
    ensureTarget(session);
    if (current?.shop_incarnation === session.route.shopIncarnation) {
      if (current.status !== 'active' || current.profile_id !== session.route.profileId) fail('SHOP_PROFIT_MIGRATION_SCOPE_CHANGED');
      return { shopId, migrated: false, rows: current.migrated_rows, backupPath: current.backup_path };
    }
    if (current && current.profile_id !== session.route.profileId) fail('SHOP_PROFIT_MIGRATION_SCOPE_CHANGED');
    let targetTransaction = false;
    canonicalDb.exec('BEGIN IMMEDIATE');
    try {
      const sourceRows = canonicalDb.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all();
      const heads = readPublishedProfitSnapshots(canonicalDb);
      const expected = new Map(heads.map((head) => [head.snapshot_key, head.snapshot.rows.filter((row) => owner(row) === shopId)]));
      if (current && [...expected.values()].some((rows) => rows.length)) fail('SHOP_PROFIT_REBOUND_SOURCE_CONFLICT');
      const targetBefore = session.db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all();
      const sourceDigest = hash(sourceRows);
      mkdirSync(backups, { recursive: true });
      const backupPath = join(backups, `${Date.now()}-${randomUUID()}.sqlite`);
      const backup = new DatabaseSync(backupPath);
      try {
        backup.exec(schema);
        copyTable(backup, 'profit_ledger_snapshots', sourceRows);
        backup.exec('CREATE TABLE target_profit_preimage AS SELECT * FROM profit_ledger_snapshots WHERE 0');
        copyTable(backup, 'target_profit_preimage', targetBefore);
        backup.exec('CREATE TABLE owner_route_preimage (payload TEXT NOT NULL)');
        if (current) backup.prepare('INSERT INTO owner_route_preimage VALUES (?)').run(JSON.stringify(current));
        if (hash(backup.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all()) !== sourceDigest) fail('SHOP_PROFIT_BACKUP_READBACK_FAILED');
        if (backup.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('SHOP_PROFIT_BACKUP_INTEGRITY_FAILED');
      } finally { backup.close(); }
      const targetRows = [];
      const sharedUpdates = [];
      for (const record of sourceRows) {
        const original = JSON.parse(record.snapshot_json);
        const rootKey = original.chunkOf || record.snapshot_key;
        if (!expected.has(rootKey) || !expected.get(rootKey).length) {
          if ((original.rows || []).some((row) => owner(row) === shopId)) sharedUpdates.push({ ...record, snapshot_json: JSON.stringify(sliceSnapshot(original, shopId, false)) });
          continue;
        }
        const own = sliceSnapshot(original, shopId, true);
        const remainder = sliceSnapshot(original, shopId, false);
        if (original.chunkKeys) {
          own.chunkKeys = original.chunkKeys.map((key) => prefix(shopId) + key);
          own.total = own.rowCount = expected.get(record.snapshot_key).length;
          remainder.total = remainder.rowCount = (heads.find((head) => head.snapshot_key === record.snapshot_key)?.snapshot.rows.length || 0) - own.rowCount;
        }
        if (own.chunkOf) own.chunkOf = prefix(shopId) + own.chunkOf;
        if (isChunk(original)) { own.chunkCount = original.chunkCount; remainder.chunkCount = original.chunkCount; }
        targetRows.push({ ...record, snapshot_key: prefix(shopId) + record.snapshot_key,
          logical_scope: prefix(shopId) + record.logical_scope, snapshot_json: JSON.stringify(own) });
        sharedUpdates.push({ ...record, snapshot_json: JSON.stringify(remainder) });
      }
      // A retried migration may encounter an identical prepared target after
      // a crash. Never overwrite an unrelated or newer independent cache.
      if (targetBefore.length && hash(targetBefore) !== hash(targetRows)) fail('SHOP_PROFIT_TARGET_PREIMAGE_CONFLICT');
      session.db.exec('BEGIN IMMEDIATE'); targetTransaction = true;
      if (!targetBefore.length) copyTable(session.db, 'profit_ledger_snapshots', targetRows);
      const ownRepository = createProfitLedgerSnapshotRepository(session.db);
      for (const [key, rows] of expected) {
        if (!rows.length) continue;
        const result = ownRepository.readSnapshot({ snapshotKey: prefix(shopId) + key });
        if (!result.ok || !isDeepStrictEqual(result.snapshot?.rows, rows)) fail('SHOP_PROFIT_TARGET_READBACK_MISMATCH');
      }
      session.db.exec('COMMIT'); targetTransaction = false;
      const update = canonicalDb.prepare('UPDATE profit_ledger_snapshots SET snapshot_json=? WHERE snapshot_key=?');
      for (const record of sharedUpdates) update.run(record.snapshot_json, record.snapshot_key);
      for (const head of heads) {
        const readback = shared.readSnapshot({ snapshotKey: head.snapshot_key });
        const otherRows = head.snapshot.rows.filter((row) => owner(row) !== shopId);
        if (!readback.ok || !isDeepStrictEqual(readback.snapshot.rows, otherRows)) fail('SHOP_PROFIT_SHARED_READBACK_MISMATCH');
      }
      const migratedRows = [...expected.values()].reduce((sum, rows) => sum + rows.length, 0);
      canonicalDb.prepare(`INSERT INTO profit_ledger_owner_routes VALUES (?,?,?,'active',?,?,?,?)
        ON CONFLICT(shop_id) DO UPDATE SET profile_id=excluded.profile_id,shop_incarnation=excluded.shop_incarnation,status=excluded.status,
        backup_path=excluded.backup_path,source_hash=excluded.source_hash,migrated_rows=excluded.migrated_rows,migrated_at=excluded.migrated_at`)
        .run(shopId, session.route.profileId, session.route.shopIncarnation, backupPath, sourceDigest, migratedRows, new Date().toISOString());
      canonicalDb.exec('COMMIT');
      return { shopId, migrated: true, rows: migratedRows, backupPath, sourceHash: sourceDigest };
    } catch (error) {
      if (targetTransaction) session.db.exec('ROLLBACK');
      canonicalDb.exec('ROLLBACK');
      throw error;
    }
  }

  function initialize() { return [...enabled].filter((id) => shopRepository.getPublicShopById(id)?.status === 'active').map(migrateShop); }
  function layout() {
    return { ok: true, partitioned: enabled.size > 0, atomicBatchWrite: true, independentShopIds: [...enabled].filter((id) => {
      const record = routeRecord(id);
      return record?.status === 'active' && shopRepository.getPublicShopById(id)?.status === 'active';
    }) };
  }
  function ownRepository(shopId) {
    if (!enabled.has(shopId) || routeRecord(shopId)?.status !== 'active') fail('SHOP_PROFIT_ROUTE_NOT_READY');
    const session = shopDatabaseRouter.open(shopId, { createIfMissing: false });
    const marker = routeRecord(shopId);
    if (marker.profile_id !== session.route.profileId || marker.shop_incarnation !== session.route.shopIncarnation) fail('SHOP_PROFIT_ROUTE_SCOPE_CHANGED');
    return createProfitLedgerSnapshotRepository(session.db);
  }
  function queryKeys(input) { return keys(input.snapshotKey ?? input.snapshotKeys ?? input.snapshot_key ?? input.keys); }
  function ownKeys(shopId, values) { return values.map((key) => prefix(shopId) + key); }
  function read(input = {}) {
    const requested = queryKeys(input), shopId = text(input.shopId);
    if (shopId) {
      const result = ownRepository(shopId).readSnapshot({ snapshotKeys: ownKeys(shopId, requested) });
      if ((result.snapshot?.rows || []).some((row) => owner(row) !== shopId)) fail('SHOP_PROFIT_ROW_OWNER_MISMATCH');
      return { ...result, snapshotKey: result.snapshotKey?.slice(prefix(shopId).length), shopId, storage: 'shop' };
    }
    const result = shared.readSnapshot(input);
    if (input.sharedOnly === true || input.sharedOnly === 'true' || input.sharedOnly === '1' || !enabled.size) return result;
    const parts = [result, ...layout().independentShopIds.map((id) => read({ ...input, shopId: id }))];
    const failed = parts.find((part) => part.ok === false); if (failed) return failed;
    const available = parts.filter((part) => part.snapshot);
    if (!available.length) return result;
    const rows = available.flatMap((part) => part.snapshot.rows || []);
    return { ok: true, source: 'partitioned-sqlite', snapshotKey: available[0].snapshotKey,
      snapshot: { ...available[0].snapshot, persistenceFormat: 'profit-ledger-partitioned-v1', rows, total: rows.length, rowCount: rows.length,
        penaltyDetails: Object.assign({}, ...available.map((part) => part.snapshot.penaltyDetails || {})) } };
  }
  function save(input = {}) {
    const shopId = text(input.shopId);
    if (!queryKeys(input)[0]) fail('PROFIT_LEDGER_SNAPSHOT_KEY_REQUIRED');
    const snapshot = input.snapshot || {};
    if (input.chunks !== undefined && !shopId) fail('SHOP_PROFIT_BATCH_OWNER_REQUIRED');
    if (shopId) {
      if ((snapshot.rows || []).some((row) => owner(row) !== shopId)) fail('SHOP_PROFIT_ROW_OWNER_MISMATCH');
      if (input.chunks !== undefined && (!Array.isArray(input.chunks)
        || input.chunks.some((chunk) => !Array.isArray(chunk?.rows) || chunk.rows.some((row) => owner(row) !== shopId)))) fail('SHOP_PROFIT_ROW_OWNER_MISMATCH');
      const repository = ownRepository(shopId);
      const payload = { ...input,
        snapshotKey: prefix(shopId) + queryKeys(input)[0],
        ...(input.chunkOf ? { chunkOf: prefix(shopId) + input.chunkOf } : {}),
        snapshot: { ...snapshot, ownerShopId: shopId,
          ...(snapshot.chunkKeys ? { chunkKeys: ownKeys(shopId, snapshot.chunkKeys) } : {}) },
      };
      const result = input.chunks !== undefined ? repository.saveSnapshotBundle(payload) : repository.saveSnapshot(payload);
      if (result.stats?.batchWrite) console.info('[profit-owner-batch-save]', JSON.stringify({
        shopId, rows: result.stats.rowCount, chunks: result.stats.chunkCount, saveDurationMs: result.stats.saveDurationMs,
      }));
      return { ...result, snapshotKey: queryKeys(input)[0], shopId, storage: 'shop' };
    }
    if ((snapshot.rows || []).some((row) => enabled.has(owner(row)))) fail('SHOP_PROFIT_INDEPENDENT_PARTITION_REQUIRED');
    return shared.saveSnapshot(input);
  }
  function clear(input = {}) {
    const shopId = text(input.shopId);
    if (shopId) return ownRepository(shopId).clearSnapshots({ snapshotKeys: ownKeys(shopId, queryKeys(input)) });
    const results = [shared.clearSnapshots(input)];
    if (!input.sharedOnly) for (const id of layout().independentShopIds) results.push(clear({ ...input, shopId: id }));
    return { ok: true, source: 'partitioned-sqlite', stats: { changed: results.some((r) => r.stats.changed), removedSnapshots: results.reduce((sum, r) => sum + r.stats.removedSnapshots, 0) } };
  }
  return { initialize, layout, readSnapshot: read, saveSnapshot: save, clearSnapshots: clear };
}

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { initializeDatabase } from '../src/db/database.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createShopDatabaseManager } from '../src/db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../src/db/shopDatabaseRouter.js';
import { createShopProfitLedgerStorage } from '../src/db/shopProfitLedgerStorage.js';
import { readPublishedProfitSnapshots } from '../src/db/repositories/profitLedgerSnapshotRepository.js';

const args = process.argv.slice(2);
const option = (key) => args.includes(key) ? args[args.indexOf(key) + 1] : '';
if (!option('--source') || !option('--shop-id') || !option('--report')) throw new Error('Required: --source --shop-id --report');
const sourcePath = resolve(option('--source')), shopId = option('--shop-id');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source = new DatabaseSync(sourcePath, { readOnly: true });
source.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=5000;BEGIN');
const records = source.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all();
const sourceHeads = readPublishedProfitSnapshots(source);
const shopRows = source.prepare("SELECT id,name,alias,client_id FROM shops WHERE status='active'").all();
source.exec('ROLLBACK'); source.close();
assert.ok(shopRows.some((row) => row.id === shopId), 'pilot must be an existing active shop');
const root = mkdtempSync(join(tmpdir(), 'wangzai-real-profit-rehearsal-'));
const { db } = initializeDatabase({ database: { path: join(root, 'profile.sqlite'), enableWal: false, busyTimeoutMs: 5000 } });
const profileId = `rehearsal-${randomUUID()}`;
const shops = createShopRepository(db, { profileId });
const manager = createShopDatabaseManager({ root: join(root, 'shops'), profileId });
const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
try {
  // Only public shop identity is copied. Real credentials never enter this test.
  for (const row of shopRows) shops.saveShop({ id: row.id, name: row.name, alias: row.alias,
    clientId: row.client_id, apiKey: `synthetic-${randomUUID()}`, status: 'active' });
  const columns = Object.keys(records[0]);
  const insert = db.prepare(`INSERT INTO profit_ledger_snapshots (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  db.exec('BEGIN'); for (const record of records) insert.run(...columns.map((column) => record[column])); db.exec('COMMIT');
  const storage = createShopProfitLedgerStorage({ canonicalDb: db, shopRepository: shops, shopDatabaseRouter: router, directShopIds: [shopId], backupRoot: join(root, 'backups') });
  let started = performance.now(); const migrated = storage.initialize()[0]; const migrationMs = Math.round(performance.now() - started);
  let verifiedOwnerRows = 0, verifiedOtherRows = 0;
  for (const head of sourceHeads) {
    const own = head.snapshot.rows.filter((row) => row.shopId === shopId);
    const other = head.snapshot.rows.filter((row) => row.shopId !== shopId);
    const ownRead = storage.readSnapshot({ snapshotKey: head.snapshot_key, shopId }).snapshot;
    assert.deepEqual(ownRead?.rows || [], own);
    assert.deepEqual(storage.readSnapshot({ snapshotKey: head.snapshot_key, sharedOnly: true }).snapshot.rows, other);
    verifiedOwnerRows += own.length; verifiedOtherRows += other.length;
  }
  for (const row of shopRows.filter((row) => row.id !== shopId)) assert.equal(existsSync(router.resolve(row.id).databasePath), false);
  const current = sourceHeads[0];
  const currentOwn = storage.readSnapshot({ snapshotKey: current.snapshot_key, shopId }).snapshot;
  const sharedBefore = hash(db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all());
  started = performance.now();
  storage.saveSnapshot({ shopId, snapshotKey: current.snapshot_key, snapshot: {
    ...currentOwn, persistenceFormat: 'profit-ledger-compact-v1', chunkKeys: undefined, writeId: undefined,
  } });
  const ownSaveMs = Math.round(performance.now() - started);
  assert.equal(hash(db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all()), sharedBefore);
  assert.deepEqual(storage.readSnapshot({ snapshotKey: current.snapshot_key, shopId }).snapshot.rows, currentOwn.rows);
  manager.closeAll();
  assert.deepEqual(storage.readSnapshot({ snapshotKey: current.snapshot_key, shopId }).snapshot.rows, currentOwn.rows);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM profit_ledger_snapshots s,json_each(s.snapshot_json,'$.rows') r WHERE json_extract(r.value,'$.shopId')=?`).get(shopId).n, 0);
  const report = { rehearsal: true, sourceOpenedReadOnly: true, shopId, sourcePublishedScopes: sourceHeads.length,
    currentTotalOrders: current.snapshot.rows.length, currentPilotOrders: currentOwn.rows.length,
    verifiedOwnerRowsAcrossHistory: verifiedOwnerRows, verifiedOtherRowsAcrossHistory: verifiedOtherRows,
    allAmountsRatesResultsUnchanged: true, otherShopFilesNotOpenedOrChanged: true,
    independentSaveDidNotWriteSharedTable: true, restartReadbackIdentical: true,
    sourceProfitTableDigest: hash(records), migrationMs, ownSaveMs, backupVerified: existsSync(migrated.backupPath) };
  writeFileSync(resolve(option('--report')), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  manager.closeAll(); db.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  rmSync(root, { recursive: true, force: true });
}

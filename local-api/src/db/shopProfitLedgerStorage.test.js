import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createShopRepository } from './repositories/shopRepository.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createProfitLedgerSnapshotRepository, readPublishedProfitSnapshots } from './repositories/profitLedgerSnapshotRepository.js';
import { createShopProfitLedgerStorage } from './shopProfitLedgerStorage.js';
import { createShopFederatedReadDatabase } from './shopFederatedReadDatabase.js';
import { createApp } from '../app/createApp.js';

const VERSION = 'profit-ledger-v16-per-order-finance-exchange-rate';
const KEY = 'all-shops:range:all-history';
const records = [1, 2, 3].map((n) => ({ shopId: `shop-${n}`, shopClientId: `client-${n}`, ledgerKey: `shop-${n}:same-1`,
  calculationVersion: VERSION, orderSnapshot: { posting: 'same-1' },
  amounts: { sourcePurchaseCostCny: { value: n, status: 'ready' }, actualCommissionFeeCny: { value: n * 2, status: 'ready' } },
  results: { actualProfitCny: { value: 100 - n * 3, status: 'ready', formula: 'existing-formula' } },
  penaltyDetails: [{ shopId: `shop-${n}`, dedupeKey: `penalty-${n}`, amountCny: n }],
}));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-profit-pilot-'));
  const db = createMigratedTestDb(join(root, 'main.sqlite'));
  const shops = createShopRepository(db, { profileId: 'profit-pilot-profile' });
  for (const n of [1, 2, 3]) shops.saveShop({ id: `shop-${n}`, name: `店${n}`, clientId: `client-${n}`, apiKey: `test-only-${n}`, status: 'active' });
  const manager = createShopDatabaseManager({ root: join(root, 'shops'), profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const shared = createProfitLedgerSnapshotRepository(db);
  const chunkKeys = [0, 1].map((n) => `${KEY}::chunk:old:${n}`);
  chunkKeys.forEach((key, n) => shared.saveSnapshot({ snapshotKey: key, snapshot: { calculationVersion: VERSION, rows: n ? records.slice(1) : records.slice(0, 1) }, chunkOf: KEY, writeId: 'old', chunkIndex: n, chunkCount: 2 }));
  shared.saveSnapshot({ snapshotKey: KEY, snapshot: { calculationVersion: VERSION, rows: [], rowCount: 3, chunkKeys, writeId: 'old', persistenceFormat: 'profit-ledger-chunked-v1', penaltyDetails: Object.fromEntries(records.map((r, n) => [`p-${n}`, r.penaltyDetails[0]])) } });
  const storage = createShopProfitLedgerStorage({ canonicalDb: db, shopRepository: shops, shopDatabaseRouter: router, directShopIds: ['shop-1'], backupRoot: join(root, 'backups') });
  return { root, db, shops, manager, router, shared, storage, close() { manager.closeAll(); db.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); } };
}
test('pilot migrates only shop 1, preserves every amount and other-shop row, and reports aggregate data without duplicates', () => {
  const f = fixture(); let federated;
  try {
    const proof = f.storage.initialize()[0];
    assert.equal(proof.rows, 1); assert.ok(existsSync(proof.backupPath));
    assert.deepEqual(f.shared.readSnapshot({ snapshotKey: KEY }).snapshot.rows, records.slice(1));
    assert.deepEqual(f.storage.readSnapshot({ keys: [KEY], shopId: 'shop-1' }).snapshot.rows, records.slice(0, 1));
    assert.deepEqual(f.storage.readSnapshot({ keys: [KEY] }).snapshot.rows.map((r) => r.shopId).sort(), ['shop-1', 'shop-2', 'shop-3']);
    assert.equal(f.storage.initialize()[0].migrated, false);
    for (const id of ['shop-2', 'shop-3']) assert.equal(f.manager.has(f.shops.identityRepository.createScopeToken(id, f.shops.profileId)), false);
    // Stores not yet cut over remain explicitly canonical during a pilot.
    federated = createShopFederatedReadDatabase({ canonicalDb: f.db, shopRepository: f.shops, shopDatabaseRouter: f.router, profitLedgerDirectShopIds: ['shop-1'], requiredShopIds: ['shop-1'] });
    const all = readPublishedProfitSnapshots(federated.db).flatMap((h) => h.snapshot.rows);
    assert.equal(all.length, 3); assert.equal(new Set(all.map((r) => r.ledgerKey)).size, 3);
    assert.deepEqual(all.sort((a, b) => a.shopId.localeCompare(b.shopId)), records);
  } finally { federated?.close(); f.close(); }
});
test('staged rollout migrates shop 2 after shop 1, then shop 3, without changing any financial row', () => {
  const f = fixture();
  try {
    const firstTwo = createShopProfitLedgerStorage({ canonicalDb: f.db, shopRepository: f.shops,
      shopDatabaseRouter: f.router, directShopIds: ['shop-1', 'shop-2'], backupRoot: join(f.root, 'backups') });
    const firstProof = firstTwo.initialize();
    assert.deepEqual(firstProof.map((item) => item.shopId), ['shop-1', 'shop-2']);
    assert.deepEqual(firstTwo.layout().independentShopIds, ['shop-1', 'shop-2']);
    for (const n of [1, 2]) {
      assert.deepEqual(firstTwo.readSnapshot({ shopId: `shop-${n}`, keys: KEY }).snapshot.rows, [records[n - 1]]);
    }
    assert.deepEqual(f.shared.readSnapshot({ snapshotKey: KEY }).snapshot.rows, [records[2]]);

    const allThree = createShopProfitLedgerStorage({ canonicalDb: f.db, shopRepository: f.shops,
      shopDatabaseRouter: f.router, directShopIds: ['shop-1', 'shop-2', 'shop-3'], backupRoot: join(f.root, 'backups') });
    const secondProof = allThree.initialize();
    assert.deepEqual(secondProof.map((item) => [item.shopId, item.migrated]), [
      ['shop-1', false], ['shop-2', false], ['shop-3', true],
    ]);
    assert.deepEqual(allThree.layout().independentShopIds, ['shop-1', 'shop-2', 'shop-3']);
    assert.deepEqual(f.shared.readSnapshot({ snapshotKey: KEY }).snapshot.rows, []);
    assert.deepEqual(allThree.readSnapshot({ keys: KEY }).snapshot.rows
      .sort((left, right) => left.shopId.localeCompare(right.shopId)), records);
  } finally { f.close(); }
});
test('shop 1 saves only to its own file and neither a legacy client nor a wrong owner can write it into the shared or another store', () => {
  const f = fixture();
  try {
    f.storage.initialize();
    const sharedBefore = f.db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all();
    const updated = structuredClone(records[0]); updated.amounts.actualCommissionFeeCny.value = 0;
    f.storage.saveSnapshot({ shopId: 'shop-1', snapshotKey: KEY, snapshot: { calculationVersion: VERSION, rows: [updated] } });
    assert.deepEqual(f.db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all(), sharedBefore);
    assert.equal(f.storage.readSnapshot({ shopId: 'shop-1', keys: [KEY] }).snapshot.rows[0].amounts.actualCommissionFeeCny.value, 0);
    assert.throws(() => f.storage.saveSnapshot({ snapshotKey: KEY, snapshot: { rows: records } }), { code: 'SHOP_PROFIT_INDEPENDENT_PARTITION_REQUIRED' });
    assert.throws(() => f.storage.saveSnapshot({ shopId: 'shop-1', snapshotKey: KEY, snapshot: { rows: [records[1]] } }), { code: 'SHOP_PROFIT_ROW_OWNER_MISMATCH' });
    assert.throws(() => createProfitLedgerSnapshotRepository(f.router.open('shop-1').db).saveSnapshot({ snapshotKey: 'wrong', snapshot: { rows: [records[1]] } }), /SHOP_PROFIT_ROW_OWNER_MISMATCH/);
    f.manager.closeAll();
    assert.equal(f.storage.readSnapshot({ shopId: 'shop-1', keys: [KEY] }).snapshot.rows[0].amounts.actualCommissionFeeCny.value, 0);
  } finally { f.close(); }
});
test('migration failure preserves shared data and safely resumes a prepared target without touching shops 2 and 3', () => {
  const f = fixture();
  try {
    const before = f.db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all();
    f.db.exec("CREATE TRIGGER fail_profit_migration BEFORE UPDATE OF snapshot_json ON profit_ledger_snapshots BEGIN SELECT RAISE(ABORT,'TEST_STOP_MIGRATION'); END");
    assert.throws(() => f.storage.initialize(), /TEST_STOP_MIGRATION/);
    assert.deepEqual(f.db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM profit_ledger_owner_routes').get().n, 0);
    f.db.exec('DROP TRIGGER fail_profit_migration');
    f.storage.initialize();
    assert.deepEqual(f.shared.readSnapshot({ snapshotKey: KEY }).snapshot.rows, records.slice(1));
  } finally { f.close(); }
});

test('HTTP layout and scoped writes use shop 1 while the aggregate read and review retain all shops', async () => {
  const f = fixture(); let server;
  try {
    server = createApp({ db: f.db, shopDatabaseManager: f.manager,
      config: { security: {}, runtime: { profileId: f.shops.profileId }, storage: { profitLedgerDirectShopIds: ['shop-1'] }, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }), listAppliedMigrations: () => [], startedAt: Date.now() });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const layout = await fetch(`${base}/api/profit/ledger-snapshot?layoutOnly=true`).then((r) => r.json());
    assert.deepEqual(layout.independentShopIds, ['shop-1']);
    const own = await fetch(`${base}/api/profit/ledger-snapshot?keys=${encodeURIComponent(KEY)}&shopId=shop-1`).then((r) => r.json());
    assert.deepEqual(own.snapshot.rows, records.slice(0, 1));
    const shared = await fetch(`${base}/api/profit/ledger-snapshot?keys=${encodeURIComponent(KEY)}&sharedOnly=true`).then((r) => r.json());
    assert.deepEqual(shared.snapshot.rows, records.slice(1));
    const all = await fetch(`${base}/api/profit/ledger-snapshot?keys=${encodeURIComponent(KEY)}`).then((r) => r.json());
    assert.equal(all.snapshot.rows.length, 3);
    const updated = structuredClone(records[0]); updated.amounts.actualCommissionFeeCny.value = 0;
    const write = await fetch(`${base}/api/profit/ledger-snapshot`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shopId: 'shop-1', snapshotKey: KEY, snapshot: { calculationVersion: VERSION, rows: [updated] } }) });
    assert.equal(write.status, 200);
    assert.deepEqual(f.shared.readSnapshot({ snapshotKey: KEY }).snapshot.rows, records.slice(1));
    assert.equal(layout.atomicBatchWrite, true);
    const batchBody = { shopId: 'shop-1', snapshotKey: KEY,
      snapshot: { calculationVersion: VERSION, persistenceFormat: 'profit-ledger-chunked-v1', rows: [], rowCount: 1,
        writeId: 'atomic-http', chunkKeys: [`${KEY}::chunk:atomic-http:0`, `${KEY}::chunk:atomic-http:1`] },
      chunks: [{ rows: [updated] }, { rows: [] }],
    };
    const atomic = await fetch(`${base}/api/profit/ledger-snapshot`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batchBody) });
    assert.equal(atomic.status, 200);
    const receipt = await atomic.json(); assert.equal(receipt.stats.readbackVerified, true); assert.equal(receipt.stats.rowCount, 1);
    assert.deepEqual(f.storage.readSnapshot({ shopId: 'shop-1', keys: KEY }).snapshot.rows, [updated]);
    assert.deepEqual(f.shared.readSnapshot({ snapshotKey: KEY }).snapshot.rows, records.slice(1));
    assert.throws(() => f.storage.saveSnapshot({ ...batchBody, chunks: [{ rows: [records[1]] }, { rows: [] }] }), { code: 'SHOP_PROFIT_ROW_OWNER_MISMATCH' });
    assert.throws(() => f.storage.saveSnapshot({ ...batchBody, shopId: undefined, sharedOnly: true }), { code: 'SHOP_PROFIT_BATCH_OWNER_REQUIRED' });
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); f.close(); }
});

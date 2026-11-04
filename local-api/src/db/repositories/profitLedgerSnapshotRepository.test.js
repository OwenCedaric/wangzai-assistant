import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createProfitLedgerSnapshotRepository } from './profitLedgerSnapshotRepository.js';

function createSnapshot(id, fetchedAt = '2026-07-12T00:00:00.000Z') {
  return {
    cacheGroup: 'ozon-profit-ledger-v1',
    calculationVersion: 'profit-ledger-v2',
    sourceKey: 'shop-a',
    fetchedAt,
    rows: [{ ledgerKey: id, calculationVersion: 'profit-ledger-v2', results: { actualProfitCny: { value: 5 } } }],
    penaltyDetails: { [`penalty:${id}`]: { amountCny: 1 } },
  };
}

function confirmedThreeShopSnapshot() {
  return { calculationVersion: 'profit-ledger-v16-per-order-finance-exchange-rate', rows: [1, 2, 3].map((i) => ({
    shopId: `shop-${i}`, ledgerKey: `shop-${i}:posting-1`, orderSnapshot: { posting: 'posting-1' },
    amounts: { actualCommissionFeeCny: { value: i === 3 ? 0 : i, status: 'ready' } },
  })) };
}

test('atomic bundle publishes all chunks once and rolls back failed validation without orphan chunks', () => {
  const db = createMigratedTestDb();
  try {
    const repo = createProfitLedgerSnapshotRepository(db);
    const initial = confirmedThreeShopSnapshot();
    repo.saveSnapshot({ snapshotKey: 'bundle', snapshot: initial });
    const bundle = (rows, token, count = rows.length) => ({ snapshotKey: 'bundle',
      snapshot: { calculationVersion: initial.calculationVersion, persistenceFormat: 'profit-ledger-chunked-v1', rows: [],
        rowCount: count, writeId: token, chunkKeys: [`bundle::chunk:${token}:0`, `bundle::chunk:${token}:1`] },
      chunks: [{ rows: rows.slice(0, 1) }, { rows: rows.slice(1) }],
    });
    const before = db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all();
    assert.throws(() => repo.saveSnapshotBundle(bundle(initial.rows, 'bad-count', 4)), /ROW_COUNT_MISMATCH/);
    assert.deepEqual(db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all(), before);
    const bad = structuredClone(initial.rows); bad[2].amounts.actualCommissionFeeCny = { value: null, status: 'pending' };
    assert.throws(() => repo.saveSnapshotBundle(bundle(bad, 'bad-evidence')), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
    assert.deepEqual(db.prepare('SELECT * FROM profit_ledger_snapshots ORDER BY snapshot_key').all(), before);
    const next = structuredClone(initial.rows); next[0].amounts.actualCommissionFeeCny.value = 0;
    const result = repo.saveSnapshotBundle(bundle(next, 'complete'));
    assert.equal(result.stats.batchWrite, true); assert.equal(result.stats.readbackVerified, true);
    assert.equal(result.stats.rowCount, 3); assert.equal(result.stats.chunkCount, 2);
    assert.deepEqual(repo.readSnapshot({ snapshotKey: 'bundle' }).snapshot.rows, next);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM profit_ledger_snapshots').get().n, 3);
  } finally { db.close(); }
});

test('a historical query cannot veto an unchanged current baseline; new scope recovery uses the newest baseline per order', () => {
  const db = createMigratedTestDb();
  try {
    let timestamp = '2026-08-24T00:00:00Z';
    const repo = createProfitLedgerSnapshotRepository(db, { now: () => timestamp });
    const historical = confirmedThreeShopSnapshot();
    repo.saveSnapshot({ snapshotKey: 'historical-query', snapshot: historical });
    timestamp = '2026-09-04T00:00:00Z';
    repo.saveSnapshot({ snapshotKey: 'current-query', snapshot: historical });
    // Model pre-existing current data from before the protective guard. This
    // current pending field is not a downgrade introduced by the next write.
    const current = structuredClone(historical);
    current.rows[0].amounts.actualCommissionFeeCny = { value: null, status: 'pending' };
    db.prepare('UPDATE profit_ledger_snapshots SET snapshot_json=? WHERE snapshot_key=?')
      .run(JSON.stringify(current), 'current-query');
    const updated = structuredClone(current);
    updated.rows[1].amounts.actualCommissionFeeCny.value = 0;
    assert.doesNotThrow(() => repo.saveSnapshot({ snapshotKey: 'current-query', snapshot: updated }));
    assert.doesNotThrow(() => repo.saveSnapshot({ snapshotKey: 'new-shop-combination', snapshot: updated }));
    const bad = structuredClone(updated);
    bad.rows[1].amounts.actualCommissionFeeCny = { value: null, status: 'pending' };
    assert.throws(() => repo.saveSnapshot({ snapshotKey: 'current-query', snapshot: bad }), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
    assert.throws(() => repo.saveSnapshot({ snapshotKey: 'another-new-scope', snapshot: bad }), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
    assert.equal(repo.readSnapshot({ snapshotKey: 'current-query' }).snapshot.rows[1].amounts.actualCommissionFeeCny.value, 0);
  } finally { db.close(); }
});

test('future shops retain evidence when the selected shop combination and snapshot key change', () => {
  const db = createMigratedTestDb();
  try {
    const repo = createProfitLedgerSnapshotRepository(db);
    const owner = `new-shop-${randomUUID()}`;
    const other = `new-shop-${randomUUID()}`;
    const version = 'profit-ledger-v16-per-order-finance-exchange-rate';
    const row = { shopId: owner, shopClientId: 'new-client', ledgerKey: `${owner}:posting-1`,
      orderSnapshot: { posting: 'posting-1' }, calculationVersion: version,
      amounts: { actualCommissionFeeCny: { value: 4, status: 'ready' }, sourcePurchaseCostCny: { value: 8, status: 'ready', source: 'purchase-override' } } };
    repo.saveSnapshot({ snapshotKey: 'one-owner', snapshot: { calculationVersion: version, rows: [row] } });
    const candidate = { calculationVersion: version, rows: [
      { ...row, orderSnapshot: { posting: 'new-client:posting-1' }, amounts: { ...row.amounts, actualCommissionFeeCny: { value: null, status: 'pending' } } },
      { ...row, shopId: other, ledgerKey: `${other}:posting-1`, amounts: { actualCommissionFeeCny: { value: 0, status: 'ready' } } },
    ] };
    assert.throws(() => repo.saveSnapshot({ snapshotKey: 'new-shop-combination', snapshot: candidate }), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
    assert.equal(repo.readSnapshot({ snapshotKey: 'new-shop-combination' }).snapshot, null);
    assert.equal(repo.readSnapshot({ snapshotKey: 'one-owner' }).snapshot.rows[0].amounts.actualCommissionFeeCny.value, 4);
    candidate.rows[0] = structuredClone(row);
    candidate.rows[0].amounts.sourcePurchaseCostCny = { value: 0, status: 'ready', source: 'missing-purchase-cost-zero' };
    assert.throws(() => repo.saveSnapshot({ snapshotKey: 'new-shop-combination', snapshot: candidate }), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
    candidate.rows[0].amounts.sourcePurchaseCostCny = { value: 0, status: 'ready', source: 'confirmed-no-purchase' };
    repo.saveSnapshot({ snapshotKey: 'new-shop-combination', snapshot: candidate });
    assert.equal(repo.readSnapshot({ snapshotKey: 'new-shop-combination' }).snapshot.rows.length, 2);
  } finally { db.close(); }
});

test('all-shop ledger persistence refuses to downgrade confirmed amounts and preserves newer confirmed zero', () => {
  const db = createMigratedTestDb();
  try {
    const repo = createProfitLedgerSnapshotRepository(db);
    const snapshot = confirmedThreeShopSnapshot();
    repo.saveSnapshot({ snapshotKey: 'all-shops', snapshot });
    const bad = structuredClone(snapshot);
    bad.rows[1].amounts.actualCommissionFeeCny = { value: null, status: 'pending' };
    assert.throws(() => repo.saveSnapshot({ snapshotKey: 'all-shops', snapshot: bad }), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
    assert.deepEqual(repo.readSnapshot({ snapshotKey: 'all-shops' }).snapshot.rows, snapshot.rows);
    const newer = structuredClone(snapshot);
    newer.rows[1].amounts.actualCommissionFeeCny.value = 0;
    repo.saveSnapshot({ snapshotKey: 'all-shops', snapshot: newer });
    assert.equal(repo.readSnapshot({ snapshotKey: 'all-shops' }).snapshot.rows[1].amounts.actualCommissionFeeCny.value, 0);
  } finally { db.close(); }
});

test('chunked manifest publication applies the same evidence guard without replacing the last good snapshot', () => {
  const db = createMigratedTestDb();
  try {
    const repo = createProfitLedgerSnapshotRepository(db);
    const snapshot = confirmedThreeShopSnapshot();
    repo.saveSnapshot({ snapshotKey: 'all-shops', snapshot });
    const bad = structuredClone(snapshot);
    bad.rows[2].amounts.actualCommissionFeeCny = { value: null, status: 'pending' };
    repo.saveSnapshot({ snapshotKey: 'all-shops::chunk:new:0', chunkOf: 'all-shops', writeId: 'new', chunkIndex: 0, chunkCount: 1, snapshot: bad });
    const manifest = { ...bad, persistenceFormat: 'profit-ledger-chunked-v1', rows: [], rowCount: 3, writeId: 'new', chunkKeys: ['all-shops::chunk:new:0'] };
    assert.throws(() => repo.saveSnapshot({ snapshotKey: 'all-shops', snapshot: manifest }), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
    assert.deepEqual(repo.readSnapshot({ snapshotKey: 'all-shops' }).snapshot.rows, snapshot.rows);
  } finally { db.close(); }
});

test('late snapshot pruning failure rolls back the replacement header', () => {
  const db = createMigratedTestDb();
  try {
    const repo = createProfitLedgerSnapshotRepository(db);
    repo.saveSnapshot({ snapshotKey: 'shop-1:range:old', snapshot: createSnapshot('old') });
    db.exec("CREATE TRIGGER fail_prune BEFORE DELETE ON profit_ledger_snapshots BEGIN SELECT RAISE(ABORT, 'TEST_PRUNE_FAILURE'); END");
    assert.throws(() => repo.saveSnapshot({ snapshotKey: 'shop-1:range:new', snapshot: createSnapshot('new') }), /TEST_PRUNE_FAILURE/);
    assert.equal(repo.readSnapshot({ snapshotKey: 'shop-1:range:new' }).snapshot, null);
    assert.equal(repo.readSnapshot({ snapshotKey: 'shop-1:range:old' }).snapshot.rows[0].ledgerKey, 'old');
  } finally { db.close(); }
});

test('published chunks cannot bypass the evidence guard and rolling keys retain the same protection', () => {
  const db = createMigratedTestDb();
  try {
    const repo = createProfitLedgerSnapshotRepository(db);
    const snapshot = confirmedThreeShopSnapshot();
    const key = 'all-shops:range:old';
    const chunkInput = { snapshotKey: `${key}::chunk:one:0`, chunkOf: key, writeId: 'one', chunkIndex: 0, chunkCount: 1, snapshot };
    repo.saveSnapshot(chunkInput);
    repo.saveSnapshot({ snapshotKey: key, snapshot: { ...snapshot, persistenceFormat: 'profit-ledger-chunked-v1', rows: [], rowCount: 3, writeId: 'one', chunkKeys: [chunkInput.snapshotKey] } });
    const bad = structuredClone(snapshot);
    bad.rows[0].amounts.actualCommissionFeeCny = { value: null, status: 'pending' };
    assert.throws(() => repo.saveSnapshot({ ...chunkInput, snapshot: bad }), { code: 'PROFIT_LEDGER_PUBLISHED_CHUNK_IMMUTABLE' });
    assert.throws(() => repo.saveSnapshot({ snapshotKey: 'all-shops:range:new', snapshot: bad }), { code: 'PROFIT_LEDGER_EVIDENCE_DOWNGRADE' });
    assert.deepEqual(repo.readSnapshot({ snapshotKey: key }).snapshot.rows, snapshot.rows);
  } finally { db.close(); }
});

test('profit ledger snapshot repository reads the first matching candidate without returning other snapshots', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProfitLedgerSnapshotRepository(db, { now: () => '2026-07-12T00:00:01.000Z' });
    const key = 'ozon-profit-ledger-v1:shop-a:range:2026-04-13_2026-07-12:filter:all';
    const saved = repository.saveSnapshot({ snapshotKey: key, snapshot: createSnapshot('ledger-current') });

    assert.equal(saved.ok, true);
    assert.equal(saved.source, 'sqlite');
    assert.equal(saved.snapshot.rows[0].ledgerKey, 'ledger-current');

    const read = repository.readSnapshot({ keys: `missing-key,${key}` });
    assert.equal(read.snapshotKey, key);
    assert.deepEqual(read.snapshot.rows.map((row) => row.ledgerKey), ['ledger-current']);
    assert.equal(JSON.stringify(read).includes('missing-key'), false);
  } finally {
    db.close();
  }
});

test('profit ledger snapshots retain one current date range per logical query and bound independent scopes', () => {
  const db = createMigratedTestDb();
  try {
    let tick = 0;
    const repository = createProfitLedgerSnapshotRepository(db, {
      now: () => new Date(Date.parse('2026-07-12T00:00:00.000Z') + tick++ * 1000).toISOString(),
    });
    for (let day = 1; day <= 7; day += 1) {
      const key = `ozon-profit-ledger-v1:shop-a:range:2026-04-${String(day).padStart(2, '0')}_2026-07-${String(day).padStart(2, '0')}:filter:all`;
      repository.saveSnapshot({ snapshotKey: key, snapshot: createSnapshot(`rolling-${day}`) });
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM profit_ledger_snapshots').get().count, 1);
    const currentKey = 'ozon-profit-ledger-v1:shop-a:range:2026-04-07_2026-07-07:filter:all';
    assert.equal(repository.readSnapshot({ snapshotKey: currentKey }).snapshot.rows[0].ledgerKey, 'rolling-7');

    for (let index = 0; index < 13; index += 1) {
      const key = `ozon-profit-ledger-v1:shop-${index}:range:2026-04-13_2026-07-12:filter:all`;
      repository.saveSnapshot({ snapshotKey: key, snapshot: createSnapshot(`shop-${index}`) });
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM profit_ledger_snapshots').get().count, 12);
    assert.equal(
      repository.readSnapshot({ snapshotKey: 'ozon-profit-ledger-v1:shop-12:range:2026-04-13_2026-07-12:filter:all' }).snapshot.rows[0].ledgerKey,
      'shop-12',
    );
    assert.equal(
      repository.readSnapshot({ snapshotKey: 'ozon-profit-ledger-v1:shop-0:range:2026-04-13_2026-07-12:filter:all' }).snapshot,
      null,
    );
  } finally {
    db.close();
  }
});

test('profit ledger snapshots do not impose a total byte ceiling across independent logical scopes', () => {
  const db = createMigratedTestDb();
  try {
    let tick = 0;
    const repository = createProfitLedgerSnapshotRepository(db, {
      now: () => new Date(Date.parse('2026-07-12T00:00:00.000Z') + tick++ * 1000).toISOString(),
    });
    const oversizedButAllowedDetail = 'x'.repeat(7 * 1024 * 1024);
    for (let index = 0; index < 5; index += 1) {
      repository.saveSnapshot({
        snapshotKey: `ozon-profit-ledger-v1:shop-${index}:range:2026-04-13_2026-07-12:filter:all`,
        snapshot: { ...createSnapshot(`budget-${index}`), oversizedButAllowedDetail },
      });
    }

    const cacheBytes = db
      .prepare('SELECT COALESCE(SUM(LENGTH(CAST(snapshot_json AS BLOB))), 0) AS bytes FROM profit_ledger_snapshots')
      .get().bytes;
    assert.ok(cacheBytes > 30 * 1024 * 1024);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM profit_ledger_snapshots').get().count, 5);
    assert.equal(
      repository.readSnapshot({ snapshotKey: 'ozon-profit-ledger-v1:shop-4:range:2026-04-13_2026-07-12:filter:all' }).snapshot.rows[0].ledgerKey,
      'budget-4',
    );
  } finally {
    db.close();
  }
});

test('profit ledger chunk manifest atomically exposes every row and clear removes the whole bundle', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProfitLedgerSnapshotRepository(db);
    const baseKey = 'ozon-profit-ledger-v1:all-shops:range:current';
    const writeId = 'write-1';
    const chunkKeys = [0, 1].map((index) => `${baseKey}::chunk:${writeId}:${String(index).padStart(6, '0')}`);
    chunkKeys.forEach((chunkKey, index) => repository.saveSnapshot({
      snapshotKey: chunkKey,
      chunkOf: baseKey,
      writeId,
      chunkIndex: index,
      chunkCount: chunkKeys.length,
      snapshot: {
        rows: index === 0
          ? [{ ledgerKey: 'order-1' }, { ledgerKey: 'order-2' }]
          : [{ ledgerKey: 'order-3' }],
      },
    }));
    repository.saveSnapshot({
      snapshotKey: baseKey,
      snapshot: {
        persistenceFormat: 'profit-ledger-chunked-v1',
        writeId,
        chunkKeys,
        rowCount: 3,
        rows: [],
      },
    });

    const read = repository.readSnapshot({ snapshotKey: baseKey });
    assert.equal(read.ok, true);
    assert.deepEqual(read.snapshot.rows.map((row) => row.ledgerKey), ['order-1', 'order-2', 'order-3']);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM profit_ledger_snapshots').get().count, 3);

    const cleared = repository.clearSnapshots({ snapshotKeys: [baseKey] });
    assert.equal(cleared.stats.removedSnapshots, 3);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM profit_ledger_snapshots').get().count, 0);
  } finally {
    db.close();
  }
});

test('profit ledger never publishes an incomplete chunk manifest over the last good snapshot', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProfitLedgerSnapshotRepository(db);
    const baseKey = 'ozon-profit-ledger-v1:all-shops:range:current';
    repository.saveSnapshot({ snapshotKey: baseKey, snapshot: createSnapshot('last-good') });
    assert.throws(
      () => repository.saveSnapshot({
        snapshotKey: baseKey,
        snapshot: {
          persistenceFormat: 'profit-ledger-chunked-v1',
          writeId: 'missing-write',
          chunkKeys: [`${baseKey}::chunk:missing-write:000000`],
          rowCount: 1,
          rows: [],
        },
      }),
      /PROFIT_LEDGER_SNAPSHOT_CHUNK_MISMATCH/,
    );
    assert.equal(repository.readSnapshot({ snapshotKey: baseKey }).snapshot.rows[0].ledgerKey, 'last-good');
  } finally {
    db.close();
  }
});

test('profit ledger snapshot accepts one compact restart payload above the former eight MiB ceiling', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProfitLedgerSnapshotRepository(db);
    const payload = 'x'.repeat(9 * 1024 * 1024);
    const saved = repository.saveSnapshot({
      snapshotKey: 'ozon-profit-ledger-v1:all-shops:range:current',
      snapshot: { ...createSnapshot('all-orders'), compactRows: payload },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.snapshot.compactRows.length, payload.length);
  } finally {
    db.close();
  }
});

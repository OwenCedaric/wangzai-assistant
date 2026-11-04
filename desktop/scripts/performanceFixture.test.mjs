import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { withManagedDevScratch } from '../../tools/managed-dev-scratch.mjs';
import { seedRendererPerformanceFixture, validatePerformanceFixtureSize, disposeRendererPerformanceFixture } from './performanceFixture.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('successful synthetic capacity runs can dispose only their own closed fixture', async () => {
  await withManagedDevScratch({ workspaceRoot, purpose: 'test-scratch' }, async lease => {
    const fixture = await seedRendererPerformanceFixture({ ownedRoot: lease.directory,
      dataRoot: path.join(lease.directory, 'disposable-profile'), products: 2, orders: 2, shops: 1 });
    assert.throws(() => disposeRendererPerformanceFixture({ ...fixture }, { ownedRoot: lease.directory }), /NOT_OWNED/);
    assert.throws(() => disposeRendererPerformanceFixture(fixture, { ownedRoot: workspaceRoot }), /NOT_OWNED/);
    assert.equal(fs.existsSync(fixture.databasePath), true);
    assert.equal(disposeRendererPerformanceFixture(fixture, { ownedRoot: lease.directory }).disposed, true);
    assert.equal(fs.existsSync(fixture.dataRoot), false);
    assert.throws(() => disposeRendererPerformanceFixture(fixture, { ownedRoot: lease.directory }), /NOT_OWNED/);
  });
});

test('fixture validates counts instead of silently flooring, clamping, or exceeding resource caps', () => {
  for (const input of [{ products: -1 }, { products: 1.1 }, { orders: Infinity }, { shops: 0 },
    { shops: 21 }, { products: 100001 }, { orders: 500001 }, { shops: '3' }, { products: NaN }]) {
    assert.throws(() => validatePerformanceFixtureSize(input), /PERFORMANCE_FIXTURE_SIZE_INVALID/);
  }
  assert.deepEqual(validatePerformanceFixtureSize({ products: 100000, orders: 200000, shops: 10 }),
    { products: 100000, orders: 200000, shops: 10 });
});

test('test-only bulk setup commits authoritative stores and keeps WAL/durability before reopening', async () => {
  await withManagedDevScratch({ workspaceRoot, purpose: 'test-scratch' }, async lease => {
    const fixture = await seedRendererPerformanceFixture({ ownedRoot: lease.directory,
      dataRoot: path.join(lease.directory, 'bulk-profile'), products: 1002, orders: 1002, shops: 2, batchSetup: true });
    assert.equal(fixture.seedCommitMode, 'test-only-per-shop-transaction');
    assert.equal(fixture.reopened, true);
    for (const receipt of fixture.shopReceipts) {
      assert.equal(receipt.setupPragmas.journal_mode, 'wal');
      assert.equal(receipt.setupPragmas.synchronous, 2);
      assert.equal(receipt.setupPragmas.foreign_keys, 1);
      assert.equal(receipt.orders, 501); assert.equal(receipt.products, 501);
    }
    disposeRendererPerformanceFixture(fixture, { ownedRoot: lease.directory });
  });
});

test('products and orders persist only to the exact shop incarnation and survive close/reopen', async () => {
  await withManagedDevScratch({ workspaceRoot, purpose: 'test-scratch' }, async (lease) => {
    lease.retain();
    const originalSecret = process.env.LOCAL_API_SECRET;
    const originalSecretFile = process.env.LOCAL_API_SECRET_FILE;
    const fixture = await seedRendererPerformanceFixture({ ownedRoot: lease.directory,
      dataRoot: path.join(lease.directory, 'profile'), products: 23, orders: 17, shops: 3 });
    assert.equal(process.env.LOCAL_API_SECRET, originalSecret);
    assert.equal(process.env.LOCAL_API_SECRET_FILE, originalSecretFile);
    assert.equal(fixture.reopened, true);
    assert.deepEqual(fixture.shopReceipts.map((row) => [row.products, row.orders]), [[8, 6], [8, 6], [7, 5]]);
    assert.equal(new Set(fixture.shopReceipts.map((row) => row.route.scopeDigest)).size, 3);
    const central = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      assert.equal(central.prepare('SELECT COUNT(*) AS n FROM ozon_products').get().n, 0);
      assert.equal(central.prepare('SELECT COUNT(*) AS n FROM ozon_orders').get().n, 0);
      for (const receipt of fixture.shopReceipts) {
        assert.equal(receipt.route.profileId, fixture.profileId);
        assert.ok(receipt.reopened);
        const db = new DatabaseSync(receipt.route.databasePath, { readOnly: true });
        try {
          for (const [table, count] of [['ozon_products', receipt.products], ['ozon_orders', receipt.orders]]) {
            assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, count);
            assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE shop_id != ?`).get(receipt.shopId).n, 0);
          }
        } finally { db.close(); }
      }
    } finally { central.close(); }
    await assert.rejects(seedRendererPerformanceFixture({ ownedRoot: lease.directory, dataRoot: fixture.dataRoot }),
      /PERFORMANCE_FIXTURE_REQUIRES_NEW_PROFILE/);
    await assert.rejects(seedRendererPerformanceFixture({ ownedRoot: lease.directory, dataRoot: workspaceRoot }),
      /PERFORMANCE_FIXTURE_OUTSIDE_OWNED_ROOT/);
    assert.ok(fs.existsSync(fixture.databasePath));
  });
});

test('zero-product shops remain valid isolated direct stores and batches cross 500 without loss', async () => {
  await withManagedDevScratch({ workspaceRoot, purpose: 'test-scratch' }, async (lease) => {
    lease.retain();
    const empty = await seedRendererPerformanceFixture({ ownedRoot: lease.directory,
      dataRoot: path.join(lease.directory, 'empty-profile'), shops: 2 });
    assert.deepEqual(empty.shopReceipts.map((row) => [row.products, row.orders]), [[0, 0], [0, 0]]);
    const batches = await seedRendererPerformanceFixture({ ownedRoot: lease.directory,
      dataRoot: path.join(lease.directory, 'batch-profile'), products: 501, orders: 501 });
    assert.equal(batches.reopened, true);
    assert.equal(batches.shopReceipts[0].products, 501);
    assert.equal(batches.shopReceipts[0].orders, 501);
  });
});

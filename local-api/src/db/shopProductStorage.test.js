import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createProductRepository } from './repositories/productRepository.js';
import { createShopRepository } from './repositories/shopRepository.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopProductStorage, shopProductStorageInternals } from './shopProductStorage.js';

async function createFixture({ fileBacked = false, storageOptions = {} } = {}) {
  const databaseRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-product-storage-'));
  const canonicalDb = createMigratedTestDb(fileBacked ? path.join(databaseRoot, 'canonical.sqlite') : ':memory:');
  let incarnation = 0;
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-product-storage',
    createIncarnation: () => `inc-product-storage-${++incarnation}`,
  });
  const manager = createShopDatabaseManager({ root: databaseRoot, profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const tasks = [];
  const storage = createShopProductStorage({
    canonicalDb,
    shopDatabaseRouter: router,
    enabledShopIds: ['shop-1'],
    backgroundRunner(task) { tasks.push(task); },
    ...storageOptions,
  });
  return {
    canonicalDb,
    shops,
    manager,
    router,
    storage,
    tasks,
    async close() {
      storage.stop();
      manager.closeAll();
      canonicalDb.close();
      await rm(databaseRoot, { recursive: true, force: true });
    },
  };
}

function saveShop(shops, id) {
  return shops.saveShop({
    id,
    name: id,
    clientId: `client-${id}`,
    apiKey: `secret-${id}`,
    status: 'active',
  });
}

function product(id, price = 100) {
  return {
    product_id: `product-${id}`,
    offer_id: `offer-${id}`,
    sku: `sku-${id}`,
    name: `Product ${id}`,
    visibility: 'IN_SALE',
    price,
    stocks: [{ warehouse_id: 'warehouse-1', present: 7 }],
    images: [`https://example.test/${id}-1.jpg`, `https://example.test/${id}-2.jpg`],
    attributes: [{ id: 9048, values: [{ value: `model-${id}` }] }],
  };
}

test('shop product storage copies every product-owned table field-for-field for the enabled shop only', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    saveShop(fixture.shops, 'shop-2');
    const repository = createProductRepository(fixture.canonicalDb);
    repository.upsertProducts({ shopId: 'shop-1', rows: [product('one'), product('two', 120)] });
    repository.upsertProducts({ shopId: 'shop-2', rows: [product('foreign')] });

    assert.equal(fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' }).accepted, 1);
    assert.equal(fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' }).accepted, 0);
    assert.equal(fixture.storage.enqueueShopSnapshot({ shopId: 'shop-2' }).accepted, 0);
    assert.equal(fixture.tasks.length, 1);
    assert.equal(fixture.storage.flush('shop-1').ok, true);

    const verification = fixture.storage.verifyShop({ shopId: 'shop-1' });
    assert.equal(verification.ok, true);
    assert.equal(verification.sourceTotal, verification.targetTotal);
    assert.equal(verification.verifiedRows, verification.sourceTotal);
    const localDb = fixture.router.open('shop-1').db;
    for (const tableName of shopProductStorageInternals.PRODUCT_TABLES) {
      assert.equal(
        localDb.prepare(`SELECT COUNT(*) AS total FROM "${tableName}" WHERE shop_id <> ?`).get('shop-1').total,
        0,
      );
    }
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).ready, true);
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-2' }).reason, 'shop_not_enabled');
  } finally {
    await fixture.close();
  }
});

test('owner deletion waits for the actual worker to settle and leaves other owner workers running', async () => {
  const pending = new Map();
  const fixture = await createFixture({ fileBacked: true, storageOptions: {
    enabledShopIds: ['shop-1', 'shop-2'],
    mirrorWorkerRunner: (input, { signal }) => new Promise(resolve => pending.set(input.shopId, { signal, resolve })),
  } });
  try {
    saveShop(fixture.shops, 'shop-1'); saveShop(fixture.shops, 'shop-2');
    fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' });
    fixture.storage.enqueueShopSnapshot({ shopId: 'shop-2' });
    fixture.tasks.splice(0).forEach(run => run());
    let completed = false;
    const closing = fixture.storage.quiesceOwner('shop-1', { timeoutMs: 3000 }).then(() => { completed = true; });
    assert.equal(pending.get('shop-1').signal.aborted, true);
    assert.equal(pending.get('shop-2').signal.aborted, false);
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' }).reason, 'owner_fenced');
    pending.get('shop-1').resolve({ ok: true, sourceRevision: 0 });
    await closing;
    assert.deepEqual(fixture.storage.getOwnerStatus('shop-1'), { fenced: true, active: 0, queued: 0 });
    assert.equal(fixture.storage.getOwnerStatus('shop-2').active, 1);
    pending.get('shop-2').resolve({ ok: true, sourceRevision: 0 });
    await fixture.storage.quiesceOwner('shop-2');
    fixture.storage.releaseOwner('shop-1');
    assert.equal(fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' }).accepted, 1);
    await fixture.storage.quiesceOwner('shop-1');
  } finally { await fixture.close(); }
});

test('a failed mirror worker does not reschedule forever on a null result', async () => {
  let calls = 0;
  const fixture = await createFixture({ fileBacked: true, storageOptions: {
    mirrorWorkerRunner: async () => { calls += 1; throw Object.assign(new Error('test'), { code: 'TEST_WORKER_FAILED' }); },
  } });
  try {
    saveShop(fixture.shops, 'shop-1');
    fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' });
    fixture.tasks.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(fixture.tasks.length, 0);
    assert.equal(fixture.storage.snapshot().pendingShops, 0);
    assert.equal(fixture.storage.snapshot().failures, 1);
  } finally { await fixture.close(); }
});

test('source-change retry is bounded and stopped storage cannot start queued copies', async () => {
  let calls = 0;
  const fixture = await createFixture({ fileBacked: true, storageOptions: {
    maxMirrorAttempts: 3,
    mirrorWorkerRunner: async () => { calls += 1; throw Object.assign(new Error('changed'), { code: 'SHOP_PRODUCT_STORAGE_SOURCE_CHANGED_DURING_COPY' }); },
  } });
  try {
    saveShop(fixture.shops, 'shop-1');
    fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' });
    for (let i = 0; i < 5 && fixture.tasks.length; i += 1) {
      fixture.tasks.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(calls, 3);
    assert.equal(fixture.tasks.length, 0);
    fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' });
    fixture.storage.stop();
    fixture.tasks.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3);
    assert.throws(() => fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' }), /SHOP_PRODUCT_STORAGE_STOPPED/);
  } finally { await fixture.close(); }
});

test('a canonical product change makes the independent copy unreadable until it is verified again', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    const repository = createProductRepository(fixture.canonicalDb);
    repository.upsertProducts({ shopId: 'shop-1', rows: [product('safe')] });
    fixture.storage.mirrorShop({ shopId: 'shop-1' });
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).ready, true);

    fixture.canonicalDb.prepare(`
      UPDATE ozon_products SET name = ?, updated_at = ? WHERE shop_id = ?
    `).run('Changed', '2099-01-01T00:00:00.000Z', 'shop-1');
    const stale = fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' });
    assert.equal(stale.ready, false);
    assert.equal(stale.reason, 'canonical_changed_since_verification');

    fixture.storage.mirrorShop({ shopId: 'shop-1' });
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).ready, true);
  } finally {
    await fixture.close();
  }
});

test('file-backed shop product snapshots run in a worker and become readable after exact verification', async () => {
  const databaseRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-product-worker-'));
  const canonicalPath = path.join(databaseRoot, 'canonical.sqlite');
  const canonicalDb = createMigratedTestDb(canonicalPath);
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-product-worker',
    createIncarnation: () => 'inc-product-worker-1',
  });
  const manager = createShopDatabaseManager({ root: databaseRoot, profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  try {
    saveShop(shops, 'shop-1');
    const repository = createProductRepository(canonicalDb);
    repository.upsertProducts({
      shopId: 'shop-1',
      rows: Array.from({ length: 40 }, (_item, index) => product(`worker-${index + 1}`, index + 1)),
    });
    const storage = createShopProductStorage({
      canonicalDb,
      shopDatabaseRouter: router,
      enabledShopIds: ['shop-1'],
    });

    assert.equal(storage.snapshot().workerMirrorEnabled, true);
    assert.equal(storage.enqueueShopSnapshot({ shopId: 'shop-1' }).accepted, 1);
    assert.equal(storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).ready, false);

    const deadline = Date.now() + 15_000;
    let readiness = storage.resolveVerifiedReadSession({ shopId: 'shop-1' });
    while (!readiness.ready && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      readiness = storage.resolveVerifiedReadSession({ shopId: 'shop-1' });
    }

    assert.equal(readiness.ready, true, readiness.reason);
    assert.equal(storage.snapshot().workerRuns, 1);
    assert.equal(storage.snapshot().activeWorkers, 0);
    assert.equal(storage.verifyShop({ shopId: 'shop-1' }).ok, true);
  } finally {
    manager.closeAll();
    canonicalDb.close();
    await rm(databaseRoot, { recursive: true, force: true });
  }
});

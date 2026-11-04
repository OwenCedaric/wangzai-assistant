import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopOrderStorage } from './shopOrderStorage.js';
import { createOrderRepository } from './repositories/orderRepository.js';
import { createShopRepository } from './repositories/shopRepository.js';

async function createFixture() {
  const databaseRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-order-storage-'));
  const canonicalDb = createMigratedTestDb();
  let incarnation = 0;
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-order-storage',
    createIncarnation: () => `inc-order-storage-${++incarnation}`,
  });
  const manager = createShopDatabaseManager({
    root: databaseRoot,
    profileId: shops.profileId,
  });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const scheduledTasks = [];
  const errors = [];
  const storage = createShopOrderStorage({
    canonicalDb,
    shopDatabaseRouter: router,
    backgroundRunner(task) {
      scheduledTasks.push(task);
    },
    onError(error, context) {
      errors.push({ code: error.code, context });
    },
  });
  return {
    canonicalDb,
    databaseRoot,
    shops,
    manager,
    router,
    storage,
    scheduledTasks,
    errors,
    async close() {
      manager.closeAll();
      canonicalDb.close();
      await rm(databaseRoot, { recursive: true, force: true });
    },
  };
}

function saveShop(shops, id) {
  return shops.saveShop({
    id,
    name: `Shop ${id}`,
    clientId: `client-${id}`,
    apiKey: `secret-${id}`,
    status: 'active',
  });
}

function order(postingNumber, amount, status = 'awaiting_packaging') {
  return {
    posting_number: postingNumber,
    order_id: `order-${postingNumber}`,
    status,
    in_process_at: '2026-09-03T10:00:00.000Z',
    products: [{ offer_id: `offer-${postingNumber}`, price: amount, quantity: 1 }],
    analytics_data: { region: 'Moscow' },
    financial_data: { total_price: amount },
  };
}

function plainRow(row) {
  return Object.fromEntries(Object.entries(row));
}

test('order writes keep their original result and are copied field-for-field into the exact shop database', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-a');
    saveShop(fixture.shops, 'shop-b');
    const repository = createOrderRepository(fixture.canonicalDb, { shopOrderStorage: fixture.storage });

    const resultA = repository.upsertOrders({ shopId: 'shop-a', rows: [order('A-1', 12.5)] });
    const resultB = repository.upsertOrders({ shopId: 'shop-b', rows: [order('B-1', 22.75)] });
    assert.deepEqual(resultA, {
      ok: true,
      inserted: 1,
      updated: 0,
      unchanged: 0,
      missing: 0,
      changed: 1,
      rows: 1,
      updatedAt: resultA.updatedAt,
    });
    assert.equal(resultB.inserted, 1);
    assert.equal(fixture.storage.snapshot().pendingShops, 2);
    assert.equal(fixture.scheduledTasks.length, 2);

    const beforeMirror = repository.listOrders({ shopId: 'shop-a', pageSize: 20 });
    const flushed = fixture.storage.flush();
    const afterMirror = repository.listOrders({ shopId: 'shop-a', pageSize: 20 });
    assert.deepEqual(afterMirror, beforeMirror);
    assert.deepEqual(flushed, { ok: true, mirrored: 2, deleted: 0, verified: 2, failures: 0 });

    const shopADb = fixture.router.open('shop-a').db;
    const shopBDb = fixture.router.open('shop-b').db;
    const canonicalA = fixture.canonicalDb.prepare('SELECT * FROM ozon_orders WHERE shop_id = ?').get('shop-a');
    const canonicalB = fixture.canonicalDb.prepare('SELECT * FROM ozon_orders WHERE shop_id = ?').get('shop-b');
    assert.deepEqual(plainRow(shopADb.prepare('SELECT * FROM ozon_orders').get()), plainRow(canonicalA));
    assert.deepEqual(plainRow(shopBDb.prepare('SELECT * FROM ozon_orders').get()), plainRow(canonicalB));
    assert.equal(shopADb.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id = ?').get('shop-b').total, 0);
    assert.equal(shopBDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id = ?').get('shop-a').total, 0);
    assert.throws(
      () => shopADb.prepare('UPDATE ozon_orders SET shop_id = ?').run('shop-b'),
      /SHOP_ORDER_SCOPE_MISMATCH/u,
    );
  } finally {
    await fixture.close();
  }
});

test('order mirror queue deduplicates repeated writes and copies the latest canonical row', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-repeat');
    const repository = createOrderRepository(fixture.canonicalDb, { shopOrderStorage: fixture.storage });
    repository.upsertOrders({ shopId: 'shop-repeat', rows: [order('REPEAT-1', 10, 'awaiting_packaging')] });
    repository.upsertOrders({ shopId: 'shop-repeat', rows: [order('REPEAT-1', 15, 'delivering')] });

    assert.equal(fixture.storage.snapshot().pendingShops, 1);
    assert.equal(fixture.storage.snapshot().pendingRows, 1);
    assert.equal(fixture.scheduledTasks.length, 1);
    assert.deepEqual(fixture.storage.flush('shop-repeat'), {
      ok: true,
      mirrored: 1,
      deleted: 0,
      verified: 1,
      failures: 0,
    });
    const local = fixture.router.open('shop-repeat').db.prepare('SELECT * FROM ozon_orders').get();
    const canonical = fixture.canonicalDb.prepare('SELECT * FROM ozon_orders WHERE shop_id = ?').get('shop-repeat');
    assert.deepEqual(plainRow(local), plainRow(canonical));
    assert.equal(local.status, 'delivering');
    assert.equal(local.amount_value, 15);
  } finally {
    await fixture.close();
  }
});

test('historical order backfill is bounded, resumable and ends in a full row-by-row verification', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-history');
    const canonicalRepository = createOrderRepository(fixture.canonicalDb);
    canonicalRepository.upsertOrders({
      shopId: 'shop-history',
      rows: [order('H-1', 1), order('H-2', 2), order('H-3', 3)],
    });

    const first = fixture.storage.backfillNextBatch({ shopId: 'shop-history', batchSize: 2 });
    assert.equal(first.mirrored, 2);
    assert.equal(first.hasMore, true);
    const second = fixture.storage.backfillNextBatch({ shopId: 'shop-history', batchSize: 2 });
    assert.equal(second.mirrored, 1);
    assert.equal(second.hasMore, true);
    const phases = [first, second];
    while (!phases.at(-1).completed && phases.length < 20) {
      phases.push(fixture.storage.backfillNextBatch({ shopId: 'shop-history', batchSize: 2 }));
    }
    assert.equal(phases.at(-1).completed, true);
    assert.ok(phases.every((result) => result.mirrored <= 2 && result.verified <= 2));
    assert.equal(phases.reduce((total, result) => total + result.mirrored, 0), 3);
    assert.ok(phases.reduce((total, result) => total + result.verified, 0) >= 3);
    assert.equal(fixture.storage.getBackfillState({ shopId: 'shop-history' }).verifiedRows, 3);
    assert.deepEqual(fixture.storage.verifyShop({ shopId: 'shop-history' }), {
      ok: true,
      shopId: 'shop-history',
      sourceTotal: 3,
      targetTotal: 3,
      foreignTotal: 0,
      verified: 3,
    });
  } finally {
    await fixture.close();
  }
});

test('a canonical deletion removes only the matching order from that shop database', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-delete');
    const repository = createOrderRepository(fixture.canonicalDb, { shopOrderStorage: fixture.storage });
    repository.upsertOrders({
      shopId: 'shop-delete',
      rows: [order('D-1', 1), order('D-2', 2)],
    });
    fixture.storage.flush('shop-delete');
    fixture.canonicalDb.prepare('DELETE FROM ozon_orders WHERE shop_id = ? AND order_key = ?').run('shop-delete', 'D-1');
    fixture.storage.enqueueCanonicalRows({ shopId: 'shop-delete', orderKeys: ['D-1'] });
    const result = fixture.storage.flush('shop-delete');
    assert.equal(result.deleted, 1);
    assert.deepEqual(
      fixture.router.open('shop-delete').db.prepare('SELECT order_key FROM ozon_orders ORDER BY order_key').all().map((row) => row.order_key),
      ['D-2'],
    );
  } finally {
    await fixture.close();
  }
});

test('independent storage failure never changes the established order write result', () => {
  const db = createMigratedTestDb();
  const shops = createShopRepository(db);
  saveShop(shops, 'shop-shadow-failure');
  const observed = [];
  const repository = createOrderRepository(db, {
    shopOrderStorage: {
      enqueueCanonicalRows() {
        const error = new Error('simulated storage failure');
        error.code = 'SHOP_ORDER_STORAGE_TEST_FAILURE';
        throw error;
      },
    },
    onShopOrderStorageError(error, context) {
      observed.push({ code: error.code, shopId: context.shopId });
    },
  });
  try {
    const result = repository.upsertOrders({
      shopId: 'shop-shadow-failure',
      rows: [order('SAFE-1', 9.9)],
    });
    assert.equal(result.ok, true);
    assert.equal(result.inserted, 1);
    assert.equal(repository.listOrders({ shopId: 'shop-shadow-failure' }).total, 1);
    assert.deepEqual(observed, [{ code: 'SHOP_ORDER_STORAGE_TEST_FAILURE', shopId: 'shop-shadow-failure' }]);
  } finally {
    db.close();
  }
});

test('a newly bound empty shop writes its first orders directly to the independent database without backfill', async () => {
  const fixture = await createFixture();
  try {
    const binding = saveShop(fixture.shops, 'shop-new-direct');
    assert.deepEqual(fixture.storage.initializeEmptyShop({
      shopId: 'shop-new-direct',
      expectedScopeToken: binding.scopeToken,
    }), {
      ok: true,
      initialized: true,
      requiresBackfill: false,
      sourceTotal: 0,
      targetTotal: 0,
      foreignTotal: 0,
    });
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-new-direct' }).ready, true);

    const repository = createOrderRepository(fixture.canonicalDb, {
      shopOrderStorage: fixture.storage,
      directShopOrderWrites: true,
    });
    const result = repository.upsertOrders({
      shopId: 'shop-new-direct',
      rows: [order('NEW-1', 18.8)],
    });
    assert.equal(result.inserted, 1);
    assert.equal(fixture.scheduledTasks.length, 0);
    assert.equal(fixture.storage.snapshot().pendingRows, 0);
    const readiness = fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-new-direct' });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.sourceTotal, 1);
    assert.equal(readiness.targetTotal, 1);
    assert.deepEqual(
      plainRow(fixture.router.open('shop-new-direct').db.prepare('SELECT * FROM ozon_orders').get()),
      plainRow(fixture.canonicalDb.prepare('SELECT * FROM ozon_orders WHERE shop_id = ?').get('shop-new-direct')),
    );
  } finally {
    await fixture.close();
  }
});

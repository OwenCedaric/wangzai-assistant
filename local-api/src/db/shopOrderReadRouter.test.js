import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createOrderRepository } from './repositories/orderRepository.js';
import { createShopRepository } from './repositories/shopRepository.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopOrderReadRouter } from './shopOrderReadRouter.js';
import { createShopOrderStorage } from './shopOrderStorage.js';

async function createFixture() {
  const databaseRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-order-read-'));
  const canonicalDb = createMigratedTestDb();
  let incarnation = 0;
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-order-read',
    createIncarnation: () => `inc-order-read-${++incarnation}`,
  });
  const manager = createShopDatabaseManager({ root: databaseRoot, profileId: shops.profileId });
  const databaseRouter = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const storage = createShopOrderStorage({
    canonicalDb,
    shopDatabaseRouter: databaseRouter,
    backgroundRunner() {},
  });
  return {
    canonicalDb,
    shops,
    manager,
    databaseRouter,
    storage,
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
    name: id,
    clientId: `client-${id}`,
    apiKey: `secret-${id}`,
    status: 'active',
  });
}

function order(postingNumber, amount, warehouse = 'Moscow') {
  return {
    posting_number: postingNumber,
    order_id: `order-${postingNumber}`,
    status: 'awaiting_packaging',
    in_process_at: '2026-09-03T10:00:00.000Z',
    products: [{ offer_id: `offer-${postingNumber}`, price: amount, quantity: 1 }],
    analytics_data: { region: 'Moscow' },
    financial_data: { total_price: amount },
    delivery_method: { warehouse_name: warehouse, name: 'Courier' },
  };
}

function completeBackfill(storage, shopId) {
  let result = null;
  for (let index = 0; index < 30; index += 1) {
    result = storage.backfillNextBatch({ shopId, batchSize: 2 });
    if (result.completed) return result;
  }
  throw new Error(`backfill did not complete for ${shopId}`);
}

test('only the verified canary shop reads base order data from its independent database', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    saveShop(fixture.shops, 'shop-2');
    const canonicalRepository = createOrderRepository(fixture.canonicalDb);
    canonicalRepository.upsertOrders({
      shopId: 'shop-1',
      rows: [order('ONE-1', 10), order('ONE-2', 20, 'Kazan')],
    });
    canonicalRepository.upsertOrders({ shopId: 'shop-2', rows: [order('TWO-1', 30)] });
    completeBackfill(fixture.storage, 'shop-1');

    const readRouter = createShopOrderReadRouter({
      canonicalDb: fixture.canonicalDb,
      shopOrderStorage: fixture.storage,
      canaryShopIds: ['shop-1'],
    });
    const canaryRepository = createOrderRepository(fixture.canonicalDb, {
      resolveOrderReadDatabase: readRouter.resolve,
      onOrderReadDatabaseError(error, context) {
        readRouter.recordQueryFallback({ shopId: context?.shopId, errorCode: error?.code || error?.message });
      },
    });
    const query = { shopId: 'shop-1', allHistory: true, pageSize: 50 };

    assert.deepEqual(canaryRepository.listOrders(query), canonicalRepository.listOrders(query));
    assert.deepEqual(canaryRepository.summarizeOrders(query), canonicalRepository.summarizeOrders(query));
    assert.deepEqual(canaryRepository.listPrintShippingFacets(query), canonicalRepository.listPrintShippingFacets(query));
    assert.equal(readRouter.snapshot().localSelections, 3);

    assert.deepEqual(
      canaryRepository.listOrders({ shopId: 'shop-2', allHistory: true }),
      canonicalRepository.listOrders({ shopId: 'shop-2', allHistory: true }),
    );
    assert.deepEqual(
      canaryRepository.listOrders({ shopIds: ['shop-1', 'shop-2'], allHistory: true }),
      canonicalRepository.listOrders({ shopIds: ['shop-1', 'shop-2'], allHistory: true }),
    );
    assert.equal(readRouter.snapshot().nonCanarySelections, 1);
    assert.equal(readRouter.snapshot().aggregateSelections, 1);
  } finally {
    await fixture.close();
  }
});

test('a changed canonical canary or failed local query automatically falls back to canonical orders', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    const canonicalRepository = createOrderRepository(fixture.canonicalDb);
    canonicalRepository.upsertOrders({ shopId: 'shop-1', rows: [order('SAFE-1', 10)] });
    completeBackfill(fixture.storage, 'shop-1');
    fixture.canonicalDb.prepare(`
      UPDATE ozon_orders
      SET amount_value = ?, updated_at = ?
      WHERE shop_id = ?
    `).run(99, '2026-09-03T12:00:00.000Z', 'shop-1');

    const readRouter = createShopOrderReadRouter({
      canonicalDb: fixture.canonicalDb,
      shopOrderStorage: fixture.storage,
      canaryShopIds: ['shop-1'],
    });
    const safeRepository = createOrderRepository(fixture.canonicalDb, {
      resolveOrderReadDatabase: readRouter.resolve,
    });
    assert.deepEqual(
      safeRepository.listOrders({ shopId: 'shop-1', allHistory: true }),
      canonicalRepository.listOrders({ shopId: 'shop-1', allHistory: true }),
    );
    assert.equal(readRouter.snapshot().safetyFallbacks, 1);
    assert.equal(readRouter.snapshot().lastFallbackReason, 'canonical_changed_since_verification');

    const queryFailures = [];
    const brokenRepository = createOrderRepository(fixture.canonicalDb, {
      resolveOrderReadDatabase() {
        return {
          shopId: 'shop-1',
          db: { prepare() { throw new Error('BROKEN_LOCAL_QUERY'); } },
        };
      },
      onOrderReadDatabaseError(error, context) {
        queryFailures.push({ message: error.message, phase: context.phase, shopId: context.shopId });
      },
    });
    assert.deepEqual(
      brokenRepository.listOrders({ shopId: 'shop-1', allHistory: true }),
      canonicalRepository.listOrders({ shopId: 'shop-1', allHistory: true }),
    );
    assert.deepEqual(queryFailures, [{ message: 'BROKEN_LOCAL_QUERY', phase: 'query', shopId: 'shop-1' }]);
  } finally {
    await fixture.close();
  }
});

test('all-ready mode automatically admits a newly initialized shop but still rejects aggregate reads', async () => {
  const fixture = await createFixture();
  try {
    const binding = saveShop(fixture.shops, 'shop-new');
    fixture.storage.initializeEmptyShop({ shopId: 'shop-new', expectedScopeToken: binding.scopeToken });
    const repository = createOrderRepository(fixture.canonicalDb, {
      shopOrderStorage: fixture.storage,
      directShopOrderWrites: true,
    });
    repository.upsertOrders({ shopId: 'shop-new', rows: [order('AUTO-1', 42)] });
    const readRouter = createShopOrderReadRouter({
      canonicalDb: fixture.canonicalDb,
      shopOrderStorage: fixture.storage,
      includeAllReadyShops: true,
    });
    assert.equal(readRouter.resolve({ shopId: 'shop-new' }).source, 'shop');
    assert.equal(readRouter.resolve({ shopIds: ['shop-new'] }).source, 'shop');
    assert.equal(readRouter.resolve({ shopId: 'all' }).source, 'canonical');
    assert.equal(readRouter.snapshot().localSelections, 2);
    assert.equal(readRouter.snapshot().aggregateSelections, 1);
  } finally {
    await fixture.close();
  }
});

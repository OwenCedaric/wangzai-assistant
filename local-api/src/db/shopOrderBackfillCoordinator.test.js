import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopOrderBackfillCoordinator } from './shopOrderBackfillCoordinator.js';
import { createShopOrderStorage } from './shopOrderStorage.js';
import { createOrderRepository } from './repositories/orderRepository.js';
import { createShopRepository } from './repositories/shopRepository.js';

async function createFixture() {
  const databaseRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-order-backfill-'));
  const canonicalDb = createMigratedTestDb();
  let incarnation = 0;
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-order-backfill',
    createIncarnation: () => `inc-order-backfill-${++incarnation}`,
  });
  const manager = createShopDatabaseManager({ root: databaseRoot, profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const createStorage = () => createShopOrderStorage({
    canonicalDb,
    shopDatabaseRouter: router,
    backgroundRunner() {},
  });
  return {
    canonicalDb,
    shops,
    manager,
    router,
    createStorage,
    async close() {
      manager.closeAll();
      canonicalDb.close();
      await rm(databaseRoot, { recursive: true, force: true });
    },
  };
}

function saveShop(shops, id) {
  shops.saveShop({
    id,
    name: `Shop ${id}`,
    clientId: `client-${id}`,
    apiKey: `secret-${id}`,
    status: 'active',
  });
}

function order(postingNumber, amount = 1) {
  return {
    posting_number: postingNumber,
    order_id: `order-${postingNumber}`,
    status: 'awaiting_packaging',
    in_process_at: '2026-09-03T10:00:00.000Z',
    products: [{ price: amount, quantity: 1 }],
  };
}

function runToCompletion(coordinator, maximumRuns = 100) {
  const results = [];
  while (results.length < maximumRuns) {
    const result = coordinator.runOnce();
    results.push(result);
    if (result.completed || result.alreadyComplete || result.ok === false) break;
  }
  return results;
}

test('pausing one owner removes queued backfill and blocks rediscovery without stopping another owner', () => {
  const visited = [];
  const coordinator = createShopOrderBackfillCoordinator({
    shopRepository: { listShops: () => [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }] },
    shopOrderStorage: { backfillNextBatch({ shopId }) { visited.push(shopId); return { completed: true }; } },
  });
  coordinator.discover();
  coordinator.pauseOwner('a');
  coordinator.wake('a');
  coordinator.runOnce();
  coordinator.discover();
  coordinator.runOnce();
  assert.deepEqual(visited, ['b', 'b']);
  assert.equal(coordinator.getOwnerStatus('a').queued, 0);
  coordinator.releaseOwner('a');
  coordinator.wake('a');
  coordinator.runOnce();
  assert.equal(visited.at(-1), 'a');
});

test('historical backfill resumes from the durable per-shop cursor after a coordinator restart', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-resume');
    createOrderRepository(fixture.canonicalDb).upsertOrders({
      shopId: 'shop-resume',
      rows: [order('R-1'), order('R-2'), order('R-3')],
    });

    const firstStorage = fixture.createStorage();
    const firstCoordinator = createShopOrderBackfillCoordinator({
      shopRepository: fixture.shops,
      shopOrderStorage: firstStorage,
      batchSize: 1,
    });
    const first = firstCoordinator.runOnce();
    assert.equal(first.mirrored, 1);
    assert.equal(first.hasMore, true);
    const firstState = firstStorage.getBackfillState({ shopId: 'shop-resume' });
    assert.equal(firstState.status, 'running');
    assert.equal(firstState.batchCount, 1);
    assert.notEqual(firstState.cursorOrderKey, '');

    const restartedStorage = fixture.createStorage();
    const restartedCoordinator = createShopOrderBackfillCoordinator({
      shopRepository: fixture.shops,
      shopOrderStorage: restartedStorage,
      batchSize: 1,
    });
    assert.equal(restartedCoordinator.runOnce().mirrored, 1);
    const resumedResults = runToCompletion(restartedCoordinator);
    const completed = resumedResults.at(-1);
    assert.equal(completed.completed, true);
    assert.equal(completed.hasMore, false);
    const state = restartedStorage.getBackfillState({ shopId: 'shop-resume' });
    assert.equal(state.status, 'completed');
    assert.ok(state.batchCount >= 3);
    assert.equal(state.mirroredRows, 3);
    assert.equal(restartedStorage.verifyShop({ shopId: 'shop-resume' }).ok, true);
  } finally {
    await fixture.close();
  }
});

test('one migration lane processes shops round-robin and keeps their rows physically isolated', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-round-a');
    saveShop(fixture.shops, 'shop-round-b');
    const orders = createOrderRepository(fixture.canonicalDb);
    orders.upsertOrders({ shopId: 'shop-round-a', rows: [order('A-1'), order('A-2')] });
    orders.upsertOrders({ shopId: 'shop-round-b', rows: [order('B-1'), order('B-2')] });
    const storage = fixture.createStorage();
    const coordinator = createShopOrderBackfillCoordinator({
      shopRepository: fixture.shops,
      shopOrderStorage: storage,
      batchSize: 1,
    });

    const first = coordinator.runOnce();
    const second = coordinator.runOnce();
    assert.notEqual(first.shopId, second.shopId);
    assert.equal(fixture.router.open('shop-round-a').db.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 1);
    assert.equal(fixture.router.open('shop-round-b').db.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 1);
    assert.equal(
      fixture.router.open('shop-round-a').db.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id <> ?').get('shop-round-a').total,
      0,
    );
    assert.equal(
      fixture.router.open('shop-round-b').db.prepare('SELECT COUNT(*) AS total FROM ozon_orders WHERE shop_id <> ?').get('shop-round-b').total,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test('a completed shop automatically restarts from the beginning when canonical history changes', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-changed');
    const orders = createOrderRepository(fixture.canonicalDb);
    orders.upsertOrders({ shopId: 'shop-changed', rows: [order('C-1')] });
    const storage = fixture.createStorage();
    const firstCoordinator = createShopOrderBackfillCoordinator({
      shopRepository: fixture.shops,
      shopOrderStorage: storage,
      batchSize: 10,
    });
    assert.equal(runToCompletion(firstCoordinator).at(-1).completed, true);

    orders.upsertOrders({ shopId: 'shop-changed', rows: [order('C-2')] });
    const restartedCoordinator = createShopOrderBackfillCoordinator({
      shopRepository: fixture.shops,
      shopOrderStorage: storage,
      batchSize: 10,
    });
    const refreshedResults = runToCompletion(restartedCoordinator);
    const refreshed = refreshedResults.at(-1);
    assert.equal(refreshed.alreadyComplete, false);
    assert.equal(refreshed.completed, true);
    assert.equal(storage.verifyShop({ shopId: 'shop-changed' }).sourceTotal, 2);
  } finally {
    await fixture.close();
  }
});

test('failed batches are bounded, persisted for diagnosis and never retry forever', () => {
  let attempts = 0;
  const recorded = [];
  const coordinator = createShopOrderBackfillCoordinator({
    shopRepository: {
      listShops() {
        return [{ id: 'shop-failure', status: 'active', disabledAt: null }];
      },
    },
    shopOrderStorage: {
      backfillNextBatch() {
        attempts += 1;
        const error = new Error('temporary failure');
        error.code = 'SHOP_ORDER_BACKFILL_TEST_FAILURE';
        throw error;
      },
      recordBackfillFailure(input) {
        recorded.push(input);
      },
    },
    maxRetries: 1,
  });

  assert.equal(coordinator.runOnce().ok, false);
  assert.equal(coordinator.snapshot().queuedShops, 1);
  assert.equal(coordinator.runOnce().ok, false);
  assert.equal(coordinator.snapshot().queuedShops, 0);
  assert.equal(attempts, 2);
  assert.equal(recorded.length, 2);
  assert.equal(coordinator.snapshot().failures, 2);
});

test('start schedules background work and stop cancels it before databases close', () => {
  const timers = [];
  const cleared = [];
  let batches = 0;
  const coordinator = createShopOrderBackfillCoordinator({
    shopRepository: {
      listShops() {
        return [{ id: 'shop-timer', status: 'active', disabledAt: null }];
      },
    },
    shopOrderStorage: {
      backfillNextBatch() {
        batches += 1;
        return { ok: true, mirrored: 1, verified: 1, completed: true, hasMore: false };
      },
    },
    setTimer(callback, delay) {
      const handle = { callback, delay, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      cleared.push(handle);
    },
  });

  assert.equal(coordinator.start().active, true);
  assert.equal(timers.length, 1);
  timers.shift().callback();
  assert.equal(batches, 1);
  assert.equal(timers.length, 1);
  const pendingTimer = timers[0];
  const stopped = coordinator.stop();
  assert.equal(stopped.active, false);
  assert.equal(stopped.queuedShops, 0);
  assert.deepEqual(cleared, [pendingTimer]);
  pendingTimer.callback();
  assert.equal(batches, 1);
});

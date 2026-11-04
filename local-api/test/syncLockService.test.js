import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createOzonScheduler } from '../src/ozon/ozonScheduler.js';
import { createSyncLockService } from '../src/sync/syncLockService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

test('syncLockService acquires, rejects duplicate, releases, and supports TTL takeover', async () => {
  const db = createMigratedTestDb();
  try {
    const locks = createSyncLockService(db);
    const first = locks.acquire({ domain: 'orders', shopId: 'shop-a', cacheKey: 'orders:1', ownerJobId: 'job-1', ttlMs: 20 });
    assert.equal(first.acquired, true);
    const duplicate = locks.acquire({ domain: 'orders', shopId: 'shop-a', cacheKey: 'orders:1', ownerJobId: 'job-2', ttlMs: 20 });
    assert.equal(duplicate.acquired, false);
    assert.equal(duplicate.existingJobId, 'job-1');
    assert.equal(locks.release(first.lock.lockKey, 'job-1').released, true);
    const reacquired = locks.acquire({ domain: 'orders', shopId: 'shop-a', cacheKey: 'orders:1', ownerJobId: 'job-3', ttlMs: 20 });
    assert.equal(reacquired.acquired, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const takeover = locks.acquire({ domain: 'orders', shopId: 'shop-a', cacheKey: 'orders:1', ownerJobId: 'job-4', ttlMs: 20 });
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.lock.ownerJobId, 'job-4');
  } finally {
    db.close();
  }
});

test('scheduler uses persistent lock and cancel releases lock', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_lock_scheduler');
    let release;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      ozonClient: { async requestReadOnly() { return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, data: { result: [] } }); }); } },
      queueOptions: { shopConcurrency: 1 },
    });
    const promise = scheduler.executeReadOnly({ shopId, domain: 'catalog', endpointKey: 'catalog.categoryTree', action: 'sync', params: {}, cacheKey: 'catalog:lock', forceRefresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    const locksBefore = scheduler.getSchedulerStatus().locks;
    assert.equal(locksBefore.length, 1);
    const cancel = scheduler.cancelJob(locksBefore[0].ownerJobId, 'unit cancel');
    assert.equal(cancel.job.status, 'canceled');
    assert.equal(createSyncLockService(db).get(locksBefore[0].lockKey).status, 'released');
    release();
    await promise;
  } finally {
    db.close();
  }
});


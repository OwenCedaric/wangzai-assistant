import assert from 'node:assert/strict';
import test from 'node:test';
import { createCacheMergeService } from '../src/cache/cacheMergeService.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createOzonScheduler } from '../src/ozon/ozonScheduler.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

function createBlockingClient() {
  let release;
  const calls = [];
  return {
    calls,
    release(value = { ok: true, status: 200, data: { result: [{ id: 1 }] } }) {
      release?.(value);
    },
    client: {
      async requestReadOnly(request) {
        calls.push(request);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  };
}

function createSyncStateFailureDb(db, failingWrites = new Set()) {
  let syncStateWrites = 0;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql);
          if (!String(sql).includes('INSERT INTO ozon_sync_state')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'run') {
                return (...args) => {
                  syncStateWrites += 1;
                  if (failingWrites.has(syncStateWrites)) {
                    const error = new Error(`forced sync-state finalization failure ${syncStateWrites}`);
                    error.code = 'SQLITE_IOERR_TEST';
                    throw error;
                  }
                  return statementTarget.run(...args);
                };
              }
              const value = statementTarget[statementProperty];
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('scheduler reuses active job by request fingerprint', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_dedupe_fingerprint');
    const blocking = createBlockingClient();
    const scheduler = createOzonScheduler({ db, shopRepository, ozonClient: blocking.client, queueOptions: { shopConcurrency: 1 } });
    const payload = { shopId, domain: 'catalog', endpointKey: 'catalog.categoryTree', action: 'sync', params: { language: 'DEFAULT' }, cacheKey: 'catalog:dedupe', forceRefresh: true };
    const firstPromise = scheduler.executeReadOnly(payload);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await scheduler.executeReadOnly(payload);
    assert.equal(second.reused, true);
    assert.equal(second.reason, 'request_fingerprint_active');
    blocking.release();
    const first = await firstPromise;
    assert.equal(first.status, 'success');
    assert.equal(second.reusedFromJobId, first.jobId);
    assert.equal(blocking.calls.length, 1);
  } finally {
    db.close();
  }
});

test('scheduler waitForResult followers receive the completed response payload', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_dedupe_wait_result');
    const blocking = createBlockingClient();
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      ozonClient: blocking.client,
      queueOptions: { shopConcurrency: 1 },
    });
    const payload = {
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      params: { language: 'DEFAULT' },
      cacheKey: 'catalog:dedupe:wait-result',
      forceRefresh: true,
    };
    const ownerPromise = scheduler.executeReadOnly(payload);
    await new Promise((resolve) => setImmediate(resolve));
    let followerSettled = false;
    const followerPromise = scheduler
      .executeReadOnly({ ...payload, waitForResult: true })
      .then((result) => {
        followerSettled = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(followerSettled, false);

    blocking.release({
      ok: true,
      status: 200,
      data: { result: [{ id: 7, name: '等待后的真实结果' }] },
    });
    const [owner, follower] = await Promise.all([ownerPromise, followerPromise]);
    assert.equal(owner.status, 'success');
    assert.equal(follower.status, 'success');
    assert.equal(follower.reused, true);
    assert.equal(follower.reason, 'request_fingerprint_active');
    assert.deepEqual(follower.data, owner.data);
    assert.equal(follower.data.result[0].id, 7);
    assert.equal(blocking.calls.length, 1);
  } finally {
    db.close();
  }
});

test('scheduler always releases singleflight and lock state when terminal persistence throws', async () => {
  const baseDb = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(baseDb);
    const shopId = saveUnitShop(shopRepository, 'shop_dedupe_finally_cleanup');
    const db = createSyncStateFailureDb(baseDb, new Set([2, 3]));
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      queueOptions: { shopConcurrency: 1 },
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          if (calls === 1) {
            const error = new Error('forced first request failure');
            error.code = 'OZON_BAD_REQUEST';
            error.status = 400;
            throw error;
          }
          return { ok: true, status: 200, data: { result: [{ id: 9 }] } };
        },
      },
    });
    const payload = {
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      params: { language: 'DEFAULT' },
      cacheKey: 'catalog:dedupe:finally-cleanup',
      forceRefresh: true,
    };

    await assert.rejects(scheduler.executeReadOnly(payload), /forced sync-state finalization failure 3/);
    assert.equal(scheduler.getSchedulerStatus().locks.length, 0);

    const retried = await scheduler.executeReadOnly(payload);
    assert.equal(retried.ok, true);
    assert.equal(retried.status, 'success');
    assert.equal(retried.reused, false);
    assert.equal(calls, 2);
  } finally {
    baseDb.close();
  }
});

test('scheduler rejects different requests that accidentally share one active cache key', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_dedupe_cache_collision');
    const blocking = createBlockingClient();
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      ozonClient: blocking.client,
      queueOptions: { shopConcurrency: 2 },
    });
    const ownerPromise = scheduler.executeReadOnly({
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      params: { language: 'DEFAULT' },
      cacheKey: 'catalog:collision',
      forceRefresh: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const collision = await scheduler.executeReadOnly({
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      params: { language: 'RU' },
      cacheKey: 'catalog:collision',
      forceRefresh: true,
      waitForResult: true,
    });
    assert.equal(collision.ok, false);
    assert.equal(collision.status, 'failed');
    assert.equal(collision.reason, 'cache_key_collision');
    assert.equal(collision.error.code, 'OZON_CACHE_KEY_COLLISION');
    assert.equal(blocking.calls.length, 1);

    blocking.release();
    const owner = await ownerPromise;
    assert.equal(owner.status, 'success');
  } finally {
    db.close();
  }
});

test('scheduler coalesces 100 concurrent equivalent reads into one physical Ozon request', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_dedupe_hundred');
    const blocking = createBlockingClient();
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      ozonClient: blocking.client,
      queueOptions: { shopConcurrency: 1 },
    });
    const payload = {
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      params: { language: 'DEFAULT' },
      cacheKey: 'catalog:dedupe:hundred',
      forceRefresh: true,
    };
    const ownerPromise = scheduler.executeReadOnly(payload);
    await new Promise((resolve) => setImmediate(resolve));

    const followers = await Promise.all(
      Array.from({ length: 100 }, () => scheduler.executeReadOnly(payload)),
    );

    assert.equal(followers.every((result) => result.reused === true), true);
    assert.equal(followers.every((result) => result.reason === 'request_fingerprint_active'), true);
    assert.equal(new Set(followers.map((result) => result.reusedFromJobId)).size, 1);
    assert.equal(blocking.calls.length, 1);
    blocking.release();
    const owner = await ownerPromise;
    assert.equal(owner.status, 'success');
    assert.equal(followers[0].reusedFromJobId, owner.jobId);
    assert.equal(blocking.calls.length, 1);
  } finally {
    db.close();
  }
});

test('scheduler reuses idempotencyKey before dedupe_until', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_dedupe_idem');
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      ozonClient: { async requestReadOnly() { calls += 1; return { ok: true, status: 200, data: { result: [] } }; } },
    });
    const first = await scheduler.executeReadOnly({ shopId, domain: 'catalog', endpointKey: 'catalog.categoryTree', action: 'sync', params: { a: 1 }, cacheKey: 'catalog:idem:a', idempotencyKey: 'idem-1', forceRefresh: true });
    const second = await scheduler.executeReadOnly({ shopId, domain: 'catalog', endpointKey: 'catalog.categoryTree', action: 'sync', params: { a: 2 }, cacheKey: 'catalog:idem:b', idempotencyKey: 'idem-1', forceRefresh: true });
    assert.equal(first.status, 'success');
    assert.equal(second.reused, true);
    assert.equal(second.reason, 'idempotency_key_dedupe');
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});

test('scheduler returns fresh cache when forceRefresh=false and creates job when true', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_dedupe_cache');
    createCacheMergeService(db).mergeResponse({
      domain: 'catalog', shopId, endpointKey: 'catalog.categoryTree', cacheKey: 'catalog:fresh',
      payload: { result: ['cached'] }, remoteHash: 'fresh-hash', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    let calls = 0;
    const scheduler = createOzonScheduler({ db, shopRepository, ozonClient: { async requestReadOnly() { calls += 1; return { ok: true, status: 200, data: { result: ['remote'] } }; } } });
    const cached = await scheduler.executeReadOnly({ shopId, domain: 'catalog', endpointKey: 'catalog.categoryTree', action: 'sync', params: {}, cacheKey: 'catalog:fresh' });
    assert.equal(cached.cacheHit, true);
    assert.equal(calls, 0);
    const refreshed = await scheduler.executeReadOnly({ shopId, domain: 'catalog', endpointKey: 'catalog.categoryTree', action: 'sync', params: {}, cacheKey: 'catalog:fresh', forceRefresh: true });
    assert.equal(refreshed.status, 'success');
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});

test('scheduler detects unfinished job from SQLite after scheduler recreation', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_dedupe_restart');
    const blocking = createBlockingClient();
    const firstScheduler = createOzonScheduler({ db, shopRepository, ozonClient: blocking.client, queueOptions: { shopConcurrency: 1 } });
    const payload = { shopId, domain: 'catalog', endpointKey: 'catalog.categoryTree', action: 'sync', params: { language: 'DEFAULT' }, cacheKey: 'catalog:restart', forceRefresh: true };
    const firstPromise = firstScheduler.executeReadOnly(payload);
    await new Promise((resolve) => setImmediate(resolve));
    const secondScheduler = createOzonScheduler({ db, shopRepository, ozonClient: blocking.client });
    const second = await secondScheduler.executeReadOnly(payload);
    assert.equal(second.reused, true);
    assert.equal(second.reason, 'request_fingerprint_active');
    blocking.release();
    await firstPromise;
  } finally {
    db.close();
  }
});


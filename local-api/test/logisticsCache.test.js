import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createCacheMergeService } from '../src/cache/cacheMergeService.js';
import { createCacheReadService } from '../src/cache/cacheReadService.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createLogisticsService } from '../src/domain/logistics/logisticsService.js';
import { createMigratedTestDb } from './testDb.js';

function createFakeScheduler(response = { ok: true, status: 'success', data: { result: [] } }) {
  const calls = [];
  let dbRef = null;
  return {
    calls,
    attachDb(db) { dbRef = db; },
    async executeReadOnly(request) {
      calls.push(request);
      if (dbRef) {
        createCacheMergeService(dbRef).mergeResponse({
          domain: request.domain,
          shopId: request.shopId,
          endpointKey: request.endpointKey,
          cacheKey: request.cacheKey,
          payload: response.data,
          remoteHash: `hash-${request.endpointKey}`,
          status: 'confirmed',
        });
      }
      return response;
    },
    readCache(domain, query = {}) {
      return createCacheReadService(dbRef).readDomainCache(domain, query);
    },
    getJob() { return null; },
    cancelJob() { return { ok: true, canceled: 0 }; },
    listSyncState() { return []; },
    listEndpoints() { return []; },
    getSchedulerStatus() { return { ok: true, queue: {} }; },
    getRateLimitStatus() { return { ok: true, rows: [] }; },
    listErrors() { return []; },
    pauseShop(shopId) { return { ok: true, shopId, paused: true }; },
    resumeShop(shopId) { return { ok: true, shopId, paused: false }; },
    pauseEndpoint(endpointKey) { return { ok: true, endpointKey, paused: true }; },
    resumeEndpoint(endpointKey) { return { ok: true, endpointKey, paused: false }; },
  };
}

async function withServer(db, ozonScheduler, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonScheduler,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('logistics service syncs warehouse dictionary into response cache without entity table', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({ id: 'shop-l1', name: 'Logistics shop', clientId: 'client-l1', apiKey: 'key-l1' });
    const scheduler = createFakeScheduler({ ok: true, status: 'success', data: { result: [{ warehouse_id: 1, name: 'WH' }] } });
    scheduler.attachDb(db);
    const service = createLogisticsService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const job = service.startSync({
      shopId: 'shop-l1',
      endpointKey: 'warehouse.list',
      source: 'recovery-reconcile',
      syncMode: 'recovery-reconcile',
      recoveryRestoreId: 'restore-logistics-contract',
      recoveryGenerationId: 'generation-logistics-contract',
      recoveryOverlapMinutes: 30,
    });
    assert.equal(job.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));
    const rows = db.prepare('SELECT * FROM ozon_response_cache WHERE domain = ? AND endpoint_key = ?').all('logistics', 'warehouse.list');
    assert.equal(rows.length, 1);
    assert.equal(scheduler.calls[0].cacheKey, 'logistics:shop-l1:warehouse.list');
    assert.equal(scheduler.calls[0].source, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].syncMode, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].recoveryRestoreId, 'restore-logistics-contract');
    assert.equal(scheduler.calls[0].recoveryGenerationId, 'generation-logistics-contract');
    assert.equal(scheduler.calls[0].recoveryOverlapMinutes, 30);
    assert.equal(scheduler.calls[0].forceRefresh, true);
    assert.deepEqual(scheduler.calls[0].params, { limit: 100, cursor: '' });
  } finally {
    db.close();
  }
});

test('logistics HTTP routes expose /api/sync/logistics and /api/cache/logistics', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({ id: 'shop-l2', name: 'Logistics shop', clientId: 'client-l2', apiKey: 'key-l2' });
    const scheduler = createFakeScheduler({ ok: true, status: 'success', data: { result: [{ id: 2, name: 'Delivery' }] } });
    scheduler.attachDb(db);
    await withServer(db, scheduler, async (base) => {
      const syncResponse = await fetch(`${base}/api/sync/logistics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shopId: 'shop-l2', endpointKey: 'deliveryMethod.list' }),
      });
      const syncPayload = await syncResponse.json();
      assert.equal(syncResponse.status, 202);
      assert.equal(syncPayload.ok, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(scheduler.calls[0].params, { limit: 100 });

      const cacheResponse = await fetch(`${base}/api/cache/logistics?shopId=shop-l2&cacheKey=logistics:shop-l2:deliveryMethod.list&pageSize=1`);
      const cachePayload = await cacheResponse.json();
      assert.equal(cacheResponse.status, 200);
      assert.equal(cachePayload.ok, true);
      assert.equal(cachePayload.rows.length, 1);
      assert.equal(cachePayload.rows[0].endpointKey, 'deliveryMethod.list');
    });
  } finally {
    db.close();
  }
});

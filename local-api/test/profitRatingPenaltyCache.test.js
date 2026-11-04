import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createRatingPenaltyRepository } from '../src/db/repositories/ratingPenaltyRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import {
  createProfitService,
  PROFIT_SYNC_ENDPOINT_KEYS,
} from '../src/domain/profit/profitService.js';
import { listOzonEndpoints } from '../src/ozon/ozonEndpointRegistry.js';
import { createMigratedTestDb } from './testDb.js';

function createFakeScheduler(responses = []) {
  const calls = [];
  return {
    calls,
    async executeReadOnly(request) {
      calls.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response || { ok: true, status: 'success', data: { result: { postings: [] } } };
    },
    readCache() { return { ok: true, source: 'sqlite', rows: [] }; },
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

test('rating penalty repository stores compact rows and reads by posting', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createRatingPenaltyRepository(db);
    const merge = repository.upsertPenalties({
      shopId: 'shop-p1',
      rows: [
        {
          operation_id: 'op-1',
          posting_number: 'posting-1',
          operation_type: 'rating_penalty',
          operation_type_name: '错误指数罚款',
          operation_date: '2026-06-29T10:00:00Z',
          error_fee_cny: -12.5,
        },
      ],
    });
    assert.equal(merge.changed, 1);
    const page = repository.listPenalties({ shopId: 'shop-p1', postingNumber: 'posting-1' });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].operation_id, 'op-1');
    assert.equal(page.rows[0].posting_number, 'posting-1');
    assert.equal(page.rows[0].error_fee_cny, -12.5);
  } finally {
    db.close();
  }
});

test('profit service syncs rating penalties through scheduler and preserves old cache on empty result', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({ id: 'shop-p2', name: 'Profit shop', clientId: 'client-p2', apiKey: 'key-p2' });
    const scheduler = createFakeScheduler([
      { ok: true, status: 'success', data: { result: { postings: [{ operation_id: 'op-2', posting_number: 'posting-2', amount: -8 }] } } },
      { ok: true, status: 'success', data: { result: { postings: [] } } },
    ]);
    const service = createProfitService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const first = service.startSync({
      shopId: 'shop-p2',
      endpointKey: 'rating.fbsPostingList',
      maxPages: 1,
      source: 'recovery-reconcile',
      syncMode: 'recovery-reconcile',
      recoveryRestoreId: 'restore-profit-contract',
      recoveryGenerationId: 'generation-profit-contract',
      recoveryOverlapMinutes: 30,
    });
    assert.equal(first.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.readCache({ scope: 'rating-penalties', shopId: 'shop-p2' }).total, 1);
    assert.equal(scheduler.calls[0].source, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].syncMode, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].recoveryRestoreId, 'restore-profit-contract');
    assert.equal(scheduler.calls[0].recoveryGenerationId, 'generation-profit-contract');
    assert.equal(scheduler.calls[0].recoveryOverlapMinutes, 30);
    assert.equal(scheduler.calls[0].forceRefresh, true);

    service.startSync({ shopId: 'shop-p2', endpointKey: 'rating.fbsPostingList', maxPages: 1, forceRefresh: true, idempotencyKey: 'rating-empty' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.readCache({ scope: 'rating-penalties', shopId: 'shop-p2' }).total, 1);
    assert.equal(scheduler.calls[0].endpointKey, 'rating.fbsPostingList');
  } finally {
    db.close();
  }
});

test('profit sync contract covers every registered read endpoint and rejects unknown routes explicitly', () => {
  const registeredProfitReads = listOzonEndpoints()
    .filter((endpoint) => endpoint.domain === 'profit' && endpoint.risk === 'read')
    .map((endpoint) => endpoint.key)
    .sort();
  assert.deepEqual([...PROFIT_SYNC_ENDPOINT_KEYS].sort(), registeredProfitReads);

  const result = createProfitService().startSync({
    shopId: 'shop-p4',
    endpointKey: 'finance.transactionList',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROFIT_ENDPOINT_NOT_SUPPORTED');
  assert.deepEqual(result.supportedEndpointKeys, ['rating.fbsPostingList']);
});

test('profit HTTP routes expose rating penalty sync and cache', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({ id: 'shop-p3', name: 'Profit shop', clientId: 'client-p3', apiKey: 'key-p3' });
    const scheduler = createFakeScheduler([
      { ok: true, status: 'success', data: { result: { postings: [{ operation_id: 'op-3', posting_number: 'posting-3', amount: -3 }] } } },
    ]);
    await withServer(db, scheduler, async (base) => {
      const syncResponse = await fetch(`${base}/api/sync/profit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shopId: 'shop-p3', endpointKey: 'rating.fbsPostingList', pageSize: 1000, maxPages: 1 }),
      });
      const syncPayload = await syncResponse.json();
      assert.equal(syncResponse.status, 202);
      assert.equal(syncPayload.ok, true);
      await new Promise((resolve) => setImmediate(resolve));

      const cacheResponse = await fetch(`${base}/api/cache/profit?scope=rating-penalties&shopId=shop-p3&pageSize=20`);
      const cachePayload = await cacheResponse.json();
      assert.equal(cacheResponse.status, 200);
      assert.equal(cachePayload.ok, true);
      assert.equal(cachePayload.rows.length, 1);
      assert.equal(cachePayload.rows[0].operation_id, 'op-3');
    });
  } finally {
    db.close();
  }
});

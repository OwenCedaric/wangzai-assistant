import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCacheMergeService } from '../src/cache/cacheMergeService.js';
import { runMigrations } from '../src/db/database.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createOzonScheduler } from '../src/ozon/ozonScheduler.js';
import { createRateLimitState } from '../src/ozon/rateLimitState.js';
import { createRequestQueue } from '../src/ozon/requestQueue.js';
import { createApp } from '../src/app/createApp.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

function saveUnitShop(shopRepository, id = 'shop_scheduler_unit') {
  shopRepository.saveShop({
    id,
    name: 'Scheduler unit shop',
    ['client' + 'Id']: 'opaque-client',
    ['api' + 'Key']: 'opaque-key',
    status: 'active',
  });
  return id;
}

test('request queue honors priority while dispatching independent shop lanes', async () => {
  const queue = createRequestQueue({ shopConcurrency: 1, endpointConcurrency: 1 });
  const order = [];
  const slow = queue.enqueue({ jobId: 'job-low', requestId: 'low', priority: 'P3', shopId: 's1', endpointKey: 'e1' }, async () => {
    order.push('low');
    return 'low';
  });
  const fast = queue.enqueue({ jobId: 'job-high', requestId: 'high', priority: 'P0', shopId: 's2', endpointKey: 'e1' }, async () => {
    order.push('high');
    return 'high';
  });

  assert.deepEqual(await Promise.all([slow, fast]), ['low', 'high']);
  assert.deepEqual(order, ['high', 'low']);
});

test('request queue can cancel queued jobs before execution', async () => {
  const queue = createRequestQueue({ shopConcurrency: 1, endpointConcurrency: 1 });
  let releaseFirst;
  const first = queue.enqueue({ jobId: 'job-running', requestId: 'running', priority: 'P1', shopId: 's1', endpointKey: 'e1' }, async () => new Promise((resolve) => {
    releaseFirst = () => resolve('done');
  }));
  const second = queue.enqueue({ jobId: 'job-cancel', requestId: 'cancel', priority: 'P1', shopId: 's1', endpointKey: 'e1' }, async () => 'should-not-run');

  const cancelResult = queue.cancelJob('job-cancel');
  assert.equal(cancelResult.canceled, 1);
  await assert.rejects(second, /canceled/iu);
  releaseFirst();
  assert.equal(await first, 'done');
});

test('rate limit state records 429 retry-after and opens circuit after repeated failures', () => {
  const db = createTestDb();
  try {
    const shopRepository = createShopRepository(db);
    saveUnitShop(shopRepository, 'shop-rl');
    const rateLimit = createRateLimitState(db, { failureThreshold: 2, circuitCooldownMs: 60_000 });
    const ticket = { shopId: 'shop-rl', endpointKey: 'catalog.categoryTree', endpoint: { rate: { bucket: 'catalog.read' } } };

    rateLimit.recordFailure(ticket, { status: 429, retryAfterMs: 5_000, message: 'too many requests' });
    const blocked = rateLimit.beforeRequest(ticket);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.status, 'rate_limited');
    assert.ok(blocked.retryAfterMs > 0);

    rateLimit.recordFailure(ticket, new Error('second failure'));
    const circuit = rateLimit.beforeRequest(ticket);
    assert.equal(circuit.allowed, false);
    assert.equal(circuit.status, 'circuit_open');
  } finally {
    db.close();
  }
});

test('cache merge keeps confirmed data safe and preserves real zero values', () => {
  const db = createTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_cache_merge');
    const merge = createCacheMergeService(db);

    const first = merge.mergeResponse({
      domain: 'profit',
      shopId,
      endpointKey: 'profit.summary',
      cacheKey: 'profit:shop_cache_merge:order-1',
      payload: { profit: 0, cost: 10, status: 'confirmed' },
      remoteHash: 'hash-a',
      status: 'confirmed',
    });
    assert.equal(first.status, 'inserted');

    const partial = merge.mergeResponse({
      domain: 'profit',
      shopId,
      endpointKey: 'profit.summary',
      cacheKey: 'profit:shop_cache_merge:order-1',
      payload: { profit: null, cost: '', status: 'partial' },
      remoteHash: 'hash-b',
      status: 'partial',
    });
    assert.equal(partial.status, 'skipped');

    const updated = merge.mergeResponse({
      domain: 'profit',
      shopId,
      endpointKey: 'profit.summary',
      cacheKey: 'profit:shop_cache_merge:order-1',
      payload: { profit: 0, cost: null, status: 'confirmed' },
      remoteHash: 'hash-c',
      status: 'confirmed',
    });
    assert.equal(updated.status, 'updated');
    assert.equal(updated.row.payload.profit, 0);
    assert.equal(updated.row.payload.cost, 10);
  } finally {
    db.close();
  }
});

test('ozon scheduler executes read-only request through queue and stores job attempt cache', async () => {
  const db = createTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_scheduler_success');
    const calls = [];
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      queueOptions: { shopConcurrency: 1, endpointConcurrency: 1 },
      ozonClient: {
        async requestReadOnly(request) {
          calls.push(request);
          return { ok: true, status: 200, data: { result: [{ id: 1, name: 'Root' }] } };
        },
      },
    });

    const result = await scheduler.executeReadOnly({
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      priority: 'P1',
      params: { language: 'DEFAULT' },
      cacheKey: 'catalog:test:scheduler',
      requestedBy: 'unit-test',
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpointKey, 'catalog.categoryTree');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_request_jobs').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_request_attempts').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_response_cache').get().count, 1);
  } finally {
    db.close();
  }
});

test('ozon scheduler rejects a response from a retired credential revision before SQLite merge', async () => {
  const db = createTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_scheduler_stale_revision');
    let releaseResponse;
    let requestStarted;
    const started = new Promise((resolve) => { requestStarted = resolve; });
    const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      queueOptions: { shopConcurrency: 1, endpointConcurrency: 1 },
      ozonClient: {
        async requestReadOnly() {
          requestStarted();
          await responseGate;
          return { ok: true, status: 200, data: { result: [{ id: 1, name: 'stale' }] } };
        },
      },
    });

    const pending = scheduler.executeReadOnly({
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      forceRefresh: true,
      cacheKey: 'catalog:test:stale-revision',
    });
    await started;
    shopRepository.saveShop({
      id: shopId,
      name: 'Scheduler unit shop',
      ['client' + 'Id']: 'opaque-client',
      ['api' + 'Key']: 'rotated-opaque-key',
      status: 'active',
    });
    releaseResponse();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.errors[0].code, 'SHOP_CREDENTIAL_REVISION_STALE');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM ozon_response_cache WHERE cache_key = ?')
        .get('catalog:test:stale-revision').count,
      0,
    );
  } finally {
    db.close();
  }
});

test('unified scheduler, image hydration, and write guard routes expose their real readiness state', async () => {
  const db = createTestDb();
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: {
      async requestReadOnly() {
        throw new Error('route test must not call Ozon');
      },
    },
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const endpointsResponse = await fetch(`http://127.0.0.1:${port}/api/ozon/endpoints`);
    const endpointsPayload = await endpointsResponse.json();
    assert.equal(endpointsResponse.status, 200);
    assert.equal(endpointsPayload.ok, true);
    assert.ok(endpointsPayload.endpoints.some((endpoint) => endpoint.key === 'catalog.categoryTree'));

    const blockedResponse = await fetch(`http://127.0.0.1:${port}/api/sync/images`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const blockedPayload = await blockedResponse.json();
    assert.equal(blockedResponse.status, 501);
    assert.equal(blockedPayload.error.code, 'PRODUCT_SYNC_NO_CONFIGURED_SHOPS');

    const previewResponse = await fetch(`http://127.0.0.1:${port}/api/write/orders/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'cancel-order',
        requestedBy: 'unit-test',
        after: { status: 'cancelled', ['api' + 'Key']: 'must-not-leak' },
      }),
    });
    const previewPayload = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(previewPayload.ok, true);
    assert.equal(previewPayload.requiresConfirmation, true);

    const auditJson = db.prepare('SELECT audit_payload_json FROM ozon_write_audit_log ORDER BY created_at DESC LIMIT 1').get().audit_payload_json;
    assert.equal(auditJson.includes('must-not-leak'), false);
    assert.equal(auditJson.includes('[REDACTED]'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});


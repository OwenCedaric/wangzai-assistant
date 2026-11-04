import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createOzonScheduler } from '../src/ozon/ozonScheduler.js';
import { createRequestQueue } from '../src/ozon/requestQueue.js';
import { createRetryController } from '../src/ozon/retryController.js';
import { createTrafficController } from '../src/ozon/trafficController.js';
import { createSyncJobService } from '../src/sync/syncJobService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

test('domain parent job polling never scans scheduler trace archives', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-domain-parent-status');
    let archiveReads = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      technicalArchiveService: {
        listTraceEventsByJob() {
          archiveReads += 1;
          return [];
        },
      },
      ozonClient: {
        async requestReadOnly() {
          return { ok: true, status: 200, data: { result: [] } };
        },
      },
    });
    const jobs = createSyncJobService(db);
    jobs.createJob({
      id: 'products_sync_parent_status',
      domain: 'products',
      shopId,
      endpointKey: 'products.list',
      priority: 'P3',
      profile: 'background',
      source: 'continuous-sync',
    });
    jobs.updateJob('products_sync_parent_status', { status: 'running' });

    const job = scheduler.getJob('products_sync_parent_status');
    assert.equal(job.status, 'running');
    assert.equal(archiveReads, 0);
  } finally {
    db.close();
  }
});

test('trafficController isolates rate and cooldown state by shop before queue activation', () => {
  let now = 1_000;
  const traffic = createTrafficController({
    now: () => now,
    profiles: {
      foreground: { targetRps: 1, hardMaxRps: 1 },
    },
  });
  const ticket = {
    profile: 'foreground',
    shopId: 'shop-a',
    endpointKey: 'catalog.categoryTree',
    clientIdHash: 'client-1',
    endpoint: { rate: { bucket: 'catalog.read', minIntervalMs: 0 } },
  };

  assert.equal(traffic.reserve(ticket).allowed, true);
  assert.equal(traffic.reserve({ ...ticket, shopId: 'shop-b' }).allowed, true);
  const blocked = traffic.reserve(ticket);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.status, 'traffic_wait');
  assert.ok(blocked.waitMs > 0);

  traffic.recordFailure?.({ ...ticket, status: 429, retryAfterMs: blocked.waitMs });
  assert.equal(traffic.reserve({ ...ticket, shopId: 'shop-c' }).allowed, true);

  now += blocked.waitMs;
  assert.equal(traffic.reserve(ticket).allowed, true);
});

test('requestQueue leaves permit-waiting work queued instead of occupying active concurrency', async () => {
  let allowed = false;
  let handlerRan = false;
  const queue = createRequestQueue({
    shopConcurrency: 1,
    permitController: {
      reserve() {
        return allowed ? { allowed: true } : { allowed: false, status: 'traffic_wait', waitMs: 10 };
      },
    },
  });

  const promise = queue.enqueue({
    jobId: 'job-permit',
    requestId: 'req-permit',
    priority: 'P1',
    profile: 'foreground',
    shopId: 'shop-a',
    endpointKey: 'catalog.categoryTree',
  }, async () => {
    handlerRan = true;
    return 'ok';
  });

  await new Promise((resolve) => setImmediate(resolve));
  const waiting = queue.getStatus();
  assert.equal(waiting.queued, 1);
  assert.equal(waiting.running, 0);
  assert.equal(handlerRan, false);
  assert.equal(waiting.queuedItems[0].nextPermitAt != null, true);

  allowed = true;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(await promise, 'ok');
  assert.equal(handlerRan, true);
});

test('requestQueue respects endpoint-specific read concurrency limits', async () => {
  const queue = createRequestQueue({
    shopConcurrency: 4,
    endpointConcurrency: 4,
  });
  let active = 0;
  let maxActive = 0;
  const endpoint = { rateLimit: { concurrency: 1 } };
  const handler = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return 'ok';
  };

  await Promise.all([
    queue.enqueue({
      jobId: 'job-endpoint-limit-1',
      requestId: 'req-endpoint-limit-1',
      priority: 'P1',
      profile: 'foreground',
      shopId: 'shop-a',
      endpointKey: 'products.list',
      endpoint,
    }, handler),
    queue.enqueue({
      jobId: 'job-endpoint-limit-2',
      requestId: 'req-endpoint-limit-2',
      priority: 'P1',
      profile: 'foreground',
      shopId: 'shop-a',
      endpointKey: 'products.list',
      endpoint,
    }, handler),
  ]);

  assert.equal(maxActive, 1);
});

test('retryController classifies 429, Ozon code 8 and timeout as queue retries', () => {
  const retry = createRetryController({ maxAttempts: 3, backoffMs: [1, 2], maxDelayMs: 10 });

  assert.equal(retry.getDecision({ status: 429, retryAfterMs: 7 }, 1).shouldRetry, true);
  assert.equal(retry.getDecision({ response: { code: 8 } }, 1).reason, 'ozon_code_8');
  assert.equal(retry.getDecision(new Error('Ozon request timed out after 15000ms.'), 1).reason, 'timeout');
  assert.equal(retry.getDecision(new Error('fetch failed'), 1).reason, 'network');
  assert.equal(retry.getDecision({ status: 400 }, 1).shouldRetry, false);
  assert.equal(retry.getDecision({ status: 429 }, 3).shouldRetry, false);
});

test('ozonScheduler retries 429 through the queue and writes retry trace events', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-scheduler-retry');
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      retryOptions: { maxAttempts: 3, backoffMs: [0, 0], maxDelayMs: 1, sleep: async () => {} },
      queueOptions: { shopConcurrency: 1, endpointConcurrency: 1 },
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          if (calls === 1) {
            const error = new Error('limited');
            error.code = 'OZON_HTTP_ERROR';
            error.status = 429;
            error.retryAfterMs = 0;
            throw error;
          }
          return { ok: true, status: 200, data: { result: [{ id: 1 }] } };
        },
      },
    });

    const result = await scheduler.executeReadOnly({
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      priority: 'P1',
      profile: 'foreground',
      source: 'user_refresh',
      snapshotId: 'snapshot-unit-retry',
      params: { language: 'DEFAULT' },
      cacheKey: 'catalog:test:retry',
      forceRefresh: true,
    });

    assert.equal(result.status, 'success');
    assert.equal(calls, 2);
    const attempts = db.prepare('SELECT status, attempt FROM ozon_request_attempts ORDER BY attempt').all();
    assert.deepEqual(attempts.map((row) => row.attempt), [1, 2]);
    assert.equal(attempts[0].status, 'rate_limited');
    assert.equal(attempts[1].status, 'success');
    const traceRows = db.prepare("SELECT phase, snapshot_id FROM ozon_scheduler_trace_events WHERE job_id = ? ORDER BY created_at").all(result.jobId);
    assert.ok(traceRows.some((row) => row.phase === 'retry_scheduled'));
    assert.equal(traceRows.every((row) => row.snapshot_id === 'snapshot-unit-retry'), true);
    const job = scheduler.getJob(result.jobId);
    assert.equal(job.snapshotId, 'snapshot-unit-retry');
    assert.equal(job.retry.count, 1);
    assert.equal(job.trace.lastEndpointKey, 'catalog.categoryTree');
  } finally {
    db.close();
  }
});

test('ozonScheduler retries Ozon code 8 through the queue', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-scheduler-code8');
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      retryOptions: { maxAttempts: 2, backoffMs: [0], maxDelayMs: 1, sleep: async () => {} },
      queueOptions: { shopConcurrency: 1, endpointConcurrency: 1 },
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          if (calls === 1) {
            const error = new Error('Ozon returned code 8');
            error.response = { code: 8, message: 'too many requests' };
            error.retryAfterMs = 0;
            throw error;
          }
          return { ok: true, status: 200, data: { result: [{ id: 2 }] } };
        },
      },
    });

    const result = await scheduler.executeReadOnly({
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      priority: 'P1',
      profile: 'foreground',
      source: 'user_refresh',
      params: { language: 'DEFAULT' },
      cacheKey: 'catalog:test:code8',
      forceRefresh: true,
    });

    assert.equal(result.status, 'success');
    assert.equal(calls, 2);
    const firstAttempt = db.prepare('SELECT status FROM ozon_request_attempts ORDER BY attempt LIMIT 1').get();
    assert.equal(firstAttempt.status, 'rate_limited');
    const retryTrace = db.prepare("SELECT COUNT(*) AS count FROM ozon_scheduler_trace_events WHERE job_id = ? AND phase = 'retry_scheduled' AND ozon_code = '8'").get(result.jobId);
    assert.equal(retryTrace.count, 1);
  } finally {
    db.close();
  }
});

test('offline exhaustion keeps confirmed cache, enters waiting-network state, and recovers on the next cadence', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-scheduler-offline');
    let mode = 'online';
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      retryOptions: { maxAttempts: 2, backoffMs: [0], maxDelayMs: 1, sleep: async () => {} },
      queueOptions: { shopConcurrency: 1, endpointConcurrency: 1 },
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          if (mode === 'offline') {
            const error = new Error('fetch failed');
            error.cause = { code: 'ENETUNREACH' };
            throw error;
          }
          return { ok: true, status: 200, data: { result: [{ id: calls }] } };
        },
      },
    });
    const input = {
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      params: { language: 'DEFAULT' },
      cacheKey: 'catalog:test:offline-recovery',
      forceRefresh: true,
    };

    assert.equal((await scheduler.executeReadOnly(input)).status, 'success');
    const committed = db.prepare(`
      SELECT response_hash, payload_json, status, is_stale
        FROM ozon_response_cache WHERE cache_key = ?
    `).get(input.cacheKey);

    mode = 'offline';
    const failed = await scheduler.executeReadOnly(input);
    assert.equal(failed.status, 'failed');
    assert.equal(calls, 3, 'one successful call plus two bounded offline attempts');
    assert.deepEqual(
      db.prepare(`
        SELECT response_hash, payload_json, status, is_stale
          FROM ozon_response_cache WHERE cache_key = ?
      `).get(input.cacheKey),
      committed,
      'a network failure must not overwrite the last confirmed cache row',
    );
    const waiting = scheduler.getShopRuntimeState(shopId);
    assert.equal(waiting.status, 'blocked');
    assert.match(waiting.lastError, /^WAITING_NETWORK:/u);

    mode = 'online';
    const recovered = await scheduler.executeReadOnly(input);
    assert.equal(recovered.status, 'success');
    assert.equal(calls, 4);
    assert.equal(scheduler.getShopRuntimeState(shopId).status, 'ready');
  } finally {
    db.close();
  }
});

test('401 pauses only the failing shop until credential revision changes and never retries that revision', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const pausedShopId = saveUnitShop(shopRepository, 'shop-scheduler-auth-paused');
    const healthyShopId = saveUnitShop(shopRepository, 'shop-scheduler-auth-healthy');
    let pausedCalls = 0;
    let healthyCalls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      retryOptions: { maxAttempts: 4, backoffMs: [0], maxDelayMs: 1, sleep: async () => {} },
      queueOptions: { shopConcurrency: 1, endpointConcurrency: 2 },
      ozonClient: {
        async requestReadOnly({ shopCredentials }) {
          if (shopCredentials.shopId === pausedShopId && Number(shopCredentials.credentialRevision) === 1) {
            pausedCalls += 1;
            const error = new Error('unauthorized');
            error.code = 'OZON_HTTP_ERROR';
            error.status = 401;
            throw error;
          }
          if (shopCredentials.shopId === pausedShopId) pausedCalls += 1;
          else healthyCalls += 1;
          return { ok: true, status: 200, data: { result: [] } };
        },
      },
    });
    const inputFor = (shopId) => ({
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      params: { language: 'DEFAULT' },
      cacheKey: `catalog:test:auth:${shopId}`,
      forceRefresh: true,
    });

    const first = await scheduler.executeReadOnly(inputFor(pausedShopId));
    assert.equal(first.status, 'failed');
    assert.equal(pausedCalls, 1, '401 is non-retryable');
    const pausedState = scheduler.getShopRuntimeState(pausedShopId);
    assert.equal(pausedState.status, 'auth_failed');
    assert.match(pausedState.lastError, /CREDENTIAL_REVISION=1/u);

    const gated = await scheduler.executeReadOnly(inputFor(pausedShopId));
    assert.equal(gated.status, 'blocked');
    assert.equal(gated.reason, 'shop_paused_auth');
    assert.equal(gated.error.code, 'OZON_AUTH_PAUSED');
    assert.equal(pausedCalls, 1, 'the paused credential revision causes zero further Ozon calls');

    const healthy = await scheduler.executeReadOnly(inputFor(healthyShopId));
    assert.equal(healthy.status, 'success');
    assert.equal(healthyCalls, 1, 'another shop remains independent');
    assert.equal(scheduler.getShopRuntimeState(healthyShopId).status, 'ready');

    shopRepository.saveShop({
      id: pausedShopId,
      name: 'Rotated auth shop',
      clientId: `client-${pausedShopId}`,
      apiKey: 'rotated-opaque-key',
      status: 'active',
    });
    const resumed = await scheduler.executeReadOnly(inputFor(pausedShopId));
    assert.equal(resumed.status, 'success');
    assert.equal(pausedCalls, 2);
    assert.equal(scheduler.getShopRuntimeState(pausedShopId).status, 'ready');
  } finally {
    db.close();
  }
});

test('403 Company is blocked keeps the exact shop-blocked reason for later gated reads', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-scheduler-company-blocked');
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      retryOptions: { maxAttempts: 4, backoffMs: [0], maxDelayMs: 1, sleep: async () => {} },
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          const error = new Error('Ozon read request failed with HTTP 403.');
          error.code = 'OZON_HTTP_ERROR';
          error.status = 403;
          error.response = { code: 7, message: 'Company is blocked, please contact support' };
          throw error;
        },
      },
    });
    const input = {
      shopId,
      domain: 'orders',
      endpointKey: 'orders.fboList',
      action: 'sync-orders-list',
      params: { filter: {}, limit: 100, offset: 0 },
      cacheKey: `orders:test:company-blocked:${shopId}`,
      forceRefresh: true,
    };

    const first = await scheduler.executeReadOnly(input);
    assert.equal(first.status, 'failed');
    assert.equal(calls, 1, 'a company-blocked response is non-retryable');
    assert.match(scheduler.getShopRuntimeState(shopId).lastError, /REASON=COMPANY_BLOCKED/u);

    const gated = await scheduler.executeReadOnly(input);
    assert.equal(gated.status, 'blocked');
    assert.equal(gated.reason, 'shop_company_blocked');
    assert.equal(gated.error.code, 'OZON_COMPANY_BLOCKED');
    assert.match(gated.error.message, /已被 Ozon 封禁/u);
    assert.equal(calls, 1, 'later reads must preserve the reason without calling Ozon again');
  } finally {
    db.close();
  }
});

test('legacy 403 auth pause recovers its Company is blocked evidence without another Ozon call', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-scheduler-company-blocked-legacy');
    const failedAt = '2026-08-05T15:34:25.438Z';
    db.prepare(`
      INSERT INTO ozon_shop_runtime_state (
        shop_id, status, last_failure_at, last_error, active_jobs, queued_jobs, updated_at
      ) VALUES (?, 'auth_failed', ?, ?, 0, 0, ?)
      ON CONFLICT(shop_id) DO UPDATE SET
        status = excluded.status,
        last_failure_at = excluded.last_failure_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(shopId, failedAt, 'PAUSED_AUTH:CREDENTIAL_REVISION=1:HTTP_403', failedAt);
    db.prepare(`
      INSERT INTO ozon_error_events (
        id, job_id, domain, shop_id, endpoint_key, error_code,
        error_message, severity, created_at
      ) VALUES (?, NULL, 'orders', ?, 'orders.fboList', 'OZON_HTTP_ERROR', ?, 'warning', ?)
    `).run(
      'error-company-blocked-legacy',
      shopId,
      'Ozon read request failed with HTTP 403. Company is blocked, please contact support; Ozon code 7',
      failedAt,
    );
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          return { ok: true, status: 200, data: { result: [] } };
        },
      },
    });

    const blocked = await scheduler.executeReadOnly({
      shopId,
      domain: 'orders',
      endpointKey: 'orders.fboList',
      action: 'sync-orders-list',
      params: { filter: {}, limit: 100, offset: 0 },
      cacheKey: `orders:test:legacy-company-blocked:${shopId}`,
      forceRefresh: true,
    });

    assert.equal(blocked.reason, 'shop_company_blocked');
    assert.equal(blocked.error.code, 'OZON_COMPANY_BLOCKED');
    assert.equal(calls, 0);
    assert.match(scheduler.getShopRuntimeState(shopId).lastError, /REASON=COMPANY_BLOCKED/u);
  } finally {
    db.close();
  }
});

test('the first 401 cancels queued sibling batches instead of creating an authorization storm', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-scheduler-auth-batches');
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      retryOptions: { maxAttempts: 4, backoffMs: [0], maxDelayMs: 1, sleep: async () => {} },
      queueOptions: { shopConcurrency: 1, endpointConcurrency: 1 },
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          const error = new Error('expired credentials');
          error.code = 'OZON_HTTP_ERROR';
          error.status = 401;
          throw error;
        },
      },
    });

    const result = await scheduler.executeReadOnly({
      shopId,
      domain: 'products',
      endpointKey: 'products.infoList',
      action: 'hydrate-products',
      params: { product_id: Array.from({ length: 250 }, (_, index) => String(index + 1)) },
      cacheKey: 'products:test:auth-batches',
      forceRefresh: true,
    });

    assert.equal(result.status, 'failed');
    assert.equal(calls, 1, 'the remaining two 100-id batches are canceled before network dispatch');
    assert.equal(result.errors.some((error) => error.code === 'OZON_HTTP_ERROR'), true);
    assert.equal(scheduler.getShopRuntimeState(shopId).status, 'auth_failed');
    assert.equal(scheduler.getSchedulerStatus().queue.queued, 0);
  } finally {
    db.close();
  }
});

test('Ozon code 5 with HTTP 404 is treated as an authentication failure', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-scheduler-ozon-code-5');
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      retryOptions: { maxAttempts: 4, backoffMs: [0], maxDelayMs: 1, sleep: async () => {} },
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          const error = new Error('Ozon read request failed with HTTP 404.');
          error.code = 'OZON_HTTP_ERROR';
          error.status = 404;
          error.response = { code: 5, message: 'Invalid Api-Key, please check the key and try again' };
          throw error;
        },
      },
    });

    const result = await scheduler.executeReadOnly({
      shopId,
      domain: 'shop',
      endpointKey: 'shop.roles',
      action: 'test-connection',
      forceRefresh: true,
      cacheKey: `shop:test:${shopId}:roles`,
    });

    assert.equal(result.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(scheduler.getShopRuntimeState(shopId).status, 'auth_failed');
    assert.match(scheduler.getShopRuntimeState(shopId).lastError, /CREDENTIAL_REVISION=1/u);
    assert.match(scheduler.getShopRuntimeState(shopId).lastError, /REASON=CREDENTIAL_REJECTED/u);
    const blocked = await scheduler.executeReadOnly({
      shopId,
      domain: 'products',
      endpointKey: 'products.attributes',
      action: 'product-write-readback',
      params: { filter: { offer_id: ['offer-101'] }, limit: 1000 },
      cacheKey: `products:test:${shopId}:invalid-key-readback`,
      forceRefresh: true,
    });
    assert.equal(blocked.reason, 'shop_paused_auth');
    assert.equal(calls, 1, 'an explicitly rejected credential cannot repeatedly probe during readback');
  } finally {
    db.close();
  }
});

test('legacy HTTP 404 auth pause self-heals once for product import readback', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-scheduler-legacy-import-pause');
    db.prepare(`
      INSERT INTO ozon_shop_runtime_state (shop_id, status, last_error, updated_at)
      VALUES (?, 'auth_failed', ?, datetime('now'))
      ON CONFLICT(shop_id) DO UPDATE SET
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(shopId, 'PAUSED_AUTH:CREDENTIAL_REVISION=1:HTTP_404');
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          return { ok: true, status: 200, data: { result: [{ id: 101, offer_id: 'offer-101' }] } };
        },
      },
    });

    const result = await scheduler.executeReadOnly({
      shopId,
      domain: 'products',
      endpointKey: 'products.attributes',
      action: 'product-write-readback',
      params: { filter: { offer_id: ['offer-101'] }, limit: 1000 },
      cacheKey: `products:test:${shopId}:legacy-resume`,
      forceRefresh: true,
    });

    assert.equal(result.status, 'success');
    assert.equal(calls, 1);
    assert.equal(scheduler.getShopRuntimeState(shopId).status, 'ready');
  } finally {
    db.close();
  }
});

test('newly imported product visibility delay does not pause shop authentication or open the endpoint circuit', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-scheduler-import-visibility-delay');
    let calls = 0;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      logger: () => {},
      retryOptions: { maxAttempts: 2, backoffMs: [0], maxDelayMs: 1, sleep: async () => {} },
      ozonClient: {
        async requestReadOnly() {
          calls += 1;
          if (calls === 1) {
            const error = new Error('Ozon read request failed with HTTP 404.');
            error.code = 'OZON_HTTP_ERROR';
            error.status = 404;
            error.response = { code: 5, message: 'item not found' };
            throw error;
          }
          return { ok: true, status: 200, data: { result: [{ id: 101, offer_id: 'offer-101' }] } };
        },
      },
    });

    const pending = await scheduler.executeReadOnly({
      shopId,
      domain: 'products',
      endpointKey: 'products.attributes',
      action: 'product-write-readback',
      params: { filter: { offer_id: ['offer-101'] }, limit: 1000 },
      cacheKey: `products:test:${shopId}:attributes:attempt:1`,
      forceRefresh: true,
    });

    assert.equal(pending.status, 'failed');
    assert.notEqual(scheduler.getShopRuntimeState(shopId)?.status, 'auth_failed');
    const circuit = db.prepare(`
      SELECT state, failure_count
      FROM ozon_circuit_breakers
      WHERE shop_id = ? AND endpoint_key = 'products.attributes'
    `).get(shopId);
    assert.ok(!circuit || Number(circuit.failure_count || 0) === 0);

    const visible = await scheduler.executeReadOnly({
      shopId,
      domain: 'products',
      endpointKey: 'products.attributes',
      action: 'product-write-readback',
      params: { filter: { offer_id: ['offer-101'] }, limit: 1000 },
      cacheKey: `products:test:${shopId}:attributes:attempt:2`,
      forceRefresh: true,
    });
    assert.equal(visible.status, 'success');
    assert.equal(calls, 2);
    assert.notEqual(scheduler.getShopRuntimeState(shopId)?.status, 'auth_failed');
  } finally {
    db.close();
  }
});


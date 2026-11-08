import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/createApp.js';
import { createRecoveryReconcileState } from '../src/backup/recoveryReconcileState.js';
import { createOrderRepository } from '../src/db/repositories/orderRepository.js';
import { createOrdersService } from '../src/domain/orders/ordersService.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createContinuousSyncService } from '../src/sync/continuousSyncService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

// These fixtures describe June/July orders. Freeze only Date so the rolling
// 90-day cache window stays deterministic; real async timers still execute.
beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-01T12:00:00.000Z') });
});

function orderRow(overrides = {}) {
  return {
    posting_number: overrides.posting_number || '123456789-0001-1',
    order_id: overrides.order_id || 'order-1',
    status: overrides.status || 'awaiting_packaging',
    in_process_at: overrides.in_process_at || '2026-06-29T10:00:00Z',
    shipment_date: overrides.shipment_date || '2026-06-30T10:00:00Z',
    products: overrides.products || [{ offer_id: 'offer-1', sku: 1001, quantity: 1, price: '12.50' }],
    analytics_data: overrides.analytics_data || { region: 'RU' },
    financial_data: overrides.financial_data || { products: [] },
  };
}

function createFakeScheduler(responses = []) {
  const calls = [];
  return {
    calls,
    async executeReadOnly(input) {
      calls.push(input);
      const data = responses.shift() || { result: { postings: [] } };
      return { ok: true, status: 'success', data, jobId: `orders-child-${calls.length}` };
    },
    readCache() { return { ok: true, rows: [] }; },
    getJob() { return null; },
    cancelJob() { return { ok: true }; },
    listSyncState() { return []; },
    listEndpoints() { return []; },
    getSchedulerStatus() { return { ok: true }; },
    pauseShop() { return { ok: true }; },
    resumeShop() { return { ok: true }; },
    pauseEndpoint() { return { ok: true }; },
    resumeEndpoint() { return { ok: true }; },
    getRateLimitStatus() { return { ok: true }; },
    listErrors() { return []; },
  };
}

async function waitForJobStatus(db, jobId, expectedStatus, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = db.prepare('SELECT status FROM ozon_request_jobs WHERE id = ?').get(jobId);
    if (row?.status === expectedStatus) return row;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return db.prepare('SELECT status FROM ozon_request_jobs WHERE id = ?').get(jobId);
}

async function withServer({ db, scheduler }, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonScheduler: scheduler,
    ozonClient: { async requestReadOnly() { return {}; } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('order repository stores compact Ozon posting rows and reads paged cache', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_repo');
    const repository = createOrderRepository(db);
    const first = repository.upsertOrders({ shopId, source: 'FBS', rows: [orderRow()] });
    assert.equal(first.inserted, 1);
    const second = repository.upsertOrders({ shopId, source: 'FBS', rows: [orderRow()] });
    assert.equal(second.unchanged, 1);
    const page = repository.listOrders({ shopId, postingNumber: '123456789-0001-1', pageSize: 20 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].posting_number, '123456789-0001-1');
    assert.equal(page.rows[0].products[0].offer_id, 'offer-1');
    assert.equal(page.rows[0].source, 'FBS');
  } finally {
    db.close();
  }
});

test('order repository keyword search covers product, buyer and raw Ozon fields without changing total semantics', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_keyword');
    const repository = createOrderRepository(db);
    const rows = [
      orderRow({
        posting_number: 'TEST-SPLIT-0001-1',
        order_id: 'TEST-SPLIT-ORDER-0001',
        status: 'awaiting_packaging',
        substatus: 'posting_created',
        products: [
          {
            name: '拆单测试商品',
            sku: 'mz-split-test-001',
            offer_id: 'mz-split-test-001',
            quantity: 1,
            price: '12.50',
          },
        ],
        analytics_data: {
          buyer_name: '测试买家',
          region: 'RU',
        },
        financial_data: {
          products: [{ offer_id: 'mz-split-test-001', payout: '10.00' }],
        },
      }),
      ...Array.from({ length: 24 }, (_, index) =>
        orderRow({
          posting_number: `TEST-PAGED-${String(index + 1).padStart(4, '0')}`,
          order_id: `TEST-PAGED-ORDER-${String(index + 1).padStart(4, '0')}`,
          products: [{ name: `分页测试商品 ${index + 1}`, sku: `paged-sku-${index + 1}`, offer_id: `paged-offer-${index + 1}` }],
          analytics_data: { buyer_name: `分页买家 ${index + 1}` },
        })
      ),
    ];

    repository.upsertOrders({ shopId, source: 'FBS', rows });

    const terms = [
      ['posting_number', 'TEST-SPLIT-0001-1'],
      ['order_id', 'TEST-SPLIT-ORDER-0001'],
      ['sku', 'mz-split-test-001'],
      ['offer_id', 'mz-split-test-001'],
      ['product_name', '拆单测试商品'],
      ['buyer_name', '测试买家'],
    ];

    for (const [label, keyword] of terms) {
      const page = repository.listOrders({ shopId, keyword, pageSize: 20 });
      assert.equal(page.total, 1, `${label} should match exactly one order`);
      assert.equal(page.rows[0].posting_number, 'TEST-SPLIT-0001-1');
    }

    const missing = repository.listOrders({ shopId, keyword: '__unlikely_keyword__', pageSize: 20 });
    assert.equal(missing.total, 0);
    assert.equal(missing.rows.length, 0);

    const page20 = repository.listOrders({ shopId, pageSize: 20 });
    assert.equal(page20.total, 25);
    assert.equal(page20.rows.length, 20);

    const page100 = repository.listOrders({ shopId, pageSize: 100 });
    assert.equal(page100.total, 25);
    assert.equal(page100.rows.length, 25);
  } finally {
    db.close();
  }
});

test('orders service starts background sync through scheduler and preserves old cache on empty later result', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_service');
    const scheduler = createFakeScheduler([
      { result: { postings: [orderRow({ posting_number: 'svc-posting' })] } },
      { result: { postings: [] } },
    ]);
    const service = createOrdersService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const accepted = service.startSync({
      shopId,
      endpointKey: 'orders.fbsList',
      params: { filter: { since: '2026-06-29T00:00:00Z', to: '2026-06-29T23:59:59Z' } },
      pageSize: 100,
      maxPages: 1,
      priority: 'P3',
      profile: 'background',
      source: 'continuous-sync',
      requestedBy: 'continuous-sync',
    });
    assert.equal(accepted.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));
    const firstJob = db
      .prepare('SELECT progress_done, progress_total FROM ozon_request_jobs WHERE id = ?')
      .get(accepted.jobId);
    assert.equal(firstJob.progress_done, 1);
    assert.equal(firstJob.progress_total, 1);
    const page = service.readCache({ shopId, postingNumber: 'svc-posting', pageSize: 20 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].postingNumber, 'svc-posting');

    service.startSync({ shopId, endpointKey: 'orders.fbsList', params: { filter: { since: '2026-06-30T00:00:00Z', to: '2026-06-30T23:59:59Z' } }, pageSize: 100, maxPages: 1, forceRefresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    const preserved = service.readCache({ shopId, postingNumber: 'svc-posting', pageSize: 20 });
    assert.equal(preserved.total, 1);
    assert.equal(scheduler.calls.every((call) => call.endpointKey === 'orders.fbsList'), true);
    assert.equal(scheduler.calls[0].priority, 'P3');
    assert.equal(scheduler.calls[0].profile, 'background');
    assert.equal(scheduler.calls[0].source, 'continuous-sync');
  } finally {
    db.close();
  }
});

test('recovery reconcile runs an Ozon orders fixture through the normal scheduler merge without duplicating rows or overwriting manual purchase facts', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_recovery_orders');
    const repository = createOrderRepository(db);
    const postingNumber = 'RECOVERY-POSTING-0001';
    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [orderRow({ posting_number: postingNumber, status: 'awaiting_packaging' })],
    });
    const seededOrder = repository.listOrders({ shopId, postingNumber, pageSize: 20 }).rows[0];
    db.prepare(`
      INSERT INTO purchase_order_overrides (
        id, shop_id, order_key, posting_number, source_cost_cny, manual_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'recovery-manual-fact',
      shopId,
      seededOrder.orderKey,
      postingNumber,
      37.5,
      'manual_confirmed',
      '2026-07-11T00:00:00.000Z',
      '2026-07-11T00:00:00.000Z',
    );

    const scheduler = createFakeScheduler([
      {
        result: {
          postings: [orderRow({ posting_number: postingNumber, status: 'delivering' })],
        },
      },
    ]);
    const ordersService = createOrdersService({
      db,
      ozonScheduler: scheduler,
      backgroundRunner: (task) => task(),
    });
    const reconcile = createRecoveryReconcileState({ db, now: () => new Date('2026-07-11T12:00:00.000Z') });
    reconcile.prepare({
      restoreId: 'restore-orders-fixture',
      generationId: 'generation-orders-fixture',
      shopId,
      overlapMinutes: 30,
    });
    const service = createContinuousSyncService({
      shopRepository,
      domainServices: new Map([['orders', ordersService]]),
      policies: [{
        id: 'orders:recovery-fixture',
        domain: 'orders',
        cadenceMs: 60_000,
        payload: {
          endpointKey: 'orders.fbsList',
          params: { filter: { since: '2026-07-01T00:00:00.000Z', to: '2026-07-11T00:00:00.000Z' } },
          pageSize: 100,
          maxPages: 1,
        },
      }],
      recoveryReconcileState: reconcile,
      getSyncJob: (jobId) => {
        const row = db.prepare('SELECT status, last_error FROM ozon_request_jobs WHERE id = ?').get(jobId);
        return row ? { status: row.status, lastError: row.last_error } : null;
      },
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });

    const queued = service.runOnce({ force: true, startup: false });
    assert.equal(queued.recoveryQueued, 1);
    assert.equal(queued.results[0].accepted, true);
    assert.equal(scheduler.calls[0].requestedBy, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].source, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].syncMode, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].params.filter.since, '2026-07-01T00:00:00.000Z');

    const job = await waitForJobStatus(db, queued.results[0].result.jobId, 'success');
    assert.equal(job?.status, 'success');
    const recoveredRows = repository.listOrders({ shopId, postingNumber, pageSize: 20 });
    assert.equal(recoveredRows.total, 1);
    assert.equal(recoveredRows.rows[0].status, 'delivering');
    const manualFact = db.prepare(`
      SELECT source_cost_cny, manual_status FROM purchase_order_overrides WHERE id = ?
    `).get('recovery-manual-fact');
    assert.equal(manualFact?.source_cost_cny, 37.5);
    assert.equal(manualFact?.manual_status, 'manual_confirmed');
    const queuedState = reconcile.get('restore-orders-fixture', shopId);
    assert.equal(queuedState?.status, 'queued');
    assert.equal(queuedState?.queuedPolicyCount, 1);
    assert.equal(queuedState?.completedPolicyCount, 0);
    assert.equal(queuedState?.failedPolicyCount, 0);
    assert.equal(queuedState?.jobIds.length, 1);
    assert.equal(queuedState?.lastError, null);
    const finalized = service.runOnce();
    assert.equal(finalized.recoveryFinalized, 1);
    const completedState = reconcile.get('restore-orders-fixture', shopId);
    assert.equal(completedState?.status, 'completed');
    assert.equal(completedState?.completedPolicyCount, 1);
    assert.equal(completedState?.failedPolicyCount, 0);
    assert.equal(completedState?.completedAt, '2026-07-11T12:00:00.000Z');
  } finally {
    db.close();
  }
});

test('orders service applies a default 90-day sync range and preserves explicit user range', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_90d');
    const scheduler = createFakeScheduler([
      { result: { postings: [] } },
      { result: { postings: [] } },
    ]);
    const service = createOrdersService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });

    service.startSync({
      shopId,
      endpointKey: 'orders.fbsList',
      maxPages: 1,
      now: '2026-07-01T00:00:00.000Z',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(scheduler.calls[0].params.filter.to, '2026-07-01T00:00:00.000Z');
    assert.equal(
      new Date(scheduler.calls[0].params.filter.to).getTime() -
        new Date(scheduler.calls[0].params.filter.since).getTime(),
      90 * 24 * 60 * 60 * 1000
    );

    service.startSync({
      shopId,
      endpointKey: 'orders.fbsList',
      params: { filter: { since: '2026-06-01T00:00:00.000Z', to: '2026-06-15T00:00:00.000Z' } },
      maxPages: 1,
      forceRefresh: true,
      idempotencyKey: 'orders-explicit-range',
      now: '2026-07-01T00:00:00.000Z',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(scheduler.calls[1].params.filter, {
      since: '2026-06-01T00:00:00.000Z',
      to: '2026-06-15T00:00:00.000Z',
    });
  } finally {
    db.close();
  }
});

test('orders cache read defaults to 90 days and preserves explicit user range', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_cache_90d');
    const repository = createOrderRepository(db);
    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [
        orderRow({ posting_number: 'recent-order', in_process_at: '2026-06-20T00:00:00.000Z' }),
        orderRow({ posting_number: 'old-order', in_process_at: '2026-01-01T00:00:00.000Z' }),
      ],
    });
    const service = createOrdersService({ db, ozonScheduler: createFakeScheduler() });

    const defaultPage = service.readCache({ shopId, now: '2026-07-01T00:00:00.000Z', pageSize: 20 });
    assert.equal(defaultPage.total, 1);
    assert.equal(defaultPage.rows[0].posting_number, 'recent-order');

    const explicitPage = service.readCache({
      shopId,
      since: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      pageSize: 20,
    });
    assert.equal(explicitPage.total, 2);
  } finally {
    db.close();
  }
});

test('orders service sends detail posting number as scalar Ozon payload', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_detail_service');
    const scheduler = createFakeScheduler([
      { result: orderRow({ posting_number: 'detail-posting' }) },
    ]);
    const service = createOrdersService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const accepted = service.startSync({
      shopId,
      endpointKey: 'orders.fbsGet',
      params: { posting_number: 'detail-posting' },
    });
    assert.equal(accepted.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(scheduler.calls[0].endpointKey, 'orders.fbsGet');
    assert.equal(scheduler.calls[0].params.posting_number, 'detail-posting');
    assert.equal('limit' in scheduler.calls[0].params, false);
    assert.equal('offset' in scheduler.calls[0].params, false);

    const page = service.readCache({ shopId, postingNumber: 'detail-posting', pageSize: 20 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].posting_number, 'detail-posting');
  } finally {
    db.close();
  }
});

test('orders HTTP routes expose /api/sync/orders and /api/cache/orders', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_http');
    const scheduler = createFakeScheduler([
      { result: { postings: [orderRow({ posting_number: 'http-posting' })] } },
    ]);
    await withServer({ db, scheduler }, async (base) => {
      const sync = await (await fetch(`${base}/api/sync/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shopId, endpointKey: 'orders.fbsList', params: { filter: { since: '2026-06-29T00:00:00Z', to: '2026-06-29T23:59:59Z' } }, maxPages: 1 }),
      })).json();
      assert.equal(sync.accepted, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const cache = await (await fetch(`${base}/api/cache/orders?shopId=${encodeURIComponent(shopId)}&postingNumber=http-posting&pageSize=20`)).json();
      assert.equal(cache.ok, true);
      assert.equal(cache.rows[0].posting_number, 'http-posting');
      assert.equal(cache.rows[0].products[0].offer_id, 'offer-1');
    });
  } finally {
    db.close();
  }
});

test('orders HTTP route persists TEST-SPLIT child rows through test split simulation endpoint', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_http_test_split');
    const repository = createOrderRepository(db);
    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [
        orderRow({
          posting_number: 'TEST-SPLIT-HTTP-1',
          order_id: 'TEST-SPLIT-HTTP-ORDER',
          products: [{ offer_id: 'split-http-offer', quantity: 2, price: '15.00' }],
          uiTestOrder: true,
          splitUiTestOrder: true,
        }),
      ],
    });

    const previousAllowTestRoutes = process.env.ALLOW_TEST_ROUTES;
    process.env.ALLOW_TEST_ROUTES = 'true';
    try {
      await withServer({ db, scheduler: createFakeScheduler() }, async (base) => {
        const split = await (await fetch(`${base}/api/orders/test-split-simulation`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopId, postingNumber: 'TEST-SPLIT-HTTP-1', splitQuantities: [1, 1] }),
        })).json();
        assert.equal(split.ok, true);
        assert.deepEqual(split.resultPostingNumbers, ['TEST-SPLIT-HTTP-1', 'TEST-SPLIT-HTTP-2']);
        assert.deepEqual(split.childPostingNumbers, ['TEST-SPLIT-HTTP-2']);

        const cache = await (await fetch(`${base}/api/cache/orders?shopId=${encodeURIComponent(shopId)}&pageSize=20`)).json();
        const child = cache.rows.find((row) => row.posting_number === 'TEST-SPLIT-HTTP-2');
        const parent = cache.rows.find((row) => row.posting_number === 'TEST-SPLIT-HTTP-1');
        assert.equal(child.splitRole, 'child');
        assert.equal(child.splitParentPostingNumber, 'TEST-SPLIT-HTTP-1');
        assert.equal(parent.splitDefaultBusinessHidden, false);
        assert.equal(parent.splitBusinessLocked, false);
        assert.equal(parent.products[0].quantity, 1);
      });
    } finally {
      if (previousAllowTestRoutes === undefined) {
        delete process.env.ALLOW_TEST_ROUTES;
      } else {
        process.env.ALLOW_TEST_ROUTES = previousAllowTestRoutes;
      }
    }
  } finally {
    db.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/createApp.js';
import { createRecoveryReconcileState } from '../src/backup/recoveryReconcileState.js';
import { createFinanceRepository } from '../src/db/repositories/financeRepository.js';
import { createFinanceService } from '../src/domain/finance/financeService.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createContinuousSyncService } from '../src/sync/continuousSyncService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function financeOperation(overrides = {}) {
  return {
    operation_id: overrides.operation_id || 'fin-op-1',
    posting_number: overrides.posting_number || '123456789-0001-1',
    order_id: overrides.order_id || 'order-1',
    operation_type: overrides.operation_type || 'MarketplaceRedistributionOfAcquiringOperation',
    operation_type_name: overrides.operation_type_name || '收单业务',
    transaction_type: overrides.transaction_type || 'all',
    operation_date: overrides.operation_date || '2026-06-29T10:00:00Z',
    amount: overrides.amount ?? -0.54,
    currency_code: overrides.currency_code || 'CNY',
    services: overrides.services || [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: -0.54 }],
  };
}

function createFakeScheduler(responses = []) {
  const calls = [];
  return {
    calls,
    async executeReadOnly(input) {
      calls.push(input);
      const data = responses.shift() || { result: { operations: [], page_count: 1 } };
      return { ok: true, status: 'success', data, jobId: `finance-child-${calls.length}` };
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

test('finance repository stores compact Ozon transaction rows and acquiring operation amount', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_finance_repo');
    const repository = createFinanceRepository(db);
    const first = repository.upsertOperations({ shopId, rows: [financeOperation()] });
    assert.equal(first.inserted, 1);
    const second = repository.upsertOperations({ shopId, rows: [financeOperation()] });
    assert.equal(second.unchanged, 1);
    const page = repository.listOperations({ shopId, postingNumber: '123456789-0001-1', pageSize: 20 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].operation_type, 'MarketplaceRedistributionOfAcquiringOperation');
    assert.equal(page.rows[0].acquiringFeeCny, -0.54);
    assert.equal(page.rows[0].services[0].price, -0.54);
  } finally {
    db.close();
  }
});

test('finance service starts background sync through scheduler and keeps old cache on empty later result', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_finance_service');
    const scheduler = createFakeScheduler([
      { result: { operations: [financeOperation({ operation_id: 'svc-op-1', posting_number: 'svc-posting' })], page_count: 1 } },
      { result: { operations: [], page_count: 1 } },
    ]);
    const service = createFinanceService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const accepted = service.startSync({ shopId, postingNumber: 'svc-posting', from: '2026-06-29T00:00:00Z', to: '2026-06-29T23:59:59Z', maxPages: 1 });
    assert.equal(accepted.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));
    const page = service.readCache({ shopId, postingNumber: 'svc-posting', pageSize: 20 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].operationId, 'svc-op-1');

    service.startSync({ shopId, postingNumber: 'svc-posting', from: '2026-06-30T00:00:00Z', to: '2026-06-30T23:59:59Z', maxPages: 1, forceRefresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    const preserved = service.readCache({ shopId, postingNumber: 'svc-posting', pageSize: 20 });
    assert.equal(preserved.total, 1);
    assert.equal(scheduler.calls.every((call) => call.endpointKey === 'finance.transactionList'), true);
  } finally {
    db.close();
  }
});

test('continuous finance sync reuses day-window cache identities and compacts legacy timestamped variants after a successful merge', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_finance_continuous');
    const legacyCacheKey = `finance:transaction-list:${shopId}:all:2026-07-01T10:00:00.000Z:2026-07-07T10:00:00.000Z:page:1`;
    db.prepare(`
      INSERT INTO ozon_response_cache (id, domain, shop_id, endpoint_key, cache_key, status, updated_at, payload_json)
      VALUES ('finance-legacy-response', 'finance', ?, 'finance.transactionList', ?, 'confirmed', '2026-07-07T10:00:00.000Z', '{}')
    `).run(shopId, legacyCacheKey);
    db.prepare(`
      INSERT INTO ozon_cache_keys (cache_key, domain, shop_id, endpoint_key, policy, allow_stale, created_at, updated_at)
      VALUES (?, 'finance', ?, 'finance.transactionList', 'ledger_snapshot', 1, '2026-07-07T10:00:00.000Z', '2026-07-07T10:00:00.000Z')
    `).run(legacyCacheKey, shopId);
    db.prepare(`
      INSERT INTO ozon_sync_state (id, domain, shop_id, scope_key, status, updated_at)
      VALUES ('finance-legacy-state', 'finance', ?, ?, 'success', '2026-07-07T10:00:00.000Z')
    `).run(shopId, legacyCacheKey);
    const stableCacheKey = `finance:transaction-list:${shopId}:all:2026-07-01:2026-07-07:page:1`;
    db.prepare(`
      INSERT INTO ozon_response_cache (id, domain, shop_id, endpoint_key, cache_key, status, updated_at, payload_json)
      VALUES ('finance-stable-response', 'finance', ?, 'finance.transactionList', ?, 'confirmed', '2026-07-07T09:00:00.000Z', '{}')
    `).run(shopId, stableCacheKey);
    db.prepare(`
      INSERT INTO ozon_cache_keys (cache_key, domain, shop_id, endpoint_key, policy, allow_stale, created_at, updated_at)
      VALUES (?, 'finance', ?, 'finance.transactionList', 'ledger_snapshot', 1, '2026-07-07T09:00:00.000Z', '2026-07-07T09:00:00.000Z')
    `).run(stableCacheKey, shopId);
    db.prepare(`
      INSERT INTO ozon_sync_state (id, domain, shop_id, scope_key, status, updated_at)
      VALUES ('finance-stable-state', 'finance', ?, ?, 'success', '2026-07-07T09:00:00.000Z')
    `).run(shopId, stableCacheKey);
    const scheduler = createFakeScheduler([
      { result: { operations: [financeOperation({ operation_id: 'continuous-op' })], page_count: 1 } },
    ]);
    const service = createFinanceService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    service.startSync({
      shopId,
      from: '2026-07-01T12:00:00.000Z',
      to: '2026-07-07T12:00:00.000Z',
      maxPages: 1,
      syncMode: 'steady',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(scheduler.calls[0].cacheKey, `finance:transaction-list:${shopId}:all:2026-07-01:2026-07-07:page:1`);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_response_cache WHERE domain = 'finance' AND shop_id = ? AND cache_key = ?`).get(shopId, stableCacheKey).count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_cache_keys WHERE domain = 'finance' AND shop_id = ? AND cache_key = ?`).get(shopId, stableCacheKey).count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_response_cache WHERE domain = 'finance' AND shop_id = ? AND cache_key = ?`).get(shopId, legacyCacheKey).count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_cache_keys WHERE domain = 'finance' AND shop_id = ? AND cache_key = ?`).get(shopId, legacyCacheKey).count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_sync_state WHERE domain = 'finance' AND shop_id = ? AND scope_key = ?`).get(shopId, legacyCacheKey).count, 0);
  } finally {
    db.close();
  }
});

test('recovery reconcile runs an Ozon finance fixture through the normal scheduler merge without duplicating the existing operation', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_recovery_finance');
    const repository = createFinanceRepository(db);
    repository.upsertOperations({
      shopId,
      rows: [financeOperation({
        operation_id: 'finance-recovery-001',
        posting_number: 'FINANCE-RECOVERY-POSTING-001',
        amount: -0.54,
      })],
    });
    const scheduler = createFakeScheduler([{ result: {
      operations: [financeOperation({
        operation_id: 'finance-recovery-001',
        posting_number: 'FINANCE-RECOVERY-POSTING-001',
        amount: -0.75,
      })],
      page_count: 1,
    } }]);
    const financeService = createFinanceService({
      db,
      ozonScheduler: scheduler,
      backgroundRunner: (task) => task(),
    });
    const reconcile = createRecoveryReconcileState({
      db,
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    reconcile.prepare({
      restoreId: 'restore-finance-fixture',
      generationId: 'generation-finance-fixture',
      shopId,
      overlapMinutes: 30,
    });
    const continuousSync = createContinuousSyncService({
      shopRepository,
      domainServices: new Map([['finance', financeService]]),
      policies: [{
        id: 'finance:recovery-fixture',
        domain: 'finance',
        cadenceMs: 60_000,
        payload: {
          from: '2026-07-01T00:00:00.000Z',
          to: '2026-07-11T00:00:00.000Z',
          windowDays: 14,
          pageSize: 1000,
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

    const queued = continuousSync.runOnce({ force: true, startup: false });
    assert.equal(queued.recoveryQueued, 1);
    assert.equal(queued.results[0].accepted, true);
    assert.equal(scheduler.calls[0].requestedBy, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].source, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].syncMode, 'recovery-reconcile');
    assert.equal(scheduler.calls[0].recoveryRestoreId, 'restore-finance-fixture');
    assert.equal(scheduler.calls[0].recoveryGenerationId, 'generation-finance-fixture');
    assert.equal(scheduler.calls[0].recoveryOverlapMinutes, 30);
    assert.equal(scheduler.calls[0].forceRefresh, true);

    const job = await waitForJobStatus(db, queued.results[0].result.jobId, 'success');
    assert.equal(job?.status, 'success');
    const recovered = repository.listOperations({
      shopId,
      postingNumber: 'FINANCE-RECOVERY-POSTING-001',
      pageSize: 20,
    });
    assert.equal(recovered.total, 1);
    assert.equal(recovered.rows[0].operationId, 'finance-recovery-001');
    assert.equal(recovered.rows[0].amount, -0.75);

    const queuedState = reconcile.get('restore-finance-fixture', shopId);
    assert.equal(queuedState?.status, 'queued');
    assert.equal(queuedState?.jobIds.length, 1);
    const finalized = continuousSync.runOnce();
    assert.equal(finalized.recoveryFinalized, 1);
    const completedState = reconcile.get('restore-finance-fixture', shopId);
    assert.equal(completedState?.status, 'completed');
    assert.equal(completedState?.completedPolicyCount, 1);
  } finally {
    db.close();
  }
});

test('finance HTTP routes expose /api/sync/finance and /api/cache/finance without real Ozon write', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_finance_http');
    const scheduler = createFakeScheduler([
      { result: { operations: [financeOperation({ operation_id: 'http-op-1', posting_number: 'http-posting' })], page_count: 1 } },
    ]);
    await withServer({ db, scheduler }, async (base) => {
      const sync = await (await fetch(`${base}/api/sync/finance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shopId, postingNumber: 'http-posting', from: '2026-06-29T00:00:00Z', to: '2026-06-29T23:59:59Z', maxPages: 1 }),
      })).json();
      assert.equal(sync.accepted, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const cache = await (await fetch(`${base}/api/cache/finance?shopId=${encodeURIComponent(shopId)}&postingNumber=http-posting&pageSize=20`)).json();
      assert.equal(cache.ok, true);
      assert.equal(cache.rows[0].operation_id, 'http-op-1');
      assert.equal(cache.rows[0].acquiringFeeCny, -0.54);
    });
  } finally {
    db.close();
  }
});

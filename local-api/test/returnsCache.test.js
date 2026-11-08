import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createRecoveryReconcileState } from '../src/backup/recoveryReconcileState.js';
import { createReturnRepository } from '../src/db/repositories/returnRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createReturnsService } from '../src/domain/returns/returnsService.js';
import { createContinuousSyncService } from '../src/sync/continuousSyncService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

// These fixtures describe June/July orders. Freeze only Date so the rolling
// 90-day cache window stays deterministic; real async timers still execute.
beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-01T12:00:00.000Z') });
});

function createFakeScheduler(responses = []) {
  const calls = [];
  return {
    calls,
    async executeReadOnly(request) {
      calls.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response || { ok: true, status: 'success', data: { result: { returns: [] } } };
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

async function waitForJobStatus(db, jobId, expectedStatus, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = db.prepare('SELECT status FROM ozon_request_jobs WHERE id = ?').get(jobId);
    if (row?.status === expectedStatus) return row;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return db.prepare('SELECT status FROM ozon_request_jobs WHERE id = ?').get(jobId);
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

test('return repository stores compact Ozon return rows and reads paged cache', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    const merge = repository.upsertReturns({
      shopId: 'shop-r1',
      source: 'rfbs-return',
      rows: [
        {
          return_id: 1001,
          posting_number: '123-1',
          status: 'awaiting_seller',
          reason: 'buyer_changed_mind',
          created_at: '2026-06-29T10:00:00Z',
          product: { offer_id: 'offer-1', quantity: 1 },
        },
      ],
    });
    assert.equal(merge.changed, 1);
    const page = repository.listReturns({ shopId: 'shop-r1', source: 'rfbs-return', pageSize: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].return_id, '1001');
    assert.equal(page.rows[0].posting_number, '123-1');
    assert.equal(page.rows[0].status, 'awaiting_seller');
    assert.deepEqual(page.rows[0].product, { offer_id: 'offer-1', quantity: 1 });
  } finally {
    db.close();
  }
});

test('return repository extracts nested rFBS detail return reason for display cache', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-detail-reason',
      source: 'rfbs-return',
      rows: [
        {
          return_id: 90652048,
          posting_number: '75064957-0486-1',
          product: { offer_id: 'mz-26050110-194993', quantity: 1 },
          detail: {
            return_reason: {
              name: '配送了错误的商品',
            },
          },
        },
      ],
    });
    const page = repository.listReturns({ shopId: 'shop-r-detail-reason', returnIds: '90652048', pageSize: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].reason, '配送了错误的商品');
    assert.equal(page.rows[0].return_reason, '配送了错误的商品');
  } finally {
    db.close();
  }
});

test('return repository does not expose posting number as return id when Ozon omits return id', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-no-return-id',
      source: 'rfbs-return',
      rows: [
        {
          posting_number: '14885060-0318-1',
          state: { state: 'Utilizing' },
          return_reason: { name: 'Покупатель отказался при вручении: товар не подошел' },
        },
      ],
    });
    const page = repository.listReturns({ shopId: 'shop-r-no-return-id', postingNumbers: '14885060-0318-1' });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].id, null);
    assert.equal(page.rows[0].return_id, null);
    assert.equal(page.rows[0].posting_number, '14885060-0318-1');
  } finally {
    db.close();
  }
});

test('return repository keeps Ozon state object as readable status instead of object string', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-state',
      source: 'rfbs-return',
      rows: [
        {
          return_id: 1002,
          posting_number: '123-2',
          state: {
            state: 'Utilizing',
            state_name: 'На утилизации',
            group_state: 'utilization',
          },
          created_at: '2026-06-30T10:00:00Z',
          product: { offer_id: 'offer-state', quantity: 1 },
        },
      ],
    });
    const page = repository.listReturns({ shopId: 'shop-r-state', source: 'rfbs-return', pageSize: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].status, 'Utilizing');
    assert.notEqual(page.rows[0].status, '[object Object]');
    assert.deepEqual(page.rows[0].state, {
      state: 'Utilizing',
      state_name: 'На утилизации',
      group_state: 'utilization',
    });
  } finally {
    db.close();
  }
});

test('return repository persists explicit Ozon refund status and refund time evidence', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-refund',
      source: 'rfbs-return',
      rows: [
        {
          return_id: 1003,
          posting_number: '123-refund',
          state: {
            state: 'ReturnedMoney',
            state_name: 'Возврат денег',
            money_return_state_name: '已退款给买家',
          },
          refund: {
            refunded_at: '2026-07-03T06:42:00Z',
          },
          updated_at: '2026-07-03T07:00:00Z',
          product: { offer_id: 'offer-refund', quantity: 1 },
        },
      ],
    });
    const page = repository.listReturns({ shopId: 'shop-r-refund', source: 'rfbs-return', pageSize: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].refundStatus, '已退款给买家');
    assert.equal(page.rows[0].refund_status, '已退款给买家');
    assert.equal(page.rows[0].refundTime, '2026-07-03T06:42:00Z');
    assert.equal(page.rows[0].refund_time, '2026-07-03T06:42:00Z');
    assert.equal(page.rows[0].refundEvidence.statusSource, 'state.money_return_state_name');
    assert.equal(page.rows[0].refundEvidence.timeSource, 'refund.refunded_at');
  } finally {
    db.close();
  }
});

test('return repository treats Ozon MoneyReturned state as refunded evidence', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-money-returned',
      source: 'rfbs-return',
      rows: [
        {
          return_id: 1005,
          posting_number: '123-money-returned',
          state: {
            state: 'MoneyReturned',
            state_name: 'Деньги возвращены',
            group_state: 'approved',
            money_return_state_name: '',
          },
          product: { offer_id: 'offer-money-returned', quantity: 1 },
        },
      ],
    });
    const page = repository.listReturns({ shopId: 'shop-r-money-returned', source: 'rfbs-return', pageSize: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].refundStatus, '已退款给买家');
    assert.equal(page.rows[0].refundEvidence.statusSource, 'state.state');
  } finally {
    db.close();
  }
});

test('return repository uses Ozon cancellation date as refund time for refused-after-delivery returns', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-cancel-refund',
      source: 'rfbs-return',
      rows: [
        {
          return_id: 1006,
          posting_number: '0102118853-0994-1',
          order_number: '0102118853-0994',
          created_at: '2026-06-30T09:17:31.852508Z',
          state: {
            state: 'Utilizing',
            state_name: 'На утилизации',
            group_state: 'utilization',
            money_return_state_name: '',
          },
          product: { offer_id: 'mz-26050408-639617', quantity: 1 },
        },
      ],
    });
    const page = repository.listReturns({ shopId: 'shop-r-cancel-refund', source: 'rfbs-return', pageSize: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].refundStatus, '已退款');
    assert.equal(page.rows[0].refundTime, '2026-06-30T09:17:31.852508Z');
    assert.equal(page.rows[0].refundEvidence.statusSource, 'Ozon取消日期');
    assert.equal(page.rows[0].refundEvidence.timeSource, 'created_at');
  } finally {
    db.close();
  }
});

test('return repository does not fabricate refund fields from generic return status and update time', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-no-refund',
      source: 'rfbs-return',
      rows: [
        {
          return_id: 1004,
          posting_number: '123-no-refund',
          status: 'awaiting_seller',
          created_at: '2026-07-03T06:00:00Z',
          updated_at: '2026-07-03T07:00:00Z',
          product: { offer_id: 'offer-no-refund', quantity: 1 },
        },
      ],
    });
    const page = repository.listReturns({ shopId: 'shop-r-no-refund', source: 'rfbs-return', pageSize: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].refundStatus, null);
    assert.equal(page.rows[0].refundTime, null);
    assert.equal(page.rows[0].refundEvidence, null);
  } finally {
    db.close();
  }
});

test('returns service starts background sync and preserves old cache on empty later result', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({ id: 'shop-r2', name: 'Returns shop', clientId: 'client-r2', apiKey: 'key-r2' });
    const scheduler = createFakeScheduler([
      { ok: true, status: 'success', data: { result: { returns: [{ id: 'ret-1', posting_number: 'p-1', status: 'opened' }] } } },
      { ok: true, status: 'success', data: { result: { returns: [] } } },
    ]);
    const service = createReturnsService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const first = service.startSync({ shopId: 'shop-r2', endpointKey: 'returns.list', maxPages: 1 });
    assert.equal(first.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.readCache({ shopId: 'shop-r2' }).total, 1);

    service.startSync({ shopId: 'shop-r2', endpointKey: 'returns.list', maxPages: 1, forceRefresh: true, idempotencyKey: 'returns-empty' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.readCache({ shopId: 'shop-r2' }).total, 1);
    assert.equal(scheduler.calls[0].endpointKey, 'returns.list');
  } finally {
    db.close();
  }
});

test('recovery reconcile runs an Ozon returns fixture through the normal scheduler merge without duplicating the existing return', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_recovery_returns');
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId,
      source: 'returns',
      rows: [{
        return_id: 'return-recovery-001',
        posting_number: 'RETURN-RECOVERY-POSTING-001',
        status: 'opened',
        reason: '旧售后原因',
        created_at: '2026-07-01T00:00:00.000Z',
        product: { offer_id: 'return-recovery-offer', quantity: 1 },
      }],
    });
    const scheduler = createFakeScheduler([{
      ok: true,
      status: 'success',
      data: {
        result: {
          returns: [{
            return_id: 'return-recovery-001',
            posting_number: 'RETURN-RECOVERY-POSTING-001',
            status: 'closed',
            reason: 'Ozon 已确认退款',
            state: { money_return_state_name: '已退款给买家' },
            refund: { refunded_at: '2026-07-11T12:10:00.000Z' },
            created_at: '2026-07-01T00:00:00.000Z',
            product: { offer_id: 'return-recovery-offer', quantity: 1 },
          }],
        },
      },
    }]);
    const returnsService = createReturnsService({
      db,
      ozonScheduler: scheduler,
      backgroundRunner: (task) => task(),
    });
    const reconcile = createRecoveryReconcileState({
      db,
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    reconcile.prepare({
      restoreId: 'restore-returns-fixture',
      generationId: 'generation-returns-fixture',
      shopId,
      overlapMinutes: 30,
    });
    const continuousSync = createContinuousSyncService({
      shopRepository,
      domainServices: new Map([['returns', returnsService]]),
      policies: [{
        id: 'returns:recovery-fixture',
        domain: 'returns',
        cadenceMs: 60_000,
        payload: { endpointKey: 'returns.list', pageSize: 100, maxPages: 1 },
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
    assert.equal(scheduler.calls[0].recoveryRestoreId, 'restore-returns-fixture');
    assert.equal(scheduler.calls[0].recoveryGenerationId, 'generation-returns-fixture');
    assert.equal(scheduler.calls[0].recoveryOverlapMinutes, 30);
    assert.equal(scheduler.calls[0].forceRefresh, true);

    const job = await waitForJobStatus(db, queued.results[0].result.jobId, 'success');
    assert.equal(job?.status, 'success');
    const recovered = repository.listReturns({
      shopId,
      returnIds: 'return-recovery-001',
      pageSize: 20,
    });
    assert.equal(recovered.total, 1);
    assert.equal(recovered.rows[0].status, 'closed');
    assert.equal(recovered.rows[0].reason, 'Ozon 已确认退款');
    assert.equal(recovered.rows[0].refundStatus, '已退款给买家');
    assert.equal(recovered.rows[0].refundTime, '2026-07-11T12:10:00.000Z');

    const queuedState = reconcile.get('restore-returns-fixture', shopId);
    assert.equal(queuedState?.status, 'queued');
    assert.equal(queuedState?.jobIds.length, 1);
    const finalized = continuousSync.runOnce();
    assert.equal(finalized.recoveryFinalized, 1);
    const completedState = reconcile.get('restore-returns-fixture', shopId);
    assert.equal(completedState?.status, 'completed');
    assert.equal(completedState?.completedPolicyCount, 1);
  } finally {
    db.close();
  }
});

test('returns rFBS sync enriches missing list reason from return detail before writing cache', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({
      id: 'shop-r-rfbs-detail',
      name: 'rFBS detail shop',
      clientId: 'client-r-rfbs-detail',
      ['api' + 'Key']: 'test-r-rfbs-detail-key',
    });
    const scheduler = createFakeScheduler([
      {
        ok: true,
        status: 'success',
        data: {
          result: {
            returns: [
              {
                return_id: 90652048,
                posting_number: '75064957-0486-1',
                product: { offer_id: 'mz-26050110-194993', quantity: 1 },
              },
            ],
          },
        },
      },
      {
        ok: true,
        status: 'success',
        data: {
          result: {
            return_id: 90652048,
            posting_number: '75064957-0486-1',
            return_reason: { name: '配送了错误的商品' },
          },
        },
      },
    ]);
    const service = createReturnsService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const accepted = service.startSync({
      shopId: 'shop-r-rfbs-detail',
      endpointKey: 'returns.rfbsList',
      maxPages: 1,
      idempotencyKey: 'returns-rfbs-detail-reason',
    });
    assert.equal(accepted.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(scheduler.calls[0].endpointKey, 'returns.rfbsList');
    assert.equal(scheduler.calls[1].endpointKey, 'returns.rfbsGet');
    assert.deepEqual(scheduler.calls[1].params, { return_id: '90652048' });
    const cache = service.readCache({ shopId: 'shop-r-rfbs-detail', returnIds: '90652048' });
    assert.equal(cache.total, 1);
    assert.equal(cache.rows[0].reason, '配送了错误的商品');
  } finally {
    db.close();
  }
});

test('returns rFBS detail enrichment caps local fan-out so one shop cannot flood the scheduler queue', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({
      id: 'shop-r-rfbs-fanout',
      name: 'rFBS fan-out shop',
      clientId: 'client-r-rfbs-fanout',
      ['api' + 'Key']: 'test-r-rfbs-fanout-key',
    });
    let activeDetails = 0;
    let maxActiveDetails = 0;
    let detailCalls = 0;
    const calls = [];
    const scheduler = {
      calls,
      async executeReadOnly(request) {
        calls.push(request);
        if (request.endpointKey === 'returns.rfbsList') {
          return {
            ok: true,
            status: 'success',
            data: {
              result: {
                returns: Array.from({ length: 5 }, (_, index) => ({
                  return_id: `rfbs-fanout-${index + 1}`,
                  posting_number: `posting-fanout-${index + 1}`,
                  product: { offer_id: `offer-fanout-${index + 1}`, quantity: 1 },
                })),
              },
            },
          };
        }
        detailCalls += 1;
        activeDetails += 1;
        maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeDetails -= 1;
        return {
          ok: true,
          status: 'success',
          data: {
            result: {
              return_id: request.params.return_id,
              return_reason: { name: `detail-${request.params.return_id}` },
            },
          },
        };
      },
    };
    const service = createReturnsService({
      db,
      ozonScheduler: scheduler,
      backgroundRunner: (task) => task(),
    });

    const accepted = service.startSync({
      shopId: 'shop-r-rfbs-fanout',
      endpointKey: 'returns.rfbsList',
      maxPages: 1,
      forceRefresh: true,
      idempotencyKey: 'returns-rfbs-fanout-cap',
    });
    const finalJob = await waitForJobStatus(db, accepted.jobId, 'success', 100);

    assert.equal(finalJob?.status, 'success');
    assert.equal(detailCalls, 5);
    assert.equal(maxActiveDetails, 2);
  } finally {
    db.close();
  }
});

test('returns rFBS sync refreshes stale list reason from return detail instead of trusting old list text', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({
      id: 'shop-r-rfbs-stale-detail',
      name: 'rFBS stale detail shop',
      clientId: 'client-r-rfbs-stale-detail',
      ['api' + 'Key']: 'test-r-rfbs-stale-detail-key',
    });
    const scheduler = createFakeScheduler([
      {
        ok: true,
        status: 'success',
        data: {
          returns: [
            {
              return_id: 92675795,
              posting_number: '11279330-0313-1',
              return_reason: { name: 'Покупатель не забрал заказ' },
              product: { offer_id: 'mz-old', quantity: 1 },
            },
          ],
        },
      },
      {
        ok: true,
        status: 'success',
        data: {
          returns: {
            posting_number: '14885060-0318-1',
            return_reason: { name: 'Покупатель отказался при вручении: товар не подошел' },
            product: { offer_id: 'mz-new', quantity: 1 },
          },
        },
      },
    ]);
    const service = createReturnsService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const accepted = service.startSync({
      shopId: 'shop-r-rfbs-stale-detail',
      endpointKey: 'returns.rfbsList',
      maxPages: 1,
      idempotencyKey: 'returns-rfbs-stale-detail-refresh',
    });
    assert.equal(accepted.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(scheduler.calls[1].endpointKey, 'returns.rfbsGet');
    const cache = service.readCache({ shopId: 'shop-r-rfbs-stale-detail', returnIds: '92675795', pageSize: 10 });
    assert.equal(cache.total, 1);
    assert.equal(cache.rows[0].posting_number, '14885060-0318-1');
    assert.equal(cache.rows[0].reason, '售后原因翻译中');
    assert.equal(cache.rows[0].reasonRaw, 'Покупатель отказался при вручении: товар не подошел');
    assert.equal(cache.rows[0].reasonTranslationStatus, 'pending');
    assert.equal(cache.rows[0].product.offer_id, 'mz-new');
  } finally {
    db.close();
  }
});

test('returns rFBS detail sync stores object-shaped Ozon detail on the existing return id', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({
      id: 'shop-r-rfbs-object-detail',
      name: 'rFBS object detail shop',
      clientId: 'client-r-rfbs-object-detail',
      ['api' + 'Key']: 'test-r-rfbs-object-detail-key',
    });
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-rfbs-object-detail',
      source: 'rfbs-return',
      rows: [
        {
          return_id: 90652048,
          posting_number: '75064957-0486-1',
          state: { state: 'MoneyReturned', state_name: 'Деньги возвращены' },
          product: { offer_id: 'mz-26050110-194993', quantity: 1 },
        },
      ],
    });
    const scheduler = createFakeScheduler([
      {
        ok: true,
        status: 'success',
        data: {
          returns: {
            posting_number: '75064957-0486-1',
            return_number: '75064957-R19',
            return_reason: { id: 22, name: 'Привезли не тот товар', is_defect: true },
            state: { state: 'MoneyReturned', state_name: 'Деньги возвращены' },
            product: { offer_id: 'mz-26050110-194993', quantity: 1 },
          },
        },
      },
    ]);
    const service = createReturnsService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const accepted = service.startSync({
      shopId: 'shop-r-rfbs-object-detail',
      endpointKey: 'returns.rfbsGet',
      params: { return_id: 90652048 },
      forceRefresh: true,
      idempotencyKey: 'returns-rfbs-object-detail-reason',
    });
    assert.equal(accepted.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(scheduler.calls[0].endpointKey, 'returns.rfbsGet');
    assert.deepEqual(scheduler.calls[0].params, { return_id: 90652048 });
    assert.equal(scheduler.calls[0].cacheKey, 'returns:shop-r-rfbs-object-detail:returns.rfbsGet:return:90652048');
    const allRows = service.readCache({ shopId: 'shop-r-rfbs-object-detail', pageSize: 10 });
    assert.equal(allRows.total, 1);
    const cache = service.readCache({ shopId: 'shop-r-rfbs-object-detail', returnIds: '90652048', pageSize: 10 });
    assert.equal(cache.total, 1);
    assert.equal(cache.rows[0].return_reason, '配送了错误的商品');
    assert.equal(cache.rows[0].raw.return_number, '75064957-R19');
  } finally {
    db.close();
  }
});

test('returns background sync uses scheduler profile and records meaningful change notifications', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({
      id: 'shop-r-notify',
      name: '售后提醒店铺',
      clientId: 'client-r-notify',
      ['api' + 'Key']: 'test-return-notify-key',
    });
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-notify',
      source: 'returns',
      rows: [
        {
          return_id: 'ret-existing',
          posting_number: 'posting-existing',
          status: 'opened',
          reason: '旧原因',
          created_at: '2026-06-29T10:00:00Z',
        },
      ],
    });
    const scheduler = createFakeScheduler([
      {
        ok: true,
        status: 'success',
        data: {
          result: {
            returns: [
              {
                return_id: 'ret-existing',
                posting_number: 'posting-existing',
                status: 'closed',
                reason: '买家取消',
                state: { money_return_state_name: '已退款给买家' },
                refund: { refunded_at: '2026-07-03T10:00:00Z' },
                created_at: '2026-06-29T10:00:00Z',
              },
            ],
          },
        },
      },
    ]);
    const service = createReturnsService({
      db,
      ozonScheduler: scheduler,
      shopRepository: createShopRepository(db),
      backgroundRunner: (task) => task(),
    });

    const accepted = service.startSync({
      shopId: 'shop-r-notify',
      endpointKey: 'returns.list',
      maxPages: 1,
      forceRefresh: true,
      recordNotifications: true,
      profile: 'background',
      syncSource: 'background-after-sales-poller',
      idempotencyKey: 'returns-notify-change',
    });
    assert.equal(accepted.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(scheduler.calls[0].profile, 'background');
    assert.equal(scheduler.calls[0].source, 'background-after-sales-poller');
    const event = db.prepare('SELECT * FROM ozon_notification_events WHERE domain = ?').get('returns');
    assert.equal(event.event_type, 'return_status_changed');
    assert.equal(event.shop_id, 'shop-r-notify');
    assert.equal(event.shop_name, '售后提醒店铺');
    assert.equal(event.posting_number, 'posting-existing');
    assert.match(event.summary, /posting-existing/u);
    assert.match(event.summary, /售后状态/u);
    const newValue = JSON.parse(event.new_value_json);
    assert.equal(newValue.status, 'closed');
    assert.equal(newValue.reason, '买家取消');
    assert.equal(newValue.refundStatus, '已退款给买家');
    const job = db.prepare('SELECT * FROM ozon_request_jobs WHERE id = ?').get(accepted.jobId);
    assert.equal(Boolean(job.snapshot_id), true);
    assert.match(job.message, /已记录 1 条后台变化提醒/u);
  } finally {
    db.close();
  }
});

test('returns background sync does not notify every row during first cache bootstrap', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({
      id: 'shop-r-bootstrap',
      name: '售后首次同步',
      clientId: 'client-r-bootstrap',
      ['api' + 'Key']: 'test-return-bootstrap-key',
    });
    const scheduler = createFakeScheduler([
      {
        ok: true,
        status: 'success',
        data: {
          result: {
            returns: [
              {
                return_id: 'ret-first',
                posting_number: 'posting-first',
                status: 'opened',
                reason: '首次读取',
                created_at: '2026-07-01T10:00:00Z',
              },
            ],
          },
        },
      },
    ]);
    const service = createReturnsService({
      db,
      ozonScheduler: scheduler,
      shopRepository: createShopRepository(db),
      backgroundRunner: (task) => task(),
    });

    service.startSync({
      shopId: 'shop-r-bootstrap',
      endpointKey: 'returns.list',
      maxPages: 1,
      recordNotifications: true,
      profile: 'background',
      syncSource: 'background-after-sales-poller',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(service.readCache({ shopId: 'shop-r-bootstrap' }).total, 1);
    const totalEvents = db.prepare('SELECT COUNT(*) AS total FROM ozon_notification_events WHERE domain = ?').get('returns').total;
    assert.equal(totalEvents, 0);
  } finally {
    db.close();
  }
});

test('returns service applies a default 90-day sync range and preserves explicit user range', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({
      id: 'shop-r-90d',
      name: 'Returns 90d',
      clientId: 'client-r-90d',
      apiKey: 'test-key-r-90d',
    });
    const scheduler = createFakeScheduler([
      { ok: true, status: 'success', data: { result: { returns: [] } } },
      { ok: true, status: 'success', data: { result: { returns: [] } } },
    ]);
    const service = createReturnsService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });

    service.startSync({
      shopId: 'shop-r-90d',
      endpointKey: 'returns.list',
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
      shopId: 'shop-r-90d',
      endpointKey: 'returns.list',
      params: { filter: { since: '2026-06-01T00:00:00.000Z', to: '2026-06-15T00:00:00.000Z' } },
      maxPages: 1,
      forceRefresh: true,
      idempotencyKey: 'returns-explicit-range',
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

test('returns cache read defaults to 90 days and preserves explicit user range', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-r-cache-90d',
      source: 'returns',
      rows: [
        {
          return_id: 'recent-return',
          posting_number: 'recent-posting',
          status: 'opened',
          created_at: '2026-06-20T00:00:00.000Z',
        },
        {
          return_id: 'old-return',
          posting_number: 'old-posting',
          status: 'opened',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const service = createReturnsService({ db, ozonScheduler: createFakeScheduler() });

    const defaultPage = service.readCache({
      shopId: 'shop-r-cache-90d',
      now: '2026-07-01T00:00:00.000Z',
      pageSize: 20,
    });
    assert.equal(defaultPage.total, 1);
    assert.equal(defaultPage.rows[0].return_id, 'recent-return');

    const explicitPage = service.readCache({
      shopId: 'shop-r-cache-90d',
      since: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      pageSize: 20,
    });
    assert.equal(explicitPage.total, 2);
  } finally {
    db.close();
  }
});

test('return reason translation is persisted per shop and public DTO never exposes pending Cyrillic text', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    for (const shopId of ['shop-reason-a', 'shop-reason-b']) {
      repository.upsertReturns({
        shopId,
        rows: [{
          return_id: `return-${shopId}`,
          posting_number: `posting-${shopId}`,
          return_reason: { name: 'Заказ утерян при доставке' },
        }],
      });
    }

    const pending = repository.listReturns({ shopId: 'shop-reason-a', pageSize: 10 }).rows[0];
    assert.equal(pending.reason, '售后原因翻译中');
    assert.equal(pending.reasonRaw, 'Заказ утерян при доставке');
    assert.equal(pending.reasonTranslationStatus, 'pending');

    const saved = repository.saveReasonTranslation({
      shopId: 'shop-reason-a',
      sourceText: 'Заказ утерян при доставке',
      translatedText: '订单在配送过程中丢失',
      provider: 'fixture',
    });
    assert.equal(saved.changed, 1);
    assert.equal(repository.listReturns({ shopId: 'shop-reason-a', pageSize: 10 }).rows[0].reason, '订单在配送过程中丢失');
    assert.equal(repository.listReturns({ shopId: 'shop-reason-b', pageSize: 10 }).rows[0].reason, '售后原因翻译中');
  } finally {
    db.close();
  }
});

test('returns service dynamically translates arbitrary Cyrillic reasons and writes the result to SQLite', async () => {
  const db = createMigratedTestDb();
  try {
    const repository = createReturnRepository(db);
    repository.upsertReturns({
      shopId: 'shop-reason-dynamic',
      rows: [{
        return_id: 'return-dynamic',
        posting_number: 'posting-dynamic',
        return_reason: { name: 'Совершенно новая причина возврата' },
      }],
    });
    const messageTranslationService = {
      async translateMessages({ messages }) {
        assert.deepEqual(messages.map((row) => row.text), ['Совершенно новая причина возврата']);
        return {
          ok: true,
          rows: messages.map((row) => ({
            ...row,
            translatedText: '全新的退货原因',
            translated: true,
            provider: 'fixture',
          })),
        };
      },
    };
    const service = createReturnsService({ db, messageTranslationService });
    const result = await service.translateReasons({
      messages: [{
        id: 'reason-1',
        shopId: 'shop-reason-dynamic',
        text: 'Совершенно новая причина возврата',
      }],
    });
    assert.equal(result.translatedCount, 1);
    assert.equal(result.persistedCount, 1);
    const row = service.readCache({ shopId: 'shop-reason-dynamic', pageSize: 10 }).rows[0];
    assert.equal(row.reason, '全新的退货原因');
    assert.equal(row.reasonRaw, 'Совершенно новая причина возврата');
    assert.equal(row.reasonTranslationProvider, 'fixture');
  } finally {
    db.close();
  }
});

test('returns service default sync can continue past the first page for 90-day ranges', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({
      id: 'shop-r-pages',
      name: 'Returns pages',
      clientId: 'client-r-pages',
      apiKey: 'test-key-r-pages',
    });
    const firstPageRows = Array.from({ length: 100 }, (_, index) => ({
      return_id: `ret-page-${index + 1}`,
      posting_number: `posting-page-${index + 1}`,
      status: 'opened',
      created_at: '2026-06-30T10:00:00Z',
    }));
    const scheduler = createFakeScheduler([
      { ok: true, status: 'success', data: { result: { returns: firstPageRows } } },
      { ok: true, status: 'success', data: { result: { returns: [] } } },
    ]);
    const service = createReturnsService({ db, ozonScheduler: scheduler, backgroundRunner: (task) => task() });
    const first = service.startSync({ shopId: 'shop-r-pages', endpointKey: 'returns.list' });
    assert.equal(first.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(scheduler.calls.length, 2);
    assert.equal(scheduler.calls[0].params.offset, 0);
    assert.equal(scheduler.calls[1].params.offset, 100);
    assert.equal(service.readCache({ shopId: 'shop-r-pages' }).total, 100);
  } finally {
    db.close();
  }
});

test('returns HTTP routes expose /api/sync/returns and /api/cache/returns', async () => {
  const db = createMigratedTestDb();
  try {
    createShopRepository(db).saveShop({ id: 'shop-r3', name: 'Returns shop', clientId: 'client-r3', apiKey: 'key-r3' });
    const scheduler = createFakeScheduler([
      { ok: true, status: 'success', data: { returns: [{ return_id: 'rfbs-1', posting_number: 'posting-1', state: 'new' }] } },
    ]);
    await withServer(db, scheduler, async (base) => {
      const syncResponse = await fetch(`${base}/api/sync/returns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shopId: 'shop-r3', endpointKey: 'returns.rfbsList', pageSize: 50, maxPages: 1 }),
      });
      const syncPayload = await syncResponse.json();
      assert.equal(syncResponse.status, 202);
      assert.equal(syncPayload.ok, true);
      await new Promise((resolve) => setImmediate(resolve));

      const cacheResponse = await fetch(`${base}/api/cache/returns?shopId=shop-r3&source=rfbs-return&pageSize=20`);
      const cachePayload = await cacheResponse.json();
      assert.equal(cacheResponse.status, 200);
      assert.equal(cachePayload.ok, true);
      assert.equal(cachePayload.rows.length, 1);
      assert.equal(cachePayload.rows[0].return_id, 'rfbs-1');
    });
  } finally {
    db.close();
  }
});

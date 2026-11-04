import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';

test('targeted empty-finance verification passes the real scheduler and returns official empty data, not a local miss', async () => {
  const db = createMigratedTestDb();
  const shopId = saveUnitShop(createShopRepository(db), 'shop-empty-live');
  const calls = [];
  const server = createApp({ db, config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }), listAppliedMigrations: () => [], startedAt: Date.now(),
    ozonClient: { async requestReadOnly(input) {
      calls.push(input);
      assert.equal(input.shopCredentials.shopId, shopId);
      assert.equal(input.endpointKey, 'finance.transactionList');
      assert.equal(input.payload.filter.posting_number, '98765432-0001-1');
      return { ok: true, status: 200, data: { result: { operations: [], row_count: 0, page_count: 0 } } };
    } },
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const to = new Date(), from = new Date(to); from.setUTCHours(0, 0, 0, 0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ozon/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        shopId, endpointKey: 'finance.transactionList', access: 'read', forceRefresh: true, allowStale: false,
        requestedBy: 'profit-empty-finance-verification', params: {
          filter: { posting_number: '98765432-0001-1', operation_type: [], transaction_type: 'all',
            date: { from: from.toISOString(), to: to.toISOString() } }, page: 1, page_size: 1000,
        },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.schedulerResult.status, 'success');
    assert.equal(payload.data.result.row_count, 0);
    assert.equal(payload.data.result.page_count, 0);
    assert.equal(calls.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

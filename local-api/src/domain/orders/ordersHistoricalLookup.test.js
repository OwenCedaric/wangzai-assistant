import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderRepository } from '../../db/repositories/orderRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';
import { createOrdersService } from './ordersService.js';

test('historical lookup tries FBS then FBO and merges the official order before returning', async () => {
  const db = createMigratedTestDb();
  try {
    saveUnitShop(createShopRepository(db), 'shop-historical-lookup');
    const calls = [];
    const service = createOrdersService({
      db,
      ozonScheduler: {
        async executeReadOnly(input) {
          calls.push(input);
          if (input.endpointKey === 'orders.fbsGet') {
            return { ok: false, error: { message: 'not an FBS posting' } };
          }
          return {
            ok: true,
            data: {
              result: {
                posting_number: 'FBO-HISTORY-1',
                order_id: 'order-history-1',
                status: 'delivered',
                products: [{ product_id: '9001', offer_id: 'history-offer-1' }],
              },
            },
          };
        },
      },
    });

    const result = await service.refreshOrdersByPostingNumbers({
      shopId: 'shop-historical-lookup',
      postingNumbers: ['FBO-HISTORY-1'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.foundCount, 1);
    assert.deepEqual(calls.map((call) => call.endpointKey), ['orders.fbsGet', 'orders.fboGet']);
    assert.ok(calls.every((call) => call.forceRefresh === true && call.allowStale === false));
    const cached = createOrderRepository(db).listOrders({
      shopId: 'shop-historical-lookup',
      postingNumber: 'FBO-HISTORY-1',
    });
    assert.equal(cached.rows.length, 1);
    assert.equal(cached.rows[0].orderId, 'order-history-1');
  } finally {
    db.close();
  }
});

test('push source hint reads only the matching order endpoint', async () => {
  const db = createMigratedTestDb();
  try {
    saveUnitShop(createShopRepository(db), 'shop-push-order-hint');
    const calls = [];
    const service = createOrdersService({
      db,
      ozonScheduler: {
        async executeReadOnly(input) {
          calls.push(input);
          return {
            ok: true,
            data: {
              result: {
                posting_number: 'FBO-PUSH-1',
                order_id: 'order-push-1',
                status: 'awaiting_packaging',
                products: [{ product_id: '9101', offer_id: 'push-offer-1' }],
              },
            },
          };
        },
      },
    });

    const result = await service.refreshOrdersByPostingNumbers({
      shopId: 'shop-push-order-hint',
      postingNumbers: ['FBO-PUSH-1'],
      sourceHints: { 'FBO-PUSH-1': 'FBO' },
      requestedBy: 'ozon-push-new-order',
    });

    assert.equal(result.foundCount, 1);
    assert.deepEqual(calls.map((call) => call.endpointKey), ['orders.fboGet']);
    assert.equal(calls[0].requestedBy, 'ozon-push-new-order');
  } finally {
    db.close();
  }
});

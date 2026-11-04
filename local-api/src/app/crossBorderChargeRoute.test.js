import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';
import { createOrderRepository } from '../db/repositories/orderRepository.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createApp } from './createApp.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('cross-border charge routes preserve tenant/user isolation through preview, confirm and readback', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopId = saveUnitShop(createShopRepository(db, {
      tenantId: 'tenant-route-a',
      userId: 'user-route-a',
    }), 'charge-route-shop');
    createOrderRepository(db).upsertOrders({
      shopId,
      rows: [{ posting_number: 'ROUTE-POSTING-1', order_id: 'route-order-1', status: 'delivered' }],
    });
    server = createApp({
      db,
      config: {
        security: {},
        sync: {},
        ozon: {},
        runtime: {
          profileId: 'default',
          tenantId: 'tenant-route-a',
          userId: 'user-route-a',
        },
      },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const contextHeaders = {
      'Content-Type': 'application/json',
      'X-Wangzai-Tenant-Id': 'tenant-route-a',
      'X-Wangzai-User-Id': 'user-route-a',
    };
    const previewResponse = await fetch(`${baseUrl}/api/logistics/cross-border/charges/preview`, {
      method: 'POST',
      headers: contextHeaders,
      body: JSON.stringify({
        browserAccountRef: 'browser-route-a',
        shopId,
        orders: [{ oid: 'route-collection-1', order_number: 'ROUTE-POSTING-1' }],
        charges: [{ oid: 'route-collection-1', type: '支出', money: 4, time: '2026-07-28 12:00:00' }],
      }),
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(preview.summary.exactCount, 1);

    const wrongConfirmResponse = await fetch(`${baseUrl}/api/logistics/cross-border/charges/confirm`, {
      method: 'POST',
      headers: { ...contextHeaders, 'X-Wangzai-User-Id': 'user-route-b' },
      body: JSON.stringify({ previewId: preview.previewId, confirmationToken: preview.confirmationToken }),
    });
    assert.equal(wrongConfirmResponse.status, 409);
    assert.equal((await wrongConfirmResponse.json()).error.code, 'CROSS_BORDER_CHARGE_CONTEXT_MISMATCH');

    const confirmResponse = await fetch(`${baseUrl}/api/logistics/cross-border/charges/confirm`, {
      method: 'POST',
      headers: contextHeaders,
      body: JSON.stringify({ previewId: preview.previewId, confirmationToken: preview.confirmationToken }),
    });
    const confirmed = await confirmResponse.json();
    assert.equal(confirmResponse.status, 200);
    assert.equal(confirmed.readbackVerified, true);

    const ownReadback = await fetch(`${baseUrl}/api/logistics/cross-border/charges?includeRecords=true`, {
      headers: contextHeaders,
    }).then((response) => response.json());
    assert.equal(ownReadback.total, 1);
    assert.equal(ownReadback.rows[0].actualFeeCny, 4);
    assert.equal(ownReadback.records.length, 1);

    const otherReadback = await fetch(`${baseUrl}/api/logistics/cross-border/charges`, {
      headers: { ...contextHeaders, 'X-Wangzai-User-Id': 'user-route-b' },
    }).then((response) => response.json());
    assert.equal(otherReadback.total, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

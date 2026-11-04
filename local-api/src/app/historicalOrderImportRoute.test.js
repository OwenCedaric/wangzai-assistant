import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';
import { createOrderRepository } from '../db/repositories/orderRepository.js';
import { createProductRepository } from '../db/repositories/productRepository.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createApp } from './createApp.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('historical order import routes keep data local and require the preview fingerprint', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopId = 'shop-route-order-history';
    saveUnitShop(createShopRepository(db), shopId);
    createProductRepository(db).upsertProducts({
      shopId,
      rows: [{
        product_id: '7101',
        offer_id: 'route-order-offer-1',
        sku: '87101',
        name: 'Route order product',
        price: '66',
      }],
    });
    createOrderRepository(db).upsertOrders({
      shopId,
      rows: [{
        posting_number: 'ROUTE-ORDER-1',
        order_id: 'route-order-id-1',
        status: 'delivered',
        products: [{ product_id: '7101', offer_id: 'route-order-offer-1', sku: '87101' }],
      }],
    });

    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {}, runtime: { profileId: 'default' } },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const preflightResponse = await fetch(`${baseUrl}/api/app/historical-order-import/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId,
        source: { fileName: '历史订单.csv', fileType: 'csv' },
        rows: [{ orderNumber: 'ROUTE-ORDER-1', purchaseCostCny: 12.5, lengthCm: 10 }],
      }),
    });
    const preview = await preflightResponse.json();
    assert.equal(preflightResponse.status, 200);
    assert.equal(preview.rows[0].status, 'ready_insert');
    assert.equal(preview.rows[0].selectedProduct.productId, '7101');

    const staleResponse = await fetch(`${baseUrl}/api/app/historical-order-import/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId,
        importId: preview.importId,
        previewFingerprint: '0'.repeat(64),
      }),
    });
    const stale = await staleResponse.json();
    assert.equal(staleResponse.status, 409);
    assert.equal(stale.error.code, 'HISTORICAL_ORDER_IMPORT_PREVIEW_STALE');

    const confirmResponse = await fetch(`${baseUrl}/api/app/historical-order-import/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId,
        importId: preview.importId,
        previewFingerprint: preview.previewFingerprint,
      }),
    });
    const confirmed = await confirmResponse.json();
    assert.equal(confirmResponse.status, 200);
    assert.equal(confirmed.verified, true);
    assert.equal(confirmed.summary.committed, 1);

    const fact = db.prepare(`
      SELECT purchase_cost_minor, length_mm, source_type
      FROM historical_order_facts WHERE shop_id = ? AND posting_number = ?
    `).get(shopId, 'ROUTE-ORDER-1');
    assert.deepEqual({ ...fact }, {
      purchase_cost_minor: 1250,
      length_mm: 100,
      source_type: 'historical_order_import',
    });

    const historyResponse = await fetch(
      `${baseUrl}/api/app/historical-order-import/history?shopId=${shopId}&limit=5`,
    );
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.equal(history.imports[0].importId, preview.importId);
    assert.equal(history.imports[0].status, 'completed');
    assert.equal(history.imports[0].rows[0].committed, true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

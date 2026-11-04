import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';
import { createProductRepository } from '../db/repositories/productRepository.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createApp } from './createApp.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('historical product import routes stage, confirm, read history, and map stale previews to 409', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    saveUnitShop(createShopRepository(db), 'shop-route-history');
    createProductRepository(db).upsertProducts({
      shopId: 'shop-route-history',
      rows: [{
        product_id: '7001',
        offer_id: 'route-offer-1',
        sku: '87001',
        name: 'Route product',
        price: '66',
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
    const preflightResponse = await fetch(`${baseUrl}/api/app/historical-product-import/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: 'shop-route-history',
        conflictMode: 'preserve',
        source: { fileName: 'history.csv', fileType: 'csv' },
        columns: [
          { sourceHeader: '货号', field: 'offerId' },
          { sourceHeader: '成本', field: 'purchaseCostCny' },
        ],
        rows: [{ offerId: 'route-offer-1', purchaseCostCny: '12.50' }],
      }),
    });
    const preview = await preflightResponse.json();
    assert.equal(preflightResponse.status, 200);
    assert.equal(preview.rows[0].status, 'ready_insert');

    const staleResponse = await fetch(`${baseUrl}/api/app/historical-product-import/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: 'shop-route-history',
        importId: preview.importId,
        previewFingerprint: '0'.repeat(64),
        conflictMode: 'preserve',
      }),
    });
    const stale = await staleResponse.json();
    assert.equal(staleResponse.status, 409);
    assert.equal(stale.error.code, 'HISTORICAL_IMPORT_PREVIEW_STALE');

    const confirmResponse = await fetch(`${baseUrl}/api/app/historical-product-import/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: 'shop-route-history',
        importId: preview.importId,
        previewFingerprint: preview.previewFingerprint,
        conflictMode: 'preserve',
      }),
    });
    const confirmed = await confirmResponse.json();
    assert.equal(confirmResponse.status, 200);
    assert.equal(confirmed.verified, true);
    assert.equal(confirmed.summary.committed, 1);

    const historyResponse = await fetch(
      `${baseUrl}/api/app/historical-product-import/history?shopId=shop-route-history&limit=5`,
    );
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.equal(history.imports.length, 1);
    assert.equal(history.imports[0].importId, preview.importId);
    assert.equal(history.imports[0].status, 'completed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

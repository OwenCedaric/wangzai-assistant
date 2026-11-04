import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createSalesSourceLinkRepository } from '../src/db/repositories/salesSourceLinkRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

test('sales source links are shop-scoped, paged, and replace stale slots without touching product or purchase links', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'shop_sales_source');
    const repository = createSalesSourceLinkRepository(db);
    repository.saveLinks({
      shopId,
      orderKey: 'posting-1',
      primaryIndex: 1,
      links: [
        {
          link: 'https://detail.1688.com/offer/one.html',
          productId: 'one',
          platform: '1688',
          previewImageUrl: 'https://img.test/sales-preview.jpg',
          originalImageUrl: 'https://img.test/sales-original.jpg',
        },
        { link: 'https://mobile.yangkeduo.com/goods.html?goods_id=two', productId: 'two', platform: 'PDD' },
      ],
    });
    const first = repository.listLinks({ shopId, orderKey: 'posting-1' });
    assert.equal(first.total, 2);
    assert.deepEqual(first.rows.map((row) => row.isPrimary), [false, true]);
    assert.equal(first.rows[0].previewImageUrl, 'https://img.test/sales-preview.jpg');
    assert.equal(first.rows[0].originalImageUrl, 'https://img.test/sales-original.jpg');
    assert.equal(db.prepare('SELECT raw_json FROM sales_source_links WHERE order_key = ? AND slot_index = 0').get('posting-1').raw_json, null);

    repository.saveLinks({
      shopId,
      orderKey: 'posting-1',
      links: [{ link: 'https://detail.1688.com/offer/three.html', productId: 'three', platform: '1688' }],
    });
    const replaced = repository.listLinks({ shopId, orderKey: 'posting-1' });
    assert.equal(replaced.total, 1);
    assert.equal(replaced.rows[0].sourceProductId, 'three');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_source_links').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_source_links').get().count, 0);
  } finally {
    db.close();
  }
});

test('sales source link HTTP routes use the dedicated table without a remote request', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'shop_sales_source_http');
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false } },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const saved = await (
      await fetch(`${baseUrl}/api/sales/source-links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopId,
          orderKey: 'posting-http',
          links: [{ link: 'https://detail.1688.com/offer/http.html', productId: 'http', platform: '1688' }],
        }),
      })
    ).json();
    assert.equal(saved.ok, true);
    const listed = await (await fetch(`${baseUrl}/api/sales/source-links?shopId=${encodeURIComponent(shopId)}`)).json();
    assert.equal(listed.total, 1);
    assert.equal(listed.rows[0].orderKey, 'posting-http');
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    db.close();
  }
});

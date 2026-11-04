import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/createApp.js';
import { createProductRepository } from '../src/db/repositories/productRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function createNoopScheduler() {
  return {
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
    async executeReadOnly() { return { ok: true, status: 'success', data: { result: { items: [] } } }; },
  };
}

async function withServer(db, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonScheduler: createNoopScheduler(),
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

test('product support tables keep material priority and attach support to cache rows', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_support');
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: 'IN_SALE',
    rows: [{ product_id: 1001, offer_id: 'offer-1001', name: '支撑商品', visibility: 'IN_SALE' }],
  });

  const ozonProfile = repository.upsertProductMaterialProfile({
    shopId,
    productId: '1001',
    offerId: 'offer-1001',
    source: 'ozon-readback',
    weight: 0.1,
    length: 10,
    width: 8,
    height: 5,
  });
  assert.equal(ozonProfile.changed, true);

  const busProfile = repository.upsertProductMaterialProfile({
    shopId,
    productId: '1001',
    offerId: 'offer-1001',
    source: 'cross-border-bus',
    weight: 0.2,
    length: 20,
    width: 18,
    height: 15,
    sourceOrderId: 'bus-001',
  });
  assert.equal(busProfile.profile.source, 'cross-border-bus');

  const staleOzonProfile = repository.upsertProductMaterialProfile({
    shopId,
    productId: '1001',
    offerId: 'offer-1001',
    source: 'ozon-readback',
    weight: 0.3,
    length: 30,
    width: 28,
    height: 25,
  });
  assert.equal(staleOzonProfile.preserved, true);
  assert.equal(staleOzonProfile.profile.source, 'cross-border-bus');
  assert.equal(staleOzonProfile.savedProfile.source, 'ozon-readback');

  repository.upsertProductSourceLinks({
    shopId,
    productId: '1001',
    offerId: 'offer-1001',
    record: {
      primaryIndex: 0,
      links: [{ link: 'https://yangkeduo.com/goods.html?goods_id=abc', platform: 'PDD', productId: 'abc', priceValue: 12.3 }],
    },
  });
  repository.upsertProductImageHealth({
    shopId,
    productId: '1001',
    offerId: 'offer-1001',
    imageUrl: 'https://img.example/a.jpg',
    status: 'broken',
    httpStatus: 404,
  });

  const page = repository.listProducts({ shopId, pageSize: 20 });
  assert.equal(page.rows[0].materialProfile.source, 'cross-border-bus');
  assert.equal(page.rows[0].materialProfile.weight, '0.2');
  assert.equal(page.rows[0].materialProfiles.length, 2);
  assert.deepEqual(page.rows[0].materialCandidates.map((item) => item.source).slice(0, 2), [
    'cross-border-bus',
    'ozon-readback',
  ]);
  assert.equal(page.rows[0].sourceLinks[0].platform, 'PDD');
  assert.equal(page.rows[0].imageHealth[0].status, 'broken');
});

test('product material profile listing supports bounded offset pagination for legacy migration', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_material_pagination');
    const repository = createProductRepository(db);
    for (let index = 0; index < 501; index += 1) {
      repository.upsertProductMaterialProfile({
        shopId,
        offerId: `offer-${String(index).padStart(3, '0')}`,
        source: 'ozon-readback',
        weight: 0.1,
        length: 10,
        width: 8,
        height: 5,
      });
    }

    const first = repository.listProductMaterialProfiles({ shopId, limit: 500, offset: 0 });
    const second = repository.listProductMaterialProfiles({ shopId, limit: 500, offset: 500 });

    assert.equal(first.length, 500);
    assert.equal(second.length, 1);
    assert.notEqual(first[0].key, second[0].key);
  } finally {
    db.close();
  }
});

test('product source link listing is paged, scoped, and removes stale slots on the one canonical save path', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_source_pagination');
    const repository = createProductRepository(db);
    for (let index = 0; index < 501; index += 1) {
      repository.upsertProductSourceLinks({
        shopId,
        productKey: `offer-${String(index).padStart(3, '0')}`,
        record: { links: [{ link: `https://detail.1688.com/offer/${index}.html`, productId: String(index) }] },
      });
    }

    const first = repository.listProductSourceLinks({ shopId, limit: 500, offset: 0 });
    const second = repository.listProductSourceLinks({ shopId, limit: 500, offset: 500 });
    assert.equal(first.length, 500);
    assert.equal(second.length, 1);
    assert.equal(first[0].shopId, shopId);
    assert.ok(first[0].productKey);
    assert.ok(first[0].updatedAt);

    repository.upsertProductSourceLinks({
      shopId,
      productId: '1001',
      offerId: 'offer-replace',
      sku: 'sku-replace',
      productKey: 'offer-replace',
      record: {
        links: [
          {
            link: 'https://detail.1688.com/offer/one.html',
            productId: 'one',
            previewImageUrl: 'https://img.test/product-preview.jpg',
            originalImageUrl: 'https://img.test/product-original.jpg',
          },
          { link: 'https://detail.1688.com/offer/two.html', productId: 'two' },
        ],
      },
    });
    repository.upsertProductSourceLinks({
      shopId,
      productKey: 'offer-replace',
      record: { links: [{ link: 'https://detail.1688.com/offer/three.html', productId: 'three' }] },
    });
    const replaced = repository.listProductSourceLinks({ shopId, productKey: 'offer-replace' });
    assert.deepEqual(replaced.map((link) => link.sourceProductId), ['three']);
    assert.equal(replaced[0].ozonProductId, '1001');
    assert.equal(replaced[0].offerId, 'offer-replace');
    assert.equal(replaced[0].sku, 'sku-replace');
    assert.equal(replaced[0].previewImageUrl, 'https://img.test/product-preview.jpg');
    assert.equal(replaced[0].originalImageUrl, 'https://img.test/product-original.jpg');
    assert.equal(
      db.prepare("SELECT raw_json FROM product_source_links WHERE shop_id = ? AND product_key = ?").get(shopId, 'offer-replace').raw_json,
      null
    );
  } finally {
    db.close();
  }
});

test('product source repository repairs only the redundant historical shop prefix before exposing source records', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_source_repair');
    db.prepare(`
      INSERT INTO product_source_links (
        id, shop_id, product_key, slot_index, is_primary, url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-prefixed-source',
      shopId,
      `${shopId}:offer-legacy`,
      0,
      1,
      'https://detail.1688.com/offer/legacy.html',
      '2026-07-11T00:00:00.000Z',
      '2026-07-11T00:00:00.000Z'
    );

    const repository = createProductRepository(db);
    const rows = repository.listProductSourceLinks({ shopId, productKey: 'offer-legacy' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].productKey, 'offer-legacy');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM product_source_links WHERE product_key = ?").get(`${shopId}:offer-legacy`).count,
      0
    );
  } finally {
    db.close();
  }
});

test('product source repository promotes legacy media from raw_json and removes the duplicated payload', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'shop_product_source_media_repair');
    db.prepare(`
      INSERT INTO product_source_links (
        id, shop_id, product_key, slot_index, is_primary, url, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-media-source',
      shopId,
      'offer-media',
      0,
      1,
      'https://detail.1688.com/offer/media.html',
      JSON.stringify({ previewImageUrl: 'https://img.test/legacy-preview.jpg', originalImageUrl: 'https://img.test/legacy-original.jpg' }),
      '2026-07-12T00:00:00.000Z',
      '2026-07-12T00:00:00.000Z'
    );

    const repository = createProductRepository(db);
    const [row] = repository.listProductSourceLinks({ shopId, productKey: 'offer-media' });
    assert.equal(row.previewImageUrl, 'https://img.test/legacy-preview.jpg');
    assert.equal(row.originalImageUrl, 'https://img.test/legacy-original.jpg');
    assert.equal(db.prepare('SELECT raw_json FROM product_source_links WHERE id = ?').get('legacy-media-source').raw_json, null);
  } finally {
    db.close();
  }
});

test('product price merge stores Ozon acquiring fee without fake fallback', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_fee');
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: 'IN_SALE',
    rows: [{ product_id: 2001, offer_id: 'offer-2001', name: '费用商品', visibility: 'IN_SALE' }],
  });
  repository.mergeProductPriceRows({
    shopId,
    rows: [{
      product_id: 2001,
      offer_id: 'offer-2001',
      price: { marketing_seller_price: '88.8', currency_code: 'CNY' },
      commissions: { sales_percent_rfbs: 12 },
      acquiring: '0.54',
    }],
  });
  const page = repository.listProducts({ shopId, productIds: ['2001'], pageSize: 20 });
  assert.equal(page.rows[0].commissionPercent, 12);
  assert.equal(page.rows[0].acquiringFeeValue, 0.54);
  assert.equal(page.rows[0].feeJson.acquiring_fee_value, 0.54);
});

test('product support HTTP routes save material and expose it through cache', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_support_http');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 3001, offer_id: 'offer-3001', name: 'HTTP 支撑商品', visibility: 'IN_SALE' }],
    });

    await withServer(db, async (base) => {
      const saved = await (await fetch(`${base}/api/products/material`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shopId, productId: '3001', offerId: 'offer-3001', source: 'supplier-confirmed', weight: 0.4, length: 40, width: 30, height: 20 }),
      })).json();
      assert.equal(saved.ok, true);
      assert.equal(saved.profile.source, 'supplier-confirmed');

      const support = await (await fetch(`${base}/api/products/support?shopId=${encodeURIComponent(shopId)}&productId=3001`)).json();
      assert.equal(support.materialProfiles[0].source, 'supplier-confirmed');

      const cache = await (await fetch(`${base}/api/cache/products?shopId=${encodeURIComponent(shopId)}&productIds=3001&pageSize=20`)).json();
      assert.equal(cache.rows[0].materialProfile.length, '40');
    });
  } finally {
    db.close();
  }
});

test('product summary exposes compact support fields for order and purchase reuse', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_summary_support');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'ARCHIVED',
      rows: [{ product_id: 4001, offer_id: 'offer-4001', sku: 'sku-4001', name: '摘要支撑商品', visibility: 'ARCHIVED' }],
    });
    repository.upsertProductMaterialProfile({
      shopId,
      productId: '4001',
      offerId: 'offer-4001',
      source: 'cross-border-bus',
      weight: 0.45,
      length: 33,
      width: 22,
      height: 11,
      sourceOrderId: 'bus-4001',
    });
    repository.upsertProductSourceLinks({
      shopId,
      productId: '4001',
      offerId: 'offer-4001',
      record: {
        primaryIndex: 0,
        links: [{ link: 'https://yangkeduo.com/goods.html?goods_id=4001', platform: 'PDD', productId: '4001', priceValue: 18.6 }],
      },
    });

    await withServer(db, async (base) => {
      const summary = await (
        await fetch(`${base}/api/products/summary?shopId=${encodeURIComponent(shopId)}&offerIds=offer-4001&pageSize=20`)
      ).json();
      assert.equal(summary.ok, true);
      assert.equal(summary.summaryKind, 'read_service');
      assert.equal(summary.rows.length, 1);
      assert.equal(summary.rows[0].visibility, 'ARCHIVED');
      assert.equal(summary.rows[0].materialProfile.source, 'cross-border-bus');
      assert.equal(summary.rows[0].materialProfile.length, '33');
      assert.equal(summary.rows[0].sourceRecord.links[0].platform, 'PDD');
      assert.equal(summary.rows[0].sourceRecord.links[0].link, 'https://yangkeduo.com/goods.html?goods_id=4001');
      assert.equal(summary.rows[0].weightKg, 0.45);
      assert.equal(summary.rows[0].depthCm, 33);
      assert.equal(Object.prototype.hasOwnProperty.call(summary.rows[0], 'attributes_json'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(summary.rows[0], 'images_json'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(summary.rows[0], 'price_json'), false);
    });
  } finally {
    db.close();
  }
});

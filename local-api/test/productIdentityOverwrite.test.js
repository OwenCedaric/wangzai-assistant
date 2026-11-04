import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductRepository } from '../src/db/repositories/productRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function productRows(prefix, offerVersion) {
  return Array.from({ length: 50 }, (_, index) => {
    const number = index + 1;
    return {
      product_id: `${prefix}-product-${number}`,
      offer_id: `${offerVersion}-offer-${number}`,
      sku: `${offerVersion}-sku-${number}`,
      name: `${offerVersion} product ${number}`,
      visibility: 'IN_SALE',
      price: { price: String(100 + number), currency_code: 'RUB' },
      stocks: { present: number },
    };
  });
}

test('fifty Ozon products overwrite only by shop_id plus product_id when offer ids change', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db);
    const shopA = saveUnitShop(shops, 'shop-product-id-a');
    const shopB = saveUnitShop(shops, 'shop-product-id-b');
    const products = createProductRepository(db);

    const first = products.upsertProducts({
      shopId: shopA,
      rows: productRows('shared', 'old'),
      visibility: 'IN_SALE',
      endpointKey: 'products.list',
    });
    assert.equal(first.inserted, 50);
    assert.equal(first.missingProductId, 0);

    const second = products.upsertProducts({
      shopId: shopA,
      rows: productRows('shared', 'new'),
      visibility: 'IN_SALE',
      endpointKey: 'products.list',
    });
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 50);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ozon_products WHERE shop_id = ?').get(shopA).count, 50);
    assert.equal(
      db.prepare("SELECT COUNT(*) count FROM ozon_products WHERE shop_id = ? AND offer_id LIKE 'new-offer-%'").get(shopA).count,
      50,
    );

    products.upsertProducts({
      shopId: shopB,
      rows: productRows('shared', 'other-shop'),
      visibility: 'IN_SALE',
      endpointKey: 'products.list',
    });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ozon_products WHERE shop_id = ?').get(shopB).count, 50);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ozon_products').get().count, 100);

    const missing = products.upsertProducts({
      shopId: shopA,
      rows: [{ offer_id: 'editable-offer-only', sku: 'editable-sku-only', name: 'must wait for Ozon product id' }],
      visibility: 'IN_SALE',
      endpointKey: 'products.list',
    });
    assert.equal(missing.rows, 0);
    assert.equal(missing.missingProductId, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ozon_products WHERE shop_id = ?').get(shopA).count, 50);

    assert.throws(
      () => db.prepare(`
        INSERT INTO ozon_products (
          id, shop_id, product_key, product_id, name, visibility, sort_index,
          remote_hash, is_stale, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'duplicate', 'IN_SALE', 0, 'hash', 0, ?, ?, ?)
      `).run(
        'duplicate-row',
        shopA,
        'product:duplicate-key',
        'shared-product-1',
        '2026-08-27T00:00:00.000Z',
        '2026-08-27T00:00:00.000Z',
        '2026-08-27T00:00:00.000Z',
      ),
      /UNIQUE constraint failed: ozon_products.shop_id, ozon_products.product_id/u,
    );
  } finally {
    db.close();
  }
});


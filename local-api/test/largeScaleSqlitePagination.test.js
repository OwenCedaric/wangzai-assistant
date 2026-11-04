import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import { createOrderRepository } from '../src/db/repositories/orderRepository.js';
import { createProductCanonicalFactRepository } from '../src/db/repositories/productCanonicalFactRepository.js';
import { createProductRepository } from '../src/db/repositories/productRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

const PRODUCT_COUNT = 10_000;
const ORDER_COUNT = 50_000;
const PAGE_SIZE = 1_000;

function pad(value, width = 6) {
  return String(value).padStart(width, '0');
}

function seedLargeFixture(db, shopId) {
  const timestamp = '2026-07-15T00:00:00.000Z';
  const insertProduct = db.prepare(`
    INSERT INTO ozon_products (
      id, shop_id, product_key, product_id, offer_id, sku, name, visibility,
      sort_index, remote_hash, is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_SALE', ?, ?, 0, ?, ?, ?)
  `);
  const insertOrder = db.prepare(`
    INSERT INTO ozon_orders (
      id, shop_id, order_key, posting_number, order_id, source, status,
      in_process_at, products_json, analytics_json, financial_json, raw_json,
      remote_hash, is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'FBS', 'awaiting_packaging', ?, '[]', '{}', '{}', '{}', ?, 0, ?, ?, ?)
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < PRODUCT_COUNT; index += 1) {
      const key = pad(index);
      insertProduct.run(
        `scale-product-row-${key}`,
        shopId,
        `product-${key}`,
        key,
        `offer-${key}`,
        `sku-${key}`,
        `规模商品 ${key}`,
        index,
        `product-hash-${key}`,
        timestamp,
        timestamp,
        timestamp,
      );
    }
    for (let index = 0; index < ORDER_COUNT; index += 1) {
      const key = pad(index);
      insertOrder.run(
        `scale-order-row-${key}`,
        shopId,
        `order-${key}`,
        `posting-${key}`,
        `order-id-${key}`,
        timestamp,
        `order-hash-${key}`,
        timestamp,
        timestamp,
        timestamp,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

test('10k products and 50k orders stay bounded, stable and complete across SQLite pages', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'shop_large_scale_pagination');
    seedLargeFixture(db, shopId);
    const canonicalFacts = createProductCanonicalFactRepository(db);
    for (let offset = 0; offset < PRODUCT_COUNT; offset += 400) {
      canonicalFacts.projectRows({
        shopId,
        productIds: Array.from(
          { length: Math.min(400, PRODUCT_COUNT - offset) },
          (_, index) => pad(offset + index),
        ),
      });
    }
    const products = createProductRepository(db);
    const orders = createOrderRepository(db);

    const productIds = new Set();
    let maxProductPageMs = 0;
    for (let page = 1; page <= PRODUCT_COUNT / PAGE_SIZE; page += 1) {
      const startedAt = performance.now();
      const result = products.listProducts({ shopId, sort: 'identity', page, pageSize: PAGE_SIZE });
      maxProductPageMs = Math.max(maxProductPageMs, performance.now() - startedAt);
      assert.equal(result.total, PRODUCT_COUNT);
      assert.equal(result.page, page);
      assert.equal(result.offset, (page - 1) * PAGE_SIZE);
      assert.equal(result.rows.length, PAGE_SIZE);
      result.rows.forEach((row) => productIds.add(row.productId));
    }
    assert.equal(productIds.size, PRODUCT_COUNT);
    assert.equal(products.listProducts({ shopId, sort: 'identity', page: 11, pageSize: PAGE_SIZE }).rows.length, 0);
    const productTail = products.listProducts({ shopId, sort: 'identity', offset: 9_990, pageSize: 20 });
    assert.equal(productTail.rows.length, 10);
    assert.equal(productTail.rows[0].productId, '009990');
    assert.ok(maxProductPageMs < 2_000, `product page exceeded bounded latency: ${maxProductPageMs.toFixed(1)}ms`);

    const postingNumbers = new Set();
    let maxOrderPageMs = 0;
    for (let page = 1; page <= ORDER_COUNT / PAGE_SIZE; page += 1) {
      const startedAt = performance.now();
      const result = orders.listOrders({ shopId, page, pageSize: PAGE_SIZE, projection: 'keys' });
      maxOrderPageMs = Math.max(maxOrderPageMs, performance.now() - startedAt);
      assert.equal(result.total, ORDER_COUNT);
      assert.equal(result.page, page);
      assert.equal(result.offset, (page - 1) * PAGE_SIZE);
      assert.equal(result.rows.length, PAGE_SIZE);
      result.rows.forEach((row) => postingNumbers.add(row.postingNumber));
    }
    assert.equal(postingNumbers.size, ORDER_COUNT);
    assert.equal(orders.listOrders({ shopId, page: 51, pageSize: PAGE_SIZE, projection: 'keys' }).rows.length, 0);
    const orderTail = orders.listOrders({ shopId, offset: 49_990, pageSize: 20, projection: 'keys' });
    assert.equal(orderTail.rows.length, 10);
    assert.equal(orderTail.rows[0].postingNumber, 'posting-049990');
    assert.ok(maxOrderPageMs < 2_000, `order page exceeded bounded latency: ${maxOrderPageMs.toFixed(1)}ms`);
  } finally {
    db.close();
  }
});

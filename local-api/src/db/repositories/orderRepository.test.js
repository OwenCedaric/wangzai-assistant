import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createOrderRepository } from './orderRepository.js';
import { createProductRepository } from './productRepository.js';
import { createShopRepository } from './shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';

test('orders repository reuses one scope filter for paged rows and summary counts', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'orders-summary-shop');
    const repository = createOrderRepository(db);
    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [
        { posting_number: 'FBS-1', order_id: '1', status: 'awaiting_packaging', in_process_at: '2026-07-10T10:00:00.000Z' },
        { posting_number: 'FBS-2', order_id: '2', status: 'awaiting_packaging', in_process_at: '2026-07-10T11:00:00.000Z' },
        { posting_number: 'FBS-3', order_id: '3', status: 'delivered', in_process_at: '2026-07-10T12:00:00.000Z' },
      ],
    });
    repository.upsertOrders({
      shopId,
      source: 'FBO',
      rows: [
        { posting_number: 'FBO-1', order_id: '4', status: 'awaiting_packaging', in_process_at: '2026-07-10T13:00:00.000Z' },
      ],
    });

    const query = { shopId, source: 'FBS', since: '2026-07-10T00:00:00.000Z', pageSize: 1, page: 1 };
    const page = repository.listOrders(query);
    const summary = repository.summarizeOrders(query);

    assert.equal(page.total, 3);
    assert.equal(page.rows.length, 1);
    assert.equal(summary.total, 3);
    assert.equal(summary.amountTotal, 0);
    assert.deepEqual(summary.statusCounts, { awaiting_packaging: 2, delivered: 1 });
    assert.deepEqual(summary.fulfillmentCounts, { FBS: 3 });
    assert.deepEqual(summary.salesStatusCounts, { all: 3, '等待备货': 2, '成功订单': 1 });
  } finally {
    db.close();
  }
});

test('orders repository applies sales status scopes and keeps tab summary outside the selected scope', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'orders-status-scope-shop');
    const repository = createOrderRepository(db);
    const now = Date.now();
    repository.upsertOrders({
      shopId,
      rows: [
        { posting_number: 'OVERDUE', order_id: '1', status: 'awaiting_packaging', cutoff_at: new Date(now - 60_000).toISOString(), total_price: 10 },
        { posting_number: 'SOON', order_id: '2', status: 'awaiting_delivery', cutoff_at: new Date(now + 60 * 60 * 1000).toISOString(), total_price: 20 },
        { posting_number: 'LATER', order_id: '3', status: 'awaiting_packaging', cutoff_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(), total_price: 30 },
        { posting_number: 'DONE', order_id: '4', status: 'delivered', total_price: 40 },
      ],
    });

    const overdue = repository.listOrders({ shopId, statusScope: '发货超时', pageSize: 20 });
    const soon = repository.listOrders({ shopId, statusScope: '即将超时', pageSize: 20 });
    const awaiting = repository.listOrders({ shopId, statusScope: '等待备货', pageSize: 20 });
    const summary = repository.summarizeOrders({ shopId });

    assert.deepEqual(overdue.rows.map((row) => row.posting_number), ['OVERDUE']);
    assert.deepEqual(soon.rows.map((row) => row.posting_number), ['SOON']);
    assert.deepEqual(awaiting.rows.map((row) => row.posting_number), ['LATER', 'OVERDUE']);
    assert.equal(summary.total, 4);
    assert.equal(summary.amountTotal, 100);
    assert.deepEqual(summary.salesStatusCounts, {
      all: 4,
      '等待备货': 2,
      '发货超时': 1,
      '等待发货': 1,
      '即将超时': 1,
      '成功订单': 1,
    });
  } finally {
    db.close();
  }
});

test('orders repository applies print-shipping filters before pagination and returns stable facets', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'orders-print-shipping-filter-shop');
    const repository = createOrderRepository(db);
    const now = Date.now();
    repository.upsertOrders({
      shopId,
      rows: [
        {
          posting_number: 'PRINT-1',
          status: 'awaiting_delivery',
          cutoff_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
          tracking_number: 'OZON-TRACK-1',
          carriage_id: 'CARRIAGE-1',
          delivery_method: { warehouse_name: '莫斯科仓', name: 'Ozon Partner Delivery' },
        },
        {
          posting_number: 'PRINT-2',
          status: 'awaiting_delivery',
          cutoff_at: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
          delivery_method: { warehouse_name: '圣彼得堡仓', name: 'Ozon Partner Delivery' },
        },
        {
          posting_number: 'PRINT-3',
          status: 'awaiting_delivery',
          cutoff_at: new Date(now - 60 * 60 * 1000).toISOString(),
          delivery_method: { warehouse_name: '莫斯科仓', name: 'CDEK' },
        },
      ],
    });

    assert.deepEqual(
      repository.listOrders({ warehouse: '莫斯科仓', pageSize: 20 }).rows.map((row) => row.posting_number),
      ['PRINT-1', 'PRINT-3'],
    );
    assert.deepEqual(
      repository.listOrders({ deliveryMethod: 'CDEK', deadlineScope: 'overdue', pageSize: 20 }).rows.map((row) => row.posting_number),
      ['PRINT-3'],
    );
    assert.deepEqual(
      repository.listOrders({ trackingState: 'available', carriageState: 'assigned', pageSize: 20 }).rows.map((row) => row.posting_number),
      ['PRINT-1'],
    );
    assert.equal(repository.listOrders({ trackingState: 'missing', pageSize: 20 }).total, 2);
    assert.equal(repository.listOrders({ carriageState: 'unassigned', pageSize: 20 }).total, 2);
    assert.equal(repository.listOrders({ deadlineScope: 'within24h', pageSize: 20 }).total, 1);
    assert.equal(repository.listOrders({ deadlineScope: 'later', pageSize: 20 }).total, 1);

    assert.deepEqual(repository.listPrintShippingFacets({}), {
      warehouses: [
        { value: '莫斯科仓', total: 2 },
        { value: '圣彼得堡仓', total: 1 },
      ],
      deliveryMethods: [
        { value: 'Ozon Partner Delivery', total: 2 },
        { value: 'CDEK', total: 1 },
      ],
    });
  } finally {
    db.close();
  }
});

test('orders payment and amount migration backfills only persisted Ozon evidence', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'orders-payment-backfill-shop');
    const repository = createOrderRepository(db);
    repository.upsertOrders({
      shopId,
      rows: [{ posting_number: 'BACKFILL-1', order_id: '1', status: 'delivered', paid_at: '2026-07-01T10:00:00.000Z', total_price: 42.5 }],
    });
    db.prepare('UPDATE ozon_orders SET payment_at = NULL, amount_value = NULL WHERE shop_id = ?').run(shopId);
    const migration = readFileSync(resolve('src/db/migrations/038_backfill_orders_payment_and_amount.sql'), 'utf8');
    db.exec(migration);
    const row = db.prepare('SELECT payment_at, amount_value FROM ozon_orders WHERE shop_id = ?').get(shopId);
    assert.equal(row.payment_at, '2026-07-01T10:00:00.000Z');
    assert.equal(row.amount_value, 42.5);
  } finally {
    db.close();
  }
});

test('orders repository calculates product price times quantity when optional total fields are absent', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'orders-product-amount-shop');
    const repository = createOrderRepository(db);
    repository.upsertOrders({
      shopId,
      rows: [{
        posting_number: 'PRODUCT-AMOUNT-1',
        order_id: '1',
        status: 'awaiting_packaging',
        products: [{ price: '357.0000', quantity: 2, currency_code: 'CNY' }],
      }],
    });

    const stored = db.prepare('SELECT amount_value FROM ozon_orders WHERE shop_id = ?').get(shopId);
    const summary = repository.summarizeOrders({ shopId });

    assert.equal(stored.amount_value, 714);
    assert.equal(summary.amountTotal, 714);
  } finally {
    db.close();
  }
});

test('orders repository can attach already-cached product images in the same paged read', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'orders-cached-image-shop');
    createProductRepository(db).upsertProducts({
      shopId,
      rows: [{
        product_id: 'image-product-1',
        offer_id: 'image-offer-1',
        sku: 'image-sku-1',
        name: 'Cached image product',
        images: [
          'https://img.example/image-product-1-main.jpg',
          'https://img.example/image-product-1-extra.jpg',
        ],
      }],
    });
    const repository = createOrderRepository(db);
    repository.upsertOrders({
      shopId,
      rows: [{
        posting_number: 'CACHED-IMAGE-ORDER-1',
        order_id: 'cached-image-order-id-1',
        status: 'delivered',
        products: [{
          product_id: 'image-product-1',
          offer_id: 'image-offer-1',
          sku: 'image-sku-1',
          quantity: 1,
        }],
      }],
    });

    const plain = repository.listOrders({ shopId, pageSize: 20 }).rows[0];
    const imageReady = repository.listOrders({
      shopId,
      pageSize: 20,
      includeProductImages: true,
    }).rows[0];

    assert.equal(plain.products[0].image, undefined);
    assert.equal(imageReady.products[0].primary_image, 'https://img.example/image-product-1-main.jpg');
    assert.deepEqual(imageReady.products[0].images, ['https://img.example/image-product-1-main.jpg']);

    const profitProjection = repository.listOrders({
      shopId,
      pageSize: 20,
      includeProductImages: true,
      projection: 'profit',
    }).rows[0];
    assert.equal(profitProjection.raw, undefined);
    assert.equal(profitProjection.posting_number, 'CACHED-IMAGE-ORDER-1');
  } finally {
    db.close();
  }
});

test('orders amount repair migration replaces the historical false zero from persisted product evidence', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'orders-amount-repair-shop');
    const repository = createOrderRepository(db);
    repository.upsertOrders({
      shopId,
      rows: [{
        posting_number: 'REPAIR-AMOUNT-1',
        order_id: '1',
        status: 'awaiting_packaging',
        products: [{ price: '41.50', quantity: 3, currency_code: 'CNY' }],
      }],
    });
    db.prepare('UPDATE ozon_orders SET amount_value = 0 WHERE shop_id = ?').run(shopId);

    const migration = readFileSync(resolve('src/db/migrations/083_repair_orders_amount_value.sql'), 'utf8');
    db.exec(migration);

    const stored = db.prepare('SELECT amount_value FROM ozon_orders WHERE shop_id = ?').get(shopId);
    assert.equal(stored.amount_value, 124.5);
  } finally {
    db.close();
  }
});

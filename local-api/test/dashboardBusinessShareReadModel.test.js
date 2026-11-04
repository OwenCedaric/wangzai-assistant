import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/createApp.js';
import { createDashboardBusinessShareReadModel } from '../src/domain/dashboard/dashboardBusinessShareReadModel.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

const FIXTURE_TIME = '2026-07-10T10:00:00.000Z';

function insertOrder(db, { shopId, key, status = 'awaiting_packaging', stale = false }) {
  db.prepare(`
    INSERT INTO ozon_orders (
      id, shop_id, order_key, posting_number, order_id, status, in_process_at, payment_at,
      remote_hash, is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `order-${shopId}-${key}`,
    shopId,
    key,
    key,
    `remote-${key}`,
    status,
    FIXTURE_TIME,
    FIXTURE_TIME,
    `hash-${shopId}-${key}`,
    stale ? 1 : 0,
    FIXTURE_TIME,
    FIXTURE_TIME,
    FIXTURE_TIME
  );
}

function insertReturn(
  db,
  {
    shopId,
    key,
    returnId = key,
    postingNumber = '',
    source = 'returns',
    stale = false,
    raw = {},
  }
) {
  db.prepare(`
    INSERT INTO ozon_returns (
      id, shop_id, return_key, return_id, posting_number, source, status,
      created_at_remote, raw_json, remote_hash, is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `return-${shopId}-${key}`,
    shopId,
    key,
    returnId,
    postingNumber || null,
    source,
    'pending',
    FIXTURE_TIME,
    JSON.stringify(raw),
    `return-hash-${shopId}-${key}`,
    stale ? 1 : 0,
    FIXTURE_TIME,
    FIXTURE_TIME,
    FIXTURE_TIME
  );
}

function insertProduct(db, { shopId, key, stock, stale = false }) {
  db.prepare(`
    INSERT INTO ozon_products (
      id, shop_id, product_key, product_id, stock_value, remote_hash,
      is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `product-${shopId}-${key}`,
    shopId,
    key,
    key,
    stock,
    `product-hash-${shopId}-${key}`,
    stale ? 1 : 0,
    FIXTURE_TIME,
    FIXTURE_TIME,
    FIXTURE_TIME
  );
}

function insertPurchaseOverride(
  db,
  { shopId, orderKey, platform = '', purchaseOrderNumber = '', cost = null, status = '', raw = {} }
) {
  db.prepare(`
    INSERT INTO purchase_order_overrides (
      id, shop_id, order_key, posting_number, ozon_order_id, purchase_platform,
      purchase_order_number, source_cost_cny, manual_status, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `override-${shopId}-${orderKey}`,
    shopId,
    orderKey,
    orderKey,
    `remote-${orderKey}`,
    platform || null,
    purchaseOrderNumber || null,
    cost,
    status || null,
    JSON.stringify(raw),
    FIXTURE_TIME,
    FIXTURE_TIME
  );
}

function seedFiveOrderFixture(db) {
  const shopRepository = createShopRepository(db);
  saveUnitShop(shopRepository, 'shop-a');
  saveUnitShop(shopRepository, 'shop-b');

  insertOrder(db, { shopId: 'shop-a', key: 'A-1' });
  insertOrder(db, { shopId: 'shop-a', key: 'A-2' });
  insertOrder(db, { shopId: 'shop-a', key: 'A-3', status: 'awaiting_registration' });
  insertOrder(db, { shopId: 'shop-a', key: 'A-4', status: 'delivered' });
  insertOrder(db, { shopId: 'shop-a', key: 'A-5', status: 'cancelled' });
  insertOrder(db, { shopId: 'shop-a', key: 'A-stale', stale: true });
  insertPurchaseOverride(db, {
    shopId: 'shop-a',
    orderKey: 'A-2',
    platform: '1688',
    purchaseOrderNumber: 'PURCHASE-A-2',
    cost: 20,
    status: '已付款',
  });

  Array.from({ length: 20 }, (_, index) => {
    insertProduct(db, { shopId: 'shop-a', key: `A-${index + 1}`, stock: index === 0 ? 0 : 5 });
  });
  insertProduct(db, { shopId: 'shop-a', key: 'A-stale-zero', stock: 0, stale: true });
  insertReturn(db, { shopId: 'shop-a', key: 'A-return', returnId: 'RETURN-A' });
  insertReturn(db, { shopId: 'shop-a', key: 'A-return-duplicate', returnId: 'RETURN-A' });
  insertReturn(db, { shopId: 'shop-a', key: 'A-return-excluded', raw: { excludeFromAfterSales: true } });
  insertReturn(db, { shopId: 'shop-a', key: 'A-return-stale', stale: true });
}

function seedPurchaseRuleEdges(db) {
  insertOrder(db, { shopId: 'shop-b', key: 'B-1' });
  insertPurchaseOverride(db, {
    shopId: 'shop-b',
    orderKey: 'B-1',
    raw: {
      manualBuyerPlatform: '1688',
      manualPurchaseOrderNo: 'RAW-B-1',
      manualPurchasePriceValue: 25,
      manualPurchaseOrderStatus: '支付成功',
    },
  });

  insertOrder(db, { shopId: 'shop-b', key: 'B-2' });
  insertPurchaseOverride(db, { shopId: 'shop-b', orderKey: 'B-2', platform: '1688' });

  insertOrder(db, { shopId: 'shop-b', key: 'B-3' });
  insertPurchaseOverride(db, {
    shopId: 'shop-b',
    orderKey: 'B-3',
    platform: '1688',
    purchaseOrderNumber: 'PURCHASE-B-3',
    cost: 30,
    status: '已付款',
    raw: { purchaseRecordStatus: 'conflict' },
  });

  insertOrder(db, { shopId: 'shop-b', key: 'B-4', status: 'delivered' });
  insertPurchaseOverride(db, { shopId: 'shop-b', orderKey: 'B-4', raw: { forcePurchaseStatus: '待拍单' } });

  insertOrder(db, { shopId: 'shop-b', key: 'B-5' });
  insertPurchaseOverride(db, {
    shopId: 'shop-b',
    orderKey: 'B-5',
    raw: { forcePurchaseStatus: '已拍单-未操作' },
  });

  insertProduct(db, { shopId: 'shop-b', key: 'B-zero', stock: 0 });
  insertReturn(db, { shopId: 'shop-b', key: 'B-return', returnId: 'RETURN-B' });
}

function fixtureQuery(shopIds) {
  return {
    shopIds,
    salesSince: '2026-07-01T00:00:00.000Z',
    salesTo: '2026-07-31T23:59:59.999Z',
    afterSalesSince: '2026-07-01T00:00:00.000Z',
    afterSalesTo: '2026-07-31T23:59:59.999Z',
  };
}

test('dashboard business share returns the 5-order/20-product aggregate without renderer rows', () => {
  const db = createMigratedTestDb();
  try {
    seedFiveOrderFixture(db);
    const result = createDashboardBusinessShareReadModel({ db }).read({
      ...fixtureQuery('shop-a'),
      page: 1,
      pageSize: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'sqlite');
    assert.deepEqual(result.counts, {
      salesOrderCount: 5,
      pendingPurchaseCount: 2,
      afterSalesTodoCount: 1,
      stockWarningCount: 1,
    });
    assert.equal('rows' in result, false);
  } finally {
    db.close();
  }
});

test('dashboard business share covers raw-only purchase, partial, conflict and forced statuses', () => {
  const db = createMigratedTestDb();
  try {
    seedFiveOrderFixture(db);
    seedPurchaseRuleEdges(db);
    const readModel = createDashboardBusinessShareReadModel({ db });
    assert.deepEqual(readModel.read(fixtureQuery('shop-b')).counts, {
      salesOrderCount: 5,
      pendingPurchaseCount: 2,
      afterSalesTodoCount: 1,
      stockWarningCount: 1,
    });
    assert.deepEqual(readModel.read({ ...fixtureQuery('shop-b,shop-a,shop-a'), pageSize: 1 }).counts, {
      salesOrderCount: 10,
      pendingPurchaseCount: 4,
      afterSalesTodoCount: 2,
      stockWarningCount: 2,
    });
  } finally {
    db.close();
  }
});

test('dashboard business share removes order-cancelled fallbacks without hiding canonical returns', () => {
  const db = createMigratedTestDb();
  try {
    saveUnitShop(createShopRepository(db), 'shop-after-sales');
    insertReturn(db, {
      shopId: 'shop-after-sales',
      key: 'real-child-1',
      returnId: 'RETURN-CHILD-1',
      postingNumber: '123456-789-1',
    });
    insertReturn(db, {
      shopId: 'shop-after-sales',
      key: 'real-child-2',
      returnId: 'RETURN-CHILD-2',
      postingNumber: '123456-789-2',
    });
    insertReturn(db, {
      shopId: 'shop-after-sales',
      key: 'fallback-base',
      returnId: null,
      postingNumber: '123456-789',
      source: 'order-cancelled',
    });
    insertReturn(db, {
      shopId: 'shop-after-sales',
      key: 'real-exact',
      returnId: 'RETURN-EXACT',
      postingNumber: '987654-321-1',
    });
    insertReturn(db, {
      shopId: 'shop-after-sales',
      key: 'fallback-exact',
      returnId: null,
      postingNumber: '987654-321-1',
      source: 'order-cancelled',
    });
    insertReturn(db, {
      shopId: 'shop-after-sales',
      key: 'rfbs-delivered',
      returnId: 'RETURN-RFBS',
      postingNumber: '222222-333-1',
      source: 'rfbs-return',
      raw: { originalOrderStatus: 'delivered' },
    });

    const result = createDashboardBusinessShareReadModel({ db }).read(
      fixtureQuery('shop-after-sales')
    );
    assert.equal(result.ok, true);
    assert.equal(result.counts.afterSalesTodoCount, 4);
  } finally {
    db.close();
  }
});

test('dashboard business share reports empty, oversized and disconnected scopes explicitly', () => {
  const db = createMigratedTestDb();
  try {
    const readModel = createDashboardBusinessShareReadModel({ db });
    assert.deepEqual(readModel.read().counts, {
      salesOrderCount: 0,
      pendingPurchaseCount: 0,
      afterSalesTodoCount: 0,
      stockWarningCount: 0,
    });
    const oversized = readModel.read({ shopIds: Array.from({ length: 101 }, (_, index) => `shop-${index}`).join(',') });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error.code, 'DASHBOARD_BUSINESS_SHARE_SCOPE_TOO_LARGE');
    assert.equal(oversized.scope.shopIds.length, 101);
    assert.equal(createDashboardBusinessShareReadModel().read({ shopIds: 'shop-a' }).ok, false);
  } finally {
    db.close();
  }
});

test('dashboard cache route uses the domain read model and never falls through to the scheduler', async () => {
  const db = createMigratedTestDb();
  let schedulerReadCalls = 0;
  const scheduler = {
    readCache() {
      schedulerReadCalls += 1;
      throw new Error('scheduler fallback must not run');
    },
  };
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: FIXTURE_TIME,
    ozonScheduler: scheduler,
    ozonClient: { async requestReadOnly() { throw new Error('Ozon must not run'); } },
  });
  try {
    seedFiveOrderFixture(db);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const query = new URLSearchParams(fixtureQuery('shop-a'));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/cache/dashboard-business-share?${query}`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.counts, {
      salesOrderCount: 5,
      pendingPurchaseCount: 2,
      afterSalesTodoCount: 1,
      stockWarningCount: 1,
    });
    assert.equal(schedulerReadCalls, 0);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

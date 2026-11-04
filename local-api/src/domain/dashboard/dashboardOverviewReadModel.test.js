import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createDashboardOverviewReadModel } from './dashboardOverviewReadModel.js';

const SHOP_ID = 'shop-dashboard-a';

function insertOrder(db, {
  id,
  status = 'awaiting_packaging',
  paymentAt,
  products = [],
  postingNumber = id,
  raw = {},
}) {
  db.prepare(`
    INSERT INTO ozon_orders (
      id, shop_id, order_key, posting_number, order_id, status, payment_at,
      products_json, analytics_json, financial_json, raw_json, remote_hash,
      is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?, 0, ?, ?, ?)
  `).run(
    id,
    SHOP_ID,
    `key-${id}`,
    postingNumber,
    `order-${id}`,
    status,
    paymentAt,
    JSON.stringify(products),
    JSON.stringify(raw),
    `hash-${id}`,
    paymentAt,
    paymentAt,
    paymentAt
  );
}

function insertProduct(db, { id, visibility, statusLabel = '', stock, stockJson }) {
  const timestamp = '2026-08-13T05:00:00.000Z';
  db.prepare(`
    INSERT INTO ozon_products (
      id, shop_id, product_key, product_id, offer_id, sku, name, visibility,
      status_label, snapshot_visibilities_json, price_value, currency_code,
      stock_value, raw_json, stock_json, remote_hash, is_stale, last_seen_at,
      created_at, updated_at, stocks_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 99, 'CNY', ?, '{}', ?, ?, 0, ?, ?, ?, ?)
  `).run(
    id,
    SHOP_ID,
    `product-${id}`,
    id,
    `offer-${id}`,
    `sku-${id}`,
    `商品-${id}`,
    visibility,
    statusLabel,
    JSON.stringify([visibility]),
    stock,
    stockJson === undefined ? '' : JSON.stringify(stockJson),
    `hash-${id}`,
    timestamp,
    timestamp,
    timestamp,
    timestamp
  );
}

function insertReturn(db, { id, status, occurredAt }) {
  db.prepare(`
    INSERT INTO ozon_returns (
      id, shop_id, return_key, return_id, posting_number, order_id, status,
      created_at_remote, product_json, finance_json, raw_json, remote_hash,
      is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', '{}', ?, 0, ?, ?, ?)
  `).run(
    id,
    SHOP_ID,
    `return-key-${id}`,
    `return-${id}`,
    `posting-${id}`,
    `order-return-${id}`,
    status,
    occurredAt,
    `hash-return-${id}`,
    occurredAt,
    occurredAt,
    occurredAt
  );
}

function metric(payload, id) {
  return payload.metrics[id];
}

test('dashboard overview uses accurate period/current-state semantics and returns no raw rows', () => {
  const db = createMigratedTestDb();
  const timestamp = '2026-08-13T05:00:00.000Z';
  db.prepare(`
    INSERT INTO shops (id, name, alias, client_id, status, created_at, updated_at)
    VALUES (?, 'Dashboard Shop', 'Ozon A店', 'client-dashboard-a', 'active', ?, ?)
  `).run(SHOP_ID, timestamp, timestamp);

  insertOrder(db, {
    id: 'today-effective',
    paymentAt: '2026-08-12T18:30:00.000Z',
    products: [{ name: '保温杯', offer_id: 'offer-cup', quantity: 2, price: 100, currency_code: 'CNY' }],
    raw: { buyer: { name: '不应返回的人名', phone: '13800000000' } },
  });
  insertOrder(db, {
    id: 'today-cancelled',
    status: 'cancelled',
    paymentAt: '2026-08-12T20:00:00.000Z',
    products: [{ name: '已取消商品', offer_id: 'offer-cancelled', quantity: 1, price: 50, currency_code: 'CNY' }],
  });
  insertOrder(db, {
    id: 'old-order',
    status: 'delivered',
    paymentAt: '2026-08-01T02:00:00.000Z',
    products: [{ name: '历史商品', offer_id: 'offer-old', quantity: 1, price: 20, currency_code: 'CNY' }],
  });

  insertProduct(db, { id: 'zero-live', visibility: 'IN_SALE', stock: 0, stockJson: { present: 0 } });
  insertProduct(db, { id: 'low-live', visibility: 'IN_SALE', stock: 4, stockJson: { present: 4 } });
  insertProduct(db, { id: 'archived-zero', visibility: 'ARCHIVED', stock: 0, stockJson: { present: 0 } });
  insertProduct(db, {
    id: 'validation-zero',
    visibility: 'VALIDATION_ERROR',
    statusLabel: 'VALIDATION_ERROR',
    stock: 0,
    stockJson: { present: 0 },
  });
  insertProduct(db, { id: 'unknown-zero', visibility: 'UNKNOWN', stock: 0, stockJson: { present: 0 } });

  insertReturn(db, { id: 'processing', status: 'Utilizing', occurredAt: '2026-08-12T19:00:00.000Z' });
  insertReturn(db, { id: 'finished', status: 'Utilized', occurredAt: '2026-08-12T19:30:00.000Z' });

  const profitSnapshot = {
    rows: [
      {
        ledgerKey: `${SHOP_ID}:today-effective`,
        shopId: SHOP_ID,
        orderSnapshot: { paymentDate: '2026-08-12T18:30:00.000Z' },
        results: { actualProfitCny: { status: 'ready', value: 30 } },
      },
      {
        ledgerKey: `${SHOP_ID}:today-cancelled`,
        shopId: SHOP_ID,
        orderSnapshot: { paymentDate: '2026-08-12T20:00:00.000Z' },
        results: { actualProfitCny: { status: 'pending', value: null } },
      },
    ],
    updatedAt: timestamp,
  };
  db.prepare(`
    INSERT INTO profit_ledger_snapshots (
      snapshot_key, logical_scope, cache_group, calculation_version,
      snapshot_json, fetched_at, updated_at, created_at
    ) VALUES (?, ?, 'dashboard-test', 'v1', ?, ?, ?, ?)
  `).run('dashboard-ledger', SHOP_ID, JSON.stringify(profitSnapshot), timestamp, timestamp, timestamp);

  const payload = createDashboardOverviewReadModel({ db }).read({
    shopIds: SHOP_ID,
    startDate: '2026-08-13',
    endDate: '2026-08-13',
  });

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.scope.shopIds, [SHOP_ID]);
  assert.equal(metric(payload, 'orderCount').value, 2);
  assert.equal(metric(payload, 'effectiveOrderCount').value, 1);
  assert.equal(metric(payload, 'cancelledCount').value, 1);
  assert.equal(metric(payload, 'salesAmount').value, 200);
  assert.equal(metric(payload, 'salesAmount').currency, 'CNY');
  assert.equal(metric(payload, 'averageOrderValue').value, 200);
  assert.equal(payload.currentTasks.pendingPurchaseCount, 1);
  assert.equal(payload.currentTasks.waitingDeliveryCount, 1);
  assert.equal(payload.currentTasks.afterSalesTodoCount, 1);
  assert.equal(payload.currentTasks.stockWarningCount, 2);
  assert.equal(payload.currentTasks.productIssueCount, 1);
  assert.deepEqual(payload.shopPerformance[0].currentTasks, {
    pendingPurchaseCount: 1,
    waitingDeliveryCount: 1,
    afterSalesTodoCount: 1,
    stockWarningCount: 2,
    total: 5,
  });
  assert.equal(metric(payload, 'outOfStockCount').value, 1);
  assert.equal(metric(payload, 'lowStockCount').value, 1);
  assert.equal(metric(payload, 'actualNetProfit').value, 30);
  assert.equal(payload.latestOrders.some((row) => row.id === 'old-order'), true);
  assert.equal(payload.dataPolicy.stockWarningsExcludeArchivedAndValidationFailed, true);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /不应返回的人名|13800000000|products_json|raw_json|financial_json/u);
  db.close();
});

test('dashboard overview fails closed for unknown shops and oversized scopes', () => {
  const db = createMigratedTestDb();
  const model = createDashboardOverviewReadModel({ db });
  const unknown = model.read({ shopIds: 'missing-shop', startDate: '2026-08-13', endDate: '2026-08-13' });
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.scope.shopIds, []);

  const oversized = model.read({ shopIds: Array.from({ length: 101 }, (_value, index) => `shop-${index}`) });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'DASHBOARD_OVERVIEW_SCOPE_TOO_LARGE');
  db.close();
});

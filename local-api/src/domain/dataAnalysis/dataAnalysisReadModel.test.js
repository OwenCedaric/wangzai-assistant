import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDataAnalysisReadModel } from './dataAnalysisReadModel.js';

test('reads the matching SQLite profit ledger automatically for the selected shop and date range', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE profit_ledger_snapshots (
      snapshot_key TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      fetched_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  const snapshot = {
    rows: [
      {
        ledgerKey: 'shop-a:order-1',
        shopId: 'shop-a',
        orderSnapshot: { paymentDate: '2026-07-10T02:00:00Z' },
        results: { actualProfitCny: { status: 'ready', value: 18.5 } },
      },
      {
        ledgerKey: 'shop-b:order-2',
        shopId: 'shop-b',
        orderSnapshot: { paymentDate: '2026-07-10T02:00:00Z' },
        results: { actualProfitCny: { status: 'ready', value: 99 } },
      },
      {
        ledgerKey: 'shop-a:old-order',
        shopId: 'shop-a',
        orderSnapshot: { paymentDate: '2026-06-01T02:00:00Z' },
        results: { actualProfitCny: { status: 'ready', value: 50 } },
      },
    ],
    updatedAt: '2026-07-20T12:00:00.000Z',
  };
  db.prepare(`
    INSERT INTO profit_ledger_snapshots (snapshot_key, snapshot_json, fetched_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('ledger:shop-a', JSON.stringify(snapshot), snapshot.updatedAt, snapshot.updatedAt);

  const dashboard = createDataAnalysisReadModel(db).build({
    shopId: 'shop-a',
    startDate: '2026-07-01',
    endDate: '2026-07-21',
  });
  const source = dashboard.sources.find((item) => item.id === 'profit-ledger');
  const metricById = new Map(dashboard.finance.metrics.map((item) => [item.id, item]));

  assert.equal(source.status, 'ready');
  assert.equal(source.rowCount, 1);
  assert.equal(metricById.get('actualNetProfit').value, 18.5);
  assert.equal(metricById.get('actualNetProfit').status, 'confirmed');
  assert.equal(metricById.get('actualNetProfitCoverage').value, 100);

  const allShopsDashboard = createDataAnalysisReadModel(db).build({
    shopId: '',
    startDate: '2026-07-01',
    endDate: '2026-07-21',
  });
  const allShopsSource = allShopsDashboard.sources.find((item) => item.id === 'profit-ledger');
  const allShopsMetricById = new Map(allShopsDashboard.finance.metrics.map((item) => [item.id, item]));

  assert.equal(allShopsSource.rowCount, 2);
  assert.equal(allShopsMetricById.get('actualNetProfit').value, 117.5);
  assert.equal(allShopsMetricById.get('actualNetProfitCoverage').value, 100);
  db.close();
});

test('aggregates only the declared active shops and keeps same-SKU rankings shop-scoped', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE shops (id TEXT PRIMARY KEY, client_id TEXT, name TEXT, alias TEXT, status TEXT);
    CREATE TABLE ozon_orders (
      id TEXT PRIMARY KEY, shop_id TEXT, order_key TEXT, posting_number TEXT, order_id TEXT,
      source TEXT, status TEXT, substatus TEXT, fulfillment TEXT, in_process_at TEXT, shipment_date TEXT,
      products_json TEXT, analytics_json TEXT, financial_json TEXT, is_stale INTEGER,
      last_seen_at TEXT, created_at TEXT, updated_at TEXT
    );
  `);
  const shops = [
    ['shop-a', 'client-a', 'A', '一店', 'active'],
    ['shop-b', 'client-b', 'B', '二店', 'active'],
    ['shop-c', 'client-c', 'C', '三店', 'active'],
    ['shop-old', 'client-old', 'Old', '旧店', 'inactive'],
  ];
  const insertShop = db.prepare('INSERT INTO shops VALUES (?, ?, ?, ?, ?)');
  shops.forEach((row) => insertShop.run(...row));
  const insertOrder = db.prepare(`INSERT INTO ozon_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  shops.forEach(([shopId], index) => insertOrder.run(
    `order-${index}`, shopId, `key-${index}`, `posting-${index}`, `oid-${index}`, 'FBS', 'delivered', '', 'FBS',
    '2026-08-10T12:00:00Z', '', JSON.stringify([{ sku: 'SAME-SKU', offer_id: 'SAME-OFFER', name: '同款商品', quantity: 1, price: 100, currency_code: 'CNY' }]),
    '{}', '{}', 0, '2026-08-11T00:00:00Z', '2026-08-10T12:00:00Z', '2026-08-11T00:00:00Z'
  ));
  const dashboard = createDataAnalysisReadModel(db).build({
    shopIds: 'shop-a,shop-b,shop-c',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
  });
  const orderCount = dashboard.sales.metrics.find((metric) => metric.id === 'orderCount');
  assert.equal(orderCount.value, 3);
  assert.equal(dashboard.sales.shopRanking.length, 3);
  assert.equal(dashboard.sales.productRanking.length, 3);
  assert.deepEqual(dashboard.dataQuality.expectedShopIds, ['shop-a', 'shop-b', 'shop-c']);
  assert.equal(dashboard.dataQuality.shopRows.every((row) => row.orderRows === 1), true);
  assert.equal(dashboard.dataQuality.reconciliation.status, 'matched');
  db.close();
});

test('all-shop traffic trend returns one summed point per business date', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE shops (id TEXT PRIMARY KEY, client_id TEXT, name TEXT, alias TEXT, status TEXT);
    CREATE TABLE ozon_analytics_daily (
      id TEXT PRIMARY KEY, shop_id TEXT, report_date TEXT, revenue_rub REAL, ordered_units INTEGER,
      product_views INTEGER, cart_adds INTEGER, visitor_sessions INTEGER, metric_signature TEXT,
      raw_metrics_json TEXT, is_stale INTEGER, last_seen_at TEXT, created_at TEXT, updated_at TEXT
    );
    INSERT INTO shops VALUES
      ('shop-a', 'client-a', 'A', '一店', 'active'),
      ('shop-b', 'client-b', 'B', '二店', 'active');
    INSERT INTO ozon_analytics_daily VALUES
      ('a-0803', 'shop-a', '2026-08-03', 10, 2, 100, 5, 40, 'metrics', '{"sourceCurrency":"RUB"}', 0, '2026-08-04', '2026-08-04', '2026-08-04'),
      ('b-0803', 'shop-b', '2026-08-03', 20, 3, 200, 7, 60, 'metrics', '{"sourceCurrency":"RUB"}', 0, '2026-08-04', '2026-08-04', '2026-08-04'),
      ('a-0804', 'shop-a', '2026-08-04', 15, 1, 90, 4, 35, 'metrics', '{"sourceCurrency":"RUB"}', 0, '2026-08-05', '2026-08-05', '2026-08-05'),
      ('b-0804', 'shop-b', '2026-08-04', 25, 4, 210, 8, 65, 'metrics', '{"sourceCurrency":"RUB"}', 0, '2026-08-05', '2026-08-05', '2026-08-05');
  `);

  const dashboard = createDataAnalysisReadModel(db).build({
    startDate: '2026-08-03',
    endDate: '2026-08-04',
  });

  assert.equal(dashboard.traffic.rowCount, 4);
  assert.equal(dashboard.traffic.dailyTrend.length, 2);
  assert.deepEqual(dashboard.traffic.dailyTrend, [
    {
      date: '2026-08-03',
      visitorSessions: 100,
      productViews: 300,
      cartAdds: 12,
      orderedUnits: 5,
      matchedOrderCount: 0,
      revenueRub: 30,
      revenueCurrency: 'RUB',
    },
    {
      date: '2026-08-04',
      visitorSessions: 100,
      productViews: 300,
      cartAdds: 12,
      orderedUnits: 5,
      matchedOrderCount: 0,
      revenueRub: 40,
      revenueCurrency: 'RUB',
    },
  ]);
  assert.deepEqual(dashboard.traffic.coverage, {
    startDate: '2026-08-03',
    endDate: '2026-08-04',
    dayCount: 2,
    continuous: true,
  });
  db.close();
});

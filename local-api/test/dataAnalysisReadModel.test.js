import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDataAnalysisService } from '../src/domain/dataAnalysis/dataAnalysisService.js';

function createBusinessTestDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../src/db/migrations/032_create_data_analysis_cache_tables.sql', import.meta.url), 'utf8'));
  db.exec(`
    CREATE TABLE ozon_orders (
      id TEXT, shop_id TEXT, order_key TEXT, posting_number TEXT, order_id TEXT, source TEXT,
      status TEXT, substatus TEXT, fulfillment TEXT, in_process_at TEXT, shipment_date TEXT,
      products_json TEXT, analytics_json TEXT, financial_json TEXT, is_stale INTEGER,
      last_seen_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE ozon_products (
      id TEXT, shop_id TEXT, product_id TEXT, offer_id TEXT, sku TEXT, name TEXT, visibility TEXT,
      status_label TEXT, snapshot_visibilities_json TEXT, category_id TEXT, category_name TEXT, type_id TEXT,
      price_value REAL, currency_code TEXT,
      stock_value INTEGER, raw_json TEXT, price_json TEXT, stock_json TEXT, fee_json TEXT,
      is_stale INTEGER, last_seen_at TEXT, updated_at TEXT, detail_synced_at TEXT,
      prices_synced_at TEXT, stocks_synced_at TEXT, hydrated_at TEXT
    );
    CREATE TABLE ozon_finance_transactions (
      id TEXT, shop_id TEXT, operation_key TEXT, operation_id TEXT, posting_number TEXT, order_id TEXT,
      operation_type TEXT, operation_type_name TEXT, transaction_type TEXT, operation_date TEXT,
      amount_total REAL, acquiring_fee_cny REAL, sale_commission_cny REAL, delivery_fee_cny REAL,
      currency_code TEXT, services_json TEXT, is_stale INTEGER, last_seen_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE ozon_returns (
      id TEXT, shop_id TEXT, return_key TEXT, return_id TEXT, posting_number TEXT, order_id TEXT,
      source TEXT, status TEXT, substatus TEXT, return_reason TEXT, decision TEXT, created_at_remote TEXT,
      updated_at_remote TEXT, product_json TEXT, finance_json TEXT, raw_json TEXT, is_stale INTEGER,
      last_seen_at TEXT, created_at TEXT, updated_at TEXT, refund_status TEXT, refund_time TEXT, refund_json TEXT
    );
    CREATE TABLE ozon_marketing_activities (
      id INTEGER, shop_id TEXT, activity_id TEXT, source_type TEXT, source_label TEXT, source_tone TEXT, title TEXT,
      original_title TEXT, joined_count INTEGER, available_count INTEGER, has_available_count INTEGER,
      estimate TEXT, date_start TEXT, date_end TEXT, raw_json TEXT, remote_hash TEXT, first_seen_at TEXT, last_seen_at TEXT, updated_at TEXT
    );
    CREATE TABLE ozon_marketing_activity_products (
      id INTEGER, shop_id TEXT, activity_id TEXT, source_type TEXT, product_id TEXT, offer_id TEXT,
      sku TEXT, ozon_sku TEXT, row_status TEXT, source_activity_price TEXT, activity_price TEXT, price TEXT, stock TEXT,
      raw_json TEXT, last_seen_at TEXT, updated_at TEXT, name TEXT, is_stale INTEGER
    );
    CREATE TABLE purchase_order_overrides (
      id TEXT, shop_id TEXT, order_key TEXT, posting_number TEXT, ozon_order_id TEXT, offer_id TEXT,
      sku TEXT, purchase_platform TEXT, purchase_order_number TEXT, source_cost_cny REAL,
      manual_status TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE cross_border_order_records (
      id TEXT, shop_id TEXT, record_key TEXT, order_id TEXT, platform_order TEXT,
      purchase_order_number TEXT, offer_id TEXT, sku TEXT, status TEXT, read_status TEXT,
      package_weight_kg REAL, length_cm REAL, width_cm REAL, height_cm REAL,
      last_seen_at TEXT, updated_at TEXT
    );
    CREATE TABLE performance_accounts (
      id TEXT, shop_id TEXT, status TEXT, last_test_at TEXT, last_test_message TEXT, updated_at TEXT
    );
  `);
  return db;
}

function insertOrder(db, { id, postingNumber, status, date, price }) {
  db.prepare(`
    INSERT INTO ozon_orders (
      id, shop_id, order_key, posting_number, status, fulfillment, in_process_at,
      products_json, updated_at
    ) VALUES (?, 'shop-1', ?, ?, ?, 'FBS', ?, ?, '2026-07-10T01:00:00Z')
  `).run(
    id,
    id,
    postingNumber,
    status,
    date,
    JSON.stringify([{ offer_id: `offer-${id}`, sku: `sku-${id}`, name: `商品${id}`, price, quantity: 1, currency_code: 'CNY' }])
  );
}

test('data analysis read model returns source-traceable business metrics without fake traffic or profit', () => {
  const db = createBusinessTestDatabase();
  try {
    insertOrder(db, { id: '1', postingNumber: 'p1', status: 'delivered', date: '2026-07-02T01:00:00Z', price: 100 });
    insertOrder(db, { id: '2', postingNumber: 'p2', status: 'cancelled', date: '2026-07-03T01:00:00Z', price: 50 });
    insertOrder(db, { id: '3', postingNumber: 'p3', status: 'delivered', date: '2026-06-25T01:00:00Z', price: 40 });

    db.prepare(`
      INSERT INTO ozon_products (
        id, shop_id, product_id, offer_id, sku, name, visibility, price_value, currency_code,
        stock_value, updated_at, stocks_synced_at, prices_synced_at
      ) VALUES
        ('prod-1', 'shop-1', '1', 'offer-1', 'sku-1', '在售缺货商品', 'ALL', 100, 'CNY', 0, '2026-07-10', '2026-07-10', '2026-07-10'),
        ('prod-2', 'shop-1', '2', 'offer-2', 'sku-2', '归档商品', 'ARCHIVED', 50, 'CNY', 0, '2026-07-10', '2026-07-10', '2026-07-10')
    `).run();
    db.prepare(`
      INSERT INTO ozon_finance_transactions (
        id, shop_id, operation_key, operation_id, posting_number, operation_type, operation_date,
        amount_total, updated_at
      ) VALUES
        ('f1', 'shop-1', 'f1', 'f1', 'p1', 'Sale', '2026-07-02', 80, '2026-07-10'),
        ('f2', 'shop-1', 'f2', 'f2', '', 'Fee', '2026-07-02', -10, '2026-07-10')
    `).run();
    db.prepare(`
      INSERT INTO ozon_returns (
        id, shop_id, return_key, return_id, posting_number, status, created_at_remote,
        product_json, raw_json, updated_at
      ) VALUES ('r1', 'shop-1', 'r1', 'r1', 'p1', 'Utilizing', '2026-07-04', ?, ?, '2026-07-10')
    `).run(
      JSON.stringify({ name: '退货商品', price: 30, currency_code: 'CNY', offer_id: 'offer-1' }),
      JSON.stringify({ return_reason: { id: 7, is_defect: true } })
    );
    db.prepare(`
      INSERT INTO purchase_order_overrides (
        id, shop_id, order_key, posting_number, source_cost_cny, updated_at
      ) VALUES ('po1', 'shop-1', '1', 'p1', 20, '2026-07-10')
    `).run();
    db.prepare(`
      INSERT INTO performance_accounts (id, shop_id, status, last_test_at, last_test_message, updated_at)
      VALUES ('perf-1', 'shop-1', 'active', '2026-07-09', '只读测试通过', '2026-07-09')
    `).run();

    const service = createDataAnalysisService({ db });
    const result = service.readCache({ shopId: 'shop-1', startDate: '2026-07-01', endDate: '2026-07-10' });
    const overviewMetrics = new Map(result.dashboard.overview.metrics.map((metric) => [metric.id, metric]));
    const salesMetrics = new Map(result.dashboard.sales.metrics.map((metric) => [metric.id, metric]));
    const financeMetrics = new Map(result.dashboard.finance.metrics.map((metric) => [metric.id, metric]));
    const afterSalesMetrics = new Map(result.dashboard.afterSales.metrics.map((metric) => [metric.id, metric]));
    const productMetrics = new Map(result.dashboard.products.metrics.map((metric) => [metric.id, metric]));

    assert.equal(result.ok, true);
    assert.equal(salesMetrics.get('orderCount').value, 2);
    assert.equal(salesMetrics.get('effectiveOrderCount').value, 1);
    assert.equal(overviewMetrics.get('salesAmount').value, 100);
    assert.equal(overviewMetrics.get('salesAmount').currency, 'CNY');
    assert.equal(overviewMetrics.get('salesAmount').source.id, 'orders');
    assert.equal(productMetrics.get('outOfStockCount').value, 1);
    assert.equal(afterSalesMetrics.get('returnCount').value, 1);
    assert.equal(financeMetrics.get('confirmedPurchaseCost').value, 20);
    assert.equal(financeMetrics.get('purchaseCostCoverage').value, 100);
    assert.equal(financeMetrics.get('actualNetProfit').value, null);
    assert.equal(financeMetrics.get('actualNetProfit').status, 'insufficient_sources');
    assert.equal(result.dashboard.modules.find((item) => item.id === 'traffic').status, 'not_synced');
    assert.equal(result.dashboard.modules.find((item) => item.id === 'advertising').status, 'live_ready');
    assert.equal(result.dashboard.dataPolicy.fakeDataAllowed, false);
    assert.equal(JSON.stringify(result.dashboard).includes('customer_email'), false);
  } finally {
    db.close();
  }
});

test('data analysis scopes Performance account readiness by bound shop and excludes unbound credentials', () => {
  const db = createBusinessTestDatabase();
  try {
    db.prepare(`
      INSERT INTO performance_accounts (id, shop_id, status, last_test_at, last_test_message, updated_at)
      VALUES
        ('perf-shop-1', 'shop-1', 'active', '2026-07-09', 'shop 1 ready', '2026-07-09'),
        ('perf-shop-2', 'shop-2', 'active', '2026-07-10', 'shop 2 ready', '2026-07-10'),
        ('perf-unbound', NULL, 'active', '2026-07-11', 'must not be guessed', '2026-07-11')
    `).run();
    const service = createDataAnalysisService({ db });

    const shopOne = service.readCache({ shopId: 'shop-1', startDate: '2026-07-01', endDate: '2026-07-10' });
    const shopTwo = service.readCache({ shopId: 'shop-2', startDate: '2026-07-01', endDate: '2026-07-10' });
    const all = service.readCache({ startDate: '2026-07-01', endDate: '2026-07-10' });

    expectPerformanceSource(shopOne, { rowCount: 1, status: 'live_ready' });
    expectPerformanceSource(shopTwo, { rowCount: 1, status: 'live_ready' });
    expectPerformanceSource(all, { rowCount: 2, status: 'live_ready' });
  } finally {
    db.close();
  }
});

function expectPerformanceSource(payload, expected) {
  const source = payload.dashboard.sources.find((item) => item.id === 'performance');
  assert.equal(source.rowCount, expected.rowCount);
  assert.equal(source.status, expected.status);
}

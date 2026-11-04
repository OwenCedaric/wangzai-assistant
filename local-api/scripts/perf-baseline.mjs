import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { initializeDatabase } from '../src/db/database.js';
import { createOrderRepository } from '../src/db/repositories/orderRepository.js';
import { createProductRepository } from '../src/db/repositories/productRepository.js';

const PRODUCT_ROWS = Math.max(1, Number.parseInt(process.env.LOCAL_API_PERF_PRODUCTS || '10000', 10) || 10000);
const ORDER_ROWS = Math.max(1, Number.parseInt(process.env.LOCAL_API_PERF_ORDERS || '50000', 10) || 50000);
const RUNS = Math.max(3, Number.parseInt(process.env.LOCAL_API_PERF_RUNS || '10', 10) || 10);
const PAGE_SIZE = 100;
const PAGE_P95_BUDGET_MS = 250;
const REPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)] || 0;
}

function measure(action) {
  const samples = [];
  let result;
  for (let index = 0; index < RUNS; index += 1) {
    const startedAt = performance.now();
    result = action(index);
    samples.push(performance.now() - startedAt);
  }
  return {
    rows: Array.isArray(result?.rows) ? result.rows.length : 0,
    total: Number(result?.total) || 0,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
    samplesMs: samples.map((value) => Math.round(value * 100) / 100),
  };
}

function planDetails(db, sql, ...params) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => String(row.detail || ''));
}

function hasTempSort(plan = []) {
  return plan.some((detail) => /TEMP B-TREE/i.test(detail));
}

function isoNow() {
  return new Date().toISOString();
}

function pruneOldReports(directory) {
  if (!process.env.LOCAL_API_PERF_REPORT) {
    const cutoff = Date.now() - REPORT_RETENTION_MS;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const target = join(directory, entry.name);
      if (statSync(target).mtimeMs < cutoff) unlinkSync(target);
    }
  }
}

function seedFixture(db, shopId) {
  const timestamp = isoNow();
  db.prepare(`
    INSERT INTO shops (id, name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(shopId, 'Performance Fixture Shop', 'active', timestamp, timestamp);
  const product = db.prepare(`
    INSERT INTO ozon_products (
      id, shop_id, product_key, product_id, offer_id, sku, name, visibility, status_label,
      price_value, currency_code, stock_value, sort_index, remote_hash, is_stale,
      last_seen_at, created_at, updated_at, snapshot_visibilities_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);
  const order = db.prepare(`
    INSERT INTO ozon_orders (
      id, shop_id, order_key, posting_number, order_id, source, status, fulfillment,
      in_process_at, products_json, analytics_json, financial_json, raw_json, remote_hash,
      is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < PRODUCT_ROWS; index += 1) {
      const identity = String(index + 1).padStart(6, '0');
      product.run(
        `perf-product-${identity}`,
        shopId,
        `product-${identity}`,
        `product-${identity}`,
        `offer-${identity}`,
        `sku-${identity}`,
        `Fixture Product ${identity}`,
        'IN_SALE',
        '出售中',
        100 + (index % 37),
        'RUB',
        index % 50,
        index,
        `hash-product-${identity}`,
        timestamp,
        timestamp,
        timestamp,
        '["IN_SALE"]'
      );
    }
    for (let index = 0; index < ORDER_ROWS; index += 1) {
      const identity = String(index + 1).padStart(7, '0');
      const orderTimestamp = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      order.run(
        `perf-order-${identity}`,
        shopId,
        `order-${identity}`,
        `posting-${identity}`,
        `order-id-${identity}`,
        'FBS',
        'awaiting_packaging',
        'FBS',
        orderTimestamp,
        '[]',
        '{}',
        '{}',
        '{}',
        `hash-order-${identity}`,
        timestamp,
        timestamp,
        timestamp
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const root = mkdtempSync(join(tmpdir(), 'wangzai-local-api-perf-'));
const databasePath = join(root, 'performance.sqlite');
const defaultReportDirectory = join(tmpdir(), 'wangzai-local-api-perf-reports');
mkdirSync(defaultReportDirectory, { recursive: true });
pruneOldReports(defaultReportDirectory);
const outputPath = process.env.LOCAL_API_PERF_REPORT
  ? process.env.LOCAL_API_PERF_REPORT
  : join(defaultReportDirectory, `performance-baseline-${Date.now()}.json`);
let db;
try {
  ({ db } = initializeDatabase({ database: { path: databasePath, enableWal: true, busyTimeoutMs: 5000 } }));
  const shopId = 'shop-performance-fixture';
  seedFixture(db, shopId);
  const products = createProductRepository(db);
  const orders = createOrderRepository(db);
  const productPage = measure(() => products.listProducts({ shopId, page: 50, pageSize: PAGE_SIZE }));
  const orderPage = measure(() => orders.listOrders({ shopId, page: 250, pageSize: PAGE_SIZE }));
  const productPlan = planDetails(db, `
    SELECT id FROM ozon_products
    WHERE is_stale = 0 AND shop_id = ?
    ORDER BY sort_index ASC, product_id ASC, offer_id ASC, updated_at DESC
    LIMIT ? OFFSET ?
  `, shopId, PAGE_SIZE, 4900);
  const orderPlan = planDetails(db, `
    SELECT id FROM ozon_orders
    WHERE is_stale = 0 AND shop_id = ?
    ORDER BY COALESCE(in_process_at, updated_at) DESC, posting_number ASC, order_id ASC, id ASC
    LIMIT ? OFFSET ?
  `, shopId, PAGE_SIZE, 24_900);
  const report = {
    scenario: 'local-api-paginated-cache-baseline',
    createdAt: isoNow(),
    dataset: { shops: 1, products: PRODUCT_ROWS, orders: ORDER_ROWS },
    runs: RUNS,
    budget: { pageP95Ms: PAGE_P95_BUDGET_MS, tempSortAllowed: false },
    products: productPage,
    orders: orderPage,
    queryPlans: { products: productPlan, orders: orderPlan },
    memoryRssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100,
  };
  report.result = productPage.p95Ms <= PAGE_P95_BUDGET_MS
    && orderPage.p95Ms <= PAGE_P95_BUDGET_MS
    && !hasTempSort(productPlan)
    && !hasTempSort(orderPlan)
    ? 'pass'
    : 'fail';
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...report, reportPath: outputPath }, null, 2)}\n`);
  if (report.result !== 'pass') process.exitCode = 1;
} finally {
  db?.close();
  rmSync(root, { recursive: true, force: true });
}

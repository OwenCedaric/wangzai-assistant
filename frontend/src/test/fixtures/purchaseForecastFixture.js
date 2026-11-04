import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeOzonSalesRowToPurchaseOrder } from '../../services/purchaseOrderRuntime.js';
import { getPurchaseOperationInitialFields } from '../../services/purchaseCrossBorderRuntime.js';

export function createPurchaseForecastFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-forecast-fixture-'));
  const databasePath = path.join(directory, 'fixture.sqlite');
  const postingNumber = '90000000-0001-1';
  const settings = { cooperationWarehouse: '1:2', packageService: '3590' };
  const rawProduct = { offer_id: 'fixture-offer', sku: 10001, name: '隔离样例商品', quantity: 2, price: '12.50', currency_code: 'CNY' };
  const raw = { posting_number: postingNumber, delivery_method: { name: '样例物流' }, products: [rawProduct] };
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`CREATE TABLE shops (id TEXT PRIMARY KEY, name TEXT, alias TEXT, client_id TEXT, status TEXT);
      CREATE TABLE ozon_orders (id INTEGER PRIMARY KEY, shop_id TEXT, posting_number TEXT, order_id TEXT,
      source TEXT, status TEXT, substatus TEXT, fulfillment TEXT, in_process_at TEXT, shipment_date TEXT,
      cutoff_at TEXT, payment_at TEXT, amount_value REAL, products_json TEXT, raw_json TEXT, last_seen_at TEXT);
      CREATE TABLE ozon_products (id INTEGER PRIMARY KEY, shop_id TEXT, product_id TEXT, offer_id TEXT, sku TEXT,
      name TEXT, primary_image_url TEXT, price_value REAL, currency_code TEXT);
      CREATE TABLE profile_settings (namespace TEXT, value_json TEXT);`);
    db.prepare('INSERT INTO shops VALUES (?,?,?,?,?)').run('fixture-shop', '隔离店铺', '隔离店铺', '10001', 'active');
    db.prepare('INSERT INTO ozon_orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(1, 'fixture-shop', postingNumber, '90000000',
      'fbs', 'awaiting_deliver', '', 'fbs', '', '', '2026-01-02', '2026-01-01', 25, JSON.stringify([rawProduct]), JSON.stringify(raw), '2026-01-01');
    db.prepare('INSERT INTO ozon_products VALUES (?,?,?,?,?,?,?,?,?)').run(1, 'fixture-shop', '10002', 'fixture-offer', '10001', rawProduct.name, '', 12.5, 'CNY');
    db.prepare('INSERT INTO profile_settings VALUES (?,?)').run('cross-border-preferences', JSON.stringify(settings));
  } finally { db.close(); }
  const order = normalizeOzonSalesRowToPurchaseOrder({
    id: postingNumber, posting: postingNumber, salesOrder: postingNumber, shopId: 'fixture-shop', shopClientId: '10001',
    fulfillment: 'fbs', deliveryMethod: '样例物流', raw,
    products: [{ ...rawProduct, offerId: rawProduct.offer_id, skuId: rawProduct.sku, qty: 2, priceValue: 12.5 }],
  });
  const fields = { ...getPurchaseOperationInitialFields('createForecast', order), country: 'RU', packageDesc: rawProduct.name };
  return { directory, databasePath, settings, postingNumber,
    base: { postingNumber, purchaseOrder: order, fields },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

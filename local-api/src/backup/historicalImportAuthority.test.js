import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createProductRepository } from '../db/repositories/productRepository.js';
import { createOrderRepository } from '../db/repositories/orderRepository.js';
import { createShopDatabaseManager } from '../db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../db/shopDatabaseRouter.js';
import { createShopProductStorage } from '../db/shopProductStorage.js';
import { createShopOrderStorage } from '../db/shopOrderStorage.js';
import { createShopDomainStorageResolver } from '../db/shopDomainStorageResolver.js';
import { createRecoveryStorageAdapter } from './recoveryStorageAdapter.js';
import { createHistoricalProductImportService } from './historicalProductImportService.js';
import { createHistoricalOrderImportService } from './historicalOrderImportService.js';

const shopId = 'historical-direct-fixture';
const now = '2026-09-05T00:00:00.000Z';

function fixture(t, { wal = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-historical-authority-test-'));
  const db = createMigratedTestDb(join(root, 'central.sqlite'));
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  db.prepare(`INSERT INTO shops (id, name, client_id, api_key_encrypted, status, shop_incarnation, created_at, updated_at)
    VALUES (?, 'Synthetic history shop', 'synthetic-client', 'fixture:synthetic-key', 'active', 'fixture-incarnation', ?, ?)`)
    .run(shopId, now, now);
  const shops = createShopRepository(db);
  const manager = createShopDatabaseManager({ root: join(root, 'shops'), profileId: 'default', enableWal: wal });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const productStorage = createShopProductStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
  productStorage.initializeDirectShop({ shopId });
  const orderStorage = createShopOrderStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
  orderStorage.initializeEmptyShop({ shopId });
  orderStorage.initializeDirectShop({ shopId });
  const shopDb = router.open(shopId).db;
  const products = createProductRepository(shopDb);
  products.upsertProducts({ shopId, rows: [{ product_id: '1001', offer_id: 'offer-1', sku: '9001', name: 'Synthetic product', price: '99' }] });
  createOrderRepository(shopDb).upsertOrders({ shopId, rows: [{ posting_number: '99887766-0001-1', order_id: '99887766',
    status: 'delivered', products: [{ product_id: '1001', offer_id: 'offer-1', sku: '9001', quantity: 1 }] }] });
  const storageAdapter = createRecoveryStorageAdapter({ db, resolveShopDomainDatabase: createShopDomainStorageResolver({
    canonicalDb: db, shopProductStorage: productStorage, shopOrderStorage: orderStorage,
  }) });
  const productImporter = createHistoricalProductImportService({ db, storageAdapter });
  const orderImporter = createHistoricalOrderImportService({ db, storageAdapter });
  t.after(() => {
    manager.closeAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, shopDb, products, storageAdapter, productImporter, orderImporter };
}

test('historical product import matches direct-only identities and commits manual costs into the serving shop database', (t) => {
  const f = fixture(t);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM product_identities').get().n, 0);
  const preview = f.productImporter.preflight({ shopId, rows: [{ productId: '1001', purchaseCostCny: '12.34' }] });
  assert.equal(preview.rows[0].status, 'ready_insert');
  const result = f.productImporter.confirm({ shopId, importId: preview.importId, previewFingerprint: preview.previewFingerprint });
  assert.equal(result.verified, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM product_manual_cost_profiles').get().n, 0);
  assert.equal(f.shopDb.prepare('SELECT purchase_cost_minor FROM product_manual_cost_profiles').get().purchase_cost_minor, 1234);
  const visible = f.products.getProductsByIds({ shopId, productIds: ['1001'] });
  assert.ok(JSON.stringify(visible).includes('12.34'), 'the normal product DTO must expose the imported manual cost');
  const update = f.productImporter.preflight({ shopId, conflictMode: 'overwrite', rows: [{ productId: '1001', purchaseCostCny: '56.78' }] });
  assert.equal(update.rows[0].status, 'ready_update');
  assert.equal(f.productImporter.confirm({ shopId, conflictMode: 'overwrite', importId: update.importId, previewFingerprint: update.previewFingerprint }).verified, true);
  assert.equal(f.shopDb.prepare('SELECT purchase_cost_minor FROM product_manual_cost_profiles').get().purchase_cost_minor, 5678);
});

test('historical order import uses direct order/product evidence and keeps each fact/projection in its actual authority', async (t) => {
  const f = fixture(t);
  const service = createHistoricalOrderImportService({ db: f.db, storageAdapter: f.storageAdapter,
    refreshOrdersByPostingNumbers() { throw new Error('UNEXPECTED_EXTERNAL_LOOKUP_FOR_EXISTING_DIRECT_ORDER'); } });
  const preview = await service.preflightWithOzon({ shopId, rows: [{ orderNumber: '99887766-0001-1', purchaseCostCny: '12.34', weightKg: '0.1' }] });
  assert.equal(preview.rows[0].status, 'ready_insert');
  const result = service.confirm({ shopId, importId: preview.importId, previewFingerprint: preview.previewFingerprint });
  assert.equal(result.verified, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM historical_order_facts').get().n, 0);
  assert.equal(f.shopDb.prepare('SELECT purchase_cost_minor FROM historical_order_facts').get().purchase_cost_minor, 1234);
  assert.equal(f.db.prepare('SELECT source_cost_cny FROM purchase_order_overrides').get().source_cost_cny, 12.34);
});

test('late historical-product audit failure rolls back shop cost and leaves its center preview retryable', (t) => {
  const f = fixture(t);
  const preview = f.productImporter.preflight({ shopId, rows: [{ productId: '1001', purchaseCostCny: '12.34' }] });
  assert.equal(preview.rows[0].status, 'ready_insert');
  f.db.exec("CREATE TRIGGER reject_history_audit BEFORE UPDATE OF status ON historical_import_runs WHEN NEW.status != 'previewed' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_HISTORY_AUDIT_FAILURE'); END");
  assert.throws(() => f.productImporter.confirm({ shopId, importId: preview.importId, previewFingerprint: preview.previewFingerprint }), /SYNTHETIC_HISTORY_AUDIT_FAILURE/);
  assert.equal(f.shopDb.prepare('SELECT COUNT(*) AS n FROM product_manual_cost_profiles').get().n, 0);
  assert.equal(f.db.prepare('SELECT status FROM historical_import_runs').get().status, 'previewed');
});

test('multi-WAL historical confirmations refuse before user facts/projections change', (t) => {
  const f = fixture(t, { wal: true });
  const product = f.productImporter.preflight({ shopId, rows: [{ productId: '1001', purchaseCostCny: '12.34' }] });
  assert.equal(product.rows[0].status, 'ready_insert');
  assert.equal(product.restoreSafety.writeAllowed, false);
  assert.throws(() => f.productImporter.confirm({ shopId, importId: product.importId, previewFingerprint: product.previewFingerprint }), /SAFE_RESTORE_REQUIRED/);
  const order = f.orderImporter.preflight({ shopId, rows: [{ orderNumber: '99887766-0001-1', purchaseCostCny: '12.34' }] });
  assert.equal(order.rows[0].status, 'ready_insert');
  assert.throws(() => f.orderImporter.confirm({ shopId, importId: order.importId, previewFingerprint: order.previewFingerprint }), /SAFE_RESTORE_REQUIRED/);
  assert.equal(f.shopDb.prepare('SELECT COUNT(*) AS n FROM product_manual_cost_profiles').get().n, 0);
  assert.equal(f.shopDb.prepare('SELECT COUNT(*) AS n FROM historical_order_facts').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM purchase_order_overrides').get().n, 0);
});

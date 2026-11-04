import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryBackupPlanner, SHOP_BACKUP_HARD_QUOTA_BYTES } from './recoveryBackupPlanner.js';
import { createMigratedTestDb } from '../../test/testDb.js';

test('recovery backup preview is registry-driven, shop-isolated, and excludes runtime/cache tables', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('shop-a', 'Shop A', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('override-a', 'shop-a', 'order-a', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO ozon_products (id, shop_id, product_key, remote_hash, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('product-a', 'shop-a', 'product-a', 'remote-a', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO ozon_response_cache (id, domain, shop_id, endpoint_key, cache_key, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('cache-a', 'products', 'shop-a', 'products.list', 'cache-a', '{"large":"ignored"}', '2026-07-11T00:00:00.000Z');

    const preview = createRecoveryBackupPlanner({ db }).previewShop('shop-a');
    assert.equal(preview.mode, 'read-only-preview');
    assert.equal(preview.quotaBytes, SHOP_BACKUP_HARD_QUOTA_BYTES);
    assert.equal(preview.domains.some((item) => item.domain === 'purchase-overrides' && item.disposition === 'required'), true);
    assert.equal(preview.domains.some((item) => item.domain === 'products' && item.disposition === 'optional'), true);
    assert.equal(preview.domains.some((item) => item.table === 'ozon_response_cache'), false);
    assert.equal(preview.automaticUploadAllowed, false);
    assert.throws(() => createRecoveryBackupPlanner({ db }).previewShop(''), /BACKUP_SHOP_ID_REQUIRED/);
  } finally {
    db.close();
  }
});

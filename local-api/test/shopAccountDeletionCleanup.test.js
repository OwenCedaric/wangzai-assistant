import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function countRows(db, tableName, shopId) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE shop_id = ?`).get(shopId).count;
}

test('legacy shop repository deletion is disabled and cannot bypass the unified removal flow', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const deleteShopId = saveUnitShop(shopRepository, 'shop_delete_scope');
    const keepShopId = saveUnitShop(shopRepository, 'shop_keep_scope');
    const now = new Date().toISOString();

    db.prepare('INSERT INTO sync_jobs (id, shop_id, module) VALUES (?, ?, ?)').run(
      'sync-delete',
      deleteShopId,
      'orders',
    );
    db.prepare('INSERT INTO sync_jobs (id, shop_id, module) VALUES (?, ?, ?)').run(
      'sync-keep',
      keepShopId,
      'orders',
    );
    db.prepare(
      'INSERT INTO ozon_response_cache (id, domain, shop_id, endpoint_key, cache_key) VALUES (?, ?, ?, ?, ?)',
    ).run('cache-delete', 'orders', deleteShopId, 'order.list', 'orders:delete');
    db.prepare(
      'INSERT INTO ozon_response_cache (id, domain, shop_id, endpoint_key, cache_key) VALUES (?, ?, ?, ?, ?)',
    ).run('cache-keep', 'orders', keepShopId, 'order.list', 'orders:keep');
    db.prepare(
      'INSERT INTO cross_border_order_records (id, shop_id, record_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('bus-delete', deleteShopId, 'bus:delete', now, now);
    db.prepare(
      'INSERT INTO cross_border_order_records (id, shop_id, record_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('bus-keep', keepShopId, 'bus:keep', now, now);

    assert.throws(
      () => shopRepository.deleteShop(deleteShopId),
      /ACCOUNT_REMOVAL_LEGACY_PRIMITIVE_DISABLED/u,
    );

    assert.equal(shopRepository.getPublicShopById(deleteShopId).id, deleteShopId);
    assert.equal(shopRepository.getPublicShopById(keepShopId).id, keepShopId);
    assert.equal(countRows(db, 'sync_jobs', deleteShopId), 1);
    assert.equal(countRows(db, 'ozon_response_cache', deleteShopId), 1);
    assert.equal(countRows(db, 'cross_border_order_records', deleteShopId), 1);
    assert.equal(countRows(db, 'sync_jobs', keepShopId), 1);
    assert.equal(countRows(db, 'ozon_response_cache', keepShopId), 1);
    assert.equal(countRows(db, 'cross_border_order_records', keepShopId), 1);
  } finally {
    db.close();
  }
});

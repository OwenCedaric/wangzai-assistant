import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createShopRepository } from './repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';

const migration082 = readFileSync(
  new URL('./migrations/082_backfill_cross_border_order_shop_scope.sql', import.meta.url),
  'utf8'
).replace(/^\uFEFF/u, '');

function insertCrossBorderRecord(db, { id, recordKey, orderId, shopId = '', status = null }) {
  db.prepare(`
    INSERT INTO cross_border_order_records (
      id, shop_id, record_key, order_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, shopId, recordKey, orderId, status);
}

function insertPurchaseOverride(db, { id, shopId, orderKey, crossBorderOrderId }) {
  db.prepare(`
    INSERT INTO purchase_order_overrides (
      id, shop_id, order_key, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, shopId, orderKey, JSON.stringify({ crossBorderOrderId, packageOrderId: crossBorderOrderId }));
}

test('migration 082 backfills only unique conflict-free CrossBorder owners and is idempotent', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db);
    saveUnitShop(shops, 'shop-a');
    saveUnitShop(shops, 'shop-b');

    insertCrossBorderRecord(db, { id: 'cross-unique', recordKey: 'bus-unique', orderId: '1001' });
    insertPurchaseOverride(db, {
      id: 'purchase-unique',
      shopId: 'shop-a',
      orderKey: 'posting-unique',
      crossBorderOrderId: '1001',
    });

    insertCrossBorderRecord(db, { id: 'cross-ambiguous', recordKey: 'bus-ambiguous', orderId: '1002' });
    insertPurchaseOverride(db, {
      id: 'purchase-ambiguous-a',
      shopId: 'shop-a',
      orderKey: 'posting-ambiguous-a',
      crossBorderOrderId: '1002',
    });
    insertPurchaseOverride(db, {
      id: 'purchase-ambiguous-b',
      shopId: 'shop-b',
      orderKey: 'posting-ambiguous-b',
      crossBorderOrderId: '1002',
    });

    insertCrossBorderRecord(db, {
      id: 'cross-conflict-empty',
      recordKey: 'bus-conflict',
      orderId: '1003',
      status: 'legacy-status',
    });
    insertCrossBorderRecord(db, {
      id: 'cross-conflict-owned',
      recordKey: 'bus-conflict',
      orderId: 'owned-1003',
      shopId: 'shop-a',
    });
    insertPurchaseOverride(db, {
      id: 'purchase-conflict',
      shopId: 'shop-a',
      orderKey: 'posting-conflict',
      crossBorderOrderId: '1003',
    });

    insertCrossBorderRecord(db, { id: 'cross-unmatched', recordKey: 'bus-unmatched', orderId: '1004' });

    db.exec(migration082);
    db.exec(migration082);

    const rows = db.prepare(`
      SELECT id, shop_id, status
      FROM cross_border_order_records
      WHERE id LIKE 'cross-%'
      ORDER BY id
    `).all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { id: 'cross-ambiguous', shop_id: '', status: null },
      { id: 'cross-conflict-owned', shop_id: 'shop-a', status: 'legacy-status' },
      { id: 'cross-unique', shop_id: 'shop-a', status: null },
      { id: 'cross-unmatched', shop_id: '', status: null },
    ]);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 82);
  } finally {
    db.close();
  }
});

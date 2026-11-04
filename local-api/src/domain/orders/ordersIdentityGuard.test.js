import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderRepository } from '../../db/repositories/orderRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';
import { extractOrders } from './ordersService.js';

test('order response extraction rejects strings and keeps only complete row objects', () => {
  const valid = { posting_number: '64720469-0563-1', status: 'awaiting_packaging' };
  assert.deepEqual(extractOrders(['64720469-0563-1', null, 123, valid]), [valid]);
  assert.deepEqual(extractOrders({ result: ['64720469-0563-1', valid] }), [valid]);
  assert.deepEqual(extractOrders('64720469-0563-1'), []);
});

test('order repository skips every identityless row and never creates a hash placeholder', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'shop-order-identity-guard');
    const repository = createOrderRepository(db);
    const result = repository.upsertOrders({
      shopId,
      rows: [
        '64720469-0563-1',
        null,
        {},
        { status: 'awaiting_packaging' },
        { posting_number: '64720469-0563-1', status: 'awaiting_packaging' },
      ],
    });
    assert.deepEqual(
      { inserted: result.inserted, missing: result.missing, rows: result.rows },
      { inserted: 1, missing: 4, rows: 5 },
    );
    const stored = db.prepare('SELECT posting_number, order_id FROM ozon_orders WHERE shop_id = ?')
      .all(shopId)
      .map((row) => ({ ...row }));
    assert.deepEqual(stored, [{ posting_number: '64720469-0563-1', order_id: null }]);
  } finally {
    db.close();
  }
});

test('database trigger rejects identityless rows even if a future caller bypasses the repository guard', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'shop-order-trigger-guard');
    assert.throws(
      () => db.prepare(`
        INSERT INTO ozon_orders (
          id, shop_id, order_key, source, remote_hash, is_stale,
          last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'FBS', ?, 0, ?, ?, ?)
      `).run('identityless-row', shopId, 'identityless-key', 'hash', 'now', 'now', 'now'),
      /OZON_ORDER_IDENTITY_REQUIRED/u,
    );
  } finally {
    db.close();
  }
});

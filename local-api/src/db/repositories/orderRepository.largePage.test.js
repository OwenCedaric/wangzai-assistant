import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderRepository } from './orderRepository.js';
import { createShopRepository } from './shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';

test('orders repository reads a 1000-row shared profit page without exceeding SQLite expression depth', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'orders-large-profit-page-shop');
    const repository = createOrderRepository(db);
    repository.upsertOrders({
      shopId,
      rows: Array.from({ length: 1000 }, (_item, index) => ({
        posting_number: `LARGE-PROFIT-${String(index + 1).padStart(4, '0')}`,
        order_id: `large-profit-order-${index + 1}`,
        status: 'delivered',
        in_process_at: '2026-08-25T00:00:00.000Z',
      })),
    });

    const page = repository.listOrders({
      shopId,
      since: '2026-08-24T00:00:00.000Z',
      to: '2026-08-26T00:00:00.000Z',
      page: 1,
      pageSize: 1000,
    });

    assert.equal(page.total, 1000);
    assert.equal(page.rows.length, 1000);
    assert.equal(page.rows.every((row) => row.historicalOrderImport === null), true);
  } finally {
    db.close();
  }
});

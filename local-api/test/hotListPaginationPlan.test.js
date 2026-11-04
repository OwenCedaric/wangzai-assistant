import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from './testDb.js';

function planDetails(db, sql, ...params) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => String(row.detail || ''));
}

test('hot product and order page queries use shop-scoped display-order indexes without a temp sort', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-plan', 'Plan Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const productPlan = planDetails(db, `
      SELECT id FROM ozon_products
      WHERE is_stale = 0 AND shop_id = ?
      ORDER BY sort_index ASC, product_id ASC, offer_id ASC, updated_at DESC
      LIMIT ? OFFSET ?
    `, 'shop-plan', 100, 0);
    const orderPlan = planDetails(db, `
      SELECT id FROM ozon_orders
      WHERE is_stale = 0 AND shop_id = ?
      ORDER BY COALESCE(in_process_at, updated_at) DESC, posting_number ASC, order_id ASC, id ASC
      LIMIT ? OFFSET ?
    `, 'shop-plan', 100, 0);

    assert.equal(productPlan.some((detail) => detail.includes('idx_ozon_products_shop_stale_display_order')), true);
    assert.equal(orderPlan.some((detail) => detail.includes('idx_ozon_orders_shop_stale_display_order')), true);
    assert.equal([...productPlan, ...orderPlan].some((detail) => /TEMP B-TREE/i.test(detail)), false);
  } finally {
    db.close();
  }
});

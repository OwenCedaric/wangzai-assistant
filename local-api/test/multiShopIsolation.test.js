import assert from 'node:assert/strict';
import test from 'node:test';
import { createHotCacheService } from '../src/cache/hotCacheService.js';
import { createOrderRepository } from '../src/db/repositories/orderRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

const sharedOrder = {
  posting_number: 'SHARED-POSTING-001',
  order_id: 'shared-order-001',
  status: 'awaiting_packaging',
  in_process_at: '2026-07-12T00:00:00.000Z',
  products: [{ offer_id: 'shared-offer', quantity: 1, price: '12.50' }],
};

test('same Ozon order key remains isolated by shop in SQLite queries and hot-cache invalidation', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db);
    const shopA = saveUnitShop(shops, 'shop-isolation-a');
    const shopB = saveUnitShop(shops, 'shop-isolation-b');
    const orders = createOrderRepository(db);

    orders.upsertOrders({
      shopId: shopA,
      source: 'FBS',
      rows: [{ ...sharedOrder, raw: { sentinel: 'shop-a-only' } }],
    });
    orders.upsertOrders({
      shopId: shopB,
      source: 'FBS',
      rows: [{ ...sharedOrder, status: 'delivering', raw: { sentinel: 'shop-b-only' } }],
    });

    const fromA = orders.listOrders({ shopId: shopA, pageSize: 20 });
    const fromB = orders.listOrders({ shopId: shopB, pageSize: 20 });
    assert.equal(fromA.total, 1);
    assert.equal(fromB.total, 1);
    assert.equal(fromA.rows[0].shopId, shopA);
    assert.equal(fromB.rows[0].shopId, shopB);
    assert.equal(fromA.rows[0].status, 'awaiting_packaging');
    assert.equal(fromB.rows[0].status, 'delivering');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM ozon_orders WHERE order_key = ?').get('SHARED-POSTING-001').count,
      2,
    );

    const cache = createHotCacheService({ maxEntries: 8, maxBytes: 4096, maxPayloadBytes: 1024 });
    const cacheKeyA = cache.buildKey({ profileId: 'profile-a', shopId: shopA, domain: 'orders', cacheKey: 'shared' });
    const cacheKeyB = cache.buildKey({ profileId: 'profile-a', shopId: shopB, domain: 'orders', cacheKey: 'shared' });
    cache.set(cacheKeyA, { sentinel: 'shop-a-only' }, { tags: [`shop:${shopA}`, 'domain:orders'] });
    cache.set(cacheKeyB, { sentinel: 'shop-b-only' }, { tags: [`shop:${shopB}`, 'domain:orders'] });
    assert.equal(cache.invalidate({ tags: [`shop:${shopA}`] }).removed, 1);
    assert.equal(cache.get(cacheKeyA), null);
    assert.deepEqual(cache.get(cacheKeyB), { sentinel: 'shop-b-only', source: 'memory' });
  } finally {
    db.close();
  }
});

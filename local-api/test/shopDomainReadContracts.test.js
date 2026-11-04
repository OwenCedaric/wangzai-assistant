import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from './testDb.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createOrderRepository } from '../src/db/repositories/orderRepository.js';
import { createReturnRepository } from '../src/db/repositories/returnRepository.js';
import { createFinanceRepository } from '../src/db/repositories/financeRepository.js';
import { createShopDatabaseManager } from '../src/db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../src/db/shopDatabaseRouter.js';
import { createShopOrderStorage } from '../src/db/shopOrderStorage.js';
import { createShopOperationalStorage } from '../src/db/shopOperationalStorage.js';
import { createDomainServiceRegistry } from '../src/domain/domainRegistry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-domain-read-contract-'));
  const db = createMigratedTestDb(path.join(root, 'main.sqlite'));
  const shops = createShopRepository(db, { profileId: 'domain-contract' });
  for (const id of ['a', 'b', 'c']) shops.saveShop({ id, name: id, status: 'active' });
  const manager = createShopDatabaseManager({ root: path.join(root, 'shops'), profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const orders = createShopOrderStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
  const operational = createShopOperationalStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
  for (const shopId of ['a', 'b', 'c']) {
    orders.initializeEmptyShop({ shopId });
    orders.initializeDirectShop({ shopId });
    operational.initializeDirectShop({ shopId });
    const session = router.open(shopId, { createIfMissing: false });
    const now = new Date().toISOString();
    createOrderRepository(session.db).upsertOrders({ shopId, rows: [{ posting_number: 'SHARED-100-001', order_id: `order-${shopId}`, status: 'delivered', in_process_at: now, products: [] }] });
    createReturnRepository(session.db).upsertReturns({ shopId, rows: [{ id: `return-${shopId}`, posting_number: 'SHARED-100-001', status: 'returned_to_seller', created_at: now }] });
    createFinanceRepository(session.db).upsertOperations({ shopId, rows: [{ operation_id: `operation-${shopId}`, operation_date: now, amount: 10, posting: { posting_number: 'SHARED-100-001' } }] });
  }
  const registry = createDomainServiceRegistry({ db, shopRepository: shops, shopDatabaseManager: manager, shopDatabaseRouter: router,
    orderDirectWriteAllShops: true, operationalDirectWriteAllShops: true });
  t.after(async () => { registry.stopBackgroundStorage(); manager.closeAll(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { db, registry, router };
}

test('customer context and sales read the same direct shop fact without copying it to main', async t => {
  const { db, registry } = await fixture(t);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ozon_orders').get().n, 0);
  const context = registry.get('customerService').readOrderRouteContext({ shopId: 'a', postingNumber: 'SHARED-100-001' });
  assert.equal(context.total, 1);
  assert.equal(context.rows[0].shopId, 'a');
  assert.equal(context.rows[0].orderId, 'order-a');
});

test('multi-shop returns and finance select only requested direct-store owners with truthful totals', async t => {
  const { registry } = await fixture(t);
  for (const domain of ['returns', 'finance']) {
    const result = registry.get(domain).readCache({ shop_ids: ['a', 'b'], pageSize: 1 });
    assert.equal(result.total, 2, domain);
    assert.equal(result.rows.length, 1, domain);
    assert.ok(['a', 'b'].includes(result.rows[0].shopId));
    const all = registry.get(domain).readCache({ shopId: 'all', pageSize: 10 });
    assert.equal(all.total, 3, domain);
    const one = registry.get(domain).readCache({ shopIds: ['b'], pageSize: 10 });
    assert.equal(one.total, 1, domain);
    assert.equal(one.rows[0].shopId, 'b');
  }
});

test('storage resolver names the authority and contradictory query scopes fail closed', async t => {
  const { db, registry, router } = await fixture(t);
  assert.equal(registry.resolveShopDomainDatabase({ shopId: 'a', canonicalTable: 'ozon_orders' }).db, router.open('a').db);
  assert.equal(registry.resolveShopDomainDatabase({ shopId: 'a', canonicalTable: 'profile_settings' }).db, db);
  assert.throws(() => registry.get('returns').readCache({ shopId: 'a', shopIds: ['b'] }), { code: 'SHOP_QUERY_SCOPE_CONFLICT' });
});

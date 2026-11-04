import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createShopRepository } from './repositories/shopRepository.js';
import { createOrderRepository } from './repositories/orderRepository.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopOrderStorage } from './shopOrderStorage.js';
import { createShopOrderRepositoryRouter, shopOrderRepositoryRouterInternals } from './shopOrderRepositoryRouter.js';

process.env.LOCAL_API_SECRET = 'isolated-order-page-test-only-secret';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wangzai-page-materialization-'));
  const db = createMigratedTestDb();
  const shops = createShopRepository(db, { profileId: 'page-materialization-fixture' });
  const ids = ['page-shop-a', 'page-shop-b'];
  for (const id of ids) shops.saveShop({ id, name: id, clientId: `fixture-${id}`, apiKey: `fixture-key-${id}`, status: 'active' });
  const manager = createShopDatabaseManager({ root, profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const storage = createShopOrderStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true, backgroundRunner() {} });
  for (const shopId of ids) { storage.initializeEmptyShop({ shopId }); storage.initializeDirectShop({ shopId }); }
  let fullRowsRead = 0;
  const wrappers = new WeakMap();
  const measured = database => {
    if (!wrappers.has(database)) wrappers.set(database, { exec: database.exec.bind(database), prepare(sql) {
      const statement = database.prepare(sql);
      return new Proxy(statement, { get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args) => {
          const result = value.apply(target, args);
          if (property === 'all' && /SELECT\s+\*\s+FROM\s+ozon_orders/iu.test(sql)) fullRowsRead += result.length;
          return result;
        };
      } });
    } });
    return wrappers.get(database);
  };
  const repository = createShopOrderRepositoryRouter({
    canonicalRepository: createOrderRepository(db),
    shopOrderStorage: { ...storage, resolveDirectWriteSession(input) { const session = storage.resolveDirectWriteSession(input); return { ...session, db: measured(session.db) }; } },
    listShopIds: () => ids,
  });
  for (const [shopIndex, shopId] of ids.entries()) repository.upsertOrders({ shopId, rows: Array.from({ length: 105 }, (_, index) => ({
    posting_number: `SAME-${String(index).padStart(4, '0')}`, order_id: String(index),
    status: index % 3 ? 'awaiting_packaging' : 'delivered',
    in_process_at: new Date(Date.UTC(2026, 8, 5, 12) - (index * 2 + shopIndex) * 60000).toISOString(),
    products: [{ offer_id: `SKU-${index}`, name: `商品 ${index}`, price: String(100 + shopIndex), quantity: 2 }],
    marker: `${shopId}:${index}`, financial_data: { total_price: 200 + shopIndex * 2 },
  })) });
  return { repository, db, ids, router, manager,
    resetReadCount() { fullRowsRead = 0; }, fullRowsRead: () => fullRowsRead,
    async close() { manager.closeAll(); db.close();
      assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'wangzai-page-materialization-')));
      await rm(root, { recursive: true, force: true }); },
  };
}

test('late multi-shop page hydrates only its returned rows and preserves every field and same-number shop identity', async () => {
  const f = await fixture();
  try {
    const expected = f.ids.flatMap(shopId => f.repository.listOrders({ shopId, pageSize: 1000 }).rows)
      .sort(shopOrderRepositoryRouterInternals.compareOrders);
    f.resetReadCount();
    const result = f.repository.listOrders({ shopIds: f.ids, page: 8, pageSize: 20 });
    assert.equal(result.total, 210);
    assert.deepEqual(result.rows, expected.slice(140, 160));
    assert.equal(f.fullRowsRead(), 20, 'selection must not hydrate hundreds of unused full orders');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ozon_orders').get().n, 0);
  } finally { await f.close(); }
});

test('direct shop pages use the same payment-order index as the canonical store without a temporary sort', async () => {
  const f = await fixture();
  try {
    const database = f.router.open(f.ids[0]).db;
    const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ozon_orders
      WHERE shop_id = ? AND is_stale = 0
        AND (COALESCE(payment_at, in_process_at) IS NULL OR COALESCE(payment_at, in_process_at) >= ?)
      ORDER BY COALESCE(payment_at, in_process_at, updated_at) DESC, posting_number ASC, order_id ASC, id ASC
      LIMIT 20 OFFSET 40`).all(f.ids[0], '2026-01-01');
    assert.equal(plan.some(row => /TEMP B-TREE/i.test(row.detail)), false, JSON.stringify(plan));
    assert.ok(plan.some(row => /payment_display_order/i.test(row.detail)), JSON.stringify(plan));
    const ownershipPlan = database.prepare(`EXPLAIN QUERY PLAN
      SELECT COUNT(*) AS total, COALESCE(MAX(updated_at), '') AS watermark FROM ozon_orders WHERE shop_id = ?`).all(f.ids[0]);
    assert.ok(ownershipPlan.some(row => /COVERING INDEX/i.test(row.detail)), JSON.stringify(ownershipPlan));
  } finally { await f.close(); }
});

test('an existing isolated shop gains the missing index without changing any order or ownership receipt', async () => {
  const f = await fixture();
  try {
    let database = f.router.open(f.ids[0]).db;
    const allRows = () => database.prepare('SELECT * FROM ozon_orders ORDER BY id').all();
    const receipt = () => database.prepare('SELECT * FROM shop_order_storage_state').get();
    const before = allRows(), beforeReceipt = receipt();
    // Only this newly-created fixture: emulate a pre-index existing shop.
    database.exec('DROP INDEX idx_shop_ozon_orders_stale_payment_display_order; DROP INDEX idx_shop_ozon_orders_owner_watermark');
    f.manager.closeAll();
    database = f.router.open(f.ids[0]).db;
    const result = f.repository.listOrders({ shopId: f.ids[0], page: 3, pageSize: 20 });
    assert.equal(result.total, 105);
    assert.equal(result.rows.length, 20);
    assert.deepEqual(allRows(), before);
    assert.deepEqual(receipt(), beforeReceipt);
    assert.ok(database.prepare('PRAGMA index_list(ozon_orders)').all().some(row => row.name === 'idx_shop_ozon_orders_stale_payment_display_order'));
  } finally { await f.close(); }
});

test('filtered and key/profit projections retain the existing multi-shop result contract', async () => {
  const f = await fixture();
  try {
    for (const query of [{ status: 'awaiting_packaging' }, { keyword: 'SKU-9' }, { projection: 'profit' }, { projection: 'keys' }]) {
      const expected = f.ids.flatMap(shopId => f.repository.listOrders({ ...query, shopId, pageSize: 1000 }).rows)
        .sort(shopOrderRepositoryRouterInternals.compareOrders);
      const result = f.repository.listOrders({ ...query, shopIds: f.ids, page: 2, pageSize: 20 });
      assert.equal(result.total, expected.length);
      assert.deepEqual(result.rows, expected.slice(20, 40));
      if (query.projection === 'keys') assert.ok(result.rows.every(row => Object.keys(row).sort().join(',') === 'orderId,orderKey,postingNumber,shopId'));
    }
  } finally { await f.close(); }
});

test('cached numeric collator exactly matches the old comparator including Unicode and empty values', () => {
  const values = ['', '0', '00', '2', '10', 'A-2', 'A-10', '中2', '中10', 'ä', 'a', 'А', null, 0, false];
  const text = value => value == null ? '' : String(value).trim();
  for (const left of values) for (const right of values) {
    const expected = text(left).localeCompare(text(right), undefined, { numeric: true });
    const actual = shopOrderRepositoryRouterInternals.compareOrders({ postingNumber: left }, { postingNumber: right });
    assert.equal(Math.sign(actual), Math.sign(expected));
  }
});

test('merge keys preserve raw date aliases, nullish precedence and unusual legacy values', async () => {
  const f = await fixture();
  try {
    const aliases = ['', false, 0, null, '2026-10-01T00:00:00.000Z', { legacy: 'date' }];
    for (const shopId of f.ids) f.repository.upsertOrders({ shopId, rows: aliases.map((paymentAt, index) => ({
      posting_number: `ALIAS-${index}`, order_id: `alias-${index}`, paymentAt,
      payment_at: '2026-08-30T00:00:00.000Z', in_process_at: '2026-09-05T00:00:00.000Z',
      status: 'delivered', products: [{ price: '2.50', quantity: 2 }],
    })) });
    const expected = f.ids.flatMap(shopId => f.repository.listOrders({ shopId, pageSize: 1000 }).rows)
      .sort(shopOrderRepositoryRouterInternals.compareOrders);
    const result = f.repository.listOrders({ shopIds: f.ids, pageSize: 1000 });
    assert.deepEqual(result.rows, expected);
    assert.equal(result.total, 222);
  } finally { await f.close(); }
});

test('two-phase hydration rejects changed, filtered-out and wrong-shop rows instead of returning partial success', async () => {
  const f = await fixture();
  try {
    const repository = createOrderRepository(f.router.open(f.ids[0]).db);
    const query = { shopId: f.ids[0], pageSize: 20 };
    const references = repository.listOrderMergeKeys(query).rows;
    assert.equal(repository.hydrateOrderMergeKeys(query, references).length, 20);
    assert.throws(() => repository.hydrateOrderMergeKeys({ ...query, status: 'does-not-exist' }, references), { code: 'ORDER_PAGE_CHANGED_DURING_READ' });
    assert.throws(() => repository.hydrateOrderMergeKeys(query, [{ ...references[0], shopId: f.ids[1] }]), { code: 'ORDER_PAGE_IDENTITY_INVALID' });
    assert.throws(() => repository.hydrateOrderMergeKeys(query, [references[0], references[0]]), { code: 'ORDER_PAGE_IDENTITY_INVALID' });
    f.repository.upsertOrders({ shopId: f.ids[0], rows: [{ posting_number: references[0].sortKey.postingNumber, status: 'cancelled', changed: true }] });
    assert.throws(() => repository.hydrateOrderMergeKeys(query, references), { code: 'ORDER_PAGE_CHANGED_DURING_READ' });
  } finally { await f.close(); }
});

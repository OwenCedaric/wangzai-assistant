import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createOrderRepository } from './repositories/orderRepository.js';
import { createShopRepository } from './repositories/shopRepository.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopOrderReadRouter } from './shopOrderReadRouter.js';
import { createShopOrderRepositoryRouter } from './shopOrderRepositoryRouter.js';
import { createShopOrderStorage } from './shopOrderStorage.js';

function saveShop(shops, id) {
  return shops.saveShop({ id, name: id, clientId: `client-${id}`, apiKey: `secret-${id}`, status: 'active' });
}

test('an independent shop read failure never falls back to stale shared orders, including a newly bound shop', () => {
  const newShop = `future-${randomUUID()}`;
  let legacyReads = 0;
  const unavailable = Object.assign(new Error('independent database unavailable'), { code: 'SHOP_DATABASE_NOT_FOUND' });
  const repository = createShopOrderRepositoryRouter({
    canonicalRepository: {
      listOrders() { legacyReads++; return { rows: [], total: 0 }; },
      pruneSimulatedTestSplitChildren() {}, reconcileSplitRelationsFromReadback() {}, upsertOrders() {}, upsertSplitRelation() {},
    },
    shopOrderStorage: { isDirectWriteShop: () => true, resolveDirectWriteSession() { throw unavailable; } },
    listShopIds: () => [newShop],
  });
  assert.throws(() => repository.listOrders({ shopId: newShop }), { code: 'SHOP_DATABASE_NOT_FOUND' });
  assert.throws(() => repository.listOrders({}), { code: 'SHOP_DATABASE_NOT_FOUND' });
  assert.equal(legacyReads, 0);
});

function order(postingNumber, amount, timestamp = '2026-09-03T10:00:00.000Z') {
  return {
    posting_number: postingNumber,
    order_id: `order-${postingNumber}`,
    status: 'awaiting_packaging',
    in_process_at: timestamp,
    products: [{ offer_id: `offer-${postingNumber}`, price: amount, quantity: 1 }],
    analytics_data: { region: 'Moscow' },
    financial_data: { total_price: amount },
  };
}

function completeBackfill(storage, shopId) {
  for (let index = 0; index < 100; index += 1) {
    const result = storage.backfillNextBatch({ shopId, batchSize: 10 });
    if (result.completed) return result;
  }
  throw new Error(`backfill did not complete for ${shopId}`);
}

async function createFixture(shopIds = ['shop-1']) {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-order-direct-'));
  const canonicalDb = createMigratedTestDb();
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-order-direct',
    createIncarnation: () => 'inc-order-direct',
  });
  shopIds.forEach((shopId) => saveShop(shops, shopId));
  const manager = createShopDatabaseManager({ root, profileId: shops.profileId });
  const databaseRouter = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const storage = createShopOrderStorage({
    canonicalDb,
    shopDatabaseRouter: databaseRouter,
    directWriteAllShops: true,
    backgroundRunner() {},
  });
  const baseRepository = createOrderRepository(canonicalDb);
  return {
    root,
    canonicalDb,
    shops,
    manager,
    databaseRouter,
    storage,
    baseRepository,
    createRoutedRepository(storageOverrides = {}) {
      const readRouter = createShopOrderReadRouter({
        canonicalDb,
        shopOrderStorage: storage,
        includeAllReadyShops: true,
      });
      const canonicalRepository = createOrderRepository(canonicalDb, {
        resolveOrderReadDatabase: readRouter.resolve,
      });
      return createShopOrderRepositoryRouter({
        canonicalRepository,
        shopOrderStorage: { ...storage, ...storageOverrides },
        listShopIds: () => shopIds,
      });
    },
    async close() {
      manager.closeAll();
      canonicalDb.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('direct order writes and split classification stay in the exact shop database', async () => {
  const fixture = await createFixture();
  try {
    fixture.baseRepository.upsertOrders({ shopId: 'shop-1', rows: [order('OLD-1', 10)] });
    fixture.baseRepository.upsertSplitRelation({
      shopId: 'shop-1',
      parentPostingNumber: 'OLD-1',
      childPostingNumbers: ['OLD-1-1', 'OLD-1-2'],
      status: 'submitted_waiting_readback',
    });
    completeBackfill(fixture.storage, 'shop-1');
    assert.equal(fixture.storage.initializeDirectShop({ shopId: 'shop-1' }).initialized, true);
    const repository = fixture.createRoutedRepository();

    const canonicalOrderTotal = fixture.canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total;
    repository.upsertOrders({ shopId: 'shop-1', rows: [order('DIRECT-1', 20, '2026-09-04T10:00:00.000Z')] });
    repository.upsertSplitRelation({
      shopId: 'shop-1',
      parentPostingNumber: 'OLD-1',
      childPostingNumbers: ['OLD-1-1', 'OLD-1-2'],
      status: 'readback_merged',
      readbackStatus: 'merged',
      childrenConfirmed: true,
    });

    const shopDb = fixture.databaseRouter.open('shop-1').db;
    assert.equal(fixture.canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, canonicalOrderTotal);
    assert.equal(shopDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 2);
    assert.equal(repository.listOrders({ shopId: 'shop-1', pageSize: 20 }).total, 2);
    assert.equal(repository.listSplitRelations({ shopId: 'shop-1' }).rows[0].readbackStatus, 'merged');
    assert.equal(
      fixture.baseRepository.listSplitRelations({ shopId: 'shop-1' }).rows[0].readbackStatus,
      'pending',
      'the shared split-classification row remains frozen',
    );
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).writeMode, 'direct');
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).directWriteRevision, 2);
    assert.equal(repository.snapshotDirectWrites().canonicalWrites, 0);
  } finally {
    await fixture.close();
  }
});

test('aggregate order pages and summaries are merged from independent shop databases', async () => {
  const fixture = await createFixture(['shop-1', 'shop-2']);
  try {
    fixture.baseRepository.upsertOrders({ shopId: 'shop-1', rows: [order('ONE-OLD', 10, '2026-09-01T10:00:00.000Z')] });
    fixture.baseRepository.upsertOrders({ shopId: 'shop-2', rows: [order('TWO-OLD', 20, '2026-09-02T10:00:00.000Z')] });
    for (const shopId of ['shop-1', 'shop-2']) {
      completeBackfill(fixture.storage, shopId);
      fixture.storage.initializeDirectShop({ shopId });
    }
    const repository = fixture.createRoutedRepository();
    repository.upsertOrders({ shopId: 'shop-1', rows: [order('ONE-DIRECT', 30, '2026-09-04T10:00:00.000Z')] });
    repository.upsertOrders({ shopId: 'shop-2', rows: [order('TWO-DIRECT', 40, '2026-09-03T10:00:00.000Z')] });

    const page = repository.listOrders({ shopIds: ['shop-1', 'shop-2'], page: 1, pageSize: 3 });
    const summary = repository.summarizeOrders({ shopIds: ['shop-1', 'shop-2'] });
    assert.equal(page.source, 'shop-federated');
    assert.equal(page.total, 4);
    assert.deepEqual(page.rows.map((row) => row.postingNumber), ['ONE-DIRECT', 'TWO-DIRECT', 'TWO-OLD']);
    assert.equal(summary.total, 4);
    assert.equal(summary.amountTotal, 100);
    assert.equal(fixture.canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 2);
  } finally {
    await fixture.close();
  }
});

test('new shops initialize direct order storage without writing a shared order row', async () => {
  const fixture = await createFixture();
  try {
    fixture.storage.initializeEmptyShop({ shopId: 'shop-1' });
    assert.equal(fixture.storage.initializeDirectShop({ shopId: 'shop-1' }).initialized, true);
    const repository = fixture.createRoutedRepository();
    repository.upsertOrders({ shopId: 'shop-1', rows: [order('FIRST-1', 15)] });
    assert.equal(fixture.canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
    assert.equal(fixture.databaseRouter.open('shop-1').db.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 1);
  } finally {
    await fixture.close();
  }
});

async function createEmptyDirectFixture(shopIds = ['shop-1']) {
  const fixture = await createFixture(shopIds);
  for (const shopId of shopIds) {
    fixture.storage.initializeEmptyShop({ shopId });
    fixture.storage.initializeDirectShop({ shopId });
  }
  return fixture;
}

test('direct order batch rolls back both rows and receipt when recordDirectWrite rejects the scope', async () => {
  const fixture = await createEmptyDirectFixture();
  try {
    const shopDb = fixture.databaseRouter.open('shop-1').db;
    const rejected = Object.assign(new Error('scope changed'), { code: 'SHOP_SCOPE_CHANGED' });
    const repository = fixture.createRoutedRepository({
      recordDirectWrite(input) {
        fixture.storage.recordDirectWrite(input);
        throw rejected;
      },
    });
    assert.throws(() => repository.upsertOrders({
      shopId: 'shop-1', rows: [order('ATOMIC-1', 12.5), order('ATOMIC-2', 22.75)],
    }), error => error === rejected);
    assert.equal(shopDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
    assert.equal(shopDb.prepare('SELECT direct_write_revision FROM shop_order_storage_state').get().direct_write_revision, 0);
    assert.equal(repository.snapshotDirectWrites().directWrites, 0);
    assert.equal(repository.snapshotDirectWrites().failures, 1);
    assert.equal(repository.snapshotDirectWrites().lastErrorCode, 'SHOP_SCOPE_CHANGED');
    fixture.manager.closeAll();
    assert.equal(fixture.databaseRouter.open('shop-1').db.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
  } finally {
    await fixture.close();
  }
});

test('direct order batch rolls back the first SQL write when the second insert fails', async () => {
  const fixture = await createEmptyDirectFixture();
  try {
    const shopDb = fixture.databaseRouter.open('shop-1').db;
    shopDb.exec(`CREATE TRIGGER fail_second_order BEFORE INSERT ON ozon_orders
      WHEN NEW.posting_number = 'FAIL-2'
      BEGIN SELECT RAISE(ABORT, 'SECOND_ORDER_REJECTED'); END;`);
    const repository = fixture.createRoutedRepository();
    assert.throws(() => repository.upsertOrders({
      shopId: 'shop-1', rows: [order('PASS-1', 12.5), order('FAIL-2', 22.75)],
    }), /SECOND_ORDER_REJECTED/);
    assert.equal(shopDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
    assert.equal(shopDb.prepare('SELECT direct_write_revision FROM shop_order_storage_state').get().direct_write_revision, 0);
    assert.equal(repository.snapshotDirectWrites().directWrites, 0);
    fixture.manager.closeAll();
    assert.equal(fixture.databaseRouter.open('shop-1').db.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
  } finally {
    await fixture.close();
  }
});

test('direct order savepoint preserves the caller transaction on success and failure', async () => {
  const fixture = await createEmptyDirectFixture();
  try {
    const shopDb = fixture.databaseRouter.open('shop-1').db;
    const repository = fixture.createRoutedRepository();
    shopDb.exec('BEGIN');
    repository.upsertOrders({ shopId: 'shop-1', rows: [order('OUTER-1', 10)] });
    assert.equal(shopDb.isTransaction, true);
    assert.equal(shopDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 1);
    const rejected = fixture.createRoutedRepository({
      recordDirectWrite() { throw Object.assign(new Error('scope changed'), { code: 'SHOP_SCOPE_CHANGED' }); },
    });
    assert.throws(() => rejected.upsertOrders({ shopId: 'shop-1', rows: [order('INNER-FAIL', 99)] }), /scope changed/);
    assert.equal(shopDb.isTransaction, true);
    assert.deepEqual(shopDb.prepare('SELECT posting_number FROM ozon_orders').all().map(row => row.posting_number), ['OUTER-1']);
    shopDb.exec('ROLLBACK');
    assert.equal(shopDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
    assert.equal(shopDb.prepare('SELECT direct_write_revision FROM shop_order_storage_state').get().direct_write_revision, 0);
  } finally {
    await fixture.close();
  }
});

test('direct order batches keep identical posting numbers isolated across shops', async () => {
  const fixture = await createEmptyDirectFixture(['shop-1', 'shop-2']);
  try {
    const repository = fixture.createRoutedRepository();
    repository.upsertOrders({ shopId: 'shop-1', rows: [order('SAME-1', 12.5)] });
    repository.upsertOrders({ shopId: 'shop-2', rows: [order('SAME-1', 22.75)] });
    for (const [shopId, amount] of [['shop-1', 12.5], ['shop-2', 22.75]]) {
      const shopDb = fixture.databaseRouter.open(shopId).db;
      const rows = shopDb.prepare('SELECT shop_id, posting_number, amount_value FROM ozon_orders').all();
      assert.deepEqual(rows.map(row => ({ ...row })), [{ shop_id: shopId, posting_number: 'SAME-1', amount_value: amount }]);
      assert.equal(repository.summarizeOrders({ shopId }).amountTotal, amount);
    }
    assert.equal(fixture.canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
  } finally {
    await fixture.close();
  }
});

test('direct order batch preserves every normal result and persisted field against the unwrapped repository', async (t) => {
  const fixture = await createEmptyDirectFixture();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-06T12:00:00.000Z') });
    const repository = fixture.createRoutedRepository();
    const shopDb = fixture.databaseRouter.open('shop-1').db;
    const batches = [
      [order('MATCH-1', 12.5), order('MATCH-2', 22.75), {}],
      [order('MATCH-1', 12.5), order('MATCH-2', 23.5), order('MATCH-3', 0)],
    ];
    for (const rows of batches) {
      const input = { shopId: 'shop-1', rows, source: 'FBS' };
      assert.deepEqual(repository.upsertOrders(input), fixture.baseRepository.upsertOrders(input));
      assert.deepEqual(
        shopDb.prepare('SELECT * FROM ozon_orders ORDER BY id').all(),
        fixture.canonicalDb.prepare('SELECT * FROM ozon_orders ORDER BY id').all(),
      );
      assert.deepEqual(repository.listOrders({ shopId: 'shop-1' }), fixture.baseRepository.listOrders({ shopId: 'shop-1' }));
      assert.deepEqual(repository.summarizeOrders({ shopId: 'shop-1' }), fixture.baseRepository.summarizeOrders({ shopId: 'shop-1' }));
    }
  } finally {
    await fixture.close();
  }
});

test('direct order batch does not report success if releasing the savepoint fails', async () => {
  const fixture = await createEmptyDirectFixture();
  try {
    const session = fixture.storage.resolveDirectWriteSession({ shopId: 'shop-1' });
    const rejected = Object.assign(new Error('release failed'), { code: 'TEST_RELEASE_FAILED' });
    let shouldFailRelease = true;
    const wrappedDb = new Proxy(session.db, {
      get(target, key) {
        if (key === 'exec') return (sql) => {
          if (shouldFailRelease && sql.startsWith('RELEASE SAVEPOINT order_write_')) {
            shouldFailRelease = false;
            throw rejected;
          }
          return target.exec(sql);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repository = fixture.createRoutedRepository({
      resolveDirectWriteSession() { return { ...session, db: wrappedDb }; },
    });
    assert.throws(() => repository.upsertOrders({ shopId: 'shop-1', rows: [order('UNCOMMITTED-1', 12.5)] }), error => error === rejected);
    assert.equal(session.db.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
    assert.equal(session.db.prepare('SELECT direct_write_revision FROM shop_order_storage_state').get().direct_write_revision, 0);
    assert.equal(session.db.isTransaction, false);
    assert.equal(repository.snapshotDirectWrites().directWrites, 0);
    assert.equal(repository.snapshotDirectWrites().failures, 1);
    assert.equal(repository.snapshotDirectWrites().lastErrorCode, 'TEST_RELEASE_FAILED');
  } finally {
    await fixture.close();
  }
});

test('failed savepoint cleanup blocks that database across routers until an explicit outer rollback', async () => {
  const fixture = await createEmptyDirectFixture(['shop-1', 'shop-2']);
  const shopDb = fixture.databaseRouter.open('shop-1').db;
  const originalExec = shopDb.exec;
  try {
    shopDb.exec(`CREATE TRIGGER fail_recovery_second_order BEFORE INSERT ON ozon_orders
      WHEN NEW.posting_number = 'RECOVERY-FAIL-2'
      BEGIN SELECT RAISE(ABORT, 'RECOVERY_SECOND_ORDER_REJECTED'); END;`);
    shopDb.exec = function (sql) {
      if (sql.startsWith('ROLLBACK TO SAVEPOINT order_write_')) {
        throw Object.assign(new Error('rollback unavailable'), { code: 'TEST_ROLLBACK_FAILED' });
      }
      return originalExec.call(this, sql);
    };
    const repository = fixture.createRoutedRepository();
    assert.throws(() => repository.upsertOrders({
      shopId: 'shop-1', rows: [order('RECOVERY-PENDING-1', 12.5), order('RECOVERY-FAIL-2', 22.75)],
    }), /RECOVERY_SECOND_ORDER_REJECTED/);
    assert.equal(shopDb.isTransaction, true);
    assert.deepEqual(shopDb.prepare('SELECT posting_number FROM ozon_orders').all().map(row => row.posting_number), ['RECOVERY-PENDING-1']);
    assert.equal(repository.snapshotDirectWrites().directWrites, 0);

    const anotherRepository = fixture.createRoutedRepository();
    for (const reader of [repository, anotherRepository]) {
      for (const method of ['listOrders', 'summarizeOrders', 'listPrintShippingFacets', 'listSplitRelations']) {
        assert.throws(() => reader[method]({ shopId: 'shop-1' }), { code: 'SHOP_ORDER_WRITE_RECOVERY_REQUIRED' });
      }
      assert.throws(() => reader.listOrders({ shopIds: ['shop-1', 'shop-2'] }), { code: 'SHOP_ORDER_WRITE_RECOVERY_REQUIRED' });
      assert.throws(() => reader.upsertOrders({ shopId: 'shop-1', rows: [order('RECOVERY-BLOCKED', 99)] }), { code: 'SHOP_ORDER_WRITE_RECOVERY_REQUIRED' });
      assert.equal(reader.snapshotDirectWrites().directWrites, 0);
    }
    assert.equal(shopDb.isTransaction, true, 'the router never rolls back or closes a caller-owned transaction');
    assert.equal(shopDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 1);
    assert.equal(repository.upsertOrders({ shopId: 'shop-2', rows: [order('RECOVERY-OTHER-SHOP', 33.75)] }).inserted, 1);
    assert.equal(repository.listOrders({ shopId: 'shop-2' }).total, 1);
    assert.equal(repository.summarizeOrders({ shopId: 'shop-2' }).amountTotal, 33.75);

    shopDb.exec = originalExec;
    shopDb.exec('ROLLBACK');
    assert.equal(shopDb.isTransaction, false);
    assert.equal(anotherRepository.listOrders({ shopId: 'shop-1' }).total, 0);
    assert.equal(repository.upsertOrders({ shopId: 'shop-1', rows: [order('RECOVERY-FRESH', 44.5)] }).inserted, 1);
    assert.deepEqual(repository.listOrders({ shopId: 'shop-1' }).rows.map(row => row.postingNumber), ['RECOVERY-FRESH']);
    assert.equal(shopDb.prepare('SELECT direct_write_revision FROM shop_order_storage_state').get().direct_write_revision, 1);
    assert.equal(fixture.canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_orders').get().total, 0);
  } finally {
    shopDb.exec = originalExec;
    if (shopDb.isTransaction) shopDb.exec('ROLLBACK');
    await fixture.close();
  }
});

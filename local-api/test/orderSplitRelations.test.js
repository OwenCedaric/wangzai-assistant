import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderRepository } from '../src/db/repositories/orderRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createOrdersService } from '../src/domain/orders/ordersService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function orderRow(postingNumber, overrides = {}) {
  return {
    posting_number: postingNumber,
    order_id: overrides.order_id || `order-${postingNumber}`,
    status: overrides.status || 'awaiting_packaging',
    in_process_at: overrides.in_process_at || '2026-06-29T10:00:00Z',
    products: overrides.products || [{ offer_id: 'offer-1', quantity: 1, price: '12.50' }],
  };
}

test('order repository annotates split parent and child rows without hiding Ozon rows', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_repo');
    const repository = createOrderRepository(db);

    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [
        orderRow('parent-1', { products: [{ offer_id: 'offer-1', quantity: 2 }] }),
        orderRow('child-1'),
      ],
    });
    repository.upsertSplitRelation({
      shopId,
      parentPostingNumber: 'parent-1',
      childPostingNumbers: ['child-1'],
      splitQuantities: [{ posting_number: 'child-1', offer_id: 'offer-1', quantity: 2 }],
      readbackStatus: 'merged',
      status: 'readback_merged',
      parentOzonVisible: true,
      childrenConfirmed: true,
    });

    const page = repository.listOrders({ shopId, pageSize: 20 });
    const parent = page.rows.find((row) => row.posting_number === 'parent-1');
    const child = page.rows.find((row) => row.posting_number === 'child-1');

    assert.equal(page.total, 2);
    assert.equal(parent.splitRole, 'parent');
    assert.equal(parent.splitBusinessLocked, false);
    assert.equal(parent.splitReadbackStatus, 'merged');
    assert.equal(parent.splitDefaultBusinessHidden, false);
    assert.equal(parent.splitOzonDisplayStatus, 'parent_visible_after_readback');
    assert.deepEqual(parent.splitChildPostingNumbers, ['child-1']);
    assert.equal(child.splitRole, 'child');
    assert.equal(child.splitBusinessLocked, false);
    assert.equal(child.splitParentPostingNumber, 'parent-1');
  } finally {
    db.close();
  }
});

test('split parent is hidden from default business display when children are confirmed and parent visibility is unknown', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_parent_unknown_visibility');
    const repository = createOrderRepository(db);

    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [
        orderRow('parent-unknown', { products: [{ offer_id: 'offer-1', quantity: 2 }] }),
        orderRow('child-unknown-1'),
        orderRow('child-unknown-2'),
      ],
    });

    repository.upsertSplitRelation({
      shopId,
      parentPostingNumber: 'parent-unknown',
      childPostingNumbers: ['child-unknown-1', 'child-unknown-2'],
      readbackStatus: 'merged',
      status: 'readback_merged',
      childrenConfirmed: true,
      parentOzonVisible: null,
    });

    const page = repository.listOrders({ shopId, pageSize: 20 });
    const parent = page.rows.find((row) => row.posting_number === 'parent-unknown');

    assert.equal(parent.splitRole, 'parent');
    assert.equal(parent.splitBusinessLocked, true);
    assert.equal(parent.splitDefaultBusinessHidden, true);
    assert.equal(parent.splitOzonDisplayStatus, 'parent_not_visible_after_readback');
  } finally {
    db.close();
  }
});

test('split parent remains visible and operable when Ozon explicitly still returns the parent row', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_parent_visible');
    const repository = createOrderRepository(db);

    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [orderRow('parent-visible'), orderRow('child-visible-1')],
    });

    repository.upsertSplitRelation({
      shopId,
      parentPostingNumber: 'parent-visible',
      childPostingNumbers: ['child-visible-1'],
      readbackStatus: 'merged',
      status: 'readback_merged',
      childrenConfirmed: true,
      parentOzonVisible: true,
    });

    const page = repository.listOrders({ shopId, pageSize: 20 });
    const parent = page.rows.find((row) => row.posting_number === 'parent-visible');

    assert.equal(parent.splitRole, 'parent');
    assert.equal(parent.splitBusinessLocked, false);
    assert.equal(parent.splitDefaultBusinessHidden, false);
    assert.equal(parent.splitOzonDisplayStatus, 'parent_visible_after_readback');
  } finally {
    db.close();
  }
});

test('split parent visibility true is not preserved when later readback is not authoritative', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_parent_unknown_readback');
    const repository = createOrderRepository(db);

    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [orderRow('parent-stale-true'), orderRow('child-stale-true')],
    });

    repository.upsertSplitRelation({
      shopId,
      parentPostingNumber: 'parent-stale-true',
      childPostingNumbers: ['child-stale-true'],
      readbackStatus: 'merged',
      status: 'readback_merged',
      childrenConfirmed: true,
      parentOzonVisible: true,
    });

    const result = repository.reconcileSplitRelationsFromReadback({
      shopId,
      rows: [orderRow('child-stale-true')],
      parentVisibilityChecked: false,
    });

    assert.equal(result.changed, 1);
    assert.equal(result.relations[0].parentOzonVisible, null);

    const relation = repository.listSplitRelations({ shopId, parentPostingNumber: 'parent-stale-true' }).rows[0];
    assert.equal(relation.parentOzonVisible, null);

    const page = repository.listOrders({ shopId, pageSize: 20 });
    const parent = page.rows.find((row) => row.posting_number === 'parent-stale-true');
    assert.equal(parent.splitDefaultBusinessHidden, true);
    assert.equal(parent.splitOzonDisplayStatus, 'parent_not_visible_after_readback');
  } finally {
    db.close();
  }
});

test('split parent visibility becomes false when authoritative list readback does not include parent', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_parent_authoritative_missing');
    const repository = createOrderRepository(db);

    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [orderRow('parent-authoritative-missing'), orderRow('child-authoritative-missing')],
    });

    repository.upsertSplitRelation({
      shopId,
      parentPostingNumber: 'parent-authoritative-missing',
      childPostingNumbers: ['child-authoritative-missing'],
      readbackStatus: 'merged',
      status: 'readback_merged',
      childrenConfirmed: true,
      parentOzonVisible: true,
    });

    const result = repository.reconcileSplitRelationsFromReadback({
      shopId,
      rows: [orderRow('child-authoritative-missing')],
      parentVisibilityChecked: true,
    });

    assert.equal(result.changed, 1);
    assert.equal(result.relations[0].parentOzonVisible, false);

    const page = repository.listOrders({ shopId, pageSize: 20 });
    const parent = page.rows.find((row) => row.posting_number === 'parent-authoritative-missing');
    assert.equal(parent.splitDefaultBusinessHidden, true);
    assert.equal(parent.splitOzonDisplayStatus, 'parent_not_visible_after_readback');
  } finally {
    db.close();
  }
});

test('split parent visibility remains true when authoritative list readback includes parent', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_parent_authoritative_visible');
    const repository = createOrderRepository(db);

    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [orderRow('parent-authoritative-visible'), orderRow('child-authoritative-visible')],
    });

    repository.upsertSplitRelation({
      shopId,
      parentPostingNumber: 'parent-authoritative-visible',
      childPostingNumbers: ['child-authoritative-visible'],
      readbackStatus: 'merged',
      status: 'readback_merged',
      childrenConfirmed: true,
      parentOzonVisible: null,
    });

    const result = repository.reconcileSplitRelationsFromReadback({
      shopId,
      rows: [orderRow('parent-authoritative-visible'), orderRow('child-authoritative-visible')],
      parentVisibilityChecked: true,
    });

    assert.equal(result.changed, 1);
    assert.equal(result.relations[0].parentOzonVisible, true);

    const page = repository.listOrders({ shopId, pageSize: 20 });
    const parent = page.rows.find((row) => row.posting_number === 'parent-authoritative-visible');
    assert.equal(parent.splitBusinessLocked, false);
    assert.equal(parent.splitDefaultBusinessHidden, false);
    assert.equal(parent.splitOzonDisplayStatus, 'parent_visible_after_readback');
  } finally {
    db.close();
  }
});

test('orders split write records relation and waits for real readback before merged status', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_write');
    const schedulerCalls = [];
    const service = createOrdersService({
      db,
      ozonScheduler: {
        async executeWrite(input) {
          schedulerCalls.push(input);
          return {
            ok: true,
            status: 'success',
            realWrite: input.realWrite === true,
            dryRun: input.dryRun === true,
            data: { result: { postings: [{ posting_number: 'child-1' }, { posting_number: 'child-2' }] } },
            readBackRows: [
              orderRow('child-1', { products: [{ offer_id: 'offer-1', quantity: 1 }] }),
              orderRow('child-2', { products: [{ offer_id: 'offer-1', quantity: 1 }] }),
            ],
          };
        },
      },
      backgroundRunner() {},
    });

    const result = await service.executeConfirmedWrite({
      input: {
        shopId,
        action: 'splitFbsPosting',
        endpointKey: 'orders.splitFbsPosting',
        realWrite: true,
        dryRun: false,
        payload: {
          posting_number: 'parent-1',
          postings: [
            { products: [{ offer_id: 'offer-1', quantity: 1 }] },
            { products: [{ offer_id: 'offer-1', quantity: 1 }] },
          ],
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.writeStatus, 'readback_merged');
    assert.equal(result.splitRelation.readbackStatus, 'merged');
    assert.deepEqual(result.splitRelation.childPostingNumbers, ['child-1', 'child-2']);
    assert.equal(schedulerCalls[0].endpointKey, 'orders.splitFbsPosting');

    const cache = service.readCache({ shopId, pageSize: 20 });
    const child = cache.rows.find((row) => row.posting_number === 'child-1');
    assert.equal(child.splitRole, 'child');
    assert.equal(child.splitParentPostingNumber, 'parent-1');
  } finally {
    db.close();
  }
});

test('orders split write treats Ozon parent plus children readback as three actual postings', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_parent_plus_children');
    const service = createOrdersService({
      db,
      ozonScheduler: {
        async executeWrite(input) {
          return {
            ok: true,
            status: 'success',
            realWrite: input.realWrite === true,
            dryRun: false,
            data: {
              result: {
                parent_posting: { posting_number: 'parent-real' },
                postings: [{ posting_number: 'child-real-1' }, { posting_number: 'child-real-2' }],
              },
            },
            readBackRows: [
              orderRow('parent-real', { products: [{ offer_id: 'offer-1', quantity: 1, price: '10.00' }] }),
              orderRow('child-real-1', { products: [{ offer_id: 'offer-1', quantity: 1, price: '10.00' }] }),
              orderRow('child-real-2', { products: [{ offer_id: 'offer-1', quantity: 1, price: '10.00' }] }),
            ],
          };
        },
      },
      backgroundRunner() {},
    });

    const result = await service.executeConfirmedWrite({
      input: {
        shopId,
        action: 'splitFbsPosting',
        endpointKey: 'orders.splitFbsPosting',
        realWrite: true,
        dryRun: false,
        payload: {
          posting_number: 'parent-real',
          postings: [
            { products: [{ offer_id: 'offer-1', quantity: 1 }] },
            { products: [{ offer_id: 'offer-1', quantity: 1 }] },
            { products: [{ offer_id: 'offer-1', quantity: 1 }] },
          ],
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.writeStatus, 'readback_merged');
    assert.equal(result.splitRelation.readbackStatus, 'merged');
    assert.equal(result.splitRelation.parentOzonVisible, true);
    assert.equal(result.splitRelation.mismatchReason, null);

    const cache = service.readCache({ shopId, pageSize: 20 });
    const parent = cache.rows.find((row) => row.posting_number === 'parent-real');
    const children = cache.rows.filter((row) => row.splitParentPostingNumber === 'parent-real' && row.splitRole === 'child');
    assert.equal(cache.total, 3);
    assert.equal(parent.splitBusinessLocked, false);
    assert.equal(parent.splitDefaultBusinessHidden, false);
    assert.equal(parent.products[0].quantity, 1);
    assert.equal(children.length, 2);
  } finally {
    db.close();
  }
});

test('orders split write queues background readback when inline rows are absent', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_background_readback');
    const backgroundTasks = [];
    const service = createOrdersService({
      db,
      ozonScheduler: {
        async executeWrite(input) {
          return {
            ok: true,
            status: 'success',
            realWrite: input.realWrite === true,
            dryRun: false,
            data: { result: { postings: [{ posting_number: 'child-bg-1' }, { posting_number: 'child-bg-2' }] } },
            readBackRows: [],
          };
        },
      },
      backgroundRunner(task) {
        backgroundTasks.push(task);
      },
    });

    const result = await service.executeConfirmedWrite({
      input: {
        shopId,
        action: 'splitFbsPosting',
        endpointKey: 'orders.splitFbsPosting',
        realWrite: true,
        dryRun: false,
        payload: {
          posting_number: 'parent-bg',
          postings: [
            { products: [{ offer_id: 'offer-1', quantity: 1 }] },
            { products: [{ offer_id: 'offer-1', quantity: 1 }] },
          ],
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.writeStatus, 'submitted_waiting_readback');
    assert.equal(result.splitRelation.readbackStatus, 'pending');
    assert.deepEqual(result.splitRelation.childPostingNumbers, ['child-bg-1', 'child-bg-2']);
    assert.equal(result.readBackJobs.scheduled, true);
    assert.equal(result.readBackJobs.jobs.length, 4);
    assert.deepEqual(
      result.readBackJobs.jobs.map((job) => job.endpointKey),
      ['orders.fbsGet', 'orders.fbsGet', 'orders.fbsGet', 'orders.fbsList'],
    );
    assert.equal(backgroundTasks.length, 4);
    assert.match(result.message, /后台回读已排队/u);
  } finally {
    db.close();
  }
});

test('order split relation is reconciled after background child readback reaches SQLite', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_reconcile');
    const repository = createOrderRepository(db);

    repository.upsertSplitRelation({
      shopId,
      parentPostingNumber: 'parent-reconcile',
      childPostingNumbers: ['child-reconcile-1', 'child-reconcile-2'],
      splitQuantities: [
        { offer_id: 'offer-1', quantity: 1 },
        { offer_id: 'offer-1', quantity: 1 },
      ],
      readbackStatus: 'pending',
      status: 'submitted_waiting_readback',
      childrenConfirmed: false,
    });

    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [orderRow('child-reconcile-1', { products: [{ offer_id: 'offer-1', quantity: 1 }] })],
    });
    const partial = repository.reconcileSplitRelationsFromReadback({
      shopId,
      rows: [orderRow('child-reconcile-1')],
    });
    assert.equal(partial.changed, 1);
    assert.equal(partial.relations[0].readbackStatus, 'partial');
    assert.equal(partial.relations[0].childrenConfirmed, false);

    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [orderRow('child-reconcile-2', { products: [{ offer_id: 'offer-1', quantity: 1 }] })],
    });
    const merged = repository.reconcileSplitRelationsFromReadback({
      shopId,
      rows: [orderRow('child-reconcile-2')],
    });

    assert.equal(merged.changed, 1);
    assert.equal(merged.relations[0].readbackStatus, 'merged');
    assert.equal(merged.relations[0].status, 'readback_merged');
    assert.equal(merged.relations[0].childrenConfirmed, true);
    assert.equal(merged.relations[0].readBackRows.length, 2);
  } finally {
    db.close();
  }
});

test('order split relation reconcile counts visible parent quantity with child quantities', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_reconcile_parent_visible_quantity');
    const repository = createOrderRepository(db);

    repository.upsertSplitRelation({
      shopId,
      parentPostingNumber: 'parent-visible-qty',
      childPostingNumbers: ['child-visible-qty-1', 'child-visible-qty-2'],
      splitQuantities: [
        { posting_number: 'parent-visible-qty', offer_id: 'offer-1', quantity: 1 },
        { posting_number: 'child-visible-qty-1', offer_id: 'offer-1', quantity: 1 },
        { posting_number: 'child-visible-qty-2', offer_id: 'offer-1', quantity: 1 },
      ],
      readbackStatus: 'pending',
      status: 'submitted_waiting_readback',
      childrenConfirmed: false,
    });

    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [
        orderRow('parent-visible-qty', { products: [{ offer_id: 'offer-1', quantity: 1 }] }),
        orderRow('child-visible-qty-1', { products: [{ offer_id: 'offer-1', quantity: 1 }] }),
        orderRow('child-visible-qty-2', { products: [{ offer_id: 'offer-1', quantity: 1 }] }),
      ],
    });

    const result = repository.reconcileSplitRelationsFromReadback({
      shopId,
      rows: [orderRow('parent-visible-qty'), orderRow('child-visible-qty-1'), orderRow('child-visible-qty-2')],
      parentVisibilityChecked: true,
    });

    assert.equal(result.changed, 1);
    assert.equal(result.relations[0].readbackStatus, 'merged');
    assert.equal(result.relations[0].status, 'readback_merged');
    assert.equal(result.relations[0].parentOzonVisible, true);
    assert.equal(result.relations[0].mismatchReason, null);
  } finally {
    db.close();
  }
});

test('orders test split simulation persists child rows and merged split relation to SQLite only for test orders', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_split_test_simulation');
    const repository = createOrderRepository(db);
    repository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: [
        {
          ...orderRow('TEST-SPLIT-0001-1', {
            order_id: 'TEST-SPLIT-ORDER-0001',
            products: [{ offer_id: 'mz-split-test-001', product_id: 4213816529, quantity: 3, price: '99.00' }],
          }),
          order_number: 'TEST-SPLIT-ORDER-0001',
          uiTestOrder: true,
          splitUiTestOrder: true,
          financial_data: { products: [{ offer_id: 'mz-split-test-001', quantity: 3, price: '99.00' }] },
        },
        orderRow('real-parent-1', { products: [{ offer_id: 'offer-real', quantity: 2, price: '10.00' }] }),
      ],
    });

    const service = createOrdersService({ db, ozonScheduler: { async executeReadOnly() { return { ok: true, data: {} }; } } });
    const result = service.simulateTestSplit({
      shopId,
      postingNumber: 'TEST-SPLIT-0001-1',
      splitQuantities: [1, 1, 1],
    });

    assert.equal(result.ok, true);
    assert.equal(result.writeStatus, 'readback_merged');
    assert.deepEqual(result.resultPostingNumbers, ['TEST-SPLIT-0001-1', 'TEST-SPLIT-0001-2', 'TEST-SPLIT-0001-3']);
    assert.deepEqual(result.childPostingNumbers, ['TEST-SPLIT-0001-2', 'TEST-SPLIT-0001-3']);
    assert.equal(result.splitRelation.readbackStatus, 'merged');
    assert.equal(result.splitRelation.childrenConfirmed, true);
    assert.equal(result.splitRelation.parentOzonVisible, true);

    const page = repository.listOrders({ shopId, pageSize: 20 });
    const parent = page.rows.find((row) => row.posting_number === 'TEST-SPLIT-0001-1');
    const children = page.rows.filter(
      (row) => row.splitRole === 'child' && row.splitParentPostingNumber === 'TEST-SPLIT-0001-1',
    );
    assert.equal(children.length, 2);
    assert.equal(parent.splitBusinessLocked, false);
    assert.equal(parent.splitDefaultBusinessHidden, false);
    assert.equal(parent.products[0].quantity, 1);
    assert.equal(parent.products[0].qty, 1);
    assert.equal(parent.items, 1);
    assert.equal(parent.quantity, 1);
    assert.equal(children.every((row) => row.splitRole === 'child'), true);
    assert.equal(children.every((row) => row.products[0].quantity === 1), true);
    assert.equal(children.every((row) => row.items === 1), true);
    assert.equal(children.every((row) => row.quantity === 1), true);

    const blocked = service.simulateTestSplit({
      shopId,
      postingNumber: 'real-parent-1',
      splitQuantities: [1, 1],
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'ORDER_TEST_SPLIT_REAL_ORDER_BLOCKED');
  } finally {
    db.close();
  }
});

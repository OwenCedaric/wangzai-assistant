import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createProfitLedgerSnapshotRepository } from '../../db/repositories/profitLedgerSnapshotRepository.js';
import { createProfitOrderReviewReadModel } from './profitOrderReviewReadModel.js';

function ledgerRow({ orderNumber, sku, shopId = 'shop-a', profit = 20, sales = 100, date = '2026-07-20' }) {
  return {
    ledgerKey: `${shopId}:${orderNumber}`,
    orderKey: `${shopId}:${orderNumber}`,
    shopId,
    orderSnapshot: {
      id: orderNumber,
      posting: orderNumber,
      salesOrder: orderNumber,
      shopId,
      product: `商品 ${sku}`,
      sku,
      paymentDate: date,
      products: [{ sku, name: `商品 ${sku}`, qty: 1 }],
    },
    amounts: {
      salesAmountCny: { status: 'ready', value: sales },
      sourcePurchaseCostCny: { status: 'ready', value: 50 },
    },
    results: {
      actualProfitCny: { status: 'ready', value: profit, formula: '测试公式' },
      estimatedProfitCny: { status: 'ready', value: profit },
    },
  };
}

test('profit order review finds one order and returns same-shop product history only', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProfitLedgerSnapshotRepository(db, { now: () => '2026-07-31T00:00:00.000Z' });
    repository.saveSnapshot({
      snapshotKey: 'ozon-profit-ledger-v1:shop-a:range:2026-05-01_2026-07-31:filter:all',
      snapshot: {
        sourceKey: 'shop-a',
        calculationVersion: 'profit-ledger-v8',
        rows: [
          ledgerRow({ orderNumber: '123456-7890-1', sku: '900001', profit: -8, date: '2026-07-30' }),
          ledgerRow({ orderNumber: '123456-7888-1', sku: '900001', profit: 18, date: '2026-07-20' }),
          ledgerRow({ orderNumber: '123456-7777-1', sku: '900002', profit: 30, date: '2026-07-10' }),
          ledgerRow({ orderNumber: '123456-7666-1', sku: '900001', shopId: 'shop-b', profit: 99 }),
        ],
      },
    });

    const result = createProfitOrderReviewReadModel(db).read({
      orderNumber: '123456-7890-1',
      shopIds: ['shop-a'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.equal(result.ledgerRow.orderSnapshot.sku, '900001');
    assert.deepEqual(
      result.relatedLedgerRows.map((row) => row.orderSnapshot.posting),
      ['123456-7890-1', '123456-7888-1'],
    );
    assert.equal(JSON.stringify(result).includes('123456-7666-1'), false);
  } finally {
    db.close();
  }
});

test('profit order review reports an empty ledger instead of inventing an order', () => {
  const db = createMigratedTestDb();
  try {
    const result = createProfitOrderReviewReadModel(db).read({ orderNumber: 'missing-order', shopIds: 'shop-a' });
    assert.equal(result.ok, true);
    assert.equal(result.found, false);
    assert.match(result.message, /没有利润账本数据/u);
  } finally {
    db.close();
  }
});

test('profit review ignores newer uncommitted chunks and preserves identical order numbers in different shops', () => {
  const db = createMigratedTestDb();
  try {
    let tick = 0;
    const repo = createProfitLedgerSnapshotRepository(db, { now: () => `2026-09-04T10:00:0${tick++}.000Z` });
    const a = ledgerRow({ orderNumber: '123456-7890-1', sku: 'one', shopId: 'shop-a', profit: 3.88 });
    const b = ledgerRow({ orderNumber: '123456-7890-1', sku: 'two', shopId: 'shop-b', profit: 9 });
    a.ledgerKey = b.ledgerKey = 'same-legacy-key';
    repo.saveSnapshot({ snapshotKey: 'all', snapshot: { rows: [a, b] } });
    const broken = structuredClone(a); broken.results.actualProfitCny = { value: null, status: 'pending' };
    repo.saveSnapshot({ snapshotKey: 'all::chunk:unpublished:0', chunkOf: 'all', writeId: 'unpublished', chunkIndex: 0, chunkCount: 2, snapshot: { rows: [broken] } });
    const model = createProfitOrderReviewReadModel(db);
    assert.equal(model.read({ orderNumber: '123456-7890-1', shopIds: ['shop-a'] }).ledgerRow.results.actualProfitCny.value, 3.88);
    assert.equal(model.read({ orderNumber: '123456-7890-1', shopIds: ['shop-b'] }).ledgerRow.results.actualProfitCny.value, 9);
  } finally { db.close(); }
});

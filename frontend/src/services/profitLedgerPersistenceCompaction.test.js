import { describe, expect, it } from 'vitest';
import { createProfitOrderFromLedgerRow } from '../entities/profit/profitDisplayRules.jsx';
import {
  compactProfitLedgerSnapshotForPersistence,
  createProfitLedgerPersistencePlan,
  PROFIT_LEDGER_CHUNK_TARGET_BYTES,
} from './profitLedgerPersistenceCompaction.js';

function fixtureRow(index = 1) {
  const key = `shop-a:posting-${index}`;
  return {
    schemaVersion: 1,
    calculationVersion: 'profit-ledger-v16-per-order-finance-exchange-rate',
    ledgerKey: key,
    orderKey: key,
    shopId: 'shop-a',
    shopClientId: 'client-a',
    actualFinanceStatus: 'confirmed',
    hasActualFinance: true,
    financeLookupChecked: true,
    exchangeRate: { mode: 'daily', base: 'RUB', quote: 'CNY', rubToCnyRate: 0.09, raw: 'x'.repeat(1000) },
    estimatedExchangeRate: { mode: 'daily', base: 'RUB', quote: 'CNY', rubToCnyRate: 0.09 },
    actualExchangeRate: { mode: 'finance', base: 'RUB', quote: 'CNY', rubToCnyRate: 0.091 },
    exchangeRates: {
      estimated: { mode: 'daily', base: 'RUB', quote: 'CNY', rubToCnyRate: 0.09 },
      actual: { mode: 'finance', base: 'RUB', quote: 'CNY', rubToCnyRate: 0.091 },
    },
    orderSnapshot: {
      id: `posting-${index}`,
      posting: `posting-${index}`,
      salesOrder: `order-${index}`,
      recordKey: key,
      profitRecordKey: key,
      shop: 'Ozon 1店',
      shopId: 'shop-a',
      shopClientId: 'client-a',
      status: 'delivered',
      statusLabel: '成功订单',
      paymentDate: '2026-08-30T00:00:00.000Z',
      fulfillment: 'FBS',
      product: '测试商品',
      offerId: 'offer-1',
      sku: 'sku-1',
      currencyCode: 'CNY',
      searchText: 'x'.repeat(1000),
      products: [{
        name: '测试商品', offerId: 'offer-1', sku: 'sku-1', productId: 'product-1',
        qty: 1, weight: '0.45', length: '21.9', width: '15.9', height: '6.9',
        image: 'https://example.invalid/main.jpg', images: Array(4).fill('https://example.invalid/large.jpg'),
      }],
    },
    amounts: {
      salesAmountCny: { value: 136.89, status: 'ready', source: 'ozon-order', evidence: { raw: 'x'.repeat(1000) } },
      logisticsFeeCny: { value: 25.5, status: 'ready', source: 'local-logistics' },
      actualCrossBorderBusFeeCny: {
        value: 1.2,
        status: 'ready',
        source: 'cross-border-charge-exact',
        evidence: {
          source: 'cross-border-charge-exact', collectionNumber: 'collection-1',
          sourceHash: 'hash-1', actualFeeCny: 1.2, collections: 'x'.repeat(8000),
        },
      },
    },
    results: {
      estimatedProfitCny: { value: 100, status: 'ready', formula: 'estimate', updatedAt: 'now' },
      actualProfitCny: { value: 90, status: 'ready', formula: 'actual', updatedAt: 'now' },
      refundLossCny: { value: null, status: 'pending', reason: '无退款', missing: ['refund'] },
      bestProfitCny: { value: 90, status: 'ready', formula: 'actual' },
    },
    status: 'profit',
  };
}

describe('profit ledger persistence compaction', () => {
  it('keeps first-screen identity, profit, image and material facts while dropping rebuildable bulk', () => {
    const source = { rows: [fixtureRow()], penaltyDetails: {}, fetchedAt: '2026-08-30T00:00:00.000Z' };
    const compact = compactProfitLedgerSnapshotForPersistence(source);
    const row = compact.rows[0];
    const restored = createProfitOrderFromLedgerRow(row);

    expect(restored).toMatchObject({
      posting: 'posting-1',
      shop: 'Ozon 1店',
      product: '测试商品',
      actualProfitValue: 90,
    });
    expect(restored.products[0]).toMatchObject({
      image: 'https://example.invalid/main.jpg',
      weight: '0.45',
      length: '21.9',
      width: '15.9',
      height: '6.9',
    });
    expect(row.amounts.actualCrossBorderBusFeeCny.evidence).toEqual({
      source: 'cross-border-charge-exact',
      collectionNumber: 'collection-1',
      sourceHash: 'hash-1',
      actualFeeCny: 1.2,
    });
    expect(JSON.stringify(compact)).not.toContain('collections');
    expect(JSON.stringify(compact)).not.toContain('searchText');
  });

  it('keeps a 1,565-order restart snapshot below the dedicated 16 MiB transport boundary', () => {
    const rows = Array.from({ length: 1565 }, (_, index) => fixtureRow(index + 1));
    const compact = compactProfitLedgerSnapshotForPersistence({ rows, penaltyDetails: {} });
    expect(new TextEncoder().encode(JSON.stringify(compact)).byteLength).toBeLessThan(16 * 1024 * 1024);
    expect(compact.rows).toHaveLength(1565);
  });

  it('splits an arbitrarily large order set without imposing a total row or byte limit', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => fixtureRow(index + 1));
    const plan = createProfitLedgerPersistencePlan({ rows, penaltyDetails: {} });
    expect(plan.rowCount).toBe(10_000);
    expect(plan.manifest.rows).toEqual([]);
    expect(plan.chunks.flatMap((chunk) => chunk.rows)).toHaveLength(10_000);
    plan.chunks.forEach((chunk) => {
      expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength)
        .toBeLessThan(PROFIT_LEDGER_CHUNK_TARGET_BYTES + 32 * 1024);
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  createProfitLedgerPersistenceComparableRow,
  mergeProfitProductSupplementRows,
  selectProfitProductSupplementBatch,
  shouldCountProfitMaterialGap,
} from './profitProductSupplementRules.js';

describe('profit product supplement batching', () => {
  it('ignores display-only image changes when deciding whether the full profit ledger must be persisted', () => {
    const base = {
      ledgerKey: 'order-1',
      orderSnapshot: {
        products: [{ offerId: 'offer-1', commissionPercent: 12, image: 'https://img.example/old.jpg' }],
      },
    };
    const imageChanged = {
      ...base,
      orderSnapshot: {
        products: [{ offerId: 'offer-1', commissionPercent: 12, image: 'https://img.example/new.jpg' }],
      },
    };
    const financeChanged = {
      ...base,
      orderSnapshot: {
        products: [{ offerId: 'offer-1', commissionPercent: 15, image: 'https://img.example/old.jpg' }],
      },
    };

    expect(createProfitLedgerPersistenceComparableRow(imageChanged)).toEqual(
      createProfitLedgerPersistenceComparableRow(base)
    );
    expect(createProfitLedgerPersistenceComparableRow(financeChanged)).not.toEqual(
      createProfitLedgerPersistenceComparableRow(base)
    );
  });

  it('keeps cached product images when a later order snapshot contains the same product without images', () => {
    const merged = mergeProfitProductSupplementRows(
      {
        id: '0103890597-0049-2',
        products: [{
          offerId: 'mz-26050711-236435',
          skuId: '4212716913',
          productId: '4473807935',
          image: 'https://img.example.test/product.jpg',
          skuImage: 'https://img.example.test/product.jpg',
          primaryImage: 'https://img.example.test/product.jpg',
          images: ['https://img.example.test/product.jpg'],
        }],
      },
      {
        id: '0103890597-0049-2',
        products: [{
          offerId: 'mz-26050711-236435',
          skuId: '4212716913',
          image: '',
          images: [],
        }],
      }
    );

    expect(merged.products).toHaveLength(1);
    expect(merged.products[0]).toMatchObject({
      image: 'https://img.example.test/product.jpg',
      skuImage: 'https://img.example.test/product.jpg',
      primaryImage: 'https://img.example.test/product.jpg',
      images: ['https://img.example.test/product.jpg'],
    });
  });

  it('prioritizes every visible order and bounds only background work', () => {
    const visibleOrders = [{ id: 'visible-1', gap: 1 }, { id: 'visible-2', gap: 1 }];
    const profitRows = [
      ...visibleOrders,
      ...Array.from({ length: 5 }, (_, index) => ({ id: `background-${index + 1}`, gap: 1 })),
    ];
    const result = selectProfitProductSupplementBatch({
      visibleOrders,
      profitRows,
      getRecordKey: (row) => row.id,
      getGapCount: (row) => row.gap,
      backgroundBatchSize: 2,
    });

    expect(result.rows.map((row) => row.id)).toEqual([
      'visible-1',
      'visible-2',
      'background-1',
      'background-2',
    ]);
    expect(result.deferredCount).toBe(3);
  });

  it('uses already enriched rows and advances past completed background work', () => {
    const enhancedRowsByKey = new Map([
      ['background-1', { id: 'background-1', gap: 0 }],
    ]);
    const result = selectProfitProductSupplementBatch({
      visibleOrders: [],
      profitRows: [{ id: 'background-1', gap: 1 }, { id: 'background-2', gap: 1 }],
      enhancedRowsByKey,
      getRecordKey: (row) => row.id,
      getGapCount: (row) => row.gap,
      backgroundBatchSize: 1,
    });

    expect(result.rows.map((row) => row.id)).toEqual(['background-2']);
    expect(result.deferredCount).toBe(0);
  });

  it('requires material facts for an offscreen order when logistics is pending', () => {
    expect(shouldCountProfitMaterialGap({ materialGap: true, logisticsDependencyMissing: true })).toBe(true);
    expect(shouldCountProfitMaterialGap({ materialGap: true, logisticsDependencyMissing: false })).toBe(false);
    expect(shouldCountProfitMaterialGap({ materialGap: true, includeVisibleFields: true })).toBe(true);
  });
});

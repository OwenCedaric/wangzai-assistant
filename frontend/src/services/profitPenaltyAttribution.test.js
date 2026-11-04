import { describe, expect, it } from 'vitest';
import { buildProfitPenaltyAttributionIndex, mergeProfitPenaltyOperationIndexes } from './profitPenaltyAttribution.js';
import { getProfitPenaltyDetails } from './profitFinanceBreakdown.js';

function readPenaltyTotal(index, postingNumber) {
  const operations = index.get(postingNumber) ?? [];
  return getProfitPenaltyDetails(operations).totalCny;
}

describe('profitPenaltyAttribution', () => {
  const childRows = [
    { id: '0122157650-0182-1', shopClientId: '4616153', amountValue: 47, qty: 1 },
    { id: '0122157650-0182-3', shopClientId: '4616153', amountValue: 47, qty: 1 },
  ];

  it('restores ready local rating penalties to their exact child posting rows', () => {
    const index = buildProfitPenaltyAttributionIndex(childRows, {
      'penalty-child-1': {
        operationId: 'rating-child-1',
        postingNumber: '0122157650-0182-1',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 6.35,
        status: 'ready',
      },
      'penalty-child-3': {
        operationId: 'rating-child-3',
        postingNumber: '0122157650-0182-3',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 6.35,
        status: 'ready',
      },
    });

    expect(readPenaltyTotal(index, '0122157650-0182-1')).toBe(6.35);
    expect(readPenaltyTotal(index, '0122157650-0182-3')).toBe(6.35);
  });

  it('allocates a parent-only penalty across all child rows in the same shop group', () => {
    const index = buildProfitPenaltyAttributionIndex(childRows, {
      'parent-penalty': {
        operationId: 'rating-parent',
        postingNumber: '0122157650-0182',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 12.7,
        status: 'ready',
      },
    });

    expect(readPenaltyTotal(index, '0122157650-0182-1')).toBe(6.35);
    expect(readPenaltyTotal(index, '0122157650-0182-3')).toBe(6.35);
    expect(readPenaltyTotal(index, '0122157650-0182')).toBe(12.7);
  });

  it('does not allocate a parent summary again when child penalties already equal it', () => {
    const index = buildProfitPenaltyAttributionIndex(childRows, {
      'parent-summary': {
        operationId: 'rating-parent-summary',
        postingNumber: '0122157650-0182',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 12.7,
        status: 'ready',
      },
      'child-1': {
        operationId: 'rating-child-1',
        postingNumber: '0122157650-0182-1',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 6.35,
        status: 'ready',
      },
      'child-3': {
        operationId: 'rating-child-3',
        postingNumber: '0122157650-0182-3',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 6.35,
        status: 'ready',
      },
    });

    expect(readPenaltyTotal(index, '0122157650-0182-1')).toBe(6.35);
    expect(readPenaltyTotal(index, '0122157650-0182-3')).toBe(6.35);
  });

  it('allocates only the parent extra amount when parent total exceeds exact child penalties', () => {
    const index = buildProfitPenaltyAttributionIndex(childRows, {
      'parent-extra': {
        operationId: 'rating-parent-extra',
        postingNumber: '0122157650-0182',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 16.7,
        status: 'ready',
      },
      'child-1': {
        operationId: 'rating-child-1',
        postingNumber: '0122157650-0182-1',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 6.35,
        status: 'ready',
      },
      'child-3': {
        operationId: 'rating-child-3',
        postingNumber: '0122157650-0182-3',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 6.35,
        status: 'ready',
      },
    });

    expect(readPenaltyTotal(index, '0122157650-0182-1')).toBe(8.35);
    expect(readPenaltyTotal(index, '0122157650-0182-3')).toBe(8.35);
  });

  it('keeps shop scopes isolated when parent numbers are the same', () => {
    const rows = [
      { id: '0122157650-0182-1', shopClientId: '4616153', amountValue: 47 },
      { id: '0122157650-0182-1', shopClientId: '4917820', amountValue: 47 },
    ];
    const index = buildProfitPenaltyAttributionIndex(rows, {
      'parent-shop-1': {
        operationId: 'rating-parent-shop-1',
        postingNumber: '0122157650-0182',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 9,
        status: 'ready',
      },
    });

    expect(readPenaltyTotal(index, '0122157650-0182-1')).toBe(9);
    expect(index.get('4917820:0122157650-0182-1')).toBeUndefined();
  });

  it('deduplicates local and fresh indexes by operation id when merging', () => {
    const local = buildProfitPenaltyAttributionIndex(childRows, {
      local: {
        operationId: 'same-operation',
        postingNumber: '0122157650-0182-1',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 6.35,
        status: 'ready',
      },
    });
    const fresh = buildProfitPenaltyAttributionIndex(childRows, {
      fresh: {
        operationId: 'same-operation',
        postingNumber: '0122157650-0182-1',
        shopClientId: '4616153',
        operationName: 'SELLER_CANCELLATION',
        amountCny: 6.35,
        status: 'ready',
      },
    });

    const merged = mergeProfitPenaltyOperationIndexes(local, fresh);

    expect(merged.get('0122157650-0182-1')).toHaveLength(1);
    expect(readPenaltyTotal(merged, '0122157650-0182-1')).toBe(6.35);
  });
});

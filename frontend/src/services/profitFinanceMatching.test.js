import { describe, expect, it } from 'vitest';
import {
  buildFinanceParentFallbackIndex,
  canUseFinanceParentFallback,
  getFinancePostingLookupGroups,
  selectFinanceOperationsExactFirst,
} from './profitFinanceMatching.js';

describe('profitFinanceMatching', () => {
  const getDedupKey = (operation) => operation.id;

  it('uses exact child posting finance rows before parent rows', () => {
    const groups = getFinancePostingLookupGroups(['0161421428-0139-4'], {
      fallbackValues: ['0161421428-0139'],
    });
    const financeIndex = new Map([
      ['0161421428-0139-4', [{ id: 'child-4', amount: -67.5 }]],
      ['0161421428-0139-5', [{ id: 'child-5', amount: -67.8 }]],
      ['0161421428-0139', [{ id: 'parent-total', amount: -135.3 }]],
    ]);

    const operations = selectFinanceOperationsExactFirst(groups, financeIndex, { getDedupKey });

    expect(operations).toEqual([{ id: 'child-4', amount: -67.5 }]);
  });

  it('does not copy parent aggregate finance rows into a child posting by default', () => {
    const groups = getFinancePostingLookupGroups(['0161421428-0139-4'], {
      fallbackValues: ['0161421428-0139'],
    });
    const financeIndex = new Map([['0161421428-0139', [{ id: 'parent-total', amount: -135.3 }]]]);

    const operations = selectFinanceOperationsExactFirst(groups, financeIndex, { getDedupKey });

    expect(operations).toEqual([]);
  });

  it('still allows a parent posting row to use parent finance rows', () => {
    const groups = getFinancePostingLookupGroups(['0161421428-0139']);
    const financeIndex = new Map([['0161421428-0139', [{ id: 'parent-total', amount: -135.3 }]]]);

    const operations = selectFinanceOperationsExactFirst(groups, financeIndex, { getDedupKey });

    expect(operations).toEqual([{ id: 'parent-total', amount: -135.3 }]);
  });

  it('allows parent finance fallback for a single known child posting', () => {
    const order = {
      id: '0125258891-0624-1',
      posting: '0125258891-0624-1',
      softwareOrderId: '0125258891-0624',
      shopClientId: '4616153',
      recordKey: '4616153:0125258891-0624-1',
    };
    const groups = getFinancePostingLookupGroups(['0125258891-0624-1'], {
      fallbackValues: ['0125258891-0624'],
    });
    const financeIndex = new Map([['0125258891-0624', [{ id: 'parent-deduction', amount: -84.2 }]]]);
    const parentFallbackIndex = buildFinanceParentFallbackIndex([order]);
    const allowParentFallbackForChild = canUseFinanceParentFallback(order, groups, financeIndex, parentFallbackIndex);

    const operations = selectFinanceOperationsExactFirst(groups, financeIndex, {
      getDedupKey,
      allowParentFallbackForChild,
    });

    expect(allowParentFallbackForChild).toBe(true);
    expect(operations).toEqual([{ id: 'parent-deduction', amount: -84.2 }]);
  });

  it('can merge exact child finance rows with safe parent supplement rows', () => {
    const order = {
      id: '0139229900-0042-1',
      posting: '0139229900-0042-1',
      softwareOrderId: '0139229900-0042',
      shopClientId: '4616153',
      recordKey: '4616153:0139229900-0042-1',
    };
    const groups = getFinancePostingLookupGroups(['0139229900-0042-1'], {
      fallbackValues: ['0139229900-0042'],
    });
    const financeIndex = new Map([
      [
        '0139229900-0042-1',
        [
          { id: 'child-sale', amount: 540.27 },
          { id: 'child-delivery-redistribution', amount: -220.11 },
        ],
      ],
      ['0139229900-0042', [{ id: 'parent-acquiring', amount: -1.55 }]],
    ]);
    const parentFallbackIndex = buildFinanceParentFallbackIndex([order]);
    const allowParentFallbackForChild = canUseFinanceParentFallback(order, groups, financeIndex, parentFallbackIndex, {
      allowWhenExactExists: true,
    });

    const operations = selectFinanceOperationsExactFirst(groups, financeIndex, {
      getDedupKey,
      allowParentFallbackForChild,
      includeFallbackWithExact: true,
    });

    expect(allowParentFallbackForChild).toBe(true);
    expect(operations).toEqual([
      { id: 'child-sale', amount: 540.27 },
      { id: 'child-delivery-redistribution', amount: -220.11 },
      { id: 'parent-acquiring', amount: -1.55 },
    ]);
  });

  it('does not parent-fallback when multiple child postings share the same parent', () => {
    const order = {
      id: '09362844-0405-2',
      posting: '09362844-0405-2',
      softwareOrderId: '09362844-0405',
      shopClientId: '4616153',
      recordKey: '4616153:09362844-0405-2',
    };
    const sibling = {
      id: '09362844-0405-3',
      posting: '09362844-0405-3',
      softwareOrderId: '09362844-0405',
      shopClientId: '4616153',
      recordKey: '4616153:09362844-0405-3',
    };
    const groups = getFinancePostingLookupGroups(['09362844-0405-2'], {
      fallbackValues: ['09362844-0405'],
    });
    const financeIndex = new Map([['09362844-0405', [{ id: 'parent-total', amount: -135.3 }]]]);
    const parentFallbackIndex = buildFinanceParentFallbackIndex([order, sibling]);

    expect(canUseFinanceParentFallback(order, groups, financeIndex, parentFallbackIndex)).toBe(false);
    expect(selectFinanceOperationsExactFirst(groups, financeIndex, { getDedupKey })).toEqual([]);
  });
});

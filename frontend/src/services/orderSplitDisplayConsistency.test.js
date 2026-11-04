import { describe, expect, it } from 'vitest';
import { shouldShowAfterSalesOrderInList } from './afterSalesDisplayRules';
import { shouldIncludeOrderInBusinessFlow, shouldShowOrderInOzonDisplayList } from './orderSplitRelationRules';

const parent = {
  posting_number: 'parent-1',
  splitRole: 'parent',
  splitBusinessLocked: true,
  splitDefaultBusinessHidden: true,
  splitRelation: {
    parentPostingNumber: 'parent-1',
    childPostingNumbers: ['child-1', 'child-2'],
    readbackStatus: 'merged',
    parentOzonVisible: null,
    childrenConfirmed: true,
  },
};

const child1 = {
  posting_number: 'child-1',
  splitRole: 'child',
  splitParentPostingNumber: 'parent-1',
};

const child2 = {
  posting_number: 'child-2',
  splitRole: 'child',
  splitParentPostingNumber: 'parent-1',
};

describe('order split display consistency', () => {
  it('uses children for default sales, purchase, and after-sales business display', () => {
    expect(shouldShowOrderInOzonDisplayList(parent)).toBe(false);
    expect(shouldShowOrderInOzonDisplayList(child1)).toBe(true);

    expect(shouldIncludeOrderInBusinessFlow(parent)).toBe(false);
    expect(shouldIncludeOrderInBusinessFlow(child1)).toBe(true);

    expect(shouldShowAfterSalesOrderInList(parent)).toBe(false);
    expect(shouldShowAfterSalesOrderInList(child1)).toBe(true);
    expect(shouldShowAfterSalesOrderInList(child2)).toBe(true);
  });

  it('allows after-sales search to reveal the parent through parent or child posting numbers', () => {
    expect(shouldShowAfterSalesOrderInList(parent, { keyword: 'parent-1' })).toBe(true);
    expect(shouldShowAfterSalesOrderInList(parent, { keyword: 'child-1' })).toBe(true);
    expect(shouldShowAfterSalesOrderInList(parent, { keyword: 'child-2' })).toBe(true);
  });
});

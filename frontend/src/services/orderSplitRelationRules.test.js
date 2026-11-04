import { describe, expect, it } from 'vitest';
import {
  attachSplitRelationFields,
  doesSplitOrderMatchKeyword,
  getSplitOrderLockReason,
  isSplitChildOrder,
  isSplitParentBusinessLocked,
  isSplitParentOrder,
  shouldIncludeOrderInBusinessFlow,
  shouldShowOrderInOzonDisplayList,
} from './orderSplitRelationRules';

describe('order split relation rules', () => {
  it('keeps Ozon-visible split parent displayable and usable as its own posting', () => {
    const parent = {
      posting_number: 'parent-1',
      splitRole: 'parent',
      splitBusinessLocked: false,
      splitDefaultBusinessHidden: false,
      splitReadbackStatus: 'pending',
      splitRelation: {
        parentPostingNumber: 'parent-1',
        childPostingNumbers: ['child-1'],
        parentOzonVisible: true,
      },
    };

    expect(isSplitParentOrder(parent)).toBe(true);
    expect(isSplitParentBusinessLocked(parent)).toBe(false);
    expect(shouldShowOrderInOzonDisplayList(parent)).toBe(true);
    expect(shouldIncludeOrderInBusinessFlow(parent)).toBe(true);
    expect(getSplitOrderLockReason(parent)).toBe('');
  });

  it('hides readback-confirmed parent from default display when Ozon no longer shows it', () => {
    const parent = {
      posting_number: 'parent-1',
      splitRole: 'parent',
      splitBusinessLocked: true,
      splitDefaultBusinessHidden: true,
      splitRelation: {
        parentPostingNumber: 'parent-1',
        childPostingNumbers: ['child-1'],
        readbackStatus: 'merged',
      },
    };

    expect(shouldShowOrderInOzonDisplayList(parent)).toBe(false);
    expect(shouldShowOrderInOzonDisplayList(parent, { keyword: 'parent-1' })).toBe(true);
    expect(shouldShowOrderInOzonDisplayList(parent, { keyword: 'child-1' })).toBe(true);
  });

  it('hides confirmed split parent when Ozon parent visibility is unknown', () => {
    const parent = {
      posting_number: 'parent-unknown',
      splitRole: 'parent',
      splitBusinessLocked: true,
      splitDefaultBusinessHidden: true,
      splitRelation: {
        parentPostingNumber: 'parent-unknown',
        childPostingNumbers: ['child-1'],
        readbackStatus: 'merged',
        parentOzonVisible: null,
        childrenConfirmed: true,
      },
    };

    expect(shouldShowOrderInOzonDisplayList(parent)).toBe(false);
    expect(shouldShowOrderInOzonDisplayList(parent, { keyword: 'parent-unknown' })).toBe(true);
    expect(shouldShowOrderInOzonDisplayList(parent, { keyword: 'child-1' })).toBe(true);
    expect(shouldIncludeOrderInBusinessFlow(parent)).toBe(false);
  });

  it('passes child split markers through normalized order objects', () => {
    const normalized = attachSplitRelationFields(
      { posting_number: 'child-1' },
      {
        posting_number: 'child-1',
        splitRole: 'child',
        splitRelation: {
          parentPostingNumber: 'parent-1',
          childPostingNumbers: ['child-1'],
          readbackStatus: 'merged',
        },
      }
    );

    expect(isSplitChildOrder(normalized)).toBe(true);
    expect(normalized.splitParentPostingNumber).toBe('parent-1');
    expect(normalized.splitChildPostingNumbers).toEqual(['child-1']);
  });

  it('treats null order input as a safe non-split row', () => {
    expect(isSplitParentOrder(null)).toBe(false);
    expect(isSplitChildOrder(null)).toBe(false);
    expect(isSplitParentBusinessLocked(null)).toBe(false);
    expect(shouldShowOrderInOzonDisplayList(null)).toBe(true);
    expect(shouldIncludeOrderInBusinessFlow(null)).toBe(true);
    expect(getSplitOrderLockReason(null)).toBe('');
    expect(doesSplitOrderMatchKeyword(null, 'parent-1')).toBe(false);
    expect(attachSplitRelationFields(null, null)).toEqual({});
  });
});

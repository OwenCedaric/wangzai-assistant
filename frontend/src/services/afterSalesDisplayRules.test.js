import { describe, expect, it } from 'vitest';
import {
  canOperateAfterSalesOrder,
  getAfterSalesPendingRemovalReason,
  getAfterSalesFulfillment,
  shouldShowAfterSalesOrderInList,
  shouldShowAfterSalesOrderInPendingList,
} from './afterSalesDisplayRules';

const splitParent = {
  id: 'return-parent-1',
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

const splitChild = {
  id: 'return-child-1',
  posting_number: 'child-1',
  splitRole: 'child',
  splitParentPostingNumber: 'parent-1',
};

describe('after-sales display rules', () => {
  it('reads fulfillment from normalized rows, raw Ozon rows, and rFBS sources', () => {
    expect(getAfterSalesFulfillment({ fulfillment: 'FBS' })).toBe('FBS');
    expect(getAfterSalesFulfillment({ raw: { delivery_schema: 'FBO' } })).toBe('FBO');
    expect(getAfterSalesFulfillment({ source: 'rfbs-return' })).toBe('rFBS');
    expect(getAfterSalesFulfillment({})).toBe('');
  });

  it('keeps normal after-sales rows visible and excludes explicit hidden rows', () => {
    expect(shouldShowAfterSalesOrderInList({ id: 'return-normal-1', posting_number: 'normal-1' })).toBe(true);
    expect(
      shouldShowAfterSalesOrderInList({
        id: 'return-hidden-1',
        posting_number: 'hidden-1',
        excludeFromAfterSales: true,
      })
    ).toBe(false);
  });

  it('hides confirmed split parents by default while keeping split children visible', () => {
    expect(shouldShowAfterSalesOrderInList(splitParent)).toBe(false);
    expect(shouldShowAfterSalesOrderInList(splitChild)).toBe(true);
  });

  it('reveals hidden split parent rows when searching the parent or child posting number', () => {
    expect(shouldShowAfterSalesOrderInList(splitParent, { keyword: 'parent-1' })).toBe(true);
    expect(shouldShowAfterSalesOrderInList(splitParent, { keyword: 'child-1' })).toBe(true);
  });

  it('treats unknown parent Ozon visibility as hidden after children are confirmed', () => {
    expect(shouldShowAfterSalesOrderInList(splitParent)).toBe(false);
  });

  it('keeps Ozon-visible split parents displayable and operable as real postings', () => {
    const visibleParent = {
      ...splitParent,
      splitBusinessLocked: false,
      splitDefaultBusinessHidden: false,
      splitRelation: {
        ...splitParent.splitRelation,
        parentOzonVisible: true,
      },
    };

    expect(shouldShowAfterSalesOrderInList(visibleParent)).toBe(true);
    expect(canOperateAfterSalesOrder(visibleParent)).toBe(true);
    expect(canOperateAfterSalesOrder(splitChild)).toBe(true);
  });

  it('filters a realistic after-sales fixture through the same default and search behavior', () => {
    const normalAfterSales = { id: 'return-normal-1', posting_number: 'normal-1' };
    const rows = [normalAfterSales, splitParent, splitChild];

    const defaultVisible = rows.filter((row) => shouldShowAfterSalesOrderInList(row, { keyword: '' }));
    expect(defaultVisible).toEqual([normalAfterSales, splitChild]);

    const searchParentVisible = rows.filter((row) => shouldShowAfterSalesOrderInList(row, { keyword: 'parent-1' }));
    expect(searchParentVisible).toContain(splitParent);

    const searchChildVisible = rows.filter((row) => shouldShowAfterSalesOrderInList(row, { keyword: 'child-2' }));
    expect(searchChildVisible).toContain(splitParent);
  });

  it('keeps unresolved and partial-refund after-sales orders in the pending list', () => {
    expect(shouldShowAfterSalesOrderInPendingList({ id: 'pending-1', raw: { status: 'processing' } })).toBe(true);
    expect(
      shouldShowAfterSalesOrderInPendingList({
        id: 'partial-1',
        refundStatus: 'partially_refunded',
        financeRefundConfirmed: true,
      })
    ).toBe(true);
  });

  it('removes an order when an individual Ozon refund field explicitly says refunded', () => {
    const row = {
      id: 'ozon-refunded-while-utilizing',
      status: '拒收后退款',
      refundStatus: '已退款',
      raw: {
        status: 'Utilizing',
        state: { state: 'Utilizing', state_name: 'На утилизации' },
      },
    };

    expect(getAfterSalesPendingRemovalReason(row)).toBe('full-refund-completed');
    expect(shouldShowAfterSalesOrderInPendingList(row)).toBe(false);
  });

  it('does not remove partial or in-progress refunds', () => {
    expect(
      shouldShowAfterSalesOrderInPendingList({
        id: 'partial-refund',
        refundStatus: '部分退款',
        raw: { status: 'PartialCompensationReturned' },
      })
    ).toBe(true);
    expect(
      shouldShowAfterSalesOrderInPendingList({
        id: 'refund-in-progress',
        refundStatus: '退款处理中',
        raw: { status: 'processing' },
      })
    ).toBe(true);
  });

  it('removes a delivered order after Ozon has completed the partial compensation', () => {
    const row = {
      id: '67185500-0317-1',
      originalOrderStatus: 'delivered',
      originalOrderSubstatus: 'posting_received',
      raw: {
        status: 'PartialCompensationReturned',
        state: {
          state: 'PartialCompensationReturned',
          state_name: 'Компенсировали покупателю',
        },
      },
    };

    expect(getAfterSalesPendingRemovalReason(row)).toBe('partial-compensation-completed');
    expect(shouldShowAfterSalesOrderInPendingList(row)).toBe(false);
    expect(shouldShowAfterSalesOrderInList(row)).toBe(true);
  });

  it('keeps partial compensation visible until the original order is confirmed delivered', () => {
    expect(
      shouldShowAfterSalesOrderInPendingList({
        id: 'partial-compensation-in-flight',
        originalOrderStatus: 'delivering',
        raw: { status: 'PartialCompensationReturned' },
      })
    ).toBe(true);
  });

  it('removes only confirmed terminal rows from the pending after-sales list', () => {
    const cases = [
      [{ id: 'refunded-1', state: { state: 'MoneyReturned', state_name: 'Деньги возвращены' } }, 'full-refund-completed'],
      [{ id: 'refund-closed-1', refund: { status: 'closed' } }, 'refund-closed'],
      [{ id: 'completed-1', raw: { status: 'completed' } }, 'order-completed'],
    ];

    cases.forEach(([row, reason]) => {
      expect(getAfterSalesPendingRemovalReason(row)).toBe(reason);
      expect(shouldShowAfterSalesOrderInPendingList(row)).toBe(false);
      expect(shouldShowAfterSalesOrderInList(row)).toBe(true);
    });
  });

  it('does not treat a delivered original order as a completed after-sales request', () => {
    const row = {
      id: 'delivered-with-refund-pending',
      originalOrderStatus: 'delivered',
      raw: { status: 'returned', refund_status: 'refunding_in_process' },
    };
    expect(getAfterSalesPendingRemovalReason(row)).toBe('');
    expect(shouldShowAfterSalesOrderInPendingList(row)).toBe(true);
    expect(
      shouldShowAfterSalesOrderInPendingList({ id: 'not-completed-1', raw: { status: 'not_completed' } })
    ).toBe(true);
  });
});

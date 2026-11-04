import { describe, expect, it } from 'vitest';
import {
  buildAfterSalesPurchaseOverrideIndex,
  getAfterSalesFinanceCompensationStatus,
  getAfterSalesPurchaseSupport,
  getAfterSalesRefundStatus,
  getAfterSalesRefundTime,
  getAfterSalesResponsibilityParty,
  getAfterSalesSourceLabel,
} from './afterSalesPurchaseSupport';

describe('afterSalesPurchaseSupport', () => {
  it('matches after-sales original posting to SQLite purchase override fields', () => {
    const index = buildAfterSalesPurchaseOverrideIndex([
      {
        shopId: 'shop-1',
        orderKey: '0102118853-0994-1',
        postingNumber: '0102118853-0994-1',
        purchasePlatform: 'PDD',
        purchaseOrderNumber: 'pdd-20260703',
        purchaseOrderUrl: 'https://mms.pinduoduo.com/orders/detail?orderSn=pdd-20260703',
      },
    ]);

    const support = getAfterSalesPurchaseSupport(
      {
        shopId: 'shop-1',
        salesOrder: '0102118853-0994-1',
        raw: { posting_number: '0102118853-0994-1' },
      },
      index
    );

    expect(support).toEqual({
      platform: 'PDD',
      orderNumber: 'pdd-20260703',
      orderUrl: 'https://mms.pinduoduo.com/orders/detail?orderSn=pdd-20260703',
      hasOrderUrl: true,
    });
  });

  it('builds purchase order detail url from cached platform and order number when explicit url is missing', () => {
    const index = buildAfterSalesPurchaseOverrideIndex([
      {
        shopId: 'shop-1',
        orderKey: '0102118853-0994-1',
        purchasePlatform: '天猫',
        purchaseOrderNumber: 'tmall-20260704',
      },
    ]);

    const support = getAfterSalesPurchaseSupport(
      {
        shopId: 'shop-1',
        salesOrder: '0102118853-0994-1',
      },
      index
    );

    expect(support.orderUrl).toContain('bizOrderId=tmall-20260704');
    expect(support.hasOrderUrl).toBe(true);
  });

  it('does not fabricate refund status or time when Ozon did not return them', () => {
    expect(getAfterSalesRefundStatus({ raw: { status: 'returning' } })).toBe('未返回');
    expect(getAfterSalesRefundTime({ raw: { updated_at: '2026-07-03T01:42:00Z' } })).toBe('未返回');
  });

  it('reads refund status and time from explicit Ozon refund fields', () => {
    expect(getAfterSalesRefundStatus({ raw: { refund: { status: 'refunded' } } })).toBe('refunded');
    expect(getAfterSalesRefundTime({ raw: { refund: { refunded_at: '2026-07-03T01:42:00Z' } } })).toContain('07/03');
  });

  it('reads refund status from Ozon money return state and normalized cache fields', () => {
    expect(
      getAfterSalesRefundStatus({
        raw: { state: { money_return_state_name: '已退款给买家' } },
      })
    ).toBe('已退款给买家');
    expect(
      getAfterSalesRefundStatus({
        raw: { state: { state: 'MoneyReturned', state_name: 'Деньги возвращены' } },
      })
    ).toBe('已退款给买家');
    expect(
      getAfterSalesRefundStatus({
        refundStatus: '退款处理中',
        refundTime: '2026-07-03T06:42:00Z',
      })
    ).toBe('退款处理中');
    expect(getAfterSalesRefundTime({ refundTime: '2026-07-03T06:42:00Z' })).toContain('07/03');
  });

  it('uses Ozon cancellation date as refund time for refused-after-delivery returns', () => {
    const order = {
      raw: {
        created_at: '2026-06-30T09:17:31.852508Z',
        state: {
          state: 'Utilizing',
          state_name: 'На утилизации',
          group_state: 'utilization',
          money_return_state_name: '',
        },
      },
    };

    expect(getAfterSalesRefundStatus(order)).toBe('已退款');
    expect(getAfterSalesRefundTime(order)).toContain('06/30');
  });

  it('reads Ozon cancellation fault party as the after-sales responsibility party', () => {
    expect(
      getAfterSalesResponsibilityParty({
        originalOrderCancellation: {
          cancellation_initiator: 'Продавец',
          cancellation_type: 'seller',
        },
      })
    ).toBe('卖家');
    expect(
      getAfterSalesResponsibilityParty({
        raw: {
          originalOrder: {
            cancellation: {
              cancellation_initiator: 'Покупатель',
              cancellation_type: 'buyer',
            },
          },
        },
      })
    ).toBe('买家');
  });

  it('infers buyer responsibility from rFBS refusal reason when Ozon omits explicit fault party', () => {
    expect(
      getAfterSalesResponsibilityParty({
        raw: {
          return_reason: {
            name: 'Покупатель отказался при вручении: товар не подошел',
          },
        },
      })
    ).toBe('买家');
  });

  it('uses finance refund evidence only as checked evidence, not as guessed Ozon return fields', () => {
    expect(getAfterSalesRefundStatus({ financeRefundConfirmed: true })).toBe('已退款（财务流水确认）');
    expect(getAfterSalesRefundStatus({ financeRefundChecked: true, financeRefundConfirmed: false })).toBe(
      '财务未确认退款'
    );
  });

  it('translates after-sales source enums before rendering the detail sidebar', () => {
    expect(getAfterSalesSourceLabel({ source: 'order-cancelled' })).toBe('已取消订单');
    expect(getAfterSalesSourceLabel({ source: 'rfbs-return' })).toBe('退货申请');
    expect(getAfterSalesSourceLabel({ raw: { source: 'conditional' } })).toBe('条件取消');
  });

  it('shows buyer compensation status from finance evidence without changing after-sales classification', () => {
    const order = {
      financeRefundChecked: true,
      financeRefundConfirmed: false,
      financeRefundEvidence: {
        checked: true,
        confirmed: false,
        buyerCompensationConfirmed: true,
        buyerCompensationAmount: -109,
      },
    };

    expect(getAfterSalesFinanceCompensationStatus(order)).toBe('已补偿买家');
    expect(getAfterSalesRefundStatus(order)).toBe('已补偿买家');
  });

  it('detects buyer compensation directly from Ozon finance operations', () => {
    expect(
      getAfterSalesFinanceCompensationStatus({
        financeOperations: [
          {
            operation_type: 'OperationMarketplaceServicePartialCompensationToClient',
            operation_type_name: 'Частичная компенсация покупателю',
            amount: -109,
          },
        ],
      })
    ).toBe('已补偿买家');
    expect(
      getAfterSalesFinanceCompensationStatus({
        financeOperations: [
          {
            operation_type_name: 'Частичная компенсация покупателю',
            amount: -109,
          },
        ],
      })
    ).toBe('已补偿买家');
  });
});

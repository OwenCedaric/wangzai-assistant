import { describe, expect, it } from 'vitest';
import {
  getPurchaseOrderActionFlags,
  getPurchaseOrderShortStatus,
} from '../features/orders/purchase/lib/purchaseImageRules.jsx';
import { purchaseOrderStageTabs } from '../features/orders/purchase/lib/purchaseMarketingApi.jsx';
import {
  derivePurchaseOrderStatus,
  getPurchaseOrderStatusReason,
} from '../features/orders/purchase/lib/purchaseOrderNormalize.jsx';

describe('purchase order status rules', () => {
  it('advances a pre-binding Ozon order after a real paid purchase is captured', () => {
    const status = derivePurchaseOrderStatus({
      ozonStatus: 'awaiting_packaging',
      paymentDate: '2026-07-26T02:43:18.000Z',
      purchaseManagementStartedAt: '2026-08-01T00:00:00.000Z',
      buyerPlatform: '拼多多',
      purchaseOrderNo: '260810-579034202431518',
      purchasePrice: '52.71',
      purchasePriceValue: 52.71,
      purchaseOrderStatus: '待发货',
      purchaseRecordStatus: 'none',
    });

    expect(status).toBe('已拍单-待预报');
  });

  it('keeps a pre-binding Ozon order pending when no paid purchase evidence exists', () => {
    const status = derivePurchaseOrderStatus({
      ozonStatus: 'awaiting_packaging',
      paymentDate: '2026-07-26T02:43:18.000Z',
      purchaseManagementStartedAt: '2026-08-01T00:00:00.000Z',
      buyerPlatform: '待拍单',
      purchaseOrderNo: '',
      purchasePrice: '待确认',
      purchaseOrderStatus: '',
      purchaseRecordStatus: 'none',
    });

    expect(status).toBe('待拍单');
  });

  it('keeps an awaiting-deliver order without local evidence out of the pending purchase list', () => {
    const status = derivePurchaseOrderStatus({
      ozonStatus: 'awaiting_deliver',
      buyerPlatform: '待拍单',
      purchaseOrderNo: '',
      purchasePrice: '待确认',
      purchaseRecordStatus: 'none',
    });

    expect(status).toBe('已拍单-未操作');
  });

  it('keeps a cancelled-purchase override pending only while Ozon is still awaiting packaging', () => {
    expect(derivePurchaseOrderStatus({
      ozonStatus: 'awaiting_packaging',
      forcePurchaseStatus: '待拍单',
      purchaseRecordStatus: 'none',
    })).toBe('待拍单');

    const awaitingDeliver = {
      ozonStatus: 'awaiting_deliver',
      forcePurchaseStatus: '待拍单',
      purchaseRecordStatus: 'none',
    };
    expect(derivePurchaseOrderStatus(awaitingDeliver)).toBe('已拍单-未操作');
    expect(getPurchaseOrderStatusReason(awaitingDeliver)).toContain('旧的“转待拍单”状态已失效');
  });

  it('reclassifies every stale pending override from current Ozon facts instead of one order id', () => {
    const base = { forcePurchaseStatus: '待拍单', purchaseRecordStatus: 'none' };
    expect(derivePurchaseOrderStatus({ ...base, ozonStatus: 'awaiting_deliver' })).toBe('已拍单-未操作');
    expect(derivePurchaseOrderStatus({
      ...base,
      ozonStatus: 'awaiting_deliver',
      crossBorderOrderFound: true,
      crossBorderOrderNumber: 'CB-1001',
    })).toBe('已拍单-待发货');
    expect(derivePurchaseOrderStatus({ ...base, ozonStatus: 'delivering' })).toBe('已拍单-已发货');
    expect(derivePurchaseOrderStatus({ ...base, ozonStatus: 'delivered' })).toBe('完结单');
    expect(derivePurchaseOrderStatus({ ...base, ozonStatus: 'cancelled' })).toBe('关闭单');
    expect(derivePurchaseOrderStatus({ ...base, ozonStatus: 'future_ozon_status' })).toBe('已拍单-未操作');
  });

  it('ignores a stale pending override when a new paid purchase is already confirmed', () => {
    expect(derivePurchaseOrderStatus({
      ozonStatus: 'awaiting_packaging',
      forcePurchaseStatus: '待拍单',
      buyerPlatform: '拼多多',
      purchaseOrderNo: 'PDD-PAID-1',
      purchasePrice: '28.50',
      purchaseOrderStatus: '已付款',
      purchaseRecordStatus: 'none',
    })).toBe('已拍单-待预报');
  });

  it('advances a shipped Ozon order even when local purchase evidence is missing', () => {
    const status = derivePurchaseOrderStatus({
      ozonStatus: 'delivering',
      buyerPlatform: '待拍单',
      purchaseOrderNo: '',
      purchasePrice: '待确认',
      purchaseRecordStatus: 'none',
    });

    expect(status).toBe('已拍单-已发货');
  });

  it('releases a saved unhandled classification after Ozon reports shipment', () => {
    const status = derivePurchaseOrderStatus({
      ozonStatus: 'delivering',
      forcePurchaseStatus: '已拍单-未操作',
      buyerPlatform: '待拍单',
      purchaseOrderNo: '',
      purchasePrice: '待确认',
      purchaseRecordStatus: 'none',
    });

    expect(status).toBe('已拍单-已发货');
  });

  it('keeps closed Ozon orders in a dedicated purchase stage', () => {
    const status = derivePurchaseOrderStatus({
      ozonStatus: 'cancelled',
      purchaseOrderNo: 'tb-closed-1',
      buyerPlatform: '淘宝',
      packageOrderId: 'bus-closed-1',
    });

    expect(status).toBe('关闭单');
    expect(purchaseOrderStageTabs.some((tab) => tab.value === '关闭单')).toBe(true);
    expect(getPurchaseOrderShortStatus(status)).toBe('关闭单');
  });

  it('keeps only archive-safe actions on closed purchase cards', () => {
    const flags = getPurchaseOrderActionFlags({
      status: '关闭单',
      ozonStatus: 'cancelled',
      packageOrderId: 'bus-closed-1',
    });

    expect(flags.showCancelOrder).toBe(false);
    expect(flags.showPurchasePayment).toBe(false);
    expect(flags.showReadCrossBorder).toBe(true);
    expect(flags.showReadVolume).toBe(true);
    expect(flags.showProfitCheck).toBe(true);
  });
});

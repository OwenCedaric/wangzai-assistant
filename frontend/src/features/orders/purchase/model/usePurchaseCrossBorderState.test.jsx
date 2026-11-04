import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePurchaseCrossBorderState } from './usePurchaseCrossBorderState.jsx';

function renderState(overrides = {}) {
  const showPurchaseNotice = vi.fn();
  const openPurchaseOrderWorkbench = vi.fn();
  const result = renderHook(() => usePurchaseCrossBorderState({
    hasSelectedOrder: true,
    selectedSourceLink: 'detail.1688.com/offer/123.html',
    selectedPurchaseOrders: [],
    purchaseOperation: {},
    crossBorderReadByOrderId: {},
    productSourceLinks: {},
    legacyPurchaseSourceLinks: {},
    selectedActionState: {},
    setCrossBorderReadByOrderId: vi.fn(),
    persistPurchaseCrossBorderDetail: vi.fn(),
    setPurchaseOperation: vi.fn(),
    setPurchasePlatformExpanded: vi.fn(),
    showPurchaseNotice,
    openPurchaseOrderWorkbench,
    ...overrides,
  }));
  return { ...result, showPurchaseNotice, openPurchaseOrderWorkbench };
}

describe('usePurchaseCrossBorderState purchase refund workbench routing', () => {
  it('opens the exact saved purchase order URL instead of the product source link', async () => {
    const state = renderState({
      selectedOrder: {
        buyerPlatform: '拼多多',
        purchaseOrderNo: '260810-579034202431518',
        purchaseOrderUrl: 'https://mobile.yangkeduo.com/order.html?order_sn=260810-579034202431518',
      },
    });

    await act(async () => {
      await state.result.current.handlePurchaseRefundAction();
    });

    expect(state.openPurchaseOrderWorkbench).toHaveBeenCalledWith(
      'https://mobile.yangkeduo.com/order.html?order_sn=260810-579034202431518',
    );
    expect(state.showPurchaseNotice).toHaveBeenCalledWith(
      '已打开当前采购单 260810-579034202431518，请核对后手动申请退款。',
      'info',
    );
  });

  it('builds the exact PDD order URL from this order platform and order number', async () => {
    const state = renderState({
      selectedOrder: {
        manualBuyerPlatform: '拼多多',
        manualPurchaseOrderNo: '260810-579034202431518',
      },
    });

    await act(async () => {
      await state.result.current.handlePurchaseRefundAction();
    });

    expect(state.openPurchaseOrderWorkbench).toHaveBeenCalledWith(
      'https://mobile.yangkeduo.com/order.html?order_sn=260810-579034202431518',
    );
  });

  it('fails closed instead of falling back to an unrelated product link', async () => {
    const state = renderState({ selectedOrder: {} });

    await act(async () => {
      await state.result.current.handlePurchaseRefundAction();
    });

    expect(state.openPurchaseOrderWorkbench).not.toHaveBeenCalled();
    expect(state.showPurchaseNotice).toHaveBeenCalledWith(
      '当前订单缺少可核验的采购订单地址或采购单号，未打开退款页面。',
      'warning',
    );
  });
});

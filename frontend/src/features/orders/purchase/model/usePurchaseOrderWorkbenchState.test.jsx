import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
  open: vi.fn(),
  hide: vi.fn(),
  sync: vi.fn(),
  navigate: vi.fn(),
  orderOperation: vi.fn(),
  toolbarAction: vi.fn(),
  sellerOrderLookup: vi.fn(),
}));
let purchaseBrowserEventListener = null;

vi.mock('../../../../services/internalBrowserLinkClient.js', () => ({
  getInternalBrowserLinkErrorMessage: (error) => String(error?.code || error?.message || '打开失败'),
  openInternalBrowserLink: browserMocks.open,
}));

vi.mock('../services/purchaseOrderWorkbenchViewportBridge.js', () => ({
  hidePurchaseOrderWorkbenchViewport: browserMocks.hide,
  runPurchaseOrderWorkbenchNavigation: browserMocks.navigate,
  runPurchaseOrderWorkbenchOrderOperation: browserMocks.orderOperation,
  runPurchaseOrderWorkbenchToolbarAction: browserMocks.toolbarAction,
  runPurchaseOrderWorkbenchSellerOrderLookup: browserMocks.sellerOrderLookup,
  syncPurchaseOrderWorkbenchViewport: browserMocks.sync,
}));

import { usePurchaseOrderWorkbenchState } from './usePurchaseOrderWorkbenchState.jsx';

const options = {
  selectedOrder: { id: 'order-1', shop: '测试店铺', amount: '99.00' },
  selectedProduct: { sku: 'sku-1', title: '测试商品' },
  selectedSourceEntry: { platform: 'PDD', url: 'https://mobile.yangkeduo.com/' },
  selectedOrderSourceShop: { id: 'shop-1', name: '测试店铺' },
  setSourceSearchDialog: vi.fn(),
  showPurchaseNotice: vi.fn(),
  onBrowserReady: vi.fn(),
};

describe('usePurchaseOrderWorkbenchState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserMocks.open.mockResolvedValue({ ok: true, visible: true });
    browserMocks.hide.mockResolvedValue({ ok: true, visible: false, embeddedHidden: true });
    browserMocks.sync.mockResolvedValue({ ok: true, visible: true });
    browserMocks.navigate.mockResolvedValue({ ok: true });
    browserMocks.orderOperation.mockResolvedValue({ ok: true });
    browserMocks.toolbarAction.mockResolvedValue({ ok: true, tabs: [] });
    browserMocks.sellerOrderLookup.mockResolvedValue({ ok: true });
    purchaseBrowserEventListener = null;
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: {
        purchaseBrowser: {
          onEvent: vi.fn((listener) => {
            purchaseBrowserEventListener = listener;
            return () => {
              if (purchaseBrowserEventListener === listener) purchaseBrowserEventListener = null;
            };
          }),
        },
      },
    });
  });

  it('awaits native embed-hide before unmounting the card and fences stale viewport callbacks', async () => {
    let releaseHide;
    browserMocks.hide.mockImplementationOnce(() => new Promise((resolve) => {
      releaseHide = resolve;
    }));
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState(options));
    expect(purchaseBrowserEventListener).toBeNull();

    act(() => result.current.open('https://mobile.yangkeduo.com/'));
    expect(purchaseBrowserEventListener).toBeTypeOf('function');
    const viewport = {
      requestKey: result.current.dialog.requestKey,
      url: result.current.dialog.url,
      presentation: result.current.dialog.presentation,
      bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
    };
    await act(async () => {
      await result.current.startBrowser(viewport);
    });
    expect(result.current.dialog.status).toBe('ready');
    expect(browserMocks.open).toHaveBeenCalledTimes(1);

    let closePromise;
    act(() => {
      closePromise = result.current.close();
    });
    expect(result.current.dialog.open).toBe(true);
    expect(result.current.dialog.status).toBe('closing');

    await act(async () => {
      await result.current.startBrowser(viewport);
    });
    expect(browserMocks.open).toHaveBeenCalledTimes(1);
    expect(browserMocks.sync).not.toHaveBeenCalled();
    expect(result.current.dialog.open).toBe(true);

    releaseHide({ ok: true, visible: false, embeddedHidden: true });
    await act(async () => {
      await closePromise;
    });
    await waitFor(() => expect(result.current.dialog.open).toBe(false));
    expect(browserMocks.hide).toHaveBeenCalledTimes(1);
    expect(purchaseBrowserEventListener).toBeNull();
    unmount();
  });

  it('releases the whole app UI even when the native hide command never settles', async () => {
    vi.useFakeTimers();
    browserMocks.hide.mockImplementationOnce(() => new Promise(() => undefined));
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState(options));
    act(() => result.current.open('https://mobile.yangkeduo.com/close-timeout'));
    expect(purchaseBrowserEventListener).toBeTypeOf('function');

    let closePromise;
    act(() => {
      closePromise = result.current.close();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(801);
      await closePromise;
    });

    expect(result.current.dialog.open).toBe(false);
    expect(purchaseBrowserEventListener).toBeNull();
    unmount();
    vi.useRealTimers();
  });

  it('does not let an older open completion hide a newer workbench request', async () => {
    let releaseFirstOpen;
    browserMocks.open
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirstOpen = resolve;
      }))
      .mockResolvedValueOnce({ ok: true, visible: true });
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState(options));

    act(() => result.current.open('https://mobile.yangkeduo.com/first'));
    const firstViewport = {
      requestKey: result.current.dialog.requestKey,
      url: result.current.dialog.url,
      presentation: result.current.dialog.presentation,
      bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
    };
    let firstOpenPromise;
    act(() => {
      firstOpenPromise = result.current.startBrowser(firstViewport);
    });

    act(() => result.current.open('https://mobile.yangkeduo.com/second'));
    const secondViewport = {
      requestKey: result.current.dialog.requestKey,
      url: result.current.dialog.url,
      presentation: result.current.dialog.presentation,
      bounds: { x: 462, y: 132, width: 918, height: 698, visible: true },
    };
    await act(async () => {
      await result.current.startBrowser(secondViewport);
    });
    releaseFirstOpen({ ok: true, visible: true });
    await act(async () => {
      await firstOpenPromise;
    });

    expect(result.current.dialog.requestKey).toBe(secondViewport.requestKey);
    expect(result.current.dialog.status).toBe('ready');
    expect(browserMocks.hide).not.toHaveBeenCalled();
    unmount();
  });

  it('minimizes by hiding the native viewport and restores without reopening the URL', async () => {
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState(options));

    act(() => result.current.open('https://mobile.yangkeduo.com/keep-state'));
    const viewport = {
      requestKey: result.current.dialog.requestKey,
      url: result.current.dialog.url,
      presentation: result.current.dialog.presentation,
      bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
    };
    await act(async () => {
      await result.current.startBrowser(viewport);
    });
    expect(browserMocks.open).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.minimize();
    });
    expect(result.current.dialog.open).toBe(true);
    expect(result.current.dialog.minimized).toBe(true);
    expect(result.current.dialog.status).toBe('ready');
    expect(browserMocks.hide).toHaveBeenCalledTimes(1);

    act(() => result.current.restore());
    expect(result.current.dialog.minimized).toBe(false);
    await act(async () => {
      await result.current.startBrowser(viewport);
    });
    expect(browserMocks.open).toHaveBeenCalledTimes(1);
    expect(browserMocks.sync).toHaveBeenCalledWith(viewport.bounds, expect.objectContaining({
      requestKey: result.current.dialog.requestKey,
    }));
    unmount();
  });

  it('re-hides a native open that completes after the card was minimized', async () => {
    let releaseOpen;
    browserMocks.open.mockImplementationOnce(() => new Promise((resolve) => {
      releaseOpen = resolve;
    }));
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState(options));

    act(() => result.current.open('https://mobile.yangkeduo.com/slow'));
    const viewport = {
      requestKey: result.current.dialog.requestKey,
      url: result.current.dialog.url,
      presentation: result.current.dialog.presentation,
      bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
    };
    let openPromise;
    act(() => {
      openPromise = result.current.startBrowser(viewport);
    });
    await act(async () => {
      await result.current.minimize();
    });
    releaseOpen({ ok: true, visible: true });
    await act(async () => {
      await openPromise;
    });

    expect(result.current.dialog.minimized).toBe(true);
    expect(result.current.dialog.status).toBe('ready');
    expect(browserMocks.hide).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('binds the opening order context after the native browser returns the exact active tab', async () => {
    browserMocks.open.mockResolvedValue({ ok: true, visible: true, activeTabId: 'tab-order-1' });
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState(options));
    const targetContext = {
      shopId: 'shop-1',
      orderKey: 'client-1:order-1',
      productKey: 'sku-1',
    };

    act(() => result.current.open('https://mobile.yangkeduo.com/', { browserTargetContext: targetContext }));
    await act(async () => {
      await result.current.startBrowser({
        requestKey: result.current.dialog.requestKey,
        url: result.current.dialog.url,
        presentation: result.current.dialog.presentation,
        browserTargetContext: result.current.dialog.browserTargetContext,
        bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
      });
    });

    expect(options.onBrowserReady).toHaveBeenCalledWith({
      requestKey: result.current.dialog.requestKey,
      browserState: expect.objectContaining({ activeTabId: 'tab-order-1' }),
      targetContext,
    });
    expect(browserMocks.open).toHaveBeenCalledWith(
      'https://mobile.yangkeduo.com/',
      expect.objectContaining({
        browserTarget: expect.objectContaining({
          targetId: 'shop-1:client-1:order-1:sku-1',
          shopId: 'shop-1',
          orderKey: 'client-1:order-1',
        }),
      }),
    );
    expect(result.current.dialog.status).toBe('ready');
    unmount();
  });

  it('updates the fixed workbench only for a paid capture from the exact tab and order target', async () => {
    browserMocks.open.mockResolvedValue({ ok: true, visible: true, activeTabId: 'tab-order-1' });
    const onPurchaseCaptured = vi.fn();
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState({
      ...options,
      onPurchaseCaptured,
    }));
    const targetContext = {
      shopId: 'shop-1',
      orderKey: 'client-1:order-1',
      productKey: 'sku-1',
    };

    act(() => result.current.open('https://mobile.yangkeduo.com/goods.html?goods_id=1', {
      browserTargetContext: targetContext,
    }));
    await act(async () => {
      await result.current.startBrowser({
        requestKey: result.current.dialog.requestKey,
        url: result.current.dialog.url,
        presentation: result.current.dialog.presentation,
        browserTargetContext: result.current.dialog.browserTargetContext,
        bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
      });
    });

    act(() => purchaseBrowserEventListener?.({
      event: 'purchase-order-auto-captured',
      tabId: 'tab-other',
      target: { shopId: 'shop-1', orderKey: 'client-1:order-1', sku: 'sku-1' },
      readbackVerified: true,
      purchaseContext: { purchasePlatform: '拼多多', purchaseOrderNumber: 'WRONG' },
    }));
    expect(onPurchaseCaptured).not.toHaveBeenCalled();

    const payload = {
      event: 'purchase-order-auto-captured',
      tabId: 'tab-order-1',
      target: { shopId: 'shop-1', orderKey: 'client-1:order-1', sku: 'sku-1' },
      readbackVerified: true,
      purchaseContext: {
        purchasePlatform: '拼多多',
        purchaseOrderNumber: 'PDD20260810001',
        purchaseOrderStatus: '待发货',
        purchaseOrderUrl: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD20260810001',
        sourceCostCny: 52.71,
      },
    };
    act(() => purchaseBrowserEventListener?.(payload));

    expect(result.current.dialog.presentation.order.purchasePlatform).toBe('拼多多');
    expect(result.current.dialog.presentation.order.purchaseOrderNo).toBe('PDD20260810001');
    expect(result.current.dialog.presentation.order.status).toBe('待发货');
    expect(result.current.dialog.presentation.source.amount).toBe('¥52.71');
    expect(onPurchaseCaptured).toHaveBeenCalledTimes(1);
    expect(onPurchaseCaptured).toHaveBeenCalledWith(payload);
    unmount();
  });

  it('shows the independent Alipay window and PDD readback states without treating page text as payment', async () => {
    const showPurchaseNotice = vi.fn();
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState({
      ...options,
      showPurchaseNotice,
    }));
    act(() => result.current.open('https://mobile.yangkeduo.com/payment-test'));
    expect(purchaseBrowserEventListener).toBeTypeOf('function');

    act(() => purchaseBrowserEventListener?.({ event: 'alipay-payment-opened', tabId: 'tab-order-1' }));
    act(() => purchaseBrowserEventListener?.({ event: 'alipay-payment-verifying', tabId: 'tab-order-1' }));
    act(() => purchaseBrowserEventListener?.({
      event: 'alipay-payment-pending',
      tabId: 'tab-order-1',
      readbackVerified: false,
    }));
    act(() => purchaseBrowserEventListener?.({
      event: 'alipay-payment-verified',
      tabId: 'tab-order-1',
      readbackVerified: true,
    }));

    expect(showPurchaseNotice).toHaveBeenNthCalledWith(
      1,
      '支付宝付款窗口已打开，请在官方页面完成付款。',
      'info',
    );
    expect(showPurchaseNotice).toHaveBeenNthCalledWith(
      3,
      '拼多多暂未确认付款，付款窗口会继续保留。',
      'warning',
    );
    expect(showPurchaseNotice).toHaveBeenNthCalledWith(
      4,
      '拼多多已确认付款，支付宝窗口已自动关闭。',
      'success',
    );
    unmount();
  });

  it('accepts an exact verified refund event and clears the stale paid presentation', async () => {
    browserMocks.open.mockResolvedValue({ ok: true, visible: true, activeTabId: 'tab-order-1' });
    const onPurchaseRefundCaptured = vi.fn();
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState({
      ...options,
      onPurchaseRefundCaptured,
    }));
    const targetContext = {
      shopId: 'shop-1',
      orderKey: 'client-1:order-1',
      productKey: 'sku-1',
    };

    act(() => result.current.open('https://mobile.yangkeduo.com/order.html?order_sn=PDD20260810001', {
      browserTargetContext: targetContext,
    }));
    await act(async () => {
      await result.current.startBrowser({
        requestKey: result.current.dialog.requestKey,
        url: result.current.dialog.url,
        presentation: result.current.dialog.presentation,
        browserTargetContext: result.current.dialog.browserTargetContext,
        bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
      });
    });

    const payload = {
      event: 'purchase-order-refund-captured',
      tabId: 'tab-order-1',
      target: { shopId: 'shop-1', orderKey: 'client-1:order-1', sku: 'sku-1' },
      readbackVerified: true,
      capture: {
        platform: '拼多多',
        purchaseOrderNumber: 'PDD20260810001',
        purchaseOrderStatus: '极速退款成功',
      },
      readback: {
        override: {
          purchasePlatform: '',
          purchaseOrderNumber: '',
          sourceCostCny: null,
          forcePurchaseStatus: '待拍单',
        },
      },
    };
    act(() => purchaseBrowserEventListener?.(payload));

    expect(result.current.dialog.presentation.order.purchasePlatform).toBe('待补录');
    expect(result.current.dialog.presentation.order.purchaseOrderNo).toBe('待补录');
    expect(result.current.dialog.presentation.order.status).toBe('待拍单');
    expect(result.current.dialog.presentation.source.platform).toBe('待补录');
    expect(result.current.dialog.presentation.source.amount).toBe('待确认');
    expect(onPurchaseRefundCaptured).toHaveBeenCalledTimes(1);
    expect(onPurchaseRefundCaptured).toHaveBeenCalledWith(payload);
    unmount();
  });

  it('accepts an automatically persisted 1688 order and source readback without a second save', async () => {
    browserMocks.open.mockResolvedValue({ ok: true, visible: true, activeTabId: 'tab-1688-1' });
    const onPurchaseCaptured = vi.fn();
    const persistedPayload = {
      ok: true,
      operation: 'read-payment-info',
      tabId: 'tab-1688-1',
      target: { shopId: 'shop-1', orderKey: 'client-1:order-1', sku: 'sku-1' },
      captureVerified: true,
      pendingSave: false,
      readbackVerified: true,
      capture: {
        sourceUrl: 'https://detail.1688.com/offer/7788990011.html',
        sourceProductId: '7788990011',
        sourceMethod: '1688-source-reader',
      },
      purchaseContext: {
        purchasePlatform: '1688',
        purchaseOrderNumber: '3316316306834029783',
        purchaseOrderStatus: '待发货',
        purchaseOrderUrl: 'https://trade.1688.com/order/order_detail.htm?orderId=3316316306834029783',
        sourceCostCny: 38.6,
      },
      readback: {
        override: {
          purchasePlatform: '1688',
          purchaseOrderNumber: '3316316306834029783',
          sourceCostCny: 38.6,
        },
        sourceLinks: [{ url: 'https://detail.1688.com/offer/7788990011.html' }],
      },
    };
    browserMocks.orderOperation.mockResolvedValueOnce(persistedPayload);
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState({
      ...options,
      onPurchaseCaptured,
    }));
    const targetContext = {
      shopId: 'shop-1', orderKey: 'client-1:order-1', productKey: 'sku-1',
    };
    act(() => result.current.open('https://trade.1688.com/order/buyer_order_list.htm', {
      browserTargetContext: targetContext,
    }));
    await act(async () => {
      await result.current.startBrowser({
        requestKey: result.current.dialog.requestKey,
        url: result.current.dialog.url,
        presentation: result.current.dialog.presentation,
        browserTargetContext: result.current.dialog.browserTargetContext,
        bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
      });
    });
    await act(async () => {
      await result.current.readPaymentInfo();
    });

    expect(browserMocks.orderOperation).toHaveBeenCalledWith('read-payment-info', {
      tabId: 'tab-1688-1',
    });
    expect(result.current.dialog.operation).toBe('');
    expect(result.current.dialog.presentation.order.purchaseOrderNo).toBe('3316316306834029783');
    expect(result.current.dialog.presentation.order.purchasePlatform).toBe('1688');
    expect(result.current.dialog.presentation.source.amount).toBe('¥38.60');
    expect(result.current.dialog.pendingSave).toBe(false);
    expect(onPurchaseCaptured).toHaveBeenCalledWith(persistedPayload);
    await act(async () => {
      await result.current.savePurchaseInfo();
    });
    expect(browserMocks.orderOperation).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('allows an exact bound status refresh after a visible native tab reports a load error', async () => {
    browserMocks.open.mockResolvedValueOnce({
      ok: true,
      visible: true,
      activeTabId: 'tab-1688-refund-1',
    });
    const refundedPayload = {
      ok: true,
      tabId: 'tab-1688-refund-1',
      operation: 'refresh-order-status',
      target: { shopId: 'shop-1', orderKey: 'client-1:order-1', sku: 'sku-1' },
      capture: {
        platform: '1688',
        purchaseOrderNumber: '3316316306834029783',
        purchaseOrderStatus: '退款成功',
      },
      refunded: true,
      readbackVerified: true,
      readback: {
        override: {
          purchasePlatform: '',
          purchaseOrderNumber: '',
          sourceCostCny: null,
          forcePurchaseStatus: '待拍单',
        },
      },
    };
    browserMocks.orderOperation.mockResolvedValueOnce(refundedPayload);
    const onPurchaseRefundCaptured = vi.fn();
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState({
      ...options,
      onPurchaseRefundCaptured,
    }));
    const targetContext = {
      shopId: 'shop-1', orderKey: 'client-1:order-1', productKey: 'sku-1',
    };
    act(() => result.current.open('https://trade.1688.com/order/buyer_order_list.htm', {
      browserTargetContext: targetContext,
    }));
    const viewport = {
      requestKey: result.current.dialog.requestKey,
      url: result.current.dialog.url,
      presentation: result.current.dialog.presentation,
      browserTargetContext: result.current.dialog.browserTargetContext,
      bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
    };
    await act(async () => {
      await result.current.startBrowser(viewport);
    });
    expect(result.current.dialog.status).toBe('ready');

    act(() => result.current.retry());
    browserMocks.open.mockRejectedValueOnce(Object.assign(new Error('LOAD_FAILED'), { code: 'LOAD_FAILED' }));
    await act(async () => {
      await result.current.startBrowser(viewport);
    });
    expect(result.current.dialog.status).toBe('error');
    expect(result.current.dialog.browserTabId).toBe('tab-1688-refund-1');

    await act(async () => {
      await result.current.refreshOrderStatus();
    });
    expect(browserMocks.orderOperation).toHaveBeenCalledWith('refresh-order-status', {
      tabId: 'tab-1688-refund-1',
    });
    expect(result.current.dialog.status).toBe('ready');
    expect(result.current.dialog.presentation.order.status).toBe('待拍单');
    expect(result.current.dialog.presentation.order.purchaseOrderNo).toBe('待补录');
    expect(result.current.dialog.presentation.source.amount).toBe('待确认');
    expect(onPurchaseRefundCaptured).toHaveBeenCalledWith(refundedPayload);
    unmount();
  });

  it('reuses the same workbench with a supplied Ozon product presentation without purchase capture locking', async () => {
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState(options));
    const presentation = {
      version: 1,
      kind: 'purchase-order',
      displayMode: 'embedded',
      title: '商品订单操作台',
      browserLabel: 'Ozon 商品页面',
      order: { orderNo: 'order-2' },
      product: { title: '测试商品', sku: '123456789' },
    };

    act(() => result.current.open('https://www.ozon.ru/product/123456789/', { presentation }));
    expect(result.current.dialog.presentation).toBe(presentation);
    await act(async () => {
      await result.current.startBrowser({
        requestKey: result.current.dialog.requestKey,
        url: result.current.dialog.url,
        presentation: result.current.dialog.presentation,
        bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
      });
    });

    expect(options.onBrowserReady).not.toHaveBeenCalled();
    expect(result.current.dialog.status).toBe('ready');
    unmount();
  });

  it('keeps the canonical shop binding on the Seller workbench command', async () => {
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState(options));

    act(() => result.current.open('https://seller.ozon.ru/app/postings/fbs', {
      shopId: 'shop-2',
      requireShopBinding: true,
    }));
    expect(result.current.dialog.shopId).toBe('shop-2');
    expect(result.current.dialog.requireShopBinding).toBe(true);

    await act(async () => {
      await result.current.startBrowser({
        requestKey: result.current.dialog.requestKey,
        url: result.current.dialog.url,
        shopId: result.current.dialog.shopId,
        requireShopBinding: result.current.dialog.requireShopBinding,
        presentation: result.current.dialog.presentation,
        bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
      });
    });

    expect(browserMocks.open).toHaveBeenCalledWith(
      'https://seller.ozon.ru/app/postings/fbs',
      expect.objectContaining({
        shopId: 'shop-2',
        requireShopBinding: true,
      })
    );
    unmount();
  });

  it('does not mark a Seller order workbench ready until the exact posting is opened and verified', async () => {
    browserMocks.open.mockResolvedValueOnce({ ok: true, activeTabId: 'seller-tab-1' });
    const { result, unmount } = renderHook(() => usePurchaseOrderWorkbenchState(options));

    act(() => result.current.open('https://seller.ozon.ru/app/postings/fbs', {
      shopId: 'shop-2',
      requireShopBinding: true,
      sellerOrderLookup: { postingNumber: '0149891397-1014-1', routeKind: 'fbs' },
    }));
    await act(async () => {
      await result.current.startBrowser({
        requestKey: result.current.dialog.requestKey,
        url: result.current.dialog.url,
        shopId: result.current.dialog.shopId,
        requireShopBinding: result.current.dialog.requireShopBinding,
        sellerOrderLookup: result.current.dialog.sellerOrderLookup,
        presentation: result.current.dialog.presentation,
        bounds: { x: 460, y: 130, width: 920, height: 700, visible: true },
      });
    });

    expect(browserMocks.sellerOrderLookup).toHaveBeenCalledWith({
      tabId: 'seller-tab-1',
      postingNumber: '0149891397-1014-1',
      routeKind: 'fbs',
    });
    expect(result.current.dialog.status).toBe('ready');
    unmount();
  });
});

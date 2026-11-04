import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const marketingMocks = vi.hoisted(() => ({
  requestOzonFbsCancelReasons: vi.fn(),
}));

vi.mock('../../../../entities/marketing/marketingOrderFields.jsx', () => marketingMocks);

import { usePurchaseBatchCancelState } from './usePurchaseBatchCancelState.jsx';
import React from 'react';

function createShop(id, clientId = `${id}-client`) {
  return {
    id,
    clientId,
    hasClientId: true,
    hasApiKey: true,
    shopAlias: id,
  };
}

function createOrder(id, shop, overrides = {}) {
  return {
    id,
    recordKey: `${shop.clientId}:${id}`,
    shopId: shop.id,
    shopClientId: shop.clientId,
    shop: shop.shopAlias,
    fulfillment: 'FBS',
    status: '已拍单-待预报',
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function useBatchCancelHarness({ selectedPurchaseOrders, shops, showPurchaseNotice }) {
  const [purchaseOperation, setPurchaseOperation] = React.useState({
    open: false,
    type: '',
    fields: {},
    cancelReasons: [],
    cancelReasonsLoading: false,
    cancelReasonsError: '',
  });
  const batchCancel = usePurchaseBatchCancelState({
    selectedPurchaseOrders,
    shops,
    setPurchaseOperation,
    showPurchaseNotice,
  });

  return {
    ...batchCancel,
    purchaseOperation,
    closeOperation: () => setPurchaseOperation((current) => ({ ...current, open: false })),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('usePurchaseBatchCancelState', () => {
  it('没有可安全取消的订单时不打开弹窗也不读取取消原因', () => {
    const shop = createShop('shop-a');
    const showPurchaseNotice = vi.fn();
    const selectedPurchaseOrders = [createOrder('posting-fbo', shop, { fulfillment: 'FBO' })];
    const { result } = renderHook(() =>
      useBatchCancelHarness({ selectedPurchaseOrders, shops: [shop], showPurchaseNotice })
    );

    expect(result.current.purchaseBatchCancelCount).toBe(0);
    expect(result.current.purchaseBatchCancelExcludedCount).toBe(1);

    act(() => result.current.openPurchaseBatchCancel());

    expect(result.current.purchaseOperation.open).toBe(false);
    expect(marketingMocks.requestOzonFbsCancelReasons).not.toHaveBeenCalled();
    expect(showPurchaseNotice).toHaveBeenCalledWith('已选订单中没有可安全取消的订单，已排除 1 个。', 'warning');
  });

  it('多店批次只保留每个店铺都返回的取消原因', async () => {
    const shopA = createShop('shop-a');
    const shopB = createShop('shop-b');
    const selectedPurchaseOrders = [createOrder('posting-a', shopA), createOrder('posting-b', shopB)];
    marketingMocks.requestOzonFbsCancelReasons.mockImplementation(async (shop) =>
      shop.id === shopA.id
        ? [
            { id: 'shared', label: '共同原因', rawLabel: 'shared raw label' },
            { id: 'only-a', label: 'A 店专用' },
          ]
        : [
            { id: 'only-b', label: 'B 店专用' },
            { id: 'shared', label: '共同原因（B）', rawLabel: 'shared raw label from B' },
          ]
    );
    const { result } = renderHook(() =>
      useBatchCancelHarness({ selectedPurchaseOrders, shops: [shopA, shopB], showPurchaseNotice: vi.fn() })
    );

    act(() => result.current.openPurchaseBatchCancel());

    expect(result.current.purchaseOperation).toMatchObject({
      open: true,
      type: 'ozonBatchCancel',
      selectedCount: 2,
      excludedCount: 0,
      shopCount: 2,
      cancelReasonsLoading: true,
    });
    await waitFor(() => expect(result.current.purchaseOperation.cancelReasonsLoading).toBe(false));

    expect(marketingMocks.requestOzonFbsCancelReasons).toHaveBeenCalledTimes(2);
    expect(marketingMocks.requestOzonFbsCancelReasons).toHaveBeenCalledWith(shopA);
    expect(marketingMocks.requestOzonFbsCancelReasons).toHaveBeenCalledWith(shopB);
    expect(result.current.purchaseOperation.cancelReasons).toEqual([
      { id: 'shared', label: '共同原因', rawLabel: 'shared raw label' },
    ]);
    expect(result.current.purchaseOperation.fields).toMatchObject({
      cancelReasonId: 'shared',
      cancelReasonMessage: 'shared raw label',
    });
  });

  it('将不可取消和无法严格匹配店铺的订单计入排除数', async () => {
    const shop = createShop('shop-a');
    const unknownShop = createShop('shop-missing');
    const selectedPurchaseOrders = [
      createOrder('posting-ready', shop),
      createOrder('posting-fbo', shop, { fulfillment: 'FBO' }),
      createOrder('posting-terminal', shop, { status: 'delivering' }),
      createOrder('posting-unresolved-shop', unknownShop),
    ];
    marketingMocks.requestOzonFbsCancelReasons.mockResolvedValue([
      { id: 'reason-1', label: '库存不足', rawLabel: 'out of stock' },
    ]);
    const { result } = renderHook(() =>
      useBatchCancelHarness({ selectedPurchaseOrders, shops: [shop], showPurchaseNotice: vi.fn() })
    );

    expect(result.current.purchaseBatchCancelCount).toBe(1);
    expect(result.current.purchaseBatchCancelExcludedCount).toBe(3);

    act(() => result.current.openPurchaseBatchCancel());
    await waitFor(() => expect(result.current.purchaseOperation.cancelReasonsLoading).toBe(false));

    expect(result.current.purchaseOperation).toMatchObject({
      selectedCount: 4,
      excludedCount: 3,
      shopCount: 1,
    });
    expect(result.current.purchaseOperation.orders.map((order) => order.id)).toEqual(['posting-ready']);
    expect(result.current.purchaseOperation.excludedOrders.map((item) => item.code)).toEqual([
      'fbo_order',
      'terminal_status',
      'shop_not_found',
    ]);
    expect(marketingMocks.requestOzonFbsCancelReasons).toHaveBeenCalledTimes(1);
    expect(marketingMocks.requestOzonFbsCancelReasons).toHaveBeenCalledWith(shop);
  });

  it('旧批次延迟返回的取消原因不会覆盖新批次', async () => {
    const shopA = createShop('shop-a');
    const shopB = createShop('shop-b');
    const oldRead = deferred();
    const newRead = deferred();
    marketingMocks.requestOzonFbsCancelReasons.mockImplementation((shop) =>
      shop.id === shopA.id ? oldRead.promise : newRead.promise
    );
    const showPurchaseNotice = vi.fn();
    const { result, rerender } = renderHook(
      ({ selectedPurchaseOrders, shops }) =>
        useBatchCancelHarness({ selectedPurchaseOrders, shops, showPurchaseNotice }),
      {
        initialProps: {
          selectedPurchaseOrders: [createOrder('posting-old', shopA)],
          shops: [shopA, shopB],
        },
      }
    );

    act(() => result.current.openPurchaseBatchCancel());
    const oldOperationId = result.current.purchaseOperation.operationId;

    rerender({
      selectedPurchaseOrders: [createOrder('posting-new', shopB)],
      shops: [shopA, shopB],
    });
    act(() => result.current.openPurchaseBatchCancel());
    const newOperationId = result.current.purchaseOperation.operationId;
    expect(newOperationId).not.toBe(oldOperationId);

    await act(async () => {
      newRead.resolve([{ id: 'new-reason', label: '新批次原因', rawLabel: 'new raw reason' }]);
      await newRead.promise;
    });
    await waitFor(() => expect(result.current.purchaseOperation.cancelReasonsLoading).toBe(false));
    expect(result.current.purchaseOperation.fields.cancelReasonId).toBe('new-reason');

    await act(async () => {
      oldRead.resolve([{ id: 'old-reason', label: '旧批次原因', rawLabel: 'old raw reason' }]);
      await oldRead.promise;
      await Promise.resolve();
    });

    expect(result.current.purchaseOperation.operationId).toBe(newOperationId);
    expect(result.current.purchaseOperation.cancelReasons.map((reason) => reason.id)).toEqual(['new-reason']);
    expect(result.current.purchaseOperation.fields.cancelReasonId).toBe('new-reason');
  });

  it('弹窗关闭后延迟返回的取消原因不再写回状态', async () => {
    const shop = createShop('shop-a');
    const pendingRead = deferred();
    marketingMocks.requestOzonFbsCancelReasons.mockReturnValue(pendingRead.promise);
    const { result } = renderHook(() =>
      useBatchCancelHarness({
        selectedPurchaseOrders: [createOrder('posting-a', shop)],
        shops: [shop],
        showPurchaseNotice: vi.fn(),
      })
    );

    act(() => result.current.openPurchaseBatchCancel());
    const operationId = result.current.purchaseOperation.operationId;
    act(() => result.current.closeOperation());

    await act(async () => {
      pendingRead.resolve([{ id: 'late-reason', label: '迟到原因', rawLabel: 'late raw reason' }]);
      await pendingRead.promise;
      await Promise.resolve();
    });

    expect(result.current.purchaseOperation).toMatchObject({
      open: false,
      operationId,
      cancelReasons: [],
      cancelReasonsLoading: true,
      cancelReasonsError: '',
    });
    expect(result.current.purchaseOperation.fields.cancelReasonId).toBe('');
  });
});

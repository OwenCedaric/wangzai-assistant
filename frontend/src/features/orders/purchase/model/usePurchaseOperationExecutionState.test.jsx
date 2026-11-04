import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  submitSalesOrderCancel: vi.fn(),
  submitSalesOrderShip: vi.fn(),
  prepareOzonForPurchaseForecast: vi.fn(),
  createOzonPackageLabelForPurchase: vi.fn(),
  readOzonPurchaseForecastState: vi.fn(),
  submitPurchaseOzonAwaitingDelivery: vi.fn(),
  requestProtectedCrossBorderOrderOperation: vi.fn(),
  readSavedCrossBorderOrderSettings: vi.fn(),
  requestPurchaseCrossBorderDetailByOrderId: vi.fn(),
  requestPurchaseOrderOzonDeliveryRoute: vi.fn(),
  assertNoExistingPurchaseCrossBorderForecast: vi.fn(),
}));

vi.mock('../../../../entities/marketing/marketingSnapshotRuntime.jsx', () => ({
  createOzonPackageLabelForPurchase: mocks.createOzonPackageLabelForPurchase,
  isOzonAwaitingDeliveryRawStatus: (status) => ['awaiting_deliver', 'awaiting_delivery'].includes(status),
  isOzonPackageLabelNotReadyError: (error) => /NO_POSTINGS_FOR_BATCH_DOWNLOAD/u.test(error?.message || ''),
  isOzonAwaitingDeliveryPendingError: () => false,
  prepareOzonForPurchaseForecast: mocks.prepareOzonForPurchaseForecast,
  readOzonPurchaseForecastState: mocks.readOzonPurchaseForecastState,
  submitSalesOrderCancel: mocks.submitSalesOrderCancel,
  submitSalesOrderShip: mocks.submitSalesOrderShip,
}));

vi.mock('../../../../entities/order/crossBorderOrderApi.jsx', () => ({
  readSavedCrossBorderOrderSettings: mocks.readSavedCrossBorderOrderSettings,
  requestProtectedCrossBorderOrderOperation: mocks.requestProtectedCrossBorderOrderOperation,
}));

vi.mock('../../../../services/purchaseCrossBorderRuntime.js', () => ({
  assertNoExistingPurchaseCrossBorderForecast: mocks.assertNoExistingPurchaseCrossBorderForecast,
  buildPurchaseCrossBorderCancelBody: () => ({ missing: [], body: {} }),
  buildPurchaseCrossBorderCreateBody: () => ({ missing: [], body: {} }),
  buildPurchaseCrossBorderPackageBody: () => ({ missing: [], body: {} }),
  buildPurchaseCrossBorderSheetBody: () => ({ missing: [], body: {} }),
  getFriendlyPurchaseOperationError: (error) => (error instanceof Error ? error.message : String(error)),
  getPurchaseForecastServiceSelection: () => ({
    requiredOptions: [{ id: 'service-1' }],
    requiredId: 'service-1',
  }),
  getPurchaseOrderShop: (shops, order, activeShop) =>
    shops.find(
      (shop) =>
        String(shop.id) === String(order.shopId || '') &&
        String(shop.clientId) === String(order.shopClientId || '')
    ) || activeShop || null,
  hasCrossBorderVerifiedSheet: () => false,
  normalizeCrossBorderOrderCreateResult: (value) => value || {},
  requestPurchaseCrossBorderDetailByOrderId: mocks.requestPurchaseCrossBorderDetailByOrderId,
  requestPurchaseOrderOzonDeliveryRoute: mocks.requestPurchaseOrderOzonDeliveryRoute,
  submitPurchaseOzonAwaitingDelivery: mocks.submitPurchaseOzonAwaitingDelivery,
}));

vi.mock('../lib/purchaseOrderNormalize.jsx', () => ({
  countPurchaseOrderModule: () => 0,
}));

vi.mock('../lib/purchaseMarketingApi.jsx', () => ({
  getPurchaseOrderRecordKey: (order = {}) => order.recordKey || order.id || '',
}));

import { usePurchaseOperationExecutionState } from './usePurchaseOperationExecutionState.jsx';

const shopA = {
  id: 'shop-a',
  clientId: 'client-a',
  apiKey: 'api-key-a',
  shopAlias: 'A 店',
};

const shopB = {
  id: 'shop-b',
  clientId: 'client-b',
  apiKey: 'api-key-b',
  shopAlias: 'B 店',
};

function makeOrder(id, shop) {
  return {
    id,
    recordKey: id,
    posting: id,
    status: '待拍单',
    fulfillment: 'FBS',
    shopId: shop.id,
    shopClientId: shop.clientId,
    shop: shop.shopAlias,
  };
}

const orderA = makeOrder('posting-a', shopA);
const orderB = makeOrder('posting-b', shopB);

function waitingReadbackResult(id) {
  return {
    id,
    writeStatus: 'submitted_waiting_readback',
    localApiWrite: {
      writeStatus: 'submitted_waiting_readback',
      message: '订单写入已提交 Ozon，后台回读已排队；SQLite 合并完成前仅显示处理中。',
    },
  };
}

function createProps(operationOverrides = {}) {
  return {
    selectedOrder: orderA,
    selectedOrderActionKeysByStatus: {},
    selectedActionFlags: { status: '待拍单' },
    status: 'all',
    selectedOrderActionDefinitions: {},
    filteredOrders: [],
    selectedOrderId: '',
    setSelectedOrderId: vi.fn(),
    visibleOrders: [],
    purchaseOperation: {
      open: true,
      type: 'ozonBatchCancel',
      order: orderA,
      orders: [orderA, orderB],
      fields: {
        cancelReasonId: '1001',
        cancelReasonMessage: '买家要求取消',
      },
      confirmed: true,
      loading: false,
      error: '',
      cancelReasons: [
        {
          id: '1001',
          label: '买家要求取消',
          rawLabel: '买家要求取消',
        },
      ],
      cancelReasonsLoading: false,
      cancelReasonsError: '',
      ...operationOverrides,
    },
    setPurchaseOperation: vi.fn(),
    shop: 'all',
    shops: [shopA, shopB],
    activeShop: shopA,
    productSourceLinks: {},
    legacyPurchaseSourceLinks: {},
    setCrossBorderReadByOrderId: vi.fn(),
    persistPurchaseCrossBorderDetail: vi.fn(),
    persistPurchaseForecastFlow: vi.fn(),
    showPurchaseNotice: vi.fn(),
    readCrossBorderForOrder: vi.fn(),
    handleRefreshPurchaseOrders: vi.fn().mockResolvedValue(undefined),
    markPurchaseOrderAwaitingDeliveryPending: vi.fn(),
    purchaseOrderCountRows: [],
    setSelectedPurchaseOrderKeys: vi.fn(),
  };
}

function renderExecutionHook(props) {
  return renderHook(() => usePurchaseOperationExecutionState(props));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSavedCrossBorderOrderSettings.mockReturnValue({ accountId: 'cross-border-a' });
  mocks.assertNoExistingPurchaseCrossBorderForecast.mockResolvedValue(undefined);
  mocks.requestPurchaseOrderOzonDeliveryRoute.mockResolvedValue({ deliveryMethod: 'GUOO' });
});

function createForecastProps(forecastFlow = {}) {
  return createProps({
    type: 'createForecast',
    orders: [],
    fields: {
      forecastMode: 'create',
      orderNumber: orderA.id,
      country: 'RU',
      dataStatus: '1',
      purchasePlatform: '1',
      purchaseOrderNo: 'purchase-1',
      packageQty: '1',
      packageDesc: '测试包裹',
      remark: 'GUOO',
    },
    forecastFlow: {
      postingNumber: orderA.id,
      shopId: shopA.id,
      stage: 'idle',
      ...forecastFlow,
    },
    confirmed: true,
  });
}

describe('usePurchaseOperationExecutionState split forecast flow', () => {
  it('submits Ozon preparation only in step one and persists the resumable stage', async () => {
    mocks.prepareOzonForPurchaseForecast.mockResolvedValue({
      skipped: false,
      postingNumber: orderA.id,
      rawStatus: 'awaiting_delivery',
    });
    const props = createForecastProps();
    const { result } = renderExecutionHook(props);

    expect(result.current.canPreparePurchaseForecastOzon).toBe(true);
    expect(result.current.canCheckPurchaseForecastLabel).toBe(false);
    expect(result.current.canSubmitPurchaseForecast).toBe(false);

    await act(async () => {
      await result.current.executePurchaseForecastOzonPrepare();
    });

    expect(mocks.prepareOzonForPurchaseForecast).toHaveBeenCalledTimes(1);
    expect(mocks.createOzonPackageLabelForPurchase).not.toHaveBeenCalled();
    expect(mocks.requestProtectedCrossBorderOrderOperation).not.toHaveBeenCalled();
    expect(props.persistPurchaseForecastFlow).toHaveBeenCalledWith(
      orderA,
      expect.objectContaining({ stage: 'ozon_prepared', postingNumber: orderA.id, shopId: shopA.id })
    );
  });

  it('monitors the real Ozon state and unlocks forecast only after a label exists', async () => {
    mocks.readOzonPurchaseForecastState.mockResolvedValue({
      postingNumber: orderA.id,
      rawStatus: 'awaiting_delivery',
      detailOrder: orderA,
    });
    mocks.createOzonPackageLabelForPurchase.mockResolvedValue({
      taskId: 'label-task-1',
      sheetOrderSn: 'sheet-1',
      sheetUrl: 'https://example.test/sheet-1.pdf',
    });
    const props = createForecastProps({
      stage: 'ozon_prepared',
      ozonPreparedAt: '2026-08-24T13:44:20.000Z',
    });
    const { result } = renderExecutionHook(props);

    expect(result.current.canCheckPurchaseForecastLabel).toBe(true);
    await act(async () => {
      await result.current.executePurchaseForecastLabelCheck();
    });

    expect(mocks.readOzonPurchaseForecastState).toHaveBeenCalledTimes(1);
    expect(mocks.createOzonPackageLabelForPurchase).toHaveBeenCalledTimes(1);
    expect(props.persistPurchaseForecastFlow).toHaveBeenCalledWith(
      orderA,
      expect.objectContaining({
        stage: 'label_ready',
        sheetOrderSn: 'sheet-1',
        sheetUrl: 'https://example.test/sheet-1.pdf',
      })
    );
    expect(mocks.requestProtectedCrossBorderOrderOperation).not.toHaveBeenCalled();
  });

  it('uses the saved label for step three without repeating Ozon preparation', async () => {
    mocks.requestProtectedCrossBorderOrderOperation.mockResolvedValue({
      orderId: 'bus-order-1',
      orderNumber: 'bus-number-1',
      readStatus: '待打包',
    });
    mocks.requestPurchaseCrossBorderDetailByOrderId.mockResolvedValue({
      orderId: 'bus-order-1',
      orderNumber: 'bus-number-1',
      readStatus: '待打包',
      sheetOrderSn: 'sheet-1',
      sheetUrl: 'https://example.test/sheet-1.pdf',
    });
    const props = createForecastProps({
      stage: 'label_ready',
      ozonPreparedAt: '2026-08-24T13:44:20.000Z',
      labelTaskId: 'label-task-1',
      sheetOrderSn: 'sheet-1',
      sheetUrl: 'https://example.test/sheet-1.pdf',
      labelReadyAt: '2026-08-24T13:45:20.000Z',
    });
    const { result } = renderExecutionHook(props);

    expect(result.current.canSubmitPurchaseForecast).toBe(true);
    await act(async () => {
      await result.current.executePurchaseForecastSubmit();
    });

    expect(mocks.prepareOzonForPurchaseForecast).not.toHaveBeenCalled();
    expect(mocks.createOzonPackageLabelForPurchase).not.toHaveBeenCalled();
    expect(mocks.requestProtectedCrossBorderOrderOperation).toHaveBeenCalledTimes(3);
    expect(mocks.requestProtectedCrossBorderOrderOperation.mock.calls.map((call) => call[0])).toEqual([
      'createOrder',
      'associateOrder',
      'syncOrderStatus',
    ]);
    expect(props.persistPurchaseForecastFlow).toHaveBeenCalledWith(
      orderA,
      expect.objectContaining({ stage: 'completed', crossBorderOrderFound: true })
    );
    const finalOperationState = props.setPurchaseOperation.mock.calls.reduce(
      (current, [update]) => (typeof update === 'function' ? update(current) : update),
      props.purchaseOperation
    );
    expect(finalOperationState).toMatchObject({
      open: false,
      loading: false,
      activeForecastStep: '',
      error: '',
    });
  });

  it('runs all three real handlers in order when automatic mode is enabled', async () => {
    mocks.prepareOzonForPurchaseForecast.mockResolvedValue({
      skipped: false,
      postingNumber: orderA.id,
      rawStatus: 'awaiting_delivery',
    });
    mocks.readOzonPurchaseForecastState.mockResolvedValue({
      postingNumber: orderA.id,
      rawStatus: 'awaiting_delivery',
      detailOrder: orderA,
    });
    mocks.createOzonPackageLabelForPurchase.mockResolvedValue({
      taskId: 'label-task-auto',
      sheetOrderSn: 'sheet-auto',
      sheetUrl: 'https://example.test/sheet-auto.pdf',
    });
    mocks.requestProtectedCrossBorderOrderOperation.mockResolvedValue({
      orderId: 'bus-order-auto',
      orderNumber: 'bus-number-auto',
      readStatus: '待打包',
    });
    mocks.requestPurchaseCrossBorderDetailByOrderId.mockResolvedValue({
      orderId: 'bus-order-auto',
      orderNumber: 'bus-number-auto',
      readStatus: '待打包',
      sheetOrderSn: 'sheet-auto',
      sheetUrl: 'https://example.test/sheet-auto.pdf',
    });
    const props = createForecastProps();
    props.purchaseOperation.fields.forecastExecutionMode = 'auto';
    props.purchaseOperation.forecastFlow.executionMode = 'auto';
    const { result } = renderExecutionHook(props);

    expect(result.current.canRunPurchaseForecastAuto).toBe(true);
    await act(async () => {
      await result.current.executePurchaseForecastAuto();
    });

    expect(mocks.prepareOzonForPurchaseForecast).toHaveBeenCalledTimes(1);
    expect(mocks.readOzonPurchaseForecastState).toHaveBeenCalledTimes(1);
    expect(mocks.createOzonPackageLabelForPurchase).toHaveBeenCalledTimes(1);
    expect(mocks.requestProtectedCrossBorderOrderOperation).toHaveBeenCalledTimes(3);
    expect(mocks.requestProtectedCrossBorderOrderOperation.mock.calls.map((call) => call[0])).toEqual([
      'createOrder',
      'associateOrder',
      'syncOrderStatus',
    ]);
    expect(props.persistPurchaseForecastFlow).toHaveBeenCalledWith(
      orderA,
      expect.objectContaining({ stage: 'completed', executionMode: 'auto' })
    );
  });

  it('persists the manual or automatic mode switch on the current order', () => {
    const props = createForecastProps();
    const { result } = renderExecutionHook(props);

    act(() => {
      result.current.updatePurchaseForecastExecutionMode('auto');
    });

    expect(props.persistPurchaseForecastFlow).toHaveBeenCalledWith(
      orderA,
      expect.objectContaining({ executionMode: 'auto' })
    );
  });
});

describe('usePurchaseOperationExecutionState batch cancellation', () => {
  it('does not submit an unconfirmed batch even when execute is called directly', async () => {
    const props = createProps({ confirmed: false });
    const { result } = renderExecutionHook(props);

    await act(async () => {
      await result.current.executePurchaseOperation();
    });

    expect(mocks.submitSalesOrderCancel).not.toHaveBeenCalled();
    expect(props.handleRefreshPurchaseOrders).not.toHaveBeenCalled();
    expect(props.setPurchaseOperation).toHaveBeenCalledWith(expect.any(Function));
    const nextState = props.setPurchaseOperation.mock.calls[0][0](props.purchaseOperation);
    expect(nextState.error).toMatch(/确认真实写入/u);
  });

  it('submits A/B shop orders strictly through their matching shops and refreshes only once', async () => {
    mocks.submitSalesOrderCancel
      .mockResolvedValueOnce(waitingReadbackResult(orderA.id))
      .mockResolvedValueOnce(waitingReadbackResult(orderB.id));
    const props = createProps();
    const { result } = renderExecutionHook(props);

    await act(async () => {
      await result.current.executePurchaseOperation();
    });

    expect(mocks.submitSalesOrderCancel).toHaveBeenCalledTimes(2);
    expect(mocks.submitSalesOrderCancel).toHaveBeenNthCalledWith(
      1,
      shopA,
      expect.objectContaining({ id: orderA.id, posting: orderA.id }),
      { cancelReasonId: '1001', cancelReasonMessage: '买家要求取消' }
    );
    expect(mocks.submitSalesOrderCancel).toHaveBeenNthCalledWith(
      2,
      shopB,
      expect.objectContaining({ id: orderB.id, posting: orderB.id }),
      { cancelReasonId: '1001', cancelReasonMessage: '买家要求取消' }
    );
    expect(props.handleRefreshPurchaseOrders).toHaveBeenCalledTimes(1);
  });

  it('reports partial failures as warning and removes only successful orders from selection', async () => {
    mocks.submitSalesOrderCancel
      .mockResolvedValueOnce(waitingReadbackResult(orderA.id))
      .mockRejectedValueOnce(new Error('B 店拒绝取消'));
    const props = createProps();
    const { result } = renderExecutionHook(props);

    await act(async () => {
      await result.current.executePurchaseOperation();
    });

    expect(props.showPurchaseNotice).toHaveBeenCalledTimes(1);
    expect(props.showPurchaseNotice).toHaveBeenCalledWith(
      expect.stringMatching(/失败 1 个.*posting-b.*B 店拒绝取消/u),
      'warning'
    );
    expect(props.setSelectedPurchaseOrderKeys).toHaveBeenCalledTimes(1);
    const selectionUpdater = props.setSelectedPurchaseOrderKeys.mock.calls[0][0];
    expect(selectionUpdater(new Set([orderA.id, orderB.id]))).toEqual(new Set([orderB.id]));
    expect(props.handleRefreshPurchaseOrders).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting-readback copy distinct from cancellation completion', async () => {
    mocks.submitSalesOrderCancel
      .mockResolvedValueOnce(waitingReadbackResult(orderA.id))
      .mockResolvedValueOnce(waitingReadbackResult(orderB.id));
    const props = createProps();
    const { result } = renderExecutionHook(props);

    await act(async () => {
      await result.current.executePurchaseOperation();
    });

    const [message, severity] = props.showPurchaseNotice.mock.calls[0];
    expect(message).toContain('等待回读 2 个');
    expect(message).not.toMatch(/取消完成|取消成功|已完成/u);
    expect(severity).toBe('info');
  });

  it('ignores a second execute call while the first batch is still running', async () => {
    let releaseFirst;
    const firstWrite = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    mocks.submitSalesOrderCancel
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValueOnce(waitingReadbackResult(orderB.id));
    const props = createProps();
    const { result } = renderExecutionHook(props);

    let firstExecution;
    let secondExecution;
    act(() => {
      firstExecution = result.current.executePurchaseOperation();
      secondExecution = result.current.executePurchaseOperation();
    });

    expect(mocks.submitSalesOrderCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst(waitingReadbackResult(orderA.id));
      await Promise.all([firstExecution, secondExecution]);
    });

    expect(mocks.submitSalesOrderCancel).toHaveBeenCalledTimes(2);
    expect(props.handleRefreshPurchaseOrders).toHaveBeenCalledTimes(1);
    expect(props.showPurchaseNotice).toHaveBeenCalledTimes(1);
  });
});

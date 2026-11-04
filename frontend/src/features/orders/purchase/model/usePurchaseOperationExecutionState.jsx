import {
  buildSalesOperationNoticeMessage,
  buildSalesOperationPartialNoticeMessage,
  formatSalesOperationFailure,
  getSalesOperationNoticeSeverity,
  getSalesOrderRawStatus,
  getSalesPostingNumber,
} from '../../../../entities/marketing/marketingOrderFields.jsx';
import {
  createOzonPackageLabelForPurchase,
  isOzonAwaitingDeliveryPendingError,
  isOzonAwaitingDeliveryRawStatus,
  isOzonPackageLabelNotReadyError,
  prepareOzonForPurchaseForecast,
  readOzonPurchaseForecastState,
  submitSalesOrderCancel,
  submitSalesOrderShip,
} from '../../../../entities/marketing/marketingSnapshotRuntime.jsx';
import { canUseOzonShop } from '../../../../entities/order/orderShopScope.jsx';
import {
  readSavedCrossBorderOrderSettings,
  requestProtectedCrossBorderOrderOperation,
} from '../../../../entities/order/crossBorderOrderApi.jsx';
import { isCrossBorderArrayConversionError } from '../../../../entities/order/orderSourceLinks.jsx';
import {
  assertNoExistingPurchaseCrossBorderForecast,
  buildPurchaseCrossBorderCancelBody,
  buildPurchaseCrossBorderCreateBody,
  buildPurchaseCrossBorderPackageBody,
  buildPurchaseCrossBorderSheetBody,
  getFriendlyPurchaseOperationError,
  getPurchaseForecastServiceSelection,
  getPurchaseOrderShop,
  normalizeCrossBorderOrderCreateResult,
  requestPurchaseCrossBorderDetailByOrderId,
  requestPurchaseOrderOzonDeliveryRoute,
  submitPurchaseOzonAwaitingDelivery,
} from '../../../../services/purchaseCrossBorderRuntime.js';
import { countPurchaseOrderModule } from '../lib/purchaseOrderNormalize.jsx';
import { getPurchaseOrderRecordKey } from '../lib/purchaseMarketingApi.jsx';
import {
  getPurchaseForecastStageText,
  isPurchaseForecastCompleted,
  isPurchaseForecastLabelReady,
  isPurchaseForecastOzonPrepared,
  mergePurchaseForecastFlow,
  normalizePurchaseForecastExecutionMode,
  normalizePurchaseForecastFlow,
  purchaseForecastExecutionModes,
  purchaseForecastStages,
} from '../lib/purchaseForecastFlow.js';
import {
  isPurchaseBatchCancelOrderEligible,
  resolveStrictPurchaseOrderShop,
} from '../lib/purchaseBatchCancelRules.js';
import React from 'react';

const PURCHASE_FORECAST_LABEL_MONITOR_ATTEMPTS = 3;
const PURCHASE_FORECAST_LABEL_MONITOR_DELAY_MS = 1_500;

function waitForPurchaseForecastPoll(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

export function usePurchaseOperationExecutionState({
  selectedOrder,
  selectedOrderActionKeysByStatus,
  selectedActionFlags,
  status,
  selectedOrderActionDefinitions,
  filteredOrders,
  selectedOrderId,
  setSelectedOrderId,
  visibleOrders,
  purchaseOperation,
  setPurchaseOperation,
  shop,
  shops,
  activeShop,
  productSourceLinks,
  legacyPurchaseSourceLinks,
  setCrossBorderReadByOrderId,
  persistPurchaseCrossBorderDetail,
  persistPurchaseForecastFlow,
  showPurchaseNotice,
  readCrossBorderForOrder,
  handleRefreshPurchaseOrders,
  markPurchaseOrderAwaitingDeliveryPending,
  purchaseOrderCountRows,
  purchaseOrderModuleCounts,
  setSelectedPurchaseOrderKeys,
} = {}) {
  const purchaseOperationExecutingRef = React.useRef(false);
  const purchaseForecastAutoRunningRef = React.useRef(false);
  const purchaseOperationRef = React.useRef(purchaseOperation);
  React.useEffect(() => {
    purchaseOperationRef.current = purchaseOperation;
  }, [purchaseOperation]);
  const updatePurchaseOperationState = (updater) => {
    const applyUpdate = (current) => (typeof updater === 'function' ? updater(current) : updater);
    purchaseOperationRef.current = applyUpdate(purchaseOperationRef.current);
    setPurchaseOperation((current) => {
      const next = applyUpdate(current);
      purchaseOperationRef.current = next;
      return next;
    });
  };
  const selectedOrderActionKeys = selectedOrder.manualClassified
    ? [...(selectedOrderActionKeysByStatus[selectedActionFlags.status] ?? []), 'restoreAutoClassify']
    : (selectedOrderActionKeysByStatus[selectedActionFlags.status] ?? []);
  const selectedOrderActionItems = selectedOrderActionKeys
    .map((key) => ({ key, ...selectedOrderActionDefinitions[key] }))
    .filter((item) => item.label);
  React.useEffect(() => {
    if (!filteredOrders.length) {
      if (selectedOrderId) setSelectedOrderId('');
      return;
    }
    const preferredDetailRows = visibleOrders.length ? visibleOrders : filteredOrders;
    if (!preferredDetailRows.some((order) => order.id === selectedOrderId)) {
      setSelectedOrderId(preferredDetailRows[0].id);
    }
  }, [filteredOrders, selectedOrderId, visibleOrders, setSelectedOrderId]);
  const purchaseForecastMode = purchaseOperation.fields?.forecastMode || 'create';
  const purchaseOperationMeta = React.useMemo(() => {
    const isRepairForecast = purchaseForecastMode === 'repair';
    const map = {
      createForecast: {
        title: isRepairForecast ? '补录预报订单' : '创建预报订单',
        body: isRepairForecast
          ? '当前订单从面单检查开始。面单生成后，预报按钮才会开启；每一步都会单独保存，不会重复提交 Ozon 备货。'
          : '按 Ozon 备货、监控面单、预报订单三步执行。每一步都会单独保存，失败后只继续当前步骤。',
        confirmText: isRepairForecast ? '确认补录预报' : '确认预报',
        color: 'warning',
      },
      updateSheet: {
        title: '更新面单',
        body: '会把新的面单号或面单文件写入跨境巴士订单。未打包订单才适合操作。',
        confirmText: '确认更新',
        color: 'warning',
      },
      updatePackage: {
        title: '更新包裹',
        body: '会替换跨境巴士订单里原有包裹信息，请确认采购单号和国内快递单号无误。',
        confirmText: '确认替换',
        color: 'warning',
      },
      cancelCrossBorder: {
        title: '废弃预报订单',
        body: '会废弃跨境巴士预报订单。订单必须是待打包状态，操作后需要重新核对。',
        confirmText: '确认废弃',
        color: 'error',
      },
      ozonAwaitingDelivery: {
        title: '提交待发货',
        body: '会把 Ozon 订单提交到待发货节点，请确认跨境巴士预报和包裹信息已处理。',
        confirmText: '确认提交',
        color: 'warning',
      },
      ozonShip: {
        title: '确认发货',
        body: '会向 Ozon 提交发货。提交后订单状态会变化，请确认包裹已经可以发出。',
        confirmText: '确认发货',
        color: 'warning',
      },
      ozonCancel: {
        title: '取消订单',
        body: '会向 Ozon 提交取消订单。请先选择 Ozon 返回的取消原因。',
        confirmText: '确认取消',
        color: 'error',
      },
      ozonBatchCancel: {
        title: '批量取消订单',
        body: '只会把已选且通过状态、拆单和店铺归属核验的订单逐个提交 Ozon；未回读确认前不会显示为取消完成。',
        confirmText: '确认批量取消',
        color: 'error',
      },
    };
    return (
      map[purchaseOperation.type] ?? {
        title: '确认操作',
        body: '该操作会写入外部平台，请确认后执行。',
        confirmText: '确认执行',
        color: 'warning',
      }
    );
  }, [purchaseOperation.type, purchaseForecastMode]);
  const purchaseCancelReasons = Array.isArray(purchaseOperation.cancelReasons)
    ? purchaseOperation.cancelReasons
    : [];
  const purchaseForecastOrder = purchaseOperation.order || selectedOrder || {};
  const purchaseForecastShop = getPurchaseOrderShop(shops, purchaseForecastOrder, activeShop);
  const purchaseForecastFlow = normalizePurchaseForecastFlow(purchaseOperation.forecastFlow || {}, {
    order: purchaseForecastOrder,
    shop: purchaseForecastShop,
  });
  const purchaseForecastExecutionMode = normalizePurchaseForecastExecutionMode(
    purchaseOperation.fields?.forecastExecutionMode || purchaseForecastFlow.executionMode
  );
  const purchaseForecastServiceSelection = getPurchaseForecastServiceSelection(
    {},
    purchaseOperation.fields || {},
  );
  const purchaseForecastServiceReady =
    !purchaseOperation.serviceOptionsLoading &&
    !purchaseOperation.serviceOptionsError &&
    purchaseForecastServiceSelection.requiredOptions.length > 0 &&
    Boolean(purchaseForecastServiceSelection.requiredId);
  const purchaseForecastConfirmed =
    purchaseOperation.open &&
    purchaseOperation.type === 'createForecast' &&
    purchaseOperation.confirmed &&
    purchaseForecastServiceReady &&
    !purchaseOperation.loading &&
    !purchaseOperation.autoRunning;
  const canPreparePurchaseForecastOzon =
    purchaseForecastConfirmed &&
    !isPurchaseForecastOzonPrepared(purchaseForecastFlow) &&
    !isPurchaseForecastCompleted(purchaseForecastFlow);
  const canCheckPurchaseForecastLabel =
    purchaseForecastConfirmed &&
    isPurchaseForecastOzonPrepared(purchaseForecastFlow) &&
    !isPurchaseForecastLabelReady(purchaseForecastFlow) &&
    !isPurchaseForecastCompleted(purchaseForecastFlow);
  const canSubmitPurchaseForecast =
    purchaseForecastConfirmed &&
    isPurchaseForecastLabelReady(purchaseForecastFlow) &&
    !isPurchaseForecastCompleted(purchaseForecastFlow);
  const canRunPurchaseForecastAuto =
    purchaseOperation.open &&
    purchaseOperation.type === 'createForecast' &&
    purchaseOperation.confirmed &&
    purchaseForecastServiceReady &&
    purchaseForecastExecutionMode === purchaseForecastExecutionModes.auto &&
    !purchaseOperation.loading &&
    !purchaseOperation.autoRunning &&
    !isPurchaseForecastCompleted(purchaseForecastFlow);
  const canSubmitPurchaseOperation =
    purchaseOperation.open &&
    purchaseOperation.confirmed &&
    !purchaseOperation.loading &&
    !purchaseOperation.cancelReasonsLoading &&
    !purchaseOperation.cancelReasonsError &&
    (!['ozonCancel', 'ozonBatchCancel'].includes(purchaseOperation.type) ||
      purchaseCancelReasons.some(
        (reason) => String(reason.id) === String(purchaseOperation.fields?.cancelReasonId || '')
      ));

  const commitPurchaseForecastFlow = (order, resolvedShop, currentFlow, patch = {}) => {
    const nextFlow = mergePurchaseForecastFlow(currentFlow, patch, { order, shop: resolvedShop });
    updatePurchaseOperationState((current) => ({
      ...current,
      forecastFlow: nextFlow,
      forecastMessage: getPurchaseForecastStageText(nextFlow),
    }));
    if (typeof persistPurchaseForecastFlow === 'function') {
      persistPurchaseForecastFlow(order, nextFlow);
    }
    return nextFlow;
  };

  const updatePurchaseForecastExecutionMode = (mode) => {
    const nextMode = normalizePurchaseForecastExecutionMode(mode);
    const currentOperation = purchaseOperationRef.current;
    if (
      !currentOperation?.open ||
      currentOperation.type !== 'createForecast' ||
      currentOperation.loading ||
      currentOperation.autoRunning
    ) return;
    const operationOrder = currentOperation.order || selectedOrder || {};
    const resolvedShop = getPurchaseOrderShop(shops, operationOrder, activeShop);
    const currentFlow = normalizePurchaseForecastFlow(currentOperation.forecastFlow || {}, {
      order: operationOrder,
      shop: resolvedShop,
    });
    const nextFlow = mergePurchaseForecastFlow(currentFlow, { executionMode: nextMode }, {
      order: operationOrder,
      shop: resolvedShop,
    });
    updatePurchaseOperationState((current) => ({
      ...current,
      fields: {
        ...current.fields,
        forecastExecutionMode: nextMode,
      },
      forecastFlow: nextFlow,
    }));
    if (typeof persistPurchaseForecastFlow === 'function') {
      persistPurchaseForecastFlow(operationOrder, nextFlow);
    }
  };

  const validatePurchaseForecastStep = async (operationOrder, resolvedShop, fields, options = {}) => {
    if (!canUseOzonShop(resolvedShop)) throw new Error('当前店铺未配置 Ozon 接口，不能处理预报。');
    const settings = readSavedCrossBorderOrderSettings();
    const createBodyOptions = {
      productSourceLinks,
      legacySourceLinks: legacyPurchaseSourceLinks,
    };
    const precheck = buildPurchaseCrossBorderCreateBody(settings, operationOrder, fields, {
      ...createBodyOptions,
      requireSheet: options.requireSheet === true,
    });
    if (precheck.missing.length) throw new Error(`缺少${precheck.missing.join('、')}，不能处理预报订单。`);
    try {
      await assertNoExistingPurchaseCrossBorderForecast(settings, operationOrder);
    } catch (error) {
      if (!isCrossBorderArrayConversionError(error)) throw error;
    }
    return { settings, createBodyOptions };
  };

  const executePurchaseForecastOzonPrepare = async () => {
    const currentOperation = purchaseOperationRef.current;
    if (
      !currentOperation.open ||
      currentOperation.type !== 'createForecast' ||
      purchaseOperationExecutingRef.current ||
      currentOperation.loading
    )
      return null;
    const operationOrder = currentOperation.order || selectedOrder;
    if (!operationOrder?.id) return null;
    if (!currentOperation.confirmed) {
      updatePurchaseOperationState((current) => ({ ...current, error: '请先勾选确认真实写入。' }));
      return null;
    }
    const resolvedShop = getPurchaseOrderShop(shops, operationOrder, activeShop);
    const fields = currentOperation.fields || {};
    let currentFlow = normalizePurchaseForecastFlow(currentOperation.forecastFlow || {}, {
      order: operationOrder,
      shop: resolvedShop,
    });
    const flowAtStart = currentFlow;
    purchaseOperationExecutingRef.current = true;
    updatePurchaseOperationState((current) => ({
      ...current,
      loading: true,
      activeForecastStep: 'ozon',
      error: '',
      forecastMessage: '正在读取 Ozon 当前状态',
    }));

    try {
      await validatePurchaseForecastStep(operationOrder, resolvedShop, fields, { requireSheet: false });
      if (fields.forecastMode === 'repair') {
        const refreshed = await readOzonPurchaseForecastState(resolvedShop, operationOrder, {
          syncSource: 'purchase-forecast-repair-verify',
          requestedBy: 'purchase-forecast-repair-flow',
        });
        if (!isOzonAwaitingDeliveryRawStatus(refreshed.rawStatus)) {
          throw new Error(`Ozon 后台当前仍为 ${refreshed.rawStatus || '未返回'}，不能跳过备货。`);
        }
        const now = new Date().toISOString();
        currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
          stage: purchaseForecastStages.labelWaiting,
          ozonStatus: refreshed.rawStatus,
          ozonPreparedAt: currentFlow.ozonPreparedAt || now,
          lastCheckedAt: now,
          lastError: '',
        });
        showPurchaseNotice('当前订单已跳过重复备货，可以开始监控面单。', 'info');
        return currentFlow;
      }

      currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
        stage: purchaseForecastStages.ozonPreparing,
        lastError: '',
      });
      let prepared;
      try {
        prepared = await prepareOzonForPurchaseForecast(resolvedShop, {
          ...operationOrder,
          posting: getSalesPostingNumber(operationOrder) || operationOrder.id,
        });
      } catch (error) {
        if (!/HAS_INCORRECT_STATUS/i.test(error instanceof Error ? error.message : String(error))) throw error;
        const refreshed = await readOzonPurchaseForecastState(resolvedShop, operationOrder, {
          syncSource: 'purchase-forecast-after-status-conflict',
        });
        if (!isOzonAwaitingDeliveryRawStatus(refreshed.rawStatus)) throw error;
        prepared = { ...refreshed, skipped: true };
      }
      const now = new Date().toISOString();
      currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
        stage: purchaseForecastStages.ozonPrepared,
        ozonStatus: prepared?.rawStatus || 'awaiting_packaging',
        ozonPreparedAt: currentFlow.ozonPreparedAt || now,
        lastCheckedAt: now,
        lastError: '',
      });
      showPurchaseNotice(
        prepared?.skipped ? 'Ozon 已经完成备货，没有重复提交。下一步监控面单。' : 'Ozon 已接收备货。下一步监控面单。',
        'success'
      );
      return currentFlow;
    } catch (error) {
      const friendly = getFriendlyPurchaseOperationError(error);
      currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
        stage: isPurchaseForecastOzonPrepared(flowAtStart)
          ? flowAtStart.stage
          : purchaseForecastStages.idle,
        lastError: friendly,
      });
      updatePurchaseOperationState((current) => ({ ...current, error: friendly }));
      return null;
    } finally {
      purchaseOperationExecutingRef.current = false;
      updatePurchaseOperationState((current) => ({
        ...current,
        loading: false,
        activeForecastStep: '',
      }));
    }
  };

  const executePurchaseForecastLabelCheck = async (options = {}) => {
    const currentOperation = purchaseOperationRef.current;
    if (
      !currentOperation.open ||
      currentOperation.type !== 'createForecast' ||
      purchaseOperationExecutingRef.current ||
      currentOperation.loading
    )
      return null;
    const operationOrder = currentOperation.order || selectedOrder;
    if (!operationOrder?.id) return null;
    if (!currentOperation.confirmed) {
      updatePurchaseOperationState((current) => ({ ...current, error: '请先勾选确认真实写入。' }));
      return null;
    }
    const resolvedShop = getPurchaseOrderShop(shops, operationOrder, activeShop);
    let currentFlow = normalizePurchaseForecastFlow(currentOperation.forecastFlow || {}, {
      order: operationOrder,
      shop: resolvedShop,
    });
    if (!isPurchaseForecastOzonPrepared(currentFlow)) {
      updatePurchaseOperationState((current) => ({ ...current, error: '请先完成 Ozon 备货。' }));
      return null;
    }

    purchaseOperationExecutingRef.current = true;
    updatePurchaseOperationState((current) => ({
      ...current,
      loading: true,
      activeForecastStep: 'label',
      error: '',
      forecastMessage: '正在监控 Ozon 状态和面单',
    }));
    try {
      currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
        stage: purchaseForecastStages.labelWaiting,
        lastError: '',
      });
      let label = null;
      const monitorAttempts = options.auto === true
        ? PURCHASE_FORECAST_LABEL_MONITOR_ATTEMPTS * 2
        : PURCHASE_FORECAST_LABEL_MONITOR_ATTEMPTS;
      for (let attempt = 0; attempt < monitorAttempts; attempt += 1) {
        const state = await readOzonPurchaseForecastState(resolvedShop, operationOrder, {
          syncSource: 'purchase-forecast-label-monitor',
          priority: 'P0',
          profile: 'readback',
          timeoutMs: 12_000,
          orderSyncTimeoutMs: 10_000,
          orderSyncPollIntervalMs: 400,
        });
        const checkedAt = new Date().toISOString();
        currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
          stage: purchaseForecastStages.labelWaiting,
          ozonStatus: state.rawStatus,
          lastCheckedAt: checkedAt,
          lastError: '',
        });

        if (isOzonAwaitingDeliveryRawStatus(state.rawStatus)) {
          try {
            label = await createOzonPackageLabelForPurchase(
              resolvedShop,
              {
                ...operationOrder,
                ...state.detailOrder,
                posting: state.postingNumber,
              },
              {
                maxCreateAttempts: 1,
                initialDetailOrder: state.detailOrder,
                existingTaskId: currentFlow.labelTaskId,
                orderSyncPollIntervalMs: 750,
                orderSyncTimeoutMs: 10_000,
              }
            );
          } catch (error) {
            if (!isOzonPackageLabelNotReadyError(error) && !isOzonAwaitingDeliveryPendingError(error)) {
              throw error;
            }
            if (error?.taskId) {
              currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
                stage: purchaseForecastStages.labelWaiting,
                labelTaskId: String(error.taskId),
                lastError: '',
              });
            }
          }
        } else if (state.rawStatus && state.rawStatus !== 'awaiting_packaging') {
          throw new Error(`Ozon 当前状态是 ${state.rawStatus}，无法继续生成面单。`);
        }

        if (label?.sheetUrl && label?.sheetOrderSn) break;
        if (attempt + 1 < monitorAttempts) {
          updatePurchaseOperationState((current) => ({
            ...current,
            forecastMessage: `Ozon 面单尚未生成，继续监控（${attempt + 1}/${monitorAttempts}）`,
          }));
          await waitForPurchaseForecastPoll(PURCHASE_FORECAST_LABEL_MONITOR_DELAY_MS);
        }
      }

      if (!label?.sheetUrl || !label?.sheetOrderSn) {
        const waitingMessage = 'Ozon 面单仍在生成，进度已经保存。稍后点击“继续监控面单”即可接着检查。';
        currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
          stage: purchaseForecastStages.labelWaiting,
          lastError: '',
        });
        updatePurchaseOperationState((current) => ({ ...current, forecastMessage: waitingMessage }));
        showPurchaseNotice(waitingMessage, 'warning');
        return currentFlow;
      }

      const readyAt = new Date().toISOString();
      currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
        stage: purchaseForecastStages.labelReady,
        labelTaskId: label.taskId,
        sheetOrderSn: label.sheetOrderSn,
        sheetUrl: label.sheetUrl,
        labelReadyAt: readyAt,
        lastCheckedAt: readyAt,
        lastError: '',
      });
      updatePurchaseOperationState((current) => ({
        ...current,
        fields: {
          ...current.fields,
          sheetOrderSn: label.sheetOrderSn,
          sheetUrl: label.sheetUrl,
        },
      }));
      showPurchaseNotice('Ozon 面单已经生成，可以进行第三步预报订单。', 'success');
      return currentFlow;
    } catch (error) {
      const friendly = getFriendlyPurchaseOperationError(error);
      currentFlow = commitPurchaseForecastFlow(operationOrder, resolvedShop, currentFlow, {
        stage: purchaseForecastStages.labelWaiting,
        lastError: friendly,
      });
      updatePurchaseOperationState((current) => ({ ...current, error: friendly }));
      return null;
    } finally {
      purchaseOperationExecutingRef.current = false;
      updatePurchaseOperationState((current) => ({
        ...current,
        loading: false,
        activeForecastStep: '',
      }));
    }
  };

  const executePurchaseOperation = async () => {
    const operationSnapshot = purchaseOperationRef.current;
    if (!operationSnapshot.open || purchaseOperationExecutingRef.current || operationSnapshot.loading) return;
    const isBatchCancel = operationSnapshot.type === 'ozonBatchCancel';
    const operationOrders = isBatchCancel
      ? (Array.isArray(operationSnapshot.orders) ? operationSnapshot.orders : []).filter(Boolean)
      : [operationSnapshot.order || selectedOrder].filter(Boolean);
    const operationOrder = operationOrders[0];
    if (!operationOrder?.id) {
      updatePurchaseOperationState((current) => ({ ...current, error: '没有可执行的订单。' }));
      return;
    }
    if (!operationSnapshot.confirmed) {
      updatePurchaseOperationState((current) => ({ ...current, error: '请先勾选确认真实写入。' }));
      return;
    }
    if (['ozonCancel', 'ozonBatchCancel'].includes(operationSnapshot.type)) {
      const selectedCancelReason = purchaseCancelReasons.find(
        (reason) => String(reason.id) === String(operationSnapshot.fields?.cancelReasonId || '')
      );
      if (
        operationSnapshot.cancelReasonsLoading ||
        operationSnapshot.cancelReasonsError ||
        !selectedCancelReason
      ) {
        updatePurchaseOperationState((current) => ({ ...current, error: '请先选择 Ozon 返回的有效取消原因。' }));
        return;
      }
    }
    purchaseOperationExecutingRef.current = true;
    updatePurchaseOperationState((current) => ({
      ...current,
      loading: true,
      activeForecastStep: operationSnapshot.type === 'createForecast' ? 'forecast' : '',
      error: '',
    }));

    let purchaseForecastCompletedSuccessfully = false;
    try {
      const settings = ['createForecast', 'updateSheet', 'updatePackage', 'cancelCrossBorder'].includes(
        operationSnapshot.type
      )
        ? readSavedCrossBorderOrderSettings()
        : null;
      const fields = operationSnapshot.fields || {};
      const shop = getPurchaseOrderShop(shops, operationOrder, activeShop);

      if (operationSnapshot.type === 'createForecast') {
        let currentFlow = normalizePurchaseForecastFlow(operationSnapshot.forecastFlow || {}, {
          order: operationOrder,
          shop,
        });
        if (!isPurchaseForecastLabelReady(currentFlow)) {
          throw new Error('Ozon 面单尚未生成，请先完成前两步。');
        }
        const label = {
          taskId: currentFlow.labelTaskId,
          sheetOrderSn: currentFlow.sheetOrderSn,
          sheetUrl: currentFlow.sheetUrl,
        };
        const forecastFields = {
          ...fields,
          dataStatus: '1',
          sheetOrderSn: label.sheetOrderSn,
          sheetUrl: label.sheetUrl,
        };
        try {
          const { settings: forecastSettings, createBodyOptions } = await validatePurchaseForecastStep(
            operationOrder,
            shop,
            forecastFields,
            { requireSheet: true }
          );
          currentFlow = commitPurchaseForecastFlow(operationOrder, shop, currentFlow, {
            stage: purchaseForecastStages.forecastSubmitting,
            lastError: '',
          });
          const routeDetail = await requestPurchaseOrderOzonDeliveryRoute(shop, operationOrder).catch(() => null);
          const { missing, body } = buildPurchaseCrossBorderCreateBody(
            forecastSettings,
            operationOrder,
            {
              ...forecastFields,
              routeRemark: routeDetail?.deliveryMethod || fields.routeRemark || '',
            },
            {
              ...createBodyOptions,
              routeText: routeDetail?.deliveryMethod || fields.routeRemark || '',
            }
          );
          if (missing.length) throw new Error(`缺少${missing.join('、')}，不能创建预报订单。`);

          let created = {
            orderId: currentFlow.crossBorderOrderId || fields.orderId || operationOrder.packageOrderId || '',
            orderNumber: currentFlow.crossBorderOrderNumber || forecastFields.orderNumber || '',
          };
          if (!created.orderId) {
            const result = await requestProtectedCrossBorderOrderOperation('createOrder', forecastSettings, body, {
              confirmed: true,
              shopId: shop?.id || '',
              shopClientId: shop?.clientId || '',
            });
            created = normalizeCrossBorderOrderCreateResult(result);
            if (!created.orderId) throw new Error('跨境巴士预报成功响应缺少订单ID，已停止后续关联。');
            currentFlow = commitPurchaseForecastFlow(operationOrder, shop, currentFlow, {
              stage: purchaseForecastStages.forecastSubmitting,
              crossBorderOrderId: created.orderId,
              crossBorderOrderNumber: created.orderNumber || forecastFields.orderNumber || '',
              lastError: '',
            });
          }
          const createdPersistFallback = {
            crossBorderOrderFound: false,
            orderId: created.orderId,
            orderNumber: created.orderNumber || forecastFields.orderNumber || '',
            sheetOrderSn: label.sheetOrderSn,
            sheetUrl: label.sheetUrl,
            crossBorderStatus: '待打包',
            readStatus: '已创建预报，待关联店铺订单',
          };
          setCrossBorderReadByOrderId((current) => ({
            ...current,
            [operationOrder.id]: {
              ...(current[operationOrder.id] ?? {}),
              orderId: created.orderId,
              orderNumber: created.orderNumber || forecastFields.orderNumber || '',
              sheetOrderSn: label.sheetOrderSn,
              sheetUrl: label.sheetUrl,
              message: '已创建预报，正在关联店铺订单',
              loading: false,
              error: '',
            },
          }));
          persistPurchaseCrossBorderDetail(operationOrder, created, createdPersistFallback);
          const numericOrderId = Number(created.orderId);
          const associationBody = {
            order_id: Number.isSafeInteger(numericOrderId) && numericOrderId > 0 ? numericOrderId : created.orderId,
          };
          if (!currentFlow.associationCompletedAt) {
            await requestProtectedCrossBorderOrderOperation('associateOrder', forecastSettings, associationBody, {
              confirmed: true,
              shopId: shop?.id || '',
              shopClientId: shop?.clientId || '',
            });
            currentFlow = commitPurchaseForecastFlow(operationOrder, shop, currentFlow, {
              stage: purchaseForecastStages.forecastSubmitting,
              associationCompletedAt: new Date().toISOString(),
              lastError: '',
            });
          }
          if (!currentFlow.statusSyncCompletedAt) {
            await requestProtectedCrossBorderOrderOperation('syncOrderStatus', forecastSettings, associationBody, {
              confirmed: true,
              shopId: shop?.id || '',
              shopClientId: shop?.clientId || '',
            });
            currentFlow = commitPurchaseForecastFlow(operationOrder, shop, currentFlow, {
              stage: purchaseForecastStages.forecastSubmitting,
              statusSyncCompletedAt: new Date().toISOString(),
              lastError: '',
            });
          }
          const verifiedDetail = await requestPurchaseCrossBorderDetailByOrderId(
            forecastSettings,
            {
              ...operationOrder,
              packageOrderId: created.orderId,
              returnNo: created.orderNumber || operationOrder.returnNo,
            },
            created.orderId,
            shop,
          );
          if (!verifiedDetail?.orderId || !verifiedDetail?.readStatus || verifiedDetail.readStatus === '未返回') {
            throw new Error('跨境巴士关联和状态同步已提交，但订单状态回读未确认。');
          }
          const completedPersistFallback = {
            ...createdPersistFallback,
            crossBorderOrderFound: true,
            readStatus: verifiedDetail.readStatus,
          };
          setCrossBorderReadByOrderId((current) => ({
            ...current,
            [operationOrder.id]: {
              ...(current[operationOrder.id] ?? {}),
              ...verifiedDetail,
              loading: false,
              error: '',
              finishedAt: Date.now(),
            },
          }));
          persistPurchaseCrossBorderDetail(operationOrder, verifiedDetail, completedPersistFallback);
          const completedAt = new Date().toISOString();
          currentFlow = commitPurchaseForecastFlow(operationOrder, shop, currentFlow, {
            stage: purchaseForecastStages.completed,
            crossBorderOrderFound: true,
            crossBorderOrderId: created.orderId || verifiedDetail.orderId || '',
            crossBorderOrderNumber: created.orderNumber || verifiedDetail?.orderNumber || '',
            forecastCompletedAt: completedAt,
            lastCheckedAt: completedAt,
            lastError: '',
          });
          purchaseForecastCompletedSuccessfully = true;
          showPurchaseNotice('预报成功：跨境巴士已关联店铺订单、同步状态并回查确认。', 'success');
        } catch (error) {
          const friendly = getFriendlyPurchaseOperationError(error);
          currentFlow = commitPurchaseForecastFlow(operationOrder, shop, currentFlow, {
            stage: currentFlow.crossBorderOrderId
              ? purchaseForecastStages.forecastSubmitting
              : purchaseForecastStages.labelReady,
            lastError: friendly,
          });
          throw new Error(`Ozon 面单已保留，但跨境巴士预报失败。${friendly ? ` ${friendly}` : ''}`);
        }
      } else if (operationSnapshot.type === 'updateSheet') {
        const { missing, body } = buildPurchaseCrossBorderSheetBody(fields);
        if (missing.length) throw new Error(`缺少${missing.join('、')}，不能更新面单。`);
        await requestProtectedCrossBorderOrderOperation('updateOrderSheet', settings, body, {
          confirmed: true,
          shopId: shop?.id || '',
          shopClientId: shop?.clientId || '',
        });
        const sheetReadBack = await readCrossBorderForOrder(operationOrder, { force: true }).catch(() => null);
        showPurchaseNotice(
          sheetReadBack ? '跨境巴士面单已提交并回查确认。' : '跨境巴士面单已提交，等待回查确认；回查未确认前不算完成。',
          sheetReadBack ? 'success' : 'warning'
        );
      } else if (operationSnapshot.type === 'updatePackage') {
        const { missing, body } = buildPurchaseCrossBorderPackageBody(operationOrder, fields);
        if (missing.length) throw new Error(`缺少${missing.join('、')}，不能更新包裹。`);
        await requestProtectedCrossBorderOrderOperation('updateOrderPackage', settings, body, {
          confirmed: true,
          shopId: shop?.id || '',
          shopClientId: shop?.clientId || '',
        });
        const packageReadBack = await readCrossBorderForOrder(operationOrder, { force: true }).catch(() => null);
        showPurchaseNotice(
          packageReadBack
            ? '跨境巴士包裹已提交并回查确认。'
            : '跨境巴士包裹已提交，等待回查确认；回查未确认前不算完成。',
          packageReadBack ? 'success' : 'warning'
        );
      } else if (operationSnapshot.type === 'cancelCrossBorder') {
        const { missing, body } = buildPurchaseCrossBorderCancelBody(fields);
        if (missing.length) throw new Error(`缺少${missing.join('、')}，不能废弃预报订单。`);
        await requestProtectedCrossBorderOrderOperation('cancelOrder', settings, body, {
          confirmed: true,
          shopId: shop?.id || '',
          shopClientId: shop?.clientId || '',
        });
        const cancelReadBack = await readCrossBorderForOrder(operationOrder, { force: true }).catch(() => null);
        setCrossBorderReadByOrderId((current) => ({
          ...current,
          [operationOrder.id]: {
            ...(current[operationOrder.id] ?? {}),
            message: cancelReadBack ? '已废弃，回查确认' : '已提交废弃，待回查确认',
            crossBorderStatus: cancelReadBack ? '已废弃' : '待回查确认',
            loading: false,
            error: '',
          },
        }));
        showPurchaseNotice(
          cancelReadBack
            ? '跨境巴士预报订单废弃已回查确认。'
            : '跨境巴士预报订单废弃已提交，等待回查确认；回查未确认前不算完成。',
          cancelReadBack ? 'success' : 'warning'
        );
      } else if (operationSnapshot.type === 'ozonAwaitingDelivery') {
        if (!canUseOzonShop(shop)) throw new Error('当前店铺未配置 Ozon 接口，不能提交。');
        await submitPurchaseOzonAwaitingDelivery(shop, {
          ...operationOrder,
          posting: getSalesPostingNumber(operationOrder) || operationOrder.id,
        });
        await handleRefreshPurchaseOrders();
        showPurchaseNotice('Ozon 订单已提交到待发货。', 'success');
      } else if (operationSnapshot.type === 'ozonShip') {
        if (!canUseOzonShop(shop)) throw new Error('当前店铺未配置 Ozon 接口，不能发货。');
        await submitSalesOrderShip(shop, {
          ...operationOrder,
          posting: getSalesPostingNumber(operationOrder) || operationOrder.id,
        });
        await handleRefreshPurchaseOrders();
        showPurchaseNotice('Ozon 发货已提交。', 'success');
      } else if (operationSnapshot.type === 'ozonBatchCancel') {
        const successEntries = [];
        const failures = [];
        for (const order of operationOrders) {
          try {
            if (!isPurchaseBatchCancelOrderEligible(order)) {
              throw new Error('订单状态已变化，不再满足批量取消条件。');
            }
            const shopResolution = resolveStrictPurchaseOrderShop(order, shops);
            if (!shopResolution.ok || !canUseOzonShop(shopResolution.shop)) {
              throw new Error(shopResolution.reason || '订单缺少可用且匹配的 Ozon 店铺配置。');
            }
            const result = await submitSalesOrderCancel(
              shopResolution.shop,
              { ...order, posting: getSalesPostingNumber(order) || order.id },
              {
                cancelReasonId: fields.cancelReasonId,
                cancelReasonMessage: fields.cancelReasonMessage || '',
              }
            );
            successEntries.push({ order, result });
          } catch (error) {
            failures.push(formatSalesOperationFailure(order, error));
          }
        }

        if (!successEntries.length) {
          const sample = failures.slice(0, 3).join('；');
          const more = failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : '';
          throw new Error(`批量取消结果：无订单提交成功，失败 ${failures.length} 个。${sample}${more}`);
        }

        await handleRefreshPurchaseOrders().catch(() => null);
        const successResults = successEntries.map(
          (entry) => entry.result || { writeStatus: 'submitted_waiting_readback' }
        );
        if (typeof setSelectedPurchaseOrderKeys === 'function') {
          const successKeys = new Set(
            successEntries.map((entry) => getPurchaseOrderRecordKey(entry.order)).filter(Boolean)
          );
          setSelectedPurchaseOrderKeys(
            (current) => new Set([...current].filter((key) => !successKeys.has(key)))
          );
        }
        showPurchaseNotice(
          failures.length
            ? buildSalesOperationPartialNoticeMessage('批量取消订单', successResults, failures)
            : buildSalesOperationNoticeMessage('批量取消订单', successResults),
          failures.length ? 'warning' : getSalesOperationNoticeSeverity(successResults)
        );
      } else if (operationSnapshot.type === 'ozonCancel') {
        if (!canUseOzonShop(shop)) throw new Error('当前店铺未配置 Ozon 接口，不能取消订单。');
        const result = await submitSalesOrderCancel(
          shop,
          { ...operationOrder, posting: getSalesPostingNumber(operationOrder) || operationOrder.id },
          {
            cancelReasonId: fields.cancelReasonId,
            cancelReasonMessage: fields.cancelReasonMessage || '',
          }
        );
        await handleRefreshPurchaseOrders();
        showPurchaseNotice(
          result ? buildSalesOperationNoticeMessage('取消订单', [result]) : '取消订单已提交，等待 Ozon 回读确认。',
          result ? getSalesOperationNoticeSeverity([result]) : 'info'
        );
      }

      updatePurchaseOperationState((current) => ({
        ...current,
        open: operationSnapshot.type === 'createForecast' && !purchaseForecastCompletedSuccessfully,
        loading: false,
        activeForecastStep: '',
        error: '',
      }));
      return true;
    } catch (error) {
      if (operationSnapshot.type === 'createForecast' && isOzonAwaitingDeliveryPendingError(error)) {
        markPurchaseOrderAwaitingDeliveryPending(operationOrder, error);
        await handleRefreshPurchaseOrders().catch(() => null);
      }
      updatePurchaseOperationState((current) => ({
        ...current,
        loading: false,
        activeForecastStep: '',
        error: getFriendlyPurchaseOperationError(error),
      }));
      return false;
    } finally {
      purchaseOperationExecutingRef.current = false;
    }
  };

  const executePurchaseForecastAuto = async () => {
    const initialOperation = purchaseOperationRef.current;
    if (
      !initialOperation?.open ||
      initialOperation.type !== 'createForecast' ||
      initialOperation.loading ||
      initialOperation.autoRunning ||
      purchaseForecastAutoRunningRef.current
    ) return false;
    if (!initialOperation.confirmed) {
      updatePurchaseOperationState((current) => ({ ...current, error: '请先勾选确认真实写入。' }));
      return false;
    }
    const executionMode = normalizePurchaseForecastExecutionMode(
      initialOperation.fields?.forecastExecutionMode || initialOperation.forecastFlow?.executionMode
    );
    if (executionMode !== purchaseForecastExecutionModes.auto) return false;

    purchaseForecastAutoRunningRef.current = true;
    updatePurchaseOperationState((current) => ({
      ...current,
      autoRunning: true,
      error: '',
    }));
    try {
      let operation = purchaseOperationRef.current;
      let operationOrder = operation.order || selectedOrder;
      let resolvedShop = getPurchaseOrderShop(shops, operationOrder, activeShop);
      let flow = normalizePurchaseForecastFlow(operation.forecastFlow || {}, {
        order: operationOrder,
        shop: resolvedShop,
      });

      if (!isPurchaseForecastOzonPrepared(flow)) {
        const preparedFlow = await executePurchaseForecastOzonPrepare();
        if (!preparedFlow || !isPurchaseForecastOzonPrepared(preparedFlow)) return false;
      }

      operation = purchaseOperationRef.current;
      operationOrder = operation.order || selectedOrder;
      resolvedShop = getPurchaseOrderShop(shops, operationOrder, activeShop);
      flow = normalizePurchaseForecastFlow(operation.forecastFlow || {}, {
        order: operationOrder,
        shop: resolvedShop,
      });
      if (!isPurchaseForecastLabelReady(flow)) {
        const labelFlow = await executePurchaseForecastLabelCheck({ auto: true });
        if (!labelFlow || !isPurchaseForecastLabelReady(labelFlow)) return false;
      }

      operation = purchaseOperationRef.current;
      operationOrder = operation.order || selectedOrder;
      resolvedShop = getPurchaseOrderShop(shops, operationOrder, activeShop);
      flow = normalizePurchaseForecastFlow(operation.forecastFlow || {}, {
        order: operationOrder,
        shop: resolvedShop,
      });
      if (isPurchaseForecastCompleted(flow)) return true;
      if (!isPurchaseForecastLabelReady(flow)) return false;
      return await executePurchaseOperation();
    } finally {
      purchaseForecastAutoRunningRef.current = false;
      updatePurchaseOperationState((current) => ({
        ...current,
        autoRunning: false,
      }));
    }
  };
  const stats = React.useMemo(() => [
    {
      title: '全部订单',
      value: String(purchaseOrderModuleCounts?.all ?? countPurchaseOrderModule(purchaseOrderCountRows, 'all')),
      hint: '全部订单',
      tone: 'primary',
    },
    {
      title: '待拍单',
      value: String(purchaseOrderModuleCounts?.['待拍单'] ?? countPurchaseOrderModule(purchaseOrderCountRows, '待拍单')),
      hint: '等待拍单',
      tone: 'warning',
    },
    {
      title: '异常单',
      value: String(purchaseOrderModuleCounts?.exception ?? countPurchaseOrderModule(purchaseOrderCountRows, 'exception')),
      hint: '未操作订单',
      tone: 'error',
    },
    {
      title: '售后单',
      value: String(purchaseOrderModuleCounts?.afterSales ?? countPurchaseOrderModule(purchaseOrderCountRows, 'afterSales')),
      hint: 'Ozon 退款待处理',
      tone: 'error',
    },
  ], [purchaseOrderCountRows, purchaseOrderModuleCounts]);

  return {
    selectedOrderActionItems,
    purchaseOperationMeta,
    canSubmitPurchaseOperation,
    purchaseForecastFlow,
    purchaseForecastExecutionMode,
    canPreparePurchaseForecastOzon,
    canCheckPurchaseForecastLabel,
    canSubmitPurchaseForecast,
    canRunPurchaseForecastAuto,
    updatePurchaseForecastExecutionMode,
    executePurchaseForecastOzonPrepare,
    executePurchaseForecastLabelCheck,
    executePurchaseForecastSubmit: executePurchaseOperation,
    executePurchaseForecastAuto,
    executePurchaseOperation,
    stats,
  };
}

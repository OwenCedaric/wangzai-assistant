import { requestOzonFbsCancelReasons } from '../../../../entities/marketing/marketingOrderFields.jsx';
import { runLimitedAsync } from '../../../../entities/order/orderAsyncRules.jsx';
import { readSavedCrossBorderOrderSettings } from '../../../../entities/order/crossBorderOrderApi.jsx';
import { PURCHASE_BATCH_CROSS_BORDER_CONCURRENCY } from '../../../../shared/config/appConfigCore.jsx';
import {
  getFriendlyPurchaseOperationError,
  getPurchaseForecastServiceSelection,
  getPurchaseOperationInitialFields,
  getPurchaseOrderCrossBorderLookupKey,
  getPurchaseOrderShop,
  normalizePurchaseRouteRemarkText,
  requestPurchaseCrossBorderDetail,
  requestPurchaseForecastServiceOptions,
  requestPurchaseOrderOzonDeliveryRoute,
} from '../../../../services/purchaseCrossBorderRuntime.js';
import { resolvePurchaseInfoOpenAction } from '../../../../services/purchaseInfoSupport.js';
import { isPurchaseOrderPreparedWithoutCrossBorder } from '../lib/purchaseOrderNormalize.jsx';
import {
  getPurchaseForecastFlowFromOrder,
  getPurchaseForecastStageText,
  mergePurchaseForecastFlow,
  normalizePurchaseForecastExecutionMode,
  purchaseForecastStages,
} from '../lib/purchaseForecastFlow.js';
import React from 'react';

export function usePurchaseCrossBorderState({
  setCrossBorderReadByOrderId,
  shops,
  activeShop,
  persistPurchaseCrossBorderDetail,
  selectedPurchaseOrders,
  showPurchaseNotice,
  status,
  purchaseOperation,
  setPurchaseOperation,
  selectedOrder,
  crossBorderReadByOrderId,
  productSourceLinks,
  legacyPurchaseSourceLinks,
  shop,
  hasSelectedOrder,
  selectedActionState,
  setPurchasePlatformExpanded,
  openPurchaseOrderWorkbench,
} = {}) {
  const readCrossBorderForOrder = React.useCallback(
    async (order, options = {}) => {
      if (!order?.id) return null;
      const isBackground = options.background === true;
      const lookupKey = `${getPurchaseOrderCrossBorderLookupKey(order)}|${options.force ? Date.now() : ''}`;
      if (!isBackground) {
        setCrossBorderReadByOrderId((current) => ({
          ...current,
          [order.id]: {
            ...(current[order.id] ?? {}),
            previousMessage: current[order.id]?.message || '',
            previousReadStatus: current[order.id]?.readStatus || '',
            lookupKey,
            loading: true,
            message: '正在读取',
            error: '',
            requestedAt: Date.now(),
          },
        }));
      }

      try {
        const settings = readSavedCrossBorderOrderSettings();
        const ozonShop = getPurchaseOrderShop(shops, order, activeShop);
        const detail = await requestPurchaseCrossBorderDetail(settings, order, ozonShop);
        setCrossBorderReadByOrderId((current) => {
          const currentEntry = current[order.id] ?? {};
          if (currentEntry.lookupKey && currentEntry.lookupKey !== lookupKey) return current;
          const stableCurrentEntry = { ...currentEntry };
          delete stableCurrentEntry.previousMessage;
          delete stableCurrentEntry.previousReadStatus;
          return {
            ...current,
            [order.id]: {
              ...stableCurrentEntry,
              ...detail,
              lookupKey,
              loading: false,
              error: '',
              finishedAt: Date.now(),
            },
          };
        });
        persistPurchaseCrossBorderDetail(order, detail);
        return detail;
      } catch (error) {
        const friendlyError = getFriendlyPurchaseOperationError(error);
        if (!isBackground) {
          setCrossBorderReadByOrderId((current) => {
            const currentEntry = current[order.id] ?? {};
            if (currentEntry.lookupKey && currentEntry.lookupKey !== lookupKey) return current;
            const previousMessage = currentEntry.previousMessage || '';
            const previousReadStatus = currentEntry.previousReadStatus || '';
            const stableCurrentEntry = { ...currentEntry };
            delete stableCurrentEntry.previousMessage;
            delete stableCurrentEntry.previousReadStatus;
            return {
              ...current,
              [order.id]: {
                ...stableCurrentEntry,
                lookupKey,
                loading: false,
                message: previousMessage || '读取失败',
                readStatus: previousReadStatus || currentEntry.readStatus,
                error: friendlyError,
                finishedAt: Date.now(),
              },
            };
          });
        }
        throw error;
      }
    },
    [activeShop, persistPurchaseCrossBorderDetail, shops, setCrossBorderReadByOrderId]
  );
  const handleBatchReadCrossBorder = React.useCallback(async () => {
    if (!selectedPurchaseOrders.length) return;
    showPurchaseNotice(`开始回查 ${selectedPurchaseOrders.length} 个订单。`, 'info');
    const results = await runLimitedAsync(selectedPurchaseOrders, PURCHASE_BATCH_CROSS_BORDER_CONCURRENCY, (order) =>
      readCrossBorderForOrder(order, { force: true })
    );
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    showPurchaseNotice(
      failedCount ? `已完成回查，${failedCount} 个订单未返回。` : '已完成批量回查。',
      failedCount ? 'warning' : 'success'
    );
  }, [readCrossBorderForOrder, selectedPurchaseOrders, showPurchaseNotice]);
  const closePurchaseOperation = () => {
    if (purchaseOperation.loading || purchaseOperation.autoRunning) return;
    setPurchaseOperation((current) => ({
      ...current,
      open: false,
      error: '',
    }));
  };
  const updatePurchaseOperationField = (field) => (event) => {
    setPurchaseOperation((current) => ({
      ...current,
      fields: {
        ...current.fields,
        [field]: event.target.value,
      },
    }));
  };
  const openPurchaseOperation = (type, order = selectedOrder) => {
    if (!order?.id) return;
    const operationShop = getPurchaseOrderShop(shops, order, activeShop);
    const initialFields = getPurchaseOperationInitialFields(type, order, crossBorderReadByOrderId[order.id] ?? {}, {
      productSourceLinks,
      legacySourceLinks: legacyPurchaseSourceLinks,
    });
    const forecastSettings = type === 'createForecast' ? readSavedCrossBorderOrderSettings() : {};
    const savedServiceSelection = getPurchaseForecastServiceSelection(forecastSettings, {});
    const fields = {
      ...initialFields,
      forecastMode: type === 'createForecast' && isPurchaseOrderPreparedWithoutCrossBorder(order) ? 'repair' : 'create',
      ...(type === 'createForecast'
        ? {
            forecastServiceOptions: savedServiceSelection.options,
            requiredServiceId: savedServiceSelection.requiredId,
            optionalServiceIds: [],
          }
        : {}),
    };
    let forecastFlow = type === 'createForecast' ? getPurchaseForecastFlowFromOrder(order, operationShop) : null;
    if (
      type === 'createForecast'
      && fields.forecastMode === 'repair'
      && forecastFlow?.stage === purchaseForecastStages.idle
    ) {
      const now = new Date().toISOString();
      forecastFlow = mergePurchaseForecastFlow(
        forecastFlow,
        {
          stage: purchaseForecastStages.labelWaiting,
          ozonStatus: order.ozonRawStatus || order.rawStatus || 'awaiting_deliver',
          ozonPreparedAt: now,
          lastCheckedAt: now,
        },
        { order, shop: operationShop }
      );
    }
    if (type === 'createForecast') {
      fields.forecastExecutionMode = normalizePurchaseForecastExecutionMode(forecastFlow?.executionMode);
    }
    setPurchaseOperation({
      open: true,
      type,
      order,
      fields,
      forecastFlow,
      forecastMessage: forecastFlow ? getPurchaseForecastStageText(forecastFlow) : '',
      activeForecastStep: '',
      confirmed: false,
      loading: false,
      autoRunning: false,
      serviceOptionsLoading: type === 'createForecast',
      serviceOptionsError: '',
      error: '',
      cancelReasons: [],
      cancelReasonsLoading: type === 'ozonCancel',
      cancelReasonsError: '',
    });

    if (type === 'createForecast') {
      requestPurchaseForecastServiceOptions(forecastSettings, order)
        .then((serviceOptions) => {
          setPurchaseOperation((current) => {
            if (!current.open || current.type !== 'createForecast' || current.order?.id !== order.id) return current;
            const requiredOptions = serviceOptions.filter((option) => option.selectionType === 'required');
            const optionalIds = new Set(
              serviceOptions
                .filter((option) => option.selectionType === 'optional')
                .map((option) => option.id),
            );
            const currentRequiredId = String(current.fields?.requiredServiceId || '').trim();
            const settingsRequiredId = String(forecastSettings.packageService || '').trim();
            const requiredServiceId = requiredOptions.some((option) => option.id === currentRequiredId)
              ? currentRequiredId
              : requiredOptions.some((option) => option.id === settingsRequiredId)
                ? settingsRequiredId
                : requiredOptions[0]?.id || '';
            return {
              ...current,
              serviceOptionsLoading: false,
              serviceOptionsError: '',
              fields: {
                ...current.fields,
                forecastServiceOptions: serviceOptions,
                requiredServiceId,
                optionalServiceIds: (Array.isArray(current.fields?.optionalServiceIds)
                  ? current.fields.optionalServiceIds
                  : []).filter((id) => optionalIds.has(String(id))),
              },
            };
          });
        })
        .catch((error) => {
          setPurchaseOperation((current) => (
            current.open && current.type === 'createForecast' && current.order?.id === order.id
              ? {
                  ...current,
                  serviceOptionsLoading: false,
                  serviceOptionsError: getFriendlyPurchaseOperationError(error),
                }
              : current
          ));
        });
      requestPurchaseOrderOzonDeliveryRoute(operationShop, order)
        .then((routeDetail) => {
          const routeText = normalizePurchaseRouteRemarkText(routeDetail?.deliveryMethod || '');
          if (!routeText) return;
          setPurchaseOperation((current) =>
            current.open && current.type === 'createForecast' && current.order?.id === order.id
              ? {
                  ...current,
                  fields: {
                    ...current.fields,
                    routeRemark: routeText,
                    remark: normalizePurchaseRouteRemarkText(current.fields?.remark || '') || routeText,
                  },
                }
              : current
          );
        })
        .catch(() => undefined);
    }

    if (type === 'ozonCancel') {
      const shop = getPurchaseOrderShop(shops, order, activeShop);
      requestOzonFbsCancelReasons(shop)
        .then((cancelReasons) => {
          setPurchaseOperation((current) =>
            current.open && current.type === 'ozonCancel'
              ? {
                  ...current,
                  cancelReasons,
                  cancelReasonsLoading: false,
                  fields: {
                    ...current.fields,
                    cancelReasonId: cancelReasons[0]?.id || '',
                  },
                }
              : current
          );
        })
        .catch((error) => {
          setPurchaseOperation((current) =>
            current.open && current.type === 'ozonCancel'
              ? {
                  ...current,
                  cancelReasonsLoading: false,
                  cancelReasonsError: getFriendlyPurchaseOperationError(error),
                }
              : current
          );
        });
    }
  };
  const handleReadCrossBorder = () => {
    if (!hasSelectedOrder) return;
    readCrossBorderForOrder(selectedOrder, { force: true })
      .then((detail) => {
        showPurchaseNotice(
          detail?.orderId ? '已回查跨境巴士订单。' : '未查到跨境巴士预报订单。',
          detail?.orderId ? 'success' : 'info'
        );
      })
      .catch((error) => {
        showPurchaseNotice(getFriendlyPurchaseOperationError(error), 'warning');
      });
  };
  const handlePurchaseAction = () => {
    if (!selectedActionState.canPurchase) {
      showPurchaseNotice(selectedActionState.purchaseReason, 'warning');
      return;
    }
    setPurchasePlatformExpanded((current) => !current);
    showPurchaseNotice('请选择采购平台进入搜款流程，付款仍需人工完成。', 'info');
  };
  const handleForecastAction = () => {
    if (!selectedActionState.canForecast) {
      showPurchaseNotice(selectedActionState.forecastReason, 'warning');
      return;
    }
    openPurchaseOperation('createForecast');
  };
  const handleReadVolumeAction = () => {
    if (!hasSelectedOrder) return;
    readCrossBorderForOrder(selectedOrder, { force: true })
      .then((detail) => {
        const hasVolume = Array.isArray(detail?.volumeItems) && detail.volumeItems.length > 0;
        showPurchaseNotice(hasVolume ? '已读取材积信息。' : '暂未返回材积信息。', hasVolume ? 'success' : 'info');
      })
      .catch((error) => {
        showPurchaseNotice(getFriendlyPurchaseOperationError(error), 'warning');
      });
  };
  const handlePurchaseRefundAction = async () => {
    if (!hasSelectedOrder) return;
    const action = resolvePurchaseInfoOpenAction(selectedOrder);
    if (!action.canOpen) {
      showPurchaseNotice('当前订单缺少可核验的采购订单地址或采购单号，未打开退款页面。', 'warning');
      return;
    }
    if (typeof openPurchaseOrderWorkbench !== 'function') {
      showPurchaseNotice('订单操作台尚未就绪，请稍后重试。', 'error');
      return;
    }
    await openPurchaseOrderWorkbench(action.url);
    showPurchaseNotice(`已打开当前采购单 ${action.support.orderNumber}，请核对后手动申请退款。`, 'info');
  };

  return {
    readCrossBorderForOrder,
    handleBatchReadCrossBorder,
    closePurchaseOperation,
    updatePurchaseOperationField,
    openPurchaseOperation,
    handleReadCrossBorder,
    handlePurchaseAction,
    handleForecastAction,
    handleReadVolumeAction,
    handlePurchaseRefundAction,
  };
}

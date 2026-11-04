import { requestOzonFbsCancelReasons } from '../../../../entities/marketing/marketingOrderFields.jsx';
import {
  getPurchaseBatchCancelKey,
  intersectPurchaseCancelReasons,
  preparePurchaseBatchCancelOrders,
} from '../lib/purchaseBatchCancelRules.js';
import React from 'react';

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || '取消原因读取失败。');
}

export function usePurchaseBatchCancelState({
  selectedPurchaseOrders = [],
  shops = [],
  setPurchaseOperation,
  showPurchaseNotice,
} = {}) {
  const operationSequenceRef = React.useRef(0);
  const preparation = React.useMemo(
    () => preparePurchaseBatchCancelOrders(selectedPurchaseOrders, shops),
    [selectedPurchaseOrders, shops]
  );
  const selectedBatchCancellableOrders = React.useMemo(
    () => preparation.readyOrders.map((item) => item.order),
    [preparation.readyOrders]
  );
  const updatePurchaseCancelReason = React.useCallback(
    (event) => {
      const cancelReasonId = event.target.value;
      setPurchaseOperation((current) => {
        const reason = current.cancelReasons.find(
          (item) => String(item.id) === String(cancelReasonId)
        );
        return {
          ...current,
          error: '',
          fields: {
            ...current.fields,
            cancelReasonId,
            cancelReasonMessage: reason?.rawLabel || reason?.label || '',
          },
        };
      });
    },
    [setPurchaseOperation]
  );

  const openPurchaseBatchCancel = React.useCallback(() => {
    if (!preparation.readyCount) {
      showPurchaseNotice?.(
        preparation.excludedCount
          ? `已选订单中没有可安全取消的订单，已排除 ${preparation.excludedCount} 个。`
          : '请先选择要取消的订单。',
        'warning'
      );
      return;
    }

    operationSequenceRef.current += 1;
    const batchKey = selectedBatchCancellableOrders.map(getPurchaseBatchCancelKey).filter(Boolean).sort().join('|');
    const operationId = `purchase:ozonBatchCancel:${operationSequenceRef.current}:${batchKey}`;
    const uniqueShops = [
      ...new Map(preparation.readyOrders.map((item) => [item.shopKey, item.shop])).values(),
    ];

    setPurchaseOperation({
      open: true,
      type: 'ozonBatchCancel',
      order: selectedBatchCancellableOrders[0],
      orders: selectedBatchCancellableOrders,
      operationId,
      batchKey,
      selectedCount: selectedPurchaseOrders.length,
      excludedCount: preparation.excludedCount,
      excludedOrders: preparation.excludedOrders,
      shopCount: preparation.shopCount,
      fields: {
        cancelReasonId: '',
        cancelReasonMessage: '',
      },
      confirmed: false,
      loading: false,
      error: '',
      cancelReasons: [],
      cancelReasonsLoading: true,
      cancelReasonsError: '',
    });

    Promise.all(uniqueShops.map((shop) => requestOzonFbsCancelReasons(shop)))
      .then((reasonLists) => {
        const cancelReasons = intersectPurchaseCancelReasons(reasonLists);
        if (!cancelReasons.length) {
          throw new Error('所选店铺没有共同可用的 Ozon 取消原因，请按店铺分别处理。');
        }
        const defaultReason = cancelReasons[0];
        setPurchaseOperation((current) =>
          current.open && current.type === 'ozonBatchCancel' && current.operationId === operationId
            ? {
                ...current,
                cancelReasons,
                cancelReasonsLoading: false,
                cancelReasonsError: '',
                fields: {
                  ...current.fields,
                  cancelReasonId: defaultReason.id,
                  cancelReasonMessage: defaultReason.rawLabel || defaultReason.label || '',
                },
              }
            : current
        );
      })
      .catch((error) => {
        setPurchaseOperation((current) =>
          current.open && current.type === 'ozonBatchCancel' && current.operationId === operationId
            ? {
                ...current,
                cancelReasons: [],
                cancelReasonsLoading: false,
                cancelReasonsError: `取消原因读取失败：${getErrorMessage(error)}`,
                fields: {
                  ...current.fields,
                  cancelReasonId: '',
                  cancelReasonMessage: '',
                },
              }
            : current
        );
      });
  }, [preparation, selectedBatchCancellableOrders, selectedPurchaseOrders.length, setPurchaseOperation, showPurchaseNotice]);

  return {
    selectedBatchCancellableOrders,
    purchaseBatchCancelCount: preparation.readyCount,
    purchaseBatchCancelExcludedCount: preparation.excludedCount,
    openPurchaseBatchCancel,
    updatePurchaseCancelReason,
  };
}

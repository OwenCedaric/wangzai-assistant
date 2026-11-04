import {
  getPurchaseOrderRecordKey,
  purchaseOrderManualClassifyOptions,
  purchaseOrderStatusTones,
} from '../lib/purchaseMarketingApi.jsx';
import {
  applyPurchaseTransferPendingOverride,
  buildPurchaseManualClassifyOverride,
  getCanonicalPurchaseOrderOverrideKey,
  hasValidPurchaseOrderNumber,
  readPurchaseOrderLocalOverrides,
  writePurchaseOrderLocalOverrideUpsert,
} from '../lib/purchaseOrderNormalize.jsx';
import { getPurchaseOrderShop } from '../../../../services/purchaseCrossBorderRuntime.js';
import React from 'react';

export function usePurchaseActionItemsState({
  setPurchaseLocalOverrides,
  setSelectedOrderId,
  showPurchaseNotice,
  setManualClassifyDialog,
  hasSelectedOrder,
  selectedOrder,
  setTransferPendingDialog,
  manualClassifyDialog,
  selectedActionState,
  handlePurchaseAction,
  handleForecastAction,
  selectedActionFlags,
  openPurchaseOperation,
  handlePurchaseRefundAction,
  selectedCrossBorderRead,
  handleReadCrossBorder,
  handleReadVolumeAction,
  handlePurchaseInfoAction,
  shops,
  activeShop,
} = {}) {
  const writeCanonicalPurchaseOverride = React.useCallback(
    (current, order, update) => {
      const orderShop = getPurchaseOrderShop(shops, order, activeShop);
      return writePurchaseOrderLocalOverrideUpsert(current, order, orderShop, update);
    },
    [activeShop, shops]
  );
  // Shared writer: applies the plan outside the React updater, then reports the
  // real persistence result instead of assuming success.
  const persistCanonicalPurchaseOverride = React.useCallback(
    async (order, update, { successMessage, failureLabel }) => {
      const plan = writeCanonicalPurchaseOverride(readPurchaseOrderLocalOverrides(), order, update);
      if (!plan?.overrides) {
        showPurchaseNotice(`${failureLabel}保存失败，请重试。`, 'warning');
        return false;
      }
      setPurchaseLocalOverrides(plan.overrides);
      const result = await Promise.resolve(plan.persistence).catch(() => null);
      if (!result || (Array.isArray(result.failedKeys) && result.failedKeys.length > 0)) {
        showPurchaseNotice(`${failureLabel}本地保存失败，重新打开页面后会丢失，请重试。`, 'warning');
        return false;
      }
      if (successMessage) showPurchaseNotice(successMessage, 'success');
      return true;
    },
    [showPurchaseNotice, setPurchaseLocalOverrides, writeCanonicalPurchaseOverride]
  );
  const hasCanonicalPurchaseOverrideTarget = React.useCallback(
    (order) => {
      const orderShop = getPurchaseOrderShop(shops, order, activeShop);
      return Boolean(getCanonicalPurchaseOrderOverrideKey(order, orderShop));
    },
    [activeShop, shops]
  );
  const applyTransferOrderToPending = React.useCallback(
    async (order) => {
      const key = getPurchaseOrderRecordKey(order);
      if (!key) return;
      if (!hasCanonicalPurchaseOverrideTarget(order)) {
        showPurchaseNotice('当前订单缺少可核验的店铺身份，未转回待拍单。', 'warning');
        return;
      }
      setSelectedOrderId(order.id);
      await persistCanonicalPurchaseOverride(
        order,
        (existing) => applyPurchaseTransferPendingOverride(existing, order),
        { successMessage: '已转回待拍单，并作废本地采购记录。', failureLabel: '转回待拍单' }
      );
    },
    [
      hasCanonicalPurchaseOverrideTarget,
      persistCanonicalPurchaseOverride,
      showPurchaseNotice,
      setSelectedOrderId,
    ]
  );
  const applyManualClassifyToOrder = React.useCallback(
    (order, targetStatus) => {
      const key = getPurchaseOrderRecordKey(order);
      if (!key || !purchaseOrderStatusTones[targetStatus]) return;
      if (!hasCanonicalPurchaseOverrideTarget(order)) {
        showPurchaseNotice('当前订单缺少可核验的店铺身份，人工归类未保存。', 'warning');
        return;
      }
      const override = buildPurchaseManualClassifyOverride(order, targetStatus);
      setSelectedOrderId(order.id);
      setManualClassifyDialog({ open: false, order: null, anchorEl: null, pendingOption: null });
      void persistCanonicalPurchaseOverride(
        order,
        (existing) => ({ ...existing, ...override }),
        { successMessage: `已人工归类到「${targetStatus}」，仅影响旺崽助手本地显示。`, failureLabel: '人工归类' }
      );
    },
    [
      hasCanonicalPurchaseOverrideTarget,
      persistCanonicalPurchaseOverride,
      setManualClassifyDialog,
      setSelectedOrderId,
      showPurchaseNotice,
    ]
  );
  const restoreAutoClassifyForOrder = React.useCallback(
    (order) => {
      const key = getPurchaseOrderRecordKey(order);
      if (!key) return;
      if (!hasCanonicalPurchaseOverrideTarget(order)) {
        showPurchaseNotice('当前订单缺少可核验的店铺身份，未恢复自动归类。', 'warning');
        return;
      }
      void persistCanonicalPurchaseOverride(
        order,
        (existing) => {
          const {
            forcePurchaseStatus,
            manualClassifiedAt,
            manualClassifiedFrom,
            manualClassifiedOzonStatus,
            ...rest
          } = existing;
          return rest;
        },
        { successMessage: '已恢复自动归类，会重新按 Ozon、采购记录和巴士记录判断。', failureLabel: '恢复自动归类' }
      );
    },
    [
      hasCanonicalPurchaseOverrideTarget,
      persistCanonicalPurchaseOverride,
      showPurchaseNotice,
    ]
  );
  const handleTransferToPendingAction = () => {
    if (!hasSelectedOrder) return;
    if (hasValidPurchaseOrderNumber(selectedOrder)) {
      setTransferPendingDialog({ open: true, order: selectedOrder });
      return;
    }
    applyTransferOrderToPending(selectedOrder);
  };
  const handleOpenManualClassify = (event) => {
    if (!hasSelectedOrder) return;
    setManualClassifyDialog({
      open: true,
      order: selectedOrder,
      anchorEl: event.currentTarget,
      pendingOption: null,
    });
  };
  const handleManualClassifySelect = (targetStatus) => {
    const order = manualClassifyDialog.order;
    if (!order) return;
    const option = purchaseOrderManualClassifyOptions.find((item) => item.value === targetStatus);
    if (!option) return;
    if (option.risky) {
      setManualClassifyDialog((current) => ({
        ...current,
        pendingOption: option,
      }));
      return;
    }
    applyManualClassifyToOrder(order, targetStatus);
  };
  const confirmManualClassifyPending = () => {
    const option = manualClassifyDialog.pendingOption;
    const order = manualClassifyDialog.order;
    if (!option || !order) return;
    applyManualClassifyToOrder(order, option.value);
  };
  const handleProfitCheckAction = () => {
    showPurchaseNotice('利润核算会按当前已返回的真实数据计算，缺少成本或物流时保持待确认。', 'info');
  };
  const selectedOrderActionDefinitions = {
    purchasePayment: {
      label: '拍单付款',
      variant: 'contained',
      disabled: !hasSelectedOrder || !selectedActionState.canPurchase,
      onClick: handlePurchaseAction,
    },
    purchaseInfo: {
      label: '采购信息',
      variant: 'outlined',
      disabled: !hasSelectedOrder,
      onClick: handlePurchaseInfoAction,
    },
    createForecast: {
      label: '预报订单',
      variant: 'contained',
      disabled: !hasSelectedOrder || !selectedActionState.canForecast,
      onClick: handleForecastAction,
    },
    repairForecast: {
      label: '补录预报',
      variant: 'contained',
      disabled: !hasSelectedOrder || !selectedActionFlags.canRepairForecast,
      onClick: handleForecastAction,
    },
    cancelOrder: {
      label: '取消订单',
      variant: 'outlined',
      color: 'error',
      disabled: !hasSelectedOrder,
      onClick: () => openPurchaseOperation('ozonCancel'),
    },
    purchaseRefund: {
      label: '拍单退款',
      variant: 'outlined',
      color: 'error',
      disabled: !hasSelectedOrder,
      onClick: handlePurchaseRefundAction,
    },
    transferPending: {
      label: '转待拍单',
      variant: 'outlined',
      disabled: !hasSelectedOrder,
      onClick: handleTransferToPendingAction,
    },
    manualClassify: {
      label: '手动归类',
      variant: 'outlined',
      disabled: !hasSelectedOrder,
      onClick: handleOpenManualClassify,
    },
    restoreAutoClassify: {
      label: '恢复自动归类',
      variant: 'outlined',
      disabled: !hasSelectedOrder,
      onClick: () => restoreAutoClassifyForOrder(selectedOrder),
    },
    readCrossBorder: {
      label: '回查巴士',
      variant: 'outlined',
      disabled: !hasSelectedOrder || selectedCrossBorderRead.loading,
      onClick: handleReadCrossBorder,
    },
    cancelCrossBorder: {
      label: '废弃预报',
      variant: 'outlined',
      color: 'error',
      disabled: !hasSelectedOrder,
      onClick: () => openPurchaseOperation('cancelCrossBorder'),
    },
    readVolume: {
      label: '读取材积',
      variant: 'outlined',
      disabled: !hasSelectedOrder || selectedCrossBorderRead.loading,
      onClick: handleReadVolumeAction,
    },
    profitCheck: {
      label: '利润核算',
      variant: 'outlined',
      disabled: !hasSelectedOrder,
      onClick: handleProfitCheckAction,
    },
  };
  const selectedOrderActionKeysByStatus = {
    待拍单: ['purchasePayment', 'purchaseInfo', 'cancelOrder'],
    '已拍单-待预报': ['createForecast', 'purchaseInfo', 'cancelOrder', 'purchaseRefund', 'transferPending'],
    '已拍单-待发货': ['purchaseInfo', 'cancelOrder', 'readCrossBorder', 'cancelCrossBorder'],
    '已拍单-未操作': [
      'purchaseInfo',
      'readCrossBorder',
      'repairForecast',
      'cancelOrder',
      'purchaseRefund',
      'manualClassify',
    ],
    '已拍单-售后单': ['purchaseInfo', 'readCrossBorder', 'cancelCrossBorder', 'cancelOrder', 'purchaseRefund'],
    '已拍单-已发货': ['purchaseInfo', 'readCrossBorder', 'readVolume'],
    完结单: ['purchaseInfo', 'readCrossBorder', 'readVolume', 'profitCheck'],
    关闭单: ['purchaseInfo', 'readCrossBorder', 'readVolume', 'profitCheck'],
  };

  return {
    applyTransferOrderToPending,
    handleManualClassifySelect,
    confirmManualClassifyPending,
    selectedOrderActionDefinitions,
    selectedOrderActionKeysByStatus,
  };
}

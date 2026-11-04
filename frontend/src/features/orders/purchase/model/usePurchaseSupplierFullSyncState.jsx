import { getPurchaseOrderShop } from '../../../../services/purchaseCrossBorderRuntime.js';
import {
  hydratePurchaseOrderLocalOverridesFromLocalFile,
  isConfirmedPurchasePlatformStatus,
  readPurchaseOrderLocalOverrides,
  writePurchaseOrderLocalOverrideUpsert,
} from '../lib/purchaseOrderNormalize.jsx';
import {
  collectPurchaseSupplierCandidates,
  createPurchaseSupplierLogisticsPatch,
  normalizePurchaseSupplierPlatform,
  syncUnifiedPurchaseLogistics,
} from '../services/purchaseSupplierFullSyncClient.js';
import React from 'react';

const INITIAL_STATE = Object.freeze({
  running: false,
  total: 0,
  completed: 0,
  matched: 0,
  failed: 0,
  message: '',
});

function sameCandidate(candidate, result) {
  return candidate.purchaseOrderNumber === String(result?.purchaseOrderNumber || '').trim()
    && candidate.platform === normalizePurchaseSupplierPlatform(result?.platformLabel || result?.platform);
}

export function usePurchaseSupplierFullSyncState({
  purchaseOrders = [],
  shops = [],
  activeShop = null,
  setPurchaseLocalOverrides,
  showPurchaseNotice,
} = {}) {
  const [purchaseSupplierSync, setPurchaseSupplierSync] = React.useState(INITIAL_STATE);

  const handleFullSupplierSync = React.useCallback(async () => {
    if (purchaseSupplierSync.running) return;
    const candidates = collectPurchaseSupplierCandidates(purchaseOrders);
    const uniqueTotal = new Set(candidates.map((row) => `${row.platform}\u0000${row.purchaseOrderNumber}`)).size;
    setPurchaseSupplierSync({
      ...INITIAL_STATE,
      running: true,
      total: uniqueTotal,
      message: '正在同步跨境巴士和国内采购物流',
    });
    try {
      const response = await syncUnifiedPurchaseLogistics(purchaseOrders, {
        batchSize: 20,
        onProgress: (progress) => {
          setPurchaseSupplierSync((current) => ({
            ...current,
            running: true,
            total: progress.total,
            completed: progress.completed,
            message: progress.message,
          }));
        },
      });
      const matchedResults = response.results.filter((row) => row?.ok === true);
      const updates = matchedResults.flatMap((result) => (
        candidates.filter((candidate) => sameCandidate(candidate, result)).flatMap(({ order }) => {
          const orderShop = getPurchaseOrderShop(shops, order, activeShop);
          const amount = Number(result.purchasePrice);
          const logisticsPatch = createPurchaseSupplierLogisticsPatch(result);
          return orderShop && Number.isFinite(amount) && amount > 0
            ? [{ amount, order, orderShop, result, logisticsPatch }]
            : [];
        })
      ));
      const persistenceTasks = [];
      // Plan the writes outside the React updater: the updater must stay pure and
      // StrictMode invokes it twice, which would duplicate every persistence call.
      let next = readPurchaseOrderLocalOverrides();
      updates.forEach(({ amount, order, orderShop, result, logisticsPatch }) => {
          const plan = writePurchaseOrderLocalOverrideUpsert(next, order, orderShop, (existing) => {
            const clearFields = new Set(Array.isArray(existing.clearFields) ? existing.clearFields : []);
            ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'manualStatus'].forEach((field) => {
              clearFields.delete(field);
            });
            const update = {
              ...existing,
              buyerPlatform: result.platformLabel,
              supplier: result.platformLabel,
              purchaseOrderNo: result.purchaseOrderNumber,
              purchasePrice: String(amount),
              purchasePriceValue: amount,
              sourceCostCny: amount,
              purchaseOrderStatus: result.purchaseOrderStatus,
              manualBuyerPlatform: result.platformLabel,
              manualPurchaseOrderNo: result.purchaseOrderNumber,
              manualPurchasePrice: String(amount),
              manualPurchasePriceValue: amount,
              manualPurchaseOrderStatus: result.purchaseOrderStatus,
              purchaseSupplierSyncedAt: new Date().toISOString(),
              purchaseSupplierSyncSource: result.sourceMethod || 'cross-border-sync-plugin-direct',
              ...(logisticsPatch || {}),
              clearFields: [...clearFields],
            };
            if (isConfirmedPurchasePlatformStatus(result.purchaseOrderStatus)) {
              if (['待拍单', '已拍单-未操作'].includes(update.forcePurchaseStatus)) delete update.forcePurchaseStatus;
              delete update.transferPendingAt;
              delete update.transferPendingReason;
            }
            return update;
          });
          if (plan?.overrides) {
            next = plan.overrides;
            if (plan.persistence) persistenceTasks.push(Promise.resolve(plan.persistence));
          }
      });
      setPurchaseLocalOverrides(next);
      const persistenceResults = await Promise.allSettled(persistenceTasks);
      const persistFailureCount = persistenceResults.filter((item) => (
        item.status === 'rejected'
        || (Array.isArray(item.value?.failedKeys) && item.value.failedKeys.length > 0)
      )).length;
      const refreshedOverrides = await hydratePurchaseOrderLocalOverridesFromLocalFile().catch(() => null);
      if (refreshedOverrides) setPurchaseLocalOverrides(refreshedOverrides);
      setPurchaseSupplierSync({
        running: false,
        total: response.total,
        completed: response.total,
        matched: response.matched,
        failed: response.failed,
        message: `同步物流完成：成功 ${response.matched}，失败 ${response.failed}`,
      });
      const persistSuffix = persistFailureCount > 0
        ? `；其中 ${persistFailureCount} 个订单本地保存失败，重新打开页面后会丢失，请重试`
        : '';
      showPurchaseNotice(
        `同步物流完成：采购单成功 ${response.matched} 条，已更新 ${updates.length} 个页面订单，失败 ${response.failed} 条${response.busErrorCode ? '，跨境巴士待补队列未完成' : ''}${persistSuffix}。`,
        response.failed || response.busErrorCode || persistFailureCount > 0 ? 'warning' : 'success',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '同步物流失败');
      setPurchaseSupplierSync((current) => ({ ...current, running: false, message }));
      showPurchaseNotice(message, 'warning');
    }
  }, [
    activeShop,
    purchaseOrders,
    purchaseSupplierSync.running,
    setPurchaseLocalOverrides,
    shops,
    showPurchaseNotice,
  ]);

  return { purchaseSupplierSync, handleFullSupplierSync };
}

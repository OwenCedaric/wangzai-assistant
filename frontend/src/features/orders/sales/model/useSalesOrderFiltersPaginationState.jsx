import { getSalesOrderRecordKey } from '../../../../entities/order/orderRecordRules.jsx';
import { getSalesOrderStatusTags } from '../../../../entities/order/orderSourceLinkFields.jsx';
import {
  getOzonLocalRowsWithEstimatedCommissions,
  getOzonLocalRowsWithProductImages,
  hasOzonOrderRowEstimatedCommission,
  hasOzonOrderRowProductImage,
  readOzonLocalProductEntityRows,
} from '../../../../entities/product/productLocalMirror.jsx';
import { getOzonApiErrorMessage } from '../../../../entities/product/productOzonApi.jsx';
import {
  isSplitParentBusinessLocked,
  shouldShowOrderInOzonDisplayList,
} from '../../../../services/orderSplitRelationRules';
import {
  clearOzonOrderSupplementCacheForRows,
  readOzonOrderSupplementCacheRows,
  writeOzonOrderSupplementCacheRows,
} from '../../../../services/ozonOrderExperience';
import { recordRequestFailure, shouldAttemptRequest } from '../../../../services/requestCooldown';
import { LOCAL_OZON_DATA_LAYER_FILE_KEY } from '../../../../shared/config/appConfigCore.jsx';
import { salesSupplementCooldown } from '../../../../shared/config/appConfigRuntime.jsx';
import { countRowsImages, usePagePerformanceLog } from '../../../../shared/ozon/ozonRuntime.jsx';
import {
  getOrderPreviewImageUrls,
  getSalesOrderPreviewImages,
  useOzonOrderImagePreload,
} from '../../../../entities/order/orderImagePreviewRules.jsx';
import React from 'react';

export function useSalesOrderFiltersPaginationState({
  paymentStartDate,
  paymentEndDate,
  paymentDateAnchorEl,
  orderRows,
  shop,
  deferredKeyword,
  keyword,
  fulfillment,
  status,
  salesOrderPage,
  salesOrderPageSize,
  orderSync,
  selectedSalesOrderKeys,
  setSalesEnhancementMap,
  setSalesSupplementErrorText,
  externalRefreshTickRef,
  externalRefreshTick,
  isActive,
  readableShops,
  salesEnhancementMap,
  readableShopsSourceKey,
  setSalesOrderPage,
  setSelectedSalesOrderKeys,
  setSalesNotice,
  resetSalesOrderRefreshProgress,
} = {}) {
  const paymentDateOpen = Boolean(paymentDateAnchorEl);
  const paymentDateText =
    paymentStartDate || paymentEndDate
      ? `${paymentStartDate || '开始日期'} - ${paymentEndDate || '结束日期'}`
      : '开始日期 - 结束日期';
  const keywordText = deferredKeyword.trim().toLowerCase();
  const visibleOrders = React.useMemo(
    () => orderRows.filter((order) => shouldShowOrderInOzonDisplayList(order, { keyword: keywordText })),
    [keywordText, orderRows]
  );
  const filteredOrderTotal = Math.max(Number(orderSync.data?.total) || 0, 0);
  const salesOrderSummary = React.useMemo(
    () => orderSync.data?.summary || { total: filteredOrderTotal, amountTotal: 0, salesStatusCounts: { all: 0 } },
    [filteredOrderTotal, orderSync.data?.summary]
  );
  const salesOrderStatusCounts = React.useMemo(
    () => ({ all: salesOrderSummary.total ?? filteredOrderTotal, ...(salesOrderSummary.salesStatusCounts || {}) }),
    [filteredOrderTotal, salesOrderSummary]
  );
  const salesOrderTotalPages = Math.max(1, Math.ceil(filteredOrderTotal / Math.max(salesOrderPageSize, 1)));
  const currentSalesOrderPage = Math.min(Math.max(Number(salesOrderPage) || 1, 1), salesOrderTotalPages);
  const salesOrderRangeStart = filteredOrderTotal ? (currentSalesOrderPage - 1) * salesOrderPageSize + 1 : 0;
  const salesOrderRangeEnd = filteredOrderTotal ? Math.min(salesOrderRangeStart + visibleOrders.length - 1, filteredOrderTotal) : 0;
  const salesOrderPagination = React.useMemo(
    () => ({ rows: visibleOrders, totalRows: filteredOrderTotal, totalPages: salesOrderTotalPages, currentPage: currentSalesOrderPage, rangeStart: salesOrderRangeStart, rangeEnd: salesOrderRangeEnd }),
    [currentSalesOrderPage, filteredOrderTotal, salesOrderRangeEnd, salesOrderRangeStart, salesOrderTotalPages, visibleOrders]
  );
  const salesOrderCountRows = visibleOrders;
  const filteredOrders = visibleOrders;
  const filteredSalesOrderKeys = React.useMemo(() => visibleOrders.map((order) => getSalesOrderRecordKey(order)).filter(Boolean), [visibleOrders]);
  const visibleSalesOrderKeys = React.useMemo(
    () => visibleOrders.map((order) => getSalesOrderRecordKey(order)).filter(Boolean),
    [visibleOrders]
  );
  const visibleSalesOrderSupplementKey = visibleSalesOrderKeys.join('|');
  const visibleSalesOrderImageCount = React.useMemo(() => countRowsImages(visibleOrders), [visibleOrders]);
  const visibleSalesOrderImageUrls = React.useMemo(
    () => getOrderPreviewImageUrls(visibleOrders, getSalesOrderPreviewImages, 80),
    [visibleOrders]
  );
  useOzonOrderImagePreload(visibleSalesOrderImageUrls, 80);
  usePagePerformanceLog('订单管理', orderSync.performance, {
    loading: orderSync.loading,
    rows: visibleOrders.length,
    imageCount: visibleSalesOrderImageCount,
  });
  const selectedSalesOrderCount = selectedSalesOrderKeys.size;
  const selectedPageSalesOrderCount = visibleSalesOrderKeys.filter((key) => selectedSalesOrderKeys.has(key)).length;
  const allSalesOrderPageSelected =
    visibleSalesOrderKeys.length > 0 && selectedPageSalesOrderCount === visibleSalesOrderKeys.length;
  const salesOrderPageSelectionIndeterminate =
    selectedPageSalesOrderCount > 0 && selectedPageSalesOrderCount < visibleSalesOrderKeys.length;
  const selectedSalesOrders = React.useMemo(
    () => filteredOrders.filter((order) => selectedSalesOrderKeys.has(getSalesOrderRecordKey(order))),
    [filteredOrders, selectedSalesOrderKeys]
  );
  const selectedCancellableOrders = React.useMemo(
    () =>
      selectedSalesOrders.filter((order) => {
        const isFbo = String(order?.fulfillment || '').toUpperCase() === 'FBO';
        const closed = ['已经发货', '成功订单', '关闭订单', '售后订单'].includes(order?.status);
        return !isFbo && !closed && !isSplitParentBusinessLocked(order);
      }),
    [selectedSalesOrders]
  );
  const selectedShippableOrders = React.useMemo(
    () =>
      selectedSalesOrders.filter((order) => {
        const isFbo = String(order?.fulfillment || '').toUpperCase() === 'FBO';
        return !isFbo && getSalesOrderStatusTags(order).includes('等待备货') && !isSplitParentBusinessLocked(order);
      }),
    [selectedSalesOrders]
  );
  const showSalesRefreshNotice = React.useCallback(
    (severity, message) => {
      if (typeof setSalesNotice !== 'function') return;
      setSalesNotice({ open: true, severity, message });
    },
    [setSalesNotice]
  );
  const handleRefreshSalesOrders = React.useCallback(() => {
    clearOzonOrderSupplementCacheForRows(orderRows);
    setSalesEnhancementMap(new Map());
    setSalesSupplementErrorText('');
    resetSalesOrderRefreshProgress?.('销售订单同步已提交 Ozon，页面继续显示 SQLite 缓存。');
    showSalesRefreshNotice('info', '销售订单同步已提交 Ozon，页面先显示 SQLite 缓存，回读完成后会自动合并。');
    return orderSync
      .refresh()
      .then((result) => {
        if (result) {
          showSalesRefreshNotice('success', '销售订单回读成功，SQLite 已合并。');
          return result;
        }
        showSalesRefreshNotice('warning', '销售订单同步失败，已保留当前 SQLite 缓存，请稍后重试。');
        return result;
      })
      .catch((error) => {
        showSalesRefreshNotice('error', '销售订单同步失败，已保留当前 SQLite 缓存，请稍后重试。');
        throw error;
      });
  }, [
    orderRows,
    orderSync,
    resetSalesOrderRefreshProgress,
    setSalesEnhancementMap,
    setSalesSupplementErrorText,
    showSalesRefreshNotice,
  ]);
  React.useEffect(() => {
    if (externalRefreshTickRef.current === externalRefreshTick) return;
    externalRefreshTickRef.current = externalRefreshTick;
    if (!isActive || !externalRefreshTick) return;
    handleRefreshSalesOrders();
  }, [externalRefreshTick, handleRefreshSalesOrders, isActive, externalRefreshTickRef]);
  React.useEffect(() => {
    setSalesEnhancementMap(new Map());
    setSalesSupplementErrorText('');
  }, [orderSync.data?.fetchedAt, setSalesEnhancementMap, setSalesSupplementErrorText]);
  React.useEffect(() => {
    if (!isActive || orderSync.loading || !visibleOrders.length || !readableShops.length) return undefined;
    const cachedRows = readOzonOrderSupplementCacheRows(visibleOrders);
    if (cachedRows.length) {
      setSalesEnhancementMap((current) => {
        let changed = false;
        const next = new Map(current);
        cachedRows.forEach((row) => {
          const key = getSalesOrderRecordKey(row);
          if (key && !next.has(key)) {
            next.set(key, row);
            changed = true;
          }
        });
        return changed ? next : current;
      });
    }
    const cachedImageKeys = getOzonLocalRowsWithProductImages(cachedRows, getSalesOrderRecordKey);
    const cachedCommissionKeys = getOzonLocalRowsWithEstimatedCommissions(cachedRows, getSalesOrderRecordKey);
    const rowsToEnhance = visibleOrders.filter((order) => {
      const key = getSalesOrderRecordKey(order);
      const enhancedOrder = key ? salesEnhancementMap.get(key) : null;
      const needsImage = !hasOzonOrderRowProductImage(enhancedOrder) && !cachedImageKeys.has(key);
      const needsCommission =
        !hasOzonOrderRowEstimatedCommission(enhancedOrder) &&
        !cachedCommissionKeys.has(key) &&
        !hasOzonOrderRowEstimatedCommission(order);
      return key && (needsImage || needsCommission) && shouldAttemptRequest(salesSupplementCooldown, key);
    });
    if (!rowsToEnhance.length) return undefined;

    let cancelled = false;
    (async () => {
      const localResult = await readOzonLocalProductEntityRows(
        LOCAL_OZON_DATA_LAYER_FILE_KEY,
        rowsToEnhance,
        readableShops,
        getSalesOrderRecordKey,
        {
          hydrateMissing: true,
          requireImages: true,
          requestedBy: 'sales-order-product-cache-miss',
        }
      );
      if (cancelled) return;
      if (localResult.rows.length) {
        writeOzonOrderSupplementCacheRows(localResult.rows);
        setSalesEnhancementMap((current) => {
          const next = new Map(current);
          localResult.rows.forEach((row) => {
            const key = getSalesOrderRecordKey(row);
            if (key) next.set(key, row);
          });
          return next;
        });
      }
      setSalesSupplementErrorText('');
    })().catch((error) => {
      if (cancelled) return;
      rowsToEnhance.forEach((row) => {
        const key = getSalesOrderRecordKey(row);
        if (key) recordRequestFailure(salesSupplementCooldown, key, { error });
      });
      setSalesSupplementErrorText(`当前页补充信息读取失败：${getOzonApiErrorMessage(error)}`);
    });

    return () => {
      cancelled = true;
    };
  }, [
    isActive,
    orderSync.loading,
    readableShops,
    readableShopsSourceKey,
    salesEnhancementMap,
    visibleOrders,
    visibleSalesOrderSupplementKey,
    setSalesEnhancementMap,
    setSalesSupplementErrorText,
  ]);
  const resetSalesOrderListState = React.useCallback(() => {
    setSalesOrderPage(1);
    setSelectedSalesOrderKeys(new Set());
  }, [setSalesOrderPage, setSelectedSalesOrderKeys]);

  return {
    paymentDateOpen,
    paymentDateText,
    salesOrderCountRows,
    filteredOrders,
    filteredOrderTotal,
    salesOrderSummary,
    salesOrderStatusCounts,
    salesOrderPagination,
    salesOrderTotalPages,
    currentSalesOrderPage,
    visibleOrders,
    salesOrderRangeStart,
    salesOrderRangeEnd,
    filteredSalesOrderKeys,
    visibleSalesOrderKeys,
    selectedSalesOrderCount,
    allSalesOrderPageSelected,
    salesOrderPageSelectionIndeterminate,
    selectedCancellableOrders,
    selectedShippableOrders,
    handleRefreshSalesOrders,
    resetSalesOrderListState,
  };
}

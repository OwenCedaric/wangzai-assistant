import { getSalesOrderRecordKey } from '../../../../entities/order/orderRecordRules.jsx';
import { getSalesOrderStatusTags } from '../../../../entities/order/orderSourceLinkFields.jsx';
import { recordLocalMirrorReadLog } from '../../../../entities/product/productLocalData.jsx';
import { isSplitParentBusinessLocked } from '../../../../services/orderSplitRelationRules';
import { readAllSalesOrderPagedCache } from '../../../../services/salesOrderPagedCacheClient.js';
import React from 'react';

function isCancellable(order = {}) {
  const isFbo = String(order.fulfillment || '').toUpperCase() === 'FBO';
  const closed = ['已经发货', '成功订单', '关闭订单', '售后订单'].includes(order.status);
  return !isFbo && !closed && !isSplitParentBusinessLocked(order);
}

function isShippable(order = {}) {
  return (
    String(order.fulfillment || '').toUpperCase() !== 'FBO' &&
    getSalesOrderStatusTags(order).includes('等待备货') &&
    !isSplitParentBusinessLocked(order)
  );
}

export function useSalesOrderSelectionState({
  setSelectedSalesOrderKeys,
  visibleSalesOrderKeys,
  filteredOrders,
  visibleOrders,
  selectedOrderId,
  isActive,
  orderSync,
  salesOrderLocalSnapshotKey,
  salesOrderTimeScope,
  shop,
  status,
  fulfillment,
  deferredKeyword,
  salesOrderPage,
  salesOrderPageSize,
  salesOrderTotalPages,
  setSalesOrderPage,
  setSelectedOrderId,
  readableShops,
  selectedSalesOrderKeys,
  salesOrderSummary,
} = {}) {
  const [selectedRowsByKey, setSelectedRowsByKey] = React.useState(() => new Map());
  const [selectionLoading, setSelectionLoading] = React.useState(false);
  const toggleSalesOrderSelection = React.useCallback((order) => {
    const key = getSalesOrderRecordKey(order);
    if (!key) return;
    setSelectedSalesOrderKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setSelectedRowsByKey((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, order);
      return next;
    });
  }, [setSelectedSalesOrderKeys]);
  const toggleSalesOrderPageSelection = React.useCallback(() => {
    const shouldClearPage = visibleSalesOrderKeys.length > 0 && visibleSalesOrderKeys.every((key) => selectedSalesOrderKeys.has(key));
    setSelectedSalesOrderKeys((current) => {
      const next = new Set(current);
      visibleSalesOrderKeys.forEach((key) => {
        if (shouldClearPage) next.delete(key);
        else next.add(key);
      });
      return next;
    });
    setSelectedRowsByKey((current) => {
      const next = new Map(current);
      visibleOrders.forEach((order) => {
        const key = getSalesOrderRecordKey(order);
        if (!key) return;
        if (shouldClearPage) next.delete(key);
        else next.set(key, order);
      });
      return next;
    });
  }, [selectedSalesOrderKeys, setSelectedSalesOrderKeys, visibleOrders, visibleSalesOrderKeys]);
  const selectAllFilteredSalesOrders = React.useCallback(async () => {
    if (selectionLoading) return;
    setSelectionLoading(true);
    try {
      const payload = await readAllSalesOrderPagedCache({
        shops: readableShops,
        timeScope: salesOrderTimeScope,
        shop,
        status,
        fulfillment,
        keyword: deferredKeyword,
      }, { timeoutMs: 30_000 });
      const next = new Map(
        (Array.isArray(payload.rows) ? payload.rows : [])
          .map((order) => [getSalesOrderRecordKey(order), order])
          .filter(([key]) => Boolean(key))
      );
      setSelectedRowsByKey(next);
      setSelectedSalesOrderKeys(new Set(next.keys()));
    } finally {
      setSelectionLoading(false);
    }
  }, [deferredKeyword, fulfillment, readableShops, salesOrderTimeScope, selectionLoading, setSelectedSalesOrderKeys, shop, status]);
  const clearSalesOrderSelection = React.useCallback(() => {
    setSelectedSalesOrderKeys(new Set());
    setSelectedRowsByKey(new Map());
  }, [setSelectedSalesOrderKeys]);
  const selectedOrder =
    visibleOrders.find((order) => getSalesOrderRecordKey(order) === selectedOrderId) ??
    visibleOrders[0] ??
    filteredOrders[0] ??
    null;
  const selectedSalesOrders = React.useMemo(() => {
    const rows = new Map(selectedRowsByKey);
    visibleOrders.forEach((order) => {
      const key = getSalesOrderRecordKey(order);
      if (key && selectedSalesOrderKeys.has(key)) rows.set(key, order);
    });
    return [...rows.values()].filter((order) => selectedSalesOrderKeys.has(getSalesOrderRecordKey(order)));
  }, [selectedRowsByKey, selectedSalesOrderKeys, visibleOrders]);
  React.useEffect(() => {
    setSelectedRowsByKey((current) => {
      const next = new Map([...current].filter(([key]) => selectedSalesOrderKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [selectedSalesOrderKeys]);
  const selectedCancellableOrders = React.useMemo(
    () => selectedSalesOrders.filter(isCancellable),
    [selectedSalesOrders]
  );
  const selectedShippableOrders = React.useMemo(
    () => selectedSalesOrders.filter(isShippable),
    [selectedSalesOrders]
  );
  React.useEffect(() => {
    setSalesOrderPage((current) => Math.min(current, salesOrderTotalPages));
  }, [salesOrderTotalPages, setSalesOrderPage]);
  React.useEffect(() => {
    if (visibleOrders.length && !visibleOrders.some((order) => getSalesOrderRecordKey(order) === selectedOrderId)) {
      setSelectedOrderId(getSalesOrderRecordKey(visibleOrders[0]));
    }
  }, [selectedOrderId, setSelectedOrderId, visibleOrders]);
  React.useEffect(() => {
    if (!isActive || orderSync.loading) return;
    recordLocalMirrorReadLog({
      domain: '05_sales_orders',
      source: orderSync.data?.source || 'sqlite',
      status: 'consistency-ok',
      rows: visibleOrders.length,
      failures: 0,
      partial: false,
      refreshedAt: orderSync.data?.fetchedAt || new Date().toISOString(),
      details: {
        localSnapshotKey: salesOrderLocalSnapshotKey,
        timeScope: salesOrderTimeScope.cachePart,
        shopScope: shop,
        selectedStatus: status,
        fulfillment,
        keyword: deferredKeyword,
        page: salesOrderPage,
        pageSize: salesOrderPageSize,
        pageRows: visibleOrders.length,
        pageTotalRows: orderSync.data?.total || 0,
      },
    }).catch(() => undefined);
  }, [deferredKeyword, fulfillment, isActive, orderSync.data?.fetchedAt, orderSync.data?.source, orderSync.data?.total, orderSync.loading, salesOrderLocalSnapshotKey, salesOrderPage, salesOrderPageSize, salesOrderTimeScope.cachePart, shop, status, visibleOrders]);
  return {
    toggleSalesOrderSelection,
    toggleSalesOrderPageSelection,
    selectAllFilteredSalesOrders,
    clearSalesOrderSelection,
    selectedOrder,
    detailOrder: selectedOrder,
    totalAmount: Number(salesOrderSummary?.amountTotal) || 0,
    selectedCancellableOrders,
    selectedShippableOrders,
    selectionLoading,
  };
}

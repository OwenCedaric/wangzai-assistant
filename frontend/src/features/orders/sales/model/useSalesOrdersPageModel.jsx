import { useSalesOrdersSnapshotState } from './useSalesOrdersSnapshotState.jsx';
import { useSalesOrderFiltersPaginationState } from './useSalesOrderFiltersPaginationState.jsx';
import { useSalesOrderSelectionState } from './useSalesOrderSelectionState.jsx';
import { useSalesOrderSourceLinkState } from './useSalesOrderSourceLinkState.jsx';
import { useSalesOrderOperationState } from './useSalesOrderOperationState.jsx';
import { useSalesOrderViewMetaState } from './useSalesOrderViewMetaState.jsx';
import { useSalesOrderLogisticsSyncState } from './useSalesOrderLogisticsSyncState.jsx';
import { useOzonProductWorkbenchState } from '../../purchase/model/useOzonProductWorkbenchState.jsx';
import { getOzonShopForOrder } from '../../../../entities/order/orderShopScope.jsx';
import {
  buildPurchaseInfoOverrideIndex,
  findPurchaseInfoOverride,
  getPurchaseInfoCrossBorderInfo,
  getPurchaseInfoSupport,
  readPurchaseInfoOverrideRows,
  resolvePurchaseInfoOpenAction,
} from '../../../../services/purchaseInfoSupport';
import React from 'react';

export function useSalesOrdersPageModel({
  shops = [],
  activeShopId,
  isActive = true,
  onOrderNotifications,
  externalRefreshTick = 0,
  initialStatus = 'all',
  viewTitle = '销售订单',
  viewDescription = '查看 Ozon 销售订单、佣金、货源成本和跨境巴士信息',
  printShippingFilters = {},
  includePrintShippingFacets = false,
} = {}) {
  const {
    activeShop,
    readableShops,
    readableShopsSourceKey,
    paymentStartDate,
    setPaymentStartDate,
    paymentEndDate,
    setPaymentEndDate,
    paymentDateAnchorEl,
    setPaymentDateAnchorEl,
    salesOrderTimeScope,
    salesOrderLocalSnapshotKey,
    orderSync,
    salesOrderRefreshProgress,
    resetSalesOrderRefreshProgress,
    salesEnhancementMap,
    setSalesEnhancementMap,
    orderRows,
    status,
    setStatus,
    shop,
    setShop,
    fulfillment,
    setFulfillment,
    keyword,
    setKeyword,
    deferredKeyword,
    salesOrderPageSize,
    setSalesOrderPageSize,
    salesOrderPage,
    setSalesOrderPage,
    selectedOrderId,
    setSelectedOrderId,
    selectedSalesOrderKeys,
    setSelectedSalesOrderKeys,
    salesSupplementErrorText,
    setSalesSupplementErrorText,
    sourceLinks,
    setSourceLinks,
    legacySalesSourceLinks,
    salesSourceSlotMap,
    setSalesSourceSlotMap,
    salesNotice,
    setSalesNotice,
    salesOperation,
    setSalesOperation,
    externalRefreshTickRef,
  } = useSalesOrdersSnapshotState({
    shops,
    activeShopId,
    isActive,
    externalRefreshTick,
    onOrderNotifications,
    initialStatus,
    printShippingFilters,
    includePrintShippingFacets,
  });
  const {
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
    handleRefreshSalesOrders,
    resetSalesOrderListState,
  } = useSalesOrderFiltersPaginationState({
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
  });
  const {
    toggleSalesOrderSelection,
    toggleSalesOrderPageSelection,
    selectAllFilteredSalesOrders,
    clearSalesOrderSelection,
    selectedOrder,
    detailOrder,
    totalAmount,
    selectedCancellableOrders,
    selectedShippableOrders,
    selectionLoading,
  } = useSalesOrderSelectionState({
    setSelectedSalesOrderKeys,
    visibleSalesOrderKeys,
    filteredSalesOrderKeys,
    filteredOrders,
    filteredOrderTotal,
    salesOrderPageSize,
    currentSalesOrderPage,
    visibleOrders,
    selectedOrderId,
    salesOrderCountRows,
    salesOrderStatusCounts,
    salesOrderPagination,
    isActive,
    orderSync,
    salesOrderLocalSnapshotKey,
    salesOrderTimeScope,
    shop,
    status,
    fulfillment,
    deferredKeyword,
    salesOrderPage,
    orderRows,
    keyword,
    setSalesOrderPage,
    salesOrderTotalPages,
    setSelectedOrderId,
    readableShops,
    selectedSalesOrderKeys,
    salesOrderSummary,
  });
  const {
    getSourceLinkRecord,
    getSourceSelectedSlot,
    getSourceLinkValue,
    selectSourceSlot,
    updateSourceLink,
    saveSourceLink,
    detailSourceLink,
    detailSourceEntry,
    detailCrossBorderInfo: salesSourceCrossBorderInfo,
  } = useSalesOrderSourceLinkState({
    shop,
    shops,
    activeShop,
    sourceLinks,
    legacySalesSourceLinks,
    salesSourceSlotMap,
    setSalesSourceSlotMap,
    setSourceLinks,
    setSalesNotice,
    detailOrder,
  });
  const showSalesWorkbenchNotice = React.useCallback((message, severity = 'info') => {
    setSalesNotice({ open: true, message, severity });
  }, [setSalesNotice]);
  const salesOzonProductWorkbench = useOzonProductWorkbenchState({
    showNotice: showSalesWorkbenchNotice,
  });
  const [purchaseOverrideRows, setPurchaseOverrideRows] = React.useState([]);
  const refreshPurchaseShippingInfo = React.useCallback(async () => {
    const rows = await readPurchaseInfoOverrideRows();
    setPurchaseOverrideRows(Array.isArray(rows) ? rows : []);
    return rows;
  }, []);
  React.useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    readPurchaseInfoOverrideRows()
      .then((rows) => {
        if (!cancelled) setPurchaseOverrideRows(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [externalRefreshTick, isActive]);
  const purchaseOverrideIndex = React.useMemo(
    () => buildPurchaseInfoOverrideIndex(purchaseOverrideRows),
    [purchaseOverrideRows]
  );
  const logisticsPurchaseOrders = React.useMemo(() => orderRows.map((order) => {
    const purchaseOverride = findPurchaseInfoOverride(order, purchaseOverrideIndex) || {};
    const purchaseInfo = getPurchaseInfoSupport(order, purchaseOverride);
    return {
      ...order,
      purchasePlatform: purchaseInfo.platform || purchaseOverride.purchasePlatform || '',
      manualBuyerPlatform: purchaseInfo.platform || purchaseOverride.manualBuyerPlatform || '',
      purchaseOrderNumber: purchaseInfo.orderNumber || purchaseOverride.purchaseOrderNumber || '',
      manualPurchaseOrderNo: purchaseInfo.orderNumber || purchaseOverride.manualPurchaseOrderNo || '',
    };
  }), [orderRows, purchaseOverrideIndex]);
  const { logisticsSync, handleSyncLogistics } = useSalesOrderLogisticsSyncState({
    setSalesNotice,
    purchaseOrders: logisticsPurchaseOrders,
  });
  const detailPurchaseOverride = React.useMemo(() => {
    if (!detailOrder) return null;
    return findPurchaseInfoOverride(detailOrder, purchaseOverrideIndex);
  }, [detailOrder, purchaseOverrideIndex]);
  const detailPurchaseInfoSupport = React.useMemo(() => {
    if (!detailOrder) return getPurchaseInfoSupport({});
    return getPurchaseInfoSupport(detailOrder, detailPurchaseOverride);
  }, [detailOrder, detailPurchaseOverride]);
  const detailCrossBorderInfo = React.useMemo(() => {
    if (!detailOrder) return getPurchaseInfoCrossBorderInfo({}, null, salesSourceCrossBorderInfo);
    return getPurchaseInfoCrossBorderInfo(detailOrder, detailPurchaseOverride, salesSourceCrossBorderInfo);
  }, [detailOrder, detailPurchaseOverride, salesSourceCrossBorderInfo]);
  const getOrderPurchaseShippingInfo = React.useCallback((order = {}) => {
    const purchaseOverride = findPurchaseInfoOverride(order, purchaseOverrideIndex);
    return {
      purchaseOverride,
      purchaseInfo: getPurchaseInfoSupport(order, purchaseOverride),
      crossBorderInfo: getPurchaseInfoCrossBorderInfo(
        order,
        purchaseOverride,
        order?.crossBorderInfo
      ),
    };
  }, [purchaseOverrideIndex]);
  const getSalesProductWorkbenchContext = React.useCallback((order, product = {}) => {
    const purchaseOverride = findPurchaseInfoOverride(order, purchaseOverrideIndex);
    const purchaseInfo = getPurchaseInfoSupport(order, purchaseOverride);
    const crossBorderInfo = getPurchaseInfoCrossBorderInfo(
      order,
      purchaseOverride,
      order?.crossBorderInfo
    );
    const sourceRecord = getSourceLinkRecord(order);
    const sourceSlot = getSourceSelectedSlot(order);
    const sourceEntry = sourceRecord?.links?.[sourceSlot]
      || sourceRecord?.links?.[sourceRecord?.primaryIndex]
      || {};
    return {
      order,
      product,
      sourceEntry,
      sourceShop: getOzonShopForOrder(order, shops, activeShop) || activeShop,
      purchaseInfo,
      crossBorderInfo,
    };
  }, [
    activeShop,
    getSourceLinkRecord,
    getSourceSelectedSlot,
    purchaseOverrideIndex,
    shops,
  ]);
  const openSalesOzonProductPage = React.useCallback((order, product = {}) => (
    salesOzonProductWorkbench.openOzonProduct(getSalesProductWorkbenchContext(order, product))
  ), [getSalesProductWorkbenchContext, salesOzonProductWorkbench]);
  const openSalesPurchaseLink = React.useCallback((url, order = detailOrder, product = order?.products?.[0] || {}) => (
    salesOzonProductWorkbench.openPurchaseLink({
      url,
      ...getSalesProductWorkbenchContext(order || {}, product),
    })
  ), [detailOrder, getSalesProductWorkbenchContext, salesOzonProductWorkbench]);
  const openSalesPurchaseInfoWorkbench = React.useCallback(() => {
    if (!detailOrder) return;
    const action = resolvePurchaseInfoOpenAction(detailOrder, detailPurchaseOverride);
    if (!action.canOpen) {
      showSalesWorkbenchNotice(action.message, 'info');
      return;
    }
    openSalesPurchaseLink(action.url, detailOrder, detailOrder.products?.[0] || {});
  }, [
    detailOrder,
    detailPurchaseOverride,
    openSalesPurchaseLink,
    showSalesWorkbenchNotice,
  ]);
  const {
    openSalesOperation,
    openSalesBatchOperation,
    closeSalesOperation,
    updateSalesCancelReason,
    updateSalesSplitPackageQuantity,
    addSalesSplitPackage,
    removeSalesSplitPackage,
    executeSalesOperation,
    operationMeta,
    detailSplitLocked,
    detailSplitLockReason,
    canCancelDetailOrder,
    canShipDetailOrder,
    canSplitDetailOrder,
    operationOrders,
    isSplitSalesOperation,
    splitOperationOrder,
    splitPackages,
    splitValidation,
    canSubmitSalesOperation,
    salesOrderPartialErrorText,
  } = useSalesOrderOperationState({
    setSalesOperation,
    salesOperation,
    shops,
    activeShop,
    setSalesNotice,
    handleRefreshSalesOrders,
    detailOrder,
    fulfillment,
    status,
    orderSync,
  });
  const { sideOrderSearch, stats } = useSalesOrderViewMetaState({
    keyword,
    setKeyword,
    resetSalesOrderListState,
    salesOrderCountRows,
    orderSync,
    totalAmount,
    salesOrderSummary,
  });
  return {
    viewTitle,
    viewDescription,
    readableShops,
    paymentStartDate,
    setPaymentStartDate,
    paymentEndDate,
    setPaymentEndDate,
    paymentDateAnchorEl,
    setPaymentDateAnchorEl,
    orderSync,
    salesOrderRefreshProgress,
    status,
    setStatus,
    shop,
    setShop,
    fulfillment,
    setFulfillment,
    keyword,
    setKeyword,
    salesOrderPageSize,
    setSalesOrderPageSize,
    setSalesOrderPage,
    setSelectedOrderId,
    selectedSalesOrderKeys,
    salesSupplementErrorText,
    salesNotice,
    setSalesNotice,
    salesOperation,
    paymentDateOpen,
    paymentDateText,
    filteredOrders,
    filteredOrderTotal,
    salesOrderStatusCounts,
    salesOrderTotalPages,
    currentSalesOrderPage,
    visibleOrders,
    salesOrderRangeStart,
    salesOrderRangeEnd,
    filteredSalesOrderKeys,
    visibleSalesOrderKeys,
    selectedSalesOrderCount,
    selectionLoading,
    allSalesOrderPageSelected,
    salesOrderPageSelectionIndeterminate,
    selectedCancellableOrders,
    selectedShippableOrders,
    handleRefreshSalesOrders,
    logisticsSync,
    handleSyncLogistics,
    refreshPurchaseShippingInfo,
    resetSalesOrderListState,
    toggleSalesOrderSelection,
    toggleSalesOrderPageSelection,
    selectAllFilteredSalesOrders,
    clearSalesOrderSelection,
    selectedOrder,
    detailOrder,
    getSourceLinkRecord,
    getSourceSelectedSlot,
    getSourceLinkValue,
    selectSourceSlot,
    updateSourceLink,
    saveSourceLink,
    detailSourceLink,
    detailSourceEntry,
    detailCrossBorderInfo,
    detailPurchaseInfoSupport,
    getOrderPurchaseShippingInfo,
    openSalesPurchaseInfoWorkbench,
    openSalesOperation,
    openSalesBatchOperation,
    closeSalesOperation,
    updateSalesCancelReason,
    updateSalesSplitPackageQuantity,
    addSalesSplitPackage,
    removeSalesSplitPackage,
    executeSalesOperation,
    operationMeta,
    detailSplitLocked,
    detailSplitLockReason,
    canCancelDetailOrder,
    canShipDetailOrder,
    canSplitDetailOrder,
    operationOrders,
    isSplitSalesOperation,
    splitOperationOrder,
    splitPackages,
    splitValidation,
    canSubmitSalesOperation,
    salesOrderPartialErrorText,
    sideOrderSearch,
    stats,
    salesOzonProductWorkbench,
    openSalesOzonProductPage,
    openSalesPurchaseLink,
  };
}

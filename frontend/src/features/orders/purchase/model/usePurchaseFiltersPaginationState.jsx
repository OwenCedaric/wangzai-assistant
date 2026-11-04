import {
  getOzonShopScopeForSelection,
} from '../../../../entities/order/orderShopScope.jsx';
import { normalizeSalesOrderDateFilter } from '../../../../entities/order/orderDateRules.jsx';
import {
  filterRowsByStatus,
  paginateRows,
} from '../../../../services/localMirrorDataset';
import { sortOrderRowsByNewestPaymentTime } from '../../../../services/orderTimeSortRules';
import { clearOzonOrderSupplementCacheForRows } from '../../../../services/ozonOrderExperience';
import {
  getPurchaseOrderRecordKey,
} from '../lib/purchaseMarketingApi.jsx';
import { isPurchaseOrderStageMatch } from '../lib/purchaseOrderNormalize.jsx';
import React from 'react';
import { createPurchaseOrderSearchIndex } from './purchaseOrderSearchIndex.js';
import { createPurchaseOrderRangeReader } from './purchaseOrderRangeReadModel.js';

export function usePurchaseFiltersPaginationState({
  paymentStartDate,
  paymentEndDate,
  paymentDateAnchorEl,
  purchaseOrders,
  shop,
  fulfillment,
  keyword,
  status,
  purchaseOrderPage,
  purchaseOrderPageSize,
  selectedPurchaseOrderKeys,
  orderRowsWithImages,
  setPurchaseImageMap,
  setPurchaseImageErrorText,
  orderSync,
  externalRefreshTickRef,
  externalRefreshTick,
  isActive,
  readableShops,
} = {}) {
  const [legacyPurchaseSourceLinks, setLegacyPurchaseSourceLinks] = React.useState({});
  const [productSourceLinks, setProductSourceLinks] = React.useState({});
  const [selectedProductIndex, setSelectedProductIndex] = React.useState(0);
  const [selectedSourceSlot, setSelectedSourceSlot] = React.useState(0);
  const [selectedPurchaseSearchImage, setSelectedPurchaseSearchImage] = React.useState({
    orderId: '',
    imageUrl: '',
    slot: '',
  });
  const [purchasePlatformExpanded, setPurchasePlatformExpanded] = React.useState(false);
  const [sourceSearchDialog, setSourceSearchDialog] = React.useState({
    open: false,
    platform: '',
    searchUrl: '',
    results: [],
    title: '',
    imageUrl: '',
    loading: false,
    externalOnly: false,
    severity: 'info',
  });
  const paymentStartKey = normalizeSalesOrderDateFilter(paymentStartDate);
  const paymentEndKey = normalizeSalesOrderDateFilter(paymentEndDate);
  const paymentDateOpen = Boolean(paymentDateAnchorEl);
  const paymentDateText =
    paymentStartDate || paymentEndDate
      ? `${paymentStartDate || '开始日期'} - ${paymentEndDate || '结束日期'}`
      : '开始日期 - 结束日期';
  const selectedShopScope = React.useMemo(() => {
    return getOzonShopScopeForSelection(readableShops, shop);
  }, [readableShops, shop]);
  const indexReaderRef = React.useRef(null);
  if (!indexReaderRef.current) indexReaderRef.current = createPurchaseOrderSearchIndex();
  const purchaseOrdersIndex = React.useMemo(() => indexReaderRef.current(purchaseOrders), [purchaseOrders]);
  const rangeReaderRef = React.useRef(null);
  if (!rangeReaderRef.current) rangeReaderRef.current = createPurchaseOrderRangeReader();
  const purchaseOrderRange = React.useMemo(
    () => rangeReaderRef.current(purchaseOrdersIndex, {
      selectedShopScope, keyword, fulfillment, paymentStartKey, paymentEndKey,
    }),
    [fulfillment, keyword, paymentEndKey, paymentStartKey, purchaseOrdersIndex, selectedShopScope]
  );
  const purchaseOrderCountRows = purchaseOrderRange.rows;
  const purchaseOrderModuleCounts = purchaseOrderRange.moduleCounts;
  const filteredOrders = React.useMemo(
    () =>
      sortOrderRowsByNewestPaymentTime(
        filterRowsByStatus(purchaseOrderCountRows, status, {
          allValue: 'all',
          matchesStatus: (order, selectedStatus) => isPurchaseOrderStageMatch(order, selectedStatus),
        })
      ),
    [purchaseOrderCountRows, status]
  );
  const purchaseOrderStageCounts = purchaseOrderRange.stageCounts;
  const purchaseOrderPagination = React.useMemo(
    () => paginateRows(filteredOrders, purchaseOrderPage, purchaseOrderPageSize),
    [filteredOrders, purchaseOrderPage, purchaseOrderPageSize]
  );
  const purchaseOrderTotalPages = purchaseOrderPagination.totalPages;
  const currentPurchaseOrderPage = purchaseOrderPagination.currentPage;
  const visibleOrders = purchaseOrderPagination.rows;
  const purchaseOrderRangeStart = purchaseOrderPagination.rangeStart;
  const purchaseOrderRangeEnd = purchaseOrderPagination.rangeEnd;
  const filteredPurchaseOrderKeys = React.useMemo(
    () => filteredOrders.map((order) => getPurchaseOrderRecordKey(order)).filter(Boolean),
    [filteredOrders]
  );
  const visiblePurchaseOrderKeys = React.useMemo(
    () => visibleOrders.map((order) => getPurchaseOrderRecordKey(order)).filter(Boolean),
    [visibleOrders]
  );
  const selectedPurchaseOrderCount = filteredPurchaseOrderKeys.filter((key) =>
    selectedPurchaseOrderKeys.has(key)
  ).length;
  const selectedPurchasePageCount = visiblePurchaseOrderKeys.filter((key) => selectedPurchaseOrderKeys.has(key)).length;
  const allPurchasePageSelected =
    visiblePurchaseOrderKeys.length > 0 && selectedPurchasePageCount === visiblePurchaseOrderKeys.length;
  const purchasePageSelectionIndeterminate =
    selectedPurchasePageCount > 0 && selectedPurchasePageCount < visiblePurchaseOrderKeys.length;
  const selectedPurchaseOrders = React.useMemo(
    () => filteredOrders.filter((order) => selectedPurchaseOrderKeys.has(getPurchaseOrderRecordKey(order))),
    [filteredOrders, selectedPurchaseOrderKeys]
  );
  const handleRefreshPurchaseOrders = React.useCallback(() => {
    clearOzonOrderSupplementCacheForRows(orderRowsWithImages);
    setPurchaseImageMap(new Map());
    setPurchaseImageErrorText('');
    return orderSync.refresh();
  }, [orderRowsWithImages, orderSync, setPurchaseImageErrorText, setPurchaseImageMap]);
  React.useEffect(() => {
    if (externalRefreshTickRef.current === externalRefreshTick) return;
    externalRefreshTickRef.current = externalRefreshTick;
    if (!isActive || !externalRefreshTick) return;
    handleRefreshPurchaseOrders();
  }, [externalRefreshTick, handleRefreshPurchaseOrders, isActive, externalRefreshTickRef]);

  return {
    legacyPurchaseSourceLinks,
    setLegacyPurchaseSourceLinks,
    productSourceLinks,
    setProductSourceLinks,
    selectedProductIndex,
    setSelectedProductIndex,
    selectedSourceSlot,
    setSelectedSourceSlot,
    selectedPurchaseSearchImage,
    setSelectedPurchaseSearchImage,
    purchasePlatformExpanded,
    setPurchasePlatformExpanded,
    sourceSearchDialog,
    setSourceSearchDialog,
    paymentDateOpen,
    paymentDateText,
    purchaseOrderCountRows,
    purchaseOrderModuleCounts,
    filteredOrders,
    purchaseOrderStageCounts,
    purchaseOrderPagination,
    purchaseOrderTotalPages,
    currentPurchaseOrderPage,
    visibleOrders,
    purchaseOrderRangeStart,
    purchaseOrderRangeEnd,
    filteredPurchaseOrderKeys,
    visiblePurchaseOrderKeys,
    selectedPurchaseOrderCount,
    allPurchasePageSelected,
    purchasePageSelectionIndeterminate,
    selectedPurchaseOrders,
    handleRefreshPurchaseOrders,
  };
}

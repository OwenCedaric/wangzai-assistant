import {
  createOzonTimeRangeScope,
  getActiveOzonShop,
  getOzonReadableShops,
  getOzonSnapshotSourceKey,
} from '../../../../entities/order/orderShopScope.jsx';
import { getSalesOrderRecordKey } from '../../../../entities/order/orderSourceLinks.jsx';
import { mergeLocalRecordMaps } from '../../../../entities/product/productLocalMirror.jsx';
import { hydrateProductSourceLinksFromLocalFile } from '../../../../services/productSourceLinkStore';
import { migrateLegacySalesSourceLinksAtStartup } from '../../../../services/salesSourceLinkStore';
import { mergeSalesOrderVisibleSupplement } from '../../../../entities/profit/profitOrderSnapshot.jsx';
import {
  createOzonOrderChangeNotifications,
  readOzonOrderSupplementCache,
} from '../../../../services/ozonOrderExperience';
import { resolveSalesOrderShopId } from '../../../../services/salesOrderPagedCacheClient.js';
import { OZON_ORDER_DEFAULT_RANGE_DAYS } from '../../../../shared/config/appConfigCore.jsx';
import { useSalesOrderPagedCacheState } from './useSalesOrderPagedCacheState.jsx';
import { useSynchronizedOzonShopSelection } from '../../../../entities/order/useSynchronizedOzonShopSelection.jsx';
import React from 'react';

export function useSalesOrdersSnapshotState({
  shops,
  activeShopId,
  isActive,
  externalRefreshTick,
  onOrderNotifications,
  initialStatus = 'all',
  printShippingFilters = {},
  includePrintShippingFacets = false,
} = {}) {
  const activeShop = React.useMemo(() => getActiveOzonShop(shops, activeShopId), [shops, activeShopId]);
  const readableShops = React.useMemo(() => getOzonReadableShops(shops), [shops]);
  const readableShopsSourceKey = React.useMemo(() => getOzonSnapshotSourceKey(readableShops), [readableShops]);
  const [paymentStartDate, setPaymentStartDate] = React.useState('');
  const [paymentEndDate, setPaymentEndDate] = React.useState('');
  const [paymentDateAnchorEl, setPaymentDateAnchorEl] = React.useState(null);
  const salesOrderTimeScope = React.useMemo(
    () =>
      createOzonTimeRangeScope({
        page: 'sales-orders',
        startDate: paymentStartDate,
        endDate: paymentEndDate,
        defaultDays: OZON_ORDER_DEFAULT_RANGE_DAYS,
      }),
    [paymentEndDate, paymentStartDate]
  );
  const [status, setStatus] = React.useState(initialStatus);
  const [fulfillment, setFulfillment] = React.useState('all');
  const [keyword, setKeyword] = React.useState('');
  const deferredKeyword = React.useDeferredValue(keyword);
  const [salesOrderPageSize, setSalesOrderPageSize] = React.useState(20);
  const [salesOrderPage, setSalesOrderPage] = React.useState(1);
  const [selectedOrderId, setSelectedOrderId] = React.useState('');
  const [selectedSalesOrderKeys, setSelectedSalesOrderKeys] = React.useState(() => new Set());
  const [salesSupplementErrorText, setSalesSupplementErrorText] = React.useState('');
  const [sourceLinks, setSourceLinks] = React.useState({});
  const [legacySalesSourceLinks, setLegacySalesSourceLinks] = React.useState({});
  const [salesSourceSlotMap, setSalesSourceSlotMap] = React.useState({});
  const [salesNotice, setSalesNotice] = React.useState({ open: false, severity: 'success', message: '' });
  const [salesOperation, setSalesOperation] = React.useState({
    open: false,
    type: '',
    order: null,
    orders: [],
    cancelReasonId: '',
    cancelReasonMessage: '',
    cancelReasons: [],
    cancelReasonsLoading: false,
    cancelReasonsError: '',
    splitPlan: '',
    splitPackages: [],
    loading: false,
    error: '',
  });
  const [shop, setShop] = useSynchronizedOzonShopSelection({
    shops: readableShops,
    activeShopId,
    onScopeChange: () => {
    setSalesOrderPage(1);
    setSelectedOrderId('');
    setSelectedSalesOrderKeys(new Set());
    },
  });
  React.useEffect(() => {
    if (shop === 'all') return;
    const resolvedShopId = resolveSalesOrderShopId(readableShops, shop);
    if (resolvedShopId !== shop) setShop(resolvedShopId);
  }, [readableShops, setShop, shop]);
  const orderSync = useSalesOrderPagedCacheState({
    shops: readableShops,
    timeScope: salesOrderTimeScope,
    shop,
    status,
    fulfillment,
    keyword: deferredKeyword,
    printShippingFilters,
    includePrintShippingFacets,
    page: salesOrderPage,
    pageSize: salesOrderPageSize,
    isActive,
  });
  const salesOrderLocalSnapshotKey = React.useMemo(
    () => `sqlite:orders:${readableShops.map((item) => item.id || item.clientId || '').join(',')}:${salesOrderTimeScope.cachePart}`,
    [readableShops, salesOrderTimeScope.cachePart]
  );
  const salesOrderRefreshProgress = orderSync.progress;
  const resetSalesOrderRefreshProgress = React.useCallback(() => undefined, []);
  const baseOrderRows = React.useMemo(() => orderSync.data?.rows ?? [], [orderSync.data?.rows]);
  const [salesEnhancementMap, setSalesEnhancementMap] = React.useState(() => new Map());
  const orderRows = React.useMemo(
    () =>
      baseOrderRows.map((order) => {
        const key = getSalesOrderRecordKey(order);
        const enhancedOrder = key ? (salesEnhancementMap.get(key) ?? readOzonOrderSupplementCache(order)) : null;
        return mergeSalesOrderVisibleSupplement(order, enhancedOrder);
      }),
    [baseOrderRows, salesEnhancementMap]
  );
  const previousSalesOrderPageRef = React.useRef({ key: '', rows: [] });
  const externalRefreshTickRef = React.useRef(externalRefreshTick);
  React.useEffect(() => {
    let isActive = true;
    migrateLegacySalesSourceLinksAtStartup(shops)
      .then(({ canonicalLinks, unresolvedLegacyLinks }) => {
        if (isActive) setLegacySalesSourceLinks({ ...unresolvedLegacyLinks, ...canonicalLinks });
      })
      .catch(() => undefined);
    hydrateProductSourceLinksFromLocalFile({}, shops)
      .then((links) => {
        if (isActive) setSourceLinks((current) => mergeLocalRecordMaps(current, links));
      })
      .catch(() => undefined);
    return () => {
      isActive = false;
    };
  }, [shops]);
  React.useEffect(() => {
    if (!orderSync.data?.fetchedAt) return;
    const key = [salesOrderTimeScope.cachePart, shop, status, fulfillment, deferredKeyword, salesOrderPage, salesOrderPageSize].join('|');
    const previous = previousSalesOrderPageRef.current;
    if (previous.key === key && previous.rows.length && typeof onOrderNotifications === 'function') {
      const notifications = createOzonOrderChangeNotifications(previous.rows, orderRows);
      if (notifications.length) onOrderNotifications(notifications);
    }
    previousSalesOrderPageRef.current = { key, rows: orderRows };
  }, [deferredKeyword, fulfillment, onOrderNotifications, orderRows, orderSync.data?.fetchedAt, salesOrderPage, salesOrderPageSize, salesOrderTimeScope.cachePart, shop, status]);
  return {
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
  };
}

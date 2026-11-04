import {
  getAfterSalesOrderCardProductImage,
  getAfterSalesOrderCardProductQty,
  mergeAfterSalesOrderCardProducts,
  requestProtectedOzonOrderOperation,
} from '../../../entities/marketing/marketingOrderFields.jsx';
import {
  getOzonRealtimeSnapshotLogSource,
  getOzonRealtimeSnapshotSourceHint,
  preloadOzonRealtimeSnapshot,
  useOzonRealtimeSnapshot,
} from '../../../entities/marketing/marketingSnapshotRuntime.jsx';
import {
  attachOzonShopIdentityToRow,
  canUseOzonShop,
  createOzonTimeRangeScope,
  firstFilled,
  formatOzonOrderDate,
  getActiveOzonShop,
  getOzonReadableShops,
  getOzonRowShopScopeValues,
  getOzonShopForOrder,
  getOzonShopScopeForSelection,
  getOzonShopLabel,
  getOzonSnapshotSourceKey,
} from '../../../entities/order/orderShopScope.jsx';
import { requestOzonRfbsReturnDetail } from '../../../entities/order/afterSalesRfbsRead.jsx';
import {
  AFTER_SALES_SIGNED_REFUND_STATUS,
  AFTER_SALES_REFUSED_REFUND_STATUS,
  dedupeAfterSalesRowsByBusinessKey,
  isAfterSalesRefundLossStatus,
  OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION,
} from '../../../entities/order/orderAsyncRules.jsx';
import { normalizeAfterSalesAmountCurrencyForDisplay } from '../../../entities/order/orderDisplayFormat.jsx';
import { getAfterSalesOrderRecordKey } from '../../../entities/order/orderRecordRules.jsx';
import { recordLocalMirrorReadLog } from '../../../entities/product/productLocalData.jsx';
import {
  getOzonSnapshotRowActivityDateKey,
  upgradeAfterSalesClassificationRow,
  upgradeAfterSalesClassificationRows,
} from '../../../entities/profit/profitAfterSalesRules.jsx';
import { requestOzonAfterSalesSnapshotForShops } from '../../../entities/profit/profitAfterSalesSnapshot.jsx';
import {
  canOperateAfterSalesOrder,
  getAfterSalesFulfillment,
  shouldShowAfterSalesOrderInList,
  shouldShowAfterSalesOrderInPendingList,
} from '../../../services/afterSalesDisplayRules';
import {
  createOzonAfterSalesChangeNotifications,
} from '../../../services/ozonOrderExperience';
import {
  buildRowsIndex,
  buildStatusCounts,
  filterRowsByStatus,
  paginateRows,
  queryRowsIndex,
  validatePageDatasetConsistency,
} from '../../../services/localMirrorDataset';
import { sortAfterSalesRowsByNewestActivityTime } from '../../../services/orderTimeSortRules';
import { getSplitOrderLockReason } from '../../../services/orderSplitRelationRules';
import { readPurchaseOverrides } from '../../../services/purchaseOrderOverrideClient';
import {
  buildAfterSalesPurchaseOverrideIndex,
  getAfterSalesPurchaseSupport,
  getAfterSalesRefundStatus,
  getAfterSalesRefundTime,
  getAfterSalesResponsibilityParty,
  getAfterSalesSourceLabel,
} from '../../../services/afterSalesPurchaseSupport';
import { resolveOzonSellerAfterSalesWorkbenchTarget } from '../../../services/ozonSellerAfterSalesPageLink';
import { OZON_AFTER_SALES_DEFAULT_RANGE_DAYS, SALES_ORDER_PAGE_SIZE_OPTIONS } from '../../../shared/config/appConfigCore.jsx';
import { OrderSideSearch } from '../../../shared/ui/OrderSideSearch.jsx';
import { countRowsImages, usePagePerformanceLog } from '../../../shared/ozon/ozonRuntime.jsx';
import { ReadProgressPanel } from '../../../shared/ui/ReadProgressPanel.jsx';
import { doesAssociatedOrderMatchKeyword } from '../../../entities/profit/profitSearchRules.jsx';
import { afterSalesOrderStatusTabs } from '../../../entities/order/orderStatusRules.jsx';
import { useSynchronizedOzonShopSelection } from '../../../entities/order/useSynchronizedOzonShopSelection.jsx';
import { refreshAfterSalesCacheFast, refreshOrderCacheFast } from '../../../services/orderFastRefreshService.js';
import {
  getOzonPushRealtimeShopId,
  isOzonPushDomainRefreshEvent,
  OZON_PUSH_REALTIME_BROWSER_EVENT,
} from '../../../services/ozonPushRealtime.js';
import { SalesOrderProductImagePreview } from '../sales/ui/SalesOrderProductImagePreview.jsx';
import { OzonProductWorkbench } from '../purchase/components/OzonProductWorkbench.jsx';
import { useOzonProductWorkbenchState } from '../purchase/model/useOzonProductWorkbenchState.jsx';
import {
  buildAfterSalesOzonProductWorkbenchContext,
  getAfterSalesWorkbenchDisplayId,
} from './lib/afterSalesOzonProductWorkbenchContext.js';
import { getAfterSalesHandlingCountdown } from './lib/afterSalesHandlingCountdown.js';
import {
  buildAfterSalesOperationRequest,
  createAfterSalesOperationForm,
  getAfterSalesOperationPlan,
  getSelectedAfterSalesOperation,
  shouldLoadAfterSalesOperationPlan,
} from './lib/afterSalesOperation.js';
import { getAfterSalesDetailView } from './lib/afterSalesDetailView.js';
import { AfterSalesOperationDialog } from './components/AfterSalesOperationDialog.jsx';
import { useAfterSalesReasonTranslations } from './model/useAfterSalesReasonTranslations.js';
import { useAfterSalesCachedClassification } from './model/useAfterSalesCachedClassification.js';
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded';
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import KeyboardArrowRightRounded from '@mui/icons-material/KeyboardArrowRightRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Pagination from '@mui/material/Pagination';
import Popover from '@mui/material/Popover';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

const AFTER_SALES_INSTANT_CACHE_TTL_MS = 5 * 60 * 1000;

function createAfterSalesSnapshotGroup(timeScope) {
  return `ozon-after-sales:${OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION}:${timeScope.cachePart}`;
}

function createAfterSalesLoaderOptions(timeScope) {
  return {
    autoSync: false,
    enrichRfbsDetails: false,
    enrichClassificationEvidence: null,
    enrichLocalOriginalOrderEvidence: true,
    dateRange: timeScope.apiRange,
    timeScope,
    defaultDays: OZON_AFTER_SALES_DEFAULT_RANGE_DAYS,
    recordNotifications: true,
    schedulerProfile: 'background',
    syncSource: 'after-sales-canonical-read',
    requestedBy: 'frontend-after-sales-canonical-read',
  };
}

export async function preloadAfterSalesOrdersLocalCache(shops = []) {
  const readableShops = getOzonReadableShops(shops);
  if (!readableShops.length) return null;
  const timeScope = createOzonTimeRangeScope({
    page: 'after-sales-orders',
    defaultDays: OZON_AFTER_SALES_DEFAULT_RANGE_DAYS,
  });
  return preloadOzonRealtimeSnapshot(readableShops, requestOzonAfterSalesSnapshotForShops, {
    cacheTtlMs: AFTER_SALES_INSTANT_CACHE_TTL_MS,
    allowAggregateLocalData: true,
    cacheGroup: createAfterSalesSnapshotGroup(timeScope),
    loaderOptions: createAfterSalesLoaderOptions(timeScope),
  });
}

function normalizeAfterSalesRowsForDisplayCache(rows = []) {
  const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object');
  return dedupeAfterSalesRowsByBusinessKey(upgradeAfterSalesClassificationRows(safeRows)).filter(
    (row) => row && !row.excludeFromAfterSales
  );
}

function waitForAfterSalesOperationRead(task, timeoutMs = 15000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error('读取 Ozon 售后操作超时，请稍后重试或打开 Ozon 后台处理。'));
    }, timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function AfterSalesOrdersPage({
  shops = [],
  activeShopId,
  isActive = true,
  externalRefreshTick = 0,
  onOrderNotifications,
  pendingOnly = false,
}) {
  const activeShop = React.useMemo(() => getActiveOzonShop(shops, activeShopId), [shops, activeShopId]);
  const afterSalesOzonProductWorkbench = useOzonProductWorkbenchState();
  const readableShops = React.useMemo(() => {
    const readable = getOzonReadableShops(shops);
    return readable.length ? readable : canUseOzonShop(activeShop) ? [activeShop] : [];
  }, [activeShop, shops]);
  const readableAfterSalesShopKey = getOzonSnapshotSourceKey(readableShops);
  const [afterSalesStartDate, setAfterSalesStartDate] = React.useState('');
  const [afterSalesEndDate, setAfterSalesEndDate] = React.useState('');
  const [afterSalesDateAnchorEl, setAfterSalesDateAnchorEl] = React.useState(null);
  const afterSalesTimeScope = React.useMemo(
    () =>
      createOzonTimeRangeScope({
        page: 'after-sales-orders',
        startDate: afterSalesStartDate,
        endDate: afterSalesEndDate,
        defaultDays: OZON_AFTER_SALES_DEFAULT_RANGE_DAYS,
      }),
    [afterSalesEndDate, afterSalesStartDate]
  );
  const afterSalesDateOpen = Boolean(afterSalesDateAnchorEl);
  const afterSalesDateText =
    afterSalesStartDate || afterSalesEndDate
      ? `${afterSalesStartDate || '开始日期'} - ${afterSalesEndDate || '结束日期'}`
      : `最近 ${OZON_AFTER_SALES_DEFAULT_RANGE_DAYS} 天`;
  const afterSalesSnapshotGroup = createAfterSalesSnapshotGroup(afterSalesTimeScope);
  const afterSalesCanonicalScopeKey = `${afterSalesSnapshotGroup}:${readableAfterSalesShopKey}`;
  const afterSalesLoaderOptions = React.useMemo(
    () => ({
      autoSync: false,
      enrichRfbsDetails: false,
      enrichClassificationEvidence: null,
      enrichLocalOriginalOrderEvidence: true,
      dateRange: afterSalesTimeScope.apiRange,
      timeScope: afterSalesTimeScope,
      defaultDays: OZON_AFTER_SALES_DEFAULT_RANGE_DAYS,
      recordNotifications: true,
      schedulerProfile: 'background',
      syncSource: 'after-sales-canonical-read',
      requestedBy: 'frontend-after-sales-canonical-read',
    }),
    [afterSalesTimeScope]
  );
  const afterSalesSync = useOzonRealtimeSnapshot(readableShops, requestOzonAfterSalesSnapshotForShops, {
    enabled: readableShops.length > 0,
    refreshOnMount: true,
    manualRefreshCooldownMs: 5000,
    manualRefreshCooldownKey: afterSalesSnapshotGroup,
    cacheTtlMs: AFTER_SALES_INSTANT_CACHE_TTL_MS,
    allowAggregateLocalData: true,
    refreshOnCacheHit: false,
    cacheGroup: afterSalesSnapshotGroup,
    snapshotIdentityKey: afterSalesCanonicalScopeKey,
    invalidateOnSnapshotKeyChange: true,
    keepCurrentDataOnForceRefresh: true,
    loaderOptions: afterSalesLoaderOptions,
  });
  const [afterSalesFastRefreshRunning, setAfterSalesFastRefreshRunning] = React.useState(false);
  const pendingAfterSalesCacheReloadRef = React.useRef(false);
  const reloadAfterSalesSnapshot = afterSalesSync.reload;
  const reloadAfterSalesCache = React.useCallback(() => reloadAfterSalesSnapshot({
    silent: true,
    force: true,
    loaderForceRefresh: false,
    loaderOptions: {
      autoSync: false,
      enrichRfbsDetails: false,
      enrichClassificationEvidence: null,
    },
  }), [reloadAfterSalesSnapshot]);
  const refreshAfterSalesOrdersFast = React.useCallback(async () => {
    if (afterSalesFastRefreshRunning) return null;
    setAfterSalesFastRefreshRunning(true);
    try {
      await reloadAfterSalesCache().catch(() => null);
      const [returnsResult, ordersResult] = await Promise.all([
        refreshAfterSalesCacheFast(readableShops, afterSalesTimeScope, {
          requestedBy: 'frontend-after-sales-fast-refresh',
          source: 'after-sales-fast-refresh',
          foregroundWaitMs: 10_000,
        }),
        refreshOrderCacheFast(readableShops, afterSalesTimeScope, {
          requestedBy: 'frontend-after-sales-order-fast-refresh',
          source: 'after-sales-order-fast-refresh',
          foregroundWaitMs: 10_000,
        }),
      ]);
      await reloadAfterSalesCache().catch(() => null);
      return { returns: returnsResult, orders: ordersResult };
    } finally {
      setAfterSalesFastRefreshRunning(false);
    }
  }, [afterSalesFastRefreshRunning, afterSalesTimeScope, readableShops, reloadAfterSalesCache]);
  React.useEffect(() => {
    const readableShopIds = new Set(readableShops.map((item) => String(item?.id || '').trim()).filter(Boolean));
    let timer = null;
    const handleAfterSalesCacheUpdated = (event) => {
      const isRelevant =
        isOzonPushDomainRefreshEvent(event, 'returns') ||
        isOzonPushDomainRefreshEvent(event, 'orders');
      if (!isRelevant) return;
      const shopId = getOzonPushRealtimeShopId(event);
      if (!shopId || !readableShopIds.has(shopId)) return;
      if (!isActive) {
        pendingAfterSalesCacheReloadRef.current = true;
        return;
      }
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => {
        pendingAfterSalesCacheReloadRef.current = false;
        void reloadAfterSalesCache().catch(() => undefined);
      }, 100);
    };
    globalThis.addEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleAfterSalesCacheUpdated);
    return () => {
      globalThis.clearTimeout(timer);
      globalThis.removeEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleAfterSalesCacheUpdated);
    };
  }, [isActive, readableShops, reloadAfterSalesCache]);
  React.useEffect(() => {
    if (!isActive || !pendingAfterSalesCacheReloadRef.current) return;
    pendingAfterSalesCacheReloadRef.current = false;
    void reloadAfterSalesCache().catch(() => undefined);
  }, [isActive, reloadAfterSalesCache]);
  const untranslatedBaseAfterSalesRows = React.useMemo(
    () => normalizeAfterSalesRowsForDisplayCache(afterSalesSync.data?.rows ?? []),
    [afterSalesSync.data?.rows]
  );
  const afterSalesClassification = useAfterSalesCachedClassification(
    untranslatedBaseAfterSalesRows,
    readableShops
  );
  const classifiedBaseAfterSalesRows = afterSalesClassification.rows;
  const baseAfterSalesRows = useAfterSalesReasonTranslations(classifiedBaseAfterSalesRows);
  const afterSalesBlockingLoading =
    (afterSalesSync.loading || afterSalesFastRefreshRunning || !afterSalesClassification.ready) &&
    !baseAfterSalesRows.length;
  const afterSalesBackgroundSyncing =
    (afterSalesSync.loading || afterSalesSync.refreshing || afterSalesFastRefreshRunning) && baseAfterSalesRows.length > 0;
  const afterSalesProgressVisible = afterSalesBlockingLoading || afterSalesBackgroundSyncing;
  const afterSalesProgressMessage = afterSalesBackgroundSyncing
    ? `后台正在更新本地售后缓存，当前显示 ${baseAfterSalesRows.length} 条`
    : '正在读取 Ozon 售后订单';
  const afterSalesRows = React.useMemo(
    () =>
      dedupeAfterSalesRowsByBusinessKey(
        baseAfterSalesRows.filter((order) => order && typeof order === 'object').map((order) => {
          return attachOzonShopIdentityToRow(
            upgradeAfterSalesClassificationRow(normalizeAfterSalesAmountCurrencyForDisplay(order)),
            readableShops
          );
        })
      ).filter((order) => !order.excludeFromAfterSales),
    [baseAfterSalesRows, readableShops]
  );
  const [status, setStatus] = React.useState('all');
  const [fulfillment, setFulfillment] = React.useState('all');
  const [keyword, setKeyword] = React.useState('');
  const [afterSalesPageSize, setAfterSalesPageSize] = React.useState(20);
  const [afterSalesPage, setAfterSalesPage] = React.useState(1);
  const [selectedOrderId, setSelectedOrderId] = React.useState('');
  const [selectedAfterSalesProductIndex, setSelectedAfterSalesProductIndex] = React.useState(0);
  const [afterSalesCountdownNowMs, setAfterSalesCountdownNowMs] = React.useState(() => Date.now());
  const [purchaseOverrideRows, setPurchaseOverrideRows] = React.useState([]);
  const [afterSalesOperationDialog, setAfterSalesOperationDialog] = React.useState({
    open: false,
    loading: false,
    submitting: false,
    order: null,
    plan: null,
    error: '',
  });
  const [afterSalesOperationForm, setAfterSalesOperationForm] = React.useState({});
  const [afterSalesOperationFeedback, setAfterSalesOperationFeedback] = React.useState(null);
  const externalRefreshTickRef = React.useRef(externalRefreshTick);
  const notificationRowsRef = React.useRef([]);
  const resetAfterSalesOrderListState = React.useCallback(() => {
    setAfterSalesPage(1);
    setSelectedOrderId('');
    setSelectedAfterSalesProductIndex(0);
  }, []);
  const [shop, setShop] = useSynchronizedOzonShopSelection({
    shops: readableShops,
    activeShopId,
    onScopeChange: resetAfterSalesOrderListState,
  });

  React.useEffect(() => {
    if (externalRefreshTickRef.current === externalRefreshTick) return;
    externalRefreshTickRef.current = externalRefreshTick;
    if (!isActive || !externalRefreshTick) return;
    void reloadAfterSalesCache().catch(() => undefined);
  }, [externalRefreshTick, isActive, reloadAfterSalesCache]);

  React.useEffect(() => {
    if (!isActive || !afterSalesSync.hasLoaded || afterSalesSync.loading || afterSalesSync.refreshing) return;
    const previousRows = notificationRowsRef.current;
    notificationRowsRef.current = baseAfterSalesRows;
    if (!previousRows.length || typeof onOrderNotifications !== 'function') return;
    const notifications = createOzonAfterSalesChangeNotifications(previousRows, baseAfterSalesRows, {
      createdAt: afterSalesSync.data?.fetchedAt || new Date().toISOString(),
    });
    if (notifications.length) onOrderNotifications(notifications);
  }, [
    afterSalesSync.data?.fetchedAt,
    afterSalesSync.hasLoaded,
    afterSalesSync.loading,
    afterSalesSync.refreshing,
    baseAfterSalesRows,
    isActive,
    onOrderNotifications,
  ]);

  React.useEffect(() => {
    if (!isActive) return undefined;
    let stopped = false;
    async function readOverrides() {
      try {
        const rows = [];
        const pageSize = 1000;
        for (let page = 1; page <= 10; page += 1) {
          const result = await readPurchaseOverrides({ page, pageSize });
          const pageRows = Array.isArray(result?.rows) ? result.rows : [];
          rows.push(...pageRows);
          const total = Number(result?.total) || rows.length;
          if (rows.length >= total || pageRows.length < pageSize) break;
        }
        if (!stopped) setPurchaseOverrideRows(rows);
      } catch {
        if (!stopped) setPurchaseOverrideRows([]);
      }
    }
    readOverrides();
    return () => {
      stopped = true;
    };
  }, [afterSalesSync.data?.fetchedAt, isActive]);

  const purchaseOverrideIndex = React.useMemo(
    () => buildAfterSalesPurchaseOverrideIndex(purchaseOverrideRows),
    [purchaseOverrideRows]
  );
  const openAfterSalesOzonProductPage = React.useCallback((order, product = {}) => {
    return afterSalesOzonProductWorkbench.openOzonProduct(buildAfterSalesOzonProductWorkbenchContext({
      order,
      product,
      purchaseOverrideIndex,
      readableShops,
    }));
  }, [
    afterSalesOzonProductWorkbench,
    purchaseOverrideIndex,
    readableShops,
  ]);
  const openAfterSalesPurchaseLink = React.useCallback((url, order, product = order?.products?.[0] || {}) => (
    afterSalesOzonProductWorkbench.openPurchaseLink({
      url,
      ...buildAfterSalesOzonProductWorkbenchContext({
        order,
        product,
        purchaseOverrideIndex,
        readableShops,
      }),
    })
  ), [
    afterSalesOzonProductWorkbench,
    purchaseOverrideIndex,
    readableShops,
  ]);
  const openAfterSalesSellerDetail = React.useCallback((order, product = order?.products?.[0] || {}) => {
    const target = resolveOzonSellerAfterSalesWorkbenchTarget(order);
    if (!target.url) return null;
    if (!target.exact) {
      return afterSalesOzonProductWorkbench.openOzonSellerOrder({
        ...buildAfterSalesOzonProductWorkbenchContext({
          order,
          product,
          purchaseOverrideIndex,
          readableShops,
        }),
        subtitle: '左侧固定当前售后订单卡片，右侧自动定位并打开当前 Ozon 原订单',
      });
    }
    return afterSalesOzonProductWorkbench.openPurchaseLink({
      url: target.url,
      ...buildAfterSalesOzonProductWorkbenchContext({
        order,
        product,
        purchaseOverrideIndex,
        readableShops,
      }),
      subtitle: '左侧固定当前售后订单卡片，右侧显示当前 Ozon Seller 售后详情',
    });
  }, [
    afterSalesOzonProductWorkbench,
    purchaseOverrideIndex,
    readableShops,
  ]);
  const afterSalesRowsIndex = React.useMemo(
    () =>
      buildRowsIndex(afterSalesRows, {
        getRowKey: (order) =>
          `${firstFilled(order.shopClientId, order.shopId, order.shop)}:${getAfterSalesOrderRecordKey(order)}`,
        getRowShop: getOzonRowShopScopeValues,
        getRowStatuses: (order) => [order.status],
        getSearchValues: (order) => {
          const firstProduct = order.products?.[0] ?? {};
          return [
            getAfterSalesWorkbenchDisplayId(order),
            order.salesOrder,
            order.posting,
            order.buyer,
            order.product,
            order.sku,
            firstProduct.offerId,
            firstProduct.skuId,
            firstProduct.sku,
            firstProduct.name,
            order.reason,
            order.splitParentPostingNumber,
            ...(Array.isArray(order.splitChildPostingNumbers) ? order.splitChildPostingNumbers : []),
            order.splitRelation?.parentPostingNumber,
            ...(Array.isArray(order.splitRelation?.childPostingNumbers) ? order.splitRelation.childPostingNumbers : []),
          ];
        },
      }),
    [afterSalesRows]
  );
  const selectedAfterSalesShopScope = React.useMemo(() => {
    return getOzonShopScopeForSelection(readableShops, shop);
  }, [readableShops, shop]);

  const filteredOrders = React.useMemo(
    () =>
      queryRowsIndex(afterSalesRowsIndex, {
        shopScope: selectedAfterSalesShopScope,
        keyword,
      }).filter((order) => {
        const keywordText = String(keyword || '')
          .trim()
          .toLowerCase();
        const matchAfterSalesDisplay = pendingOnly
          ? shouldShowAfterSalesOrderInPendingList(order, { keyword: keywordText })
          : shouldShowAfterSalesOrderInList(order, { keyword: keywordText });
        const matchFulfillment = fulfillment === 'all' || getAfterSalesFulfillment(order) === fulfillment;
        const firstProduct = order.products?.[0] ?? {};
        const matchKeyword = doesAssociatedOrderMatchKeyword(order, keyword, [
          order.buyer,
          order.product,
          order.sku,
          firstProduct.offerId,
          firstProduct.skuId,
          order.reason,
        ]);
        const afterSalesDateKey = getOzonSnapshotRowActivityDateKey(order);
        const matchStart =
          !afterSalesTimeScope.startDateKey ||
          !afterSalesDateKey ||
          afterSalesDateKey >= afterSalesTimeScope.startDateKey;
        const matchEnd =
          !afterSalesTimeScope.endDateKey || !afterSalesDateKey || afterSalesDateKey <= afterSalesTimeScope.endDateKey;
        return matchAfterSalesDisplay && matchFulfillment && matchKeyword && matchStart && matchEnd;
      }),
    [
      afterSalesRowsIndex,
      afterSalesTimeScope.endDateKey,
      afterSalesTimeScope.startDateKey,
      fulfillment,
      keyword,
      pendingOnly,
      selectedAfterSalesShopScope,
    ]
  );
  const filteredOrdersWithStatus = React.useMemo(
    () =>
      sortAfterSalesRowsByNewestActivityTime(
        filterRowsByStatus(filteredOrders, status, {
          allValue: 'all',
          matchesStatus: (order, selectedStatus) =>
            selectedStatus === AFTER_SALES_REFUSED_REFUND_STATUS
              ? isAfterSalesRefundLossStatus(order.status)
              : order.status === selectedStatus,
        })
      ),
    [filteredOrders, status]
  );

  const afterSalesPagination = React.useMemo(
    () => paginateRows(filteredOrdersWithStatus, afterSalesPage, afterSalesPageSize),
    [afterSalesPage, afterSalesPageSize, filteredOrdersWithStatus]
  );
  const afterSalesStatusCounts = React.useMemo(
    () =>
      buildStatusCounts(filteredOrders, afterSalesOrderStatusTabs, {
        allValue: 'all',
        matchesStatus: (order, selectedStatus) =>
          selectedStatus === AFTER_SALES_REFUSED_REFUND_STATUS
            ? isAfterSalesRefundLossStatus(order.status)
            : order.status === selectedStatus,
      }),
    [filteredOrders]
  );
  const afterSalesTotalPages = afterSalesPagination.totalPages;
  const currentAfterSalesPage = afterSalesPagination.currentPage;
  const visibleOrders = afterSalesPagination.rows;
  const afterSalesRangeStart = afterSalesPagination.rangeStart;
  const afterSalesRangeEnd = afterSalesPagination.rangeEnd;
  const visibleAfterSalesImageCount = React.useMemo(() => countRowsImages(visibleOrders), [visibleOrders]);
  usePagePerformanceLog('售后订单', afterSalesSync.performance, {
    loading: afterSalesBlockingLoading,
    rows: visibleOrders.length,
    imageCount: visibleAfterSalesImageCount,
  });
  const afterSalesPerformanceEventId = afterSalesSync.performance?.eventId || '';
  const afterSalesHasFreshRemoteResult = afterSalesPerformanceEventId.endsWith(':api');
  const afterSalesSourceHint = getOzonRealtimeSnapshotSourceHint(afterSalesSync);
  const selectedOrder =
    visibleOrders.find((order) => getAfterSalesOrderRecordKey(order) === selectedOrderId) ?? visibleOrders[0] ?? null;
  const afterSalesDatasetConsistency = React.useMemo(
    () =>
      validatePageDatasetConsistency(
        {
          countRows: filteredOrders,
          filteredRows: filteredOrdersWithStatus,
          statusCounts: afterSalesStatusCounts,
          pageRows: visibleOrders,
          page: afterSalesPagination,
          detailRow: selectedOrder,
          detailSourceRows: filteredOrdersWithStatus,
        },
        {
          allStatusValue: 'all',
          getRowKey: getAfterSalesOrderRecordKey,
        }
      ),
    [
      afterSalesPagination,
      afterSalesStatusCounts,
      filteredOrders,
      filteredOrdersWithStatus,
      selectedOrder,
      visibleOrders,
    ]
  );
  const afterSalesConsistencyLogKeyRef = React.useRef('');
  React.useEffect(() => {
    if (!isActive || afterSalesSync.loading) return;
    const consistencyLogKey = [
      afterSalesSnapshotGroup,
      afterSalesSync.performance?.eventId || '',
      afterSalesTimeScope.cachePart,
      shop,
      status,
      keyword,
      afterSalesPage,
      afterSalesPageSize,
      filteredOrders.length,
      filteredOrdersWithStatus.length,
      afterSalesPagination.totalRows,
      afterSalesDatasetConsistency.ok ? 'ok' : afterSalesDatasetConsistency.issues.map((issue) => issue.code).join(','),
    ].join('|');
    if (afterSalesConsistencyLogKeyRef.current === consistencyLogKey) return;
    afterSalesConsistencyLogKeyRef.current = consistencyLogKey;
    recordLocalMirrorReadLog({
      domain: '09_after_sales',
      source: getOzonRealtimeSnapshotLogSource(afterSalesSync),
      status: afterSalesDatasetConsistency.ok ? 'consistency-ok' : 'consistency-failed',
      rows: afterSalesRows.length,
      failures: afterSalesDatasetConsistency.issues.length,
      partial: !afterSalesDatasetConsistency.ok,
      refreshedAt: afterSalesSync.data?.fetchedAt || afterSalesSync.data?.updatedAt || new Date().toISOString(),
      details: {
        cacheScopeKey: afterSalesSnapshotGroup,
        canonicalScopeKey: afterSalesCanonicalScopeKey,
        timeScope: afterSalesTimeScope.cachePart,
        shopScope: shop,
        selectedStatus: status,
        keyword,
        filteredRows: filteredOrdersWithStatus.length,
        countRows: filteredOrders.length,
        pageRows: visibleOrders.length,
        pageTotalRows: afterSalesPagination.totalRows,
        consistency: afterSalesDatasetConsistency,
      },
    }).catch(() => undefined);
  }, [
    afterSalesDatasetConsistency,
    afterSalesCanonicalScopeKey,
    afterSalesPage,
    afterSalesPageSize,
    afterSalesPagination.totalRows,
    afterSalesRows.length,
    afterSalesSnapshotGroup,
    afterSalesSync,
    afterSalesTimeScope.cachePart,
    filteredOrders.length,
    filteredOrdersWithStatus.length,
    isActive,
    keyword,
    shop,
    status,
    visibleOrders.length,
  ]);
  const selectedOrderKey = selectedOrder ? getAfterSalesOrderRecordKey(selectedOrder) : '';
  const selectedAfterSalesProducts = React.useMemo(
    () => mergeAfterSalesOrderCardProducts(selectedOrder?.products ?? []),
    [selectedOrder]
  );
  const safeSelectedAfterSalesProductIndex = selectedAfterSalesProducts.length
    ? Math.min(selectedAfterSalesProductIndex, selectedAfterSalesProducts.length - 1)
    : 0;
  const selectedAfterSalesProduct = selectedAfterSalesProducts[safeSelectedAfterSalesProductIndex] ?? null;
  const detailAfterSalesOperateAllowed = canOperateAfterSalesOrder(selectedOrder);
  const detailSplitLocked = Boolean(
    selectedOrder &&
    (!detailAfterSalesOperateAllowed ||
      selectedOrder.originalOrderSplitRole === 'parent' ||
      selectedOrder.splitRole === 'parent')
  );
  const detailSplitLockReason = detailSplitLocked
    ? firstFilled(
        selectedOrder?.originalOrderSplitLockReason,
        selectedOrder?.splitLockReason,
        getSplitOrderLockReason(selectedOrder)
      )
    : '';
  const selectedAfterSalesRefundStatus = React.useMemo(() => getAfterSalesRefundStatus(selectedOrder), [selectedOrder]);
  const selectedAfterSalesRefundTime = React.useMemo(() => getAfterSalesRefundTime(selectedOrder), [selectedOrder]);
  const selectedAfterSalesResponsibilityParty = React.useMemo(
    () => getAfterSalesResponsibilityParty(selectedOrder),
    [selectedOrder]
  );
  const selectedAfterSalesDisplayId = React.useMemo(
    () => getAfterSalesWorkbenchDisplayId(selectedOrder ?? {}),
    [selectedOrder]
  );
  const selectedAfterSalesSellerTarget = React.useMemo(
    () => resolveOzonSellerAfterSalesWorkbenchTarget(selectedOrder ?? {}),
    [selectedOrder]
  );
  const selectedAfterSalesSourceLabel = React.useMemo(() => getAfterSalesSourceLabel(selectedOrder), [selectedOrder]);
  const selectedAfterSalesHandlingCountdown = React.useMemo(
    () => getAfterSalesHandlingCountdown(selectedOrder, { nowMs: afterSalesCountdownNowMs }),
    [afterSalesCountdownNowMs, selectedOrder]
  );
  const selectedAfterSalesPurchaseSupport = React.useMemo(
    () => getAfterSalesPurchaseSupport(selectedOrder, purchaseOverrideIndex, readableShops),
    [purchaseOverrideIndex, readableShops, selectedOrder]
  );

  React.useEffect(() => {
    if (!isActive || !selectedOrderKey) return undefined;
    setAfterSalesCountdownNowMs(Date.now());
    const timerId = window.setInterval(() => setAfterSalesCountdownNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timerId);
  }, [isActive, selectedOrderKey]);

  const closeAfterSalesOperationDialog = React.useCallback(() => {
    setAfterSalesOperationDialog((current) => (
      current.submitting
        ? current
        : { open: false, loading: false, submitting: false, order: null, plan: null, error: '' }
    ));
  }, []);

  const openAfterSalesOperationDialog = React.useCallback(async (order) => {
    const initialPlan = getAfterSalesOperationPlan(order);
    const shouldLoadLatestPlan = shouldLoadAfterSalesOperationPlan(initialPlan);
    const exactShop = getOzonShopForOrder(
      order,
      readableShops,
      readableShops.length === 1 ? readableShops[0] : null
    );
    setAfterSalesOperationFeedback(null);
    setAfterSalesOperationForm(createAfterSalesOperationForm(initialPlan));
    setAfterSalesOperationDialog({
      open: true,
      loading: shouldLoadLatestPlan,
      submitting: false,
      order,
      plan: initialPlan,
      error: exactShop ? '' : '无法确认这条售后属于哪个店铺，已阻止提交。',
    });

    if (!exactShop || !shouldLoadLatestPlan) return;

    try {
      const latestRaw = await waitForAfterSalesOperationRead(
        requestOzonRfbsReturnDetail(exactShop, {
          ...(order.raw || {}),
          return_id: initialPlan.returnId,
        })
      );
      const latestPlan = getAfterSalesOperationPlan(order, latestRaw);
      setAfterSalesOperationForm(createAfterSalesOperationForm(latestPlan));
      setAfterSalesOperationDialog({
        open: true,
        loading: false,
        submitting: false,
        order,
        plan: latestPlan,
        error: '',
      });
    } catch (error) {
      setAfterSalesOperationDialog({
        open: true,
        loading: false,
        submitting: false,
        order,
        plan: initialPlan,
        error: error?.message || '读取 Ozon 最新售后动作失败，请刷新后重试。',
      });
    }
  }, [readableShops]);

  const submitAfterSalesOperation = React.useCallback(async () => {
    const current = afterSalesOperationDialog;
    if (!current.plan || !current.order || current.loading || current.submitting) return;
    const exactShop = getOzonShopForOrder(
      current.order,
      readableShops,
      readableShops.length === 1 ? readableShops[0] : null
    );
    if (!exactShop) {
      setAfterSalesOperationDialog((state) => ({
        ...state,
        error: '无法确认这条售后属于哪个店铺，已阻止提交。',
      }));
      return;
    }

    let operation;
    try {
      operation = buildAfterSalesOperationRequest(current.plan, afterSalesOperationForm);
    } catch (error) {
      setAfterSalesOperationDialog((state) => ({ ...state, error: error?.message || '售后操作参数不完整。' }));
      return;
    }

    setAfterSalesOperationDialog((state) => ({ ...state, submitting: true, error: '' }));
    try {
      const result = await requestProtectedOzonOrderOperation(
        operation.operationId,
        exactShop,
        operation.payload,
        { confirmed: true }
      );
      const message = result?.localApiWrite?.message || '售后操作已提交 Ozon，正在刷新处理结果。';
      setAfterSalesOperationFeedback({ severity: 'success', message });
      setAfterSalesOperationDialog({
        open: false,
        loading: false,
        submitting: false,
        order: null,
        plan: null,
        error: '',
      });
      Promise.resolve(refreshAfterSalesOrdersFast()).catch(() => undefined);
    } catch (error) {
      setAfterSalesOperationDialog((state) => ({
        ...state,
        submitting: false,
        error: error?.message || 'Ozon 售后操作提交失败，请根据提示检查后重试。',
      }));
    }
  }, [afterSalesOperationDialog, afterSalesOperationForm, readableShops, refreshAfterSalesOrdersFast]);

  const selectedAfterSalesOperation = React.useMemo(
    () => getSelectedAfterSalesOperation(afterSalesOperationDialog.plan || {}, afterSalesOperationForm),
    [afterSalesOperationDialog.plan, afterSalesOperationForm]
  );
  const selectedAfterSalesRejectionReason = React.useMemo(
    () => (afterSalesOperationDialog.plan?.rejectionReasons || []).find(
      (reason) => String(reason.id) === String(afterSalesOperationForm.rejectionReasonId)
    ) || null,
    [afterSalesOperationDialog.plan?.rejectionReasons, afterSalesOperationForm.rejectionReasonId]
  );
  const afterSalesOperationDetail = React.useMemo(
    () => getAfterSalesDetailView(
      afterSalesOperationDialog.order || {},
      afterSalesOperationDialog.plan
    ),
    [afterSalesOperationDialog.order, afterSalesOperationDialog.plan]
  );
  const afterSalesOperationSellerTarget = React.useMemo(
    () => resolveOzonSellerAfterSalesWorkbenchTarget(afterSalesOperationDialog.order || {}),
    [afterSalesOperationDialog.order]
  );

  React.useEffect(() => {
    if (afterSalesPage > afterSalesTotalPages) {
      setAfterSalesPage(afterSalesTotalPages);
    }
  }, [afterSalesPage, afterSalesTotalPages]);

  React.useEffect(() => {
    if (filteredOrdersWithStatus.length === 0) {
      if (selectedOrderId) setSelectedOrderId('');
      return;
    }
    if (!visibleOrders.some((order) => getAfterSalesOrderRecordKey(order) === selectedOrderId)) {
      setSelectedOrderId(getAfterSalesOrderRecordKey(visibleOrders[0] ?? filteredOrdersWithStatus[0]));
    }
  }, [filteredOrdersWithStatus, selectedOrderId, visibleOrders]);

  React.useEffect(() => {
    setSelectedAfterSalesProductIndex(0);
  }, [selectedOrderKey]);

  React.useEffect(() => {
    if (!selectedAfterSalesProducts.length || selectedAfterSalesProductIndex < selectedAfterSalesProducts.length)
      return;
    setSelectedAfterSalesProductIndex(0);
  }, [selectedAfterSalesProductIndex, selectedAfterSalesProducts.length]);

  const stats = [
    { title: '售后总数', value: String(afterSalesStatusCounts.all ?? 0), hint: afterSalesSourceHint, tone: 'primary' },
    {
      title: '发货前取消',
      value: String(afterSalesStatusCounts['发货前取消'] ?? 0),
      hint: '未出库订单',
      tone: 'warning',
    },
    {
      title: '发货后取消',
      value: String(afterSalesStatusCounts['发货后取消'] ?? 0),
      hint: '需确认物流拦截',
      tone: 'error',
    },
    {
      title: '拒收后退款',
      value: String(afterSalesStatusCounts[AFTER_SALES_REFUSED_REFUND_STATUS] ?? 0),
      hint: '需核算货款损失',
      tone: 'success',
    },
    {
      title: '签收后退款',
      value: String(afterSalesStatusCounts[AFTER_SALES_SIGNED_REFUND_STATUS] ?? 0),
      hint: '签收后发生退款扣款',
      tone: 'error',
    },
  ];

  return (
    <>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        alignItems={{ xs: 'stretch', md: 'center' }}
        justifyContent="space-between"
        spacing={2}
        mb={3}
      >
        <Box>
          <Typography variant="h4">{pendingOnly ? '待处理单' : '售后订单'}</Typography>
          <Typography color="text.secondary" mt={0.75}>
            {pendingOnly
              ? '仅保留尚未全额退款、且未关闭、且未完成的顾客售后申请'
              : '预览退款、取消和售后处理进度'}
          </Typography>
        </Box>
        <Stack spacing={0.75} alignItems={{ xs: 'stretch', md: 'flex-end' }} className="hero-actions">
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              startIcon={<RefreshRounded />}
              onClick={refreshAfterSalesOrdersFast}
              disabled={!readableShops.length || afterSalesSync.loading || afterSalesSync.refreshing || afterSalesFastRefreshRunning}
            >
              {afterSalesBlockingLoading ? '读取中' : afterSalesBackgroundSyncing ? '同步中' : '刷新售后'}
            </Button>
          </Stack>
          <ReadProgressPanel
            visible={afterSalesProgressVisible}
            running={afterSalesProgressVisible}
            message={afterSalesProgressMessage}
            ariaLabel="售后订单读取进度"
          />
        </Stack>
      </Stack>

      {afterSalesOperationFeedback ? (
        <Alert
          severity={afterSalesOperationFeedback.severity}
          onClose={() => setAfterSalesOperationFeedback(null)}
          sx={{ mb: 2 }}
        >
          {afterSalesOperationFeedback.message}
        </Alert>
      ) : null}

      <Box className="sales-order-stat-grid after-sales-order-stat-grid">
        {stats.map((item) => (
          <Card key={item.title} className={`order-preview-card preview-${item.tone}`}>
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                {item.title}
              </Typography>
              <Typography variant="h5" mt={0.5}>
                {item.value}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {item.hint}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      <Card className="after-sales-order-filter-card">
        <CardContent>
          <Stack direction={{ xs: 'column', xl: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', xl: 'center' }}>
            <Box className="after-sales-order-filter-copy">
              <Typography variant="h6">售后状态</Typography>
              <Typography variant="body2" color="text.secondary">
                按售后节点快速查看订单
              </Typography>
            </Box>
            <Box className="after-sales-order-status-grid">
              {afterSalesOrderStatusTabs.map((tab) => {
                const count = afterSalesStatusCounts[tab.value] ?? 0;
                return (
                  <Box
                    key={tab.value}
                    component="button"
                    type="button"
                    className={`status-tab status-${tab.tone}${status === tab.value ? ' active' : ''}`}
                    onClick={() => {
                      setStatus(tab.value);
                      resetAfterSalesOrderListState();
                    }}
                  >
                    <span>{tab.label}</span>
                    <strong>{count}</strong>
                  </Box>
                );
              })}
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Box className="sales-orders-layout">
        <Card className="sales-orders-table-card">
          <CardContent>
            <Box className="sales-order-table-head after-sales-order-table-head">
              <Box className="sales-order-table-title">
                <Typography variant="h6">{pendingOnly ? '待处理售后列表' : '售后订单列表'}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {afterSalesSync.data?.fetchedAt
                    ? `已同步 ${formatOzonOrderDate(afterSalesSync.data.fetchedAt)}`
                    : '等待读取 Ozon 售后订单'}
                </Typography>
              </Box>
              <Box className="sales-order-filter-toolbar after-sales-order-filter-toolbar">
                <TextField
                  size="small"
                  className="sales-order-search-field"
                  placeholder="搜索单号 / 货号 / SKU"
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value);
                    resetAfterSalesOrderListState();
                  }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchRounded />
                      </InputAdornment>
                    ),
                  }}
                />
                <FormControl size="small" className="filter-select sales-order-filter-select">
                  <Select
                    value={shop}
                    onChange={(event) => {
                      setShop(event.target.value);
                      resetAfterSalesOrderListState();
                    }}
                  >
                    <MenuItem value="all">全部店铺</MenuItem>
                    {readableShops.map((item) => (
                      <MenuItem key={item.id} value={item.id}>
                        {getOzonShopLabel(item)}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" className="filter-select sales-order-filter-select">
                  <Select
                    value={fulfillment}
                    onChange={(event) => {
                      setFulfillment(event.target.value);
                      resetAfterSalesOrderListState();
                    }}
                  >
                    <MenuItem value="all">全部履约</MenuItem>
                    <MenuItem value="FBS">FBS</MenuItem>
                    <MenuItem value="FBO">FBO</MenuItem>
                    <MenuItem value="rFBS">rFBS</MenuItem>
                  </Select>
                </FormControl>
                <Box
                  component="button"
                  type="button"
                  className={`sales-date-range-filter sales-date-range-trigger${afterSalesStartDate || afterSalesEndDate ? ' has-value' : ''}`}
                  onClick={(event) => setAfterSalesDateAnchorEl(event.currentTarget)}
                >
                  <Typography component="span" className="sales-date-range-label">
                    售后时间
                  </Typography>
                  <Typography component="span" className="sales-date-range-value">
                    {afterSalesDateText}
                  </Typography>
                  <CalendarMonthRounded className="sales-date-icon" />
                </Box>
                <Popover
                  open={afterSalesDateOpen}
                  anchorEl={afterSalesDateAnchorEl}
                  onClose={() => setAfterSalesDateAnchorEl(null)}
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                  transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                  PaperProps={{ className: 'sales-date-popover' }}
                >
                  <Box className="sales-date-popover-content">
                    <Typography variant="body2" color="text.secondary">
                      售后时间：{afterSalesDateText}
                    </Typography>
                    <TextField
                      size="small"
                      type="date"
                      label="开始日期"
                      value={afterSalesStartDate}
                      onChange={(event) => {
                        setAfterSalesStartDate(event.target.value);
                        resetAfterSalesOrderListState();
                      }}
                      inputProps={{ onKeyDown: (event) => event.preventDefault() }}
                      InputLabelProps={{ shrink: true }}
                    />
                    <TextField
                      size="small"
                      type="date"
                      label="结束日期"
                      value={afterSalesEndDate}
                      onChange={(event) => {
                        setAfterSalesEndDate(event.target.value);
                        resetAfterSalesOrderListState();
                      }}
                      inputProps={{ onKeyDown: (event) => event.preventDefault() }}
                      InputLabelProps={{ shrink: true }}
                    />
                    <Box className="sales-date-popover-actions">
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          setAfterSalesStartDate('');
                          setAfterSalesEndDate('');
                          resetAfterSalesOrderListState();
                        }}
                      >
                        清空时间
                      </Button>
                      <Button size="small" variant="contained" onClick={() => setAfterSalesDateAnchorEl(null)}>
                        完成
                      </Button>
                    </Box>
                  </Box>
                </Popover>
              </Box>
            </Box>
            {afterSalesSync.error ? (
              <Alert severity="warning" className="order-sync-alert">
                {afterSalesSync.error}
              </Alert>
            ) : null}
            {afterSalesHasFreshRemoteResult && afterSalesSync.data?.errors?.length ? (
              <Alert severity="info" className="order-sync-alert">
                部分售后补充信息暂未返回，已展示成功读取的数据。
              </Alert>
            ) : null}
            <TableContainer className="wide-table-container">
              <Table className="data-table sales-orders-table after-sales-orders-table">
                <colgroup>
                  <col className="after-sales-order-col-image" />
                  <col className="after-sales-order-col-order" />
                  <col className="after-sales-order-col-product" />
                  <col className="after-sales-order-col-shop" />
                  <col className="after-sales-order-col-type" />
                  <col className="after-sales-order-col-amount" />
                  <col className="after-sales-order-col-status" />
                  <col className="after-sales-order-col-updated" />
                </colgroup>
                <TableHead>
                  <TableRow>
                    <TableCell align="center">产品图</TableCell>
                    <TableCell>订单信息</TableCell>
                    <TableCell>商品</TableCell>
                    <TableCell align="center">店铺</TableCell>
                    <TableCell align="center">类型</TableCell>
                    <TableCell align="center">退款金额</TableCell>
                    <TableCell align="center">状态</TableCell>
                    <TableCell align="center">更新</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visibleOrders.map((order) => {
                    const firstProduct = order.products?.[0] ?? {};
                    const offerText =
                      firstFilled(
                        firstProduct.offerId && firstProduct.offerId !== '未返回' ? firstProduct.offerId : '',
                        order.sku && order.sku !== '未返回' ? order.sku : ''
                      ) || '未返回';
                    const afterSalesDisplayId = getAfterSalesWorkbenchDisplayId(order);
                    return (
                      <TableRow
                        key={getAfterSalesOrderRecordKey(order)}
                        hover
                        className={
                          getAfterSalesOrderRecordKey(selectedOrder) === getAfterSalesOrderRecordKey(order)
                            ? 'selected-row'
                            : ''
                        }
                        onClick={() => setSelectedOrderId(getAfterSalesOrderRecordKey(order))}
                      >
                        <TableCell
                          align="center"
                          className="sales-order-image-cell"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <SalesOrderProductImagePreview order={order} />
                        </TableCell>
                        <TableCell className="sales-order-identity-cell">
                          <Typography variant="subtitle1" noWrap title={order.salesOrder || '未返回'}>
                            {order.salesOrder || '未返回'}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={`售后单: ${afterSalesDisplayId}`}
                          >
                            售后单: {afterSalesDisplayId}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={`货号: ${offerText}`}
                          >
                            货号: {offerText}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography
                            component="button"
                            type="button"
                            variant="subtitle1"
                            className="sales-order-product-title ozon-product-title-button"
                            noWrap
                            title={`${order.product}｜打开 Ozon 商品页面`}
                            onClick={(event) => {
                              event.stopPropagation();
                              openAfterSalesOzonProductPage(order, firstProduct);
                            }}
                          >
                            {order.product}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" display="block">
                            售后数量:{' '}
                            {order.products?.reduce((sum, product) => sum + (Number(product.qty) || 0), 0) || 1} 件
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={order.reason}
                          >
                            售后原因: {order.reason || '未返回'}
                          </Typography>
                        </TableCell>
                        <TableCell align="center" className="sales-order-shop-cell">
                          {order.shop}
                        </TableCell>
                        <TableCell align="center" className="after-sales-order-type-cell">
                          {order.type}
                        </TableCell>
                        <TableCell align="center" className="sales-order-amount-cell">
                          {order.refundAmount}
                        </TableCell>
                        <TableCell align="center" className="sales-order-status-cell">
                          <Chip size="small" color={order.tone} label={order.status} variant="outlined" />
                        </TableCell>
                        <TableCell align="center" className="sales-order-time-cell">
                          {order.updated}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!afterSalesBlockingLoading && filteredOrdersWithStatus.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8}>
                        <Typography variant="body2" color="text.secondary" align="center">
                          {readableShops.length
                            ? pendingOnly
                              ? '当前没有需要继续处理的 Ozon 售后订单'
                              : '暂未读取到符合条件的 Ozon 售后订单'
                            : '请先在设置里配置 Ozon 店铺'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </TableContainer>
            {filteredOrdersWithStatus.length > 0 ? (
              <Box className="sales-order-pagination">
                <Box className="sales-order-pagination-summary">
                  <Typography variant="body2" color="text.secondary">
                    共 {filteredOrdersWithStatus.length} 条
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {afterSalesRangeStart}-{afterSalesRangeEnd}
                  </Typography>
                </Box>
                <Box className="sales-order-pagination-controls">
                  <Typography variant="body2" color="text.secondary">
                    每页
                  </Typography>
                  <FormControl size="small" className="sales-order-page-size-select">
                    <Select
                      value={String(afterSalesPageSize)}
                      onChange={(event) => {
                        const nextSize = Number(event.target.value);
                        setAfterSalesPageSize(nextSize);
                        setAfterSalesPage(1);
                        const nextOrder = filteredOrdersWithStatus[0];
                        setSelectedOrderId(nextOrder ? getAfterSalesOrderRecordKey(nextOrder) : '');
                      }}
                    >
                      {SALES_ORDER_PAGE_SIZE_OPTIONS.map((size) => (
                        <MenuItem key={size} value={String(size)}>
                          {size} / 页
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Pagination
                    size="small"
                    shape="rounded"
                    page={currentAfterSalesPage}
                    count={afterSalesTotalPages}
                    siblingCount={1}
                    boundaryCount={1}
                    onChange={(_, value) => {
                      setAfterSalesPage(value);
                      const nextOrder = filteredOrdersWithStatus[(value - 1) * afterSalesPageSize];
                      setSelectedOrderId(nextOrder ? getAfterSalesOrderRecordKey(nextOrder) : '');
                    }}
                  />
                </Box>
              </Box>
            ) : null}
          </CardContent>
        </Card>

        <Box className="purchase-order-side-panel after-sales-order-side-panel" data-order-follow-panel="true">
          <OrderSideSearch
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              resetAfterSalesOrderListState();
            }}
            placeholder="搜索售后单 / 原单 / 买家 / SKU"
            className="after-sales-order-side-search"
          />
          <Card className="purchase-order-detail-card sales-order-detail-card after-sales-detail-card">
            <CardContent className="after-sales-detail-content">
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
                <Box>
                  <Typography variant="h6">订单信息</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {selectedOrder ? selectedAfterSalesDisplayId : '未选择售后订单'}
                  </Typography>
                </Box>
                {selectedOrder ? (
                  <Stack direction="row" alignItems="center" justifyContent="flex-end" spacing={1} sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      noWrap
                      title={selectedAfterSalesHandlingCountdown.label}
                      aria-label="售后处理倒计时"
                      sx={{
                        color:
                          selectedAfterSalesHandlingCountdown.tone === 'overdue' ||
                          selectedAfterSalesHandlingCountdown.tone === 'urgent'
                            ? 'error.main'
                            : selectedAfterSalesHandlingCountdown.tone === 'ready'
                              ? 'success.main'
                              : 'text.secondary',
                        fontWeight: 700,
                        textAlign: 'right',
                        minWidth: 0,
                      }}
                    >
                      {selectedAfterSalesHandlingCountdown.label}
                    </Typography>
                    <Chip size="small" color={selectedOrder.tone} label={selectedOrder.status} variant="outlined" />
                  </Stack>
                ) : null}
              </Stack>

              {selectedOrder ? (
                <>
                  <Box className="detail-info-grid after-sales-detail-info-grid">
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        原订单
                      </Typography>
                      <Typography variant="subtitle1" noWrap title={selectedOrder.salesOrder}>
                        {selectedOrder.salesOrder}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        售后单
                      </Typography>
                      <Typography variant="subtitle1" noWrap title={selectedAfterSalesDisplayId}>
                        {selectedAfterSalesDisplayId}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        店铺
                      </Typography>
                      <Typography variant="subtitle1" noWrap title={selectedOrder.shop}>
                        {selectedOrder.shop}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        物流状态
                      </Typography>
                      <Typography variant="subtitle1" noWrap title={selectedOrder.logistics}>
                        {selectedOrder.logistics}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        退款金额
                      </Typography>
                      <Typography variant="subtitle1" noWrap title={selectedOrder.refundAmount}>
                        {selectedOrder.refundAmount}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        责任方
                      </Typography>
                      <Typography variant="subtitle1" noWrap title={selectedAfterSalesResponsibilityParty}>
                        {selectedAfterSalesResponsibilityParty}
                      </Typography>
                    </Box>
                  </Box>

                  <Divider sx={{ my: 1.25 }} />

                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    className="after-sales-product-title"
                  >
                    <Typography variant="subtitle1">商品明细</Typography>
                    {selectedAfterSalesProducts.length > 1 ? (
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <IconButton
                          size="small"
                          onClick={() => setSelectedAfterSalesProductIndex((current) => Math.max(current - 1, 0))}
                          disabled={safeSelectedAfterSalesProductIndex === 0}
                        >
                          <ChevronLeftRounded fontSize="small" />
                        </IconButton>
                        <Typography variant="caption" color="text.secondary">
                          商品 {safeSelectedAfterSalesProductIndex + 1} / {selectedAfterSalesProducts.length}
                        </Typography>
                        <IconButton
                          size="small"
                          onClick={() =>
                            setSelectedAfterSalesProductIndex((current) =>
                              Math.min(current + 1, selectedAfterSalesProducts.length - 1)
                            )
                          }
                          disabled={safeSelectedAfterSalesProductIndex >= selectedAfterSalesProducts.length - 1}
                        >
                          <KeyboardArrowRightRounded fontSize="small" />
                        </IconButton>
                      </Stack>
                    ) : null}
                  </Stack>
                  <Stack spacing={1}>
                    {selectedAfterSalesProduct ? (
                      (() => {
                        const product = selectedAfterSalesProduct;
                        const imageUrl = getAfterSalesOrderCardProductImage(product);
                        const qty = getAfterSalesOrderCardProductQty(product);

                        return (
                          <Box
                            key={`${product.sku || product.offerId || 'after-sales-product'}-${safeSelectedAfterSalesProductIndex}`}
                            className="detail-product-row after-sales-product-card"
                          >
                            <Box className="detail-product-main after-sales-product-main">
                              <Box className={`after-sales-product-thumb${imageUrl ? '' : ' empty'}`}>
                                {imageUrl ? (
                                  <Box component="img" src={imageUrl} alt={product.name || '售后商品'} loading="lazy" />
                                ) : (
                                  <Inventory2Rounded fontSize="small" />
                                )}
                              </Box>
                              <Box className="after-sales-product-panel">
                                <Typography
                                  component="button"
                                  type="button"
                                  variant="subtitle1"
                                  className="detail-product-name ozon-product-title-button"
                                  noWrap
                                  title={`${product.name || selectedOrder.product || '商品'}｜打开 Ozon 商品页面`}
                                  onClick={() => openAfterSalesOzonProductPage(selectedOrder, product)}
                                >
                                  {product.name || '未返回'}
                                </Typography>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  display="block"
                                  noWrap
                                  title={product.sku || product.offerId || '未返回'}
                                >
                                  {product.sku || product.offerId || '未返回'}
                                </Typography>
                              </Box>
                            </Box>
                            <Box className="detail-product-meta">
                              <Typography variant="subtitle1" className="after-sales-product-qty">
                                x{qty}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                noWrap
                                title={product.price || '未返回'}
                              >
                                {product.price || '未返回'}
                              </Typography>
                            </Box>
                          </Box>
                        );
                      })()
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        暂无商品明细
                      </Typography>
                    )}
                  </Stack>

                  <Divider sx={{ my: 1.25 }} />

                  <Typography variant="subtitle1" mb={0.75}>
                    处理进度
                  </Typography>
                  <Box className="after-sales-progress-card">
                    <Box className="after-sales-progress-grid">
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          售后状态
                        </Typography>
                        <Typography variant="body2" title={selectedOrder.status}>
                          {selectedOrder.status}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          退款状态
                        </Typography>
                        <Typography variant="body2" title={selectedAfterSalesRefundStatus}>
                          {selectedAfterSalesRefundStatus}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          退款时间
                        </Typography>
                        <Typography variant="body2" title={selectedAfterSalesRefundTime}>
                          {selectedAfterSalesRefundTime}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          来源
                        </Typography>
                        <Typography variant="body2" title={selectedAfterSalesSourceLabel}>
                          {selectedAfterSalesSourceLabel}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          更新时间
                        </Typography>
                        <Typography variant="body2" title={selectedOrder.updated}>
                          {selectedOrder.updated}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          拍单平台
                        </Typography>
                        <Typography variant="body2" title={selectedAfterSalesPurchaseSupport.platform}>
                          {selectedAfterSalesPurchaseSupport.platform}
                        </Typography>
                      </Box>
                      <Box className="after-sales-progress-wide">
                        <Typography variant="caption" color="text.secondary">
                          采购单号
                        </Typography>
                        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                          <Typography variant="body2" title={selectedAfterSalesPurchaseSupport.orderNumber}>
                            {selectedAfterSalesPurchaseSupport.orderNumber}
                          </Typography>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => openAfterSalesPurchaseLink(
                              selectedAfterSalesPurchaseSupport.orderUrl,
                              selectedOrder,
                              selectedAfterSalesProduct || {}
                            )}
                            disabled={!selectedAfterSalesPurchaseSupport.hasOrderUrl}
                          >
                            打开采购订单
                          </Button>
                        </Stack>
                      </Box>
                    </Box>
                    <Box className="after-sales-reason-block">
                      <Typography variant="caption" color="text.secondary">
                        售后原因
                      </Typography>
                      <Typography variant="body2">{selectedOrder.reason || '未返回'}</Typography>
                    </Box>
                  </Box>

                  {detailSplitLocked ? (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                      {detailSplitLockReason}
                    </Alert>
                  ) : null}

                  <Stack direction="row" spacing={1} className="detail-actions">
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => openAfterSalesSellerDetail(
                        selectedOrder,
                        selectedAfterSalesProduct || {}
                      )}
                      disabled={!selectedAfterSalesSellerTarget.url}
                      title="在售后订单操作台中查看当前记录及关联原订单"
                    >
                      查看原单
                    </Button>
                    <Button
                      variant="contained"
                      size="small"
                      onClick={() => openAfterSalesOperationDialog(selectedOrder)}
                      disabled={detailSplitLocked || afterSalesOperationDialog.submitting}
                    >
                      查看 / 处理售后
                    </Button>
                  </Stack>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  请选择左侧售后订单查看详情。
                </Typography>
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>
      <AfterSalesOperationDialog
        afterSalesOperationDialog={afterSalesOperationDialog}
        afterSalesOperationDetail={afterSalesOperationDetail}
        afterSalesOperationForm={afterSalesOperationForm}
        setAfterSalesOperationForm={setAfterSalesOperationForm}
        selectedAfterSalesOperation={selectedAfterSalesOperation}
        selectedAfterSalesRejectionReason={selectedAfterSalesRejectionReason}
        afterSalesOperationSellerTarget={afterSalesOperationSellerTarget}
        afterSalesDisplayId={getAfterSalesWorkbenchDisplayId(afterSalesOperationDialog.order || {}) || '未返回'}
        openAfterSalesSellerDetail={openAfterSalesSellerDetail}
        closeAfterSalesOperationDialog={closeAfterSalesOperationDialog}
        submitAfterSalesOperation={submitAfterSalesOperation}
      />
      <OzonProductWorkbench controller={afterSalesOzonProductWorkbench} />
    </>
  );
}

export { AfterSalesOrdersPage };
export default AfterSalesOrdersPage;

import { useOzonRealtimeSnapshot } from '../../entities/marketing/marketingSnapshotRuntime.jsx';
import {
  attachOzonShopIdentityToRow,
  appendOzonSnapshotScopeKey,
  createOzonTimeRangeScope,
  firstFilled,
  formatOzonOrderDate,
  getOzonReadableShops,
  getOzonRowShopScopeValues,
  getOzonShopForOrder,
  getOzonShopLabel,
  getOzonShopScopeForSelection,
  getOzonSnapshotSourceKey,
  resolveOzonConfiguredShop,
} from '../../entities/order/orderShopScope.jsx';
import {
  doesSalesOrderMatchPaymentDateRange,
  normalizeSalesOrderDateFilter,
} from '../../entities/order/orderDateRules.jsx';
import { buildProfitSourceRecordsForOrder } from '../../entities/order/orderSourceLinks.jsx';
import { writeProfitLedgerLocalSnapshot } from '../../entities/profit/profitLedgerPersistence.jsx';
import {
  hasOzonOrderRowEstimatedCommission,
  hasOzonOrderRowProductImage,
  readOzonLocalProductEntityRows,
} from '../../entities/product/productLocalMirror.jsx';
import { firstFiniteNumber } from '../../entities/product/productAttributes.jsx';
import {
  doesProfitOrderMatchTab,
  getProfitDisplayMoney,
  getProfitModeLabel,
  getProfitModeSummaryValue,
  getProfitOrderActualValue,
  getProfitOrderEstimatedValue,
  getProfitOrderProfitLossInfo,
  getProfitOrderProfitLossValue,
  getProfitOrderStableRecordKey,
  getProfitResultStatusLabel,
  getProfitTabCount,
  getSignedProfitDisplay,
} from '../../entities/profit/profitFinanceEvidence.jsx';
import {
  shouldRebuildProfitLedgerForRatingPenalty,
} from '../../entities/profit/profitLedgerMapping.jsx';
import {
  applyProfitLedgerToProfitOrder,
  getProfitDetailActualFees,
  getProfitDetailEstimateSummary,
  getProfitDetailOrderInfo,
  getProfitDetailRealStatusLabel,
  getProfitLedgerEntryValue,
  getProfitLedgerRowKey,
  isFreshProfitFinanceRow,
  isProfitLedgerUsableForOrder,
} from '../../entities/profit/profitDisplayRules.jsx';
import {
  readLocalProfitFinanceContextsForShops,
  requestOzonProfitFullSnapshotForShops,
} from '../../entities/profit/profitAfterSalesRules.jsx';
import {
  applyProfitProductMaterialFallbackToOrder,
  applyProfitProductSummaryMaterialToRows,
  hasProfitOrderProductMaterialGap,
} from '../../entities/profit/profitProductMaterialFallbackRules.js';
import { buildRowsIndex, paginateRows, queryRowsIndex } from '../../services/localMirrorDataset';
import { shouldIncludeOrderInBusinessFlow } from '../../services/orderSplitRelationRules';
import {
  createProfitLedgerHash,
  createProfitLedgerSnapshotFromLedgers,
  getProfitLedgerSnapshotCacheKey,
  getProfitLedgerSnapshotCacheKeyCandidates,
  selectBestProfitLedgerRow,
} from '../../services/profitLedgerService';
import { sortProfitOrdersByPaymentDateDesc } from '../../services/profitOrderView';
import { readProfitOrderCanonicalDependencyRows } from '../../services/profitOrderDependencyRecovery.js';
import { shouldHydrateCachedProfitFinanceOrder, startProfitFinanceHydration, areProfitFinanceContextsEqual } from '../../services/profitFinanceHydrationRules.js';
import { protectProfitLedgerFinanceInputs } from '../../services/profitFinanceReadbackGuard.js';
import { prepareProfitCalculationOrder } from '../../services/profitPartialCompensation.js';
import { buildProfitPenaltyAttributionIndex } from '../../services/profitPenaltyAttribution';
import { recordRequestSuccess } from '../../services/requestCooldown';
import { safeWarn } from '../../services/safeLog';
import {
  LOCAL_OZON_DATA_LAYER_FILE_KEY,
  LOCAL_PROFIT_DATA_FILE_KEY,
  OZON_ORDER_SNAPSHOT_CACHE_TTL_MS,
  PROFIT_FINANCE_CACHE_VERSION,
  PROFIT_PAGE_INTERNAL_REFRESH_TTL_MS,
  SALES_ORDER_PAGE_SIZE_OPTIONS,
} from '../../shared/config/appConfigCore.jsx';
import { ozonSnapshotManualRefreshAt, profitFinanceCooldown } from '../../shared/config/appConfigRuntime.jsx';
import { OrderSideSearch } from '../../shared/ui/OrderSideSearch.jsx';
import { ReadProgressPanel } from '../../shared/ui/ReadProgressPanel.jsx';
import { PurchaseOrderProductImagePreview } from '../orders/purchase/ui/PurchaseOrderProductImagePreview.jsx';
import { OzonProductWorkbench } from '../orders/purchase/components/OzonProductWorkbench.jsx';
import { useOzonProductWorkbenchState } from '../orders/purchase/model/useOzonProductWorkbenchState.jsx';
import { buildProfitOzonProductWorkbenchContext } from './lib/profitOzonProductWorkbenchContext.js';
import { mergeProfitSnapshotWithSharedOrders } from './lib/profitOrderSourceMerge.js';
import { clearProfitRefreshProgress, publishProfitRefreshProgress } from './model/profitRefreshProgressRuntime.js';
import { useProfitLocalInputs } from './model/useProfitLocalInputs.js';
import { useProfitLedgerReadback } from './model/useProfitLedgerReadback.js';
import { useProfitCalculationLanes } from './model/useProfitCalculationLanes.js';
import { usesPrivateProfitExecution, runLocalProfitCalculation, runRemoteProfitCalculations } from '../../services/profitCalculationExecution.js';
import { useProfitInlineEditing } from './model/useProfitInlineEditing.js';
import { ProfitEditableMoney } from './ui/ProfitEditableMoney.jsx';
import {
  createProfitLedgerPersistenceComparableRow,
  mergeProfitProductSupplementRows,
  PROFIT_LOCAL_DEPENDENCY_TIMEOUT_MS,
  selectProfitProductSupplementBatch,
  shouldCountProfitMaterialGap,
} from './model/profitProductSupplementRules.js';
import {
  hydrateProfitSharedOrderExchangeRates,
  readProfitOrdersFromSharedCache,
} from './services/profitSharedOrderCacheService.js';
import { profitModeOptions, profitTabConfig } from '../../entities/profit/profitModeRules.jsx';
import {
  doesProfitOrderMatchKeyword,
  getProfitOrderSearchValues,
  getProfitValueClass,
} from '../../entities/profit/profitSearchRules.jsx';
import { getProfitReadMessage } from '../warehouse/warehouseRuntime.jsx';
import { getProfitOrderRecordKey } from '../../entities/profit/profitOrderRecordRules.jsx';
import { useSynchronizedOzonShopSelection } from '../../entities/order/useSynchronizedOzonShopSelection.jsx';
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
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

function shiftProfitDateKey(dateKey = '', offsetDays = 0) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + offsetDays);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function createProfitRollingSnapshotScopes(scope = null, lookbackDays = 7) {
  if (!scope?.startDateKey || !scope?.endDateKey) return [scope].filter(Boolean);
  const scopes = [scope];
  for (let day = 1; day <= lookbackDays; day += 1) {
    const startDateKey = shiftProfitDateKey(scope.startDateKey, -day);
    const endDateKey = shiftProfitDateKey(scope.endDateKey, -day);
    if (!startDateKey || !endDateKey) continue;
    scopes.push({
      ...scope,
      startDateKey,
      endDateKey,
      cachePart: `${scope.page}:range:${startDateKey}_${endDateKey}:filter:${scope.filterScope}:v:${scope.version}`,
      apiRange: {
        since: scope.apiRange?.since ? scope.apiRange.since.replace(scope.startDateKey, startDateKey) : scope.since,
        to: scope.apiRange?.to ? scope.apiRange.to.replace(scope.endDateKey, endDateKey) : scope.to,
      },
    });
  }
  return scopes;
}

function uniqueProfitSnapshotKeys(keys = []) {
  return [...new Set(keys.map((key) => String(key || '').trim()).filter(Boolean))];
}

function createProfitOrderTimeScope(startDate = '', endDate = '') {
  if (!String(startDate || '').trim() && !String(endDate || '').trim()) {
    return {
      page: 'profit-calculation',
      filterScope: 'all',
      version: 'time-v1',
      startDateKey: '',
      endDateKey: '',
      since: '',
      to: '',
      apiRange: {},
      allHistory: true,
      cachePart: 'profit-calculation:range:all-history:filter:all:v:time-v1',
    };
  }
  return {
    ...createOzonTimeRangeScope({ page: 'profit-calculation', startDate, endDate }),
    allHistory: false,
  };
}

function createEmptyProfitLocalFinanceContexts() {
  return {
    byShopId: new Map(),
    byClientId: new Map(),
    errors: [],
    matchedRowCount: 0,
  };
}

function createProfitLedgerRowsPersistSignature(rows = [], keyToken = '', getRowKey = null) {
  const rowParts = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const key = (typeof getRowKey === 'function' ? getRowKey(row) : '') || getProfitLedgerRowKey(row);
      const rowHash = createProfitLedgerHash(createProfitLedgerPersistenceComparableRow(row));
      if (!key || !rowHash) return '';
      // The formulas deliberately exclude read provenance from their hash.
      // Persist renewed empty receipts even when the numerical profit is unchanged.
      const receiptToken = row.financeEmptyReceipt ? JSON.stringify(row.financeEmptyReceipt) : '';
      return `${key}:${rowHash}:${receiptToken}`;
    })
    .filter(Boolean)
    .sort();
  return rowParts.length ? `${keyToken}:${rowParts.join('|')}` : '';
}

function createProfitProductSupplementState(scopeKey = '') {
  return {
    scopeKey,
    inFlight: false,
    attempt: 0,
    nextRetryAt: 0,
    timer: null,
  };
}

function clearProfitProductSupplementTimer(state = null) {
  if (state?.timer) clearTimeout(state.timer);
  if (state) {
    state.timer = null;
    state.nextRetryAt = 0;
  }
}

const PROFIT_PRODUCT_SUPPLEMENT_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000, 30_000, 60_000]);

function hasProfitLedgerDependencyGap(order = {}, amountKey = '') {
  return getProfitLedgerEntryValue(order?.profitLedger?.amounts?.[amountKey]) === null;
}

function getProfitFinancialDependencyGapCount(order = {}) {
  let gaps = 0;
  if (hasProfitLedgerDependencyGap(order, 'estimatedCommissionFeeCny')) gaps += 1;
  if (hasProfitLedgerDependencyGap(order, 'logisticsFeeCny')) gaps += 1;
  return gaps;
}

function getProfitProductSupplementGapCount(order = {}, options = {}) {
  const includeVisibleFields = options.includeVisibleFields !== false;
  const logisticsDependencyMissing = hasProfitLedgerDependencyGap(order, 'logisticsFeeCny');
  let gaps = 0;
  if (includeVisibleFields && !hasOzonOrderRowProductImage(order)) gaps += 1;
  if (!hasOzonOrderRowEstimatedCommission(order)) gaps += 1;
  if (shouldCountProfitMaterialGap({
    includeVisibleFields,
    logisticsDependencyMissing,
    materialGap: hasProfitOrderProductMaterialGap(order),
  })) gaps += 1;
  gaps += getProfitFinancialDependencyGapCount(order);
  return gaps;
}

function getProfitSupplementEvidenceSignature(order = {}) {
  const products = (Array.isArray(order?.products) ? order.products : []).map((product = {}) => ({
    offerId: firstFilled(product.offerId, product.offer_id, product.sellerSku, product.seller_sku),
    skuId: firstFilled(product.skuId, product.sku_id, product.raw?.sku),
    productId: firstFilled(product.productId, product.product_id, product.raw?.product_id),
    salesAmountValue: firstFiniteNumber(
      product.salesAmountValue,
      product.priceValue,
      product.price,
      product.raw?.price,
      product.raw?.price_value
    ),
    commissionPercent: firstFiniteNumber(
      product.commissionPercent,
      product.raw?.commissionPercent,
      product.raw?.commission_percent
    ),
    image: firstFilled(product.image, product.skuImage, product.primaryImage, product.mainImage, product.imageUrl),
    weight: firstFilled(product.weight, product.materialProfile?.weight),
    length: firstFilled(product.length, product.materialProfile?.length),
    width: firstFilled(product.width, product.materialProfile?.width),
    height: firstFilled(product.height, product.materialProfile?.height),
  }));
  return JSON.stringify({
    products,
    logistics: firstFilled(order.logistics, order.deliveryMethod, order.raw?.delivery_method?.tpl_provider),
    deliveryMethodId: firstFilled(order.raw?.delivery_method?.id, order.raw?.delivery_method_id),
  });
}

function getProfitProductSupplementRetryDelay(attempt = 0) {
  const index = Math.max(
    0,
    Math.min(Number(attempt) || 0, PROFIT_PRODUCT_SUPPLEMENT_RETRY_DELAYS_MS.length - 1)
  );
  return PROFIT_PRODUCT_SUPPLEMENT_RETRY_DELAYS_MS[index];
}

function ProfitCalculationPage({
  shops = [],
  activeShopId = '',
  isActive = true,
  externalRefreshTick = 0,
  localInputsRefreshTick = 0,
}) {
  const readableShops = React.useMemo(() => getOzonReadableShops(shops), [shops]);
  const readableShopsSourceKey = React.useMemo(() => getOzonSnapshotSourceKey(readableShops), [readableShops]);
  const profitSnapshotShopsRef = React.useRef({ sourceKey: '', shops: [] });
  if (profitSnapshotShopsRef.current.sourceKey !== readableShopsSourceKey) {
    profitSnapshotShopsRef.current = {
      sourceKey: readableShopsSourceKey,
      shops: readableShops,
    };
  }
  const profitSnapshotShops = profitSnapshotShopsRef.current.shops;
  const [paymentStartDate, setPaymentStartDate] = React.useState('');
  const [paymentEndDate, setPaymentEndDate] = React.useState('');
  const [paymentStartDateDraft, setPaymentStartDateDraft] = React.useState('');
  const [paymentEndDateDraft, setPaymentEndDateDraft] = React.useState('');
  const [profitDateRefreshRequest, setProfitDateRefreshRequest] = React.useState({
    revision: 0,
    shopIds: [],
  });
  const [paymentDateAnchorEl, setPaymentDateAnchorEl] = React.useState(null);
  const profitOrderTimeScope = React.useMemo(
    () => createProfitOrderTimeScope(paymentStartDate, paymentEndDate),
    [paymentEndDate, paymentStartDate]
  );
  const profitOrderSnapshotGroup = React.useMemo(
    () => `ozon-profit-orders-unified-v3:${profitOrderTimeScope.cachePart}`,
    [profitOrderTimeScope.cachePart]
  );
  const profitRollingSnapshotScopes = React.useMemo(
    () => createProfitRollingSnapshotScopes(profitOrderTimeScope, 7),
    [profitOrderTimeScope]
  );
  const profitLedgerBaseSnapshotKeys = React.useMemo(
    () => getProfitLedgerSnapshotCacheKeyCandidates(readableShops),
    [readableShops]
  );
  const profitLedgerSnapshotKeys = React.useMemo(
    () =>
      uniqueProfitSnapshotKeys(
        profitRollingSnapshotScopes.flatMap((scope) =>
          profitLedgerBaseSnapshotKeys.map((key) => appendOzonSnapshotScopeKey(key, scope))
        )
      ),
    [profitLedgerBaseSnapshotKeys, profitRollingSnapshotScopes]
  );
  const profitLedgerSnapshotKey = profitLedgerSnapshotKeys[0] || getProfitLedgerSnapshotCacheKey(readableShops);
  const profitLedgerSnapshotKeyToken = profitLedgerSnapshotKeys.join('|');
  const profitPersistenceScopeRef = React.useRef(profitLedgerSnapshotKeyToken);
  profitPersistenceScopeRef.current = profitLedgerSnapshotKeyToken;
  const profitPageManualRefreshCooldownKey = `profit-page:${profitLedgerSnapshotKey}`;
  const profitSync = useOzonRealtimeSnapshot(profitSnapshotShops, requestOzonProfitFullSnapshotForShops, {
    enabled: isActive,
    refreshOnMount: false,
    manualRefreshCooldownMs: PROFIT_PAGE_INTERNAL_REFRESH_TTL_MS,
    manualRefreshCooldownKey: profitPageManualRefreshCooldownKey,
    cacheTtlMs: OZON_ORDER_SNAPSHOT_CACHE_TTL_MS,
    cacheGroup: profitOrderSnapshotGroup,
    keepCurrentDataOnForceRefresh: true,
    invalidateOnSnapshotKeyChange: true,
    loaderOptions: {
      dateRange: profitOrderTimeScope.apiRange,
      timeScope: profitOrderTimeScope,
      localDataFileKey: LOCAL_PROFIT_DATA_FILE_KEY,
      profitExchangeRateReadMissingOnly: true,
      profitExchangeRateBatchSize: 100,
      profitExchangeRateRealtimeTtlMs: 30 * 60 * 1000,
      exchangeRateTimeoutMs: 8000,
      exchangeRateDailyConcurrency: 30,
      exchangeRateMaxLookbackDays: 3,
      progressReporter: publishProfitRefreshProgress,
    },
  });
  const profitDateScopeLoadKey = `${readableShopsSourceKey}:${profitOrderTimeScope.cachePart}`;
  const profitDateScopeLoadRef = React.useRef({ key: '', revision: 0 });
  const reloadProfitSnapshot = profitSync.reload;
  const profitSnapshotRows = React.useMemo(() => profitSync.data?.rows ?? [], [profitSync.data?.rows]);
  const [profitSharedOrderRows, setProfitSharedOrderRows] = React.useState([]);
  const profitSharedOrderLoadKey = `${readableShopsSourceKey}:${profitOrderTimeScope.cachePart}`;
  const profitSharedOrderLoadedKeyRef = React.useRef('');
  const profitSharedOrderInFlightKeyRef = React.useRef('');
  const profitSharedOrderExchangeRef = React.useRef({ key: '', promise: null, rows: null });
  React.useEffect(() => {
    if (!readableShops.length) {
      setProfitSharedOrderRows([]);
      profitSharedOrderLoadedKeyRef.current = '';
      profitSharedOrderInFlightKeyRef.current = '';
      return undefined;
    }
    if (!isActive) return undefined;
    if (
      profitSharedOrderLoadedKeyRef.current === profitSharedOrderLoadKey ||
      profitSharedOrderInFlightKeyRef.current === profitSharedOrderLoadKey
    ) return undefined;
    if (
      profitSharedOrderLoadedKeyRef.current &&
      profitSharedOrderLoadedKeyRef.current !== profitSharedOrderLoadKey
    ) setProfitSharedOrderRows([]);
    let cancelled = false;
    profitSharedOrderInFlightKeyRef.current = profitSharedOrderLoadKey;
    readProfitOrdersFromSharedCache(readableShops, profitOrderTimeScope, { deferExchangeRates: true })
      .then((snapshot) => {
        if (!cancelled) {
          setProfitSharedOrderRows(snapshot.rows);
          profitSharedOrderLoadedKeyRef.current = profitSharedOrderLoadKey;
          profitSharedOrderInFlightKeyRef.current = '';
        }
      })
      .catch((error) => {
        if (!cancelled) {
          profitSharedOrderInFlightKeyRef.current = '';
          safeWarn('利润页读取订单共享热缓存失败', error);
        }
      });
    return () => {
      cancelled = true;
      if (profitSharedOrderInFlightKeyRef.current === profitSharedOrderLoadKey) {
        profitSharedOrderInFlightKeyRef.current = '';
      }
    };
  }, [isActive, profitSharedOrderLoadKey, profitOrderTimeScope, readableShops]);
  React.useEffect(() => {
    if (!isActive || !profitSharedOrderRows.length) return undefined;
    let exchangeState = profitSharedOrderExchangeRef.current;
    if (exchangeState.key !== profitSharedOrderLoadKey) {
      exchangeState = {
        key: profitSharedOrderLoadKey,
        promise: hydrateProfitSharedOrderExchangeRates(profitSharedOrderRows),
        rows: null,
      };
      profitSharedOrderExchangeRef.current = exchangeState;
      exchangeState.promise
        .then((hydratedRows) => {
          if (profitSharedOrderExchangeRef.current === exchangeState) exchangeState.rows = hydratedRows;
        })
        .catch(() => undefined);
    }
    if (exchangeState.rows === profitSharedOrderRows) return undefined;
    if (exchangeState.rows) {
      setProfitSharedOrderRows(exchangeState.rows);
      return undefined;
    }
    let cancelled = false;
    exchangeState.promise
      ?.then((hydratedRows) => {
        if (!cancelled && profitSharedOrderExchangeRef.current === exchangeState) {
          setProfitSharedOrderRows(hydratedRows);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isActive, profitSharedOrderLoadKey, profitSharedOrderRows]);
  const rawBaseProfitRows = React.useMemo(
    () => mergeProfitSnapshotWithSharedOrders(profitSharedOrderRows, profitSnapshotRows),
    [profitSharedOrderRows, profitSnapshotRows]
  );
  const [profitImageMap, setProfitImageMap] = React.useState(() => new Map());
  const [profitProductSupplementRetryRevision, setProfitProductSupplementRetryRevision] = React.useState(0);
  const [profitFinanceRows, setProfitFinanceRows] = React.useState({});
  const [profitLocalFinanceContexts, setProfitLocalFinanceContexts] = React.useState(
    createEmptyProfitLocalFinanceContexts
  );
  const [profitLocalPenaltyDetails, setProfitLocalPenaltyDetails] = React.useState({});
  const [profitLedgerRows, setProfitLedgerRows] = React.useState({});
  const profitLedgerRowsRef = React.useRef(profitLedgerRows);
  profitLedgerRowsRef.current = profitLedgerRows;
  const { inputs: profitLocalInputs, setInputs: setProfitLocalInputs, error: profitLocalInputsError, retry: retryProfitLocalInputs } = useProfitLocalInputs({
    isActive, readableShops, sourceKey: readableShopsSourceKey, refreshTick: localInputsRefreshTick,
  });
  const [profitLedgerCacheInfo, setProfitLedgerCacheInfo] = React.useState({
    status: 'idle',
    rowCount: 0,
    updatedAt: '',
  });
  const [profitFinanceErrors, setProfitFinanceErrors] = React.useState([]);
  const [profitPageRefreshing, setProfitPageRefreshing] = React.useState(false);
  const [profitInlineEditor, setProfitInlineEditor] = React.useState(null);
  const profitLocalFinanceHydrationRef = React.useRef('');
  const profitLocalFinanceReadbackRef = React.useRef({ key: '', contexts: null });
  const profitOzonProductWorkbench = useOzonProductWorkbenchState();
  const openProfitOzonProductPage = React.useCallback((order, product = {}) => (
    profitOzonProductWorkbench.openOzonProduct(buildProfitOzonProductWorkbenchContext({
      order,
      product,
      profitLocalInputs,
      readableShops,
    }))
  ), [profitLocalInputs, profitOzonProductWorkbench, readableShops]);
  const externalRefreshTickRef = React.useRef(externalRefreshTick);
  const baseProfitRows = React.useMemo(() => {
    const map = new Map();
    rawBaseProfitRows.forEach((order) => {
      const key = getProfitOrderRecordKey(order);
      if (key) {
        const orderLedger = isProfitLedgerUsableForOrder(order, order.profitLedger) ? order.profitLedger : null;
        map.set(key, {
          ...order,
          profitLedger: selectBestProfitLedgerRow([orderLedger]) ?? order.profitLedger,
        });
      }
    });
    return Array.from(map.values());
  }, [rawBaseProfitRows]);
  const cachedOnlyProfitFinanceRows = React.useMemo(() => {
    return baseProfitRows.filter((order) => shouldHydrateCachedProfitFinanceOrder(order, { revalidateConfirmed: true }));
  }, [baseProfitRows]);
  const cachedOnlyProfitFinanceSignature = React.useMemo(
    () =>
      cachedOnlyProfitFinanceRows
        .map((order) => getProfitOrderRecordKey(order))
        .filter(Boolean)
        .sort()
        .join('|'),
    [cachedOnlyProfitFinanceRows]
  );
  React.useEffect(() => {
    if (!isActive || !readableShops.length) return undefined;
    if (!cachedOnlyProfitFinanceRows.length) {
      profitLocalFinanceHydrationRef.current = '';
      profitLocalFinanceReadbackRef.current = { key: '', contexts: null };
      setProfitLocalFinanceContexts((current) => current.byShopId.size || current.byClientId.size
        ? createEmptyProfitLocalFinanceContexts() : current);
      return undefined;
    }
    const hydrationKey = [
      readableShopsSourceKey,
      profitOrderTimeScope.cachePart,
      profitSync.data?.fetchedAt || '',
      cachedOnlyProfitFinanceSignature,
    ].join(':');
    if (profitLocalFinanceHydrationRef.current === hydrationKey) return undefined;
    return startProfitFinanceHydration({
      initialContexts: profitLocalFinanceReadbackRef.current.key === hydrationKey
        ? profitLocalFinanceReadbackRef.current.contexts : null,
      read: (readOptions) => readLocalProfitFinanceContextsForShops(readableShops, baseProfitRows, {
        ...readOptions,
        lookupRows: cachedOnlyProfitFinanceRows,
        getCachedLedgerRows: () => profitLedgerRowsRef.current,
        localFinanceTimeoutMs: 10000,
        verifyEmptyFinance: true,
      }),
      onValue(contexts) {
        profitLocalFinanceReadbackRef.current = { key: hydrationKey, contexts };
        profitLocalFinanceHydrationRef.current = contexts.partial || contexts.errors.length ? '' : hydrationKey;
        setProfitLocalFinanceContexts(current => areProfitFinanceContextsEqual(current, contexts) ? current : contexts);
      },
      onError(error) {
        profitLocalFinanceHydrationRef.current = '';
        safeWarn('利润页历史缓存订单本地财务补齐失败', error);
      },
    });
  }, [
    baseProfitRows,
    cachedOnlyProfitFinanceRows,
    cachedOnlyProfitFinanceSignature,
    isActive,
    profitOrderTimeScope.cachePart,
    profitSync.data?.fetchedAt,
    readableShops,
    readableShopsSourceKey,
  ]);
  const localProfitRatingPenaltyIndex = React.useMemo(
    () => buildProfitPenaltyAttributionIndex(baseProfitRows, profitLocalPenaltyDetails),
    [baseProfitRows, profitLocalPenaltyDetails]
  );
  const mergedProfitRatingPenaltyIndex = localProfitRatingPenaltyIndex;
  const createProfitRowCalculation = React.useCallback(
    function* (order) {
            const key = getProfitOrderRecordKey(order);
            const imageOrder = key ? profitImageMap.get(key) : null;
            const financeOrder = key && isFreshProfitFinanceRow(profitFinanceRows[key]) ? profitFinanceRows[key] : null;
            const ledgerRow = key ? profitLedgerRows[key] : null;
            const imageProducts = imageOrder?.products ?? null;
            const mergedOrder = imageOrder
              ? { ...order, ...imageOrder, products: imageProducts ?? order.products }
              : order;
            const mergedWithFinance = financeOrder
              ? {
                  ...mergedOrder,
                  ...financeOrder,
                  products: imageProducts ?? financeOrder.products ?? mergedOrder.products,
                }
              : mergedOrder;
            const identityReadyOrder = attachOzonShopIdentityToRow(mergedWithFinance, readableShops);
            const materialReadyOrder = applyProfitProductMaterialFallbackToOrder(identityReadyOrder);
            const ledgerCandidates = [financeOrder?.profitLedger, ledgerRow, mergedWithFinance.profitLedger].filter(
              (row) => {
                if (!isProfitLedgerUsableForOrder(materialReadyOrder, row)) return false;
                return !shouldRebuildProfitLedgerForRatingPenalty(
                  materialReadyOrder,
                  row,
                  mergedProfitRatingPenaltyIndex
                );
              }
            );
            const selectedLedger = selectBestProfitLedgerRow(ledgerCandidates);
            const financeBaselineLedger = selectedLedger ?? selectBestProfitLedgerRow(
              [financeOrder?.profitLedger, ledgerRow, mergedWithFinance.profitLedger]
                .filter((row) => isProfitLedgerUsableForOrder(materialReadyOrder, row))
            );
            const calculationOrder = prepareProfitCalculationOrder(materialReadyOrder, financeBaselineLedger);
            const rowShop = getOzonShopForOrder(calculationOrder, readableShops);
            const localFinanceContext =
              profitLocalFinanceContexts.byShopId.get(materialReadyOrder.shopId) ??
              profitLocalFinanceContexts.byClientId.get(materialReadyOrder.shopClientId) ??
              null;
            const hasLocalFinanceMatch = Boolean(localFinanceContext?.matchedOrderKeys?.has(key));
            const verifiedEmptyReceipt = localFinanceContext?.emptyFinanceReceipts?.get(key);
            const localExchangeRates = hasLocalFinanceMatch
              ? localFinanceContext?.exchangeRatesByOrderKey?.get(key) ?? null
              : null;
            const profitRowContext = {
              ...(hasLocalFinanceMatch
                ? {
                    financeIndex: localFinanceContext.financeIndex,
                    financeLookupCheckedIndex: localFinanceContext.financeLookupCheckedIndex,
                    financeParentFallbackIndex: localFinanceContext.financeParentFallbackIndex,
                    ...(localExchangeRates
                      ? {
                          estimatedExchangeRate: localExchangeRates.estimated,
                          actualExchangeRate: localExchangeRates.actual,
                          exchangeRates: localExchangeRates,
                        }
                      : {}),
                  }
                : {}),
              ratingPenaltyIndex: mergedProfitRatingPenaltyIndex,
              purchaseLocalOverrides: profitLocalInputs.purchaseLocalOverrides,
              sourceRecords: buildProfitSourceRecordsForOrder(calculationOrder, {
                purchaseLocalOverrides: profitLocalInputs.purchaseLocalOverrides,
                productSourceLinks: profitLocalInputs.productSourceLinks,
                shop: rowShop,
              }),
              shop: rowShop,
              profitFinanceVersion: hasLocalFinanceMatch
                ? PROFIT_FINANCE_CACHE_VERSION
                : selectedLedger?.profitFinanceVersion || materialReadyOrder.profitFinanceVersion || '',
              fetchedAt: materialReadyOrder.fetchedAt || materialReadyOrder.updatedAt || 'profit-ledger-row',
            };
            const normalizedOrder = yield { operation: 'normalize', input: { order: calculationOrder, context: profitRowContext } };
            const protectedFreshLedger = protectProfitLedgerFinanceInputs(financeBaselineLedger, normalizedOrder.profitLedger, {
              financeReadbackComplete: hasLocalFinanceMatch,
              verifiedEmptyReceipt,
            });
            const mergedLedger = financeBaselineLedger
              ? yield { operation: 'merge-ledger', input: { order: calculationOrder, cachedLedger: financeBaselineLedger, ledger: protectedFreshLedger } }
              : protectedFreshLedger;
            const existingLedger = yield { operation: 'rebuild-final', input: { order: calculationOrder, ledger: mergedLedger || selectedLedger } };
            const profitLedger =
              existingLedger ??
              normalizedOrder.profitLedger ??
              (yield { operation: 'ledger', input: { order: normalizedOrder, context: {
                orderKey: key || getProfitOrderStableRecordKey(materialReadyOrder),
                purchaseOverrides: profitLocalInputs.purchaseLocalOverrides,
                sourceRecords: profitRowContext.sourceRecords,
                fetchedAt: materialReadyOrder.fetchedAt || materialReadyOrder.updatedAt || 'pending',
              } } });
            if (profitLedger && protectedFreshLedger?.financeReadbackState) {
              profitLedger.financeReadbackState = protectedFreshLedger.financeReadbackState;
              profitLedger.financeEmptyReceipt = protectedFreshLedger.financeEmptyReceipt ?? null;
            }
            const calculatedOrder = applyProfitLedgerToProfitOrder(normalizedOrder, profitLedger);
            return shouldIncludeOrderInBusinessFlow(calculatedOrder) ? calculatedOrder : null;
        },
    [
      mergedProfitRatingPenaltyIndex,
      profitFinanceRows,
      profitImageMap,
      profitLedgerRows,
      profitLocalFinanceContexts,
      profitLocalInputs,
      readableShops,
    ]
  );
  const calculateProfitRow = React.useCallback(order => runLocalProfitCalculation(createProfitRowCalculation(order)), [createProfitRowCalculation]);
  const calculateProfitBatch = React.useCallback((orders, options) => runRemoteProfitCalculations(orders.map(createProfitRowCalculation), options), [createProfitRowCalculation]);
  const { rows: profitRows, errors: profitCalculationErrors, retry: retryProfitCalculation } = useProfitCalculationLanes({
    isActive, baseProfitRows, calculateProfitRow, readableShops, profitLocalFinanceContexts,
    calculateProfitBatch: usesPrivateProfitExecution ? calculateProfitBatch : undefined,
    profitImageMap, profitFinanceRows, profitLedgerRows, profitLocalInputs,
    ratingPenaltyIndex: mergedProfitRatingPenaltyIndex,
  });
  const [activeTab, setActiveTab] = React.useState('all');
  const [profitMode, setProfitMode] = React.useState('mixed');
  const [keyword, setKeyword] = React.useState('');
  const [fulfillment, setFulfillment] = React.useState('all');
  const [profitOrderPageSize, setProfitOrderPageSize] = React.useState(20);
  const [profitOrderPage, setProfitOrderPage] = React.useState(1);
  const [selectedOrderId, setSelectedOrderId] = React.useState('');
  const [shop, setShop] = useSynchronizedOzonShopSelection({
    shops: readableShops,
    activeShopId,
    onScopeChange: () => {
      setProfitOrderPage(1);
      setSelectedOrderId('');
      setProfitInlineEditor(null);
      setProfitFinanceRows({});
      setProfitLocalFinanceContexts(createEmptyProfitLocalFinanceContexts());
      profitLocalFinanceHydrationRef.current = '';
      setProfitFinanceErrors([]);
      setProfitImageMap(new Map());
      profitPageRefreshRequestRef.current += 1;
    },
  });
  const queueProfitDateRefresh = React.useCallback(() => {
    const selectedShop = resolveOzonConfiguredShop(readableShops, shop);
    const shopIds = selectedShop
      ? [String(selectedShop.id || '').trim()].filter(Boolean)
      : readableShops.map((item) => String(item?.id || '').trim()).filter(Boolean);
    setProfitDateRefreshRequest((current) => ({
      revision: current.revision + 1,
      shopIds,
    }));
  }, [readableShops, shop]);
  React.useEffect(() => {
    if (!readableShops.length) {
      profitDateScopeLoadRef.current = { key: '', revision: profitDateRefreshRequest.revision };
      return undefined;
    }
    if (!isActive) return undefined;
    const previous = profitDateScopeLoadRef.current;
    const explicitDateRefresh = profitDateRefreshRequest.revision > previous.revision;
    if (previous.key === profitDateScopeLoadKey && !explicitDateRefresh) return undefined;
    profitDateScopeLoadRef.current = {
      key: profitDateScopeLoadKey,
      revision: profitDateRefreshRequest.revision,
    };

    let cancelled = false;
    const loadDateScope = async () => {
      if (!explicitDateRefresh) {
        await reloadProfitSnapshot({ silent: true });
        return;
      }

      // Phase 1: bypass the old 90-day snapshot immediately and reread the
      // selected range from SQLite. This makes historical rows visible before
      // the slower Ozon synchronization completes.
      await reloadProfitSnapshot({
        silent: true,
        force: true,
        loaderForceRefresh: false,
        loaderOptions: {
          autoSync: false,
          forceFinanceRefresh: false,
          forceAfterSalesRefresh: false,
          startBackgroundFinanceSync: false,
        },
      });
      if (cancelled) return;

      // Phase 2: only the currently selected shop(s) perform a real historical
      // order sync. Finance/after-sales stay local here so changing a date
      // cannot start unrelated calculations or congest every shop channel.
      await reloadProfitSnapshot({
        silent: true,
        force: true,
        loaderForceRefresh: true,
        loaderOptions: {
          forceOrderRefreshShopIds: profitDateRefreshRequest.shopIds,
          forceFinanceRefresh: false,
          forceAfterSalesRefresh: false,
          startBackgroundFinanceSync: false,
          syncMaxPages: 100,
        },
      });
    };
    loadDateScope().catch((error) => {
      if (!cancelled) safeWarn('利润页日期范围订单刷新失败', error);
    });
    return () => {
      cancelled = true;
    };
  }, [
    isActive,
    profitDateRefreshRequest,
    profitDateScopeLoadKey,
    readableShops.length,
    reloadProfitSnapshot,
  ]);
  const paymentStartKey = normalizeSalesOrderDateFilter(paymentStartDate);
  const paymentEndKey = normalizeSalesOrderDateFilter(paymentEndDate);
  const paymentDateOpen = Boolean(paymentDateAnchorEl);
  const paymentDateText =
    paymentStartDate || paymentEndDate
      ? `${paymentStartDate || '开始日期'} - ${paymentEndDate || '结束日期'}`
      : '开始日期 - 结束日期';
  const profitLedgerCacheHint =
    profitLedgerCacheInfo.status === 'loading'
      ? '利润缓存读取中'
      : profitLedgerCacheInfo.partial
        ? `利润缓存未完整读取，已确认 ${profitLedgerCacheInfo.rowCount} 条；失败店铺保留旧数据`
      : profitLedgerCacheInfo.status === 'hit'
        ? `利润证据缓存 ${profitLedgerCacheInfo.rowCount} 条 · 当前订单 ${rawBaseProfitRows.length} 条${
            profitLedgerCacheInfo.updatedAt ? ` · ${formatOzonOrderDate(profitLedgerCacheInfo.updatedAt)}` : ''
          }`
        : profitLedgerCacheInfo.status === 'updated'
          ? `利润证据已更新 ${profitLedgerCacheInfo.rowCount} 条 · 当前订单 ${rawBaseProfitRows.length} 条`
          : profitLedgerCacheInfo.status === 'error'
            ? '利润缓存读取失败'
            : rawBaseProfitRows.length
              ? `本地镜像已读取 ${rawBaseProfitRows.length} 条`
              : '暂无利润缓存';

  const profitRowsIndex = React.useMemo(
    () =>
      buildRowsIndex(profitRows, {
        getRowKey: (order) =>
          `${firstFilled(order.shopClientId, order.clientId, order.shopId, order.shopName, order.shop)}:${getProfitOrderRecordKey(order)}`,
        getRowShop: getOzonRowShopScopeValues,
        getRowStatuses: (order) => [order.fulfillment],
        getSearchValues: (order) => getProfitOrderSearchValues(order),
      }),
    [profitRows]
  );
  const selectedProfitShopScope = React.useMemo(
    () => getOzonShopScopeForSelection(readableShops, shop),
    [readableShops, shop]
  );
  const profitIndexedRows = React.useMemo(
    () =>
      queryRowsIndex(profitRowsIndex, {
        shopScope: selectedProfitShopScope,
        statusValue: fulfillment,
        allStatusValue: 'all',
        keyword,
      }),
    [fulfillment, keyword, profitRowsIndex, selectedProfitShopScope]
  );
  const profitFilterScopeRows = React.useMemo(
    () =>
      profitIndexedRows.filter((order) => {
        const matchKeyword = doesProfitOrderMatchKeyword(order, keyword);
        const matchPaymentDate = doesSalesOrderMatchPaymentDateRange(order, paymentStartKey, paymentEndKey);
        return matchKeyword && matchPaymentDate;
      }),
    [keyword, paymentEndKey, paymentStartKey, profitIndexedRows]
  );
  const filteredOrders = React.useMemo(
    () =>
      sortProfitOrdersByPaymentDateDesc(
        profitFilterScopeRows.filter((order) => doesProfitOrderMatchTab(order, activeTab, profitMode))
      ),
    [activeTab, profitFilterScopeRows, profitMode]
  );

  const profitOrderPagination = React.useMemo(
    () => paginateRows(filteredOrders, profitOrderPage, profitOrderPageSize),
    [filteredOrders, profitOrderPage, profitOrderPageSize]
  );
  const profitOrderTotalPages = profitOrderPagination.totalPages;
  const currentProfitOrderPage = profitOrderPagination.currentPage;
  const visibleOrders = profitOrderPagination.rows;
  const profitOrderRangeStart = profitOrderPagination.rangeStart;
  const profitOrderRangeEnd = profitOrderPagination.rangeEnd;
  const visibleProfitOrderKey = React.useMemo(
    () =>
      visibleOrders
        .map((order) => getProfitOrderRecordKey(order))
        .filter(Boolean)
        .join('|'),
    [visibleOrders]
  );
  const profitVisibleImageScopeKey = React.useMemo(
    () => `${readableShopsSourceKey}:${profitOrderTimeScope.cachePart}:${visibleProfitOrderKey}`,
    [profitOrderTimeScope.cachePart, readableShopsSourceKey, visibleProfitOrderKey]
  );
  const profitFinancialDependencyKey = React.useMemo(
    () =>
      profitRows
        .filter((order) => getProfitFinancialDependencyGapCount(order) > 0)
        .map((order) => getProfitOrderRecordKey(order))
        .filter(Boolean)
        .sort()
        .join('|'),
    [profitRows]
  );
  const profitProductSupplementScopeKey = React.useMemo(
    () => `${profitVisibleImageScopeKey}:dependencies:${profitFinancialDependencyKey}`,
    [profitFinancialDependencyKey, profitVisibleImageScopeKey]
  );
  const profitVisibleProductAttemptKey = `${profitProductSupplementScopeKey}:${profitProductSupplementRetryRevision}`;
  const profitAllOrderRefreshScopeKey = React.useMemo(
    () => `${readableShopsSourceKey}:${profitOrderTimeScope.cachePart}:all-orders`,
    [profitOrderTimeScope.cachePart, readableShopsSourceKey]
  );
  const profitAllOrderRefreshScopeRef = React.useRef(profitAllOrderRefreshScopeKey);
  const profitPageRefreshRequestRef = React.useRef(0);
  const profitLocalProductSupplementRef = React.useRef(createProfitProductSupplementState());
  const profitLedgerPersistSignatureRef = React.useRef('');

  if (profitAllOrderRefreshScopeRef.current !== profitAllOrderRefreshScopeKey) {
    profitAllOrderRefreshScopeRef.current = profitAllOrderRefreshScopeKey;
    profitPageRefreshRequestRef.current += 1;
  }

  React.useEffect(() => {
    setProfitPageRefreshing(false);
  }, [profitAllOrderRefreshScopeKey]);


  const profitRowsLedgerSignature = React.useMemo(
    () =>
      createProfitLedgerRowsPersistSignature(
        profitRows.map((order) => order?.profitLedger).filter(Boolean),
        profitLedgerSnapshotKeyToken,
        (ledger) => ledger?.orderKey || getProfitLedgerRowKey(ledger)
      ),
    [profitLedgerSnapshotKeyToken, profitRows]
  );

  const selectedOrder =
    visibleOrders.find((order) => getProfitOrderRecordKey(order) === selectedOrderId) ??
    visibleOrders[0] ??
    filteredOrders[0] ??
    null;
  const selectedOrderProfitContext = React.useMemo(() => {
    if (!selectedOrder) {
      return {
        purchaseLocalOverrides: profitLocalInputs.purchaseLocalOverrides,
        sourceRecords: [],
        shop: null,
      };
    }
    const rowShop = getOzonShopForOrder(selectedOrder, readableShops);
    return {
      purchaseLocalOverrides: profitLocalInputs.purchaseLocalOverrides,
      sourceRecords: buildProfitSourceRecordsForOrder(selectedOrder, {
        purchaseLocalOverrides: profitLocalInputs.purchaseLocalOverrides,
        productSourceLinks: profitLocalInputs.productSourceLinks,
        shop: rowShop,
      }),
      shop: rowShop,
    };
  }, [profitLocalInputs, readableShops, selectedOrder]);

  React.useEffect(() => {
    setProfitOrderPage((current) => Math.min(current, profitOrderTotalPages));
  }, [profitOrderTotalPages]);

  React.useEffect(() => {
    if (!filteredOrders.length) {
      if (selectedOrderId) setSelectedOrderId('');
      return;
    }
    if (!filteredOrders.some((order) => getProfitOrderRecordKey(order) === selectedOrderId)) {
      setSelectedOrderId(getProfitOrderRecordKey(filteredOrders[0]));
    }
  }, [filteredOrders, selectedOrderId]);

  React.useEffect(() => {
    setProfitFinanceRows({});
    setProfitLocalFinanceContexts(createEmptyProfitLocalFinanceContexts());
    profitLocalFinanceHydrationRef.current = '';
    setProfitFinanceErrors([]);
    setProfitImageMap(new Map());
    clearProfitProductSupplementTimer(profitLocalProductSupplementRef.current);
    profitLocalProductSupplementRef.current = createProfitProductSupplementState();
  }, [profitOrderSnapshotGroup, readableShopsSourceKey]);

  React.useEffect(
    () => () => {
      clearProfitProductSupplementTimer(profitLocalProductSupplementRef.current);
    },
    []
  );

  React.useEffect(() => {
    const hasStaleRows = Object.values(profitFinanceRows).some((row) => row && !isFreshProfitFinanceRow(row));
    if (!hasStaleRows) return;
    setProfitFinanceRows({});
  }, [profitFinanceRows]);

  React.useEffect(() => {
    if (!isActive || !readableShops.length || (!visibleOrders.length && !profitFinancialDependencyKey)) return undefined;

    if (profitLocalProductSupplementRef.current.scopeKey !== profitProductSupplementScopeKey) {
      clearProfitProductSupplementTimer(profitLocalProductSupplementRef.current);
      profitLocalProductSupplementRef.current = createProfitProductSupplementState(profitProductSupplementScopeKey);
    }
    const supplementState = profitLocalProductSupplementRef.current;

    const supplementBatch = selectProfitProductSupplementBatch({
      visibleOrders,
      profitRows,
      enhancedRowsByKey: profitImageMap,
      getRecordKey: getProfitOrderRecordKey,
      getGapCount: getProfitProductSupplementGapCount,
    });
    const { rows: rowsToEnhance, visibleOrderKeys, deferredCount } = supplementBatch;

    if (!rowsToEnhance.length) {
      clearProfitProductSupplementTimer(supplementState);
      supplementState.attempt = 0;
      return undefined;
    }
    if (supplementState.inFlight || supplementState.timer) return undefined;

    const now = Date.now();
    if (supplementState.nextRetryAt > now) {
      const remainingMs = Math.max(1, supplementState.nextRetryAt - now);
      supplementState.timer = setTimeout(() => {
        const current = profitLocalProductSupplementRef.current;
        if (current.scopeKey !== profitProductSupplementScopeKey) return;
        current.timer = null;
        current.nextRetryAt = 0;
        setProfitProductSupplementRetryRevision((revision) => revision + 1);
      }, remainingMs);
      return undefined;
    }

    let cancelled = false;
    supplementState.inFlight = true;
    const rowsBeforeRead = new Map(
      rowsToEnhance.map((order) => {
        const key = getProfitOrderRecordKey(order);
        return [key, profitImageMap.get(key) || order];
      })
    );
    const queueRetry = () => {
      const current = profitLocalProductSupplementRef.current;
      if (cancelled || current.scopeKey !== profitProductSupplementScopeKey || current.timer) return;
      const delayMs = getProfitProductSupplementRetryDelay(current.attempt);
      current.attempt += 1;
      current.nextRetryAt = Date.now() + delayMs;
      current.timer = setTimeout(() => {
        const latest = profitLocalProductSupplementRef.current;
        if (latest.scopeKey !== profitProductSupplementScopeKey) return;
        latest.timer = null;
        latest.nextRetryAt = 0;
        setProfitProductSupplementRetryRevision((revision) => revision + 1);
      }, delayMs);
    };

    (async () => {
      const canonicalResult = await readProfitOrderCanonicalDependencyRows(rowsToEnhance, readableShops, {
        timeoutMs: PROFIT_LOCAL_DEPENDENCY_TIMEOUT_MS,
      });
      if (cancelled) return;
      const canonicalRows = Array.isArray(canonicalResult.rows) ? canonicalResult.rows : rowsToEnhance;
      const localResult = await readOzonLocalProductEntityRows(
        LOCAL_OZON_DATA_LAYER_FILE_KEY,
        canonicalRows,
        readableShops,
        getProfitOrderRecordKey,
        {
          timeoutMs: PROFIT_LOCAL_DEPENDENCY_TIMEOUT_MS,
          enableSkuFallback: true,
          requireImages: true,
          requestedBy: 'profit-page-local-supplement',
          commissionRateMode: 'rFBS',
        }
      );
      if (cancelled) return;
      const usefulRowsByKey = new Map();
      const localRows = Array.isArray(localResult.rows) ? localResult.rows : [];
      const rowsWithMaterial = localResult.entityMap?.size
        ? applyProfitProductSummaryMaterialToRows(localRows, localResult.entityMap, getProfitOrderRecordKey)
        : localRows;
      rowsWithMaterial
        .map(applyProfitProductMaterialFallbackToOrder)
        .forEach((row) => {
          const key = getProfitOrderRecordKey(row);
          if (!key) return;
          const before = usefulRowsByKey.get(key) || rowsBeforeRead.get(key) || {};
          const merged = mergeProfitProductSupplementRows(before, row);
          const gapOptions = { includeVisibleFields: visibleOrderKeys.has(key) };
          const gapReduced =
            getProfitProductSupplementGapCount(merged, gapOptions) <
            getProfitProductSupplementGapCount(before, gapOptions);
          const canonicalEvidenceChanged =
            canonicalResult.matchedKeys?.has(key) &&
            getProfitSupplementEvidenceSignature(merged) !== getProfitSupplementEvidenceSignature(before);
          if (!gapReduced && !canonicalEvidenceChanged) return;
          usefulRowsByKey.set(key, merged);
        });

      const stillMissingDependency = rowsToEnhance.some((order) => {
        const key = getProfitOrderRecordKey(order);
        return getProfitProductSupplementGapCount(
          usefulRowsByKey.get(key) || rowsBeforeRead.get(key) || order,
          { includeVisibleFields: visibleOrderKeys.has(key) }
        ) > 0;
      });
      if (usefulRowsByKey.size) {
        setProfitImageMap((current) => {
          const next = new Map(current);
          usefulRowsByKey.forEach((row, key) => {
            next.set(key, row);
          });
          return next;
        });
      }
      if (stillMissingDependency || (!usefulRowsByKey.size && deferredCount > 0)) queueRetry();
      else {
        clearProfitProductSupplementTimer(supplementState);
        supplementState.attempt = 0;
      }
    })().catch((error) => {
      if (!cancelled) {
        safeWarn('利润页本地商品镜像补图/补佣金/补材积失败', error);
        queueRetry();
      }
    }).finally(() => {
      if (profitLocalProductSupplementRef.current.scopeKey === profitProductSupplementScopeKey) {
        profitLocalProductSupplementRef.current.inFlight = false;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    isActive,
    profitImageMap,
    profitFinancialDependencyKey,
    profitProductSupplementScopeKey,
    profitRows,
    profitVisibleProductAttemptKey,
    readableShops,
    visibleOrders,
  ]);

  const persistProfitLedgerOrders = React.useCallback(
    (orders = [], errors = []) => {
      const ledgerRows = (Array.isArray(orders) ? orders : []).map((order) => order?.profitLedger).filter(Boolean);
      if (!ledgerRows.length && !errors.length) return Promise.resolve(null);
      const snapshot = createProfitLedgerSnapshotFromLedgers(ledgerRows, {
        sourceKey: profitLedgerSnapshotKey,
        errors,
        fetchedAt: new Date().toISOString(),
      });
      return writeProfitLedgerLocalSnapshot(LOCAL_PROFIT_DATA_FILE_KEY, profitLedgerSnapshotKeys, snapshot).then(
        (result) => {
          if (profitPersistenceScopeRef.current !== profitLedgerSnapshotKeyToken) return result;
          const rows = result?.snapshot?.rows ?? [];
          if (rows.length) {
            const nextPenaltyDetails =
              result?.snapshot?.profitPenaltyDetails ?? result?.snapshot?.penaltyDetails ?? {};
            setProfitLocalPenaltyDetails((current) => {
              const next = result.stats?.partialOwnerUpdate ? {
                ...Object.fromEntries(Object.entries(current).filter(([, record]) => !result.stats.updatedShopIds.includes(record?.shopId))),
                ...nextPenaltyDetails,
              } : nextPenaltyDetails;
              return createProfitLedgerHash({ penaltyDetails: current }) === createProfitLedgerHash({ penaltyDetails: next }) ? current : next;
            });
            setProfitLedgerCacheInfo((current) => ({
              ...current,
              status: current.partial ? current.status : 'updated',
              rowCount: current.partial ? current.rowCount : result.stats?.partialOwnerUpdate ? current.rowCount || rows.length : rows.length,
              updatedAt: result.snapshot.updatedAt || result.snapshot.fetchedAt || new Date().toISOString(),
            }));
          }
          return result;
        }
      );
    },
    [profitLedgerSnapshotKey, profitLedgerSnapshotKeys, profitLedgerSnapshotKeyToken]
  );

  const retryProfitLedgerReadback = useProfitLedgerReadback({
    isActive, hasShops: readableShops.length > 0, sourceKey: readableShopsSourceKey,
    fileKey: LOCAL_PROFIT_DATA_FILE_KEY, snapshotKeys: profitLedgerSnapshotKeys,
    snapshotKeyToken: profitLedgerSnapshotKeyToken, setRows: setProfitLedgerRows,
    setPenaltyDetails: setProfitLocalPenaltyDetails, setCacheInfo: setProfitLedgerCacheInfo,
    persistSignatureRef: profitLedgerPersistSignatureRef, createPersistSignature: createProfitLedgerRowsPersistSignature,
  });

  React.useEffect(() => {
    if (!isActive || !profitRows.length || !profitRowsLedgerSignature) return;
    if (profitLedgerPersistSignatureRef.current === profitRowsLedgerSignature) return;
    profitLedgerPersistSignatureRef.current = profitRowsLedgerSignature;
    persistProfitLedgerOrders(profitRows, profitSync.data?.errors ?? []).catch((error) => {
      safeWarn('利润账本 SQLite 快照写入失败', error);
      if (profitLedgerPersistSignatureRef.current === profitRowsLedgerSignature) {
        profitLedgerPersistSignatureRef.current = '';
      }
    });
  }, [
    isActive,
    persistProfitLedgerOrders,
    profitRows,
    profitRowsLedgerSignature,
    profitSync.data?.errors,
  ]);

  const shopOptions = readableShops.map((item) => ({
    value: String(item.id || '').trim(),
    label: getOzonShopLabel(item),
  })).filter((item) => item.value);
  const fulfillments = React.useMemo(
    () => Array.from(new Set(profitRows.map((order) => order.fulfillment).filter(Boolean))),
    [profitRows]
  );
  const { profitSummaryCards, profitTabs } = React.useMemo(() => {
    const summaryCurrency =
      profitFilterScopeRows.find((order) => order.currencyCode)?.currencyCode ||
      profitRows.find((order) => order.currencyCode)?.currencyCode ||
      'CNY';
    const estimatedProfitValues = profitFilterScopeRows
      .map(getProfitOrderEstimatedValue)
      .filter((value) => value !== null);
    const actualProfitValues = profitFilterScopeRows
      .map(getProfitOrderActualValue)
      .filter((value) => value !== null);
    const knownProfitValues = profitFilterScopeRows
      .map(getProfitOrderProfitLossValue)
      .filter((value) => value !== null);
    const estimatedProfitSum = estimatedProfitValues.length
      ? estimatedProfitValues.reduce((sum, value) => sum + value, 0)
      : null;
    const actualProfitSum = actualProfitValues.length
      ? actualProfitValues.reduce((sum, value) => sum + value, 0)
      : null;
    const lossSum = knownProfitValues.length
      ? knownProfitValues.reduce((sum, value) => (value < 0 ? sum + Math.abs(value) : sum), 0)
      : null;
    const comprehensiveProfit = getProfitModeSummaryValue(profitFilterScopeRows, profitMode);
    return {
      profitTabs: profitTabConfig.map((tab) => ({
        ...tab,
        count: getProfitTabCount(profitFilterScopeRows, tab.value, profitMode),
      })),
      profitSummaryCards: [
        {
          title: '综合利润',
          value: getProfitDisplayMoney(comprehensiveProfit, summaryCurrency),
          hint:
            profitMode === 'mixed' ? '实际利润优先，缺实际时用预估' : `${getProfitModeLabel(profitMode)}汇总`,
          tone: 'primary',
        },
        {
          title: '预估利润',
          value: getProfitDisplayMoney(estimatedProfitSum, summaryCurrency),
          hint: '已读取订单预估',
          tone: 'warning',
        },
        {
          title: '实际利润',
          value: getProfitDisplayMoney(actualProfitSum, summaryCurrency),
          hint: '按财务扣费核算',
          tone: 'success',
        },
        {
          title: '亏损数据',
          value: getProfitDisplayMoney(lossSum, summaryCurrency),
          hint: '亏损订单汇总',
          tone: 'error',
        },
      ],
    };
  }, [profitFilterScopeRows, profitMode, profitRows]);
  const profitErrors = [...(profitSync.data?.errors ?? []), ...profitFinanceErrors];
  const shouldShowProfitError = Boolean(profitSync.error) && profitRows.length === 0 && !profitSync.loading;
  const visibleProfitErrors = !profitSync.loading && profitRows.length === 0 ? profitErrors : [];
  const profitCachedRows = Number(profitSync.data?.rows?.length || profitRows.length) || 0;
  const hasVisibleProfitCache = profitRows.length > 0;
  const profitBlockingLoading = Boolean(profitSync.loading && !hasVisibleProfitCache);
  const profitPassiveRefreshing = Boolean(
    !profitPageRefreshing && hasVisibleProfitCache && (profitSync.loading || profitSync.refreshing)
  );
  const profitProgressRunning = Boolean(profitBlockingLoading || profitPageRefreshing);
  const profitProgressMessage = profitPageRefreshing
    ? `正在刷新全部利润订单，当前缓存 ${profitCachedRows} 条`
    : profitPassiveRefreshing
      ? `本地缓存已显示 ${profitCachedRows} 条，后台同步中`
      : profitCachedRows > 0
        ? `本地缓存已显示 ${profitCachedRows} 条`
        : '正在读取 Ozon 利润订单';
  React.useEffect(() => {
    if (!isActive) {
      clearProfitRefreshProgress();
      return;
    }
    if (profitPageRefreshing) {
      publishProfitRefreshProgress({
        active: true,
        stage: 'orders',
        label: '利润订单刷新',
        total: profitCachedRows,
        done: 0,
        cached: profitCachedRows,
        missing: 0,
        message: `正在刷新全部利润订单，当前缓存 ${profitCachedRows} 条`,
      });
      return;
    }
    if (profitPassiveRefreshing) {
      publishProfitRefreshProgress({
        active: false,
        stage: 'background-sync',
        label: '利润后台同步',
        total: profitCachedRows,
        done: profitCachedRows,
        cached: profitCachedRows,
        missing: 0,
        message: `利润页已显示本地缓存 ${profitCachedRows} 条，后台同步不阻塞使用`,
      });
      return;
    }
    if (profitBlockingLoading) {
      publishProfitRefreshProgress({
        active: true,
        stage: 'local-cache',
        label: '利润本地缓存',
        total: profitCachedRows,
        done: 0,
        cached: profitCachedRows,
        missing: 0,
        message: profitProgressMessage,
      });
      return;
    }
    if (profitCachedRows > 0) {
      publishProfitRefreshProgress({
        active: false,
        stage: 'done',
        label: '利润本地缓存',
        total: profitCachedRows,
        done: profitCachedRows,
        cached: profitCachedRows,
        missing: 0,
        message: `利润页已显示本地缓存 ${profitCachedRows} 条，后台刷新完成后自动合并`,
      });
    }
  }, [
    isActive,
    profitBlockingLoading,
    profitCachedRows,
    profitPageRefreshing,
    profitPassiveRefreshing,
    profitProgressMessage,
  ]);
  const selectedOrderKey = selectedOrder ? getProfitOrderRecordKey(selectedOrder) : '';
  const selectedOrderProfitLossInfo = selectedOrder ? getProfitOrderProfitLossInfo(selectedOrder) : null;
  const selectedOrderStatusValue = selectedOrderProfitLossInfo?.value ?? null;
  const selectedOrderStatusDisplay =
    selectedOrderStatusValue === null || selectedOrderStatusValue === undefined
      ? '待确认'
      : getSignedProfitDisplay(selectedOrderStatusValue, selectedOrder?.currencyCode || 'CNY');
  const selectedOrderStatusClass = getProfitValueClass(selectedOrderStatusDisplay);
  const selectedOrderActualProfitValue = selectedOrder ? getProfitOrderActualValue(selectedOrder) : null;
  const selectedOrderActualProfitDisplay =
    selectedOrderActualProfitValue === null || selectedOrderActualProfitValue === undefined
      ? '待确认'
      : getSignedProfitDisplay(selectedOrderActualProfitValue, selectedOrder?.currencyCode || 'CNY');
  const selectedOrderActualProfitClass = getProfitValueClass(selectedOrderActualProfitDisplay);
  const selectedOrderProfitLossStatus = getProfitResultStatusLabel(selectedOrderStatusValue);
  const selectedOrderDetailInfo = getProfitDetailOrderInfo(selectedOrder, selectedOrderProfitContext);
  const selectedOrderRealStatus = getProfitDetailRealStatusLabel(selectedOrder);
  const selectedOrderEstimateSummary = getProfitDetailEstimateSummary(selectedOrder);
  const selectedOrderActualFees = getProfitDetailActualFees(selectedOrder);
  const handleProfitSavedOverrides = React.useCallback((overrides, saved) => {
    setProfitLocalInputs(current => ({ ...current, purchaseLocalOverrides: saved?.key
      ? { ...current.purchaseLocalOverrides, [saved.key]: saved.overrides } : overrides }));
  }, [setProfitLocalInputs]);
  const profitEditing = useProfitInlineEditing({
    selectedOrder, selectedOrderKey, editor: profitInlineEditor, setEditor: setProfitInlineEditor,
    setLedgerRows: setProfitLedgerRows, setFinanceRows: setProfitFinanceRows,
    persistOrders: persistProfitLedgerOrders, onSavedOverrides: handleProfitSavedOverrides,
  });
  const renderProfitEditableMoneyValue = React.useCallback(
    (fieldId, value, className, hint = '') => (
      <ProfitEditableMoney
        fieldId={fieldId} value={value} className={className} hint={hint}
        editor={profitInlineEditor} orderKey={selectedOrderKey}
        setEditor={setProfitInlineEditor} editing={profitEditing}
      />
    ), [profitEditing, profitInlineEditor, selectedOrderKey]
  );
  const getEstimatedProfitEditableFieldId = React.useCallback((label = '') => {
    if (label === '货源成本') return 'sourcePurchaseCostCny';
    if (label === '物流预估') return 'logisticsFeeCny';
    return '';
  }, []);
  const getActualProfitEditableFieldId = React.useCallback((label = '') => {
    if (label === '巴士费用') return 'crossBorderBusFeeCny';
    return '';
  }, []);
  React.useEffect(() => {
    setProfitInlineEditor(null);
  }, [selectedOrderKey]);
  const handleRefreshAllProfitOrders = React.useCallback(async () => {
    if (!isActive || !readableShops.length || profitPageRefreshing) return;
    const requestId = profitPageRefreshRequestRef.current + 1;
    profitPageRefreshRequestRef.current = requestId;
    const requestScopeKey = profitAllOrderRefreshScopeKey;
    const isCurrentProfitRefresh = () =>
      profitPageRefreshRequestRef.current === requestId && profitAllOrderRefreshScopeRef.current === requestScopeKey;
    setProfitPageRefreshing(true);
    setProfitFinanceErrors([]);
    try {
      const snapshot = await profitSync.refresh();
      if (!isCurrentProfitRefresh()) return;
      const refreshedRows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
      refreshedRows.forEach((order) => {
        const key = getProfitOrderRecordKey(order);
        if (key) recordRequestSuccess(profitFinanceCooldown, key);
      });
      if (!isCurrentProfitRefresh()) return;
      setProfitFinanceErrors(snapshot?.errors ?? []);
    } catch (error) {
      if (!isCurrentProfitRefresh()) return;
      setProfitFinanceErrors([{ error }]);
    } finally {
      if (profitPageRefreshRequestRef.current === requestId) setProfitPageRefreshing(false);
    }
  }, [isActive, profitAllOrderRefreshScopeKey, profitPageRefreshing, profitSync, readableShops.length]);

  React.useEffect(() => {
    if (externalRefreshTickRef.current === externalRefreshTick) return;
    externalRefreshTickRef.current = externalRefreshTick;
    if (!isActive || !externalRefreshTick) return;
    const lastRefreshAt = Number(ozonSnapshotManualRefreshAt.get(profitPageManualRefreshCooldownKey)) || 0;
    if (lastRefreshAt > 0 && Date.now() - lastRefreshAt < PROFIT_PAGE_INTERNAL_REFRESH_TTL_MS) return;
    profitSync.refresh();
  }, [externalRefreshTick, isActive, profitPageManualRefreshCooldownKey, profitSync]);

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
          <Typography variant="h4">利润核算</Typography>
          <Typography color="text.secondary" mt={0.75}>
            按订单核算 Ozon 预估利润、实际利润和亏损数据
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
            {profitLedgerCacheHint}
          </Typography>
        </Box>
        <Stack spacing={0.75} alignItems={{ xs: 'stretch', md: 'flex-end' }} className="hero-actions">
          <Stack direction="row" spacing={1}>
            <FormControl size="small" className="profit-mode-select">
              <Select
                value={profitMode}
                onChange={(event) => {
                  setProfitMode(event.target.value);
                  setProfitOrderPage(1);
                }}
                displayEmpty
                IconComponent={KeyboardArrowDownRounded}
                renderValue={(value) => `模式切换：${getProfitModeLabel(value)}`}
              >
                {profitModeOptions.map((item) => (
                  <MenuItem key={item.value} value={item.value}>
                    {item.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button
              variant="contained"
              startIcon={<RefreshRounded />}
              onClick={handleRefreshAllProfitOrders}
              disabled={!readableShops.length || profitBlockingLoading || profitPageRefreshing}
            >
              {profitBlockingLoading || profitPageRefreshing ? '读取中' : '刷新全部订单'}
            </Button>
          </Stack>
          <ReadProgressPanel
            visible={profitProgressRunning}
            running={profitProgressRunning}
            message={profitProgressMessage}
            runningText="读取中"
            ariaLabel="利润核算读取进度"
          />
        </Stack>
      </Stack>

      {profitLocalInputsError && (
        <Alert severity="warning" action={<Button onClick={retryProfitLocalInputs}>重试</Button>} sx={{ mb: 2 }}>
          {profitLocalInputsError}
        </Alert>
      )}
      {profitLedgerCacheInfo.partial && profitLedgerCacheInfo.status !== 'loading' && (
        <Alert severity="warning" action={<Button onClick={retryProfitLedgerReadback}>重试读取</Button>} sx={{ mb: 2 }}>
          部分利润账本读取失败，健康店铺可继续使用；失败店铺的金额可能是旧数据。
          {(profitLedgerCacheInfo.partitionErrors || []).map(error => error.shopId || '共享存储').join('、')}
        </Alert>
      )}
      {profitCalculationErrors.length > 0 && (
        <Alert severity="warning" action={<Button onClick={retryProfitCalculation}>重新计算</Button>} sx={{ mb: 2 }}>
          {profitCalculationErrors.map(error => error.shopId).join('、')} 计算失败，显示的是上次结果。
        </Alert>
      )}
      <Box className="profit-stat-grid">
        {profitSummaryCards.map((item) => (
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

      <Card className="profit-filter-card">
        <CardContent>
          <Stack direction={{ xs: 'column', xl: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', xl: 'center' }}>
            <Box className="profit-filter-copy">
              <Typography variant="h6">利润标签</Typography>
              <Typography variant="body2" color="text.secondary">
                按利润口径快速查看订单
              </Typography>
            </Box>
            <Box className="profit-status-grid">
              {profitTabs.map((tab) => (
                <Box
                  key={tab.value}
                  component="button"
                  type="button"
                  className={`status-tab${activeTab === tab.value ? ' active' : ''}`}
                  onClick={() => {
                    setActiveTab(tab.value);
                    setProfitOrderPage(1);
                  }}
                >
                  <span>{tab.label}</span>
                  <strong>{tab.count}</strong>
                </Box>
              ))}
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Box className="profit-orders-layout">
        <Card className="profit-orders-table-card">
          <CardContent>
            <Box className="profit-order-table-head">
              <Box className="sales-order-table-title">
                <Typography variant="h6">订单利润列表</Typography>
                <Typography variant="body2" color="text.secondary">
                  {profitSync.data?.fetchedAt
                    ? `已同步 ${formatOzonOrderDate(profitSync.data.fetchedAt)}`
                    : '等待读取 Ozon 订单'}
                </Typography>
              </Box>
              <Box className="profit-filter-toolbar">
                <TextField
                  size="small"
                  className="profit-search-field"
                  placeholder="搜索单号 / 货号 / SKU"
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value);
                    setProfitOrderPage(1);
                  }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchRounded />
                      </InputAdornment>
                    ),
                  }}
                />
                <FormControl size="small" className="profit-filter-select">
                  <Select
                    value={shop}
                    onChange={(event) => {
                      setShop(event.target.value);
                      setProfitOrderPage(1);
                    }}
                  >
                    <MenuItem value="all">全部店铺</MenuItem>
                    {shopOptions.map((item) => (
                      <MenuItem key={item.value} value={item.value}>
                        {item.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" className="profit-filter-select">
                  <Select
                    value={fulfillment}
                    onChange={(event) => {
                      setFulfillment(event.target.value);
                      setProfitOrderPage(1);
                    }}
                  >
                    <MenuItem value="all">全部履约</MenuItem>
                    {fulfillments.map((item) => (
                      <MenuItem key={item} value={item}>
                        {item}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Box
                  component="button"
                  type="button"
                  className={`sales-date-range-filter sales-date-range-trigger${paymentStartDate || paymentEndDate ? ' has-value' : ''}`}
                  onClick={(event) => {
                    setPaymentStartDateDraft(paymentStartDate);
                    setPaymentEndDateDraft(paymentEndDate);
                    setPaymentDateAnchorEl(event.currentTarget);
                  }}
                >
                  <Typography component="span" className="sales-date-range-label">
                    付款时间
                  </Typography>
                  <Typography component="span" className="sales-date-range-value">
                    {paymentDateText}
                  </Typography>
                  <CalendarMonthRounded className="sales-date-icon" />
                </Box>
                <Popover
                  open={paymentDateOpen}
                  anchorEl={paymentDateAnchorEl}
                  onClose={() => setPaymentDateAnchorEl(null)}
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                  transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                  PaperProps={{ className: 'sales-date-popover' }}
                >
                  <Box className="sales-date-popover-content">
                    <TextField
                      size="small"
                      type="date"
                      label="开始日期"
                      value={paymentStartDateDraft}
                      onChange={(event) => {
                        setPaymentStartDateDraft(event.target.value);
                        setProfitOrderPage(1);
                      }}
                      inputProps={{
                        max: paymentEndDateDraft || undefined,
                        onKeyDown: (event) => event.preventDefault(),
                      }}
                      InputLabelProps={{ shrink: true }}
                    />
                    <TextField
                      size="small"
                      type="date"
                      label="结束日期"
                      value={paymentEndDateDraft}
                      onChange={(event) => {
                        setPaymentEndDateDraft(event.target.value);
                        setProfitOrderPage(1);
                      }}
                      inputProps={{
                        min: paymentStartDateDraft || undefined,
                        onKeyDown: (event) => event.preventDefault(),
                      }}
                      InputLabelProps={{ shrink: true }}
                    />
                    <Box className="sales-date-popover-actions">
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          setPaymentStartDateDraft('');
                          setPaymentEndDateDraft('');
                          setPaymentStartDate('');
                          setPaymentEndDate('');
                          queueProfitDateRefresh();
                          setProfitOrderPage(1);
                          setPaymentDateAnchorEl(null);
                        }}
                      >
                        清空时间
                      </Button>
                      <Button
                        size="small"
                        variant="contained"
                        onClick={() => {
                          setPaymentStartDate(paymentStartDateDraft);
                          setPaymentEndDate(paymentEndDateDraft);
                          queueProfitDateRefresh();
                          setProfitOrderPage(1);
                          setPaymentDateAnchorEl(null);
                        }}
                      >
                        完成
                      </Button>
                    </Box>
                  </Box>
                </Popover>
              </Box>
            </Box>
            {shouldShowProfitError ? (
              <Alert severity="warning" className="order-sync-alert">
                {getProfitReadMessage(profitSync.error)}
              </Alert>
            ) : null}
            {visibleProfitErrors.length ? (
              <Alert severity="info" className="order-sync-alert">
                {visibleProfitErrors.map((item) => getProfitReadMessage(item.error)).join('；')}
              </Alert>
            ) : null}
            <TableContainer className="wide-table-container">
              <Table className="data-table profit-orders-table">
                <colgroup>
                  <col className="profit-order-col-image" />
                  <col className="profit-order-col-order" />
                  <col className="profit-order-col-product" />
                  <col className="profit-order-col-shop" />
                  <col className="profit-order-col-sales" />
                  <col className="profit-order-col-estimated" />
                  <col className="profit-order-col-actual" />
                  <col className="profit-order-col-diff" />
                </colgroup>
                <TableHead>
                  <TableRow>
                    <TableCell align="center">图</TableCell>
                    <TableCell>单号</TableCell>
                    <TableCell>商品</TableCell>
                    <TableCell>店铺</TableCell>
                    <TableCell align="right">销售额</TableCell>
                    <TableCell align="right">预估利润</TableCell>
                    <TableCell align="right">实际利润</TableCell>
                    <TableCell align="right">盈亏</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visibleOrders.map((order) => {
                    const orderKey = getProfitOrderRecordKey(order);
                    const profitLossInfo = getProfitOrderProfitLossInfo(order);
                    const profitLossDisplay =
                      profitLossInfo.value === null
                        ? '待确认'
                        : getSignedProfitDisplay(profitLossInfo.value, order.currencyCode || 'CNY');
                    const profitLossClass = profitLossInfo.isEstimatedFallback
                      ? 'profit-value-warning'
                      : getProfitValueClass(profitLossDisplay);
                    const estimatedProfitDisplay = String(order.estimatedProfit ?? '').trim() || '待确认';
                    const actualProfitDisplay = String(order.actualProfit ?? '').trim() || '待确认';
                    const productNo =
                      firstFilled(order.offerId, order.sku, order.products?.[0]?.offerId, order.products?.[0]?.sku) ||
                      '未返回';
                    return (
                      <TableRow
                        key={orderKey}
                        hover
                        className={selectedOrderKey === orderKey ? 'selected-row' : ''}
                        onClick={() => setSelectedOrderId(orderKey)}
                      >
                        <TableCell align="center" className="profit-order-image-cell">
                          <PurchaseOrderProductImagePreview order={order} />
                        </TableCell>
                        <TableCell className="profit-order-id-cell">
                          <Typography variant="subtitle1" noWrap title={order.id}>
                            {order.id}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={`货号: ${productNo}`}
                          >
                            货号: {productNo}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={`付款: ${order.paymentTime}`}
                          >
                            付款: {order.paymentTime}
                          </Typography>
                        </TableCell>
                        <TableCell className="profit-order-product-cell">
                          <Typography
                            component="button"
                            type="button"
                            className="profit-order-product-title ozon-product-title-button"
                            variant="subtitle1"
                            noWrap
                            title={`${order.product}｜打开 Ozon 商品页面`}
                            onClick={(event) => {
                              event.stopPropagation();
                              openProfitOzonProductPage(order, order.products?.[0] || {});
                            }}
                          >
                            {order.product}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" display="block" noWrap>
                            订单数量: {order.qty} 件
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={`SKU ID: ${order.skuId}`}
                          >
                            SKU ID: {order.skuId}
                          </Typography>
                        </TableCell>
                        <TableCell className="profit-order-shop-cell">
                          <Typography variant="body2" className="profit-shop-name" noWrap title={order.shop}>
                            {order.shop}
                          </Typography>
                          <Typography
                            variant="caption"
                            className="profit-fulfillment-text"
                            noWrap
                            title={order.fulfillment}
                          >
                            {order.fulfillment}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" className="profit-order-money-cell">
                          <Typography variant="body2" className="profit-money-cell" noWrap>
                            {order.salesAmount}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" className="profit-order-money-cell">
                          <Typography
                            variant="body2"
                            className={`profit-money-cell ${getProfitValueClass(estimatedProfitDisplay)}`}
                            noWrap
                          >
                            {estimatedProfitDisplay}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" className="profit-order-money-cell">
                          <Typography
                            variant="body2"
                            className={`profit-money-cell ${getProfitValueClass(actualProfitDisplay)}`}
                            noWrap
                          >
                            {actualProfitDisplay}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" className="profit-order-money-cell">
                          <Typography variant="body2" className={`profit-money-cell ${profitLossClass}`} noWrap>
                            {profitLossDisplay}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!profitSync.loading && filteredOrders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8}>
                        <Typography variant="body2" color="text.secondary" align="center">
                          {readableShops.length ? '暂未读取到符合条件的订单' : '请先在设置里配置 Ozon 店铺'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </TableContainer>

            {filteredOrders.length > 0 ? (
              <Box className="sales-order-pagination">
                <Box className="sales-order-pagination-summary">
                  <Typography variant="body2" color="text.secondary">
                    共 {filteredOrders.length} 条
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {profitOrderRangeStart}-{profitOrderRangeEnd}
                  </Typography>
                </Box>
                <Box className="sales-order-pagination-controls">
                  <Typography variant="body2" color="text.secondary">
                    每页
                  </Typography>
                  <FormControl size="small" className="sales-order-page-size-select">
                    <Select
                      value={String(profitOrderPageSize)}
                      onChange={(event) => {
                        setProfitOrderPageSize(Number(event.target.value));
                        setProfitOrderPage(1);
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
                    page={currentProfitOrderPage}
                    count={profitOrderTotalPages}
                    siblingCount={1}
                    boundaryCount={1}
                    onChange={(_, value) => {
                      setProfitOrderPage(value);
                      const nextOrder = filteredOrders[(value - 1) * profitOrderPageSize];
                      if (nextOrder) setSelectedOrderId(getProfitOrderRecordKey(nextOrder));
                    }}
                  />
                </Box>
              </Box>
            ) : null}
          </CardContent>
        </Card>

        <Box className="purchase-order-side-panel profit-order-side-panel" data-order-follow-panel="true">
          <OrderSideSearch
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              setProfitOrderPage(1);
            }}
            placeholder="搜索单号 / 货号 / SKU"
            className="profit-order-side-search"
          />
          <Card className="purchase-order-detail-card profit-detail-card">
            <CardContent>
              <Stack
                direction="row"
                alignItems="flex-start"
                justifyContent="space-between"
                spacing={1.5}
                className="profit-detail-header"
              >
                <Box>
                  <Typography variant="h6">订单利润详情</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {selectedOrder?.id ?? '未选择订单'}
                  </Typography>
                </Box>
                {selectedOrder ? (
                  <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" justifyContent="flex-end">
                    {selectedOrderRealStatus ? (
                      <Chip
                        size="small"
                        className="profit-detail-real-status-chip"
                        label={selectedOrderRealStatus}
                        variant="outlined"
                      />
                    ) : null}
                    <Chip
                      size="small"
                      className={selectedOrderStatusClass}
                      label={selectedOrderProfitLossStatus}
                      variant="filled"
                    />
                  </Stack>
                ) : null}
              </Stack>

              <Typography variant="subtitle1" className="profit-detail-section-title">
                订单信息
              </Typography>
              <Box className="profit-detail-info-grid">
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Ozon订单号
                  </Typography>
                  <Typography variant="subtitle1">{selectedOrderDetailInfo?.ozonOrderId ?? '未返回'}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    货号
                  </Typography>
                  <Typography variant="subtitle1">{selectedOrderDetailInfo?.offerId ?? '未返回'}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    所属店铺
                  </Typography>
                  <Typography variant="subtitle1">{selectedOrderDetailInfo?.shop ?? '未返回'}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    付款时间
                  </Typography>
                  <Typography variant="subtitle1">{selectedOrderDetailInfo?.paymentTime ?? '未返回'}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    采购平台
                  </Typography>
                  <Typography variant="subtitle1">{selectedOrderDetailInfo?.purchasePlatform ?? '未返回'}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    采购订单号
                  </Typography>
                  <Typography variant="subtitle1">{selectedOrderDetailInfo?.purchaseOrderNo ?? '未返回'}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    货源价格
                  </Typography>
                  <Typography variant="subtitle1">{selectedOrderDetailInfo?.purchaseCost ?? '未返回'}</Typography>
                </Box>
              </Box>

              <Divider className="profit-detail-divider" />

              <Typography variant="subtitle1" className="profit-detail-section-title">
                预估利润信息
              </Typography>
              <Box className="profit-detail-fee-panel profit-detail-estimated-panel">
                {(selectedOrder?.estimatedFees ?? []).map((item) => {
                  const fieldId = getEstimatedProfitEditableFieldId(item.label);
                  return (
                    <Box key={item.label} className="profit-detail-fee-item">
                      <Typography variant="body2" color="text.secondary">
                        {item.label}
                      </Typography>
                      {renderProfitEditableMoneyValue(
                        fieldId,
                        item.value,
                        'profit-detail-fee-value profit-value-warning',
                        item.hint
                      )}
                    </Box>
                  );
                })}
              </Box>
              <Box className="profit-detail-summary-strip">
                {selectedOrderEstimateSummary.map((item) => (
                  <Box key={item.label} className="profit-detail-summary-item">
                    <Typography variant="caption" color="text.secondary">
                      {item.label}
                    </Typography>
                    <Typography variant="subtitle1" className={item.tone} title={item.hint || undefined}>
                      {item.value}
                    </Typography>
                  </Box>
                ))}
              </Box>

              <Divider className="profit-detail-divider" />

              <Box className="profit-detail-section-head">
                <Typography variant="subtitle1" className="profit-detail-section-title">
                  实际利润
                </Typography>
                <Box className={`profit-detail-result-pill ${selectedOrderActualProfitClass}`}>
                  {selectedOrderActualProfitDisplay}
                </Box>
              </Box>
              <Box className="profit-detail-fee-panel profit-detail-actual-panel">
                {selectedOrderActualFees.map((item) => {
                  const fieldId = getActualProfitEditableFieldId(item.label);
                  return (
                    <Box key={item.label} className="profit-detail-actual-line">
                      <Typography variant="body2" color="text.secondary">
                        {item.label}
                      </Typography>
                      {renderProfitEditableMoneyValue(
                        fieldId,
                        item.value,
                        'profit-detail-fee-value profit-value-warning',
                        item.hint
                      )}
                    </Box>
                  );
                })}
              </Box>
            </CardContent>
          </Card>
        </Box>
      </Box>
      <OzonProductWorkbench controller={profitOzonProductWorkbench} />
    </>
  );
}

export { ProfitCalculationPage };
export default ProfitCalculationPage;

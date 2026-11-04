import { useOzonRealtimeSnapshot } from '../../../../entities/marketing/marketingSnapshotRuntime.jsx';
import {
  createOzonTimeRangeScope,
  getActiveOzonShop,
  getOzonReadableShops,
  getOzonSnapshotSourceKey,
} from '../../../../entities/order/orderShopScope.jsx';
import { getSalesOrderRecordKey } from '../../../../entities/order/orderRecordRules.jsx';
import { applyOzonLocalProductEntitiesToRows } from '../../../../entities/product/productLocalMirror.jsx';
import {
  mergeSalesOrderVisibleSupplement,
} from '../../../../entities/profit/profitOrderSnapshot.jsx';
import {
  getOzonSalesOrdersSnapshotCacheKey,
} from '../../../../entities/profit/profitAfterSalesRules.jsx';
import {
  createOzonOrderChangeNotifications,
  readOzonOrderSupplementCache,
} from '../../../../services/ozonOrderExperience';
import { applyProductMaterialProfiles, readProductMaterialProfiles } from '../../../../services/productMaterialProfileStore';
import { readRubCnyExchangeRateContext } from '../../../../services/exchangeRateClient';
import {
  buildOrderExchangeRateBundle,
  getOrderEstimatedExchangeDateKey,
} from '../../../../services/orderExchangeRateRules';
import { readSalesOrderProductSummaryEntities } from '../../../../services/salesOrderProductSummaryService';
import { clearVoidedPurchaseDisplayFields } from '../../../../services/purchaseInfoSupport.js';
import { loadFeePlanState } from '../../../settings/lib/feeSettings.jsx';
import {
  OZON_ORDER_DEFAULT_RANGE_DAYS,
  OZON_ORDER_SNAPSHOT_CACHE_TTL_MS,
  PROFIT_ORDER_DEFAULT_RANGE_DAYS,
} from '../../../../shared/config/appConfigCore.jsx';
import { getPurchaseOrderRecordKey } from '../lib/purchaseMarketingApi.jsx';
import {
  annotatePurchaseOrder,
  applyPurchaseManualFallbacks,
  createEmptyPurchaseOrder,
  createManualPurchaseDraftFromOrder,
  findPurchaseOrderLocalOverride,
  hydratePurchaseOrderLocalOverridesFromLocalFile,
  normalizeOzonSalesRowToPurchaseOrder,
  readPurchaseOrderLocalOverrides,
  sanitizePurchaseOrderLocalOverrideForMerge,
} from '../lib/purchaseOrderNormalize.jsx';
import { getPurchaseOrderShop } from '../../../../services/purchaseCrossBorderRuntime.js';
import { readPurchaseProfitLedgerSnapshot } from '../services/purchaseProfitLedgerService.js';
import { requestPurchaseOrdersPreciseSnapshotForShops } from '../services/purchaseOrderPreciseSyncService.js';
import { useSynchronizedOzonShopSelection } from '../../../../entities/order/useSynchronizedOzonShopSelection.jsx';
import { refreshOrderCacheFast } from '../../../../services/orderFastRefreshService.js';
import {
  getOzonPushRealtimeShopId,
  isOzonPushDomainRefreshEvent,
  OZON_PUSH_REALTIME_BROWSER_EVENT,
} from '../../../../services/ozonPushRealtime.js';
import React from 'react';
import { useScopedPurchaseResource } from './useScopedPurchaseResource.js';
import { createPurchaseRowMapper } from './purchaseIncrementalRows.js';

const EMPTY_PURCHASE_PROFIT_ROWS = Object.freeze({});
const EMPTY_PURCHASE_PRODUCT_ENTITIES = new Map();

function isUsableCrossBorderText(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return !/^(?:未返回|待确认|null|undefined|nan|-|—)$/i.test(text);
}

function firstUsableCrossBorderText(...values) {
  return values.find(isUsableCrossBorderText);
}

export function usePurchaseOrdersDatasetState({
  shops,
  activeShopId,
  isActive,
  externalRefreshTick,
  onOrderNotifications,
} = {}) {
  const activeShop = React.useMemo(() => getActiveOzonShop(shops, activeShopId), [shops, activeShopId]);
  const readableShops = React.useMemo(() => getOzonReadableShops(shops), [shops]);
  const readableShopsSourceKey = React.useMemo(() => getOzonSnapshotSourceKey(readableShops), [readableShops]);
  const rowMappers = React.useRef(null);
  if (!rowMappers.current) rowMappers.current = Object.fromEntries(
    ['images', 'products', 'rates', 'normalized', 'crossBorder'].map(key => [key, createPurchaseRowMapper()])
  );
  const [paymentStartDate, setPaymentStartDate] = React.useState('');
  const [paymentEndDate, setPaymentEndDate] = React.useState('');
  const [paymentDateAnchorEl, setPaymentDateAnchorEl] = React.useState(null);
  const purchaseOrderTimeScope = React.useMemo(
    () =>
      createOzonTimeRangeScope({
        page: 'purchase-orders',
        startDate: paymentStartDate,
        endDate: paymentEndDate,
        defaultDays: OZON_ORDER_DEFAULT_RANGE_DAYS,
      }),
    [paymentEndDate, paymentStartDate]
  );
  const purchaseOrderPoolTimeScope = React.useMemo(
    () =>
      createOzonTimeRangeScope({
        page: 'orders-shared-pool',
        startDate: paymentStartDate,
        endDate: paymentEndDate,
        defaultDays: OZON_ORDER_DEFAULT_RANGE_DAYS,
        version: 'orders-90d-v1',
      }),
    [paymentEndDate, paymentStartDate]
  );
  const purchaseProfitLedgerTimeScope = React.useMemo(
    () =>
      createOzonTimeRangeScope({
        page: 'profit-calculation',
        startDate: paymentStartDate,
        endDate: paymentEndDate,
        defaultDays: PROFIT_ORDER_DEFAULT_RANGE_DAYS,
      }),
    [paymentEndDate, paymentStartDate]
  );
  const purchaseOrderSnapshotGroup = React.useMemo(
    () => `ozon-purchase-orders:${purchaseOrderTimeScope.cachePart}`,
    [purchaseOrderTimeScope.cachePart]
  );
  const purchaseOrderLocalSnapshotKey = React.useMemo(
    () => getOzonSalesOrdersSnapshotCacheKey(readableShops, purchaseOrderPoolTimeScope, 'ozon-orders-shared'),
    [purchaseOrderPoolTimeScope, readableShops]
  );
  const orderSync = useOzonRealtimeSnapshot(readableShops, requestPurchaseOrdersPreciseSnapshotForShops, {
    enabled: isActive && readableShops.length > 0,
    refreshOnMount: true,
    allowInitialPartialSnapshot: true,
    cacheTtlMs: OZON_ORDER_SNAPSHOT_CACHE_TTL_MS,
    cacheGroup: purchaseOrderSnapshotGroup,
    keepCurrentDataOnForceRefresh: true,
    manualRefreshCooldownMs: 5000,
    manualRefreshCooldownKey: purchaseOrderSnapshotGroup,
    loaderOptions: {
      enrichCrossBorder: false,
      dateRange: purchaseOrderTimeScope.apiRange,
      timeScope: purchaseOrderTimeScope,
      preciseSync: true,
      preciseLookbackDays: 7,
      preciseOverlapHours: 6,
      preciseMaxPages: 10,
    },
  });
  const pendingOrderCacheReloadRef = React.useRef(false);
  const reloadPurchaseOrderSnapshot = orderSync.reload;
  const reloadPurchaseOrderCache = React.useCallback(() => reloadPurchaseOrderSnapshot({
    silent: true,
    force: true,
    loaderForceRefresh: false,
    loaderOptions: { preciseSync: false, autoSync: false },
  }), [reloadPurchaseOrderSnapshot]);
  const refreshPurchaseOrdersFast = React.useCallback(async () => {
    await reloadPurchaseOrderCache().catch(() => null);
    const result = await refreshOrderCacheFast(readableShops, purchaseOrderTimeScope, {
      requestedBy: 'frontend-purchase-orders-fast-refresh',
      source: 'purchase-orders-fast-refresh',
      foregroundWaitMs: 10_000,
    });
    await reloadPurchaseOrderCache().catch(() => null);
    return result;
  }, [purchaseOrderTimeScope, readableShops, reloadPurchaseOrderCache]);
  React.useEffect(() => {
    const readableShopIds = new Set(readableShops.map((item) => String(item?.id || '').trim()).filter(Boolean));
    let timer = null;
    const handleOrderCacheUpdated = (event) => {
      if (!isOzonPushDomainRefreshEvent(event, 'orders')) return;
      const shopId = getOzonPushRealtimeShopId(event);
      if (!shopId || !readableShopIds.has(shopId)) return;
      if (!isActive) {
        pendingOrderCacheReloadRef.current = true;
        return;
      }
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => {
        pendingOrderCacheReloadRef.current = false;
        void reloadPurchaseOrderCache().catch(() => undefined);
      }, 80);
    };
    globalThis.addEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOrderCacheUpdated);
    return () => {
      globalThis.clearTimeout(timer);
      globalThis.removeEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOrderCacheUpdated);
    };
  }, [isActive, readableShops, reloadPurchaseOrderCache]);
  React.useEffect(() => {
    if (!isActive || !pendingOrderCacheReloadRef.current) return;
    pendingOrderCacheReloadRef.current = false;
    void reloadPurchaseOrderCache().catch(() => undefined);
  }, [isActive, reloadPurchaseOrderCache]);
  const baseOrderRows = React.useMemo(() => orderSync.data?.rows ?? [], [orderSync.data?.rows]);
  const readPurchaseProfitResource = React.useCallback(async () => {
    const snapshot = await readPurchaseProfitLedgerSnapshot(readableShops, purchaseProfitLedgerTimeScope);
    const rows = snapshot.rowsByKey;
    return rows && Object.keys(rows).length ? rows : EMPTY_PURCHASE_PROFIT_ROWS;
  }, [purchaseProfitLedgerTimeScope, readableShops]);
  const purchaseProfitLedgerRowsByKey = useScopedPurchaseResource({
    scopeKey: readableShops.length ? `${readableShopsSourceKey}:${purchaseProfitLedgerTimeScope.cachePart}` : '',
    enabled: isActive,
    read: readPurchaseProfitResource,
    emptyValue: EMPTY_PURCHASE_PROFIT_ROWS,
    refreshKey: externalRefreshTick,
  });
  const [purchaseImageMap, setPurchaseImageMap] = React.useState(() => new Map());
  const [purchaseImageErrorText, setPurchaseImageErrorText] = React.useState('');
  const orderRowsWithImages = React.useMemo(
    () =>
      rowMappers.current.images(baseOrderRows, readableShopsSourceKey, (order) => {
        const key = getSalesOrderRecordKey(order);
        const enhancedOrder = key ? (purchaseImageMap.get(key) ?? readOzonOrderSupplementCache(order)) : null;
        return [enhancedOrder];
      }, (order, [enhancedOrder]) => mergeSalesOrderVisibleSupplement(order, enhancedOrder)),
    [baseOrderRows, purchaseImageMap, readableShopsSourceKey]
  );
  const [purchaseExchangeRateContext, setPurchaseExchangeRateContext] = React.useState(() => ({
    todayKey: '',
    realtime: null,
    dailyRates: new Map(),
    errors: [],
  }));
  const [, setFeeSettingsRevision] = React.useState(0);
  const purchaseOrderExchangeDateKeys = React.useMemo(
    () => [...new Set(orderRowsWithImages.map(getOrderEstimatedExchangeDateKey).filter(Boolean))],
    [orderRowsWithImages]
  );
  const purchaseOrderExchangeDateKeysSignature = React.useMemo(
    () => [...purchaseOrderExchangeDateKeys].sort().join(','),
    [purchaseOrderExchangeDateKeys]
  );
  const purchaseOrderExchangeDateKeysSignatureRef = React.useRef('');
  const readPurchaseProductResource = React.useCallback(async () => {
    if (!orderRowsWithImages.length) return EMPTY_PURCHASE_PRODUCT_ENTITIES;
    const summary = await readSalesOrderProductSummaryEntities(orderRowsWithImages, readableShops, { getRecordKey: getSalesOrderRecordKey });
    return summary?.entityMap instanceof Map && summary.entityMap.size ? summary.entityMap : EMPTY_PURCHASE_PRODUCT_ENTITIES;
  }, [orderRowsWithImages, readableShops]);
  const productSummaryEntityMap = useScopedPurchaseResource({
    scopeKey: readableShops.length ? readableShopsSourceKey : '',
    enabled: isActive,
    read: readPurchaseProductResource,
    emptyValue: EMPTY_PURCHASE_PRODUCT_ENTITIES,
  });
  React.useEffect(() => {
    let isMounted = true;
    if (!isActive) {
      return () => {
        isMounted = false;
      };
    }

    loadFeePlanState()
      .then(() => {
        if (isMounted) setFeeSettingsRevision((current) => current + 1);
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, [isActive]);
  React.useEffect(() => {
    let isMounted = true;
    if (!isActive) {
      setPurchaseExchangeRateContext({ todayKey: '', realtime: null, dailyRates: new Map(), errors: [] });
      return () => {
        isMounted = false;
      };
    }

    readRubCnyExchangeRateContext([], { maxLookbackDays: 10 })
      .then((context) => {
        if (isMounted) {
          setPurchaseExchangeRateContext((current) => ({
            todayKey: context.todayKey || current.todayKey,
            realtime: context.realtime ?? current.realtime,
            dailyRates: current.dailyRates instanceof Map ? current.dailyRates : new Map(),
            errors: Array.isArray(context.errors) ? context.errors : [],
          }));
        }
      })
      .catch((error) => {
        if (isMounted) {
          setPurchaseExchangeRateContext({
            todayKey: '',
            realtime: null,
            dailyRates: new Map(),
            errors: [{ ok: false, label: '汇率', error }],
          });
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isActive]);
  React.useEffect(() => {
    let isMounted = true;
    if (!isActive || !purchaseOrderExchangeDateKeys.length) {
      return () => {
        isMounted = false;
      };
    }
    // Image hydration rebuilds the row array without changing which payment dates
    // exist. Skip the refetch unless the set of date keys really changed, otherwise
    // every page turn re-requests daily rates and rebuilds every mapped row.
    if (purchaseOrderExchangeDateKeysSignatureRef.current === purchaseOrderExchangeDateKeysSignature) {
      return () => {
        isMounted = false;
      };
    }
    purchaseOrderExchangeDateKeysSignatureRef.current = purchaseOrderExchangeDateKeysSignature;

    readRubCnyExchangeRateContext(purchaseOrderExchangeDateKeys, {
      includeRealtime: false,
      maxLookbackDays: 10,
      dailyConcurrency: 3,
    })
      .then((context) => {
        if (!isMounted) return;
        setPurchaseExchangeRateContext((current) => {
          const dailyRates = new Map(current.dailyRates instanceof Map ? current.dailyRates : []);
          context.dailyRates?.forEach?.((rate, dateKey) => {
            dailyRates.set(dateKey, rate);
          });
          return {
            todayKey: current.todayKey || context.todayKey,
            realtime: current.realtime || context.realtime,
            dailyRates,
            errors: [...(Array.isArray(current.errors) ? current.errors : []), ...(context.errors ?? [])],
          };
        });
      })
      .catch((error) => {
        if (!isMounted) return;
        setPurchaseExchangeRateContext((current) => ({
          ...current,
          errors: [...(Array.isArray(current.errors) ? current.errors : []), { ok: false, label: '日汇率', error }],
        }));
      });

    return () => {
      isMounted = false;
    };
  }, [isActive, purchaseOrderExchangeDateKeys, purchaseOrderExchangeDateKeysSignature]);
  const orderRowsWithProductSummary = React.useMemo(
    () =>
      productSummaryEntityMap.size
        ? rowMappers.current.products(orderRowsWithImages, readableShopsSourceKey,
          () => [productSummaryEntityMap],
          order => applyOzonLocalProductEntitiesToRows([order], productSummaryEntityMap, getSalesOrderRecordKey)[0])
        : orderRowsWithImages,
    [orderRowsWithImages, productSummaryEntityMap, readableShopsSourceKey]
  );
  const orderRowsForPurchase = React.useMemo(
    () => {
      let changed = false;
      const rows = rowMappers.current.rates(orderRowsWithProductSummary, readableShopsSourceKey,
        () => [purchaseExchangeRateContext], (order) => {
        const exchangeRates = buildOrderExchangeRateBundle(order, purchaseExchangeRateContext, {
          includeActual: false,
        });
        const exchangeRate = exchangeRates.estimated;
        if (exchangeRate) changed = true;
        return exchangeRate
          ? {
              ...order,
              exchangeRate,
              estimatedExchangeRate: exchangeRate,
              exchangeRates: { ...(order.exchangeRates ?? {}), estimated: exchangeRate },
              rubToCnyRate: exchangeRate.rubToCnyRate,
            }
          : order;
      });
      return changed || rows.some((row, index) => row !== orderRowsWithProductSummary[index]) ? rows : orderRowsWithProductSummary;
    },
    [orderRowsWithProductSummary, purchaseExchangeRateContext, readableShopsSourceKey]
  );
  const [status, setStatus] = React.useState('all');
  const [fulfillment, setFulfillment] = React.useState('all');
  const [keyword, setKeyword] = React.useState('');
  const [purchaseOrderPageSize, setPurchaseOrderPageSize] = React.useState(20);
  const [purchaseOrderPage, setPurchaseOrderPage] = React.useState(1);
  const [selectedOrderId, setSelectedOrderId] = React.useState('');
  const [selectedPurchaseOrderKeys, setSelectedPurchaseOrderKeys] = React.useState(() => new Set());
  const [crossBorderReadByOrderId, setCrossBorderReadByOrderId] = React.useState({});
  const [purchaseNotice, setPurchaseNotice] = React.useState({ open: false, message: '', severity: 'info' });
  const [purchaseOperation, setPurchaseOperation] = React.useState({
    open: false,
    type: '',
    order: null,
    orders: [],
    operationId: '',
    fields: {},
    confirmed: false,
    loading: false,
    autoRunning: false,
    error: '',
    cancelReasons: [],
    cancelReasonsLoading: false,
    cancelReasonsError: '',
  });
  const [transferPendingDialog, setTransferPendingDialog] = React.useState({
    open: false,
    order: null,
  });
  const [manualClassifyDialog, setManualClassifyDialog] = React.useState({
    open: false,
    order: null,
    anchorEl: null,
    pendingOption: null,
  });
  const [purchaseLocalOverrides, setPurchaseLocalOverrides] = React.useState(readPurchaseOrderLocalOverrides);
  const [manualPurchaseDraft, setManualPurchaseDraft] = React.useState(createManualPurchaseDraftFromOrder);
  const [manualPurchaseAnchorEl, setManualPurchaseAnchorEl] = React.useState(null);
  const handledPurchasePluginCaptureIdsRef = React.useRef(new Set());
  const purchasePluginLastCaptureAtRef = React.useRef(Date.now());
  const previousPurchaseOrderRowsRef = React.useRef([]);
  const externalRefreshTickRef = React.useRef(externalRefreshTick);
  const purchaseOrdersLayoutRef = React.useRef(null);
  const [shop, setShop] = useSynchronizedOzonShopSelection({
    shops: readableShops,
    activeShopId,
    onScopeChange: () => {
      setPurchaseOrderPage(1);
      setSelectedOrderId('');
      setSelectedPurchaseOrderKeys(new Set());
      setCrossBorderReadByOrderId({});
      setPurchaseNotice({ open: false, message: '', severity: 'info' });
      setPurchaseOperation((current) => ({
        ...current,
        open: false,
        order: null,
        orders: [],
        operationId: '',
        loading: false,
        error: '',
      }));
      setTransferPendingDialog({ open: false, order: null });
      setManualClassifyDialog({ open: false, order: null, anchorEl: null, pendingOption: null });
      setManualPurchaseDraft(createManualPurchaseDraftFromOrder());
      setManualPurchaseAnchorEl(null);
    },
  });
  React.useEffect(() => {
    let isMounted = true;
    if (!isActive || !readableShops.length) {
      return () => {
        isMounted = false;
      };
    }
    hydratePurchaseOrderLocalOverridesFromLocalFile()
      .then((overrides) => {
        if (isMounted) setPurchaseLocalOverrides(overrides);
      })
      .catch(() => undefined);
    return () => {
      isMounted = false;
    };
  }, [externalRefreshTick, isActive, readableShops.length, readableShopsSourceKey]);
  React.useEffect(() => {
    if (!isActive) return undefined;
    let disposed = false;
    const handlePurchaseOverrideUpdated = () => {
      hydratePurchaseOrderLocalOverridesFromLocalFile()
        .then((overrides) => { if (!disposed) setPurchaseLocalOverrides(overrides); })
        .catch(() => undefined);
    };
    globalThis.addEventListener?.('wangzai:purchase-order-overrides-updated', handlePurchaseOverrideUpdated);
    return () => {
      disposed = true;
      globalThis.removeEventListener?.('wangzai:purchase-order-overrides-updated', handlePurchaseOverrideUpdated);
    };
  }, [isActive]);
  React.useEffect(() => {
    if (!orderSync.data?.fetchedAt) return;
    const previousRows = previousPurchaseOrderRowsRef.current;
    if (previousRows.length && typeof onOrderNotifications === 'function') {
      const notifications = createOzonOrderChangeNotifications(previousRows, baseOrderRows);
      if (notifications.length) onOrderNotifications(notifications);
    }
    previousPurchaseOrderRowsRef.current = baseOrderRows;
  }, [baseOrderRows, onOrderNotifications, orderSync.data?.fetchedAt]);
  const basePurchaseOrders = React.useMemo(
    () => {
      const storedMaterials = readProductMaterialProfiles();
      const materialProfiles = Object.keys(storedMaterials).length ? storedMaterials : EMPTY_PURCHASE_PROFIT_ROWS;
      return rowMappers.current.normalized(orderRowsForPurchase, readableShopsSourceKey,
        () => [activeShop, purchaseLocalOverrides, purchaseProfitLedgerRowsByKey, shops, materialProfiles], (order) => {
        const normalizedOrder = normalizeOzonSalesRowToPurchaseOrder(order);
        const orderShop = getPurchaseOrderShop(shops, normalizedOrder, activeShop);
        const bindingStartedAt = orderShop?.purchaseManagementStartedAt || '';
        const overrideKey = getPurchaseOrderRecordKey(normalizedOrder);
        const rawOverride = overrideKey
          ? findPurchaseOrderLocalOverride(purchaseLocalOverrides, normalizedOrder, orderShop)
          : null;
        const override =
          rawOverride && typeof rawOverride === 'object' && !Array.isArray(rawOverride)
            ? sanitizePurchaseOrderLocalOverrideForMerge(rawOverride)
            : {};
        const profitLedger = overrideKey
          ? (purchaseProfitLedgerRowsByKey[overrideKey] ?? normalizedOrder.profitLedger)
          : normalizedOrder.profitLedger;
        const orderWithOverrides = clearVoidedPurchaseDisplayFields(
          applyPurchaseManualFallbacks({
            ...normalizedOrder,
            ...override,
            profitLedger,
            purchaseManagementStartedAt: bindingStartedAt,
          }),
          rawOverride,
        );
        const productsWithMaterial = Array.isArray(orderWithOverrides.products)
          ? applyProductMaterialProfiles(orderWithOverrides.products, orderShop)
          : orderWithOverrides.products;
        return annotatePurchaseOrder({
          ...orderWithOverrides,
          products: productsWithMaterial,
        });
      });
    },
    [activeShop, orderRowsForPurchase, purchaseLocalOverrides, purchaseProfitLedgerRowsByKey, shops, readableShopsSourceKey]
  );
  const purchaseOrders = React.useMemo(() => {
    return rowMappers.current.crossBorder(basePurchaseOrders, readableShopsSourceKey,
      order => [crossBorderReadByOrderId[order.id]], (order, [crossBorderRead]) => {
      if (!crossBorderRead) return order;
      const crossBorderVolumeItems = Array.isArray(crossBorderRead.volumeItems) ? crossBorderRead.volumeItems : [];
      const orderVolumeItems = Array.isArray(order.volumeItems) ? order.volumeItems : [];
      const volumeItems = crossBorderVolumeItems.length ? crossBorderVolumeItems : orderVolumeItems;
      const primaryVolumeItem = volumeItems[0] ?? {};
      return annotatePurchaseOrder({
        ...order,
        crossBorderOrderFound: Boolean(
          crossBorderRead.orderId || crossBorderRead.orderItem || order.crossBorderOrderFound
        ),
        crossBorderStatus: crossBorderRead.crossBorderStatus || crossBorderRead.readStatus || order.crossBorderStatus,
        crossBorderOrderCount: crossBorderRead.orderCount || order.crossBorderOrderCount,
        packageOrderIds: crossBorderRead.orderIds?.length ? crossBorderRead.orderIds : order.packageOrderIds,
        packageOrderId: crossBorderRead.orderId || order.packageOrderId,
        packageWeight: firstUsableCrossBorderText(
          primaryVolumeItem.weightText,
          crossBorderRead.packageWeight,
          order.packageWeight
        ),
        packageSize: firstUsableCrossBorderText(
          primaryVolumeItem.sizeText,
          crossBorderRead.packageSize,
          order.packageSize
        ),
        volumeItems,
        readStatus: crossBorderRead.message || crossBorderRead.error || order.readStatus,
        warehouse: crossBorderRead.warehouse || order.warehouse,
        logistics: crossBorderRead.logistics || order.logistics,
        deliveryMethod: crossBorderRead.deliveryMethod || order.deliveryMethod,
        deliveryMethodId: crossBorderRead.deliveryMethodId || order.deliveryMethodId,
        logisticsFreight: crossBorderRead.logisticsFreight || order.logisticsFreight,
        guooFreight: crossBorderRead.guooFreight || order.guooFreight,
        freightCostValue: crossBorderRead.freightCostValue ?? order.freightCostValue,
        freightCost: crossBorderRead.freightCost || order.freightCost,
      });
    });
  }, [basePurchaseOrders, crossBorderReadByOrderId, readableShopsSourceKey]);
  const inputTelemetryRef = React.useRef(null);
  React.useEffect(() => {
    if (!globalThis.__wangzaiRendererTreeTelemetryEnabled) return;
    const inputs = { baseOrderRows, purchaseImageMap, productSummaryEntityMap, purchaseExchangeRateContext,
      orderRowsForPurchase, purchaseLocalOverrides, purchaseProfitLedgerRowsByKey, activeShop, shops,
      basePurchaseOrders, crossBorderReadByOrderId, purchaseOrders };
    const changed = Object.keys(inputs).filter(key => inputTelemetryRef.current?.[key] !== inputs[key]);
    inputTelemetryRef.current = inputs;
    if (changed.length) performance.mark('wangzai-purchase-input-change', { detail: {
      changed, active: isActive, rows: baseOrderRows.length, summaryEntities: productSummaryEntityMap.size,
      realtimeRate: Boolean(purchaseExchangeRateContext.realtime), dailyRates: purchaseExchangeRateContext.dailyRates?.size,
    } });
  });
  const emptyPurchaseOrder = React.useMemo(() => createEmptyPurchaseOrder(activeShop), [activeShop]);

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
    purchaseOrderTimeScope,
    purchaseOrderLocalSnapshotKey,
    orderSync,
    refreshPurchaseOrdersFast,
    purchaseImageMap,
    setPurchaseImageMap,
    purchaseImageErrorText,
    setPurchaseImageErrorText,
    orderRowsWithImages,
    status,
    setStatus,
    shop,
    setShop,
    fulfillment,
    setFulfillment,
    keyword,
    setKeyword,
    purchaseOrderPageSize,
    setPurchaseOrderPageSize,
    purchaseOrderPage,
    setPurchaseOrderPage,
    selectedOrderId,
    setSelectedOrderId,
    selectedPurchaseOrderKeys,
    setSelectedPurchaseOrderKeys,
    crossBorderReadByOrderId,
    setCrossBorderReadByOrderId,
    purchaseNotice,
    setPurchaseNotice,
    purchaseOperation,
    setPurchaseOperation,
    transferPendingDialog,
    setTransferPendingDialog,
    manualClassifyDialog,
    setManualClassifyDialog,
    setPurchaseLocalOverrides,
    manualPurchaseDraft,
    setManualPurchaseDraft,
    manualPurchaseAnchorEl,
    setManualPurchaseAnchorEl,
    handledPurchasePluginCaptureIdsRef,
    purchasePluginLastCaptureAtRef,
    externalRefreshTickRef,
    purchaseOrdersLayoutRef,
    purchaseOrders,
    emptyPurchaseOrder,
  };
}

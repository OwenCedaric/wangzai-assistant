import { getJobStatus, startDomainRefresh } from '../../../../services/ozonSyncClient.js';
import { refreshOzonTimeRangeScope } from '../../../../entities/order/orderShopScope.jsx';
import { invalidateOrderDomainCacheForShop } from '../../../../services/orderCanonicalCacheRuntime.js';
import { clearSalesOrderPagedMemoryCache, invalidateSalesOrderPagedMemoryCache, readSalesOrderPagedCache, resolveSalesOrderShopId } from '../../../../services/salesOrderPagedCacheClient.js';
import { getOzonPushRealtimeShopId, isOzonPushDomainRefreshEvent, OZON_PUSH_REALTIME_BROWSER_EVENT } from '../../../../services/ozonPushRealtime.js';
import React from 'react';

const FINAL_SYNC_STATUSES = new Set(['success', 'partial', 'failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open']);
const FAILED_SYNC_STATUSES = new Set(['failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open']);
const SALES_ORDER_READ_TIMEOUT_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function createProgress(message = '') {
  return { running: false, blocking: false, completed: 0, total: 0, message, errors: [] };
}

function createRefreshTasks(shops = [], timeScope) {
  const dateRange = { since: timeScope?.since || '', to: timeScope?.to || '' };
  return shops.flatMap((shop) => [
    { shop, endpointKey: 'orders.fbsList', label: 'FBS/rFBS 订单列表', params: { filter: dateRange, dir: 'DESC' } },
    { shop, endpointKey: 'orders.fbsUnfulfilledList', label: '待处理 FBS 订单', params: { filter: { ...dateRange, cutoff_from: dateRange.since, cutoff_to: dateRange.to }, dir: 'ASC' } },
    { shop, endpointKey: 'orders.fboList', label: 'FBO 订单列表', params: { filter: dateRange, dir: 'DESC' } },
  ]);
}

function getJobId(payload) {
  return String(payload?.jobId || payload?.job?.jobId || payload?.job?.id || '').trim();
}

/**
 * The sales screen reads only a SQLite page. Ozon synchronization stays a background job
 * and can never turn page rendering back into an all-orders renderer snapshot.
 */
export function useSalesOrderPagedCacheState({
  shops = [],
  timeScope,
  shop = 'all',
  status = 'all',
  fulfillment = 'all',
  keyword = '',
  printShippingFilters = {},
  includePrintShippingFacets = false,
  page = 1,
  pageSize = 20,
  isActive = true,
} = {}) {
  const printShippingWarehouse = String(printShippingFilters?.warehouse ?? '').trim();
  const printShippingDeliveryMethod = String(printShippingFilters?.deliveryMethod ?? '').trim();
  const printShippingDeadlineScope = String(printShippingFilters?.deadlineScope ?? '').trim();
  const printShippingTrackingState = String(printShippingFilters?.trackingState ?? '').trim();
  const printShippingCarriageState = String(printShippingFilters?.carriageState ?? '').trim();
  const [state, setState] = React.useState(() => ({
    data: { rows: [], total: 0, summary: { total: 0, amountTotal: 0, salesStatusCounts: { all: 0 } } },
    loading: false,
    error: null,
    stale: false,
    performance: null,
  }));
  const [progress, setProgress] = React.useState(() => createProgress());
  const requestIdRef = React.useRef(0);
  const refreshRunRef = React.useRef(0);
  const refreshRunningRef = React.useRef(false);
  const [effectiveTimeScope, setEffectiveTimeScope] = React.useState(timeScope);
  React.useEffect(() => {
    setEffectiveTimeScope(timeScope);
  }, [timeScope]);
  const queryInput = React.useMemo(
    () => ({
      shops,
      timeScope: effectiveTimeScope,
      shop,
      status,
      fulfillment,
      keyword,
      printShippingFilters: {
        warehouse: printShippingWarehouse,
        deliveryMethod: printShippingDeliveryMethod,
        deadlineScope: printShippingDeadlineScope,
        trackingState: printShippingTrackingState,
        carriageState: printShippingCarriageState,
      },
      includePrintShippingFacets,
      page,
      pageSize,
    }),
    [
      fulfillment,
      includePrintShippingFacets,
      keyword,
      page,
      pageSize,
      printShippingCarriageState,
      printShippingDeadlineScope,
      printShippingDeliveryMethod,
      printShippingTrackingState,
      printShippingWarehouse,
      shop,
      shops,
      status,
      effectiveTimeScope,
    ]
  );
  const queryKey = React.useMemo(
    () => [
      shops.map((item) => `${item?.id || ''}:${item?.clientId || ''}`).join(','),
      effectiveTimeScope?.cachePart || '', shop, status, fulfillment, keyword.trim(), printShippingWarehouse,
      printShippingDeliveryMethod, printShippingDeadlineScope, printShippingTrackingState,
      printShippingCarriageState, includePrintShippingFacets, page, pageSize,
    ].join('\u0001'),
    [
      fulfillment,
      includePrintShippingFacets,
      keyword,
      page,
      pageSize,
      printShippingCarriageState,
      printShippingDeadlineScope,
      printShippingDeliveryMethod,
      printShippingTrackingState,
      printShippingWarehouse,
      shop,
      shops,
      status,
      effectiveTimeScope?.cachePart,
    ]
  );

  const load = React.useCallback(async ({
    silent = false,
    bypassMemory = false,
    bypassHotCache = false,
    queryOverride = null,
  } = {}) => {
    if (!isActive) return null;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const startedAt = performance.now();
    if (!silent) setState((current) => ({
      ...current,
      loading: true,
      error: null,
      stale: Boolean(current.data?.fetchedAt),
    }));
    try {
      let data;
      try {
        data = await readSalesOrderPagedCache(queryOverride || queryInput, {
          timeoutMs: SALES_ORDER_READ_TIMEOUT_MS,
          bypassMemory,
          bypassHotCache,
        });
      } catch (error) {
        if (error?.code !== 'LOCAL_API_TIMEOUT') throw error;
        await sleep(150);
        data = await readSalesOrderPagedCache(queryOverride || queryInput, {
          timeoutMs: SALES_ORDER_READ_TIMEOUT_MS,
          bypassMemory: true,
          bypassHotCache,
        });
      }
      if (requestId !== requestIdRef.current) return null;
      const durationMs = performance.now() - startedAt;
      setState({
        data: { ...data, fetchedAt: new Date().toISOString(), errors: [] },
        loading: false,
        error: null,
        stale: false,
        performance: { durationMs, source: data.source || 'sqlite', rows: data.rows.length, total: data.total },
      });
      return data;
    } catch (error) {
      if (requestId !== requestIdRef.current) return null;
      setState((current) => ({
        ...current,
        loading: false,
        error,
        stale: Boolean(current.data?.fetchedAt),
        performance: current.performance,
      }));
      throw error;
    }
  }, [isActive, queryInput]);

  React.useEffect(() => {
    if (!isActive) return undefined;
    load().catch(() => undefined);
    return () => {
      requestIdRef.current += 1;
    };
  }, [isActive, load, queryKey]);

  React.useEffect(() => {
    const readableShopIds = new Set(shops.map((item) => String(item?.id || '').trim()).filter(Boolean));
    const handleOzonPushRefresh = (event) => {
      if (!isOzonPushDomainRefreshEvent(event, 'orders')) return;
      const shopId = getOzonPushRealtimeShopId(event);
      if (!shopId || !readableShopIds.has(shopId)) return;
      const selectedShopId = resolveSalesOrderShopId(shops, shop);
      if (selectedShopId && selectedShopId !== shopId) return;
      invalidateSalesOrderPagedMemoryCache({ shopId });
      invalidateOrderDomainCacheForShop('orders', shopId);
      if (isActive) void load({ silent: true, bypassMemory: true }).catch(() => undefined);
    };
    globalThis.addEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOzonPushRefresh);
    return () => globalThis.removeEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOzonPushRefresh);
  }, [isActive, load, shop, shops]);

  const refresh = React.useCallback(async ({ background = false } = {}) => {
    if (refreshRunningRef.current) return null;
    refreshRunningRef.current = true;
    try {
      const runId = refreshRunRef.current + 1;
      refreshRunRef.current = runId;
      const refreshedTimeScope = refreshOzonTimeRangeScope(effectiveTimeScope);
      const refreshedQueryInput = { ...queryInput, timeScope: refreshedTimeScope };
      setEffectiveTimeScope(refreshedTimeScope);
      clearSalesOrderPagedMemoryCache();
      const tasks = createRefreshTasks(shops, refreshedTimeScope);
      if (!tasks.length) {
        return load({
          silent: background,
          bypassMemory: true,
          bypassHotCache: true,
          queryOverride: refreshedQueryInput,
        });
      }
      setProgress({
        running: true,
        blocking: !background,
        completed: 0,
        total: tasks.length,
        message: '销售订单同步已提交 Ozon，页面继续读取 SQLite 缓存。',
        errors: [],
      });
      const submitted = await Promise.allSettled(
        tasks.map((task) =>
          startDomainRefresh('orders', {
            shopId: task.shop.id,
            endpointKey: task.endpointKey,
            action: 'sync-orders-list',
            params: task.params,
            pageSize: 1000,
            maxPages: 100,
            forceRefresh: true,
            requestedBy: background ? 'frontend-sales-orders-background-refresh' : 'frontend-sales-orders-manual-refresh',
          }, { timeoutMs: 5_000 })
        )
      );
      const jobs = submitted.map((result, index) => ({
        label: tasks[index].label,
        jobId: result.status === 'fulfilled' ? getJobId(result.value) : '',
        error: result.status === 'rejected' ? result.reason : result.value?.accepted === false ? result.value?.error : null,
      }));
      const pendingIds = jobs.map((item) => item.jobId).filter(Boolean);
      const errors = jobs.map((item) => item.error?.message || item.error).filter(Boolean).map(String);
      const deadline = Date.now() + 180_000;
      let completed = jobs.length - pendingIds.length;
      while (pendingIds.length && Date.now() < deadline && refreshRunRef.current === runId) {
        const statuses = await Promise.all(pendingIds.map((jobId) => getJobStatus(jobId, { timeoutMs: 10_000 }).catch(() => null)));
        const activeIds = [];
        statuses.forEach((job, index) => {
          const syncJob = job?.job || job || {};
          const state = String(syncJob.status || '').trim();
          if (FINAL_SYNC_STATUSES.has(state)) {
            completed += 1;
            if (FAILED_SYNC_STATUSES.has(state)) errors.push(syncJob.lastError || `${jobs.find((item) => item.jobId === pendingIds[index])?.label || '订单同步'}失败`);
          } else {
            activeIds.push(pendingIds[index]);
          }
        });
        pendingIds.splice(0, pendingIds.length, ...activeIds);
        setProgress({
          running: pendingIds.length > 0,
          blocking: !background,
          completed: Math.min(completed, jobs.length),
          total: jobs.length,
          message: pendingIds.length ? `后台正在同步 Ozon 销售订单：${Math.min(completed, jobs.length)}/${jobs.length}` : errors.length ? '销售订单同步结束，部分接口失败，已保留 SQLite 缓存。' : '销售订单同步完成，SQLite 已合并。',
          errors: errors.slice(0, 3),
        });
        if (pendingIds.length) await sleep(1_000);
      }
      if (refreshRunRef.current !== runId) return null;
      if (pendingIds.length) {
        errors.push('订单同步仍在后台执行，已继续显示 SQLite 缓存。');
      }
      setProgress({
        running: pendingIds.length > 0,
        blocking: false,
        completed: Math.min(completed, jobs.length),
        total: jobs.length,
        message: pendingIds.length ? '销售订单同步仍在后台执行，页面继续读取 SQLite 缓存。' : errors.length ? '销售订单同步结束，部分接口失败，已保留 SQLite 缓存。' : '销售订单同步完成，SQLite 已合并。',
        errors: errors.slice(0, 3),
      });
      const result = await load({
        silent: background,
        bypassMemory: true,
        bypassHotCache: true,
        queryOverride: refreshedQueryInput,
      });
      return errors.length ? null : result;
    } finally {
      refreshRunningRef.current = false;
    }
  }, [effectiveTimeScope, load, queryInput, shops]);

  return { ...state, paged: true, refresh, progress };
}

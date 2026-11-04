import { canUseOzonShop, getOzonShopLabel } from '../../../entities/order/orderShopScope.jsx';
import {
  clearProductListCacheForShop,
  createEmptyProductStatusCounts,
  getProductListPageCacheKeyForScopeKey,
  getProductListServerSort,
  mapProductCacheCountsToStatusLabels,
  PRODUCT_LIST_CACHE_TTL_MS,
  PRODUCT_MANUAL_REFRESH_SYNC_MAX_PAGES,
  productListMemoryCache,
  productListPageMetaMemoryCache,
  readTimedCacheCandidates,
  writeProductListPageMemoryCache,
} from '../../../entities/product/productLocalData.jsx';
import { normalizeProductListQueryFilters } from '../../../entities/product/productListQuery.jsx';
import {
  prefetchLocalApiProductNeighborPages,
  readLocalApiProductPage,
} from '../../../entities/product/productLocalMirror.jsx';
import { readRubCnyExchangeRateContext } from '../../../services/exchangeRateClient';
import { getProductListSyncJobs, startProductListSync } from '../../../services/productListSyncClient';
import { getPerformanceNow } from '../../../shared/config/appConfigRuntime.jsx';
import {
  getOzonPushRealtimeShopId,
  isOzonPushDomainRefreshEvent,
  OZON_PUSH_REALTIME_BROWSER_EVENT,
} from '../../../services/ozonPushRealtime.js';
import { countRowsImages, productStatusTabs } from '../../../shared/ozon/ozonRuntime.jsx';
import { measureRouteRenderPhase } from '../../../app/performance/routeModuleLoadTelemetry.js';
import {
  applyProductFeeExchangeRateToRows,
  getProductFeeRubToCnyRate,
  setProductFeeRubToCnyRate,
} from '../lib/productEditing.jsx';
import React from 'react';

function isProductRefreshFailedStatus(status) {
  return ['failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open', 'timeout'].includes(String(status || ''));
}

const PRODUCT_REFRESH_FINAL_STATUSES = new Set([
  'success',
  'partial',
  'failed',
  'canceled',
  'blocked',
  'rate_limited',
  'circuit_open',
]);

const PRODUCT_MANUAL_REFRESH_CURRENT_HYDRATION_CONCURRENCY = 8;
const PRODUCT_MANUAL_REFRESH_FULL_HYDRATION_CONCURRENCY = 12;
const PRODUCT_MANUAL_REFRESH_ENRICH_HYDRATION_CONCURRENCY = 2;
const PRODUCT_MANUAL_REFRESH_SYNC_PAGE_SIZE = 1000;
const PRODUCT_MANUAL_REFRESH_CORE_HYDRATION_BATCH_SIZE = 1000;
const PRODUCT_MANUAL_REFRESH_FAST_HYDRATION_MODE = 'fast';
const PRODUCT_MANUAL_REFRESH_FOREGROUND_WAIT_TIMEOUT_MS = 30_000;
const PRODUCT_MANUAL_REFRESH_FULL_PRIORITY = 'P1';
const PRODUCT_MANUAL_REFRESH_FULL_PROFILE = 'foreground';
const PRODUCT_MANUAL_REFRESH_ENRICH_PRIORITY = 'P4';
const PRODUCT_MANUAL_REFRESH_ENRICH_PROFILE = 'background';
const PRODUCT_MANUAL_REFRESH_ARCHIVED_VISIBILITY = 'ARCHIVED';
const PRODUCT_MANUAL_REFRESH_FOREGROUND_VISIBILITIES = Object.freeze([
  'ALL',
  'IN_SALE',
  'TO_SUPPLY',
  'STATE_FAILED',
  'VALIDATION_STATE_FAIL',
  'REMOVED_FROM_SALE',
]);
const PRODUCT_MANUAL_REFRESH_ARCHIVED_PRIORITY = 'P4';
const PRODUCT_MANUAL_REFRESH_ARCHIVED_PROFILE = 'background';
const PRODUCT_FEE_EXCHANGE_RATE_TIMEOUT_MS = 8000;
const PRODUCT_FEE_EXCHANGE_RATE_LOOKBACK_DAYS = 30;

function measureProductPageLoadPhase(phase, startedAt, endedAt = getPerformanceNow()) {
  if (globalThis.__wangzaiRendererTreeTelemetryEnabled !== true) return null;
  return measureRouteRenderPhase('products', phase, startedAt, { endedAt });
}

async function readProductFeeRubToCnyRate() {
  const cachedRate = getProductFeeRubToCnyRate();
  if (cachedRate) return cachedRate;
  const context = await readRubCnyExchangeRateContext([], {
    timeoutMs: PRODUCT_FEE_EXCHANGE_RATE_TIMEOUT_MS,
    maxLookbackDays: PRODUCT_FEE_EXCHANGE_RATE_LOOKBACK_DAYS,
  });
  return setProductFeeRubToCnyRate(context?.realtime?.rubToCnyRate);
}

function collectProductRefreshJobIds(payload) {
  const ids = [];
  const pushId = (value) => {
    const text = String(value || '').trim();
    if (text) ids.push(text);
  };
  pushId(payload?.jobId);
  pushId(payload?.job?.jobId || payload?.job?.id);
  if (Array.isArray(payload?.jobIds)) payload.jobIds.forEach(pushId);
  if (Array.isArray(payload?.jobs)) {
    payload.jobs.forEach((job) => {
      pushId(job?.jobId || job?.id);
    });
  }
  return [...new Set(ids)];
}

function isProductRefreshFinalStatus(status) {
  return PRODUCT_REFRESH_FINAL_STATUSES.has(String(status || ''));
}

function getProductRefreshProgressValue(job, field, fallback = 0) {
  const value = job?.progress?.[field] ?? job?.[`progress${field[0].toUpperCase()}${field.slice(1)}`];
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function sleepProductRefresh(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, ms));
  });
}

async function waitForProductRefreshJobs({
  jobIds,
  refreshRunId,
  productRefreshRunRef,
  setProductRefreshProgress,
  timeoutMs = 180_000,
  pendingAsFailed = true,
}) {
  const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (ids.length === 0) return { timedOut: false, failedCount: 0, finalCount: 0, totalJobs: 0 };

  const startedAt = Date.now();
  const intervalMs = 1_000;
  let lastFailedCount = 0;
  let lastFinalCount = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    if (productRefreshRunRef.current !== refreshRunId) {
      return {
        canceled: true,
        timedOut: false,
        failedCount: lastFailedCount,
        finalCount: lastFinalCount,
        totalJobs: ids.length,
      };
    }

    let jobsById = new Map();
    try {
      const payload = await getProductListSyncJobs(ids, { timeoutMs: 10_000 });
      jobsById = new Map((Array.isArray(payload?.jobs) ? payload.jobs : []).map((job) => [job?.jobId || job?.id, job]));
    } catch {
      setProductRefreshProgress((current) => ({
        ...current,
        running: true,
        total: Math.max(current.total || 0, ids.length),
        completed: Math.min(current.completed || 0, Math.max(current.total || ids.length, ids.length)),
        message: '后台商品同步仍在进行，正在等待 local-api 返回进度。',
      }));
      await sleepProductRefresh(intervalMs);
      continue;
    }
    let progressDone = 0;
    let progressTotal = 0;
    let finalCount = 0;
    let failedCount = 0;

    ids.forEach((jobId) => {
      const job = jobsById.get(jobId) || null;
      const status = job?.status || 'unknown';
      const isFinal = isProductRefreshFinalStatus(status);
      const jobTotal = getProductRefreshProgressValue(job, 'total', 0);
      const jobDone = getProductRefreshProgressValue(job, 'done', 0);
      const safeTotal = jobTotal > 0 ? jobTotal : 1;

      progressTotal += safeTotal;
      progressDone += isFinal ? safeTotal : Math.min(jobDone, safeTotal);
      if (isFinal) finalCount += 1;
      if (isProductRefreshFailedStatus(status)) failedCount += 1;
    });

    lastFailedCount = failedCount;
    lastFinalCount = finalCount;
    setProductRefreshProgress((current) => ({
      ...current,
      running: true,
      total: Math.max(progressTotal, ids.length),
      completed: Math.min(progressDone, Math.max(progressTotal, ids.length)),
      errors: failedCount,
      message:
        finalCount >= ids.length
          ? '后台商品同步已完成，正在统一读取 SQLite 最新快照。'
          : `后台正在同步 Ozon 商品：${progressDone}/${Math.max(progressTotal, ids.length)}`,
    }));

    if (finalCount >= ids.length) {
      return { timedOut: false, failedCount, finalCount, totalJobs: ids.length };
    }
    await sleepProductRefresh(intervalMs);
  }

  return {
    timedOut: true,
    failedCount: lastFailedCount + (pendingAsFailed ? Math.max(ids.length - lastFinalCount, 0) : 0),
    finalCount: lastFinalCount,
    totalJobs: ids.length,
  };
}

export function useProductSyncState({
  isActive,
  activityRuntime = null,
  loadRequestRef,
  loadAbortRef,
  setProductLoadError,
  setLoading,
  setProductPageLoading,
  status,
  keyword,
  pageSize,
  page,
  productSort,
  productListQueryFilters = {},
  productListQueryFilterSignature = '',
  productMirrorScopeShops,
  setLocalProductMirrorStatusCounts,
  productMirrorScopeKey,
  setProducts,
  setLocalProductServerPageMeta,
  setProductPerformance,
  productRefreshProgress,
  productRefreshRunRef,
  setProductRefreshToken,
  setProductRefreshProgress,
  productRefreshToken,
} = {}) {
  const productPageLoadKeyRef = React.useRef('');
  const productPageLoadPendingKeyRef = React.useRef('');
  const productPageLoadAttemptRef = React.useRef(0);
  const resumeActiveWorkRef = React.useRef(() => undefined);
  const isActiveRef = React.useRef(isActive);
  if (!activityRuntime) isActiveRef.current = isActive;
  React.useEffect(() => {
    const applyActivity = (nextActive) => {
      isActiveRef.current = nextActive;
      if (!nextActive) {
        productPageLoadAttemptRef.current += 1;
        productPageLoadPendingKeyRef.current = '';
        loadAbortRef.current?.abort();
        return;
      }
      resumeActiveWorkRef.current();
    };
    if (activityRuntime?.subscribe) return activityRuntime.subscribe(applyActivity);
    applyActivity(isActive);
    return undefined;
  }, [activityRuntime, isActive, loadAbortRef]);
  const normalizedProductListQueryFilters = React.useMemo(
    () => normalizeProductListQueryFilters(productListQueryFilters),
    [productListQueryFilters]
  );
  const productPageLoadKey = [
    'sqlite',
    productMirrorScopeKey,
    status,
    keyword.trim(),
    page,
    pageSize,
    productSort?.key || '',
    productSort?.direction || '',
    productListQueryFilterSignature,
    productRefreshToken,
  ].join('\u0001');
  const loadOzonProducts = React.useCallback(
    async (options = {}) => {
      if (!isActiveRef.current) return;
      const startedAt = getPerformanceNow();
      measureProductPageLoadPhase('local-load-start', startedAt, startedAt);
      const force = Boolean(options.force);
      const requestId = loadRequestRef.current + 1;
      loadRequestRef.current = requestId;
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      const requestSignal = controller.signal;
      const isCurrentRequest = () => loadRequestRef.current === requestId;

      const localApiTargets = productMirrorScopeShops.filter((item) => item?.id);
      if (!localApiTargets.length) {
        setProductLoadError('');
        setLoading(false);
        setProductPageLoading(false);
        return;
      }

      const selectedTab = productStatusTabs.find((tab) => tab.label === status) ?? productStatusTabs[0];
      const keywordQuery = keyword.trim();
      const serverSort = getProductListServerSort(productSort);
      const listCacheKey = getProductListPageCacheKeyForScopeKey(
        productMirrorScopeKey,
        selectedTab.visibility,
        pageSize,
        page,
        keywordQuery,
        serverSort,
        productListQueryFilterSignature
      );
      const listCacheKeys = [listCacheKey];
      const productFeeRatePromise = readProductFeeRubToCnyRate().catch(() => null);
      const queueProductFeeExchangeRateMerge = (rowsForCache = null, pageMeta = null) => {
        productFeeRatePromise.then((rubToCnyRate) => {
          if (!rubToCnyRate) return;
          setProducts((currentRows) => applyProductFeeExchangeRateToRows(currentRows, rubToCnyRate));
          if (!isCurrentRequest()) return;
          if (Array.isArray(rowsForCache) && pageMeta) {
            writeProductListPageMemoryCache(
              listCacheKey,
              applyProductFeeExchangeRateToRows(rowsForCache, rubToCnyRate),
              pageMeta
            );
          }
        });
      };
      const localStart = getPerformanceNow();
      const cachedRows = force
        ? null
        : readTimedCacheCandidates(productListMemoryCache, listCacheKeys, PRODUCT_LIST_CACHE_TTL_MS);
      const cachedPageMeta = cachedRows
        ? readTimedCacheCandidates(productListPageMetaMemoryCache, listCacheKeys, PRODUCT_LIST_CACHE_TTL_MS)
        : null;
      let localSnapshot = null;
      let localRows = null;
      let localApiServerPageMeta = null;
      if (!cachedRows) {
        const localApiReadStartedAt = getPerformanceNow();
        const localApiPage = await readLocalApiProductPage(localApiTargets, selectedTab, {
          pageSize,
          page,
          keyword: keywordQuery,
          sort: serverSort,
          filters: normalizedProductListQueryFilters,
          rubToCnyRate: getProductFeeRubToCnyRate(),
          signal: requestSignal,
        }).catch(() => null);
        const localApiReadFinishedAt = getPerformanceNow();
        measureProductPageLoadPhase('local-api-read', localApiReadStartedAt, localApiReadFinishedAt);
        if (!isCurrentRequest()) return;
        const localApiRows = Array.isArray(localApiPage?.rows) ? localApiPage.rows : null;
        if (localApiRows) {
          localRows = localApiRows;
          const localApiStatusCounts = createEmptyProductStatusCounts();
          const pageCounts = mapProductCacheCountsToStatusLabels(localApiPage?.counts);
          productStatusTabs.forEach((tab) => {
            localApiStatusCounts[tab.label] = Number(pageCounts[tab.label]) || 0;
          });
          if (localApiPage?.counts && typeof localApiPage.counts === 'object') {
            setLocalProductMirrorStatusCounts({ scopeKey: productMirrorScopeKey, counts: localApiStatusCounts });
          }
          localSnapshot = {
            rows: localRows,
            total: Number(localApiPage?.total) || 0,
            page,
            pageSize,
            sort: serverSort,
            filterSignature: productListQueryFilterSignature,
            statusCounts: localApiStatusCounts,
            source: 'sqlite',
            fetchedAt: new Date().toISOString(),
          };
          localApiServerPageMeta = {
            scopeKey: productMirrorScopeKey,
            status: selectedTab.label,
            keyword: keywordQuery,
            page,
            pageSize,
            sort: serverSort,
            filterSignature: productListQueryFilterSignature,
            statusCounts: localApiStatusCounts,
            total: localSnapshot.total,
            source: 'sqlite',
          };
          prefetchLocalApiProductNeighborPages(localApiTargets, selectedTab, {
            page,
            pageSize,
            keyword: keywordQuery,
            total: localSnapshot.total,
            sort: serverSort,
            filters: normalizedProductListQueryFilters,
          });
        }
        measureProductPageLoadPhase('local-page-prep', localApiReadFinishedAt);
      }
      const localMs = getPerformanceNow() - localStart;

      setProductLoadError('');
      if (cachedRows) {
        const cachedProfileRows = cachedRows;
        const hasMatchingCachedPageMeta = Boolean(
          cachedPageMeta &&
          cachedPageMeta.status === selectedTab.label &&
          cachedPageMeta.keyword === keywordQuery &&
          cachedPageMeta.sort === serverSort &&
          cachedPageMeta.filterSignature === productListQueryFilterSignature &&
          Number(cachedPageMeta.page) === Number(page) &&
          Number(cachedPageMeta.pageSize) === Number(pageSize)
        );
        const cachedTotal = hasMatchingCachedPageMeta
          ? Math.max(0, Number(cachedPageMeta.total) || 0)
          : Math.max(
            cachedProfileRows.length,
            (Math.max(Number(page) || 1, 1) - 1) * pageSize + cachedProfileRows.length
          );
        setProducts(cachedProfileRows);
        if (cachedPageMeta?.statusCounts && typeof cachedPageMeta.statusCounts === 'object') {
          setLocalProductMirrorStatusCounts({
            scopeKey: productMirrorScopeKey,
            counts: cachedPageMeta.statusCounts,
          });
        }
        queueProductFeeExchangeRateMerge(cachedProfileRows, {
          scopeKey: productMirrorScopeKey,
          status: selectedTab.label,
          keyword: keywordQuery,
          page,
          pageSize,
          sort: serverSort,
          filterSignature: productListQueryFilterSignature,
          statusCounts: cachedPageMeta?.statusCounts || null,
          total: cachedTotal,
          source: 'memory-cache',
        });
        setLocalProductServerPageMeta({
          scopeKey: productMirrorScopeKey,
          status: selectedTab.label,
          keyword: keywordQuery,
          page,
          pageSize,
          sort: serverSort,
          filterSignature: productListQueryFilterSignature,
          statusCounts: cachedPageMeta?.statusCounts || null,
          total: cachedTotal,
          source: 'memory-cache',
        });
        const imageStart = getPerformanceNow();
        const cachedImageCount = countRowsImages(cachedRows);
        setProductPerformance({
          eventId: `商品列表:${Date.now()}:cache`,
          startedAt,
          localMs,
          ozonMs: 0,
          processingMs: 0,
          imageMs: getPerformanceNow() - imageStart,
          rows: cachedRows.length,
          imageCount: cachedImageCount,
          apiCount: 0,
        });
      } else if (localRows) {
        const localRowsPageMeta = localApiServerPageMeta || {
          scopeKey: productMirrorScopeKey,
          status: selectedTab.label,
          keyword: keywordQuery,
          page,
          pageSize,
          sort: serverSort,
          filterSignature: productListQueryFilterSignature,
          total: localRows.length,
          source: 'local',
        };
        writeProductListPageMemoryCache(listCacheKey, localRows, localRowsPageMeta);
        setProducts(localRows);
        queueProductFeeExchangeRateMerge(localRows, localRowsPageMeta);
        setLocalProductServerPageMeta(
          localApiServerPageMeta || {
            scopeKey: '',
            status: '',
            keyword: '',
            page: 1,
            pageSize,
            sort: serverSort,
            filterSignature: productListQueryFilterSignature,
            total: 0,
            source: '',
          }
        );
        const imageStart = getPerformanceNow();
        const localImageCount = countRowsImages(localRows);
        setProductPerformance({
          eventId: `商品列表:${Date.now()}:sqlite`,
          startedAt,
          localMs,
          ozonMs: 0,
          processingMs: 0,
          imageMs: getPerformanceNow() - imageStart,
          rows: localRows.length,
          imageCount: localImageCount,
          apiCount: 0,
        });
      }
      if (!cachedRows && !localRows) {
        setLocalProductServerPageMeta({
          scopeKey: '',
          status: '',
          keyword: '',
          page: 1,
          pageSize,
          sort: serverSort,
          filterSignature: productListQueryFilterSignature,
          total: 0,
          source: '',
        });
      }
      if (!cachedRows && !localRows) {
        setProducts([]);
        setProductLoadError('本地商品数据读取失败，请稍后重试。');
      }
      setLoading(false);
      setProductPageLoading(false);
      return {
        hasLocalData: Boolean(cachedRows || localRows),
        source: cachedRows ? 'memory-cache' : localRows ? localApiServerPageMeta?.source || 'sqlite' : 'empty',
      };
    },
    [
      keyword,
      page,
      pageSize,
      productSort,
      productListQueryFilterSignature,
      productMirrorScopeKey,
      productMirrorScopeShops,
      status,
      loadAbortRef,
      loadRequestRef,
      setLoading,
      setLocalProductMirrorStatusCounts,
      setLocalProductServerPageMeta,
      setProductLoadError,
      setProductPageLoading,
      setProductPerformance,
      setProducts,
      normalizedProductListQueryFilters,
    ]
  );
  const ensureProductPageLoaded = React.useCallback(() => {
    if (!isActiveRef.current) return;
    if (productPageLoadKeyRef.current === productPageLoadKey) return;
    if (productPageLoadPendingKeyRef.current === productPageLoadKey) return;
    const attemptId = productPageLoadAttemptRef.current + 1;
    productPageLoadAttemptRef.current = attemptId;
    productPageLoadPendingKeyRef.current = productPageLoadKey;
    void loadOzonProducts({ localOnly: true })
      .then(() => {
        if (productPageLoadAttemptRef.current !== attemptId || !isActiveRef.current) return;
        // Opening the page is a pure SQLite query. Bootstrap/full sync is an
        // explicit account lifecycle or user refresh action, never a page side effect.
        productPageLoadKeyRef.current = productPageLoadKey;
      })
      .finally(() => {
        if (productPageLoadPendingKeyRef.current === productPageLoadKey) {
          productPageLoadPendingKeyRef.current = '';
        }
      });
  }, [loadOzonProducts, productPageLoadKey]);
  resumeActiveWorkRef.current = ensureProductPageLoaded;
  const handleRefreshProducts = React.useCallback(() => {
    if (productRefreshProgress.blocking) return;
    const refreshRunId = productRefreshRunRef.current + 1;
    productRefreshRunRef.current = refreshRunId;
    const syncTargets = productMirrorScopeShops.filter(canUseOzonShop);
    if (syncTargets.length === 0) {
      setProductRefreshProgress({
        running: false,
        blocking: false,
        total: 0,
        completed: 0,
        errors: 0,
        message: '没有可读取的 Ozon 店铺，已改为读取本地缓存。',
      });
      loadOzonProducts({ localOnly: true });
      return;
    }
    const refreshTasks = syncTargets.map((shop) => ({
      shop,
      label: getOzonShopLabel(shop),
    }));
    const selectedTab = productStatusTabs.find((tab) => tab.label === status) || productStatusTabs[0];
    const currentVisibility = selectedTab?.visibility || 'ALL';
    const foregroundVisibilities =
      currentVisibility === PRODUCT_MANUAL_REFRESH_ARCHIVED_VISIBILITY
        ? [...PRODUCT_MANUAL_REFRESH_FOREGROUND_VISIBILITIES, PRODUCT_MANUAL_REFRESH_ARCHIVED_VISIBILITY]
        : PRODUCT_MANUAL_REFRESH_FOREGROUND_VISIBILITIES;
    const shouldSubmitCurrentViewRefresh = currentVisibility !== 'ALL';
    const foregroundHydrateLimit = Math.max(Number(pageSize) || 20, 20);
    setProductRefreshProgress({
      running: true,
      blocking: true,
      total: refreshTasks.length,
      completed: 0,
      errors: 0,
      message: `准备提交商品后台刷新，共 ${refreshTasks.length} 个店铺；页面继续读取 SQLite 缓存。`,
    });
    const startBackgroundProductEnrichment = () => {
      if (productRefreshRunRef.current !== refreshRunId) return;
      Promise.allSettled(
        refreshTasks.map((task) =>
          startProductListSync(
            {
              shopId: task.shop.id,
              visibility: 'ALL',
              pageSize: PRODUCT_MANUAL_REFRESH_SYNC_PAGE_SIZE,
              maxPages: PRODUCT_MANUAL_REFRESH_SYNC_MAX_PAGES,
              hydrate: true,
              hydrationConcurrency: PRODUCT_MANUAL_REFRESH_ENRICH_HYDRATION_CONCURRENCY,
              hydrationMode: 'full',
              forceRefresh: true,
              priority: PRODUCT_MANUAL_REFRESH_ENRICH_PRIORITY,
              profile: PRODUCT_MANUAL_REFRESH_ENRICH_PROFILE,
              schedulerProfile: PRODUCT_MANUAL_REFRESH_ENRICH_PROFILE,
              source: 'manual-product-refresh-enrich-background',
              syncSource: 'manual-product-refresh-enrich-background',
              requestedBy: 'frontend-product-refresh-enrich-background',
            },
            { timeoutMs: 5000 }
          )
        )
      ).catch(() => undefined);
    };
    const startBackgroundArchivedStatusSync = () => {
      if (productRefreshRunRef.current !== refreshRunId) return;
      Promise.allSettled(
        refreshTasks.map((task) =>
          startProductListSync(
            {
              shopId: task.shop.id,
              visibility: PRODUCT_MANUAL_REFRESH_ARCHIVED_VISIBILITY,
              pageSize: PRODUCT_MANUAL_REFRESH_SYNC_PAGE_SIZE,
              maxPages: PRODUCT_MANUAL_REFRESH_SYNC_MAX_PAGES,
              // 已下架商品同样必须完成五类补水；列表接口只返回基础标识，
              // 编辑页所需详情、图片、价格、库存、属性与材积必须全部重建。
              hydrate: true,
              hydrationMode: 'full',
              hydrationConcurrency: PRODUCT_MANUAL_REFRESH_ENRICH_HYDRATION_CONCURRENCY,
              hydrationBatchSize: 100,
              forceRefresh: true,
              priority: PRODUCT_MANUAL_REFRESH_ARCHIVED_PRIORITY,
              profile: PRODUCT_MANUAL_REFRESH_ARCHIVED_PROFILE,
              schedulerProfile: PRODUCT_MANUAL_REFRESH_ARCHIVED_PROFILE,
              source: 'manual-product-refresh-archived-background',
              syncSource: 'manual-product-refresh-archived-background',
              requestedBy: 'frontend-product-refresh-archived-background',
            },
            { timeoutMs: 5000 }
          )
        )
      )
        .then(async (results) => {
          if (productRefreshRunRef.current !== refreshRunId) return;
          const jobIds = results.flatMap((item) =>
            item.status === 'fulfilled' ? collectProductRefreshJobIds(item.value) : []
          );
          if (jobIds.length === 0) return;

          setProductRefreshProgress((current) => ({
            ...current,
            running: true,
            blocking: false,
            total: jobIds.length,
            completed: 0,
            message: '正在补齐已下架商品的详情、图片、价格库存、属性与材积，请继续读取 SQLite 缓存。',
          }));
          const waitResult = await waitForProductRefreshJobs({
            jobIds,
            refreshRunId,
            productRefreshRunRef,
            setProductRefreshProgress,
            timeoutMs: 90_000,
            pendingAsFailed: false,
          });
          if (productRefreshRunRef.current !== refreshRunId || waitResult.canceled) return;

          productMirrorScopeShops.forEach(clearProductListCacheForShop);
          setProductRefreshToken((value) => value + 1);
          await loadOzonProducts({ localOnly: true });
          if (productRefreshRunRef.current !== refreshRunId) return;
          setProductRefreshProgress((current) => ({
            ...current,
            running: false,
            blocking: false,
            completed: current.total || jobIds.length,
            errors: current.errors + waitResult.failedCount,
            message: waitResult.timedOut
              ? '已下架商品详情仍在后台补齐，页面已先按 SQLite 当前快照刷新。'
              : waitResult.failedCount > 0
                ? '已下架商品详情补齐结束，但部分任务失败；页面已保留 Ozon 已返回数据。'
                : '已下架商品名称、图片和类目已按 Ozon 最新快照补齐。',
          }));
        })
        .catch(() => undefined);
    };
    Promise.allSettled(
      refreshTasks
        .flatMap((task) => {
          const tasks = [];
          if (shouldSubmitCurrentViewRefresh) {
            tasks.push(async () => {
              if (productRefreshRunRef.current !== refreshRunId) return null;
              setProductRefreshProgress((current) => ({
                ...current,
                running: true,
                blocking: true,
                message: `正在提交当前视图快速刷新：${task.label}`,
              }));
              const result = await startProductListSync(
                {
                  shopId: task.shop.id,
                  visibility: currentVisibility,
                  pageSize: PRODUCT_MANUAL_REFRESH_SYNC_PAGE_SIZE,
                  maxPages: 1,
                  hydrate: true,
                  maxHydrateProducts: foregroundHydrateLimit,
                  hydrationConcurrency: PRODUCT_MANUAL_REFRESH_CURRENT_HYDRATION_CONCURRENCY,
                  hydrationMode: PRODUCT_MANUAL_REFRESH_FAST_HYDRATION_MODE,
                  hydrationBatchSize: PRODUCT_MANUAL_REFRESH_CORE_HYDRATION_BATCH_SIZE,
                  forceRefresh: true,
                  priority: 'P1',
                  profile: 'foreground',
                  schedulerProfile: 'foreground',
                  requestedBy: 'frontend-product-refresh-current-foreground',
                },
                { timeoutMs: 5000 }
              );
              const accepted = result?.accepted === true || result?.ok === true;
              const finalStatus = result?.status || result?.job?.status || (accepted ? 'queued' : 'failed');
              return {
                result,
                failed: !accepted || isProductRefreshFailedStatus(finalStatus),
                kind: 'current',
                label: task.label,
              };
            });
          }
          tasks.push(async () => {
            if (productRefreshRunRef.current !== refreshRunId) return null;
            setProductRefreshProgress((current) => ({
              ...current,
              running: true,
              blocking: true,
              message: `正在提交前台核心同步：${task.label}`,
            }));
            const result = await startProductListSync(
              {
                shopId: task.shop.id,
                allStatuses: true,
                visibilities: foregroundVisibilities,
                pageSize: PRODUCT_MANUAL_REFRESH_SYNC_PAGE_SIZE,
                maxPages: PRODUCT_MANUAL_REFRESH_SYNC_MAX_PAGES,
                hydrate: true,
                hydrationConcurrency: PRODUCT_MANUAL_REFRESH_FULL_HYDRATION_CONCURRENCY,
                hydrationMode: PRODUCT_MANUAL_REFRESH_FAST_HYDRATION_MODE,
                hydrationBatchSize: PRODUCT_MANUAL_REFRESH_CORE_HYDRATION_BATCH_SIZE,
                forceRefresh: true,
                priority: PRODUCT_MANUAL_REFRESH_FULL_PRIORITY,
                profile: PRODUCT_MANUAL_REFRESH_FULL_PROFILE,
                schedulerProfile: PRODUCT_MANUAL_REFRESH_FULL_PROFILE,
                source: 'manual-product-refresh-background',
                syncSource: 'manual-product-refresh-background',
                requestedBy: 'frontend-product-refresh-full-background',
              },
              { timeoutMs: 5000 }
            );
            const accepted = result?.accepted === true || result?.ok === true;
            const finalStatus = result?.status || result?.job?.status || (accepted ? 'queued' : 'failed');
            return {
              result,
              failed: !accepted || isProductRefreshFailedStatus(finalStatus),
              kind: 'background',
              label: task.label,
            };
          });
          return tasks;
        })
        .map((submitTask) => submitTask())
    )
      .then((results) => {
        if (productRefreshRunRef.current !== refreshRunId) return null;
        const failedCount = results.filter((item) => item.status === 'rejected' || item.value?.failed).length;
        const jobIds = results.flatMap((item) =>
          item.status === 'fulfilled' ? collectProductRefreshJobIds(item.value?.result) : []
        );
        void loadOzonProducts({ localOnly: true });
        setProductRefreshProgress((current) => ({
          ...current,
          running: jobIds.length > 0,
          blocking: false,
          errors: current.errors + failedCount,
          total: jobIds.length || current.total || refreshTasks.length,
          completed: 0,
          message: jobIds.length
            ? `商品核心同步已提交后台，页面继续显示 SQLite 缓存；前台任务 ${jobIds.length} 个。`
            : '后台全量刷新未返回可轮询任务，页面已保留当前缓存。',
        }));
        if (jobIds.length === 0) return;
        waitForProductRefreshJobs({
          jobIds,
          refreshRunId,
          productRefreshRunRef,
          setProductRefreshProgress,
          timeoutMs: PRODUCT_MANUAL_REFRESH_FOREGROUND_WAIT_TIMEOUT_MS,
          pendingAsFailed: false,
        })
          .then(async (waitResult) => {
            if (productRefreshRunRef.current !== refreshRunId || waitResult.canceled) return;
            if (waitResult.timedOut) {
              productMirrorScopeShops.forEach(clearProductListCacheForShop);
              setProductRefreshToken((value) => value + 1);
              await loadOzonProducts({ localOnly: true });
              if (productRefreshRunRef.current !== refreshRunId) return;
              setProductRefreshProgress((current) => ({
                ...current,
                running: false,
                blocking: false,
                errors: Math.max(current.errors, failedCount + waitResult.failedCount),
                message: 'Ozon 慢任务已转后台继续校准，页面已按当前 SQLite 最新快照刷新。',
              }));
              startBackgroundArchivedStatusSync();
              return;
            }
            productMirrorScopeShops.forEach(clearProductListCacheForShop);
            setProductRefreshToken((value) => value + 1);
            await loadOzonProducts({ localOnly: true });
            if (productRefreshRunRef.current !== refreshRunId) return;
            setProductRefreshProgress((current) => ({
              ...current,
              running: false,
              blocking: false,
              completed: current.total || jobIds.length || refreshTasks.length,
              errors: failedCount + waitResult.failedCount,
              message:
                failedCount + waitResult.failedCount > 0
                  ? '后台商品同步已结束但存在失败任务，页面已按 SQLite 当前最新快照刷新。'
                  : currentVisibility === PRODUCT_MANUAL_REFRESH_ARCHIVED_VISIBILITY
                    ? '核心商品数据已合并，已下架列表、标签和库存价格已按 Ozon 最新快照刷新。'
                    : '核心商品数据已合并，标签和列表已统一刷新；已下架大桶和完整商品卡信息已转入后台校准。',
            }));
            if (failedCount + waitResult.failedCount === 0) {
              startBackgroundArchivedStatusSync();
              startBackgroundProductEnrichment();
            }
          })
          .catch((error) => {
            if (productRefreshRunRef.current !== refreshRunId) return;
            const message = error instanceof Error ? error.message : String(error);
            setProductRefreshProgress((current) => ({
              ...current,
              running: false,
              blocking: false,
              errors: current.errors + 1,
              message: `后台商品同步轮询异常：${message}`,
            }));
          });
      })
      .catch((error) => {
        if (productRefreshRunRef.current !== refreshRunId) return;
        const message = error instanceof Error ? error.message : String(error);
        setProductRefreshProgress((current) => ({
          ...current,
          running: false,
          blocking: false,
          errors: current.errors + 1,
          message: `刷新异常：${message}`,
        }));
        loadOzonProducts({ localOnly: true });
      });
  }, [
    loadOzonProducts,
    pageSize,
    productMirrorScopeShops,
    productRefreshProgress.blocking,
    productRefreshRunRef,
    setProductRefreshProgress,
    setProductRefreshToken,
    status,
  ]);
  // Start the first SQLite read in the commit phase. The request remains
  // asynchronous and does not block paint, while avoiding a full passive-
  // effect frame before the product query is even submitted.
  React.useLayoutEffect(() => {
    ensureProductPageLoaded();
    return () => {
      productPageLoadAttemptRef.current += 1;
      if (productPageLoadPendingKeyRef.current === productPageLoadKey) {
        productPageLoadPendingKeyRef.current = '';
      }
    };
  }, [ensureProductPageLoaded, productPageLoadKey]);

  React.useEffect(() => {
    const handleOzonPushRefresh = (event) => {
      if (!isOzonPushDomainRefreshEvent(event, 'products')) return;
      const shopId = getOzonPushRealtimeShopId(event);
      const shop = productMirrorScopeShops.find((item) => String(item?.id || '').trim() === shopId);
      if (!shop) return;
      clearProductListCacheForShop(shop);
      setProductRefreshToken((value) => value + 1);
    };
    globalThis.addEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOzonPushRefresh);
    return () => globalThis.removeEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOzonPushRefresh);
  }, [productMirrorScopeShops, setProductRefreshToken]);

  return {
    loadOzonProducts,
    handleRefreshProducts,
  };
}

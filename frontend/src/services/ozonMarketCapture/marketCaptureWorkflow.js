import {
  ensureOzonBrowserTab,
  getOzonBrowserCaptureErrorMessage,
  getOzonBrowserCommand,
  isOzonBrowserSessionStaleError,
  readOzonBrowserCaptureSnapshot,
  recoverOzonBrowserCollectorTab,
  waitForOzonBrowserObserverStatus,
} from '../ozonBrowserCaptureClient.js';
import {
  getDefaultOzonMarketRoute,
  getOzonMarketSearchRoute,
  getOzonProductPerformanceRoute,
  OZON_MARKET_COMMAND_RESERVE_MS,
  OZON_MARKET_CAPTURE_ROUTES,
  OZON_MARKET_REFRESH_BUDGET_MS,
} from './marketCaptureRoutes.js';
import {
  lastSequence,
  latestDataset,
  mergeRouteBatches,
  navigateToExactMarketRoute,
  needsProductPerformanceProbe,
  normalizeCommandState,
  paginateCapturedDatasets,
  paginationCandidates,
  paginationSummary,
  probeRouteDatasets,
  readNormalizedDatasetWindow,
  readSearchSnapshot,
  resolveAfterNavigationSequence,
  responseResult,
  waitForDatasets,
} from './marketCaptureTransport.js';
import { runOzonMarketCollectorTask } from './marketCollectorCoordinator.js';
import { enrichProductPerformanceFollowSellers } from './followSellerCaptureService.js';

const DEFAULT_SEARCH_TIMEOUT_MS = 8_000;
const DEFAULT_ROUTE_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_CAPTURE_SETTLE_MS = 500;
const DEFAULT_PRODUCT_PERFORMANCE_WARMUP_MS = 5_000;
const DEFAULT_PRODUCT_PERFORMANCE_RECIPE_RETRY_MS = 3_000;
const DEFAULT_PRODUCT_PERFORMANCE_PROBE_RETRIES = 3;
const DEFAULT_PRODUCT_PERFORMANCE_RETRY_DELAY_MS = 350;
const DEFAULT_PRODUCT_SEARCH_PAGINATION_PAGES = 19;
const DEFAULT_PRODUCT_SEARCH_PAGINATION_DELAY_MS = 100;
const MAX_PRODUCT_SEARCH_RECORDS = 1_000;
const OZON_ANALYTICS_API_ORIGIN = 'https://api.seller.ozon.ru';
const OZON_SELLER_ORIGIN = 'https://seller.ozon.ru';
const OZON_PRODUCT_PERFORMANCE_PATH = '/api/site/seller-analytics/what_to_sell/data/v3';
const OZON_PRODUCT_PERFORMANCE_PAGE_SIZE = 50;

function text(value) {
  return String(value ?? '').trim();
}

function wait(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function createCaptureAccumulator(options) {
  const accumulator = options.createCaptureAccumulator?.();
  if (accumulator?.add && accumulator?.snapshot) return accumulator;
  const error = new Error('市场采集缺少数据累加器。');
  error.code = 'OZON_MARKET_CAPTURE_ACCUMULATOR_MISSING';
  throw error;
}

function createProductPerformanceSearchProbe(route, searchText, categoryIds = []) {
  const probe = (Array.isArray(route?.probes) ? route.probes : [])
    .find((item) => /what_to_sell\/data\/v3/iu.test(text(item?.path)));
  if (!probe) {
    const error = new Error('Ozon 商品表现页没有可用的市场商品探针。');
    error.code = 'OZON_PRODUCT_PERFORMANCE_PROBE_MISSING';
    throw error;
  }
  const normalizedSearchText = text(searchText);
  const searchField = /^\d{5,}$/u.test(normalizedSearchText) ? 'sku' : 'name';
  const categories = searchField === 'sku'
    ? []
    : [...new Set((Array.isArray(categoryIds) ? categoryIds : []).map(text).filter(Boolean))];
  return {
    ...probe,
    path: OZON_PRODUCT_PERFORMANCE_PATH,
    method: 'POST',
    origin: OZON_ANALYTICS_API_ORIGIN,
    body: {
      limit: String(OZON_PRODUCT_PERFORMANCE_PAGE_SIZE),
      offset: '0',
      filter: {
        period: 'monthly',
        categories,
        [searchField]: normalizedSearchText,
      },
    },
  };
}

async function executeProductPerformanceSearchProbe(
  command,
  tabId,
  route,
  searchText,
  sourceSequence = 0,
  options = {},
) {
  const baseProbe = createProductPerformanceSearchProbe(
    route,
    searchText,
    options.productPerformanceCategoryIds,
  );
  const result = await executeProductPerformanceProbe(
    command,
    tabId,
    baseProbe,
    sourceSequence,
    options,
  );
  return { ...result, query: searchText };
}

async function executeProductPerformanceProbe(
  command,
  tabId,
  baseProbe,
  sourceSequence = 0,
  options = {},
) {
  const origins = [...new Set([
    text(baseProbe?.origin),
    OZON_ANALYTICS_API_ORIGIN,
    OZON_SELLER_ORIGIN,
  ].filter(Boolean))];
  const maxAttempts = Math.max(1, Math.min(
    5,
    Number(options.productPerformanceProbeRetries) || DEFAULT_PRODUCT_PERFORMANCE_PROBE_RETRIES,
  ));
  const retryDelayMs = Math.max(0, Math.min(
    2_000,
    Number(options.productPerformanceRetryDelayMs) || DEFAULT_PRODUCT_PERFORMANCE_RETRY_DELAY_MS,
  ));
  let lastResponse = null;
  let lastProbe = baseProbe;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let retryableFailure = false;
    for (const origin of origins) {
      const probe = { ...baseProbe, origin };
      try {
        const response = responseResult(await command({
          command: 'ozon-data-probe',
          tabId,
          sourceSequence: Math.max(0, Number(sourceSequence) || 0),
          path: probe.path,
          method: probe.method,
          origin: probe.origin,
          body: probe.body,
        }));
        lastProbe = probe;
        lastResponse = response;
        if (response.quality === 'confirmed-data' && Number(response.capturedSequence)) {
          return { probe, response };
        }
        if (response.quality !== 'access-denied') break;
      } catch (error) {
        lastProbe = probe;
        lastError = error;
        const code = text(error?.code || error?.message).toUpperCase();
        retryableFailure = code.includes('OZON_DATA_OBSERVER_PROBE_FAILED')
          || code.includes('FAILED TO FETCH')
          || code.includes('NETWORK');
        if (!retryableFailure) throw error;
      }
    }
    if (!retryableFailure || attempt >= maxAttempts) break;
    await wait(retryDelayMs * attempt);
  }

  if (lastResponse) return { probe: lastProbe, response: lastResponse };
  throw lastError || Object.assign(new Error('OZON_PRODUCT_PERFORMANCE_NETWORK_FAILED'), {
    code: 'OZON_PRODUCT_PERFORMANCE_NETWORK_FAILED',
  });
}

function productPerformancePaginationProbe(baseProbe = {}, pageIndex = 1) {
  const body = baseProbe.body && typeof baseProbe.body === 'object'
    ? structuredClone(baseProbe.body)
    : {};
  return {
    ...baseProbe,
    path: OZON_PRODUCT_PERFORMANCE_PATH,
    method: 'POST',
    body: {
      ...body,
      limit: String(OZON_PRODUCT_PERFORMANCE_PAGE_SIZE),
      offset: String(OZON_PRODUCT_PERFORMANCE_PAGE_SIZE * pageIndex),
    },
  };
}

async function paginateProductPerformanceSearch(
  command,
  tabId,
  probeResult,
  sourceSequence,
  options = {},
) {
  if (options.pagination === false) return [];
  const sourceRecordCount = Math.max(0, Number(probeResult?.response?.recordCount) || 0);
  if (sourceRecordCount < OZON_PRODUCT_PERFORMANCE_PAGE_SIZE) {
    return [{
      dataset: 'product-performance',
      sourceSequence,
      pagesFetched: 0,
      recordsFetched: 0,
      totalRecordCount: sourceRecordCount,
      stopReason: sourceRecordCount ? 'short-page' : 'empty-page',
      complete: true,
      stoppedSafely: true,
      errorCode: '',
      capturedSequences: [],
    }];
  }

  const maximumAdditionalPages = Math.max(
    0,
    Math.ceil(MAX_PRODUCT_SEARCH_RECORDS / OZON_PRODUCT_PERFORMANCE_PAGE_SIZE) - 1,
  );
  const maxPages = Math.max(1, Math.min(
    maximumAdditionalPages,
    Number(options.paginationMaxPages) || DEFAULT_PRODUCT_SEARCH_PAGINATION_PAGES,
  ));
  const requestedDelayMs = options.paginationDelayMs === undefined
    ? DEFAULT_PRODUCT_SEARCH_PAGINATION_DELAY_MS
    : Number(options.paginationDelayMs);
  const delayMs = Math.max(0, Math.min(
    3_000,
    Number.isFinite(requestedDelayMs)
      ? requestedDelayMs
      : DEFAULT_PRODUCT_SEARCH_PAGINATION_DELAY_MS,
  ));
  const capturedSequences = [];
  let recordsFetched = 0;
  let attemptedPages = 0;
  let stopReason = 'record-limit-reached';
  let errorCode = '';
  let failedPage = 0;
  let failedStatus = 0;

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
    attemptedPages += 1;
    const pageProbe = productPerformancePaginationProbe(probeResult.probe, pageIndex);
    try {
      const page = await executeProductPerformanceProbe(
        command,
        tabId,
        pageProbe,
        sourceSequence,
        options,
      );
      const response = page.response || {};
      const recordCount = Math.max(0, Number(response.recordCount) || 0);
      const capturedSequence = Math.max(0, Number(response.capturedSequence) || 0);
      if (response.quality !== 'confirmed-data' || !capturedSequence) {
        failedPage = pageIndex;
        failedStatus = Math.max(0, Number(response.status) || 0);
        errorCode = text(response.quality || 'OZON_DATA_PAGINATION_INCOMPLETE');
        stopReason = failedStatus >= 400 ? 'http-error' : 'no-data';
        break;
      }
      capturedSequences.push(capturedSequence);
      recordsFetched += recordCount;
      if (recordCount < OZON_PRODUCT_PERFORMANCE_PAGE_SIZE) {
        stopReason = recordCount === 0 ? 'empty-page' : 'short-page';
        break;
      }
    } catch (error) {
      failedPage = pageIndex;
      errorCode = text(error?.code || error?.message || 'OZON_DATA_PAGINATION_FAILED');
      stopReason = 'network-error';
      break;
    }
    if (pageIndex < maxPages && delayMs > 0) await wait(delayMs);
  }

  const complete = ['record-limit-reached', 'short-page', 'empty-page'].includes(stopReason);
  return [{
    dataset: 'product-performance',
    sourceSequence,
    pagesFetched: capturedSequences.length,
    attemptedPages,
    recordsFetched,
    totalRecordCount: Math.min(
      MAX_PRODUCT_SEARCH_RECORDS,
      sourceRecordCount + recordsFetched,
    ),
    stopReason,
    complete,
    stoppedSafely: complete,
    errorCode: complete ? '' : errorCode || 'OZON_DATA_PAGINATION_INCOMPLETE',
    failedPage,
    failedStatus,
    capturedSequences,
  }];
}

async function searchProductPerformanceDataset(command, tabId, searchText, options = {}) {
  const route = getOzonProductPerformanceRoute();
  let baseline = 0;
  try {
    baseline = lastSequence(responseResult(await command({ command: 'ozon-data-status', tabId })));
  } catch (error) {
    if (isOzonBrowserSessionStaleError(error)) throw error;
  }
  const navigationSettleMs = Math.max(0, Math.min(
    3_000,
    Number(options.productPerformanceNavigationSettleMs) || 0,
  ));
  if (navigationSettleMs > 0) await wait(navigationSettleMs);
  await navigateToExactMarketRoute(command, tabId, route.url, options);
  const status = await waitForOzonBrowserObserverStatus(
    command,
    tabId,
    options.productSearchObserverTimeoutMs ?? 15_000,
  );
  if (status?.installed !== true || status?.enabled !== true || status?.ready !== true) {
    const error = new Error('Ozon 商品表现页的数据观察器注入失败。');
    error.code = 'OZON_DATA_OBSERVER_NOT_READY';
    throw error;
  }
  const navigationBaseline = await resolveAfterNavigationSequence(command, tabId, baseline);

  // The page's own first read carries Ozon's current company/language headers.
  // Reuse that exact recipe when available; probing immediately after the
  // document commits can race those headers and surface as `Failed to fetch`.
  const warmupBatch = await waitForDatasets(command, tabId, {
    afterSequence: navigationBaseline,
    expected: route.datasets,
    timeoutMs: options.productPerformanceWarmupMs
      ?? options.productSearchWarmupMs
      ?? DEFAULT_PRODUCT_PERFORMANCE_WARMUP_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    settleMs: 0,
    requireConfirmed: false,
  }).catch(() => ({ datasets: [], matching: [] }));
  let warmupRecipe = latestDataset(warmupBatch.datasets, 'product-performance');
  let sourceSequence = Number(warmupRecipe?.sequence) || 0;

  let probeResult = null;
  let lastProbeError = null;
  const exactCategoryIds = (Array.isArray(options.productPerformanceCategoryIds)
    ? options.productPerformanceCategoryIds
    : []).map(text).filter(Boolean);
  const hasConfirmedResult = () => (
    probeResult?.response?.quality === 'confirmed-data'
    && Number(probeResult.response.capturedSequence) > 0
  );
  const tryNameCandidates = async () => {
    for (const candidate of productSearchCandidates(searchText, options.productSearchAlternatives)) {
      try {
        const current = await executeProductPerformanceSearchProbe(
          command,
          tabId,
          route,
          candidate,
          sourceSequence,
          options,
        );
        probeResult = current;
        if (hasConfirmedResult()) return true;
      } catch (error) {
        lastProbeError = error;
      }
    }
    return false;
  };
  const tryCategoryOnly = async () => {
    if (!exactCategoryIds.length) return false;
    try {
      const categoryOnly = await executeProductPerformanceSearchProbe(
        command,
        tabId,
        route,
        '',
        sourceSequence,
        options,
      );
      probeResult = {
        ...categoryOnly,
        query: searchText,
        categoryOnly: true,
      };
      return hasConfirmedResult();
    } catch (error) {
      lastProbeError = error;
      return false;
    }
  };

  if (options.productPerformancePreferCategoryOnly === true) await tryCategoryOnly();
  if (!hasConfirmedResult()) await tryNameCandidates();
  if (!hasConfirmedResult() && !sourceSequence) {
    // A cold document can expose the company context before its first
    // what-to-sell request has produced a reusable header recipe. Wait once
    // more on the same committed page, then retry every local alias. This is
    // a route-level retry, not a blind retry of the same incomplete request.
    const recipeRetryBatch = await waitForDatasets(command, tabId, {
      afterSequence: navigationBaseline,
      expected: route.datasets,
      timeoutMs: options.productPerformanceRecipeRetryMs
        ?? DEFAULT_PRODUCT_PERFORMANCE_RECIPE_RETRY_MS,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      settleMs: 0,
      requireConfirmed: false,
    }).catch(() => ({ datasets: [] }));
    warmupRecipe = latestDataset(recipeRetryBatch.datasets, 'product-performance');
    sourceSequence = Number(warmupRecipe?.sequence) || 0;
    if (sourceSequence) {
      if (options.productPerformancePreferCategoryOnly === true) await tryCategoryOnly();
      if (!hasConfirmedResult()) await tryNameCandidates();
    }
  }
  if (!hasConfirmedResult() && exactCategoryIds.length) {
    // api.seller.ozon.ru can reject a cold cross-origin name search even while
    // the same read endpoint is available through seller.ozon.ru. An exact
    // Ozon type id is already a complete server-side filter, so retry without
    // the textual name instead of falling back to unrelated legacy rows.
    await tryCategoryOnly();
  }
  if (!hasConfirmedResult() && lastProbeError) throw lastProbeError;
  const capturedSequence = Number(probeResult?.response?.capturedSequence) || 0;
  if (probeResult?.response?.quality !== 'confirmed-data' || !capturedSequence) return null;

  const resultBaseline = Math.max(0, capturedSequence - 1);
  const resultBatch = await waitForDatasets(command, tabId, {
    afterSequence: resultBaseline,
    expected: route.datasets,
    timeoutMs: options.productSearchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    settleMs: options.captureSettleMs ?? DEFAULT_CAPTURE_SETTLE_MS,
    requireConfirmed: true,
  });
  const exactDatasets = resultBatch.matching.filter(
    (dataset) => Number(dataset?.sequence) === capturedSequence,
  );
  if (!exactDatasets.length) return null;

  // Product search uses the same exact allow-listed probe for every offset.
  // Running each page through `ozon-data-probe` is deliberate: the native CEF
  // transport can recover an individual page when renderer fetch becomes
  // unavailable. The generic in-page paginator cannot cross that boundary and
  // used to silently leave the Skill with only the first 50 rows.
  const pagination = await paginateProductPerformanceSearch(
    command,
    tabId,
    probeResult,
    capturedSequence,
    {
      ...options,
      paginationMaxPages: options.paginationMaxPages ?? DEFAULT_PRODUCT_SEARCH_PAGINATION_PAGES,
    },
  );
  const snapshot = await readOzonBrowserCaptureSnapshot({
    command,
    tabId,
    afterSequence: resultBaseline,
    autoOpen: false,
  });
  const exactSequences = new Set([
    capturedSequence,
    ...pagination.flatMap((result) => (
      Array.isArray(result?.capturedSequences) ? result.capturedSequences : []
    )),
  ].map(Number).filter((sequence) => sequence > 0));
  return {
    ...snapshot,
    captureMode: 'product-search',
    query: probeResult.query,
    serverQueryMatched: true,
    pagination: paginationSummary(pagination),
    datasets: (Array.isArray(snapshot.datasets) ? snapshot.datasets : [])
      .filter((dataset) => exactSequences.has(Number(dataset?.sequence)))
      .filter((dataset) => route.datasets.includes(text(dataset?.dataset))),
  };
}

function productSearchCandidates(searchText, alternatives = []) {
  return [...new Set([searchText, ...(Array.isArray(alternatives) ? alternatives : [])]
    .map(text)
    .filter(Boolean))].slice(0, 6);
}

function collectorPriority(options = {}, fallback = 'normal') {
  const requested = text(options.collectorPriority);
  return ['background', 'normal', 'interactive'].includes(requested) ? requested : fallback;
}

function incompletePaginationResults(results = []) {
  const items = Array.isArray(results) ? results : [];
  const completedDatasets = new Set(items
    .filter((result) => result?.complete === true)
    .map((result) => text(result?.dataset))
    .filter(Boolean));
  return items.filter((result) => (
    result?.complete === false
    && !completedDatasets.has(text(result?.dataset))
  ));
}

function paginationRouteFields(results = []) {
  const items = Array.isArray(results) ? results : [];
  const incomplete = incompletePaginationResults(items);
  const safePartial = incomplete.filter((result) => (
    result?.safePartial === true && result?.safeToPersist === true
  ));
  const failed = incomplete.filter((result) => (
    result?.safePartial !== true || result?.safeToPersist !== true
  ));
  return {
    pagesFetched: items.reduce((total, result) => total + (Number(result?.pagesFetched) || 0), 0),
    recordsFetched: items.reduce((total, result) => total + (Number(result?.recordsFetched) || 0), 0),
    stopReasons: items.map((result) => text(result?.stopReason)).filter(Boolean),
    incompleteDatasets: [...new Set(incomplete.map((result) => text(result?.dataset)).filter(Boolean))],
    safePartialDatasets: [...new Set(safePartial.map((result) => text(result?.dataset)).filter(Boolean))],
    paginationWarnings: safePartial.map((result) => ({
      dataset: text(result?.dataset),
      coverageStatus: text(result?.coverageStatus),
      limitationCode: text(result?.limitationCode || result?.stopReason || 'OZON_DATA_PAGINATION_UNAVAILABLE'),
      stopReason: text(result?.stopReason),
      preserveExisting: result?.preserveExisting !== false,
    })),
    paginationErrors: failed.map((result) => ({
      dataset: text(result?.dataset),
      errorCode: text(result?.errorCode || result?.stopReason || 'OZON_DATA_PAGINATION_INCOMPLETE'),
      stopReason: text(result?.stopReason),
    })),
    complete: incomplete.length === 0,
    safeToPersist: failed.length === 0,
  };
}

function snapshotDatasetRecordCount(snapshot = {}, datasetIds = []) {
  const accepted = new Set((Array.isArray(datasetIds) ? datasetIds : []).map(text).filter(Boolean));
  return (Array.isArray(snapshot?.datasetViews) ? snapshot.datasetViews : [])
    .filter((dataset) => !accepted.size || accepted.has(text(dataset?.dataset || dataset?.id)))
    .reduce((total, dataset) => total + (Number(dataset?.recordCount) || dataset?.records?.length || 0), 0);
}

function shouldEmitPaginationProgress(partial = {}) {
  const pagesFetched = Number(partial.pagesFetched) || 0;
  return partial.complete === true
    || partial.safePartial === true
    || pagesFetched === 0
    || pagesFetched % 25 === 0;
}

async function runWithCollectorRecovery(operation, options = {}) {
  try {
    return await operation();
  } catch (error) {
    if (options.recoverStaleSession === false || !isOzonBrowserSessionStaleError(error)) throw error;
    await recoverOzonBrowserCollectorTab({
      command: options.command,
      profileLoader: options.profileLoader,
      profileId: options.profileId,
    });
    return operation();
  }
}

async function readOzonMarketCaptureDataCore(options = {}) {
  try {
    const snapshot = await readOzonBrowserCaptureSnapshot(options);
    return typeof options.normalizeSnapshot === 'function'
      ? options.normalizeSnapshot(snapshot)
      : snapshot;
  } catch (error) {
    const wrapped = new Error(getOzonBrowserCaptureErrorMessage(error));
    wrapped.code = text(error?.code || error?.message || 'OZON_MARKET_BROWSER_READ_FAILED');
    throw wrapped;
  }
}

async function searchOzonProductCaptureDataCore(query, options = {}) {
  const searchText = text(query);
  if (!searchText || searchText.length > 160) {
    const error = new Error('请输入 1-160 个字符的商品关键词或 SKU。');
    error.code = 'OZON_PRODUCT_SEARCH_QUERY_INVALID';
    throw error;
  }
  const command = getOzonBrowserCommand(options.command);
  try {
    const stateResponse = await command({ command: 'state' });
    const initialState = normalizeCommandState(stateResponse);
    const ensured = await ensureOzonBrowserTab({
      command,
      state: initialState,
      autoOpen: options.autoOpen !== false,
      profileLoader: options.profileLoader,
      profileId: options.profileId,
    });
    const { tab } = ensured;
    if (!tab?.tabId) {
      const error = new Error('当前没有已打开的 Ozon 内置浏览器页面。');
      error.code = 'PURCHASE_BROWSER_TAB_NOT_FOUND';
      throw error;
    }

    const tabId = text(tab.tabId);
    const productPerformanceOptions = {
      ...options,
      productPerformanceNavigationSettleMs: options.productPerformanceNavigationSettleMs
        ?? (initialState?.queue?.active ? 750 : 0),
    };
    try {
      const productPerformance = await searchProductPerformanceDataset(
        command,
        tabId,
        searchText,
        productPerformanceOptions,
      );
      if (productPerformance?.datasets?.length) {
        if (options.followSellerEnrichment === false) return productPerformance;
        try {
          return await enrichProductPerformanceFollowSellers({
            command,
            tabId,
            snapshot: productPerformance,
            limit: options.followSellerLimit,
            concurrency: options.followSellerConcurrency,
            batchSize: options.followSellerBatchSize,
          });
        } catch (error) {
          await options.onRouteError?.(error, {
            ...getOzonProductPerformanceRoute(),
            phase: 'follow-seller-enrichment',
          });
          return {
            ...productPerformance,
            followSellerCoverage: {
              source: 'ozon-public-other-offers',
              status: 'unavailable',
              errorCode: text(error?.code || error?.message || 'OZON_FOLLOW_SELLERS_UNAVAILABLE'),
            },
          };
        }
      }
      const error = new Error('Ozon 全量商品接口没有返回可用数据。');
      error.code = 'OZON_PRODUCT_PERFORMANCE_EMPTY';
      throw error;
    } catch (error) {
      if (isOzonBrowserSessionStaleError(error)) throw error;
      await options.onRouteError?.(error, getOzonProductPerformanceRoute());
      throw error;
    }
  } catch (error) {
    const wrapped = new Error(getOzonBrowserCaptureErrorMessage(error));
    wrapped.code = text(error?.code || error?.message || 'OZON_PRODUCT_SEARCH_FAILED');
    throw wrapped;
  }
}

async function runBackgroundMarketRoutes({ command, tabId, options = {} }) {
  const routeTimeoutMs = options.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const captureAccumulator = options.captureAccumulator || createCaptureAccumulator(options);
  const excludedRouteIds = new Set(options.excludedRouteIds || []);
  const routes = OZON_MARKET_CAPTURE_ROUTES.filter((route) => !excludedRouteIds.has(route.id));
  const routeResults = [];
  for (const route of routes) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const deadlineAt = Number(options.paginationDeadlineAt) || 0;
    const reserveMs = options.paginationCommandReserveMs == null
      ? OZON_MARKET_COMMAND_RESERVE_MS
      : Math.max(0, Number(options.paginationCommandReserveMs) || 0);
    if (deadlineAt > 0 && deadlineAt - now() <= reserveMs) {
      routeResults.push({
        routeId: route.id,
        status: 'safe-partial',
        complete: false,
        safeToPersist: true,
        datasets: [...route.datasets],
        incompleteDatasets: [...route.datasets],
        safePartialDatasets: [...route.datasets],
        pagesFetched: 0,
        recordsFetched: 0,
        stopReasons: ['time-budget-exhausted'],
        paginationErrors: [],
        paginationWarnings: route.datasets.map((dataset) => ({
          dataset,
          coverageStatus: 'time-budget-exhausted',
          limitationCode: 'OZON_DATA_PAGINATION_TIME_BUDGET_EXHAUSTED',
          stopReason: 'time-budget-exhausted',
          preserveExisting: true,
        })),
      });
      continue;
    }
    try {
      const status = responseResult(await command({ command: 'ozon-data-status', tabId }));
      const previousSequence = lastSequence(status) || Number(status.queueLength) || 0;
      await navigateToExactMarketRoute(command, tabId, route.url, options);
      const baseline = await resolveAfterNavigationSequence(command, tabId, previousSequence);
      let routeBatch = { datasets: [], matching: [] };
      let routeWasProbed = false;
      // Audited probes are the authoritative read recipe for these routes.
      // Waiting for the page's drifting natural request first only duplicates
      // the polling window and used to add 5-10 seconds per route.
      if (route.preferProbe === true) {
        const probedBatch = await probeRouteDatasets(command, tabId, route, baseline, options);
        if (probedBatch.matching.length) {
          routeBatch = probedBatch;
          routeWasProbed = true;
          routeBatch.paginationMatching = probedBatch.paginationMatching;
        }
      }
      if (!routeBatch.matching.length) {
        routeBatch = await waitForDatasets(command, tabId, {
          afterSequence: baseline,
          expected: route.datasets,
          timeoutMs: options.routeTimeoutMs ?? route.timeoutMs ?? routeTimeoutMs,
          pollIntervalMs,
          settleMs: route.settleMs ?? options.captureSettleMs ?? DEFAULT_CAPTURE_SETTLE_MS,
        });
      }
      if (route.preferProbe !== true && needsProductPerformanceProbe(route, routeBatch)) {
        const probedBatch = await probeRouteDatasets(command, tabId, route, baseline, options);
        if (probedBatch.matching.length) {
          routeBatch = mergeRouteBatches(routeBatch, probedBatch);
          routeWasProbed = true;
          routeBatch.paginationMatching = probedBatch.paginationMatching;
        }
      }
      let paginationDatasets = routeWasProbed && Array.isArray(routeBatch.paginationMatching)
        ? routeBatch.paginationMatching
        : routeBatch.matching;
      let paginationSource = paginationDatasets.length ? (routeWasProbed ? 'direct-probe' : 'fresh-route') : 'none';
      if (!paginationDatasets.length && route.id !== 'ozon-bestsellers') {
        const retainedDatasets = await readNormalizedDatasetWindow(command, tabId, 0, 20);
        paginationDatasets = paginationCandidates(retainedDatasets, route.datasets);
        if (paginationDatasets.length) paginationSource = 'retained-recipe';
      }
      const firstSnapshot = await readSearchSnapshot(command, tabId, baseline, captureAccumulator);
      await options.onProgress?.(firstSnapshot, route);
      const paginationResults = await paginateCapturedDatasets(
        command,
        tabId,
        paginationDatasets,
        route.datasets,
        {
          ...options,
          pagination: route.pagination !== false && options.pagination !== false,
          paginationMode: route.paginationMode,
          onPaginationBatch: async (partial, dataset) => {
            await options.onPaginationBatch?.(partial, dataset);
            if (!shouldEmitPaginationProgress(partial)) return;
            await options.onProgress?.({
              ...(await readSearchSnapshot(command, tabId, baseline, captureAccumulator)),
              pagination: paginationSummary([partial]),
            }, { ...route, phase: 'pagination-progress' });
          },
          onPaginationError: (error, dataset) => options.onRouteError?.(error, {
            ...route,
            phase: 'pagination',
            dataset: text(dataset?.dataset),
          }),
        },
      );
      let expandedSnapshot = firstSnapshot;
      if (paginationResults.length) {
        expandedSnapshot = {
          ...(await readSearchSnapshot(command, tabId, baseline, captureAccumulator)),
          pagination: paginationSummary(paginationResults),
        };
        await options.onProgress?.(expandedSnapshot, { ...route, phase: 'pagination-complete' });
      }
      const paginationFields = paginationRouteFields(paginationResults);
      routeResults.push({
        routeId: route.id,
        status: !paginationFields.complete
          ? paginationFields.safeToPersist ? 'safe-partial' : 'partial'
          : routeBatch.matching.length || paginationResults.length ? 'success' : 'empty',
        source: paginationSource,
        datasets: [...new Set(paginationDatasets.map((dataset) => text(dataset?.dataset)).filter(Boolean))],
        recordCount: snapshotDatasetRecordCount(expandedSnapshot, route.datasets),
        ...paginationFields,
      });
    } catch (error) {
      if (isOzonBrowserSessionStaleError(error)) throw error;
      routeResults.push({
        routeId: route.id,
        status: 'failed',
        complete: false,
        datasets: [...route.datasets],
        incompleteDatasets: [...route.datasets],
        errorCode: text(error?.code || error?.message || 'OZON_MARKET_ROUTE_FAILED'),
      });
      await options.onRouteError?.(error, route);
    }
  }
  return { data: captureAccumulator.snapshot(), routeResults };
}

async function syncOzonMarketCaptureDataCore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const refreshBudgetMs = Math.max(
    1_000,
    Math.min(OZON_MARKET_REFRESH_BUDGET_MS, Number(options.paginationBudgetMs) || OZON_MARKET_REFRESH_BUDGET_MS),
  );
  const paginationDeadlineAt = Number(options.paginationDeadlineAt) || now() + refreshBudgetMs;
  const command = getOzonBrowserCommand(options.command);
  const stateResponse = await command({ command: 'state' });
  const initialState = normalizeCommandState(stateResponse);
  const ensured = await ensureOzonBrowserTab({
    command,
    state: initialState,
    autoOpen: options.autoOpen !== false,
    profileLoader: options.profileLoader,
    profileId: options.profileId,
  });
  const { tab } = ensured;
  if (!tab?.tabId) {
    const error = new Error('当前没有已打开的 Ozon 内置浏览器页面。');
    error.code = 'PURCHASE_BROWSER_TAB_NOT_FOUND';
    throw error;
  }
  const tabId = text(tab.tabId);
  const status = responseResult(await command({ command: 'ozon-data-status', tabId }));
  const baseline = lastSequence(status);
  const captureAccumulator = createCaptureAccumulator(options);
  const defaultRoute = getDefaultOzonMarketRoute();
  await navigateToExactMarketRoute(command, tabId, defaultRoute.url, options);
  const defaultBaseline = await resolveAfterNavigationSequence(command, tabId, baseline);
  let defaultBatch = { datasets: [], matching: [] };
  let defaultPaginationMatching = [];
  if (defaultRoute.preferProbe === true) {
    const probedBatch = await probeRouteDatasets(command, tabId, defaultRoute, defaultBaseline, options);
    if (probedBatch.matching.length) {
      defaultBatch = probedBatch;
      // Keep the exact audited probe response as the replay recipe.  The page
      // may emit a later natural request to the same endpoint while the probe
      // settles; that request is useful capture data, but it may omit paging
      // fields and must not displace the probe sequence selected above.
      defaultPaginationMatching = Array.isArray(probedBatch.paginationMatching)
        ? probedBatch.paginationMatching
        : probedBatch.matching;
    }
  }
  if (!defaultBatch.matching.length) {
    defaultBatch = await waitForDatasets(command, tabId, {
      afterSequence: defaultBaseline,
      expected: defaultRoute.datasets,
      timeoutMs: options.defaultTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      settleMs: options.captureSettleMs ?? DEFAULT_CAPTURE_SETTLE_MS,
      requireConfirmed: true,
    });
    defaultPaginationMatching = defaultBatch.matching;
  }
  if (defaultRoute.preferProbe !== true && needsProductPerformanceProbe(defaultRoute, defaultBatch)) {
    const probedBatch = await probeRouteDatasets(command, tabId, defaultRoute, defaultBaseline, options);
    if (probedBatch.matching.length) {
      defaultBatch = mergeRouteBatches(defaultBatch, probedBatch);
      defaultPaginationMatching = Array.isArray(probedBatch.paginationMatching)
        ? probedBatch.paginationMatching
        : probedBatch.matching;
    }
  }
  const initial = {
    ...(await readSearchSnapshot(command, tabId, defaultBaseline, captureAccumulator)),
    captureMode: 'default-navigation',
  };
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  if (onProgress) await onProgress(initial, defaultRoute);
  if (options.background !== false) {
    const backgroundWork = (async () => {
      const routeResults = [{
        routeId: defaultRoute.id,
        status: defaultBatch.matching.length ? 'success' : 'empty',
        source: defaultBatch.matching.length ? 'fresh-route' : 'none',
        datasets: [...new Set(defaultBatch.matching.map((dataset) => text(dataset?.dataset)).filter(Boolean))],
        recordCount: defaultBatch.matching.reduce((total, dataset) => total + (Number(dataset?.recordCount) || 0), 0),
        pagesFetched: 0,
        recordsFetched: 0,
        stopReasons: [],
        incompleteDatasets: [],
        paginationErrors: [],
        paginationWarnings: [],
        safePartialDatasets: [],
        complete: true,
        safeToPersist: true,
      }];
      const paginationResults = await paginateCapturedDatasets(
        command,
        tabId,
        defaultPaginationMatching,
        defaultRoute.datasets,
        {
          ...options,
          pagination: defaultRoute.pagination !== false && options.pagination !== false,
          paginationMode: defaultRoute.paginationMode,
          paginationDeadlineAt,
          onPaginationBatch: async (partial, dataset) => {
            await options.onPaginationBatch?.(partial, dataset);
            if (!shouldEmitPaginationProgress(partial)) return;
            await onProgress?.({
              ...(await readSearchSnapshot(command, tabId, defaultBaseline, captureAccumulator)),
              captureMode: 'default-navigation',
              pagination: paginationSummary([partial]),
            }, { ...defaultRoute, phase: 'pagination-progress' });
          },
        },
      );
      if (paginationResults.length) {
        Object.assign(routeResults[0], paginationRouteFields(paginationResults));
        if (routeResults[0].complete === false) {
          routeResults[0].status = routeResults[0].safeToPersist ? 'safe-partial' : 'partial';
        }
        await onProgress?.({
          ...(await readSearchSnapshot(command, tabId, defaultBaseline, captureAccumulator)),
          captureMode: 'default-navigation',
          pagination: paginationSummary(paginationResults),
        }, { ...defaultRoute, phase: 'pagination-complete' });
      }
      routeResults[0].recordCount = snapshotDatasetRecordCount(
        captureAccumulator.snapshot() || initial,
        defaultRoute.datasets,
      );
      if (options.scanRoutes !== false) {
        const backgroundRoutes = await runBackgroundMarketRoutes({
          command,
          tabId,
          options: {
            ...options,
            paginationDeadlineAt,
            captureAccumulator,
            excludedRouteIds: [...new Set([...(options.excludedRouteIds || []), defaultRoute.id])],
            onProgress,
          },
        });
        routeResults.push(...backgroundRoutes.routeResults);
      }
      return {
        ...(captureAccumulator.snapshot() || initial),
        captureMode: 'default-navigation',
        routeResults,
      };
    })();
    if (options.awaitBackground === true) {
      return await backgroundWork.catch(async (error) => {
        await options.onRouteError?.(error, defaultRoute);
        return {
          ...initial,
          captureMode: 'default-navigation',
          routeResults: [{
            routeId: defaultRoute.id,
            status: 'failed',
            complete: false,
            datasets: [...defaultRoute.datasets],
            incompleteDatasets: [...defaultRoute.datasets],
            errorCode: text(error?.code || error?.message || 'OZON_MARKET_ROUTE_FAILED'),
          }],
        };
      });
    } else {
      void backgroundWork.catch((error) => options.onRouteError?.(error, defaultRoute));
    }
  }
  return initial;
}

async function searchOzonMarketCaptureDataCore(query, options = {}) {
  const searchText = text(query);
  if (!searchText || searchText.length > 160) {
    const error = new Error('请输入 1-160 个字符的搜索词。');
    error.code = 'OZON_DATA_SEARCH_QUERY_INVALID';
    throw error;
  }
  const command = getOzonBrowserCommand(options.command);
  try {
    const stateResponse = await command({ command: 'state' });
    const initialState = normalizeCommandState(stateResponse);
    const ensured = await ensureOzonBrowserTab({
      command,
      state: initialState,
      autoOpen: options.autoOpen !== false,
      profileLoader: options.profileLoader,
      profileId: options.profileId,
    });
    const { tab } = ensured;
    if (!tab?.tabId) {
      const error = new Error('当前没有已打开的 Ozon 内置浏览器页面。');
      error.code = 'PURCHASE_BROWSER_TAB_NOT_FOUND';
      throw error;
    }
    const tabId = text(tab.tabId);
    const status = responseResult(await command({ command: 'ozon-data-status', tabId }));
    const baseline = lastSequence(status);
    const captureAccumulator = createCaptureAccumulator(options);
    const queryRoute = getOzonMarketSearchRoute();
    await navigateToExactMarketRoute(command, tabId, queryRoute.url, options);
    const queryBaseline = await resolveAfterNavigationSequence(command, tabId, baseline);
    const recipeBatch = await waitForDatasets(command, tabId, {
      afterSequence: queryBaseline,
      expected: ['keywords'],
      timeoutMs: options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      settleMs: options.captureSettleMs ?? DEFAULT_CAPTURE_SETTLE_MS,
    });
    const recipe = latestDataset(recipeBatch.matching, 'keywords');
    if (!recipe?.sequence) {
      const error = new Error('Ozon 搜索页面没有返回可回放的关键词请求。');
      error.code = 'OZON_DATA_SEARCH_RECIPE_UNAVAILABLE';
      throw error;
    }
    const searchResponse = responseResult(await command({
      command: 'ozon-data-search',
      tabId,
      sourceSequence: recipe.sequence,
      query: searchText,
    }));
    const capturedSequence = Number(searchResponse.capturedSequence) || 0;
    const searchBatch = await waitForDatasets(command, tabId, {
      afterSequence: Math.max(queryBaseline, capturedSequence - 1),
      expected: ['keywords'],
      timeoutMs: options.searchResultTimeoutMs ?? 4_000,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      settleMs: options.captureSettleMs ?? DEFAULT_CAPTURE_SETTLE_MS,
      requireConfirmed: false,
    });
    const initial = await readSearchSnapshot(command, tabId, queryBaseline, captureAccumulator);
    const initialWithQuery = {
      ...initial,
      captureMode: 'search',
      query: searchText,
      searchStatus: searchResponse.quality || 'captured',
    };
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    if (onProgress) await onProgress(initialWithQuery, queryRoute);
    if (options.background !== false) {
      const backgroundWork = (async () => {
        const routeResults = [{
          routeId: queryRoute.id,
          status: searchBatch.matching.length ? 'success' : 'empty',
          source: 'fresh-search',
          datasets: ['keywords'],
          recordCount: searchBatch.matching.reduce((total, dataset) => total + (Number(dataset?.recordCount) || 0), 0),
          pagesFetched: 0,
          stopReasons: [],
          incompleteDatasets: [],
          safePartialDatasets: [],
          paginationWarnings: [],
          paginationErrors: [],
          complete: true,
          safeToPersist: true,
        }];
        const paginationSource = searchBatch.matching.find(
          (dataset) => Number(dataset?.sequence) === capturedSequence,
        ) || {
          sequence: capturedSequence,
          dataset: 'keywords',
          quality: searchResponse.quality || 'confirmed-data',
        };
        const paginationResults = await paginateCapturedDatasets(
          command,
          tabId,
          [paginationSource],
          ['keywords'],
          {
            ...options,
            paginationMode: queryRoute.paginationMode,
            onPaginationBatch: async (partial, dataset) => {
              await options.onPaginationBatch?.(partial, dataset);
              if (!shouldEmitPaginationProgress(partial)) return;
              await onProgress?.({
                ...(await readSearchSnapshot(command, tabId, queryBaseline, captureAccumulator)),
                captureMode: 'search',
                query: searchText,
                searchStatus: searchResponse.quality || 'captured',
                pagination: paginationSummary([partial]),
              }, { ...queryRoute, phase: 'pagination-progress' });
            },
          },
        );
        if (paginationResults.length) {
          Object.assign(routeResults[0], paginationRouteFields(paginationResults));
          if (routeResults[0].complete === false) {
            routeResults[0].status = routeResults[0].safeToPersist ? 'safe-partial' : 'partial';
          }
          await onProgress?.({
            ...(await readSearchSnapshot(command, tabId, queryBaseline, captureAccumulator)),
            captureMode: 'search',
            query: searchText,
            searchStatus: searchResponse.quality || 'captured',
            pagination: paginationSummary(paginationResults),
          }, { ...queryRoute, phase: 'pagination-complete' });
        }
        if (options.scanRoutes !== false) {
          const backgroundRoutes = await runBackgroundMarketRoutes({
            command,
            tabId,
            options: {
              ...options,
              captureAccumulator,
              onProgress,
            },
          });
          routeResults.push(...backgroundRoutes.routeResults);
        }
        return {
          ...(captureAccumulator.snapshot() || initial),
          captureMode: 'search',
          query: searchText,
          searchStatus: searchResponse.quality || 'captured',
          routeResults,
        };
      })();
      if (options.awaitBackground === true) {
        return await backgroundWork.catch(async (error) => {
          await options.onRouteError?.(error, queryRoute);
          return initialWithQuery;
        });
      }
      void backgroundWork.catch((error) => options.onRouteError?.(error, queryRoute));
    }
    return initialWithQuery;
  } catch (error) {
    const wrapped = new Error(getOzonBrowserCaptureErrorMessage(error));
    wrapped.code = text(error?.code || error?.message || 'OZON_MARKET_BROWSER_SEARCH_FAILED');
    throw wrapped;
  }
}

export async function readOzonMarketCaptureData(options = {}) {
  const command = getOzonBrowserCommand(options.command);
  return runOzonMarketCollectorTask(
    ({ command: coordinatedCommand }) => runWithCollectorRecovery(
      () => readOzonMarketCaptureDataCore({
        ...options,
        command: coordinatedCommand,
      }),
      { ...options, command: coordinatedCommand },
    ),
    {
      name: 'market-read',
      priority: collectorPriority(options, 'normal'),
      profileId: options.profileId,
      command,
    },
  );
}

export async function searchOzonProductCaptureData(query, options = {}) {
  const command = getOzonBrowserCommand(options.command);
  return runOzonMarketCollectorTask(
    ({ command: coordinatedCommand }) => runWithCollectorRecovery(
      () => searchOzonProductCaptureDataCore(query, {
        ...options,
        command: coordinatedCommand,
      }),
      { ...options, command: coordinatedCommand },
    ),
    {
      name: 'product-search',
      priority: collectorPriority(options, 'interactive'),
      profileId: options.profileId,
      command,
    },
  );
}

export async function syncOzonMarketCaptureData(options = {}) {
  const command = getOzonBrowserCommand(options.command);
  return runOzonMarketCollectorTask(
    ({ command: coordinatedCommand }) => runWithCollectorRecovery(
      () => syncOzonMarketCaptureDataCore({
        ...options,
        command: coordinatedCommand,
      }),
      { ...options, command: coordinatedCommand },
    ),
    {
      name: 'market-sync',
      priority: collectorPriority(options, 'normal'),
      profileId: options.profileId,
      command,
    },
  );
}

export async function searchOzonMarketCaptureData(query, options = {}) {
  const command = getOzonBrowserCommand(options.command);
  return runOzonMarketCollectorTask(
    ({ command: coordinatedCommand }) => runWithCollectorRecovery(
      () => searchOzonMarketCaptureDataCore(query, {
        ...options,
        command: coordinatedCommand,
      }),
      { ...options, command: coordinatedCommand },
    ),
    {
      name: 'market-search',
      priority: collectorPriority(options, 'interactive'),
      profileId: options.profileId,
      command,
    },
  );
}

import {
  getSeerfarCategoryTree,
  listIntegrationProfiles,
  readExternalIntegration,
} from '../../../api/localApiClient.js';
import { resolveOzonProductSearchQuery } from '../../../services/ozonSearch/ozonSearchQueryResolver.js';
import { buildExternalOzonQueryResult } from '../lib/smartToolExternalOzonResult.js';
import { normalizeSmartToolExternalProduct } from '../lib/smartToolExternalOzonAnalysis.js';
import {
  marketKeywordPlatformMatches,
  parseSmartToolMarketKeywordItems,
} from '../lib/smartToolMarketKeywordQuery.js';
import {
  extractSmartToolOzonNumericReference,
  splitSmartToolUsageInputItems,
} from '../lib/smartToolUsage.js';
import {
  EXTERNAL_PRODUCT_ANALYSIS_MODE_INPUT_LABEL,
  normalizeExternalProductAnalysisMode,
} from '../lib/smartToolExternalProductAnalysisMode.js';
import {
  hasExternalProductManualData,
  normalizeExternalProductManualData,
} from '../lib/smartToolExternalProductManualData.js';
import { annotateSeerfarKeywordRecoveryRecords } from '../lib/smartToolSeerfarKeywordRecovery.js';

const EXTERNAL_OZON_TOOL_ROUTES = new Map([
  ['linkfox-seerfar-ozon-shop-search', {
    providerType: 'seerfar-open-api', operation: 'ozon-shop-search',
  }],
  ['linkfox-seerfar-ozon-product-detail-search', {
    providerType: 'seerfar-open-api', operation: 'seerfar-ozon-product-detail-search',
  }],
  ['linkfox-seerfar-ozon-category-search', {
    providerType: 'seerfar-open-api', operation: 'seerfar-ozon-category-search',
  }],
  ['linkfox-seerfar-ozon-product-report-search', {
    providerType: 'seerfar-open-api', operation: 'seerfar-ozon-product-report-search',
  }],
  ['linkfox-seerfar-ozon-keyword-mining', {
    providerType: 'seerfar-open-api', operation: 'seerfar-ozon-keyword-mining',
  }],
  ['linkfox-seerfar-ozon-market-keyword-search', {
    providerType: 'seerfar-open-api', operation: 'seerfar-ozon-market-keyword-search',
  }],
  ['linkfox-seerfar-ozon-keyword-back-search', {
    providerType: 'seerfar-open-api', operation: 'seerfar-ozon-keyword-back-search',
  }],
]);

const EXTERNAL_OZON_DEFAULT_PAGE_SIZE = 100;
// Seerfar accepts one paid search at a time for the same API key.  Parallel
// page workers make two requests fail with HTTP 429 while only one succeeds,
// and the exhausted worker used to tear down the already visible first page.
// Keep the provider lane serial; the first page is still emitted immediately
// so the UI remains responsive while the complete result continues loading.
const EXTERNAL_OZON_PAGE_CONCURRENCY = 1;
const EXTERNAL_OZON_PAGE_RETRY_LIMIT = 6;
const EXTERNAL_OZON_NETWORK_RETRY_LIMIT = 2;
const EXTERNAL_OZON_SERVER_RETRY_LIMIT = 3;
const EXTERNAL_OZON_RETRY_BASE_DELAY_MS = 2000;
const EXTERNAL_OZON_PRODUCT_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const EXTERNAL_OZON_PRODUCT_DETAIL_OPERATION = 'seerfar-ozon-product-detail-search';
const EXTERNAL_OZON_PRODUCT_REPORT_OPERATION = 'seerfar-ozon-product-report-search';
const EXTERNAL_OZON_KEYWORD_MINING_OPERATION = 'seerfar-ozon-keyword-mining';
const EXTERNAL_OZON_MARKET_KEYWORD_OPERATION = 'seerfar-ozon-market-keyword-search';
const EXTERNAL_OZON_MARKET_MAX_PAGES = 10;
const SEERFAR_RECOVERY_CATEGORIES_KEY = '_seerfarRecoveryCategories';
const externalOzonProductDetailCache = new Map();
const externalOzonProductDetailRequests = new Map();
const EXTERNAL_OZON_OPERATION_PAGE_SIZES = new Map([
  ['ozon-shop-search', 20],
  ['seerfar-ozon-category-search', 20],
]);
const EXTERNAL_OZON_RECORD_KEYS = Object.freeze([
  'records', 'products', 'productList', 'rows', 'list', 'items', 'data',
]);

function text(value) {
  return String(value ?? '').trim();
}

function firstInputValue(values = {}) {
  return Object.values(values && typeof values === 'object' ? values : {}).map(text).find(Boolean) || '';
}

function externalOzonPageSize(operation = '') {
  return EXTERNAL_OZON_OPERATION_PAGE_SIZES.get(text(operation))
    || EXTERNAL_OZON_DEFAULT_PAGE_SIZE;
}

function defaultPage(field, operation = '') {
  return { page: 1, pageSize: externalOzonPageSize(operation), orders: [{ field, direction: 'DESC' }] };
}

function uniqueTextValues(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function publicExternalInput(input = {}) {
  const publicInput = { ...input };
  delete publicInput[SEERFAR_RECOVERY_CATEGORIES_KEY];
  return publicInput;
}

function providerSafeExternalInput(input = {}) {
  const safeInput = publicExternalInput(input);
  delete safeInput.manualData;
  return safeInput;
}

function normalizedCategoryName(value) {
  return text(value).normalize('NFKC').toLocaleLowerCase();
}

function exactLeafCategory(nodes = [], hint = '') {
  const normalizedHint = normalizedCategoryName(hint);
  if (!normalizedHint) return null;
  return (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node && node.hasChildren !== true)
    .filter((node) => [node.cnTitle, node.title, node.enTitle]
      .some((value) => normalizedCategoryName(value) === normalizedHint))
    .sort((left, right) => Number(right.level || 0) - Number(left.level || 0))[0] || null;
}

async function resolveSeerfarLeafCategory(keyword, categoryTreeLoader, signal) {
  const queryPlan = resolveOzonProductSearchQuery(keyword);
  const hints = uniqueTextValues([keyword, ...(queryPlan.categoryHints || [])]).slice(0, 8);
  for (const hint of hints) {
    throwIfAborted(signal);
    try {
      const payload = await categoryTreeLoader({
        query: hint,
        limit: 80,
        timeoutMs: 30000,
        ...(signal ? { signal } : {}),
      });
      const matched = exactLeafCategory(payload?.nodes, hint);
      if (matched?.id) return matched;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // Keep the original title filter usable if the local category tree is temporarily unavailable.
    }
  }
  return null;
}

function containsHanText(value) {
  return /\p{Script=Han}/u.test(text(value));
}

async function resolveKeywordContextForSeerfar(keyword, categoryTreeLoader, signal) {
  const queryPlan = resolveOzonProductSearchQuery(keyword);
  const category = await resolveSeerfarLeafCategory(keyword, categoryTreeLoader, signal);
  const resolvedKeyword = queryPlan.aliases?.[0]
    || (containsHanText(keyword) ? category?.title : '')
    || keyword;
  return { keyword: resolvedKeyword, categoryId: text(category?.id) };
}

export async function resolveSmartToolExternalOzonInput(tool = {}, input = {}, options = {}) {
  const categoryTreeLoader = options.getCategoryTree || getSeerfarCategoryTree;
  if (tool.id === 'linkfox-seerfar-ozon-product-report-search' && input.keywords?.length) {
    const matches = await Promise.all(input.keywords.map((keyword) => (
      resolveSeerfarLeafCategory(keyword, categoryTreeLoader, options.signal)
    )));
    const categoryIds = uniqueTextValues([
      ...(input.categoryIds || []),
      ...matches.map((match) => match?.id),
    ]);
    const unmatchedKeywords = input.keywords.filter((_, index) => !matches[index]);
    const resolved = {
      ...input,
      ...(categoryIds.length ? { categoryIds } : {}),
    };
    if (unmatchedKeywords.length) resolved.keywords = unmatchedKeywords;
    else delete resolved.keywords;
    return resolved;
  }
  if (tool.id === 'linkfox-seerfar-ozon-keyword-mining' && input.keyword) {
    const context = await resolveKeywordContextForSeerfar(
      input.keyword,
      categoryTreeLoader,
      options.signal,
    );
    return {
      ...input,
      keyword: context.keyword,
      ...(context.categoryId ? { [SEERFAR_RECOVERY_CATEGORIES_KEY]: [context.categoryId] } : {}),
    };
  }
  if (tool.id === 'linkfox-seerfar-ozon-market-keyword-search' && input.keywords?.length) {
    const contexts = await Promise.all(input.keywords.map((keyword) => (
      resolveKeywordContextForSeerfar(keyword, categoryTreeLoader, options.signal)
    )));
    return {
      ...input,
      keywords: uniqueTextValues(contexts.map((context) => context.keyword)),
      [SEERFAR_RECOVERY_CATEGORIES_KEY]: uniqueTextValues([
        ...(input.categories || []),
        ...contexts.map((context) => context.categoryId),
      ]),
    };
  }
  return input;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function remoteDataFromResponse(response = {}) {
  const payload = isRecord(response?.data) ? response.data : (isRecord(response) ? response : {});
  return isRecord(payload?.data) ? payload.data : payload;
}

function responseWithRemoteData(response = {}, remoteData = {}) {
  if (isRecord(response?.data?.data)) {
    return { ...response, data: { ...response.data, data: remoteData } };
  }
  if (isRecord(response?.data)) return { ...response, data: remoteData };
  return { ...response, data: remoteData };
}

function applyExternalOzonClientFilters(tool = {}, response = {}, input = {}) {
  if (tool.id !== 'linkfox-seerfar-ozon-market-keyword-search' || !input.platformFilter?.length) {
    return response;
  }
  const remoteData = remoteDataFromResponse(response);
  const collection = recordCollection(remoteData);
  if (!collection.key) return response;
  const records = collection.records.filter((record) => (
    marketKeywordPlatformMatches(record, input.platformFilter)
  ));
  return responseWithRemoteData(response, {
    ...remoteData,
    [collection.key]: records,
    ...(remoteData?.allPagesLoaded === true ? { total: records.length } : {}),
    size: records.length,
    currentSize: records.length,
  });
}

function recordCollection(remoteData = {}) {
  for (const key of EXTERNAL_OZON_RECORD_KEYS) {
    if (Array.isArray(remoteData?.[key])) return { key, records: remoteData[key] };
  }
  return { key: '', records: [] };
}

function explicitRemoteTotal(remoteData = {}) {
  for (const value of [remoteData?.total, remoteData?.productCount, remoteData?.totalCount]) {
    const normalized = Number(value);
    if (Number.isFinite(normalized) && normalized >= 0) return normalized;
  }
  return null;
}

function externalRecordIdentity(record = {}, index = 0) {
  const sku = text(record?.sku || record?.productId || record?.id || record?.offerId);
  if (sku) return `product:${sku}`;
  const keyword = text(record?.query || record?.keyword || record?.name);
  if (keyword) {
    const channel = text(record?.platform ?? record?.dimension?.type ?? record?.type);
    return `keyword:${keyword}:${channel}`;
  }
  try {
    return `record:${JSON.stringify(record)}`;
  } catch {
    return `record-index:${index}`;
  }
}

function deduplicateExternalRecords(records = []) {
  const seen = new Set();
  return (Array.isArray(records) ? records : []).filter((record, index) => {
    const identity = externalRecordIdentity(record, index);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function splitSmartToolExternalOzonInputs(tool = {}, input = {}) {
  if (tool.id !== 'linkfox-seerfar-ozon-product-report-search') return [input];
  const filterKeys = ['skus', 'categoryIds', 'keywords'].filter((key) => input[key]?.length);
  if (filterKeys.length <= 1) return [input];
  const baseInput = { ...input };
  filterKeys.forEach((key) => delete baseInput[key]);
  return filterKeys.map((key) => ({ ...baseInput, [key]: input[key] }));
}

function retryablePageErrorKind(error) {
  const remoteStatus = Number(
    error?.status
      ?? error?.statusCode
      ?? error?.remoteStatus
      ?? error?.payload?.error?.status,
  );
  if (remoteStatus === 429) return 'rate-limit';
  if (remoteStatus >= 500 && remoteStatus <= 599) return 'server';
  const content = [
    error?.code,
    error?.cause?.code,
    error?.message,
    error?.payload?.error?.code,
    error?.payload?.error?.message,
    error?.payload?.error?.diagnostic?.causeCode,
  ]
    .map(text)
    .join(' ');
  if (/1003|频繁|rate.?limit|too many/iu.test(content)) return 'rate-limit';
  if (
    /EXTERNAL_INTEGRATION_NETWORK_FAILED|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|域名解析失败|连接被重置|无法连接/iu
      .test(content)
  ) {
    return 'network';
  }
  return '';
}

function retryLimitForPageError(kind) {
  if (kind === 'rate-limit') return EXTERNAL_OZON_PAGE_RETRY_LIMIT;
  if (kind === 'network') return EXTERNAL_OZON_NETWORK_RETRY_LIMIT;
  if (kind === 'server') return EXTERNAL_OZON_SERVER_RETRY_LIMIT;
  return 0;
}

function retryDelay(attempt, baseDelayMs = EXTERNAL_OZON_RETRY_BASE_DELAY_MS) {
  const normalizedBase = Number(baseDelayMs);
  const base = Number.isFinite(normalizedBase) && normalizedBase >= 0
    ? normalizedBase
    : EXTERNAL_OZON_RETRY_BASE_DELAY_MS;
  return Math.min(30000, base * (2 ** attempt));
}

function createAbortError() {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function wait(delayMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

async function readExternalPage(
  readIntegration,
  request,
  requestOptions,
  pageNumber,
  retryOptions = {},
  attempt = 0,
) {
  throwIfAborted(requestOptions.signal);
  const page = {
    ...(request.input.page || {}),
    page: pageNumber,
    pageSize: externalOzonPageSize(request.operation),
  };
  delete page.pageNumber;
  try {
    const providerInput = providerSafeExternalInput({ ...request.input, page });
    return await readIntegration({
      ...request,
      input: providerInput,
    }, requestOptions);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const retryKind = retryablePageErrorKind(error);
    const retryLimitKey = retryKind === 'rate-limit' ? 'rateLimitRetryLimit' : `${retryKind}RetryLimit`;
    const configuredRetryLimit = Number(retryOptions[retryLimitKey]);
    const retryLimit = Number.isInteger(configuredRetryLimit) && configuredRetryLimit >= 0
      ? configuredRetryLimit
      : retryLimitForPageError(retryKind);
    if (!retryKind || attempt >= retryLimit) throw error;
    // A paid request can still be finishing in Electron after the renderer was
    // canceled.  Start at two seconds and back off far enough for that request
    // to leave the provider lane before retrying the new page.
    const delayMs = retryDelay(attempt, retryOptions.baseDelayMs);
    retryOptions.onRetry?.({
      page: pageNumber,
      retry: attempt + 1,
      retryLimit,
      delayMs,
      reason: retryKind,
      code: text(error?.code || error?.payload?.error?.code),
    });
    await wait(delayMs, requestOptions.signal);
    return readExternalPage(
      readIntegration,
      request,
      requestOptions,
      pageNumber,
      retryOptions,
      attempt + 1,
    );
  }
}

export async function readAllSmartToolExternalOzonPages(request = {}, options = {}) {
  const readIntegration = options.readIntegration || readExternalIntegration;
  const requestOptions = {
    timeoutMs: 120000,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const retryOptions = {
    baseDelayMs: options.retryBaseDelayMs,
    onRetry: options.onRetry,
    rateLimitRetryLimit: options.rateLimitRetryLimit,
    networkRetryLimit: options.networkRetryLimit,
    serverRetryLimit: options.serverRetryLimit,
  };
  const pageSize = externalOzonPageSize(request.operation);
  const configuredMaxPages = Number(options.maxPages);
  const maxPages = Number.isInteger(configuredMaxPages) && configuredMaxPages > 0
    ? configuredMaxPages
    : Number.POSITIVE_INFINITY;
  const firstResponse = await readExternalPage(readIntegration, request, requestOptions, 1, retryOptions);
  if (!request.input?.page) {
    const remote = remoteDataFromResponse(firstResponse);
    const collection = recordCollection(remote);
    const loaded = collection.records.length || (isRecord(remote?.product) ? 1 : 0);
    const total = explicitRemoteTotal(remote) ?? loaded;
    options.onFirstPage?.({ response: firstResponse, loaded, total, page: 1, totalPages: 1 });
    return { response: firstResponse, pageCount: 1 };
  }
  const firstRemote = remoteDataFromResponse(firstResponse);
  const firstCollection = recordCollection(firstRemote);
  if (!firstCollection.key) return { response: firstResponse, pageCount: 1 };
  const knownTotal = explicitRemoteTotal(firstRemote);
  const total = knownTotal ?? firstCollection.records.length;
  const explicitTotalPages = Number(firstRemote?.totalPages);
  const hasExplicitTotalPages = Number.isInteger(explicitTotalPages) && explicitTotalPages > 0;
  const availableTotalPages = hasExplicitTotalPages
    ? explicitTotalPages
    : Math.max(1, Math.ceil(total / pageSize));
  const totalPages = Math.min(availableTotalPages, maxPages);
  const pageLimitReached = totalPages < availableTotalPages;
  options.onFirstPage?.({
    response: firstResponse,
    loaded: firstCollection.records.length,
    total,
    page: 1,
    totalPages,
  });
  if (knownTotal === null && !hasExplicitTotalPages && firstRemote?.hasNextPage === true) {
    const records = [...firstCollection.records];
    let pageNumber = 2;
    let hasNextPage = true;
    while (hasNextPage && pageNumber <= maxPages) {
      const response = await readExternalPage(
        readIntegration,
        request,
        requestOptions,
        pageNumber,
        retryOptions,
      );
      const remote = remoteDataFromResponse(response);
      const collection = recordCollection(remote);
      if (!collection.records.length) break;
      records.push(...collection.records);
      options.onProgress?.({
        loaded: records.length,
        total: 0,
        page: pageNumber,
        totalPages: 0,
      });
      hasNextPage = remote?.hasNextPage === true
        || (remote?.hasNextPage !== false && collection.records.length >= pageSize);
      pageNumber += 1;
    }
    const mergedRecords = deduplicateExternalRecords(records);
    const pageCount = pageNumber - 1;
    const truncated = hasNextPage === true && pageNumber > maxPages;
    const remoteData = {
      ...firstRemote,
      [firstCollection.key]: mergedRecords,
      total: Math.max(total, mergedRecords.length),
      size: mergedRecords.length,
      currentSize: mergedRecords.length,
      totalPages: pageCount,
      providerTotalPages: hasExplicitTotalPages ? explicitTotalPages : 0,
      hasNextPage: truncated,
      allPagesLoaded: !truncated,
      loadedPages: pageCount,
      truncated,
    };
    return {
      response: responseWithRemoteData(firstResponse, remoteData),
      pageCount,
    };
  }
  if (totalPages <= 1 && firstRemote?.hasNextPage !== true) {
    const remoteData = {
      ...firstRemote,
      providerTotalPages: availableTotalPages,
      allPagesLoaded: !pageLimitReached,
      loadedPages: 1,
      hasNextPage: pageLimitReached,
      truncated: pageLimitReached,
    };
    return { response: responseWithRemoteData(firstResponse, remoteData), pageCount: 1 };
  }

  const recordsByPage = new Map([[1, firstCollection.records]]);
  let completedPages = 1;
  let loadedRecords = firstCollection.records.length;
  options.onProgress?.({ loaded: firstCollection.records.length, total, page: 1, totalPages });
  let nextPage = 2;
  const worker = async () => {
    while (nextPage <= totalPages) {
      throwIfAborted(options.signal);
      const pageNumber = nextPage;
      nextPage += 1;
      const response = await readExternalPage(
        readIntegration,
        request,
        requestOptions,
        pageNumber,
        retryOptions,
      );
      const collection = recordCollection(remoteDataFromResponse(response));
      recordsByPage.set(pageNumber, collection.records);
      completedPages += 1;
      loadedRecords += collection.records.length;
      options.onProgress?.({ loaded: loadedRecords, total, page: completedPages, totalPages });
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(EXTERNAL_OZON_PAGE_CONCURRENCY, Math.max(1, totalPages - 1)) },
    () => worker(),
  ));

  const allRecords = [];
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    allRecords.push(...(recordsByPage.get(pageNumber) || []));
  }
  const records = deduplicateExternalRecords(allRecords);
  const remoteData = {
    ...firstRemote,
    [firstCollection.key]: records,
    total: Math.max(total, records.length),
    size: records.length,
    current: 1,
    currentSize: records.length,
    totalPages,
    providerTotalPages: availableTotalPages,
    hasNextPage: pageLimitReached,
    allPagesLoaded: !pageLimitReached,
    loadedPages: totalPages,
    truncated: pageLimitReached,
  };
  return {
    response: responseWithRemoteData(firstResponse, remoteData),
    pageCount: totalPages,
  };
}

function firstExternalOzonProductRecord(response = {}, requestedSku = '') {
  const records = recordCollection(remoteDataFromResponse(response)).records;
  if (!records.length) return null;
  const normalizedSku = text(requestedSku);
  return records.find((record) => externalProductSku(record) === normalizedSku)
    || records[0]
    || null;
}

function detailMetric(record = {}, ...keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function productDetailResponseFromReport(primaryResponse = {}, reportResponse = {}, requestedSku = '') {
  const reportData = remoteDataFromResponse(reportResponse);
  const product = firstExternalOzonProductRecord(reportResponse, requestedSku);
  if (!isRecord(product)) return primaryResponse;
  const timeInterval = isRecord(reportData?.timeInterval) ? reportData.timeInterval : {};
  return responseWithRemoteData(primaryResponse, {
    product,
    totalSales: detailMetric(product, 'totalSales', 'sales', 'monthlySales'),
    totalRevenue: detailMetric(product, 'totalRevenue', 'revenue', 'monthlyRevenue'),
    dailySales: detailMetric(product, 'dailySales', 'averageDailyUnits'),
    stock: detailMetric(product, 'stock'),
    startDate: detailMetric(product, 'startDate') || timeInterval.min || '',
    endDate: detailMetric(product, 'endDate') || timeInterval.max || '',
    categoryRanks: Array.isArray(product.categoryRanks) ? product.categoryRanks : [],
    salesTrendVOList: Array.isArray(product.salesTrendVOList) ? product.salesTrendVOList : [],
    detailSource: 'product-report-fallback',
  });
}

function isNonRecoverableExternalError(error) {
  if (error?.name === 'AbortError') return true;
  const code = text(error?.code || error?.payload?.error?.code);
  return /AUTH|BALANCE|INPUT_INVALID|API_KEY_REQUIRED/iu.test(code);
}

function seerfarRecoveryCategories(input = {}) {
  return uniqueTextValues([
    ...(input.categories || []),
    ...(input[SEERFAR_RECOVERY_CATEGORIES_KEY] || []),
  ]);
}

function marketRecoveryInput(input = {}) {
  const recovered = { ...input };
  [
    'keyword',
    'keywords',
    'matchType',
    'includeKeywords',
    'excludeKeywords',
    'relevancy',
    'uniqQueriesWCa',
    'ca',
    'wordCount',
    'titleDensity',
    'adRivalCount',
    SEERFAR_RECOVERY_CATEGORIES_KEY,
  ].forEach((key) => delete recovered[key]);
  const categories = seerfarRecoveryCategories(input);
  if (categories.length) recovered.categories = categories;
  else delete recovered.categories;
  recovered.page = defaultPage('searchVolume', EXTERNAL_OZON_MARKET_KEYWORD_OPERATION);
  return recovered;
}

function keywordRecoveryResponse(
  operation,
  primaryResponse,
  fallbackResponse,
  input = {},
) {
  const fallbackRemote = remoteDataFromResponse(fallbackResponse);
  const collection = recordCollection(fallbackRemote);
  const categories = seerfarRecoveryCategories(input);
  const seeds = input.keyword ? [input.keyword] : uniqueTextValues(input.keywords || []);
  const records = annotateSeerfarKeywordRecoveryRecords(
    collection.records,
    seeds,
    {
      strictMatch: categories.length === 0 && seeds.length > 0,
      source: categories.length ? 'market-category-recovery' : 'market-scan-recovery',
    },
  );
  const strictRecovery = categories.length === 0 && seeds.length > 0;
  const remoteData = {
    ...fallbackRemote,
    [collection.key || 'records']: records,
    total: strictRecovery ? records.length : Math.max(Number(fallbackRemote?.total) || 0, records.length),
    size: records.length,
    currentSize: records.length,
    recoverySource: categories.length ? 'market-category' : 'market-scan',
    recoverySeed: seeds.join(' / '),
  };
  return {
    ...responseWithRemoteData(primaryResponse || fallbackResponse, remoteData),
    operation,
  };
}

async function readKeywordRecoveryFromMarket(request = {}, options = {}, primaryResponse = null) {
  const fallback = await readAllSmartToolExternalOzonPages({
    profileId: request.profileId,
    operation: EXTERNAL_OZON_MARKET_KEYWORD_OPERATION,
    input: marketRecoveryInput(request.input),
  }, {
    ...options,
    onFirstPage: options.onFirstPage
      ? ({ response, loaded, total, page, totalPages }) => options.onFirstPage({
        response: keywordRecoveryResponse(
          request.operation,
          primaryResponse,
          response,
          request.input,
        ),
        loaded,
        total,
        page,
        totalPages,
      })
      : undefined,
    maxPages: EXTERNAL_OZON_MARKET_MAX_PAGES,
  });
  return {
    response: keywordRecoveryResponse(
      request.operation,
      primaryResponse,
      fallback.response,
      request.input,
    ),
    pageCount: fallback.pageCount,
  };
}

async function readSmartToolExternalOzonRequest(request = {}, options = {}) {
  const isKeywordMining = request.operation === EXTERNAL_OZON_KEYWORD_MINING_OPERATION;
  const isFilteredMarket = request.operation === EXTERNAL_OZON_MARKET_KEYWORD_OPERATION
    && request.input?.keywords?.length;
  if (isKeywordMining || isFilteredMarket) {
    if (seerfarRecoveryCategories(request.input).length) {
      return readKeywordRecoveryFromMarket(request, options);
    }
    let primary = null;
    let primaryError = null;
    try {
      primary = await readAllSmartToolExternalOzonPages(request, {
        ...options,
        serverRetryLimit: isFilteredMarket ? 0 : options.serverRetryLimit,
        maxPages: request.operation === EXTERNAL_OZON_MARKET_KEYWORD_OPERATION
          ? EXTERNAL_OZON_MARKET_MAX_PAGES
          : options.maxPages,
      });
      if (recordCollection(remoteDataFromResponse(primary.response)).records.length) return primary;
    } catch (error) {
      if (isNonRecoverableExternalError(error)) throw error;
      primaryError = error;
    }
    try {
      return await readKeywordRecoveryFromMarket(request, options, primary?.response || null);
    } catch (fallbackError) {
      if (isNonRecoverableExternalError(fallbackError)) throw fallbackError;
      if (primary) return primary;
      throw primaryError || fallbackError;
    }
  }

  if (request.operation !== EXTERNAL_OZON_PRODUCT_DETAIL_OPERATION) {
    return readAllSmartToolExternalOzonPages(request, {
      ...options,
      maxPages: request.operation === EXTERNAL_OZON_MARKET_KEYWORD_OPERATION
        ? EXTERNAL_OZON_MARKET_MAX_PAGES
        : options.maxPages,
    });
  }

  // The detail endpoint legitimately returns data:null for SKUs that are not in
  // its detail index.  Do not flash a false zero-result success before the
  // product-report fallback has had a chance to find the same SKU.
  const quietOptions = {
    ...options,
    onFirstPage: undefined,
    onProgress: undefined,
    serverRetryLimit: 0,
  };
  let primary = null;
  let primaryError = null;
  try {
    primary = await readAllSmartToolExternalOzonPages(request, quietOptions);
    const primaryData = remoteDataFromResponse(primary.response);
    if (isRecord(primaryData?.product)) {
      options.onFirstPage?.({ response: primary.response, loaded: 1, total: 1, page: 1, totalPages: 1 });
      return primary;
    }
  } catch (error) {
    if (isNonRecoverableExternalError(error)) throw error;
    primaryError = error;
  }

  const sku = text(request.input?.sku);
  if (!sku) {
    if (primary) return primary;
    throw primaryError || new Error('商品详情查询失败。');
  }
  try {
    const fallback = await readAllSmartToolExternalOzonPages({
      profileId: request.profileId,
      operation: EXTERNAL_OZON_PRODUCT_REPORT_OPERATION,
      input: {
        skus: [sku],
        variationsMerge: 0,
        page: defaultPage('revenue', EXTERNAL_OZON_PRODUCT_REPORT_OPERATION),
      },
    }, quietOptions);
    const response = productDetailResponseFromReport(
      primary?.response || fallback.response,
      fallback.response,
      sku,
    );
    const loaded = isRecord(remoteDataFromResponse(response)?.product) ? 1 : 0;
    if (loaded) options.onFirstPage?.({ response, loaded, total: loaded, page: 1, totalPages: 1 });
    return { response, pageCount: 1 };
  } catch (error) {
    if (isNonRecoverableExternalError(error)) throw error;
    if (primary) return primary;
    throw primaryError || error;
  }
}

function mergeExternalOzonPageResults(results = []) {
  const usable = (Array.isArray(results) ? results : []).filter((item) => item?.response);
  if (!usable.length) throw new Error('外部数据接口没有返回可合并的数据。');
  if (usable.length === 1) return usable[0];
  const first = usable[0];
  const firstRemote = remoteDataFromResponse(first.response);
  const firstCollection = recordCollection(firstRemote);
  const records = deduplicateExternalRecords(usable.flatMap((item) => (
    recordCollection(remoteDataFromResponse(item.response)).records
  )));
  const pageCount = usable.reduce((sum, item) => sum + (Number(item.pageCount) || 1), 0);
  const remoteData = {
    ...firstRemote,
    [firstCollection.key || 'records']: records,
    total: records.length,
    size: records.length,
    current: 1,
    currentSize: records.length,
    totalPages: pageCount,
    hasNextPage: false,
    allPagesLoaded: true,
    loadedPages: pageCount,
  };
  return {
    response: responseWithRemoteData(first.response, remoteData),
    pageCount,
  };
}

export function buildSmartToolExternalOzonInput(tool = {}, values = {}) {
  const raw = firstInputValue(values);
  switch (tool.id) {
    case 'linkfox-seerfar-ozon-shop-search': {
      const id = extractSmartToolOzonNumericReference(raw, { allowNegative: true });
      if (!id) throw new Error('请填写数字店铺 ID，或粘贴完整 Ozon 店铺链接。');
      return { id: Number(id), page: defaultPage('sales', 'ozon-shop-search') };
    }
    case 'linkfox-seerfar-ozon-product-detail-search': {
      const reference = text(values?.['商品 SKU 或链接']) || raw;
      const sku = extractSmartToolOzonNumericReference(reference);
      if (!sku) throw new Error('请填写数字 SKU，或粘贴完整 Ozon 商品链接。');
      const manualData = normalizeExternalProductManualData(values);
      return {
        sku,
        dateRange: 'past_30_days',
        analysisMode: normalizeExternalProductAnalysisMode(
          values?.[EXTERNAL_PRODUCT_ANALYSIS_MODE_INPUT_LABEL],
        ),
        ...(hasExternalProductManualData(manualData) ? { manualData } : {}),
      };
    }
    case 'linkfox-seerfar-ozon-category-search':
      if (!/^\d+(?:_\d+)*$/u.test(raw)) throw new Error('请选择类目，或填写完整类目 ID。');
      return { categoryId: raw, page: defaultPage('revenue', 'seerfar-ozon-category-search') };
    case 'linkfox-seerfar-ozon-product-report-search': { // keyword, SKU and URL share one compact list
      const items = splitSmartToolUsageInputItems(raw, { splitWhitespace: false });
      if (!items.length) throw new Error('请至少填写一个商品关键词、SKU 或 Ozon 商品链接。');
      const references = items.map((item) => extractSmartToolOzonNumericReference(item));
      if (items.some((item, index) => /^https?:\/\//iu.test(item) && !references[index])) {
        throw new Error('商品链接中没有识别到 SKU，请换成完整 Ozon 商品链接。');
      }
      const skus = references.filter(Boolean);
      const keywords = items.filter((item, index) => !references[index]);
      if (skus.length > 10) throw new Error('商品筛选一次最多填写 10 个 SKU 或商品链接。');
      return {
        ...(skus.length ? { skus } : {}),
        ...(keywords.length ? { keywords } : {}),
        variationsMerge: 0,
        page: defaultPage('revenue'),
      };
    }
    case 'linkfox-seerfar-ozon-keyword-mining':
      if (!raw) throw new Error('请先填写俄语种子关键词。');
      return { keyword: raw, matchType: 0, page: defaultPage('relevancy') };
    case 'linkfox-seerfar-ozon-market-keyword-search': {
      const parsed = parseSmartToolMarketKeywordItems(
        splitSmartToolUsageInputItems(raw, { splitWhitespace: false }),
      );
      return {
        ...(parsed.keywords.length ? { keywords: parsed.keywords } : {}),
        ...(parsed.categories.length ? { categories: parsed.categories } : {}),
        ...parsed.ranges,
        ...(parsed.searchDate ? { searchDate: parsed.searchDate } : {}),
        ...(parsed.platformFilter.length ? { platformFilter: parsed.platformFilter } : {}),
        matchType: parsed.matchType,
        page: {
          ...defaultPage(parsed.order.field),
          orders: [parsed.order],
        },
      };
    }
    case 'linkfox-seerfar-ozon-keyword-back-search': {
      const skuIds = splitSmartToolUsageInputItems(raw, { splitWhitespace: true })
        .map((item) => extractSmartToolOzonNumericReference(item))
        .filter(Boolean);
      if (!skuIds.length) throw new Error('请至少填写一个数字 SKU 或完整 Ozon 商品链接。');
      return { skuIds, hasVariant: 0, page: defaultPage('exposure') };
    }
    default:
      throw new Error('当前工具没有对应的只读查询规则。');
  }
}

function profileIsReady(profile = {}) {
  const testedAt = new Date(profile.lastTestAt).getTime();
  return profile.hasApiKey === true
    && profile.lastTestStatus === 'connected'
    && Number.isFinite(testedAt)
    && Date.now() - testedAt >= 0
    && Date.now() - testedAt <= 10 * 60 * 1000;
}

export function selectSmartToolExternalProfile(profiles = [], providerType = 'seerfar-open-api') {
  return (Array.isArray(profiles) ? profiles : [])
    .filter((profile) => profile.integrationType === providerType && profileIsReady(profile))
    .sort((left, right) => {
      const leftConnected = left.lastTestStatus === 'connected' ? 1 : 0;
      const rightConnected = right.lastTestStatus === 'connected' ? 1 : 0;
      return rightConnected - leftConnected
        || text(right.updatedAt).localeCompare(text(left.updatedAt));
    })[0] || null;
}

export function canUseSmartToolExternalOzonData(toolOrId = '') {
  const id = typeof toolOrId === 'string' ? toolOrId : toolOrId?.id;
  return EXTERNAL_OZON_TOOL_ROUTES.has(text(id));
}

export async function runSmartToolDraftWithExternalOzonData(tool = {}, values = {}, options = {}) {
  if (!canUseSmartToolExternalOzonData(tool)) throw new Error('当前不是外部数据查询工具。');
  throwIfAborted(options.signal);
  const route = EXTERNAL_OZON_TOOL_ROUTES.get(text(tool.id));
  const profileResult = await (options.listProfiles || listIntegrationProfiles)({
    timeoutMs: 10000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const profile = selectSmartToolExternalProfile(profileResult?.profiles, route.providerType)
    || { id: 'builtin-points', integrationType: route.providerType };
  const queryInput = buildSmartToolExternalOzonInput(tool, values);
  const input = await resolveSmartToolExternalOzonInput(tool, queryInput, options);
  const providerInput = { ...input };
  delete providerInput.manualData;
  const displayInput = publicExternalInput(input);
  const requestInputs = splitSmartToolExternalOzonInputs(tool, providerInput);
  const pageResults = [];
  const createdAt = new Date().toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  for (let index = 0; index < requestInputs.length; index += 1) {
    throwIfAborted(options.signal);
    const request = {
      profileId: profile.id,
      operation: route.operation,
      input: requestInputs[index],
    };
    pageResults.push(await readSmartToolExternalOzonRequest(request, {
      ...options,
      onFirstPage: options.onPartialDraft
        ? ({ response, loaded = 0, total = 0, totalPages = 1 }) => {
          const displayResponse = applyExternalOzonClientFilters(tool, response, input);
          const partialResult = buildExternalOzonQueryResult(tool, displayResponse, {
            ...displayInput,
            ...(input.page ? { page: { ...input.page, allPages: false } } : {}),
            ...(queryInput.keyword ? { keyword: queryInput.keyword } : {}),
            ...(queryInput.keywords?.length ? { keywords: queryInput.keywords } : {}),
          });
          options.onPartialDraft({
            toolId: tool.id,
            toolTitle: tool.title || '数据查询',
            createdAt,
            result: {
              ...partialResult,
              status: 'loading',
              statusLabel: '首批数据已返回，正在继续读取',
              summary: total > loaded
                ? `首批 ${loaded} 条已可查看；正在后台读取剩余数据（共 ${total} 条 / ${totalPages} 页）。`
                : `已返回 ${loaded} 条真实数据。`,
            },
          });
        }
        : undefined,
      onProgress: options.onProgress
        ? (progress) => options.onProgress({ ...progress, group: index + 1, groups: requestInputs.length })
        : undefined,
    }));
  }
  const { response, pageCount } = mergeExternalOzonPageResults(pageResults);
  const displayResponse = applyExternalOzonClientFilters(tool, response, input);
  return {
    toolId: tool.id,
    toolTitle: tool.title || '数据查询',
    createdAt,
    result: buildExternalOzonQueryResult(tool, displayResponse, {
      ...displayInput,
      ...(input.page ? { page: { ...input.page, allPages: true, loadedPages: pageCount } } : {}),
      ...(queryInput.keyword ? { keyword: queryInput.keyword } : {}),
      ...(queryInput.keywords?.length ? { keywords: queryInput.keywords } : {}),
    }),
  };
}

function externalProductSku(record = {}) {
  return text(record?.sku || record?.ozonId || record?.productId || record?.id);
}

async function readExternalProductDetail(profileId, sku, options = {}) {
  throwIfAborted(options.signal);
  const result = await readSmartToolExternalOzonRequest({
    profileId,
    operation: EXTERNAL_OZON_PRODUCT_DETAIL_OPERATION,
    input: { sku, dateRange: 'past_30_days' },
  }, {
    ...options,
    onFirstPage: undefined,
    onProgress: undefined,
  });
  return result.response;
}

export async function enrichSmartToolExternalOzonProduct(record = {}, options = {}) {
  const sku = externalProductSku(record);
  if (!sku) throw new Error('当前商品没有可查询的 SKU。');
  if (record?.sfEnrich !== true && text(record?.sfSource) !== 'seerfar-open-api') return record;
  if (record?.sfDetailComplete === true) return record;
  throwIfAborted(options.signal);
  const profileResult = await (options.listProfiles || listIntegrationProfiles)({
    timeoutMs: 10000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const profile = selectSmartToolExternalProfile(profileResult?.profiles, 'seerfar-open-api');
  if (!profile) throw new Error('请先在设置中保存可用的数据接口 API Key。');
  const cacheKey = `${profile.id}:${sku}`;
  const cached = externalOzonProductDetailCache.get(cacheKey);
  if (cached?.expiresAt > Date.now() && cached.detailData) {
    return normalizeSmartToolExternalProduct(record, cached.detailData);
  }
  let pending = externalOzonProductDetailRequests.get(cacheKey);
  if (!pending) {
    pending = readExternalProductDetail(profile.id, sku, options)
      .then((response) => {
        const detailData = remoteDataFromResponse(response);
        if (!isRecord(detailData?.product)) throw new Error('商品详情接口没有返回商品资料。');
        externalOzonProductDetailCache.set(cacheKey, {
          detailData,
          expiresAt: Date.now() + EXTERNAL_OZON_PRODUCT_DETAIL_CACHE_TTL_MS,
        });
        return detailData;
      })
      .finally(() => externalOzonProductDetailRequests.delete(cacheKey));
    externalOzonProductDetailRequests.set(cacheKey, pending);
  }
  const detailData = await pending;
  return normalizeSmartToolExternalProduct(record, detailData);
}

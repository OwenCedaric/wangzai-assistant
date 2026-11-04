import { getProfitOrderRecordKey } from './profitOrderRecordRules.jsx';
import { isPartialCompensationSale } from '../../services/profitPartialCompensation.js';
import { getProfitPenaltyDetails } from '../../services/profitFinanceBreakdown';
import {
  canUseFinanceParentFallback,
  getFinancePostingLookupGroups,
  selectFinanceOperationsExactFirst,
} from '../../services/profitFinanceMatching';
import { createProfitLedgerRow } from '../../services/profitLedgerService';
import { buildProfitPenaltyAttributionIndex } from '../../services/profitPenaltyAttribution';
import { createOzonRatingPenaltyOperations, extractOzonRatingPenaltyRows } from '../../services/profitRatingPenalty';
import {
  OZON_FINANCE_POSTING_CONCURRENCY,
  PROFIT_FINANCE_CACHE_TTL_MS,
  PROFIT_FINANCE_CACHE_VERSION,
  PROFIT_FINANCE_ROW_LOOKBACK_DAYS,
} from '../../shared/config/appConfigCore.jsx';
import { chunkValues } from '../../shared/lib/collectionUtils.js';
import { getExplicitOzonTimeRange, getOzonOrderDateRange } from '../order/orderShopScope.jsx';
import { firstFilled, firstUsableOzonId, getOzonShopClientId, normalizeOzonId } from '../order/orderIdentityRules.jsx';
import { requestOzonReadOnlyVariantsWithRows } from '../product/productOzonApi.jsx';
import {
  getFinanceOperationDedupKey,
  getOzonFinanceDateChunks,
  getProfitFinancePostingLookupKeys,
  getProfitFinancePostingRequests,
  getProfitFinanceRowDateMs,
  getProfitOrderFinanceLookupGroups,
  getProfitOrderStableRecordKey,
  getProfitPostingBaseKey,
  getProfitPostingLookupKeys,
  requestOzonFinanceOperationsForPostingCached,
} from './profitFinanceEvidence.jsx';
import { getProfitLedgerEntryValue, getProfitLedgerRowKey } from './profitLedgerEntryRules.jsx';
import { getProfitActualStatusText, isProfitFinalZeroAllowedStatus } from './profitStatusRules.jsx';
import { createOwnerCacheReadFence } from '../../services/ownerCacheReadFence.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

const PROFIT_ACTUAL_FINANCE_AMOUNT_KEYS = [
  'actualOzonFeeCny',
  'actualCommissionFeeCny',
  'actualPenaltyFeeCny',
  'actualAcquiringFeeCny',
  'actualDeliveryServiceFeeCny',
  'actualLogisticsFeeCny',
  'platformNetCny',
];

function hasProfitLedgerActualFinanceEvidence(ledger = null) {
  const amounts = ledger?.amounts && typeof ledger.amounts === 'object' ? ledger.amounts : {};
  return PROFIT_ACTUAL_FINANCE_AMOUNT_KEYS.some((key) => {
    const entry = amounts[key];
    if (!entry || typeof entry !== 'object') return false;
    const source = normalizeText(entry.source);
    if (source !== 'ozon-finance' && !source.startsWith('ozon-finance-')) return false;
    return getProfitLedgerEntryValue(entry) !== null;
  });
}

function getProfitOrderRubToCnyRate(row = {}) {
  return (
    row.profitLedger?.exchangeRates?.actual?.rubToCnyRate ??
    row.profitLedger?.actualExchangeRate?.rubToCnyRate ??
    row.exchangeRates?.actual?.rubToCnyRate ??
    row.actualExchangeRate?.rubToCnyRate ??
    row.profitLedger?.exchangeRates?.estimated?.rubToCnyRate ??
    row.profitLedger?.exchangeRate?.rubToCnyRate ??
    row.exchangeRates?.estimated?.rubToCnyRate ??
    row.exchangeRate?.rubToCnyRate ??
    row.rubToCnyRate ??
    null
  );
}

export async function requestOzonFinanceOperationsSnapshot(shop, rows = [], options = {}) {
  const allPostingRequests = getProfitFinancePostingRequests(rows, {
    dateRange: options.dateRange,
    timeScope: options.timeScope,
    startDate: options.startDate,
    endDate: options.endDate,
    maxLookupKeys: options.maxLookupKeys,
    preferBaseLookup: options.preferBaseLookup,
    stopAfterFirstMatchedLookup: options.stopAfterFirstMatchedLookup,
  });
  const maxPostingNumbers = Math.max(0, Number(options.maxPostingNumbers) || 0);
  const postingRequests = maxPostingNumbers ? allPostingRequests.slice(0, maxPostingNumbers) : allPostingRequests;
  const skippedPostingCount = Math.max(0, allPostingRequests.length - postingRequests.length);
  const postingConcurrency = Math.max(1, Number(options.postingConcurrency) || OZON_FINANCE_POSTING_CONCURRENCY);
  const operations = [];
  const seen = new Set();
  const errors = [];
  const checkedPostingNumbers = [];

  if (skippedPostingCount > 0) {
    errors.push({
      ok: false,
      label: '财务流水限流',
      error: new Error(`本轮跳过 ${skippedPostingCount} 个订单的财务流水补充，稍后或手动刷新继续读取。`),
    });
  }

  for (const chunk of chunkValues(postingRequests, postingConcurrency)) {
    const chunkResults = await Promise.allSettled(
      chunk.map((request) =>
        requestOzonFinanceOperationsForPostingCached(shop, request.postingNumber, request.dateRange, {
          forceRefresh: options.forceRefresh,
          maxLookupKeys: options.maxLookupKeys,
          preferBaseLookup: options.preferBaseLookup,
          stopAfterFirstMatchedLookup: options.stopAfterFirstMatchedLookup,
        })
      )
    );
    chunkResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const postingNumber = chunk[index]?.postingNumber;
        if (postingNumber) checkedPostingNumbers.push(postingNumber);
        return;
      }
      if (result.status === 'rejected') {
        errors.push({ postingNumber: chunk[index]?.postingNumber, error: result.reason });
      }
    });
    chunkResults
      .filter((result) => result.status === 'fulfilled')
      .flatMap((result) => result.value)
      .forEach((operation) => {
        const key = getFinanceOperationDedupKey(operation);
        if (seen.has(key)) return;
        seen.add(key);
        operations.push(operation);
      });
  }

  return { operations, errors, checkedPostingNumbers };
}

export function buildOzonRatingIndexPostingListBodies({ from, to, postingNumber, limit, offset, forceRefresh }) {
  const normalizedPostingNumber = normalizeOzonId(postingNumber).trim();
  const fromDate = String(from || '').slice(0, 10);
  const toDate = String(to || '').slice(0, 10);
  const page = Math.floor((Number(offset) || 0) / limit) + 1;
  const filterWithIsoDate = {
    date_from: from,
    date_to: to,
  };
  const filterWithDateOnly = {
    date_from: fromDate,
    date_to: toDate,
  };
  const filterWithIsoDateAndPosting = normalizedPostingNumber
    ? { ...filterWithIsoDate, posting_number: normalizedPostingNumber }
    : filterWithIsoDate;
  const filterWithDateOnlyAndPosting = normalizedPostingNumber
    ? { ...filterWithDateOnly, posting_number: normalizedPostingNumber }
    : filterWithDateOnly;
  const postingOnlyBody = normalizedPostingNumber
    ? [
        { date_from: fromDate, date_to: toDate, posting_number: normalizedPostingNumber, limit, offset },
        { from: fromDate, to: toDate, posting_number: normalizedPostingNumber, limit, offset },
        { posting_number: normalizedPostingNumber, limit, offset },
      ]
    : [];
  const bodies = [
    { filter: filterWithIsoDateAndPosting, limit, offset },
    { filter: filterWithIsoDateAndPosting, page, page_size: limit },
    { filter: filterWithDateOnlyAndPosting, limit, offset },
    { filter: filterWithDateOnlyAndPosting, page, page_size: limit },
    { filter: { date_from: from, date_to: to }, limit, offset },
    { filter: { date_from: fromDate, date_to: toDate }, limit, offset },
    ...postingOnlyBody,
  ];
  return forceRefresh ? bodies.map((body) => ({ ...body, forceRefresh: true })) : bodies;
}

export function getRatingPenaltyOperationDedupKey(operation = {}) {
  const operationId = normalizeOzonId(operation.operation_id).trim();
  if (operationId) return `operation:${operationId}`;
  const posting = normalizeOzonId(operation.posting?.posting_number || operation.posting_number).trim();
  const type = normalizeOzonId(operation.operation_type_name || operation.operation_type).trim();
  const date = normalizeOzonId(operation.operation_date).trim();
  const amount = firstFilled(operation.error_fee_cny, operation.error_fee, operation.amount, 'pending');
  return `rating:${posting}:${date}:${type}:${amount}`;
}

export async function requestOzonRatingPenaltyOperationsForPosting(shop, postingNumber, dateRange, options = {}) {
  const operations = [];
  const seen = new Set();
  const dateChunks = getOzonFinanceDateChunks(dateRange.since, dateRange.to);
  const lookupPostingNumbers = getProfitFinancePostingLookupKeys(postingNumber, options);
  const requestPostingNumbers = lookupPostingNumbers.length ? lookupPostingNumbers : [''];
  const pageLimit = Math.max(1, Number(options.pageLimit) || 1000);

  for (const lookupPostingNumber of requestPostingNumbers) {
    const operationsBeforeLookup = operations.length;
    for (const chunk of dateChunks) {
      let offset = 0;
      while (true) {
        const data = await requestOzonReadOnlyVariantsWithRows(
          '/v1/rating/index/fbs/posting/list',
          shop,
          buildOzonRatingIndexPostingListBodies({
            from: chunk.from,
            to: chunk.to,
            postingNumber: lookupPostingNumber,
            limit: pageLimit,
            offset,
            forceRefresh: options.forceRefresh && offset === 0,
          }),
          extractOzonRatingPenaltyRows
        );
        const pageRows = extractOzonRatingPenaltyRows(data);
        const pageOperations = createOzonRatingPenaltyOperations(data, {
          shopId: shop?.id,
          shopClientId: getOzonShopClientId(shop),
          postingNumbers: getProfitFinancePostingLookupKeys(lookupPostingNumber, options),
        });
        pageOperations.forEach((operation) => {
          const key = getRatingPenaltyOperationDedupKey(operation);
          if (seen.has(key)) return;
          seen.add(key);
          operations.push(operation);
        });
        if (pageRows.length < pageLimit) break;
        offset += pageRows.length;
      }
    }
    if (options.stopAfterFirstMatchedLookup !== false && operations.length > operationsBeforeLookup) {
      break;
    }
  }

  return operations;
}

export const profitRatingPenaltyOperationCache = new Map();
const profitRatingPenaltyFencedOwnerIdentifiers = new Set();
const profitRatingPenaltyReadFence = createOwnerCacheReadFence();

function normalizeRatingCacheIdentifiers(identifiers = []) {
  return [...new Set((Array.isArray(identifiers) ? identifiers : [identifiers])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function getRatingCacheShopIdentifiers(shop = {}) {
  return normalizeRatingCacheIdentifiers([shop?.id, getOzonShopClientId(shop)]);
}

function isRatingCacheShopFenced(shop = {}) {
  return getRatingCacheShopIdentifiers(shop).some((identifier) => (
    profitRatingPenaltyFencedOwnerIdentifiers.has(identifier)
  ));
}

function assertRatingCacheShopWritable(shop = {}) {
  if (!isRatingCacheShopFenced(shop)) return;
  const error = new Error('ACCOUNT_REMOVAL_OWNER_QUIESCED');
  error.code = 'ACCOUNT_REMOVAL_OWNER_QUIESCED';
  throw error;
}

function ratingCacheKeyMatchesIdentifier(cacheKey, identifier) {
  const key = String(cacheKey);
  return key.startsWith(`${PROFIT_FINANCE_CACHE_VERSION}:rating:${identifier}:`)
    || key.startsWith(`${PROFIT_FINANCE_CACHE_VERSION}:rating-range:${identifier}:`);
}

export function fenceProfitRatingPenaltyCacheForOwner(identifiers = []) {
  const normalized = normalizeRatingCacheIdentifiers(identifiers);
  normalized.forEach((identifier) => profitRatingPenaltyFencedOwnerIdentifiers.add(identifier));
  profitRatingPenaltyReadFence.invalidate(normalized, profitRatingPenaltyOperationCache);
  return { identifiers: normalized, fenced: true };
}

export function releaseProfitRatingPenaltyOwnerFence(identifiers = []) {
  normalizeRatingCacheIdentifiers(identifiers).forEach(identifier => profitRatingPenaltyFencedOwnerIdentifiers.delete(identifier));
}

export function countProfitRatingPenaltyCacheEntriesForOwner(identifiers = []) {
  const normalized = normalizeRatingCacheIdentifiers(identifiers);
  return [...profitRatingPenaltyOperationCache.keys()].filter((key) => (
    normalized.some((identifier) => ratingCacheKeyMatchesIdentifier(key, identifier))
  )).length;
}

export function invalidateProfitRatingPenaltyCacheEntriesForOwner(identifiers = []) {
  const normalized = normalizeRatingCacheIdentifiers(identifiers);
  let removedCount = profitRatingPenaltyReadFence.invalidate(normalized, profitRatingPenaltyOperationCache).removedCacheEntries;
  for (const [key, entry] of profitRatingPenaltyOperationCache) {
    if (entry?.readTicket) continue;
    if (!normalized.some((identifier) => ratingCacheKeyMatchesIdentifier(key, identifier))) continue;
    profitRatingPenaltyOperationCache.delete(key);
    removedCount += 1;
  }
  return { removedCount };
}

export function getProfitRatingPenaltyOperationCacheKey(shop, postingNumber, dateRange, options = {}) {
  const ownerId = String(shop?.id || getOzonShopClientId(shop) || '').trim();
  if (!ownerId) throw new Error('错误指数缓存缺少明确的店铺标识。');
  const posting = normalizeOzonId(postingNumber).trim();
  const lookupMode = [
    options.preferBaseLookup === false ? 'raw-first' : 'base-first',
    options.stopAfterFirstMatchedLookup === false ? 'all-matches' : 'first-match',
    Number(options.maxLookupKeys) > 0 ? `max-${Number(options.maxLookupKeys)}` : 'max-all',
  ].join(':');
  return `${PROFIT_FINANCE_CACHE_VERSION}:rating:${ownerId}:${posting}:${dateRange.since}:${dateRange.to}:${lookupMode}`;
}

export async function requestOzonRatingPenaltyOperationsForPostingCached(shop, postingNumber, dateRange, options = {}) {
  assertRatingCacheShopWritable(shop);
  const cacheKey = getProfitRatingPenaltyOperationCacheKey(shop, postingNumber, dateRange, options);
  const cached = profitRatingPenaltyOperationCache.get(cacheKey);
  if (!options.forceRefresh && cached) {
    if (cached.promise) return cached.promise;
    if (Date.now() - cached.createdAt < PROFIT_FINANCE_CACHE_TTL_MS) return cached.value;
  }

  const readTicket = profitRatingPenaltyReadFence.capture(getRatingCacheShopIdentifiers(shop));
  const promise = requestOzonRatingPenaltyOperationsForPosting(shop, postingNumber, dateRange, options)
    .then((value) => {
      if (readTicket.current && !isRatingCacheShopFenced(shop)
        && profitRatingPenaltyOperationCache.get(cacheKey)?.promise === promise) {
        profitRatingPenaltyOperationCache.set(cacheKey, { createdAt: Date.now(), value });
      }
      return value;
    })
    .catch((error) => {
      if (profitRatingPenaltyOperationCache.get(cacheKey)?.promise === promise) profitRatingPenaltyOperationCache.delete(cacheKey);
      throw error;
    })
    .finally(() => readTicket.finish());
  if (readTicket.current && !isRatingCacheShopFenced(shop)) profitRatingPenaltyOperationCache.set(cacheKey, { createdAt: Date.now(), promise, readTicket });
  return promise;
}

export function getProfitRatingPenaltyBulkDateRange(rows = [], fallbackRange = getOzonOrderDateRange()) {
  const times = rows.map((row) => getProfitFinanceRowDateMs(row)).filter((time) => Number.isFinite(time) && time > 0);
  if (!times.length) return fallbackRange;

  const start = new Date(Math.min(...times));
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - PROFIT_FINANCE_ROW_LOOKBACK_DAYS);

  const end = new Date();
  end.setHours(23, 59, 59, 999);
  if (end <= start) return fallbackRange;
  return { since: start.toISOString(), to: end.toISOString() };
}

export function getProfitRatingPenaltyDateRangeCacheKey(shop, dateRange, options = {}) {
  const ownerId = String(shop?.id || getOzonShopClientId(shop) || '').trim();
  if (!ownerId) throw new Error('错误指数缓存缺少明确的店铺标识。');
  const sinceKey = String(dateRange?.since || '').slice(0, 10);
  const toKey = String(dateRange?.to || '').slice(0, 10);
  const pageLimit = Math.max(1, Number(options.pageLimit) || 1000);
  return `${PROFIT_FINANCE_CACHE_VERSION}:rating-range:${ownerId}:${sinceKey}:${toKey}:limit-${pageLimit}`;
}

export async function requestOzonRatingPenaltyOperationsForDateRange(shop, dateRange, options = {}) {
  const operations = [];
  const seen = new Set();
  const dateChunks = getOzonFinanceDateChunks(dateRange.since, dateRange.to).slice().reverse();
  const pageLimit = Math.max(1, Number(options.pageLimit) || 1000);
  const chunkErrors = [];
  let successfulChunks = 0;

  for (const chunk of dateChunks) {
    try {
      let offset = 0;
      while (true) {
        const data = await requestOzonReadOnlyVariantsWithRows(
          '/v1/rating/index/fbs/posting/list',
          shop,
          buildOzonRatingIndexPostingListBodies({
            from: chunk.from,
            to: chunk.to,
            postingNumber: '',
            limit: pageLimit,
            offset,
            forceRefresh: options.forceRefresh && offset === 0,
          }),
          extractOzonRatingPenaltyRows
        );
        successfulChunks += offset === 0 ? 1 : 0;
        const pageRows = extractOzonRatingPenaltyRows(data);
        const pageOperations = createOzonRatingPenaltyOperations(data, {
          shopId: shop?.id,
          shopClientId: getOzonShopClientId(shop),
        });
        pageOperations.forEach((operation) => {
          const key = getRatingPenaltyOperationDedupKey(operation);
          if (seen.has(key)) return;
          seen.add(key);
          operations.push(operation);
        });
        if (pageRows.length < pageLimit) break;
        offset += pageRows.length;
      }
    } catch (error) {
      chunkErrors.push({ chunk, error });
    }
  }

  if (!successfulChunks && chunkErrors.length) {
    const error = new Error('错误指数分段读取全部失败');
    error.cause = chunkErrors[0]?.error;
    error.chunkErrors = chunkErrors;
    error.partialOperations = operations;
    throw error;
  }
  if (chunkErrors.length) {
    const error = new Error('错误指数分段读取部分失败，请重试未完成分段。');
    error.cause = chunkErrors[0]?.error;
    error.chunkErrors = chunkErrors;
    error.partialOperations = operations;
    throw error;
  }

  return operations;
}

export async function requestOzonRatingPenaltyOperationsForDateRangeCached(shop, dateRange, options = {}) {
  assertRatingCacheShopWritable(shop);
  const cacheKey = getProfitRatingPenaltyDateRangeCacheKey(shop, dateRange, options);
  const cached = profitRatingPenaltyOperationCache.get(cacheKey);
  if (!options.forceRefresh && cached) {
    if (cached.promise) return cached.promise;
    if (Date.now() - cached.createdAt < PROFIT_FINANCE_CACHE_TTL_MS) return cached.value;
  }

  const readTicket = profitRatingPenaltyReadFence.capture(getRatingCacheShopIdentifiers(shop));
  const promise = requestOzonRatingPenaltyOperationsForDateRange(shop, dateRange, options)
    .then((value) => {
      if (readTicket.current && !isRatingCacheShopFenced(shop)
        && profitRatingPenaltyOperationCache.get(cacheKey)?.promise === promise) {
        profitRatingPenaltyOperationCache.set(cacheKey, { createdAt: Date.now(), value });
      }
      return value;
    })
    .catch((error) => {
      if (profitRatingPenaltyOperationCache.get(cacheKey)?.promise === promise) profitRatingPenaltyOperationCache.delete(cacheKey);
      throw error;
    })
    .finally(() => readTicket.finish());
  if (readTicket.current && !isRatingCacheShopFenced(shop)) profitRatingPenaltyOperationCache.set(cacheKey, { createdAt: Date.now(), promise, readTicket });
  return promise;
}

export async function requestOzonRatingPenaltyBulkOperationsForRows(shop, rows = [], options = {}) {
  if (!rows.length) return { operations: [], errors: [] };
  const operations = [];
  const errors = [];
  const seen = new Set();
  const addOperation = (operation) => {
    const key = getRatingPenaltyOperationDedupKey(operation);
    if (seen.has(key)) return;
    seen.add(key);
    operations.push(operation);
  };

  try {
    const dateRange = getExplicitOzonTimeRange(options) || getProfitRatingPenaltyBulkDateRange(rows);
    const bulkOperations = await requestOzonRatingPenaltyOperationsForDateRangeCached(shop, dateRange, {
      forceRefresh: options.forceRefresh,
      pageLimit: options.pageLimit,
    });
    bulkOperations.forEach(addOperation);
  } catch (error) {
    errors.push({ ok: false, label: '错误指数批量读取', error });
  }

  const ratingPenaltyIndex = buildProfitPenaltyAttributionIndex(rows, operations);
  const fallbackRows = getProfitRowsNeedingRatingPenaltyPostingFallback(rows, ratingPenaltyIndex);
  const allPostingRequests = getProfitFinancePostingRequests(fallbackRows, {
    dateRange: options.dateRange,
    timeScope: options.timeScope,
    startDate: options.startDate,
    endDate: options.endDate,
    maxLookupKeys: options.maxLookupKeys,
    preferBaseLookup: options.preferBaseLookup,
    stopAfterFirstMatchedLookup: options.stopAfterFirstMatchedLookup,
  });
  const maxPostingNumbers = Math.max(0, Number(options.maxPostingNumbers) || 0);
  const postingRequests = maxPostingNumbers ? allPostingRequests.slice(0, maxPostingNumbers) : allPostingRequests;
  const skippedPostingCount = Math.max(0, allPostingRequests.length - postingRequests.length);
  const postingConcurrency = Math.max(1, Number(options.postingConcurrency) || OZON_FINANCE_POSTING_CONCURRENCY);

  if (skippedPostingCount > 0) {
    errors.push({
      ok: false,
      label: '错误指数单号补查限流',
      error: new Error(`本轮跳过 ${skippedPostingCount} 个订单的罚款单号补查，稍后继续读取。`),
    });
  }

  for (const chunk of chunkValues(postingRequests, postingConcurrency)) {
    const chunkResults = await Promise.allSettled(
      chunk.map((request) =>
        requestOzonRatingPenaltyOperationsForPostingCached(shop, request.postingNumber, request.dateRange, {
          forceRefresh: options.forceRefresh,
          maxLookupKeys: options.maxLookupKeys,
          preferBaseLookup: options.preferBaseLookup,
          stopAfterFirstMatchedLookup: options.stopAfterFirstMatchedLookup,
        })
      )
    );
    chunkResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        errors.push({ postingNumber: chunk[index]?.postingNumber, error: result.reason });
      }
    });
    chunkResults
      .filter((result) => result.status === 'fulfilled')
      .flatMap((result) => result.value)
      .forEach(addOperation);
  }

  return { operations, errors };
}

export function getProfitRowsNeedingRatingPenaltyLookup(rows = [], financeIndex = new Map()) {
  return rows.filter((row) => {
    const penaltyOperations = getProfitOrderPenaltyFinanceOperations(row, financeIndex);
    const details = getProfitPenaltyDetails(penaltyOperations, {
      rubToCnyRate: getProfitOrderRubToCnyRate(row),
      shopId: row.shopId,
      shopClientId: row.shopClientId,
      postingNumber: firstUsableOzonId(row.id, row.posting, row.raw?.posting_number, row.raw?.postingNumber),
      orderId: firstUsableOzonId(row.salesOrder, row.raw?.order_number, row.raw?.orderNumber, row.raw?.order_id),
    });
    const statusText = getProfitActualStatusText(row, []);
    return details.hasPendingPenaltyAmount || isProfitFinalZeroAllowedStatus(statusText);
  });
}

export function getProfitRowsNeedingRatingPenaltyPostingFallback(rows = [], ratingPenaltyIndex = new Map()) {
  return getProfitRowsNeedingRatingPenaltyLookup(rows, new Map()).filter((row) => {
    const statusText = getProfitActualStatusText(row, []);
    if (!isProfitFinalZeroAllowedStatus(statusText)) return false;
    return !getProfitOrderReadyRatingPenaltyDetails(row, ratingPenaltyIndex);
  });
}

export async function requestOzonRatingPenaltyOperationsSnapshot(shop, rows = [], options = {}) {
  const targetRows = options.includeAllRows
    ? rows
    : getProfitRowsNeedingRatingPenaltyLookup(rows, options.financeIndex ?? new Map());
  const allPostingRequests = getProfitFinancePostingRequests(targetRows, {
    dateRange: options.dateRange,
    timeScope: options.timeScope,
    startDate: options.startDate,
    endDate: options.endDate,
    maxLookupKeys: options.maxLookupKeys,
    preferBaseLookup: options.preferBaseLookup,
    stopAfterFirstMatchedLookup: options.stopAfterFirstMatchedLookup,
  });
  const maxPostingNumbers = Math.max(0, Number(options.maxPostingNumbers) || 0);
  const postingRequests = maxPostingNumbers ? allPostingRequests.slice(0, maxPostingNumbers) : allPostingRequests;
  const skippedPostingCount = Math.max(0, allPostingRequests.length - postingRequests.length);
  const postingConcurrency = Math.max(1, Number(options.postingConcurrency) || OZON_FINANCE_POSTING_CONCURRENCY);
  const operations = [];
  const seen = new Set();
  const errors = [];
  const addOperation = (operation) => {
    const key = getRatingPenaltyOperationDedupKey(operation);
    if (seen.has(key)) return;
    seen.add(key);
    operations.push(operation);
  };

  if (skippedPostingCount > 0) {
    errors.push({
      ok: false,
      label: '错误指数限流',
      error: new Error(`本轮跳过 ${skippedPostingCount} 个订单的罚款实际金额补充，稍后或手动刷新继续读取。`),
    });
  }

  try {
    const bulkDateRange = getExplicitOzonTimeRange(options) || getProfitRatingPenaltyBulkDateRange(rows);
    const bulkOperations = await requestOzonRatingPenaltyOperationsForDateRangeCached(shop, bulkDateRange, {
      forceRefresh: options.forceRefresh,
      pageLimit: options.pageLimit,
    });
    bulkOperations.forEach(addOperation);
  } catch (error) {
    errors.push({ ok: false, label: '错误指数批量读取', error });
  }

  for (const chunk of chunkValues(postingRequests, postingConcurrency)) {
    const chunkResults = await Promise.allSettled(
      chunk.map((request) =>
        requestOzonRatingPenaltyOperationsForPostingCached(shop, request.postingNumber, request.dateRange, {
          forceRefresh: options.forceRefresh,
          maxLookupKeys: options.maxLookupKeys,
          preferBaseLookup: options.preferBaseLookup,
          stopAfterFirstMatchedLookup: options.stopAfterFirstMatchedLookup,
        })
      )
    );
    chunkResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        errors.push({ postingNumber: chunk[index]?.postingNumber, error: result.reason });
      }
    });
    chunkResults
      .filter((result) => result.status === 'fulfilled')
      .flatMap((result) => result.value)
      .forEach(addOperation);
  }

  return { operations, errors };
}

export function addFinanceIndexKey(map, key, operation) {
  const [text] = getFinancePostingLookupGroups([key]).exactKeys;
  if (!text) return;
  const current = map.get(text) ?? [];
  current.push(operation);
  map.set(text, current);
}

export function buildFinanceOperationIndex(operations = []) {
  const map = new Map();
  operations.forEach((operation) => {
    addFinanceIndexKey(map, operation.posting?.posting_number, operation);
    addFinanceIndexKey(map, operation.posting?.postingNumber, operation);
    addFinanceIndexKey(map, operation.posting_number, operation);
    addFinanceIndexKey(map, operation.postingNumber, operation);
    addFinanceIndexKey(map, operation.order_id, operation);
    addFinanceIndexKey(map, operation.orderId, operation);
  });
  return map;
}

export function buildFinanceLookupCheckedIndex(postingNumbers = []) {
  const map = new Map();
  postingNumbers.forEach((postingNumber) => {
    getFinancePostingLookupGroups([postingNumber]).exactKeys.forEach((key) => {
      map.set(key, true);
    });
  });
  return map;
}

export function getProfitOrderFinanceOperations(order = {}, financeIndex = new Map(), options = {}) {
  const groups = getProfitOrderFinanceLookupGroups(order);
  return selectFinanceOperationsExactFirst(groups, financeIndex, {
    getDedupKey: getFinanceOperationDedupKey,
    allowParentFallbackForChild: canUseFinanceParentFallback(
      order,
      groups,
      financeIndex,
      options.financeParentFallbackIndex
    ),
  });
}

export function getProfitOrderPenaltyFinanceOperations(order = {}, financeIndex = new Map()) {
  const groups = getProfitOrderFinanceLookupGroups(order);
  const operations = [];
  const seen = new Set();
  [...groups.exactKeys, ...groups.fallbackKeys].forEach((key) => {
    const matched = financeIndex.get(key);
    if (!Array.isArray(matched)) return;
    matched.forEach((operation) => {
      const operationKey = getFinanceOperationDedupKey(operation);
      if (seen.has(operationKey)) return;
      seen.add(operationKey);
      operations.push(operation);
    });
  });
  return operations;
}

export function getRatingPenaltyOperationPrimaryPostingKey(operation = {}) {
  return normalizeOzonId(
    operation.posting?.posting_number ||
      operation.posting?.postingNumber ||
      operation.posting_number ||
      operation.postingNumber
  ).trim();
}

export function doesRatingPenaltyOperationMatchOrderScope(operation = {}, order = {}) {
  const operationShopClientId = normalizeOzonId(
    firstFilled(operation.shopClientId, operation.clientId, operation.shop_client_id, operation.__raw?.shopClientId)
  ).trim();
  const orderShopClientId = normalizeOzonId(firstFilled(order.shopClientId, order.clientId)).trim();
  if (operationShopClientId && orderShopClientId) return operationShopClientId === orderShopClientId;

  const operationShopId = normalizeOzonId(
    firstFilled(operation.shopId, operation.shop_id, operation.__raw?.shopId)
  ).trim();
  const orderShopId = normalizeOzonId(order.shopId).trim();
  if (operationShopId && orderShopId) return operationShopId === orderShopId;

  return true;
}

export function collectRatingPenaltyOperationsByKeys(ratingPenaltyIndex = new Map(), keys = [], options = {}) {
  const operations = [];
  const seen = options.seen ?? new Set();
  keys.forEach((key) => {
    const matched = ratingPenaltyIndex.get(key);
    if (!Array.isArray(matched)) return;
    matched.forEach((operation) => {
      if (typeof options.filter === 'function' && !options.filter(operation)) return;
      const operationKey = getRatingPenaltyOperationDedupKey(operation);
      if (seen.has(operationKey)) return;
      seen.add(operationKey);
      operations.push(operation);
    });
  });
  return operations;
}

export function getProfitOrderRatingPenaltyExactChildKeys(order = {}, groups = null) {
  const lookupGroups = groups ?? getProfitOrderFinanceLookupGroups(order);
  const explicitPostingValues = [
    ...(Array.isArray(order.postingNumbers) ? order.postingNumbers : []),
    order.posting,
    order.id,
    order.softwareOrderId,
    order.raw?.posting_number,
    order.raw?.postingNumber,
    order.raw?.analytics_data?.posting_number,
  ];
  const explicitChildKeys = new Set(
    getFinancePostingLookupGroups(explicitPostingValues).exactKeys.filter((key) =>
      Boolean(getProfitPostingBaseKey(key))
    )
  );
  return lookupGroups.exactKeys.filter((key) => explicitChildKeys.has(key));
}

export function getProfitOrderRatingPenaltyOperations(order = {}, ratingPenaltyIndex = new Map()) {
  const groups = getProfitOrderFinanceLookupGroups(order);
  const seen = new Set();
  const exactChildKeys = getProfitOrderRatingPenaltyExactChildKeys(order, groups);
  const exactLookupKeys = exactChildKeys.length ? exactChildKeys : groups.exactKeys;
  const exactOperations = collectRatingPenaltyOperationsByKeys(ratingPenaltyIndex, exactLookupKeys, {
    seen,
    filter: (operation) => doesRatingPenaltyOperationMatchOrderScope(operation, order),
  });
  if (exactOperations.length > 0) return exactOperations;

  const exactChildKeySet = new Set(
    exactChildKeys.length ? exactChildKeys : groups.exactKeys.filter((key) => Boolean(getProfitPostingBaseKey(key)))
  );
  const fallbackOperations = collectRatingPenaltyOperationsByKeys(ratingPenaltyIndex, groups.fallbackKeys, {
    seen,
    filter: (operation) => {
      if (!doesRatingPenaltyOperationMatchOrderScope(operation, order)) return false;
      if (!exactChildKeySet.size) return true;
      const operationPostingKey = getRatingPenaltyOperationPrimaryPostingKey(operation);
      const operationBaseKey = getProfitPostingBaseKey(operationPostingKey);
      if (!operationBaseKey) return true;
      return exactChildKeySet.has(operationPostingKey);
    },
  });
  return fallbackOperations;
}

export function getProfitOrderReadyRatingPenaltyDetails(order = {}, ratingPenaltyIndex = new Map()) {
  const ratingPenaltyOperations = getProfitOrderRatingPenaltyOperations(order, ratingPenaltyIndex);
  if (!ratingPenaltyOperations.length) return null;
  const details = getProfitPenaltyDetails(ratingPenaltyOperations, {
    rubToCnyRate: getProfitOrderRubToCnyRate(order),
    shopId: order.shopId,
    shopClientId: order.shopClientId,
    postingNumber: firstUsableOzonId(order.id, order.posting, order.raw?.posting_number, order.raw?.postingNumber),
    orderId: firstUsableOzonId(order.salesOrder, order.raw?.order_number, order.raw?.orderNumber, order.raw?.order_id),
  });
  return details.hasReadyPenaltyAmount ? details : null;
}

export function shouldRebuildProfitLedgerForRatingPenalty(order = {}, ledger = null, ratingPenaltyIndex = new Map()) {
  const details = getProfitOrderReadyRatingPenaltyDetails(order, ratingPenaltyIndex);
  if (!details) return false;
  const ledgerPenalty = getProfitLedgerEntryValue(ledger?.amounts?.actualPenaltyFeeCny);
  if (ledgerPenalty === null) return true;
  return Math.abs(ledgerPenalty - details.totalCny) > 0.005;
}

export function shouldRebuildProfitLedgerForFinalZeroActualSales(order = {}, ledger = null) {
  if (!ledger?.amounts) return false;
  if (isPartialCompensationSale({ ...ledger.orderSnapshot, ...order,
    partialCompensationOnly: ledger.orderSnapshot?.partialCompensationOnly,
    hasFinanceRefund: ledger.orderSnapshot?.hasFinanceRefund })) return false;
  const statusText = getProfitActualStatusText(order, []);
  if (!isProfitFinalZeroAllowedStatus(statusText)) return false;
  const penaltyDetails = getProfitLedgerPenaltyEvidenceRecords(ledger);
  const hasFinanceEvidence =
    ledger.financeLookupChecked === true ||
    Boolean(ledger.profitFinanceVersion) ||
    penaltyDetails.length > 0 ||
    hasProfitLedgerActualFinanceEvidence(ledger);
  if (!hasFinanceEvidence) return false;
  const actualSalesValue = getProfitLedgerEntryValue(ledger.amounts.actualSalesAmountCny);
  if (actualSalesValue !== null && Math.abs(actualSalesValue) > 0.005) return true;
  const actualProfitStatus = String(ledger.results?.actualProfitCny?.status || '').trim();
  const actualProfitValue = getProfitLedgerEntryValue(ledger.results?.actualProfitCny);
  const actualFinanceStatus = String(ledger.actualFinanceStatus || '').trim();
  if (
    actualProfitStatus !== 'ready' ||
    actualProfitValue === null ||
    actualFinanceStatus !== 'confirmed' ||
    ledger.hasActualFinance !== true ||
    ledger.financeLookupChecked !== true
  ) {
    return true;
  }
  return [
    ledger.amounts.actualOzonFeeCny,
    ledger.amounts.actualCommissionFeeCny,
    ledger.amounts.actualPenaltyFeeCny,
    ledger.amounts.actualAcquiringFeeCny,
    ledger.amounts.actualDeliveryServiceFeeCny,
    ledger.amounts.actualLogisticsFeeCny,
    ledger.amounts.platformNetCny,
  ].some((entry) => getProfitLedgerEntryValue(entry) === null);
}

export function getProfitLedgerPenaltyEvidenceRecords(ledger = null) {
  return [
    ...(Array.isArray(ledger?.penaltyDetails) ? ledger.penaltyDetails : []),
    ...(Array.isArray(ledger?.amounts?.actualPenaltyFeeCny?.evidence?.records)
      ? ledger.amounts.actualPenaltyFeeCny.evidence.records
      : []),
    ...(Array.isArray(ledger?.amounts?.actualPenaltyFeeCny?.evidence?.summary?.records)
      ? ledger.amounts.actualPenaltyFeeCny.evidence.summary.records
      : []),
  ];
}

export function rebuildProfitLedgerForFinalZeroActualSales(order = {}, ledger = null) {
  if (!shouldRebuildProfitLedgerForFinalZeroActualSales(order, ledger)) return ledger;
  const amountKeys = [
    'salesAmountCny',
    'actualSalesAmountCny',
    'sourcePurchaseCostCny',
    'estimatedCommissionFeeCny',
    'estimatedAcquiringFeeCny',
    'estimatedDeliveryServiceFeeCny',
    'estimatedOzonFeeCny',
    'actualOzonFeeCny',
    'actualCommissionFeeCny',
    'actualPenaltyFeeCny',
    'actualAcquiringFeeCny',
    'actualDeliveryServiceFeeCny',
    'actualLogisticsFeeCny',
    'platformNetCny',
    'estimatedCrossBorderBusFeeCny',
    'actualCrossBorderBusFeeCny',
    'crossBorderBusFeeCny',
    'logisticsFeeCny',
    'refundOrderDeductionFeeCny',
  ];
  const amounts = amountKeys.reduce((next, key) => {
    next[key] = key === 'actualCrossBorderBusFeeCny'
      ? ledger.amounts?.[key]
      : getProfitLedgerEntryValue(ledger.amounts?.[key]);
    return next;
  }, {});
  amounts.actualSalesAmountCny = 0;
  const penaltySummary = ledger.amounts?.actualPenaltyFeeCny?.evidence?.summary ?? null;
  const penaltyDetails = getProfitLedgerPenaltyEvidenceRecords(ledger);
  const actualPenaltyValue = getProfitLedgerEntryValue(ledger.amounts?.actualPenaltyFeeCny);
  const financeEvidenceChecked =
    ledger.financeLookupChecked === true ||
    Boolean(ledger.profitFinanceVersion) ||
    penaltyDetails.length > 0 ||
    hasProfitLedgerActualFinanceEvidence(ledger);
  [
    'actualOzonFeeCny',
    'actualCommissionFeeCny',
    'actualAcquiringFeeCny',
    'actualDeliveryServiceFeeCny',
    'actualLogisticsFeeCny',
    'platformNetCny',
  ].forEach((key) => {
    if (amounts[key] === null) amounts[key] = 0;
  });
  if (actualPenaltyValue === null && !penaltySummary?.hasPenaltyEvent && penaltyDetails.length === 0) {
    amounts.actualPenaltyFeeCny = 0;
  }
  return createProfitLedgerRow(
    {
      ...ledger.orderSnapshot,
      ...order,
      profitLedger: undefined,
    },
    {
      orderKey: getProfitOrderRecordKey(order) || getProfitLedgerRowKey(ledger) || getProfitOrderStableRecordKey(order),
      amounts,
      exchangeRate: ledger.exchangeRate,
      estimatedExchangeRate: ledger.exchangeRates?.estimated ?? ledger.estimatedExchangeRate ?? ledger.exchangeRate,
      actualExchangeRate: ledger.exchangeRates?.actual ?? ledger.actualExchangeRate,
      exchangeRates: ledger.exchangeRates,
      rubToCnyRate: ledger.exchangeRates?.estimated?.rubToCnyRate ?? ledger.exchangeRate?.rubToCnyRate,
      hasActualFinance: true,
      actualFinanceStatus: 'confirmed',
      financeLookupChecked: financeEvidenceChecked,
      financeOperationCount: ledger.financeOperationCount,
      afterSalesCount: ledger.afterSalesCount,
      profitFinanceVersion: ledger.profitFinanceVersion,
      actualCrossBorderBusFeeSource: ledger.amounts?.actualCrossBorderBusFeeCny?.source || '',
      crossBorderChargeEvidence: ledger.amounts?.actualCrossBorderBusFeeCny?.evidence ?? null,
      crossBorderChargeUpdatedAt: ledger.amounts?.actualCrossBorderBusFeeCny?.updatedAt || '',
      actualPenaltyFeeRequiresDirectAmount: actualPenaltyValue === null && penaltySummary?.hasPenaltyEvent,
      penaltyDetails,
      penaltySummary,
      allowZeroPurchaseCost: amounts.sourcePurchaseCostCny === 0,
      hasRefundLoss: ledger.results?.refundLossCny?.status === 'ready' || Boolean(order.signedRefundLoss),
      updatedAt: ledger.updatedAt || ledger.results?.actualProfitCny?.updatedAt || new Date().toISOString(),
    }
  );
}

export function getPenaltyOperationPostingLookupKeys(operation = {}) {
  return getProfitPostingLookupKeys([
    operation.posting?.posting_number,
    operation.posting?.postingNumber,
    operation.posting_number,
    operation.postingNumber,
    operation.order_id,
    operation.orderId,
  ]);
}

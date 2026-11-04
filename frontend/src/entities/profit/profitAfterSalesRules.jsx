import { normalizeSalesOrderDateFilter } from '../order/orderDateRules.jsx';
import { getProfitOrderRecordKey } from './profitOrderRecordRules.jsx';
import { getDomainCache, startDomainSync, readLiveProfitFinancePosting, readLiveProfitFinancePostings } from '../../api/localApiClient';
import { createProfitFinanceBatchReader } from '../../services/profitFinanceBatchReader.js';
import { splitProfitFinanceReadBatches } from '../../services/profitFinanceReadBatches.js';
import { getEmptyFinancePostingKeys, isVerifiedEmptyFinanceReceipt, verifyEmptyFinanceAtOzon } from '../../services/profitEmptyFinanceEvidence.js';
import { readRubCnyExchangeRateContext } from '../../services/exchangeRateClient';
import { buildOrderExchangeRateBundle, getOrderExchangeRateDateKeys } from '../../services/orderExchangeRateRules';
import { getOzonAfterSalesReasonRawText } from '../../services/ozonOrderExperience';
import { getFinanceOperationAmount } from '../../services/profitFinanceBreakdown';
import { buildFinanceParentFallbackIndex } from '../../services/profitFinanceMatching';
import { buildProfitPenaltyAttributionIndex } from '../../services/profitPenaltyAttribution';
import { readProfitProductSummarySupport } from '../../services/profitProductSummarySupportService';
import {
  OZON_AFTER_SALES_DETAIL_CONCURRENCY,
  OZON_INITIAL_ORDER_QUICK_RANGE_DAYS,
  PROFIT_FINANCE_CACHE_VERSION,
} from '../../shared/config/appConfigCore.jsx';
import { requestOzonReadOnly } from '../../shared/ozon/ozonRuntime.jsx';
import {
  shouldReadAfterSalesOriginalOrderDetail,
  shouldRequestAfterSalesRefundFinanceEvidence,
} from '../marketing/marketingOrderFields.jsx';
import { isLowPriorityAfterSalesReason } from '../order/afterSalesReasonRules.jsx';
import {
  getOzonAfterSalesBackgroundSnapshotCacheKey,
  getOzonAfterSalesBackgroundSnapshotReadKeys,
  getOzonAfterSalesSnapshotCacheKey,
  getOzonAfterSalesSnapshotCacheKeys,
  getOzonAfterSalesSnapshotReadKeys,
} from '../order/afterSalesSnapshotKeys.jsx';
import {
  enrichOzonRfbsReturnItemsWithDetails,
  getOzonRfbsReturnId,
  getOzonRfbsReturnPayload,
  requestOzonRfbsReturnDetail,
} from '../order/afterSalesRfbsRead.jsx';
import {
  appendOzonSnapshotScopeKey,
  canUseOzonShop,
  firstFilled,
  firstUsableOzonId,
  formatLocalDateKey,
  getOzonReadableShops,
  getOzonShopClientId,
  getOzonShopForOrder,
  getOzonShopLabel,
  getOzonSnapshotSourceKey,
  getOzonSnapshotSourceKeyCandidates,
  normalizeOzonId,
  resolveOzonTimeRange,
} from '../order/orderShopScope.jsx';
import {
  AFTER_SALES_CLASSIFICATION_VERSION,
  getAfterSalesPostingLookupKeys,
  getAfterSalesTone,
  mergeAfterSalesRowsByBusinessKey,
  runIsolatedShopAsync,
  runLimitedAsync,
} from '../order/orderAsyncRules.jsx';
import { getAfterSalesStatusByRules } from '../order/orderDisplayFormat.jsx';
import { buildProfitSourceRecordsForOrder, hydrateProfitLocalInputs } from '../order/orderSourceLinks.jsx';
import { getOzonLocalUniqueValues } from '../product/productLocalData.jsx';
import { applyOzonLocalProductEntitiesToRows } from '../product/productLocalMirror.jsx';
import {
  buildProfitPriceInfoMap,
  chunkValues,
  getOzonAfterSalesDisplayReason,
  normalizeOzonAfterSalesRow,
  readOzonOrderEndpoint,
  requestOzonOrderPriceInfos,
  requestOzonSalesOrdersSnapshotForShops,
} from './profitOrderSnapshot.jsx';
import { applyProfitProductSummaryMaterialToRows } from './profitProductMaterialFallbackRules';
import {
  buildAfterSalesRowIndex,
  getFinanceOperationDedupKey,
  getProfitFinancePostingLookupKeys,
  getProfitPostingBaseKey,
  getProfitRowPrimaryPostingNumbers,
  getProfitRowsLookupKeys,
  requestOzonFinanceOperationsForPostingCached,
  requestOzonProfitAfterSalesSnapshotForShop,
} from './profitFinanceEvidence.jsx';
import {
  buildFinanceLookupCheckedIndex,
  buildFinanceOperationIndex,
  getProfitOrderFinanceOperations,
  requestOzonFinanceOperationsSnapshot,
  requestOzonRatingPenaltyOperationsSnapshot,
} from './profitLedgerMapping.jsx';
import { getProfitActualStatusText, isProfitFinalZeroAllowedStatus } from './profitDisplayRules.jsx';
import { normalizeProfitOrdersForExecution } from '../../services/profitCalculationExecution.js';
import { mergeAfterSalesOriginalOrderEvidence } from '../order/afterSalesOriginalOrderEvidence.jsx';
import { requestOzonAfterSalesOriginalOrderDetail } from '../order/afterSalesOriginalOrderRead.jsx';
import { readProfitMissingOnlyExchangeRateContext } from './profitExchangeRateCache.js';

async function readProfitRubCnyExchangeRateContext(rows = [], options = {}, financeOperations = []) {
  const dateKeys = getOrderExchangeRateDateKeys(rows, { financeOperations });
  if (options.profitExchangeRateReadMissingOnly === true) {
    return readProfitMissingOnlyExchangeRateContext(rows, { ...options, dateKeys }, financeOperations);
  }
  const shouldReadDailyRates = options.realtimeOnlyExchangeRate !== true;
  return readRubCnyExchangeRateContext(dateKeys, {
    timeoutMs: options.exchangeRateTimeoutMs,
    signal: options.signal,
    todayKey: options.exchangeRateTodayKey,
    now: options.exchangeRateNow,
    maxLookbackDays: options.exchangeRateMaxLookbackDays,
    dailyConcurrency: options.exchangeRateDailyConcurrency,
    includeRealtime: true,
    skipDailyRates: !shouldReadDailyRates,
  });
}

function getProfitRowExchangeRates(row = {}, exchangeRateContext = {}, financeOperations = []) {
  return buildOrderExchangeRateBundle(row, exchangeRateContext, { financeOperations });
}

function getProfitLocalFinanceDateRange(options = {}) {
  return resolveOzonTimeRange(
    options.dateRange || options.apiRange || options.timeScope || options,
    options.defaultDays ?? OZON_INITIAL_ORDER_QUICK_RANGE_DAYS
  );
}

function getProfitLocalFinancePostingNumbers(rows = [], options = {}) {
  const postingNumbers = new Set();
  rows.forEach((row) => {
    getProfitRowPrimaryPostingNumbers(row).forEach((postingNumber) => {
      const lookupKeys = getProfitFinancePostingLookupKeys(postingNumber, {
        maxLookupKeys: options.maxFinanceLookupKeys ?? options.maxLookupKeys ?? 2,
        preferBaseLookup: options.preferBaseFinanceLookup ?? options.preferBaseLookup ?? false,
      });
      (lookupKeys.length ? lookupKeys : [postingNumber]).forEach((key) => {
        const text = normalizeOzonId(key).trim();
        if (text && text !== '未返回') postingNumbers.add(text);
      });
    });
  });
  return [...postingNumbers];
}

function normalizeLocalFinanceOperation(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const postingNumber = firstUsableOzonId(
    row.posting_number,
    row.postingNumber,
    raw.posting_number,
    raw.posting?.posting_number
  );
  return {
    ...raw,
    ...row,
    operation_id: firstFilled(row.operation_id, row.operationId, raw.operation_id),
    posting_number: postingNumber,
    postingNumber,
    posting: {
      ...(raw.posting && typeof raw.posting === 'object' ? raw.posting : {}),
      ...(row.posting && typeof row.posting === 'object' ? row.posting : {}),
      posting_number: postingNumber,
    },
    order_id: firstFilled(row.order_id, row.orderId, raw.order_id, raw.posting?.order_id),
    operation_type: firstFilled(row.operation_type, row.operationType, raw.operation_type),
    operation_type_name: firstFilled(row.operation_type_name, row.operationTypeName, raw.operation_type_name),
    transaction_type: firstFilled(row.transaction_type, row.transactionType, raw.transaction_type),
    operation_date: firstFilled(row.operation_date, row.operationDate, raw.operation_date),
    amount: firstFilled(row.amount, row.amount_total, row.amountTotal, raw.amount),
    currency_code: firstFilled(row.currency_code, row.currencyCode, raw.currency_code),
    sale_commission: firstFilled(
      row.sale_commission,
      row.saleCommission,
      row.sale_commission_cny,
      row.saleCommissionCny,
      raw.sale_commission,
      raw.saleCommission,
      raw.sale_commission_cny,
      raw.saleCommissionCny
    ),
    services: Array.isArray(row.services) ? row.services : Array.isArray(raw.services) ? raw.services : [],
  };
}

function mergeProfitFinanceOperations(...operationLists) {
  const operations = [];
  const seen = new Set();
  operationLists.flat().forEach((operation) => {
    if (!operation) return;
    const key = getFinanceOperationDedupKey(operation);
    if (seen.has(key)) return;
    seen.add(key);
    operations.push(operation);
  });
  return operations;
}

function startProfitFinanceBackgroundSync(shop, rows = [], options = {}) {
  if (!shop?.id || !rows.length) return;
  if (!options.startBackgroundSync && !options.forceRefresh) return;
  const range = getProfitLocalFinanceDateRange(options);
  startDomainSync(
    'finance',
    {
      shopId: shop.id,
      from: range.since,
      to: range.to,
      pageSize: 1000,
      maxPages: options.financeBackgroundMaxPages ?? options.maxFinancePages ?? 5,
      windowDays: options.financeWindowDays ?? 7,
      forceRefresh: options.forceRefresh === true,
      requestedBy: options.requestedBy || 'frontend-profit-finance-background',
    },
    { timeoutMs: options.backgroundSyncTimeoutMs ?? 3000 }
  ).catch(() => undefined);
}

export async function readLocalProfitFinanceCacheForShop(shop, rows = [], options = {}) {
  const readStartedAt = Date.now();
  const assertActive = () => { if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError'); };
  assertActive();
  const postingNumbers = getProfitLocalFinancePostingNumbers(rows, options);
  startProfitFinanceBackgroundSync(shop, rows, options);
  if (!shop?.id || !postingNumbers.length) {
    return { shopId: shop?.id, operations: [], checkedPostingNumbers: [], failedPostingNumbers: [], errors: [], complete: true };
  }

  const previous = options.forceRefresh !== true && options.previousReadback?.shopId === shop.id ? options.previousReadback : null;
  const requestedPostings = new Set(postingNumbers);
  const checked = new Set((previous?.checkedPostingNumbers ?? []).filter((posting) => requestedPostings.has(posting)));
  const operations = (previous?.operations ?? []).filter((operation) => checked.has(operation.posting_number || operation.postingNumber));
  const errors = [];
  const failedPostingNumbers = [];
  const seen = new Set(operations.map(getFinanceOperationDedupKey));
  const batches = splitProfitFinanceReadBatches(postingNumbers.filter(posting => !checked.has(posting)), {
    maxCount: options.localFinancePostingChunkSize,
  });
  let requestCount = 0;
  for (const chunk of batches) {
    const chunkPostings = new Set(chunk);
    let page = 1;
    let expectedTotal = null;
    const batch = [];
    const batchKeys = new Set();
    const pageSize = Math.min(Math.max(Number(options.localFinancePageSize) || 1000, 1), 1000);
    while (true) {
      try {
        assertActive();
        requestCount++;
        const cache = await getDomainCache(
          'finance',
          {
            shopId: shop.id,
            postingNumbers: chunk.join(','),
            page,
            pageSize,
          },
          {
            timeoutMs: options.localFinanceTimeoutMs ?? 10000,
            signal: options.signal,
            observe: false,
          }
        );
        assertActive();
        const rowsInPage = Array.isArray(cache?.rows) ? cache.rows : null;
        const total = cache?.total == null || cache?.total === '' ? NaN : Number(cache.total);
        const failIncomplete = () => { const error = new Error('本地财务分页未读齐，等待补读'); error.code = 'PROFIT_FINANCE_READ_INCOMPLETE'; throw error; };
        if (cache?.ok === false || !rowsInPage || !Number.isSafeInteger(total) || total < 0 || (expectedTotal !== null && expectedTotal !== total)) failIncomplete();
        expectedTotal = total;
        const normalizedPage = rowsInPage.map(normalizeLocalFinanceOperation);
        for (const operation of normalizedPage) {
          const key = getFinanceOperationDedupKey(operation);
          if (!key || batchKeys.has(key) || !chunkPostings.has(operation.posting_number)
            || (operation.shopId && operation.shopId !== shop.id)) failIncomplete();
          batchKeys.add(key);
          batch.push(operation);
        }
        if (batch.length > total || (batch.length < total && rowsInPage.length < pageSize)) failIncomplete();
        if (batch.length === total) {
          for (const operation of batch) {
            const key = getFinanceOperationDedupKey(operation);
            if (!seen.has(key)) { seen.add(key); operations.push(operation); }
          }
          chunk.forEach((posting) => checked.add(posting));
          break;
        }
        page += 1;
      } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError') throw error;
        errors.push({ ok: false, label: `${getOzonShopLabel(shop)} 本地财务缓存`, error });
        failedPostingNumbers.push(...chunk);
        break;
      }
    }
  }

  return { shopId: shop.id, operations, checkedPostingNumbers: [...checked], failedPostingNumbers, errors, complete: errors.length === 0,
    stats: { postingCount: postingNumbers.length, batchCount: batches.length, requestCount, durationMs: Date.now() - readStartedAt } };
}

export function buildLocalProfitFinanceHydrationContext(rows = [], operations = [], options = {}) {
  const financeOperations = mergeProfitFinanceOperations(operations);
  const financeIndex = buildFinanceOperationIndex(financeOperations);
  const financeParentFallbackIndex = buildFinanceParentFallbackIndex(
    Array.isArray(options.allRowsForParentFallback) && options.allRowsForParentFallback.length
      ? options.allRowsForParentFallback
      : rows
  );
  const matchedPostingNumbers = [];
  const matchedOrderKeys = new Set();
  const emptyFinanceReceipts = new Map();
  const failedPostings = new Set(options.failedPostingNumbers ?? []);

  rows.forEach((row) => {
    if (getProfitLocalFinancePostingNumbers([row]).some((posting) => failedPostings.has(posting))) return;
    const matched = getProfitOrderFinanceOperations(row, financeIndex, {
      financeParentFallbackIndex,
    });
    if (!matched.length) {
      const receipt = options.emptyFinanceReceipts?.get(getProfitOrderRecordKey(row));
      if (!isProfitFinalZeroAllowedStatus(getProfitActualStatusText(row, []))
        || !isVerifiedEmptyFinanceReceipt(receipt, row, { shop: options.shop })) return;
      emptyFinanceReceipts.set(getProfitOrderRecordKey(row), receipt);
    }
    matchedPostingNumbers.push(...getProfitRowPrimaryPostingNumbers(row));
    const orderKey = getProfitOrderRecordKey(row);
    if (orderKey) matchedOrderKeys.add(orderKey);
  });

  return {
    financeOperations,
    financeIndex,
    financeLookupCheckedIndex: buildFinanceLookupCheckedIndex(matchedPostingNumbers),
    financeParentFallbackIndex,
    matchedOrderKeys,
    emptyFinanceReceipts,
    matchedRowCount: matchedOrderKeys.size,
  };
}

export function buildLocalProfitFinanceExchangeRateIndex(rows = [], hydrationContext = {}, exchangeRateContext = {}) {
  const exchangeRatesByOrderKey = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const orderKey = getProfitOrderRecordKey(row);
    if (!orderKey) return;
    const financeOperations = getProfitOrderFinanceOperations(row, hydrationContext.financeIndex ?? new Map(), {
      financeParentFallbackIndex: hydrationContext.financeParentFallbackIndex,
    });
    if (!financeOperations.length) return;
    const exchangeRates = getProfitRowExchangeRates(row, exchangeRateContext, financeOperations);
    if (exchangeRates.estimated || exchangeRates.actual) exchangeRatesByOrderKey.set(orderKey, exchangeRates);
  });
  return exchangeRatesByOrderKey;
}

export async function readLocalProfitFinanceContextsForShops(shops = [], rows = [], options = {}) {
  const readableShops = getOzonReadableShops(shops);
  const lookupRows = Array.isArray(options.lookupRows) ? options.lookupRows : rows;
  const emptyResult = {
    byShopId: new Map(),
    byClientId: new Map(),
    errors: [],
    matchedRowCount: 0,
  };
  if (!readableShops.length || !lookupRows.length) return emptyResult;

  const results = await runIsolatedShopAsync(readableShops, async (shop) => {
    const shopStartedAt = Date.now();
    const previousContext = options.previousContexts?.byShopId?.get(shop.id);
    const shopClientId = getOzonShopClientId(shop);
    const shopLookupRows = lookupRows.filter(
      (row) => row.shopId === shop.id || row.shopClientId === shopClientId
    );
    const shopScopeRows = rows.filter(
      (row) => row.shopId === shop.id || row.shopClientId === shopClientId
    );
    const priorEmptyReceiptsCurrent = [...(previousContext?.emptyFinanceReceipts?.entries() ?? [])].every(([key, receipt]) => {
      const row = shopLookupRows.find(candidate => getProfitOrderRecordKey(candidate) === key);
      return row && isVerifiedEmptyFinanceReceipt(receipt, row, { shop });
    });
    if (previousContext?.localFinanceReadback?.complete && !previousContext.errors?.length && priorEmptyReceiptsCurrent) return previousContext;
    if (!shopLookupRows.length) {
      return {
        shop,
        errors: [],
        ...buildLocalProfitFinanceHydrationContext([], [], {
          allRowsForParentFallback: shopScopeRows,
        }),
      };
    }
    const local = await readLocalProfitFinanceCacheForShop(shop, shopLookupRows, {
      ...options,
      previousReadback: previousContext?.localFinanceReadback,
      forceRefresh: false,
      startBackgroundSync: false,
    });
    const localReadMs = Date.now() - shopStartedAt;
    const initialRateDates = new Set(getOrderExchangeRateDateKeys(shopLookupRows, { financeOperations: local.operations }));
    const readRates = operations => readProfitRubCnyExchangeRateContext(
      shopLookupRows, { ...options, profitExchangeRateReadMissingOnly: true }, operations
    ).catch(error => ({ todayKey: '', realtime: null, dailyRates: new Map(), errors: [{ ok: false, label: `${getOzonShopLabel(shop)} 财务汇率`, error }] }));
    // This read has no dependency on the empty-posting checks. If new finance
    // dates appear below, perform the required additional rate read before use.
    const ratesPromise = readRates(local.operations);
    const emptyFinanceReceipts = new Map();
    if (options.verifyEmptyFinance === true) {
      const checked = new Set(local.checkedPostingNumbers);
      const availablePostings = new Set(local.operations.map(operation => operation.posting_number || operation.postingNumber));
      const eligible = shopLookupRows.filter(row => {
        const keys = getEmptyFinancePostingKeys(row);
        return isProfitFinalZeroAllowedStatus(getProfitActualStatusText(row, []))
          && keys.length && keys.every(key => checked.has(key) && !availablePostings.has(key));
      });
      const priorReceipt = row => previousContext?.emptyFinanceReceipts?.get(getProfitOrderRecordKey(row))
        ?? options.getCachedLedgerRows?.()?.[getProfitOrderRecordKey(row)]?.financeEmptyReceipt
        ?? row.profitLedger?.financeEmptyReceipt;
      const pendingKeys = eligible.filter(row => !isVerifiedEmptyFinanceReceipt(priorReceipt(row), row, { shop }))
        .flatMap(getEmptyFinancePostingKeys);
      const fetchPage = createProfitFinanceBatchReader(shop.id, pendingKeys, {
        readBatch: readLiveProfitFinancePostings, readPage: readLiveProfitFinancePosting, signal: options.signal,
      });
      await runIsolatedShopAsync(eligible, async row => {
        const key = getProfitOrderRecordKey(row);
        const receipt = priorReceipt(row);
        if (isVerifiedEmptyFinanceReceipt(receipt, row, { shop })) { emptyFinanceReceipts.set(key, receipt); return; }
        try {
          const verified = await verifyEmptyFinanceAtOzon({ ...shop, clientId: shopClientId }, row, {
            signal: options.signal, fetchPage,
          });
          if (verified.receipt) emptyFinanceReceipts.set(key, verified.receipt);
          else local.operations.push(...verified.operations);
        } catch (error) {
          if (options.signal?.aborted || error?.name === 'AbortError') throw error;
          local.errors.push({ ok: false, label: `${getOzonShopLabel(shop)} 无流水订单官方核验`, error });
        }
      }, { concurrency: 2 });
      if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    }
    const hydrationContext = buildLocalProfitFinanceHydrationContext(shopLookupRows, local.operations ?? [], {
      allRowsForParentFallback: shopScopeRows,
      failedPostingNumbers: local.failedPostingNumbers,
      emptyFinanceReceipts,
      shop,
    });
    let exchangeRateContext = await ratesPromise;
    if (getOrderExchangeRateDateKeys(shopLookupRows, { financeOperations: hydrationContext.financeOperations })
      .some(date => !initialRateDates.has(date))) exchangeRateContext = await readRates(hydrationContext.financeOperations);
    const context = {
      shop,
      clientId: shopClientId,
      localFinanceReadback: local,
      errors: [...(local.errors ?? []), ...(exchangeRateContext.errors ?? [])],
      ...hydrationContext,
      exchangeRatesByOrderKey: buildLocalProfitFinanceExchangeRateIndex(
        shopLookupRows,
        hydrationContext,
        exchangeRateContext
      ),
      timings: { localReadMs, localRequests: local.stats?.requestCount || 0,
        localBatches: local.stats?.batchCount || 0, totalMs: Date.now() - shopStartedAt },
    };
    if (!options.signal?.aborted) {
      if (options.onShopContext) console.info('[profit-hydration-ready] ' + JSON.stringify({ shopId: shop.id,
        ...context.timings, matchedRows: context.matchedRowCount, emptyReceipts: context.emptyFinanceReceipts.size,
        readyAt: new Date().toISOString() }));
      options.onShopContext?.(context);
    }
    return context;
  });

  const byShopId = new Map();
  const byClientId = new Map();
  const errors = [];
  let matchedRowCount = 0;
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') {
      errors.push({
        ok: false,
        label: `${getOzonShopLabel(readableShops[index])} 本地财务补齐`,
        error: result.reason,
      });
      return;
    }
    const context = result.value;
    const shopId = String(context.shop?.id || '').trim();
    const shopClientId = getOzonShopClientId(context.shop);
    if (shopId) byShopId.set(shopId, context);
    if (shopClientId) byClientId.set(shopClientId, context);
    errors.push(...(context.errors ?? []));
    matchedRowCount += Number(context.matchedRowCount) || 0;
  });

  return { byShopId, byClientId, errors, matchedRowCount };
}

export async function requestOzonProfitFinanceSupplementForShop(shop, rows = [], options = {}) {
  if (!rows.length) {
    return {
      shop,
      priceInfoMap: new Map(),
      financeOperations: [],
      financeIndex: new Map(),
      ratingPenaltyIndex: new Map(),
      financeLookupCheckedIndex: new Map(),
      afterSalesIndex: new Map(),
      errors: [],
    };
  }

  const [priceResult, localFinanceResult, financeResult, afterSalesResult] = await Promise.all([
    readOzonOrderEndpoint(`${getOzonShopLabel(shop)} 利润预估扣费`, () => requestOzonOrderPriceInfos(shop, rows)),
    readOzonOrderEndpoint(`${getOzonShopLabel(shop)} 本地财务缓存`, () =>
      readLocalProfitFinanceCacheForShop(shop, rows, {
        ...options,
        forceRefresh: options.forceFinanceRefresh,
        startBackgroundSync: options.startBackgroundFinanceSync ?? options.forceFinanceRefresh,
      })
    ),
    readOzonOrderEndpoint(`${getOzonShopLabel(shop)} 财务扣费`, () =>
      requestOzonFinanceOperationsSnapshot(shop, rows, {
        dateRange: options.dateRange || options.apiRange,
        timeScope: options.timeScope,
        startDate: options.startDate,
        endDate: options.endDate,
        forceRefresh: options.forceFinanceRefresh,
        maxPostingNumbers: options.maxFinancePostingNumbers,
        postingConcurrency: options.financePostingConcurrency,
        maxLookupKeys: options.maxFinanceLookupKeys ?? 2,
        preferBaseLookup: options.preferBaseFinanceLookup ?? false,
        stopAfterFirstMatchedLookup: options.stopAfterFirstMatchedFinanceLookup ?? false,
      })
    ),
    readOzonOrderEndpoint(`${getOzonShopLabel(shop)} 售后核验`, () =>
      requestOzonProfitAfterSalesSnapshotForShop(shop, {
        dateRange: options.dateRange || options.apiRange,
        timeScope: options.timeScope,
        startDate: options.startDate,
        endDate: options.endDate,
        forceRefresh: options.forceAfterSalesRefresh,
        lookupKeys: getProfitRowsLookupKeys(rows),
      })
    ),
  ]);

  const localFinanceOperations = localFinanceResult.ok ? (localFinanceResult.value.operations ?? []) : [];
  const remoteFinanceOperations = financeResult.ok ? (financeResult.value.operations ?? []) : [];
  const financeOperations = mergeProfitFinanceOperations(localFinanceOperations, remoteFinanceOperations);
  const financeIndex = buildFinanceOperationIndex(financeOperations);
  const ratingPenaltyResult = await readOzonOrderEndpoint(`${getOzonShopLabel(shop)} 错误指数罚款`, () =>
    requestOzonRatingPenaltyOperationsSnapshot(shop, rows, {
      financeIndex,
      dateRange: options.dateRange || options.apiRange,
      timeScope: options.timeScope,
      startDate: options.startDate,
      endDate: options.endDate,
      forceRefresh: options.forceFinanceRefresh,
      maxPostingNumbers: options.maxFinancePostingNumbers,
      postingConcurrency: options.financePostingConcurrency,
      maxLookupKeys: options.maxFinanceLookupKeys ?? 2,
      preferBaseLookup: options.preferBaseFinanceLookup ?? false,
      stopAfterFirstMatchedLookup: options.stopAfterFirstMatchedFinanceLookup ?? false,
      includeAllRows: options.includeAllRatingPenaltyRows,
    })
  );

  return {
    shop,
    priceInfoMap: buildProfitPriceInfoMap(priceResult.ok ? priceResult.value : []),
    financeOperations,
    financeIndex,
    ratingPenaltyIndex: buildProfitPenaltyAttributionIndex(
      options.allRowsForParentFallback || rows,
      ratingPenaltyResult.ok ? (ratingPenaltyResult.value.operations ?? []) : []
    ),
    financeLookupCheckedIndex: buildFinanceLookupCheckedIndex([
      ...(localFinanceResult.ok ? (localFinanceResult.value.checkedPostingNumbers ?? []) : []),
      ...(financeResult.ok ? (financeResult.value.checkedPostingNumbers ?? []) : []),
    ]),
    afterSalesIndex: buildAfterSalesRowIndex(afterSalesResult.ok ? afterSalesResult.value.rows : []),
    errors: [
      ...[priceResult, localFinanceResult, financeResult, afterSalesResult, ratingPenaltyResult].filter(
        (result) => !result.ok
      ),
      ...(localFinanceResult.ok ? (localFinanceResult.value.errors ?? []) : []),
      ...(financeResult.ok ? (financeResult.value.errors ?? []) : []),
      ...(ratingPenaltyResult.ok ? (ratingPenaltyResult.value.errors ?? []) : []),
    ],
  };
}

export async function requestOzonProfitFinanceRowsForShops(shops = [], rows = [], options = {}) {
  const readableShops = getOzonReadableShops(shops);
  const snapshotFetchedAt = options.fetchedAt || new Date().toISOString();
  if (!readableShops.length || !rows.length) {
    return { rows: [], errors: [], fetchedAt: snapshotFetchedAt };
  }

  const supplementResults = await runIsolatedShopAsync(readableShops, (shop) => {
    const shopRows = rows.filter((row) => row.shopId === shop.id || row.shopClientId === getOzonShopClientId(shop));
    return requestOzonProfitFinanceSupplementForShop(shop, shopRows, options);
  });
  const supplements = supplementResults.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          shop: readableShops[index],
          priceInfoMap: new Map(),
          financeOperations: [],
          financeIndex: new Map(),
          ratingPenaltyIndex: new Map(),
          financeLookupCheckedIndex: new Map(),
          afterSalesIndex: new Map(),
          errors: [{ ok: false, label: getOzonShopLabel(readableShops[index]), error: result.reason }],
        }
  );
  const supplementFinanceOperations = supplements.flatMap((item) =>
    Array.isArray(item.financeOperations) ? item.financeOperations : []
  );
  const supplementByShopId = new Map(supplements.map((item) => [item.shop.id, item]));
  const supplementByClientId = new Map(supplements.map((item) => [getOzonShopClientId(item.shop), item]));
  const [{ purchaseLocalOverrides, productSourceLinks }, productSummarySupport, exchangeRateContext] =
    await Promise.all([
      hydrateProfitLocalInputs(readableShops),
      readProfitProductSummarySupport(rows, readableShops, { getRecordKey: getProfitOrderRecordKey }).catch(() => ({
        entityMap: new Map(),
        productSourceLinks: {},
      })),
      readProfitRubCnyExchangeRateContext(rows, options, supplementFinanceOperations),
    ]);
  const rowsWithProductSummary = productSummarySupport?.entityMap?.size
    ? applyProfitProductSummaryMaterialToRows(
        applyOzonLocalProductEntitiesToRows(rows, productSummarySupport.entityMap, getProfitOrderRecordKey, {
          commissionRateMode: 'rFBS',
        }),
        productSummarySupport.entityMap,
        getProfitOrderRecordKey
      )
    : rows;
  const mergedProductSourceLinks = {
    ...(productSourceLinks && typeof productSourceLinks === 'object' ? productSourceLinks : {}),
    ...(productSummarySupport?.productSourceLinks && typeof productSummarySupport.productSourceLinks === 'object'
      ? productSummarySupport.productSourceLinks
      : {}),
  };
  const financeParentFallbackRows =
    Array.isArray(options.allRowsForParentFallback) && options.allRowsForParentFallback.length
      ? options.allRowsForParentFallback
      : rowsWithProductSummary;
  const financeParentFallbackIndex = buildFinanceParentFallbackIndex(financeParentFallbackRows);

  return {
    rows: await normalizeProfitOrdersForExecution(rowsWithProductSummary.map((row) => {
      const supplement = supplementByShopId.get(row.shopId) ?? supplementByClientId.get(row.shopClientId) ?? {};
      const rowShop = supplement.shop ?? getOzonShopForOrder(row, readableShops);
      const financeOperations = getProfitOrderFinanceOperations(row, supplement.financeIndex ?? new Map(), {
        financeParentFallbackIndex,
      });
      const exchangeRates = getProfitRowExchangeRates(row, exchangeRateContext, financeOperations);
      const exchangeRate = exchangeRates.estimated;
      return { order: row, context: {
        ...supplement,
        purchaseLocalOverrides,
        financeParentFallbackIndex,
        rubToCnyRate: exchangeRate?.rubToCnyRate,
        exchangeRate,
        estimatedExchangeRate: exchangeRates.estimated,
        actualExchangeRate: exchangeRates.actual,
        exchangeRates,
        sourceRecords: buildProfitSourceRecordsForOrder(row, {
          purchaseLocalOverrides,
          productSourceLinks: mergedProductSourceLinks,
          shop: rowShop,
        }),
        profitFinanceVersion: PROFIT_FINANCE_CACHE_VERSION,
        fetchedAt: snapshotFetchedAt,
      } };
    }), options),
    errors: [...supplements.flatMap((item) => item.errors ?? []), ...(exchangeRateContext.errors ?? [])],
    fetchedAt: snapshotFetchedAt,
  };
}

export async function requestOzonProfitSnapshotForShops(shops = [], options = {}) {
  const readableShops = getOzonReadableShops(shops);
  const salesSnapshot = await requestOzonSalesOrdersSnapshotForShops(readableShops, options);
  const snapshotFetchedAt = salesSnapshot.fetchedAt || options.fetchedAt || new Date().toISOString();
  const unifiedSnapshot = await requestOzonProfitFinanceRowsForShops(readableShops, salesSnapshot.rows, {
    ...options,
    fetchedAt: snapshotFetchedAt,
    forceFinanceRefresh: options.forceFinanceRefresh ?? options.forceRefresh,
    forceAfterSalesRefresh: options.forceAfterSalesRefresh ?? options.forceRefresh,
    startBackgroundFinanceSync: options.startBackgroundFinanceSync ?? options.forceRefresh,
    allRowsForParentFallback: salesSnapshot.rows,
  });

  return {
    ...salesSnapshot,
    rows: unifiedSnapshot.rows,
    errors: [...(salesSnapshot.errors ?? []), ...(unifiedSnapshot.errors ?? [])],
    fetchedAt: snapshotFetchedAt,
    profitPipeline: {
      mode: 'unified-order-after-sales-finance',
      source: 'canonical',
    },
  };
}

export async function requestOzonProfitFullSnapshotForShops(shops = [], options = {}) {
  return requestOzonProfitSnapshotForShops(shops, {
    enrichCrossBorder: false,
    ...options,
  });
}

export {
  enrichOzonRfbsReturnItemsWithDetails,
  getOzonRfbsReturnId,
  getOzonRfbsReturnPayload,
  requestOzonRfbsReturnDetail,
};

export function summarizeAfterSalesRefundFinanceOperations(operations = []) {
  const amounts = operations.map(getFinanceOperationAmount).filter((amount) => amount !== null);
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  const hasPositive = amounts.some((amount) => amount > 0);
  const hasNegative = amounts.some((amount) => amount < 0);
  const getAccrualsForSale = (operation = {}) => {
    const value = Number(operation.accruals_for_sale ?? operation.accrualsForSale);
    return Number.isFinite(value) ? value : null;
  };
  const getAmountForCompensation = (operation = {}) => {
    const amount = getFinanceOperationAmount(operation);
    if (amount !== null) return amount;
    const value = Number(firstFilled(operation.amount_total, operation.amountTotal));
    return Number.isFinite(value) ? value : null;
  };
  const getOperationText = (operation = {}) =>
    [
      operation.operation_type,
      operation.operation_type_name,
      operation.operationType,
      operation.operationTypeName,
      operation.type,
      operation.name,
      operation.services?.map?.((service) => service.name || service.service_name).join(' '),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  const buyerCompensationOperations = operations.filter((operation) => {
    const amount = getAmountForCompensation(operation);
    if (amount === null || amount >= 0) return false;
    const operationText = getOperationText(operation);
    return (
      operationText.includes('operationmarketplaceservicepartialcompensationtoclient') ||
      /partial\s+compensation|compensation\s+to\s+(client|customer|buyer)/iu.test(operationText) ||
      /частичн\S*\s+компенсац\S*\s+покупател/iu.test(operationText)
    );
  });
  const buyerCompensationAmount = buyerCompensationOperations
    .map(getAmountForCompensation)
    .filter((amount) => amount !== null)
    .reduce((sum, amount) => sum + amount, 0);
  const evidenceText = operations
    .map((operation) =>
      [
        operation.operation_type,
        operation.operation_type_name,
        operation.type,
        operation.name,
        operation.services?.map?.((service) => service.name || service.service_name).join(' '),
      ]
        .filter(Boolean)
        .join(' ')
    )
    .join('\n')
    .toLowerCase();
  const hasRefundKeyword = /(clientreturn|refund|return|возврат|退款|退货|返还)/i.test(evidenceText);
  const hasAcquiringRedistributionOnly =
    operations.length > 0 &&
    operations.every((operation) => {
      const operationText = [
        operation.operation_type,
        operation.operation_type_name,
        operation.type,
        operation.name,
        operation.services?.map?.((service) => service.name || service.service_name).join(' '),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return /acquiring|эквайр|收单|перераспредел|redistribution/i.test(operationText) && !hasRefundKeyword;
    });
  const hasDeliveredSaleOperation = operations.some((operation) => {
    const operationType = String(operation.operation_type || operation.operationType || '').toLowerCase();
    const accrualsForSale = getAccrualsForSale(operation);
    return operationType.includes('deliveredtocustomer') || (accrualsForSale !== null && accrualsForSale > 0);
  });
  const hasRefundDeductionOperation = operations.some((operation) => {
    const operationText = [
      operation.operation_type,
      operation.operation_type_name,
      operation.type,
      operation.name,
      operation.services?.map?.((service) => service.name || service.service_name).join(' '),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const amount = getFinanceOperationAmount(operation);
    const accrualsForSale = getAccrualsForSale(operation);
    const hasReturnText = /clientreturn|refund|return|возврат|退款|退货/i.test(operationText);
    return Boolean(
      hasReturnText && ((amount !== null && amount < 0) || (accrualsForSale !== null && accrualsForSale < 0))
    );
  });
  const signedRefundConfirmed = hasDeliveredSaleOperation && hasRefundDeductionOperation;
  const confirmed =
    signedRefundConfirmed ||
    (!hasAcquiringRedistributionOnly &&
      operations.length > 0 &&
      hasRefundKeyword &&
      ((hasPositive && hasNegative) || Math.abs(total) < 0.01));
  return {
    checked: true,
    confirmed,
    signedRefundConfirmed,
    operationCount: operations.length,
    netAmount: Number(total.toFixed(4)),
    hasPositive,
    hasNegative,
    buyerCompensationConfirmed: buyerCompensationOperations.length > 0,
    buyerCompensationAmount: Number(buyerCompensationAmount.toFixed(4)),
    buyerCompensationOperationCount: buyerCompensationOperations.length,
    buyerCompensationStatus: buyerCompensationOperations.length > 0 ? '已补偿买家' : '',
    hasDeliveredSaleOperation,
    hasRefundDeductionOperation,
    hasAcquiringRedistributionOnly,
    reason: signedRefundConfirmed
      ? '财务流水已出现签收销售和退款扣款证据'
      : confirmed
        ? '财务流水已出现退款/冲正闭环证据'
        : '财务流水未确认退款/冲正闭环',
  };
}

export function getFinanceOperationPostingKey(operation = {}) {
  return firstUsableOzonId(
    operation.posting?.posting_number,
    operation.posting?.postingNumber,
    operation.posting_number,
    operation.postingNumber,
    operation.items?.[0]?.posting_number,
    operation.items?.[0]?.postingNumber
  );
}

export async function requestOzonAfterSalesRefundFinanceEvidence(shop, row = {}, options = {}) {
  const lookupPostingNumbers = getAfterSalesPostingLookupKeys(row);
  const postingNumber = lookupPostingNumbers[0] || '';
  if (!postingNumber)
    return { checked: false, confirmed: false, reason: '售后单未返回原订单号', lookupPostingNumbers: [] };
  const operations = await requestOzonFinanceOperationsForPostingCached(
    shop,
    postingNumber,
    resolveOzonTimeRange(
      options.dateRange || options.timeScope || options,
      options.defaultDays ?? OZON_INITIAL_ORDER_QUICK_RANGE_DAYS
    ),
    {
      preferBaseLookup: false,
      stopAfterFirstMatchedLookup: false,
    }
  );
  const summary = summarizeAfterSalesRefundFinanceOperations(operations);
  const matchedPostingNumbers = [
    ...new Set(
      operations
        .map(getFinanceOperationPostingKey)
        .filter(Boolean)
        .map((value) => normalizeOzonId(value).trim())
    ),
  ];
  const basePostingNumber = getProfitPostingBaseKey(postingNumber);
  return {
    ...summary,
    lookupPostingNumbers,
    matchedPostingNumbers,
    basePostingNumber,
    reason: `${summary.reason}${basePostingNumber ? `；已同时核查母单 ${basePostingNumber}` : ''}`,
  };
}

export function applyAfterSalesFinanceEvidence(row = {}, financeEvidence = null) {
  if (!financeEvidence?.checked) return row;
  const source = row.source || row.raw?.source || 'returns';
  const raw = {
    ...(row.raw ?? {}),
    financeRefundChecked: true,
    financeRefundConfirmed: Boolean(financeEvidence.confirmed),
    financeRefundEvidence: financeEvidence,
  };
  const classification = getAfterSalesStatusByRules(raw, source);
  const status = classification.status;
  return {
    ...row,
    raw,
    status,
    type: status,
    tone: getAfterSalesTone(status),
    excludeFromAfterSales: Boolean(classification.excludeFromAfterSales),
    classificationVersion: AFTER_SALES_CLASSIFICATION_VERSION,
    classificationConfidence: classification.confidence ?? row.classificationConfidence ?? 0,
    refusedEvidence: classification.deliveryEvidence?.refusedSnippet || classification.evidence.refusedSnippet || '',
    destroyedEvidence:
      classification.deliveryEvidence?.destroyedSnippet || classification.evidence.destroyedSnippet || '',
    blockedEvidence: classification.deliveryEvidence?.blockedSnippet || classification.evidence.blockedSnippet || '',
    deliveredEvidence: classification.deliveryEvidence?.deliveredSnippet || '',
    shippedEvidence: classification.deliveryEvidence?.shippedSnippet || '',
    originalOrderCancelledEvidence: classification.originalOrderEvidence?.cancelledSnippet || '',
    originalOrderDeliveredEvidence: classification.originalOrderEvidence?.deliveredSnippet || '',
    financeRefundChecked: true,
    financeRefundConfirmed: Boolean(financeEvidence.confirmed),
    financeRefundEvidence: financeEvidence,
    classificationReason: `${classification.reason || row.classificationReason || '售后归类'}；${financeEvidence.reason}`,
    timeline: [
      ...updateAfterSalesTimelineStatus(row.timeline, status).filter(
        (item) => !String(item || '').startsWith('财务核查：')
      ),
      `财务核查：${financeEvidence.confirmed ? '已确认退款/冲正' : '未确认退款/冲正'}`,
    ],
  };
}

export function updateAfterSalesTimelineStatus(timeline = [], status) {
  const rows = Array.isArray(timeline) ? timeline : [];
  const nextStatusLine = `售后状态：${status}`;
  let hasStatusLine = false;
  const next = [];
  rows.forEach((item) => {
    const text = String(item || '');
    if (text.startsWith('售后状态：')) {
      if (!hasStatusLine) next.push(nextStatusLine);
      hasStatusLine = true;
      return;
    }
    next.push(item);
  });
  return hasStatusLine ? next : [nextStatusLine, ...next];
}

export function upgradeAfterSalesDisplayReason(row = {}, status = '') {
  if (!row || typeof row !== 'object') return row;
  const source = row.source || row.raw?.source || 'returns';
  const raw = row.raw && typeof row.raw === 'object' ? { ...row.raw, ...row } : row;
  const displayStatus = status || row.status || row.type || getAfterSalesStatusByRules(raw, source).status;
  const displayReason = getOzonAfterSalesDisplayReason(raw, displayStatus);
  const displayReasonRaw = getOzonAfterSalesReasonRawText(raw);
  if (!isLowPriorityAfterSalesReason(displayReason) && displayReason !== row.reason) {
    return {
      ...row,
      reason: displayReason,
      reasonRaw: displayReasonRaw || row.reasonRaw || row.reason_raw || '',
      reason_raw: displayReasonRaw || row.reasonRaw || row.reason_raw || '',
      note: isLowPriorityAfterSalesReason(row.note) || !row.note || row.note === row.reason ? displayReason : row.note,
    };
  }
  if (isLowPriorityAfterSalesReason(row.reason) && isLowPriorityAfterSalesReason(displayReason)) {
    return {
      ...row,
      reason: '',
      note: isLowPriorityAfterSalesReason(row.note) || row.note === row.reason ? '' : row.note,
    };
  }
  return row;
}

export function upgradeAfterSalesClassificationRow(row = {}) {
  if (!row || typeof row !== 'object') return row;
  const currentVersion = Number(row.classificationVersion) || 0;
  if (currentVersion >= AFTER_SALES_CLASSIFICATION_VERSION) return upgradeAfterSalesDisplayReason(row);

  const source = row.source || row.raw?.source || 'returns';
  const raw = row.raw && typeof row.raw === 'object' ? { ...row.raw, ...row } : row;
  const classification = getAfterSalesStatusByRules(raw, source);
  const status = classification.status;
  return upgradeAfterSalesDisplayReason(
    {
      ...row,
      status,
      type: status,
      tone: getAfterSalesTone(status),
      excludeFromAfterSales: Boolean(classification.excludeFromAfterSales),
      classificationVersion: AFTER_SALES_CLASSIFICATION_VERSION,
      classificationConfidence: classification.confidence ?? row.classificationConfidence ?? 0,
      classificationReason: classification.reason || row.classificationReason || '售后归类',
      refusedEvidence:
        classification.deliveryEvidence?.refusedSnippet ||
        classification.evidence.refusedSnippet ||
        row.refusedEvidence ||
        '',
      destroyedEvidence:
        classification.deliveryEvidence?.destroyedSnippet ||
        classification.evidence.destroyedSnippet ||
        row.destroyedEvidence ||
        '',
      blockedEvidence:
        classification.deliveryEvidence?.blockedSnippet ||
        classification.evidence.blockedSnippet ||
        row.blockedEvidence ||
        '',
      deliveredEvidence: classification.deliveryEvidence?.deliveredSnippet || row.deliveredEvidence || '',
      shippedEvidence: classification.deliveryEvidence?.shippedSnippet || row.shippedEvidence || '',
      originalOrderCancelledEvidence:
        classification.originalOrderEvidence?.cancelledSnippet || row.originalOrderCancelledEvidence || '',
      originalOrderDeliveredEvidence:
        classification.originalOrderEvidence?.deliveredSnippet || row.originalOrderDeliveredEvidence || '',
      timeline: updateAfterSalesTimelineStatus(row.timeline, status),
    },
    status
  );
}

export function upgradeAfterSalesClassificationRows(rows = []) {
  return Array.isArray(rows) ? rows.map((row) => upgradeAfterSalesClassificationRow(row)) : [];
}

export async function enrichAfterSalesRowsWithClassificationEvidence(shop, rows = [], options = {}) {
  const originalRows = Array.isArray(rows) ? rows : [];
  const mergedRows = mergeAfterSalesRowsByBusinessKey(originalRows);
  if (!canUseOzonShop(shop) || !mergedRows.length) {
    return { rows: mergedRows, errors: [], attempted: 0, pending: 0 };
  }

  const candidates = mergedRows
    .map((row, index) => ({
      row,
      index,
      needsOriginalOrder: shouldReadAfterSalesOriginalOrderDetail(row),
      needsFinance: shouldRequestAfterSalesRefundFinanceEvidence(row),
    }))
    .filter((candidate) => candidate.needsOriginalOrder || candidate.needsFinance);
  const requestedMaxRows = Number(options.maxRows);
  const maxRows =
    Number.isFinite(requestedMaxRows) && requestedMaxRows > 0 ? Math.floor(requestedMaxRows) : candidates.length;
  const evidenceCandidates = candidates.slice(0, maxRows);
  if (!evidenceCandidates.length) {
    return { rows: mergedRows, errors: [], attempted: 0, pending: 0 };
  }

  const evidenceResults = await runLimitedAsync(
    evidenceCandidates,
    Math.min(4, OZON_AFTER_SALES_DETAIL_CONCURRENCY),
    async ({ row, needsOriginalOrder, needsFinance }) => {
      let detailRow = row;
      const source = row.source || row.raw?.source || 'returns';
      const errors = [];

      if (needsOriginalOrder) {
        const originalOrder = await requestOzonAfterSalesOriginalOrderDetail(shop, detailRow).catch(() => null);
        if (originalOrder && originalOrder !== detailRow) {
          const raw = mergeAfterSalesOriginalOrderEvidence(detailRow.raw ?? detailRow, originalOrder);
          detailRow = normalizeOzonAfterSalesRow(raw, { source, shop });
        }
      }

      if (needsFinance || shouldRequestAfterSalesRefundFinanceEvidence(detailRow)) {
        try {
          const financeEvidence = await requestOzonAfterSalesRefundFinanceEvidence(shop, detailRow, options);
          detailRow = applyAfterSalesFinanceEvidence(detailRow, financeEvidence);
        } catch (error) {
          errors.push({
            ok: false,
            label: `售后退款流水：${firstUsableOzonId(detailRow.salesOrder, detailRow.id) || '未知订单'}`,
            error,
          });
        }
      }

      return { row: detailRow, errors };
    }
  );

  const enrichedRows = mergeAfterSalesRowsByBusinessKey(originalRows);
  const errors = [];
  evidenceResults.forEach((result, index) => {
    const candidate = evidenceCandidates[index];
    if (result.status === 'fulfilled') {
      enrichedRows[candidate.index] = result.value?.row ?? candidate.row;
      errors.push(...(result.value?.errors ?? []));
      return;
    }
    errors.push({
      ok: false,
      label: `售后退款/原单证据：${firstUsableOzonId(candidate.row.salesOrder, candidate.row.id) || '未知订单'}`,
      error: result.reason,
    });
  });

  return {
    rows: mergeAfterSalesRowsByBusinessKey(enrichedRows),
    errors,
    attempted: evidenceCandidates.length,
    pending: Math.max(candidates.length - evidenceCandidates.length, 0),
  };
}

export {
  getOzonAfterSalesBackgroundSnapshotCacheKey,
  getOzonAfterSalesBackgroundSnapshotReadKeys,
  getOzonAfterSalesSnapshotCacheKey,
  getOzonAfterSalesSnapshotCacheKeys,
  getOzonAfterSalesSnapshotReadKeys,
};

export function getOzonSalesOrdersSnapshotCacheKey(shops = [], scope = null, cacheGroup = 'ozon-sales-orders') {
  return appendOzonSnapshotScopeKey(`${cacheGroup}:${getOzonSnapshotSourceKey(shops)}`, scope);
}

export function getOzonSalesOrdersSnapshotCacheKeys(shops = [], scope = null, cacheGroup = 'ozon-sales-orders') {
  return getOzonSnapshotSourceKeyCandidates(shops).map((sourceKey) =>
    appendOzonSnapshotScopeKey(`${cacheGroup}:${sourceKey}`, scope)
  );
}

export function getOzonSalesOrdersSnapshotReadKeys(shops = [], scope = null, cacheGroup = 'ozon-sales-orders') {
  return getOzonLocalUniqueValues([
    ...getOzonSalesOrdersSnapshotCacheKeys(shops, scope, cacheGroup),
    ...getOzonSalesOrdersSnapshotCacheKeys(shops, null, cacheGroup),
  ]);
}

export function getOzonSnapshotRowActivityTime(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const value = firstFilled(
    row.updatedAt,
    row.updated,
    row.paymentTime,
    row.paymentDate,
    row.createdAt,
    row.created,
    raw.updated_at,
    raw.updatedAt,
    raw.in_process_at,
    raw.created_at,
    raw.createdAt,
    raw.shipment_date,
    raw.delivery_date_begin
  );
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

export function sortOzonSnapshotRowsByRecentActivity(rows = []) {
  return [...rows].sort((left, right) => getOzonSnapshotRowActivityTime(right) - getOzonSnapshotRowActivityTime(left));
}

export function getOzonSnapshotRowActivityDateKey(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const candidates = [
    row.updatedAt,
    row.updated,
    row.paymentTime,
    row.paymentDate,
    row.createdAt,
    row.created,
    raw.updated_at,
    raw.updatedAt,
    raw.in_process_at,
    raw.created_at,
    raw.createdAt,
    raw.shipment_date,
    raw.delivery_date_begin,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (!text || text === '未返回') continue;
    const fullDate = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[T\s])/);
    if (fullDate && !/[T\s]\d{1,2}:\d{2}/.test(text)) {
      return `${fullDate[1]}-${fullDate[2].padStart(2, '0')}-${fullDate[3].padStart(2, '0')}`;
    }
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 2020) {
      return formatLocalDateKey(parsed);
    }
    const dateToken = text.split(/\s+/)[0].replace(/[，,]+$/u, '');
    const normalizedDate = normalizeSalesOrderDateFilter(dateToken);
    if (normalizedDate) return normalizedDate;
  }
  return '';
}

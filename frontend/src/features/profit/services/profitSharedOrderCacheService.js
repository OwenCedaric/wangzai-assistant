import { readAllSalesOrderPagedCache } from '../../../services/salesOrderPagedCacheClient.js';
import {
  readProfitMissingOnlyExchangeRateContext,
  writeProfitExchangeRateCachePatch,
} from '../../../entities/profit/profitExchangeRateCache.js';
import {
  buildOrderExchangeRateBundle,
  getOrderExchangeRateDateKeys,
} from '../../../services/orderExchangeRateRules.js';

const PROFIT_SHARED_ORDER_CACHE_TIMEOUT_MS = 30_000;
const PROFIT_SHARED_ORDER_EXCHANGE_TIMEOUT_MS = 8_000;
const PROFIT_SHARED_ORDER_EXCHANGE_LOOKBACK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function dateKeyMs(value = '') {
  const time = Date.parse(`${String(value || '').slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(time) ? time : null;
}

function applyLatestDailyRateToToday(context = {}, dateKeys = [], maxLookbackDays = 14) {
  const todayKey = String(context.todayKey || '').trim();
  if (!todayKey || context.realtime || !dateKeys.includes(todayKey)) return context;
  const todayMs = dateKeyMs(todayKey);
  if (todayMs === null) return context;
  const candidates = [];
  context.dailyRates?.forEach?.((rate, requestedDate) => {
    const dateMs = dateKeyMs(requestedDate);
    const lookbackDays = dateMs === null ? -1 : Math.round((todayMs - dateMs) / DAY_MS);
    if (lookbackDays < 0 || lookbackDays > maxLookbackDays || !rate?.rubToCnyRate) return;
    candidates.push({ rate, requestedDate, lookbackDays });
  });
  candidates.sort((left, right) => String(right.requestedDate).localeCompare(String(left.requestedDate)));
  const latest = candidates[0];
  if (!latest) return context;
  return {
    ...context,
    realtime: {
      ...latest.rate,
      mode: 'daily-nearest',
      requestedDate: todayKey,
      nearestFallback: true,
      lookbackDaysUsed: latest.lookbackDays,
    },
  };
}

function applySharedOrderExchangeRates(rows = [], exchangeRateContext = {}, buildBundle = buildOrderExchangeRateBundle) {
  return (Array.isArray(rows) ? rows : []).map((order) => {
    const exchangeRates = buildBundle(order, exchangeRateContext, { includeActual: false });
    const estimated = exchangeRates?.estimated;
    if (!estimated?.rubToCnyRate) return order;
    return {
      ...order,
      exchangeRate: estimated,
      estimatedExchangeRate: estimated,
      exchangeRates: { ...(order.exchangeRates ?? {}), estimated },
      rubToCnyRate: estimated.rubToCnyRate,
    };
  });
}

export async function hydrateProfitSharedOrderExchangeRates(rows = [], options = {}) {
  const dateKeys = getOrderExchangeRateDateKeys(rows);
  if (!dateKeys.length) return rows;
  const readExchangeRateContext = options.readExchangeRateContext || readProfitMissingOnlyExchangeRateContext;
  try {
    const maxLookbackDays =
      Number(options.exchangeRateMaxLookbackDays) || PROFIT_SHARED_ORDER_EXCHANGE_LOOKBACK_DAYS;
    const exchangeRateContext = applyLatestDailyRateToToday(await readExchangeRateContext(rows, {
        dateKeys,
        localDataFileKey: options.localDataFileKey,
        profitExchangeRateBatchSize: Number(options.profitExchangeRateBatchSize) || 100,
        profitExchangeRateRealtimeTtlMs: Number(options.profitExchangeRateRealtimeTtlMs) || 30 * 60 * 1000,
        exchangeRateTimeoutMs:
          Number(options.exchangeRateTimeoutMs) || PROFIT_SHARED_ORDER_EXCHANGE_TIMEOUT_MS,
        exchangeRateMaxLookbackDays: maxLookbackDays,
        exchangeRateDailyConcurrency: Number(options.exchangeRateDailyConcurrency) || 30,
    }), dateKeys, maxLookbackDays);
    if (exchangeRateContext?.realtime) {
      const persistExchangeRateContext = options.persistExchangeRateContext || writeProfitExchangeRateCachePatch;
      await persistExchangeRateContext(exchangeRateContext, {
        fileKey: options.localDataFileKey,
        todayKey: exchangeRateContext.todayKey,
        ttlMs: Number(options.profitExchangeRateRealtimeTtlMs) || 30 * 60 * 1000,
      }).catch(() => undefined);
    }
    return applySharedOrderExchangeRates(
      rows,
      exchangeRateContext,
      options.buildExchangeRateBundle || buildOrderExchangeRateBundle,
    );
  } catch {
    return rows;
  }
}

/**
 * Reads the same canonical SQLite order cache used by order management.
 * This adapter never refreshes Ozon and does not calculate or rewrite profit data.
 */
export async function readProfitOrdersFromSharedCache(shops = [], timeScope = null, options = {}) {
  const snapshot = await readAllSalesOrderPagedCache(
    {
      shops,
      timeScope,
      shop: 'all',
      status: 'all',
      fulfillment: 'all',
      keyword: '',
      page: 1,
      includeSummary: false,
      allHistory: timeScope?.allHistory === true,
      includeProductImages: true,
      projection: 'profit',
    },
    {
      timeoutMs: Number(options.timeoutMs) || PROFIT_SHARED_ORDER_CACHE_TIMEOUT_MS,
    }
  );
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const hydratedRows = options.deferExchangeRates === true
    ? rows
    : await hydrateProfitSharedOrderExchangeRates(rows, options);

  return {
    rows: hydratedRows,
    total: Number(snapshot?.total) || 0,
    source: snapshot?.source || 'sqlite',
    fetchedAt: snapshot?.fetchedAt || new Date().toISOString(),
  };
}

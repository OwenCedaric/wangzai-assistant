import {
  readRubCnyExchangeRateContext,
  readRubCnyRateCache,
  saveRubCnyRateCacheRecords,
} from '../../services/exchangeRateClient';
import {
  getCachedActualExchangeRate,
  getCachedEstimatedExchangeRate,
  getOrderExchangeRateDateKeys,
  normalizeOrderExchangeDateKey,
  normalizeOrderExchangeRatePayload,
} from '../../services/orderExchangeRateRules';
import { LOCAL_PROFIT_DATA_FILE_KEY } from '../../shared/config/appConfigCore.jsx';
import { enqueueOzonLocalDataWrite, readLocalDataFile, writeLocalDataFile } from '../product/productLocalData.jsx';

const PROFIT_EXCHANGE_RATE_CACHE_VERSION = 1;
const DEFAULT_PROFIT_EXCHANGE_RATE_BATCH_SIZE = 100;
const DEFAULT_PROFIT_EXCHANGE_RATE_TIMEOUT_MS = 8000;
const DEFAULT_PROFIT_EXCHANGE_RATE_DAILY_CONCURRENCY = 30;
const DEFAULT_PROFIT_EXCHANGE_RATE_TTL_MS = 30 * 60 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getNowDate(options = {}) {
  if (typeof options.now === 'function') return toDate(options.now()) || new Date();
  if (typeof options.exchangeRateNow === 'function') return toDate(options.exchangeRateNow()) || new Date();
  if (options.exchangeRateNow) return toDate(options.exchangeRateNow) || new Date();
  return toDate(options.now) || new Date();
}

function getIsoTimestamp(value = new Date()) {
  const date = toDate(value);
  return date ? date.toISOString() : new Date().toISOString();
}

function getProfitExchangeRateTodayKey(options = {}) {
  return (
    normalizeOrderExchangeDateKey(options.todayKey) ||
    normalizeOrderExchangeDateKey(options.exchangeRateTodayKey) ||
    normalizeOrderExchangeDateKey(getNowDate(options))
  );
}

function normalizeProfitExchangeRateCache(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return {
    version: Number(source.version) || PROFIT_EXCHANGE_RATE_CACHE_VERSION,
    updatedAt: String(source.updatedAt || '').trim(),
    daily: isPlainObject(source.daily) ? { ...source.daily } : {},
    realtime: isPlainObject(source.realtime) ? { ...source.realtime } : {},
  };
}

function normalizeProfitExchangeRateRecord(value, options = {}) {
  const fallbackDateKey = normalizeOrderExchangeDateKey(options.dateKey || options.requestedDate || options.date);
  const normalized = normalizeOrderExchangeRatePayload(value, {
    role: options.role || value?.role,
    requestedDate: fallbackDateKey,
    date: fallbackDateKey,
  });
  if (!normalized) return null;
  const requestedDate = normalizeOrderExchangeDateKey(normalized.requestedDate || fallbackDateKey || normalized.date);
  const date = normalizeOrderExchangeDateKey(normalized.date || requestedDate);
  if (!requestedDate && !date) return null;
  return {
    ...normalized,
    requestedDate: requestedDate || date,
    date: date || requestedDate,
    fetchedAt: String(value?.fetchedAt || normalized.fetchedAt || '').trim(),
    expiresAt: String(value?.expiresAt || '').trim(),
    immutable: value?.immutable === undefined ? undefined : Boolean(value.immutable),
  };
}

function isRealtimeRecordFresh(record, options = {}) {
  const normalized = normalizeProfitExchangeRateRecord(record, options);
  if (!normalized) return false;
  const nowMs = getNowDate(options).getTime();
  const expiresAt = toDate(normalized.expiresAt);
  if (expiresAt) return expiresAt.getTime() > nowMs;
  const fetchedAt = toDate(normalized.fetchedAt);
  if (!fetchedAt) return false;
  const ttlMs = Math.max(1, Number(options.ttlMs) || DEFAULT_PROFIT_EXCHANGE_RATE_TTL_MS);
  return nowMs - fetchedAt.getTime() <= ttlMs;
}

function createEmptyExchangeRateContext(options = {}) {
  return {
    todayKey: getProfitExchangeRateTodayKey(options),
    realtime: null,
    dailyRates: new Map(),
    errors: [],
  };
}

function setContextRate(context, value, options = {}) {
  const record = normalizeProfitExchangeRateRecord(value, options);
  if (!record) return false;
  const todayKey = options.todayKey || context.todayKey;
  const dateKey = normalizeOrderExchangeDateKey(record.requestedDate || record.date || options.dateKey);
  if (!dateKey) return false;
  if (dateKey === todayKey) {
    if (isRealtimeRecordFresh(record, { ...options, dateKey, todayKey })) {
      context.realtime = record;
      return true;
    }
    return false;
  }
  context.dailyRates.set(dateKey, { ...record, immutable: true });
  return true;
}

function createStoredProfitExchangeRateRecord(record, options = {}) {
  const dateKey = normalizeOrderExchangeDateKey(options.dateKey || record?.requestedDate || record?.date);
  const todayKey = options.todayKey || '';
  const now = getNowDate(options);
  const fetchedAt = String(record?.fetchedAt || '').trim() || getIsoTimestamp(now);
  const stored = {
    mode: String(record?.mode || (dateKey === todayKey ? 'realtime' : 'daily')).trim(),
    date: normalizeOrderExchangeDateKey(record?.date || dateKey) || dateKey,
    requestedDate: normalizeOrderExchangeDateKey(record?.requestedDate || dateKey) || dateKey,
    nearestFallback: Boolean(record?.nearestFallback),
    lookbackDaysUsed:
      record?.lookbackDaysUsed === null || record?.lookbackDaysUsed === undefined
        ? null
        : Number.isFinite(Number(record.lookbackDaysUsed))
          ? Number(record.lookbackDaysUsed)
          : null,
    base: 'RUB',
    quote: 'CNY',
    rubToCnyRate: Number(record?.rubToCnyRate ?? record?.rate),
    source: String(record?.source || '').trim(),
    fetchedAt,
    immutable: dateKey !== todayKey,
  };
  if (dateKey === todayKey) {
    const ttlMs = Math.max(1, Number(options.ttlMs) || DEFAULT_PROFIT_EXCHANGE_RATE_TTL_MS);
    stored.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  }
  return Number.isFinite(stored.rubToCnyRate) && stored.rubToCnyRate > 0 ? stored : null;
}

function mergeProfitExchangeRateCache(currentCache = {}, patch = {}, options = {}) {
  const cache = normalizeProfitExchangeRateCache(currentCache);
  const todayKey = options.todayKey || getProfitExchangeRateTodayKey(options);
  const dailyPatch = patch?.daily instanceof Map ? Object.fromEntries(patch.daily) : patch?.daily || {};
  const realtimePatch = patch?.realtime instanceof Map ? Object.fromEntries(patch.realtime) : patch?.realtime || {};

  Object.entries(dailyPatch).forEach(([dateKey, value]) => {
    const normalizedDateKey = normalizeOrderExchangeDateKey(dateKey);
    if (!normalizedDateKey) return;
    const record = createStoredProfitExchangeRateRecord(value, {
      ...options,
      dateKey: normalizedDateKey,
      todayKey,
    });
    if (record) cache.daily[normalizedDateKey] = record;
  });

  Object.entries(realtimePatch).forEach(([dateKey, value]) => {
    const normalizedDateKey = normalizeOrderExchangeDateKey(dateKey);
    if (!normalizedDateKey) return;
    const record = createStoredProfitExchangeRateRecord(value, {
      ...options,
      dateKey: normalizedDateKey,
      todayKey,
    });
    if (record) cache.realtime[normalizedDateKey] = record;
  });

  cache.version = PROFIT_EXCHANGE_RATE_CACHE_VERSION;
  cache.updatedAt = getIsoTimestamp(getNowDate(options));
  return cache;
}

function createProfitExchangeRateCachePatchFromContext(context = {}, options = {}) {
  const todayKey = options.todayKey || context.todayKey || getProfitExchangeRateTodayKey(options);
  const daily = {};
  const realtime = {};
  if (context.dailyRates?.forEach) {
    context.dailyRates.forEach((rate, dateKey) => {
      const normalizedDateKey = normalizeOrderExchangeDateKey(dateKey);
      if (!normalizedDateKey || normalizedDateKey === todayKey) return;
      daily[normalizedDateKey] = rate;
    });
  }
  const realtimeDateKey = normalizeOrderExchangeDateKey(
    context.realtime?.requestedDate || context.realtime?.date || todayKey
  );
  if (context.realtime && realtimeDateKey) {
    realtime[realtimeDateKey] = context.realtime;
  }
  return { daily, realtime };
}

function hasStoredRateRecords(cache = {}) {
  const normalized = normalizeProfitExchangeRateCache(cache);
  return Boolean(Object.keys(normalized.daily).length || Object.keys(normalized.realtime).length);
}

function createProfitExchangeRateCacheFromCanonicalRecords(records = []) {
  const daily = {};
  const realtime = {};
  let updatedAt = '';
  (Array.isArray(records) ? records : []).forEach((record) => {
    const normalized = normalizeProfitExchangeRateRecord(record, { dateKey: record?.requestedDate });
    const dateKey = normalizeOrderExchangeDateKey(normalized?.requestedDate || normalized?.date);
    if (!normalized || !dateKey) return;
    const target = normalized.immutable === false ? realtime : daily;
    target[dateKey] = normalized;
    const candidateUpdatedAt = String(record?.updatedAt || normalized.fetchedAt || '').trim();
    if (Date.parse(candidateUpdatedAt) > Date.parse(updatedAt)) updatedAt = candidateUpdatedAt;
  });
  return normalizeProfitExchangeRateCache({ version: PROFIT_EXCHANGE_RATE_CACHE_VERSION, updatedAt, daily, realtime });
}

function createCanonicalRateRecords(cache = {}) {
  const normalized = normalizeProfitExchangeRateCache(cache);
  return [...Object.values(normalized.daily), ...Object.values(normalized.realtime)].map((record) => ({
    ...record,
    requestedDate: normalizeOrderExchangeDateKey(record?.requestedDate || record?.date),
  })).filter((record) => record.requestedDate);
}

function createRateReadError(label, error) {
  return {
    ok: false,
    label,
    error: error instanceof Error ? error : new Error(String(error || '利润汇率读取失败')),
  };
}

function notifyProfitProgress(options = {}, event = {}) {
  if (typeof options.progressReporter !== 'function') return;
  options.progressReporter({
    active: true,
    stage: 'exchange-rate',
    label: '利润汇率补读',
    ...event,
  });
}

function uniqueDateKeys(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : []).map((value) => normalizeOrderExchangeDateKey(value)).filter(Boolean)
    ),
  ];
}

function chunkValues(values = [], size = DEFAULT_PROFIT_EXCHANGE_RATE_BATCH_SIZE) {
  const chunkSize = Math.max(1, Number(size) || DEFAULT_PROFIT_EXCHANGE_RATE_BATCH_SIZE);
  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function readProfitExchangeRateCache(fileKey = LOCAL_PROFIT_DATA_FILE_KEY, options = {}) {
  const readCanonical = options.readCanonicalCache || readRubCnyRateCache;
  const saveCanonical = options.saveCanonicalCache || saveRubCnyRateCacheRecords;
  try {
    const canonical = createProfitExchangeRateCacheFromCanonicalRecords(
      (await readCanonical({ timeoutMs: options.timeoutMs ?? 3000 }))?.records
    );
    if (hasStoredRateRecords(canonical)) return canonical;
  } catch {
    // local-api 不可用时才继续读取 legacy file，避免正常利润打开解析整份大 JSON。
  }

  const store = await readLocalDataFile(fileKey).catch(() => ({}));
  const legacy = normalizeProfitExchangeRateCache(store?.profitExchangeRates);
  if (hasStoredRateRecords(legacy)) {
    await saveCanonical(createCanonicalRateRecords(legacy), { timeoutMs: options.timeoutMs ?? 3000 }).catch(() => undefined);
  }
  return legacy;
}

export function collectProfitCachedExchangeRates(rows = [], cache = {}, options = {}) {
  const todayKey = options.todayKey || getProfitExchangeRateTodayKey(options);
  const context = createEmptyExchangeRateContext({ ...options, todayKey });
  const normalizedCache = normalizeProfitExchangeRateCache(cache);

  Object.entries(normalizedCache.daily).forEach(([dateKey, record]) => {
    setContextRate(context, record, { ...options, dateKey, todayKey });
  });
  Object.entries(normalizedCache.realtime).forEach(([dateKey, record]) => {
    setContextRate(context, record, { ...options, dateKey, todayKey });
  });

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const estimated = getCachedEstimatedExchangeRate(row);
    if (estimated) setContextRate(context, estimated, { ...options, dateKey: estimated.requestedDate, todayKey });
    const actual = getCachedActualExchangeRate(row);
    if (actual) setContextRate(context, actual, { ...options, dateKey: actual.requestedDate, todayKey });
  });

  return context;
}

export function getProfitMissingExchangeRateDateKeys(requiredDateKeys = [], context = {}, options = {}) {
  const todayKey = options.todayKey || context.todayKey || getProfitExchangeRateTodayKey(options);
  return uniqueDateKeys(requiredDateKeys).filter((dateKey) => {
    if (dateKey === todayKey) return !isRealtimeRecordFresh(context.realtime, { ...options, dateKey, todayKey });
    return !context.dailyRates?.has?.(dateKey);
  });
}

export function mergeProfitExchangeRateContext(cachedContext = {}, freshContext = {}, options = {}) {
  const todayKey =
    options.todayKey || freshContext.todayKey || cachedContext.todayKey || getProfitExchangeRateTodayKey(options);
  const dailyRates = new Map();
  cachedContext.dailyRates?.forEach?.((rate, dateKey) => {
    const normalizedDateKey = normalizeOrderExchangeDateKey(dateKey);
    if (normalizedDateKey) dailyRates.set(normalizedDateKey, rate);
  });
  freshContext.dailyRates?.forEach?.((rate, dateKey) => {
    const normalizedDateKey = normalizeOrderExchangeDateKey(dateKey);
    if (normalizedDateKey) dailyRates.set(normalizedDateKey, rate);
  });
  return {
    todayKey,
    realtime: freshContext.realtime || cachedContext.realtime || null,
    dailyRates,
    errors: [...(cachedContext.errors ?? []), ...(freshContext.errors ?? [])],
  };
}

export async function writeProfitExchangeRateCachePatch(context = {}, options = {}) {
  const todayKey = options.todayKey || context.todayKey || getProfitExchangeRateTodayKey(options);
  const patch = createProfitExchangeRateCachePatchFromContext(context, { ...options, todayKey });
  if (!Object.keys(patch.daily).length && !Object.keys(patch.realtime).length) return null;
  const canonicalPatch = normalizeProfitExchangeRateCache({
    version: PROFIT_EXCHANGE_RATE_CACHE_VERSION,
    daily: patch.daily,
    realtime: patch.realtime,
  });
  try {
    const result = await (options.saveCanonicalCache || saveRubCnyRateCacheRecords)(
      createCanonicalRateRecords(canonicalPatch),
      { timeoutMs: options.timeoutMs ?? 3000 }
    );
    if (result?.ok) return canonicalPatch;
    throw new Error('EXCHANGE_RATE_CACHE_SAVE_FAILED');
  } catch {
    // SQLite/local-api 不可用时才保留 legacy fallback，不能在成功路径继续双写。
  }
  const fileKey = options.fileKey || LOCAL_PROFIT_DATA_FILE_KEY;
  return enqueueOzonLocalDataWrite(fileKey, async () => {
    const currentStore = await readLocalDataFile(fileKey).catch(() => ({}));
    const nextCache = mergeProfitExchangeRateCache(currentStore?.profitExchangeRates, patch, {
      ...options,
      todayKey,
    });
    await writeLocalDataFile(fileKey, {
      ...(isPlainObject(currentStore) ? currentStore : {}),
      profitExchangeRates: nextCache,
    });
    return nextCache;
  });
}

export async function readProfitMissingOnlyExchangeRateContext(rows = [], options = {}, financeOperations = []) {
  const todayKey = getProfitExchangeRateTodayKey(options);
  const ttlMs = Math.max(1, Number(options.profitExchangeRateRealtimeTtlMs) || DEFAULT_PROFIT_EXCHANGE_RATE_TTL_MS);
  const requiredDateKeys = uniqueDateKeys(
    options.dateKeys || getOrderExchangeRateDateKeys(rows, { financeOperations })
  );
  const cache = await readProfitExchangeRateCache(
    options.localDataFileKey || LOCAL_PROFIT_DATA_FILE_KEY,
    options,
  ).catch(() => ({}));
  const cachedContext = collectProfitCachedExchangeRates(rows, cache, {
    ...options,
    todayKey,
    ttlMs,
  });
  const missingDateKeys = getProfitMissingExchangeRateDateKeys(requiredDateKeys, cachedContext, {
    ...options,
    todayKey,
    ttlMs,
  });
  const cachedCount = Math.max(0, requiredDateKeys.length - missingDateKeys.length);
  notifyProfitProgress(options, {
    total: requiredDateKeys.length,
    cached: cachedCount,
    missing: missingDateKeys.length,
    done: 0,
    message: `利润汇率：本地命中 ${cachedCount} 个日期，待补读 ${missingDateKeys.length} 个日期`,
  });

  if (!missingDateKeys.length) {
    notifyProfitProgress(options, {
      active: false,
      total: requiredDateKeys.length,
      cached: cachedCount,
      missing: 0,
      done: 0,
      message: `利润汇率已全部命中本地缓存，共 ${requiredDateKeys.length} 个日期`,
    });
    return cachedContext;
  }

  let mergedContext = cachedContext;
  let completed = 0;
  let failed = 0;
  const batchSize = Math.max(1, Number(options.profitExchangeRateBatchSize) || DEFAULT_PROFIT_EXCHANGE_RATE_BATCH_SIZE);
  for (const chunk of chunkValues(missingDateKeys, batchSize)) {
    let freshContext = null;
    try {
      freshContext = await readRubCnyExchangeRateContext(chunk, {
        timeoutMs: options.exchangeRateTimeoutMs ?? DEFAULT_PROFIT_EXCHANGE_RATE_TIMEOUT_MS,
        todayKey,
        now: options.exchangeRateNow ?? options.now,
        maxLookbackDays: options.exchangeRateMaxLookbackDays,
        dailyConcurrency: options.exchangeRateDailyConcurrency ?? DEFAULT_PROFIT_EXCHANGE_RATE_DAILY_CONCURRENCY,
        includeRealtime: false,
      });
    } catch (error) {
      freshContext = {
        todayKey,
        realtime: null,
        dailyRates: new Map(),
        errors: [createRateReadError('利润汇率补读', error)],
      };
    }
    completed += chunk.length;
    failed += freshContext.errors?.length ?? 0;
    mergedContext = mergeProfitExchangeRateContext(mergedContext, freshContext, { ...options, todayKey, ttlMs });
    notifyProfitProgress(options, {
      total: requiredDateKeys.length,
      cached: cachedCount,
      missing: missingDateKeys.length,
      done: completed,
      failed,
      message: `利润汇率补读 ${completed} / ${missingDateKeys.length}，本地已命中 ${cachedCount} 个日期`,
    });
  }

  await writeProfitExchangeRateCachePatch(mergedContext, {
    ...options,
    fileKey: options.localDataFileKey || LOCAL_PROFIT_DATA_FILE_KEY,
    todayKey,
    ttlMs,
  }).catch((error) => {
    mergedContext = {
      ...mergedContext,
      errors: [...(mergedContext.errors ?? []), createRateReadError('利润汇率缓存写入', error)],
    };
  });

  notifyProfitProgress(options, {
    active: false,
    total: requiredDateKeys.length,
    cached: cachedCount,
    missing: missingDateKeys.length,
    done: missingDateKeys.length,
    failed,
    message: `利润汇率补读完成：本地命中 ${cachedCount}，补读 ${missingDateKeys.length}`,
  });
  return mergedContext;
}

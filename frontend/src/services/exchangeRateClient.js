import {
  getRubCnyDailyRate,
  getRubCnyDailyRates,
  getRubCnyRealtimeRate,
  listRubCnyRateCache,
  saveRubCnyRateCache,
} from '../api/localApiClient';

export function readRubCnyRateCache(options = {}) {
  return listRubCnyRateCache(options);
}

export function saveRubCnyRateCacheRecords(records = [], options = {}) {
  return saveRubCnyRateCache(records, options);
}

export function normalizeRubCnyRatePayload(payload = null) {
  if (!payload?.ok) return null;
  const rate = Number(payload.rubToCnyRate ?? payload.rate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return {
    mode: String(payload.mode || '').trim() || 'unknown',
    date: String(payload.date || payload.providerDate || '').trim(),
    requestedDate: String(payload.requestedDate || '').trim(),
    nearestFallback: Boolean(payload.nearestFallback),
    lookbackDaysUsed:
      payload.lookbackDaysUsed === null || payload.lookbackDaysUsed === undefined
        ? null
        : Number.isFinite(Number(payload.lookbackDaysUsed))
          ? Number(payload.lookbackDaysUsed)
          : null,
    base: 'RUB',
    quote: 'CNY',
    rubToCnyRate: rate,
    source: String(payload.source || '').trim(),
    fetchedAt: String(payload.fetchedAt || '').trim(),
  };
}

export function getExchangeRateDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeDateKey(value = '') {
  const text = String(value || '')
    .trim()
    .slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : '';
}

function createRateError(label, error) {
  return {
    ok: false,
    label,
    error: error instanceof Error ? error : new Error(String(error || '汇率读取失败')),
  };
}

async function runLimitedRateReads(items = [], limit = 3, worker = async () => undefined) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(Number(limit) || 1, 1), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    })
  );

  return results;
}

function normalizeBatchRateRows(payload = {}, requestedDateKeys = []) {
  const requestedDates = Array.isArray(requestedDateKeys) ? requestedDateKeys : [];
  const rates = payload?.rates;
  const rows = [];

  if (Array.isArray(rates)) {
    rates.forEach((item, index) => {
      const value = item && typeof item === 'object' ? item : { rate: item };
      rows.push({
        requestedDate:
          normalizeDateKey(value.requestedDate) || normalizeDateKey(value.date) || requestedDates[index] || '',
        payload: value.ok === undefined ? { ...value, ok: true } : value,
      });
    });
    return rows;
  }

  if (rates && typeof rates === 'object') {
    Object.entries(rates).forEach(([date, item]) => {
      const value = item && typeof item === 'object' ? item : { rate: item };
      rows.push({
        requestedDate: normalizeDateKey(value.requestedDate) || normalizeDateKey(date) || normalizeDateKey(value.date),
        payload: value.ok === undefined ? { ...value, ok: true, requestedDate: date } : value,
      });
    });
  }

  return rows;
}

function getBatchErrorMessage(value, fallback = '历史日汇率批量读取失败') {
  if (value instanceof Error) return value;
  const message = value?.error?.message || value?.message || value?.error || value;
  return message instanceof Error ? message : new Error(String(message || fallback));
}

export function createRubCnyExchangeRateReader({
  readRealtime = getRubCnyRealtimeRate,
  readDaily = getRubCnyDailyRate,
  readDailyBatch = getRubCnyDailyRates,
} = {}) {
  return async function readRubCnyExchangeRateContext(dateKeys = [], options = {}) {
    const todayKey = normalizeDateKey(options.todayKey) || getExchangeRateDateKey(options.now || new Date());
    const normalizedDateKeys = [
      ...new Set((Array.isArray(dateKeys) ? dateKeys : []).map(normalizeDateKey).filter(Boolean)),
    ];
    const dailyDateKeys =
      options.skipDailyRates === true ? [] : normalizedDateKeys.filter((dateKey) => dateKey !== todayKey);
    const needsRealtime = options.includeRealtime !== false || normalizedDateKeys.length !== dailyDateKeys.length;
    const errors = [];
    let realtime = null;
    const dailyRates = new Map();

    if (needsRealtime) {
      try {
        realtime = normalizeRubCnyRatePayload(
          await readRealtime({ timeoutMs: options.timeoutMs, signal: options.signal })
        );
        if (!realtime) errors.push(createRateError('实时汇率', '实时汇率接口未返回有效 RUB/CNY'));
      } catch (error) {
        errors.push(createRateError('实时汇率', error));
      }
      if (!realtime) {
        try {
          const nearestDailyRate = normalizeRubCnyRatePayload(
            await readDaily(todayKey, {
              timeoutMs: options.timeoutMs,
              signal: options.signal,
              allowNearest: true,
              maxLookbackDays: options.maxLookbackDays,
            })
          );
          if (nearestDailyRate) {
            realtime = { ...nearestDailyRate, mode: 'daily-nearest' };
          } else {
            errors.push(createRateError(`最近可取汇率 ${todayKey}`, '最近可取汇率接口未返回有效 RUB/CNY'));
          }
        } catch (error) {
          errors.push(createRateError(`最近可取汇率 ${todayKey}`, error));
        }
      }
    }

    const shouldUseBatch =
      dailyDateKeys.length > 1 &&
      typeof readDailyBatch === 'function' &&
      options.useBatchRates !== false &&
      options.disableBatchRates !== true;

    if (shouldUseBatch) {
      try {
        const batchPayload = await readDailyBatch(dailyDateKeys, {
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          allowNearest: true,
          maxLookbackDays: options.maxLookbackDays,
        });
        const rows = normalizeBatchRateRows(batchPayload, dailyDateKeys);
        const returnedDates = new Set();

        rows.forEach((row) => {
          const requestedDate = normalizeDateKey(row.requestedDate);
          if (!requestedDate || !dailyDateKeys.includes(requestedDate)) return;
          const rate = normalizeRubCnyRatePayload(row.payload);
          if (!rate) return;
          returnedDates.add(requestedDate);
          dailyRates.set(requestedDate, {
            ...rate,
            requestedDate: rate.requestedDate || requestedDate,
            mode: rate.nearestFallback ? 'daily-nearest' : 'daily',
          });
        });

        const batchErrors = Array.isArray(batchPayload?.errors) ? batchPayload.errors : [];
        batchErrors.forEach((error, index) => {
          errors.push(createRateError(error?.label || `历史日汇率批量错误 ${index + 1}`, getBatchErrorMessage(error)));
        });

        const missingDates = dailyDateKeys.filter((dateKey) => !returnedDates.has(dateKey));
        if (batchPayload?.ok === false || missingDates.length) {
          const missingHint = missingDates.length
            ? `未返回 ${missingDates.length} 个日期的有效汇率`
            : '批量汇率读取失败';
          errors.push(createRateError('历史日汇率批量读取', getBatchErrorMessage(batchPayload?.error, missingHint)));
        }
      } catch (error) {
        errors.push(createRateError('历史日汇率批量读取', error));
      }
    } else {
      await runLimitedRateReads(dailyDateKeys, options.dailyConcurrency ?? 3, async (dateKey) => {
        try {
          const rate = normalizeRubCnyRatePayload(
            await readDaily(dateKey, {
              timeoutMs: options.timeoutMs,
              signal: options.signal,
              allowNearest: true,
              maxLookbackDays: options.maxLookbackDays,
            })
          );
          if (rate) {
            dailyRates.set(dateKey, { ...rate, mode: rate.nearestFallback ? 'daily-nearest' : 'daily' });
          } else {
            errors.push(createRateError(`日汇率 ${dateKey}`, '日汇率接口未返回有效 RUB/CNY'));
          }
        } catch (error) {
          errors.push(createRateError(`日汇率 ${dateKey}`, error));
        }
      });
    }

    return {
      todayKey,
      realtime,
      dailyRates,
      errors,
    };
  };
}

export const readRubCnyExchangeRateContext = createRubCnyExchangeRateReader();

export function getRubCnyRateForDate(dateKey = '', context = {}, options = {}) {
  const normalizedDateKey = normalizeDateKey(dateKey);
  if (normalizedDateKey && normalizedDateKey !== context.todayKey) {
    return (
      context.dailyRates?.get?.(normalizedDateKey) ??
      (options.allowRealtimeFallback !== false ? context.realtime : null) ??
      null
    );
  }
  return context.realtime ?? null;
}

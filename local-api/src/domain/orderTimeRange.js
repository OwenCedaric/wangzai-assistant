export const DEFAULT_ORDER_SYNC_RANGE_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function firstFilled(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function resolveNow(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date : new Date();
}

export function getExplicitOrderSyncRange(params = {}, input = {}) {
  const source = toPlainObject(params);
  const safeInput = toPlainObject(input);
  const filter = toPlainObject(source.filter);
  const inputRange = toPlainObject(safeInput.dateRange ?? safeInput.range);
  const since = firstFilled(
    filter.since,
    filter.date_from,
    filter.dateFrom,
    source.since,
    source.date_from,
    source.dateFrom,
    inputRange.since,
    inputRange.date_from,
    inputRange.dateFrom,
    safeInput.since,
    safeInput.date_from,
    safeInput.dateFrom
  );
  const to = firstFilled(
    filter.to,
    filter.date_to,
    filter.dateTo,
    source.to,
    source.date_to,
    source.dateTo,
    inputRange.to,
    inputRange.date_to,
    inputRange.dateTo,
    safeInput.to,
    safeInput.date_to,
    safeInput.dateTo
  );
  return { since, to };
}

export function normalizeOrderLikeSyncParamsWithDefaultRange(params = {}, input = {}, options = {}) {
  const source = toPlainObject(params);
  const filter = toPlainObject(source.filter);
  const explicitRange = getExplicitOrderSyncRange(source, input);
  if (explicitRange.since || explicitRange.to) {
    return {
      ...source,
      filter: {
        ...filter,
        ...(explicitRange.since ? { since: explicitRange.since } : {}),
        ...(explicitRange.to ? { to: explicitRange.to } : {}),
      },
    };
  }

  const defaultDays = toPositiveInteger(
    options.defaultDays ?? input.defaultDays ?? input.default_days,
    DEFAULT_ORDER_SYNC_RANGE_DAYS
  );
  const end = resolveNow(options.now ?? input.now ?? input.currentTime ?? input.current_time);
  const start = new Date(end.getTime() - defaultDays * MS_PER_DAY);
  return {
    ...source,
    filter: {
      ...filter,
      since: start.toISOString(),
      to: end.toISOString(),
    },
  };
}

export function normalizeOrderLikeCacheQueryWithDefaultRange(query = {}, options = {}) {
  const source = toPlainObject(query);
  const explicitRange = getExplicitOrderSyncRange(source, source);
  const allHistoryValue = source.allHistory ?? source.all_history;
  const allHistory = allHistoryValue === true || allHistoryValue === 1 || normalizeText(allHistoryValue) === '1';
  if (allHistory && !explicitRange.since && !explicitRange.to) {
    return { ...source, since: '', to: '' };
  }
  const rangedParams = normalizeOrderLikeSyncParamsWithDefaultRange(source, source, options);
  const filter = toPlainObject(rangedParams.filter);
  return {
    ...source,
    since: firstFilled(source.since, source.from, source.dateFrom, filter.since),
    to: firstFilled(source.to, source.dateTo, filter.to),
  };
}

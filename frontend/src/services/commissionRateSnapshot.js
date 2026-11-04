import { normalizeEstimatedCommissionPercent } from './feeCalculationService.js';

const DEFAULT_COMMISSION_MODE = 'rFBS';
const DEFAULT_COMMISSION_SOURCE = 'ozon:/v5/product/info/prices';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

export function getCommissionRateDateKey(value = new Date()) {
  if (typeof value === 'string') {
    const exact = value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (exact) {
      return `${exact[1]}-${padDatePart(exact[2])}-${padDatePart(exact[3])}`;
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function toReadAt(value = new Date()) {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toISOString();
}

function normalizeCommissionMode(value = DEFAULT_COMMISSION_MODE) {
  const text = String(value || '').trim();
  return text || DEFAULT_COMMISSION_MODE;
}

function getRateFromHistoryEntry(entry) {
  if (!isPlainObject(entry)) return normalizeEstimatedCommissionPercent(entry);
  return normalizeEstimatedCommissionPercent(entry.rate ?? entry.percent ?? entry.commissionPercent);
}

export function normalizeCommissionRateHistory(value = {}) {
  if (!isPlainObject(value)) return {};
  const history = {};

  for (const [rawDateKey, rawEntry] of Object.entries(value)) {
    const dateKey = getCommissionRateDateKey(rawDateKey);
    const rate = getRateFromHistoryEntry(rawEntry);
    if (!dateKey || rate === null) continue;

    const entry = isPlainObject(rawEntry) ? rawEntry : {};
    history[dateKey] = {
      rate,
      percent: rate,
      mode: normalizeCommissionMode(entry.mode),
      source: String(entry.source || DEFAULT_COMMISSION_SOURCE),
      readAt: String(entry.readAt || entry.updatedAt || entry.verifiedAt || dateKey),
    };
  }

  return history;
}

export function upsertDailyCommissionRateSnapshot(history = {}, options = {}) {
  const rate = normalizeEstimatedCommissionPercent(options.rate ?? options.percent ?? options.commissionPercent);
  const dateKey = getCommissionRateDateKey(options.readAt || new Date());
  const normalized = normalizeCommissionRateHistory(history);
  if (rate === null || !dateKey) return normalized;

  return {
    ...normalized,
    [dateKey]: {
      rate,
      percent: rate,
      mode: normalizeCommissionMode(options.mode),
      source: String(options.source || DEFAULT_COMMISSION_SOURCE),
      readAt: toReadAt(options.readAt || new Date()),
    },
  };
}

export function selectCommissionRateSnapshot(history = {}, preferredDateKey = '', preferredMode = '') {
  const normalized = normalizeCommissionRateHistory(history);
  const normalizedPreferredMode = preferredMode ? normalizeCommissionMode(preferredMode).toLowerCase() : '';
  const dateKeys = Object.keys(normalized)
    .filter((dateKey) => {
      if (!normalizedPreferredMode) return true;
      return normalizeCommissionMode(normalized[dateKey]?.mode).toLowerCase() === normalizedPreferredMode;
    })
    .sort();
  if (!dateKeys.length) return null;

  const targetDateKey = getCommissionRateDateKey(preferredDateKey);
  if (targetDateKey && dateKeys.includes(targetDateKey)) {
    return { dateKey: targetDateKey, ...normalized[targetDateKey] };
  }

  if (targetDateKey) {
    const closestPastDateKey = dateKeys.filter((dateKey) => dateKey <= targetDateKey).at(-1);
    if (closestPastDateKey) return { dateKey: closestPastDateKey, ...normalized[closestPastDateKey] };
    const earliestDateKey = dateKeys[0];
    return { dateKey: earliestDateKey, ...normalized[earliestDateKey] };
  }

  const latestDateKey = dateKeys.at(-1);
  return { dateKey: latestDateKey, ...normalized[latestDateKey] };
}

export function resolveDailyCommissionRateSnapshot(history = {}, options = {}) {
  const withFreshRate = upsertDailyCommissionRateSnapshot(history, {
    rate: options.fallbackRate ?? options.fallbackPercent ?? options.rate,
    mode: options.mode,
    source: options.source,
    readAt: options.readAt,
  });

  const lockedDateKey = getCommissionRateDateKey(options.lockedDateKey);
  const normalizedMode = normalizeCommissionMode(options.mode);
  const lockedSnapshot = withFreshRate[lockedDateKey];
  if (
    lockedDateKey &&
    lockedSnapshot &&
    normalizeCommissionMode(lockedSnapshot.mode).toLowerCase() === normalizedMode.toLowerCase()
  ) {
    return {
      history: withFreshRate,
      dateKey: lockedDateKey,
      locked: true,
      ...lockedSnapshot,
    };
  }

  const orderSnapshot = selectCommissionRateSnapshot(withFreshRate, options.orderDateKey, normalizedMode);
  if (orderSnapshot) {
    return {
      history: withFreshRate,
      locked: false,
      ...orderSnapshot,
    };
  }

  return {
    history: withFreshRate,
    dateKey: '',
    rate: null,
    percent: null,
    mode: normalizedMode,
    source: String(options.source || DEFAULT_COMMISSION_SOURCE),
    readAt: '',
    locked: false,
  };
}

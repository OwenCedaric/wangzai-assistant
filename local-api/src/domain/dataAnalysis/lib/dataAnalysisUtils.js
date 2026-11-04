export function normalizeText(value, fallback = '') {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

export function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const number = Number(value.replace(/[^0-9.-]/gu, ''));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export function roundNumber(value, digits = 2) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

export function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

export function toDateKey(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const directMatch = text.match(/^(\d{4}-\d{2}-\d{2})/u);
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text);
  if (directMatch && !hasExplicitTimezone) return directMatch[1];
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  const parts = shanghaiDateFormatter.formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year && byType.month && byType.day
    ? `${byType.year}-${byType.month}-${byType.day}`
    : date.toISOString().slice(0, 10);
}

export function normalizeDateRange(input = {}) {
  const endDate = toDateKey(input.endDate || input.dateTo || input.end_date) || new Date().toISOString().slice(0, 10);
  const requestedStart = toDateKey(input.startDate || input.dateFrom || input.start_date);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const fallbackStart = new Date(end);
  fallbackStart.setUTCDate(fallbackStart.getUTCDate() - 29);
  let startDate = requestedStart || fallbackStart.toISOString().slice(0, 10);
  if (startDate > endDate) startDate = endDate;
  return { startDate, endDate };
}

export function createPreviousRange(range = {}) {
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T00:00:00.000Z`);
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.max(1, Math.floor((end.getTime() - start.getTime()) / dayMs) + 1);
  const previousEnd = new Date(start.getTime() - dayMs);
  const previousStart = new Date(previousEnd.getTime() - (days - 1) * dayMs);
  return {
    startDate: previousStart.toISOString().slice(0, 10),
    endDate: previousEnd.toISOString().slice(0, 10),
  };
}

export function isDateInRange(value, range = {}) {
  const dateKey = toDateKey(value);
  if (!dateKey) return false;
  return (!range.startDate || dateKey >= range.startDate) && (!range.endDate || dateKey <= range.endDate);
}

export function filterRowsByDate(rows = [], range = {}, getDate = (row) => row?.date) {
  return (Array.isArray(rows) ? rows : []).filter((row) => isDateInRange(getDate(row), range));
}

export function calculatePercent(numerator, denominator) {
  const left = toFiniteNumber(numerator);
  const right = toFiniteNumber(denominator);
  if (left === null || right === null || right === 0) return null;
  return roundNumber((left / right) * 100, 2);
}

export function calculateDelta(current, previous) {
  const currentValue = toFiniteNumber(current);
  const previousValue = toFiniteNumber(previous);
  if (currentValue === null || previousValue === null) {
    return { value: null, percent: null, status: 'unavailable' };
  }
  const value = roundNumber(currentValue - previousValue, 2);
  if (previousValue === 0) {
    return {
      value,
      percent: currentValue === 0 ? 0 : null,
      status: currentValue === 0 ? 'confirmed' : 'no_comparable_base',
    };
  }
  return {
    value,
    percent: roundNumber(((currentValue - previousValue) / Math.abs(previousValue)) * 100, 2),
    status: 'confirmed',
  };
}

export function sumValues(rows = [], getter = (row) => row) {
  return (Array.isArray(rows) ? rows : []).reduce((total, row) => {
    const value = toFiniteNumber(getter(row));
    return value === null ? total : total + value;
  }, 0);
}

export function countBy(rows = [], getter = (row) => row) {
  const counts = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const key = normalizeText(getter(row), '未返回');
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key, 'zh-CN'));
}

export function createMoneyAccumulator() {
  return new Map();
}

export function addMoney(accumulator, amount, currencyCode = '') {
  const value = toFiniteNumber(amount);
  if (!(accumulator instanceof Map) || value === null) return;
  const currency = normalizeText(currencyCode, 'UNKNOWN').toUpperCase();
  accumulator.set(currency, (accumulator.get(currency) || 0) + value);
}

export function toMoneyBreakdown(accumulator) {
  const breakdown = [...(accumulator instanceof Map ? accumulator.entries() : [])]
    .map(([currency, value]) => ({ currency, value: roundNumber(value, 2) || 0 }))
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value));
  const confirmed = breakdown.filter((item) => item.currency !== 'UNKNOWN');
  return {
    value: breakdown.length === 1 ? breakdown[0].value : null,
    currency: breakdown.length === 1 ? breakdown[0].currency : breakdown.length ? 'MIXED' : '',
    breakdown,
    status: !breakdown.length
      ? 'empty'
      : breakdown.some((item) => item.currency === 'UNKNOWN')
        ? 'currency_unconfirmed'
        : confirmed.length > 1
          ? 'mixed_currency'
          : 'confirmed',
  };
}

export function createMetric({
  id,
  label,
  value = null,
  unit = 'count',
  currency = '',
  status = 'confirmed',
  sourceId,
  sourceLabel,
  sourceType = 'derived',
  syncedAt = null,
  comparisonValue = null,
  delta = null,
  detail = '',
  breakdown = [],
  isEstimated = false,
} = {}) {
  return {
    id: normalizeText(id),
    label: normalizeText(label),
    value: toFiniteNumber(value),
    unit,
    currency: normalizeText(currency),
    status,
    source: {
      id: normalizeText(sourceId),
      label: normalizeText(sourceLabel),
      type: sourceType,
      syncedAt: syncedAt || null,
    },
    comparisonValue: toFiniteNumber(comparisonValue),
    delta: delta || calculateDelta(value, comparisonValue),
    detail: normalizeText(detail),
    breakdown: Array.isArray(breakdown) ? breakdown : [],
    isEstimated: Boolean(isEstimated),
  };
}

export function safeRatioMetric(input = {}) {
  const value = calculatePercent(input.numerator, input.denominator);
  return createMetric({
    ...input,
    value,
    unit: 'percent',
    status: value === null ? input.emptyStatus || 'unavailable' : input.status || 'confirmed',
  });
}

export function latestTimestamp(rows = [], fields = ['updated_at']) {
  let latest = '';
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    fields.forEach((field) => {
      const value = normalizeText(row?.[field]);
      if (value && (!latest || value > latest)) latest = value;
    });
  });
  return latest || null;
}

export function buildDailyKeys(range = {}, maxDays = 93) {
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T00:00:00.000Z`);
  const dayMs = 24 * 60 * 60 * 1000;
  const count = Math.floor((end.getTime() - start.getTime()) / dayMs) + 1;
  if (!Number.isFinite(count) || count <= 0 || count > maxDays) return [];
  return Array.from({ length: count }, (_, index) => new Date(start.getTime() + index * dayMs).toISOString().slice(0, 10));
}
const shanghaiDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

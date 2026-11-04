export function normalizeOzonMetricText(value) {
  return String(value ?? '').trim();
}

export function parseOzonProductMetric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const source = normalizeOzonMetricText(value)
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/[^0-9,.-]/g, '');
  if (!source || source === '-' || source === '.' || source === ',') return null;

  const commaIndex = source.lastIndexOf(',');
  const dotIndex = source.lastIndexOf('.');
  let normalized = source;
  if (commaIndex >= 0 && dotIndex >= 0) {
    const decimalSeparator = commaIndex > dotIndex ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? /\./g : /,/g;
    normalized = source.replace(groupingSeparator, '');
    if (decimalSeparator === ',') normalized = normalized.replace(',', '.');
  } else if (commaIndex >= 0) {
    normalized = source.replace(',', '.');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function ozonMetricValues(records = [], key = '', allowNegative = false) {
  return (Array.isArray(records) ? records : [])
    .map((record) => parseOzonProductMetric(record?.[key]))
    .filter((value) => value !== null && (allowNegative || value >= 0));
}

export function averageOzonMetrics(values = []) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

export function medianOzonMetrics(values = []) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function sumOzonMetrics(values = []) {
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

export function clampOzonMetric(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function roundOzonMetric(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** Math.max(0, digits);
  return Math.round(value * factor) / factor;
}

export function percentageOzonMetric(part, total, digits = 0) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return roundOzonMetric((part / total) * 100, digits);
}

export function pearsonOzonMetricPairs(pairs = []) {
  const valid = pairs.filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right));
  if (valid.length < 3) return null;
  const leftAverage = averageOzonMetrics(valid.map(([left]) => left));
  const rightAverage = averageOzonMetrics(valid.map(([, right]) => right));
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  valid.forEach(([left, right]) => {
    const leftDelta = left - leftAverage;
    const rightDelta = right - rightAverage;
    numerator += leftDelta * rightDelta;
    leftSquare += leftDelta ** 2;
    rightSquare += rightDelta ** 2;
  });
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator > 0 ? numerator / denominator : null;
}

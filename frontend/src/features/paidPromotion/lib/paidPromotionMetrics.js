function isMissingMetricValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function toFiniteMetricNumber(value) {
  if (isMissingMetricValue(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  let text = String(value)
    .replace(/[\u00a0\u202f\s]+/gu, '')
    .replace(/[%¥₽$€£]/gu, '')
    .replace(/(?:руб(?:\.|ля|лей)?|rur|rub)/giu, '')
    .trim();
  if (!text) return null;
  if (text.includes(',') && text.includes('.')) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./gu, '').replace(',', '.');
    } else {
      text = text.replace(/,/gu, '');
    }
  } else if (text.includes(',')) {
    text = text.replace(',', '.');
  }
  if (!/^[+]?\d+(?:\.\d+)?$/u.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readMetricValue(record = {}, key) {
  const statistics = record?.statistics;
  if (statistics && Object.prototype.hasOwnProperty.call(statistics, key)) return statistics[key];
  return record?.[key];
}

function valueResult(value, source = 'returned') {
  return { value, state: 'value', source };
}

function unavailableResult(state, source = 'calculated') {
  return { value: null, state, source };
}

function roundMetric(value) {
  // Preserve calculation precision internally. The UI formatter is the only
  // layer allowed to round to two decimals, so RUB -> CNY conversion never
  // starts from an already rounded CPC/ratio.
  return Number(value.toFixed(6));
}

/**
 * Ozon Performance does not consistently return CTR/CPC/ACOS/ROAS on every
 * campaign type. Resolve them from the returned base facts first so every
 * screen uses the same business formula. A zero denominator is a real
 * business state, not a missing API field.
 */
export function resolvePaidPromotionMetric(record = {}, key = '') {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const directValue = toFiniteMetricNumber(readMetricValue(record, normalizedKey));

  if (normalizedKey === 'ctr') {
    const impressions = toFiniteMetricNumber(readMetricValue(record, 'impressions'));
    const clicks = toFiniteMetricNumber(readMetricValue(record, 'clicks'));
    if (impressions !== null && clicks !== null) {
      if (impressions > 0) return valueResult(roundMetric((clicks / impressions) * 100), 'calculated');
      return unavailableResult('no-impressions');
    }
  }

  if (normalizedKey === 'cpc') {
    const spent = toFiniteMetricNumber(readMetricValue(record, 'spent'));
    const clicks = toFiniteMetricNumber(readMetricValue(record, 'clicks'));
    if (spent !== null && clicks !== null) {
      if (clicks > 0) return valueResult(roundMetric(spent / clicks), 'calculated');
      return unavailableResult('no-clicks');
    }
  }

  if (normalizedKey === 'acos') {
    const spent = toFiniteMetricNumber(readMetricValue(record, 'spent'));
    const revenue = toFiniteMetricNumber(readMetricValue(record, 'revenue'));
    if (spent !== null && revenue !== null) {
      if (revenue > 0) return valueResult(roundMetric((spent / revenue) * 100), 'calculated');
      return unavailableResult('no-sales');
    }
  }

  if (normalizedKey === 'roas' || normalizedKey === 'roi') {
    const spent = toFiniteMetricNumber(readMetricValue(record, 'spent'));
    const revenue = toFiniteMetricNumber(readMetricValue(record, 'revenue'));
    if (spent !== null && revenue !== null) {
      if (spent > 0) return valueResult(roundMetric(revenue / spent), 'calculated');
      return unavailableResult('no-spend');
    }
    const alternateKey = normalizedKey === 'roi' ? 'roas' : 'roi';
    const alternateValue = toFiniteMetricNumber(readMetricValue(record, alternateKey));
    if (directValue === null && alternateValue !== null) return valueResult(alternateValue);
  }

  return directValue === null ? unavailableResult('missing', 'unavailable') : valueResult(directValue);
}

export function getPaidPromotionMetricStateLabel(state = '') {
  if (state === 'no-impressions') return '暂无展示';
  if (state === 'no-clicks') return '暂无点击';
  if (state === 'no-sales') return '暂无成交';
  if (state === 'no-spend') return '暂无花费';
  return '';
}

export function getPaidPromotionMetricValue(record = {}, key = '') {
  return resolvePaidPromotionMetric(record, key).value;
}

const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;

function text(value) {
  return String(value ?? '').trim();
}

function isoDay(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : text(value);
}

/** Continuous sync refreshes mutable current-day data, but its cache identity must not
 * include the wall-clock milliseconds from every 15-minute run. */
export function isContinuousFinanceSync(input = {}) {
  const mode = text(input.syncMode ?? input.sync_mode).toLowerCase();
  return mode === 'steady' || mode === 'bootstrap';
}

export function financeRangeScope({ from, to, continuous = false } = {}) {
  return continuous ? `${isoDay(from)}:${isoDay(to)}` : `${text(from)}:${text(to)}`;
}

export function buildFinanceRunScopeKey({ from, to, continuous = false } = {}) {
  return `finance:${financeRangeScope({ from, to, continuous })}`;
}

export function buildFinanceTransactionCacheKey({
  shopId,
  postingNumber,
  from,
  to,
  page,
  continuous = false,
} = {}) {
  return [
    'finance',
    'transaction-list',
    text(shopId),
    text(postingNumber) || 'all',
    financeRangeScope({ from, to, continuous }),
    `page:${Math.max(1, Number(page) || 1)}`,
  ].join(':');
}

export function buildFinanceJobCacheKey({ shopId, from, to, continuous = false } = {}) {
  return ['finance', text(shopId), financeRangeScope({ from, to, continuous })].join(':');
}

/** Maps the historical wall-clock cache keys to the canonical day-window identity.
 * It intentionally leaves non-timestamp keys alone, so unrelated cache contracts cannot
 * be compacted by the finance maintenance path. */
export function normalizeLegacyFinanceScopeKey(value) {
  const key = text(value);
  if (!key.startsWith('finance:') || !ISO_TIMESTAMP_PATTERN.test(key)) return key;
  ISO_TIMESTAMP_PATTERN.lastIndex = 0;
  return key.replace(ISO_TIMESTAMP_PATTERN, (timestamp) => isoDay(timestamp));
}

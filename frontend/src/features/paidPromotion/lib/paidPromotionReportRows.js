function normalizeText(value) {
  return String(value ?? '').trim();
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
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

export function normalizePromotionMetricNumber(value) {
  return toOptionalNumber(value);
}

function roundMetric(value) {
  return Number(value.toFixed(2));
}

function firstOptionalNumber(...values) {
  for (const value of values) {
    const number = toOptionalNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function deriveRate(numerator, denominator, multiplier = 1) {
  const normalizedNumerator = toOptionalNumber(numerator);
  const normalizedDenominator = toOptionalNumber(denominator);
  if (normalizedNumerator === null || normalizedDenominator === null || normalizedDenominator <= 0) return null;
  return roundMetric((normalizedNumerator / normalizedDenominator) * multiplier);
}

function shiftIsoDate(dateText, days) {
  const timestamp = Date.parse(`${normalizeText(dateText)}T12:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getPromotionRowDate(row = {}) {
  return normalizeText(
    row.date ||
      row.orderDate ||
      row.order_date ||
      row.createdAt ||
      row.created_at ||
      row.updatedAt ||
      row.updated_at ||
      row.periodFrom ||
      row.period_from
  );
}

export function sortPromotionRowsNewestFirst(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, index, date: getPromotionRowDate(row) }))
    .sort((left, right) => {
      if (left.date && right.date) {
        const byDate = right.date.localeCompare(left.date);
        if (byDate) return byDate;
      } else if (left.date || right.date) {
        return left.date ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}

export function buildCompletePromotionDailyTrend(rows = [], dateFrom = '', dateTo = '') {
  const normalizedRows = new Map(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => normalizeText(row?.date))
      .map((row) => [normalizeText(row.date), { ...row, availabilityState: 'returned' }])
  );
  const start = normalizeText(dateFrom);
  const end = normalizeText(dateTo);
  if (!start || !end || start > end || !shiftIsoDate(start, 0) || !shiftIsoDate(end, 0)) {
    return [...normalizedRows.values()].sort((left, right) => right.date.localeCompare(left.date));
  }
  const result = [];
  let cursor = start;
  for (let guard = 0; cursor && cursor <= end && guard < 3700; guard += 1) {
    result.push(
      normalizedRows.get(cursor) || {
        date: cursor,
        impressions: null,
        clicks: null,
        spent: null,
        orders: null,
        revenue: null,
        ctr: null,
        cpc: null,
        acos: null,
        roas: null,
        availabilityState: 'no-record',
      }
    );
    cursor = shiftIsoDate(cursor, 1);
  }
  return result.reverse();
}

export function aggregatePromotionMetricRows(rows = []) {
  const metricKeys = ['impressions', 'clicks', 'spent', 'orders', 'revenue', 'bonusSpent', 'prepaymentSpent'];
  const totals = Object.fromEntries(metricKeys.map((key) => [key, null]));
  let returnedRowCount = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const rowHasMetric = metricKeys.some((key) => toOptionalNumber(row?.[key]) !== null);
    if (rowHasMetric) returnedRowCount += 1;
    for (const key of metricKeys) {
      const value = toOptionalNumber(row?.[key]);
      if (value === null) continue;
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return {
    ...totals,
    ctr: deriveRate(totals.clicks, totals.impressions, 100),
    cpc: deriveRate(totals.spent, totals.clicks),
    acos: deriveRate(totals.spent, totals.revenue, 100),
    roas: deriveRate(totals.revenue, totals.spent),
    rowCount: Array.isArray(rows) ? rows.length : 0,
    returnedRowCount,
  };
}

function getCampaignDateKey(row = {}) {
  const campaignId = normalizeText(row.campaignId || row.campaign_id);
  const date = normalizeText(row.date || row.day || row.dateFrom || row.date_from);
  return campaignId && date ? `${campaignId}:${date}` : '';
}

/**
 * Expense statistics is the authoritative source for the money split, while
 * daily statistics owns traffic and conversion facts. Ozon returns those in
 * separate datasets, so join only on the exact campaign + date scope. Never
 * fall back to titles or to another campaign's totals.
 */
export function mergePromotionExpenseRows(expenseRows = [], dailyRows = []) {
  const dailyRowsByKey = new Map();
  for (const row of Array.isArray(dailyRows) ? dailyRows : []) {
    const key = getCampaignDateKey(row);
    if (!key) continue;
    const rows = dailyRowsByKey.get(key) || [];
    rows.push(row);
    dailyRowsByKey.set(key, rows);
  }

  const merged = (Array.isArray(expenseRows) ? expenseRows : []).map((expenseRow) => {
    const exactDailyRows = dailyRowsByKey.get(getCampaignDateKey(expenseRow)) || [];
    const dailySummary = aggregatePromotionMetricRows(exactDailyRows);
    const dailyIdentity = exactDailyRows[0] || {};
    const impressions = firstOptionalNumber(expenseRow.impressions, dailySummary.impressions);
    const clicks = firstOptionalNumber(expenseRow.clicks, dailySummary.clicks);
    const spent = firstOptionalNumber(expenseRow.spent, dailySummary.spent);
    const orders = firstOptionalNumber(expenseRow.orders, dailySummary.orders);
    const revenue = firstOptionalNumber(expenseRow.revenue, dailySummary.revenue);
    return {
      ...dailyIdentity,
      ...expenseRow,
      campaignId: normalizeText(expenseRow.campaignId) || normalizeText(dailyIdentity.campaignId),
      campaignTitle: normalizeText(expenseRow.campaignTitle) || normalizeText(dailyIdentity.campaignTitle),
      date: normalizeText(expenseRow.date) || normalizeText(dailyIdentity.date),
      impressions,
      clicks,
      spent,
      orders,
      revenue,
      ctr: deriveRate(clicks, impressions, 100) ?? firstOptionalNumber(expenseRow.ctr, dailySummary.ctr),
      cpc: deriveRate(spent, clicks) ?? firstOptionalNumber(expenseRow.cpc, dailySummary.cpc),
      acos: deriveRate(spent, revenue, 100) ?? firstOptionalNumber(expenseRow.acos, dailySummary.acos),
      roas: deriveRate(revenue, spent) ?? firstOptionalNumber(expenseRow.roas, dailySummary.roas),
      statisticsJoined: exactDailyRows.length > 0,
    };
  });

  return sortPromotionRowsNewestFirst(merged);
}

export function getPromotionDataSetAvailability(dataSet = null) {
  const status = normalizeText(dataSet?.status).toLowerCase();
  if (status === 'success') return { status, tone: 'success', label: '已完整返回' };
  if (status === 'empty') return { status, tone: 'empty', label: '接口明确无记录' };
  if (status === 'partial') return { status, tone: 'warning', label: '部分数据已返回' };
  if (status === 'failed') return { status, tone: 'error', label: '读取失败' };
  if (status === 'unavailable') return { status, tone: 'empty', label: '当前接口不提供' };
  if (status === 'skipped') return { status, tone: 'muted', label: '尚未读取' };
  return { status: 'unknown', tone: 'muted', label: '状态未返回' };
}

export function getPromotionDataSetsAvailability(dataSets = []) {
  const statuses = (Array.isArray(dataSets) ? dataSets : [])
    .map((dataSet) => normalizeText(dataSet?.status).toLowerCase())
    .filter(Boolean);
  if (!statuses.length) return getPromotionDataSetAvailability(null);
  if (statuses.includes('partial')) return getPromotionDataSetAvailability({ status: 'partial' });
  const hasReturnedSource = statuses.some((status) => status === 'success' || status === 'empty');
  if (statuses.includes('failed') && hasReturnedSource) {
    return getPromotionDataSetAvailability({ status: 'partial' });
  }
  if (statuses.includes('success')) return getPromotionDataSetAvailability({ status: 'success' });
  if (statuses.includes('failed')) return getPromotionDataSetAvailability({ status: 'failed' });
  if (statuses.includes('empty')) return getPromotionDataSetAvailability({ status: 'empty' });
  if (statuses.includes('unavailable')) return getPromotionDataSetAvailability({ status: 'unavailable' });
  if (statuses.every((status) => status === 'skipped')) {
    return getPromotionDataSetAvailability({ status: 'skipped' });
  }
  return getPromotionDataSetAvailability({ status: statuses[0] });
}

export function getPromotionScopedDataAvailability(
  availability = null,
  rows = [],
  metricKeys = ['impressions', 'clicks', 'spent', 'orders', 'revenue'],
  { requireAllMetrics = false } = {}
) {
  const base = availability?.status ? availability : getPromotionDataSetAvailability(availability);
  if (!['success', 'partial'].includes(base.status)) return base;
  const scopedRows = Array.isArray(rows) ? rows : [];
  if (!scopedRows.length) {
    return { status: 'empty', tone: 'empty', label: '当前范围无记录' };
  }
  const returnedMetricRows = scopedRows.filter((row) => {
    const isReturned = (key) => toOptionalNumber(row?.[key]) !== null;
    return requireAllMetrics ? metricKeys.every(isReturned) : metricKeys.some(isReturned);
  });
  if (!returnedMetricRows.length) {
    return { status: 'empty', tone: 'empty', label: '当前范围无统计记录' };
  }
  if (returnedMetricRows.length < scopedRows.length || base.status === 'partial') {
    return { status: 'partial', tone: 'warning', label: '部分统计已返回' };
  }
  return base;
}

export function getPromotionBidDisplayState(product = {}, key = '') {
  const value = toOptionalNumber(product?.[key]);
  if (value !== null) return { state: 'value', value, label: '' };
  const availabilityKey = {
    recommendedBid: 'recommended',
    competitiveBid: 'competitive',
    minCpoBid: 'minCpo',
    minimumCpcBid: 'minimumCpc',
  }[key] || '';
  const availability = product?.bidAvailability?.[availabilityKey] || {};
  if (availability.status === 'empty') return { state: 'empty', value: null, label: '暂无建议' };
  if (availability.status === 'failed') return { state: 'failed', value: null, label: '读取失败' };
  if (availability.status === 'unavailable') return { state: 'unavailable', value: null, label: '接口不提供' };
  if (availability.status === 'skipped') return { state: 'skipped', value: null, label: '不适用' };
  return { state: 'missing', value: null, label: '未读取' };
}

import {
  calculateDelta,
  calculatePercent,
  createMetric,
  latestTimestamp,
  normalizeText,
  parseJson,
  roundNumber,
  toDateKey,
  toFiniteNumber,
} from '../lib/dataAnalysisUtils.js';

function sum(rows = [], field) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  let knownCount = 0;
  const value = sourceRows.reduce((total, row) => {
    const current = toFiniteNumber(row?.[field]);
    if (current === null) return total;
    knownCount += 1;
    return total + current;
  }, 0);
  return {
    value: knownCount ? value : null,
    knownCount,
    totalCount: sourceRows.length,
    status: !knownCount ? 'not_returned' : knownCount === sourceRows.length ? 'confirmed' : 'partial',
  };
}

function createTrafficMetric({
  id,
  label,
  value,
  comparisonValue,
  unit = 'count',
  currency = '',
  detail,
  sourceSyncedAt,
  sourceId = 'analytics',
  sourceLabel = '平台官方流量快照',
  sourceType = 'official-cache',
  status,
  comparisonComparable = true,
}) {
  const available = value !== null && value !== undefined;
  const metric = createMetric({
    id,
    label,
    value: available ? value : null,
    unit,
    currency,
    status: status || (available ? 'confirmed' : 'not_returned'),
    sourceId,
    sourceLabel,
    sourceType,
    syncedAt: sourceSyncedAt,
    comparisonValue: comparisonComparable ? comparisonValue : null,
    delta: available && comparisonComparable ? calculateDelta(value, comparisonValue) : null,
    detail,
  });
  return comparisonComparable ? metric : { ...metric, comparisonValue: null, delta: null };
}

function getDateKey(row = {}) {
  return String(row?.report_date || row?.date || '').slice(0, 10);
}

function getDateWindow(rows = []) {
  const dates = [...new Set((Array.isArray(rows) ? rows : []).map(getDateKey).filter(Boolean))].sort();
  if (!dates.length) return null;
  const startMs = Date.parse(`${dates[0]}T00:00:00Z`);
  const endMs = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`);
  const calendarDayCount = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.round((endMs - startMs) / 86400000) + 1
    : dates.length;
  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    dayCount: dates.length,
    continuous: calendarDayCount === dates.length,
  };
}

function getTrafficCurrency(row = {}) {
  const raw = parseJson(row.raw_metrics_json ?? row.rawMetricsJson, {});
  return normalizeText(
    row.currency_code || row.currencyCode || raw.sourceCurrency || raw.source_currency
  ).toUpperCase();
}

function summarizeTrafficCurrency(rows = []) {
  const currencies = [...new Set((Array.isArray(rows) ? rows : []).map(getTrafficCurrency).filter(Boolean))];
  return {
    currency: currencies.length === 1 ? currencies[0] : currencies.length ? 'MIXED' : '',
    status: !currencies.length ? 'currency_unconfirmed' : currencies.length === 1 ? 'confirmed' : 'mixed_currency',
    currencies,
  };
}

function combineCoverageStatus(...fields) {
  if (fields.some((field) => field?.status === 'not_returned')) return 'not_returned';
  if (fields.some((field) => field?.status === 'partial')) return 'partial';
  return fields.length ? 'confirmed' : 'not_returned';
}

function getOrderDate(row = {}) {
  return toDateKey(row?.in_process_at || row?.created_at);
}

function isCancelledOrder(row = {}) {
  return String(row?.status || '').trim().toLowerCase() === 'cancelled';
}

function filterOrdersToDateWindow(rows = [], window = null) {
  if (!window?.startDate || !window?.endDate) return [];
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const date = getOrderDate(row);
    return date && date >= window.startDate && date <= window.endDate;
  });
}

function buildDailyTrend(rows = [], matchedOrderCountByDate = new Map()) {
  const fields = Object.freeze([
    ['visitorSessions', 'visitor_sessions'],
    ['productViews', 'product_views'],
    ['cartAdds', 'cart_adds'],
    ['orderedUnits', 'ordered_units'],
    ['revenueRub', 'revenue_rub'],
  ]);
  const groups = new Map();

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const date = getDateKey(row);
    if (!date) return;
    const group = groups.get(date) || {
      date,
      values: new Map(),
      revenueCurrencies: new Set(),
    };
    fields.forEach(([targetField, sourceField]) => {
      const value = toFiniteNumber(row[sourceField] ?? row[targetField]);
      if (value === null) return;
      const current = group.values.get(targetField) || { value: 0, returnedRows: 0 };
      current.value += value;
      current.returnedRows += 1;
      group.values.set(targetField, current);
    });
    const currency = getTrafficCurrency(row);
    if (currency) group.revenueCurrencies.add(currency);
    groups.set(date, group);
  });

  return [...groups.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((group) => {
      const value = (field) => group.values.get(field)?.value ?? null;
      const currencies = [...group.revenueCurrencies];
      return {
        date: group.date,
        visitorSessions: value('visitorSessions'),
        productViews: value('productViews'),
        cartAdds: value('cartAdds'),
        orderedUnits: value('orderedUnits'),
        matchedOrderCount: matchedOrderCountByDate.get(group.date) || 0,
        revenueRub: value('revenueRub'),
        revenueCurrency: currencies.length === 1 ? currencies[0] : currencies.length ? 'MIXED' : null,
      };
    });
}

export function calculateTrafficAnalysis({ rows = [], comparisonRows = [], orderRows = [], comparisonOrderRows = [] } = {}) {
  const currentRows = Array.isArray(rows) ? rows : [];
  const previousRows = Array.isArray(comparisonRows) ? comparisonRows : [];
  const currentWindow = getDateWindow(currentRows);
  const previousWindow = getDateWindow(previousRows);
  const scopedOrderRows = filterOrdersToDateWindow(orderRows, currentWindow).filter((row) => !isCancelledOrder(row));
  const scopedPreviousOrderRows = filterOrdersToDateWindow(comparisonOrderRows, previousWindow).filter(
    (row) => !isCancelledOrder(row)
  );
  const orderCountByDate = new Map();
  const previousOrderCountByDate = new Map();
  scopedOrderRows.forEach((row) => {
    const date = getOrderDate(row);
    if (date) orderCountByDate.set(date, (orderCountByDate.get(date) || 0) + 1);
  });
  scopedPreviousOrderRows.forEach((row) => {
    const date = getOrderDate(row);
    if (date) previousOrderCountByDate.set(date, (previousOrderCountByDate.get(date) || 0) + 1);
  });
  const sourceSyncedAt = latestTimestamp([...currentRows, ...previousRows], ['updated_at', 'last_seen_at']);
  const orderSourceSyncedAt = latestTimestamp([...scopedOrderRows, ...scopedPreviousOrderRows], ['updated_at', 'last_seen_at']);
  const current = {
    visitorSessions: sum(currentRows, 'visitor_sessions'),
    productViews: sum(currentRows, 'product_views'),
    cartAdds: sum(currentRows, 'cart_adds'),
    orderedUnits: sum(currentRows, 'ordered_units'),
    revenueRub: sum(currentRows, 'revenue_rub'),
    matchedOrderCount: scopedOrderRows.length,
  };
  const previous = {
    visitorSessions: sum(previousRows, 'visitor_sessions'),
    productViews: sum(previousRows, 'product_views'),
    cartAdds: sum(previousRows, 'cart_adds'),
    orderedUnits: sum(previousRows, 'ordered_units'),
    revenueRub: sum(previousRows, 'revenue_rub'),
    matchedOrderCount: scopedPreviousOrderRows.length,
  };
  const hasRows = currentRows.length > 0;
  const currentCurrency = summarizeTrafficCurrency(currentRows);
  const previousCurrency = summarizeTrafficCurrency(previousRows);
  const comparisonComparable = Boolean(
    currentWindow?.dayCount &&
      previousWindow?.dayCount &&
      currentWindow.continuous &&
      previousWindow.continuous &&
      currentWindow.dayCount === previousWindow.dayCount
  );
  const cartConversionStatus = combineCoverageStatus(current.cartAdds, current.visitorSessions);
  const orderConversionStatus = combineCoverageStatus(current.orderedUnits, current.visitorSessions);
  const previousCartConversionStatus = combineCoverageStatus(previous.cartAdds, previous.visitorSessions);
  const previousOrderConversionStatus = combineCoverageStatus(previous.orderedUnits, previous.visitorSessions);
  const cartConversion = hasRows ? calculatePercent(current.cartAdds.value, current.visitorSessions.value) : null;
  const previousCartConversion = previousRows.length
    ? calculatePercent(previous.cartAdds.value, previous.visitorSessions.value)
    : null;
  const orderConversion = hasRows ? calculatePercent(current.orderedUnits.value, current.visitorSessions.value) : null;
  const previousOrderConversion = previousRows.length
    ? calculatePercent(previous.orderedUnits.value, previous.visitorSessions.value)
    : null;

  return {
    sourceSyncedAt,
    metrics: [
      createTrafficMetric({
        id: 'trafficSessionCount',
        label: '访问次数',
        value: hasRows ? current.visitorSessions.value : null,
        comparisonValue: previous.visitorSessions.value,
        status: current.visitorSessions.status,
        comparisonComparable:
          comparisonComparable && current.visitorSessions.status === 'confirmed' && previous.visitorSessions.status === 'confirmed',
        detail: '平台官方分析接口返回的访问会话数。',
        sourceSyncedAt,
      }),
      createTrafficMetric({
        id: 'trafficProductViewCount',
        label: '商品浏览',
        value: hasRows ? current.productViews.value : null,
        comparisonValue: previous.productViews.value,
        status: current.productViews.status,
        comparisonComparable:
          comparisonComparable && current.productViews.status === 'confirmed' && previous.productViews.status === 'confirmed',
        detail: '平台官方分析接口返回的商品浏览次数。',
        sourceSyncedAt,
      }),
      createTrafficMetric({
        id: 'trafficCartAddCount',
        label: '加购次数',
        value: hasRows ? current.cartAdds.value : null,
        comparisonValue: previous.cartAdds.value,
        status: current.cartAdds.status,
        comparisonComparable:
          comparisonComparable && current.cartAdds.status === 'confirmed' && previous.cartAdds.status === 'confirmed',
        detail: '平台官方分析接口返回的加入购物车次数。',
        sourceSyncedAt,
      }),
      createTrafficMetric({
        id: 'trafficCartConversionRate',
        label: '访问至加购次数比',
        value: cartConversion,
        comparisonValue: previousCartConversion,
        unit: 'percent',
        status: cartConversionStatus,
        detail: '官方加购次数 ÷ 官方访问会话数；按次数计算，不等同买家转化率。',
        sourceSyncedAt,
        comparisonComparable:
          comparisonComparable && cartConversionStatus === 'confirmed' && previousCartConversionStatus === 'confirmed',
      }),
      createTrafficMetric({
        id: 'trafficOrderCount',
        label: '下单件数',
        value: hasRows ? current.orderedUnits.value : null,
        comparisonValue: previous.orderedUnits.value,
        status: current.orderedUnits.status,
        detail: '平台官方分析接口返回的下单商品件数；不是订单笔数。',
        sourceSyncedAt,
        comparisonComparable:
          comparisonComparable && current.orderedUnits.status === 'confirmed' && previous.orderedUnits.status === 'confirmed',
      }),
      createTrafficMetric({
        id: 'trafficOrderConversionRate',
        label: '访问至下单件比',
        value: orderConversion,
        comparisonValue: previousOrderConversion,
        unit: 'percent',
        status: orderConversionStatus,
        detail: '官方下单件数 ÷ 官方访问会话数；该比例不是买家转化率。',
        sourceSyncedAt,
        comparisonComparable:
          comparisonComparable && orderConversionStatus === 'confirmed' && previousOrderConversionStatus === 'confirmed',
      }),
      createTrafficMetric({
        id: 'trafficMatchedOrderCount',
        label: '本地有效订单（参考）',
        value: hasRows ? current.matchedOrderCount : null,
        comparisonValue: previous.matchedOrderCount,
        detail: '本地订单缓存中同日期范围、状态不为已取消的订单笔数。它与官方“下单件数”粒度和日期口径不同，仅单独展示，不直接比较。',
        sourceSyncedAt: orderSourceSyncedAt,
        sourceId: 'orders',
        sourceLabel: '平台订单快照',
        sourceType: 'derived-official',
        comparisonComparable,
      }),
      createTrafficMetric({
        id: 'trafficRevenueRub',
        label: '官方成交额',
        value: hasRows ? roundNumber(current.revenueRub.value, 2) : null,
        comparisonValue: roundNumber(previous.revenueRub.value, 2),
        status:
          current.revenueRub.status === 'confirmed'
            ? currentCurrency.status
            : current.revenueRub.status,
        unit: 'money',
        currency: currentCurrency.currency,
        detail: `平台官方分析接口返回的成交额；本期币种字段判定为 ${currentCurrency.currency || '未返回'}，卢布金额由页面按日汇率折算人民币。`,
        sourceSyncedAt,
        comparisonComparable:
          comparisonComparable &&
          current.revenueRub.status === 'confirmed' &&
          previous.revenueRub.status === 'confirmed' &&
          currentCurrency.status === 'confirmed' &&
          previousCurrency.status === 'confirmed' &&
          currentCurrency.currency === previousCurrency.currency,
      }),
    ],
    funnel: [
      { id: 'sessions', label: '访问次数', value: current.visitorSessions.value, rate: null },
      {
        id: 'views',
        label: '商品浏览',
        value: current.productViews.value,
        rate: calculatePercent(current.productViews.value, current.visitorSessions.value),
      },
      { id: 'cart', label: '加入购物车', value: current.cartAdds.value, rate: cartConversion },
      { id: 'orders', label: '下单件数', value: current.orderedUnits.value, rate: orderConversion },
    ],
    dailyTrend: buildDailyTrend(currentRows, orderCountByDate),
    comparisonDailyTrend: buildDailyTrend(previousRows, previousOrderCountByDate),
    rowCount: currentRows.length,
    coverage: currentWindow,
    comparisonCoverage: previousWindow,
    quality: {
      comparisonComparable,
      comparisonNote: comparisonComparable
        ? '当前期与对比期官方快照均连续，且覆盖天数一致。'
        : '当前期与对比期官方快照不连续或覆盖天数不一致，已停止展示误导性的环比变化。',
      fieldCoverage: {
        visitorSessions: current.visitorSessions,
        productViews: current.productViews,
        cartAdds: current.cartAdds,
        orderedUnits: current.orderedUnits,
        revenueRub: current.revenueRub,
      },
      matchedEffectiveOrderCount: current.matchedOrderCount,
      revenueCurrency: currentCurrency,
    },
  };
}

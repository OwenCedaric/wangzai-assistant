import { getRubCnyRateForDate } from '../../../services/exchangeRateClient.js';
import { buildMarketDatasetMetrics } from './dataAnalysisMarketMetrics.js';
import { augmentMarketOpportunityDatasetViews } from './dataAnalysisMarketOpportunity.js';

const RUB_CURRENCIES = new Set(['RUB', 'RUR']);
const CNY_CURRENCIES = new Set(['CNY', 'RMB']);
const MARKET_MONEY_FIELDS = Object.freeze([
  'price',
  'averagePrice',
  'averageRevenue',
  'priceFrom',
  'priceTo',
  'revenue',
  'orderAmount',
  'averagePurchasePrice',
  'averageDailyRevenue',
  'followMinPrice',
  'followMaxPrice',
]);

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function dateKey(value = '') {
  return String(value || '').slice(0, 10);
}

function currencyCode(value = '') {
  return String(value || '').trim().toUpperCase();
}

function isRubCurrency(value = '') {
  return RUB_CURRENCIES.has(currencyCode(value));
}

function isCnyCurrency(value = '') {
  return CNY_CURRENCIES.has(currencyCode(value));
}

function calculateDelta(current, previous) {
  const currentValue = toFiniteNumber(current);
  const previousValue = toFiniteNumber(previous);
  if (currentValue === null || previousValue === null) return { value: null, percent: null, status: 'unavailable' };
  const value = round(currentValue - previousValue);
  if (previousValue === 0) {
    return { value, percent: currentValue === 0 ? 0 : null, status: currentValue === 0 ? 'confirmed' : 'no_comparable_base' };
  }
  return { value, percent: round(((currentValue - previousValue) / Math.abs(previousValue)) * 100), status: 'confirmed' };
}

function resolveCnyRate(currency = '', date = '', rateContext = {}) {
  const code = String(currency || '').trim().toUpperCase();
  if (code === 'CNY' || code === 'RMB') return { rate: 1, source: '原币种人民币', date: dateKey(date), fallback: false };
  if (code !== 'RUB' && code !== 'RUR') return null;
  const rate = getRubCnyRateForDate(dateKey(date), rateContext, { allowRealtimeFallback: false });
  const value = toFiniteNumber(rate?.rubToCnyRate ?? rate?.rate);
  if (value === null || value <= 0) return null;
  return {
    rate: value,
    source: rate?.source || '卢布兑人民币日汇率',
    date: rate?.date || rate?.providerDate || dateKey(date),
    fallback: Boolean(rate?.nearestFallback),
  };
}

function convertMoneyBreakdownToCny(breakdown = [], date = '', rateContext = {}) {
  const rows = Array.isArray(breakdown) ? breakdown : [];
  let converted = 0;
  let total = 0;
  let missing = 0;
  const rates = [];
  rows.forEach((item) => {
    const value = toFiniteNumber(item?.value);
    if (value === null) return;
    total += 1;
    const rate = resolveCnyRate(item?.currency, date, rateContext);
    if (!rate) {
      missing += 1;
      return;
    }
    converted += value * rate.rate;
    rates.push(rate);
  });
  if (!total || missing === total) {
    return {
      value: null,
      breakdown: [],
      status: total ? 'currency_unconfirmed' : 'empty',
      convertedRows: 0,
      totalRows: total,
      rates,
    };
  }
  return {
    value: round(converted),
    breakdown: [{ currency: 'CNY', value: round(converted) || 0 }],
    status: missing ? 'partial' : 'confirmed',
    convertedRows: total - missing,
    totalRows: total,
    rates,
  };
}

function convertRows(rows = [], rateContext = {}) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const amount = toFiniteNumber(row?.amount);
    const rate = resolveCnyRate(row?.currency, row?.operationDate, rateContext);
    return {
      ...row,
      amountCnyRaw: amount === null || !rate ? null : amount * rate.rate,
      amountCny: amount === null || !rate ? null : round(amount * rate.rate),
      rate,
    };
  });
}

function sum(rows = [], predicate = () => true) {
  return (Array.isArray(rows) ? rows : []).reduce((total, row) => {
    if (!predicate(row)) return total;
    return total + (toFiniteNumber(row?.amountCnyRaw) || 0);
  }, 0);
}

function replaceMetric(metrics = [], id, patch = {}) {
  return (Array.isArray(metrics) ? metrics : []).map((metric) => (metric.id === id ? { ...metric, ...patch } : metric));
}

function convertDirectMoneyToCny(value, currency = '', date = '', rateContext = {}) {
  const amount = toFiniteNumber(value);
  const code = currencyCode(currency);
  if (amount === null) {
    return { value: null, rawValue: null, rate: null, status: 'empty' };
  }
  if (isCnyCurrency(code)) {
    return {
      value: round(amount),
      rawValue: amount,
      rate: { rate: 1, source: '原币种人民币', date: dateKey(date), fallback: false },
      status: 'confirmed',
    };
  }
  if (!isRubCurrency(code)) {
    return { value: amount, rawValue: amount, rate: null, status: 'unchanged' };
  }
  const rate = resolveCnyRate(code, date, rateContext);
  return {
    value: rate ? round(amount * rate.rate) : null,
    rawValue: rate ? amount * rate.rate : null,
    rate,
    status: rate ? 'confirmed' : 'currency_unconfirmed',
  };
}

function metricContainsRub(metric = {}) {
  if (isRubCurrency(metric.currency)) return true;
  return (Array.isArray(metric.breakdown) ? metric.breakdown : []).some((item) => isRubCurrency(item?.currency));
}

function transformGenericMoneyMetric(metric = {}, rateContext = {}, fallbackDate = '', detailSuffix = '') {
  if (metric?.unit !== 'money' || !metricContainsRub(metric)) return metric;
  const breakdown = Array.isArray(metric.breakdown) ? metric.breakdown : [];
  const converted = breakdown.length
    ? convertMoneyBreakdownToCny(breakdown, fallbackDate, rateContext)
    : convertDirectMoneyToCny(metric.value, metric.currency, fallbackDate, rateContext);
  const comparison = toFiniteNumber(metric.comparisonValue) === null
    ? { value: null, status: 'empty' }
    : convertDirectMoneyToCny(metric.comparisonValue, metric.currency, fallbackDate, rateContext);
  const value = converted.value;
  const comparisonValue = comparison.status === 'confirmed' ? comparison.value : null;
  const originalStatus = String(metric.status || 'confirmed');
  const conversionStatus = converted.status === 'currency_unconfirmed'
    ? 'currency_unconfirmed'
    : converted.status === 'partial'
      ? 'partial'
      : ['partial', 'mixed_currency'].includes(originalStatus)
        ? 'partial'
        : originalStatus === 'not_returned' && value === null
          ? 'not_returned'
          : 'confirmed';
  return {
    ...metric,
    value,
    comparisonValue,
    delta: value === null || comparisonValue === null ? null : calculateDelta(value, comparisonValue),
    currency: 'CNY',
    status: conversionStatus,
    breakdown: value === null ? [] : [{ currency: 'CNY', value }],
    detail: `${metric.detail || ''} ${detailSuffix || '卢布金额按筛选截止日汇率折算为人民币。'}`.trim(),
  };
}

function collectMetricRubFallbackDate(metrics = [], fallbackDate = '') {
  return (Array.isArray(metrics) ? metrics : []).some(metricContainsRub) ? [dateKey(fallbackDate)] : [];
}

function transformSalesMetric(metric = {}, rateContext = {}, fallbackDate = '') {
  if (metric.unit !== 'money') return metric;
  const currency = String(metric.currency || '').toUpperCase();
  const directValue = toFiniteNumber(metric.value);
  if ((currency === 'CNY' || currency === 'RMB') && directValue !== null) {
    return {
      ...metric,
      value: directValue,
      comparisonValue: toFiniteNumber(metric.comparisonValue),
      currency: 'CNY',
      breakdown: metric.breakdown?.length ? metric.breakdown : [{ currency: 'CNY', value: directValue }],
    };
  }
  const converted = convertMoneyBreakdownToCny(metric.breakdown, fallbackDate, rateContext);
  const value = converted.value;
  const comparisonValue =
    currency === 'CNY'
      ? toFiniteNumber(metric.comparisonValue)
      : null;
  return {
    ...metric,
    value,
    comparisonValue,
    delta: comparisonValue === null || value === null ? null : calculateDelta(value, comparisonValue),
    currency: 'CNY',
    status: value === null ? converted.status : converted.status === 'partial' ? 'partial' : 'confirmed',
    breakdown: converted.breakdown,
    detail: `${metric.detail || ''} 页面金额统一展示为人民币；非人民币订单按订单日期汇率折算。`.trim(),
  };
}

function transformSalesTrendRow(row = {}, rateContext = {}) {
  const sourceBreakdown = Array.isArray(row.sales?.breakdown) ? row.sales.breakdown : [];
  if (!sourceBreakdown.length) {
    const confirmedEmpty = String(row.sales?.status || '') === 'empty';
    return {
      ...row,
      sales: {
        ...(row.sales || {}),
        value: confirmedEmpty ? 0 : null,
        currency: 'CNY',
        status: confirmedEmpty ? 'empty' : row.sales?.status || 'not_returned',
        breakdown: confirmedEmpty ? [{ currency: 'CNY', value: 0 }] : [],
      },
    };
  }
  const converted = convertMoneyBreakdownToCny(sourceBreakdown, row.date, rateContext);
  return {
    ...row,
    sales: {
      ...(row.sales || {}),
      value: converted.value,
      currency: 'CNY',
      status: converted.value === null ? converted.status : converted.status === 'partial' ? 'partial' : 'confirmed',
      breakdown: converted.breakdown,
    },
  };
}

function transformProductRankingRow(row = {}, rateContext = {}, fallbackDate = '') {
  const converted = convertMoneyBreakdownToCny(row.sales?.breakdown, fallbackDate, rateContext);
  const sourceStatus = String(row.sales?.status || '');
  return {
    ...row,
    sales: {
      ...(row.sales || {}),
      value: converted.value,
      currency: 'CNY',
      status:
        sourceStatus && !['confirmed', 'empty'].includes(sourceStatus)
          ? sourceStatus
          : converted.value === null
            ? converted.status
            : converted.status === 'partial'
              ? 'partial'
              : 'confirmed',
      breakdown: converted.breakdown,
    },
  };
}

function transformSales(sales = {}, rateContext = {}, fallbackDate = '') {
  const trend = (Array.isArray(sales.trend) ? sales.trend : []).map((row) => transformSalesTrendRow(row, rateContext));
  const convertedSalesRows = trend.filter((row) => toFiniteNumber(row.sales?.value) !== null);
  const allSalesRowsConverted = trend.length > 0 && convertedSalesRows.length === trend.length;
  const salesValue = convertedSalesRows.reduce((total, row) => total + (toFiniteNumber(row.sales?.value) || 0), 0);
  const effectiveOrderCount = toFiniteNumber(
    (sales.metrics || []).find((metric) => metric.id === 'effectiveOrderCount')?.value
  );
  let metrics = (sales.metrics || []).map((metric) => transformSalesMetric(metric, rateContext, fallbackDate));
  metrics = replaceMetric(metrics, 'salesAmount', {
    value: convertedSalesRows.length ? round(salesValue) : null,
    currency: 'CNY',
    status: !convertedSalesRows.length ? 'currency_unconfirmed' : allSalesRowsConverted ? 'confirmed' : 'partial',
    breakdown: convertedSalesRows.length ? [{ currency: 'CNY', value: round(salesValue) || 0 }] : [],
  });
  metrics = replaceMetric(metrics, 'averageOrderValue', {
    value: convertedSalesRows.length && effectiveOrderCount ? round(salesValue / effectiveOrderCount) : null,
    currency: 'CNY',
    status:
      convertedSalesRows.length && effectiveOrderCount
        ? allSalesRowsConverted
          ? 'confirmed'
          : 'partial'
        : 'currency_unconfirmed',
    breakdown:
      convertedSalesRows.length && effectiveOrderCount
        ? [{ currency: 'CNY', value: round(salesValue / effectiveOrderCount) || 0 }]
        : [],
  });
  return {
    ...sales,
    metrics,
    trend,
    productRanking: (sales.productRanking || []).map((row) => transformProductRankingRow(row, rateContext, fallbackDate)),
    shopRanking: (sales.shopRanking || []).map((row) => transformProductRankingRow(row, rateContext, fallbackDate)),
    currencyConversion: {
      sourceCurrency: '订单原币种',
      targetCurrency: 'CNY',
      status: 'confirmed',
      note: '订单、趋势和排行统一按人民币展示；本地已有人民币订单保持原值。',
    },
  };
}

function updateMoneyMetric(metrics, id, value, comparisonValue, detail, status = 'confirmed') {
  const roundedValue = round(value);
  const roundedComparison = round(comparisonValue);
  return replaceMetric(metrics, id, {
    label:
      id === 'financeNetAmount'
        ? '平台到账金额'
        : id === 'financeIncomeAmount'
          ? '正向入账'
          : '平台扣减',
    value: roundedValue,
    comparisonValue: roundedComparison,
    delta: roundedValue === null || roundedComparison === null ? null : calculateDelta(value, comparisonValue),
    currency: 'CNY',
    status,
    breakdown: roundedValue === null ? [] : [{ currency: 'CNY', value: roundedValue }],
    detail,
  });
}

function buildOperationBreakdown(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    if (row.amountCny === null) return;
    const key = row.operationType || '未返回费用类型';
    const current = map.get(key) || { code: key, count: 0, amount: 0 };
    current.count += 1;
    current.amount += row.amountCnyRaw;
    map.set(key, current);
  });
  return [...map.values()]
    .sort((left, right) => right.count - left.count || Math.abs(right.amount) - Math.abs(left.amount))
    .map((row) => ({
      code: row.code,
      count: row.count,
      amount: {
        value: round(row.amount),
        currency: 'CNY',
        status: 'confirmed',
        breakdown: [{ currency: 'CNY', value: round(row.amount) || 0 }],
      },
      sourceId: 'finance',
    }));
}

function buildLargestDeductions(rows = []) {
  return rows
    .filter((row) => row.amountCny !== null && row.amountCny < 0)
    .sort((left, right) => left.amountCny - right.amountCny)
    .slice(0, 30)
    .map((row) => ({
      operationId: row.operationId,
      postingNumber: row.postingNumber,
      operationType: row.operationType,
      operationDate: row.operationDate,
      amount: round(row.amountCny),
      currency: 'CNY',
      currencySource: '按流水日卢布兑人民币汇率折算',
      conversionRate: row.rate?.rate || null,
      sourceId: 'finance',
    }));
}

function transformFinance(finance = {}, rateContext = {}) {
  const currentRows = convertRows(finance.currencyConversionRows, rateContext);
  const comparisonRows = convertRows(finance.comparisonCurrencyConversionRows, rateContext);
  const convertedRows = currentRows.filter((row) => row.amountCny !== null);
  const convertedComparisonRows = comparisonRows.filter((row) => row.amountCny !== null);
  const current = {
    net: convertedRows.length ? sum(convertedRows) : null,
    positive: convertedRows.length ? sum(convertedRows, (row) => row.amountCnyRaw >= 0) : null,
    negative: convertedRows.length ? Math.abs(sum(convertedRows, (row) => row.amountCnyRaw < 0)) : null,
  };
  const previous = {
    net: convertedComparisonRows.length ? sum(convertedComparisonRows) : null,
    positive: convertedComparisonRows.length
      ? sum(convertedComparisonRows, (row) => row.amountCnyRaw >= 0)
      : null,
    negative: convertedComparisonRows.length
      ? Math.abs(sum(convertedComparisonRows, (row) => row.amountCnyRaw < 0))
      : null,
  };
  const coverage = currentRows.length ? round((convertedRows.length / currentRows.length) * 100, 1) : null;
  const conversionStatus = !currentRows.length
    ? 'empty'
    : convertedRows.length === currentRows.length
      ? 'confirmed'
      : convertedRows.length
        ? 'partial'
        : 'currency_unconfirmed';
  let metrics = finance.metrics || [];
  metrics = updateMoneyMetric(metrics, 'financeNetAmount', current.net, previous.net, '平台财务流水按发生日卢布兑人民币汇率折算后的净额。', conversionStatus);
  metrics = updateMoneyMetric(metrics, 'financeIncomeAmount', current.positive, previous.positive, '平台财务正向流水按发生日卢布兑人民币汇率折算。', conversionStatus);
  metrics = updateMoneyMetric(metrics, 'financeDeductionAmount', current.negative, previous.negative, '平台财务扣减流水按发生日卢布兑人民币汇率折算。', conversionStatus);
  metrics = replaceMetric(metrics, 'financeCurrencyCoverage', {
    id: 'financeCurrencyCoverage',
    label: '人民币换算覆盖率',
    value: coverage,
    unit: 'percent',
    status: coverage === null ? 'empty' : coverage >= 100 ? 'confirmed' : 'currency_unconfirmed',
    detail: `财务接口直接返回币种 ${finance.currencyCoverage?.officialCurrencyRows || 0}/${currentRows.length} 笔；其余按平台结算规则判定为卢布，再按每笔流水发生日汇率换算人民币。`,
    breakdown: [],
  });
  const rates = [...new Set(convertedRows.map((row) => row.rate?.rate).filter((rate) => Number.isFinite(rate)))];
  return {
    ...finance,
    metrics,
    operationBreakdown: buildOperationBreakdown(convertedRows),
    largestDeductions: buildLargestDeductions(convertedRows),
    flowSummary: {
      positiveAmount: round(current.positive),
      negativeAmount: round(current.negative),
      positiveCount: convertedRows.filter((row) => row.amountCnyRaw >= 0).length,
      negativeCount: convertedRows.filter((row) => row.amountCnyRaw < 0).length,
      convertedCount: convertedRows.length,
      totalCount: currentRows.length,
    },
    currencyCoverage: {
      ...(finance.currencyCoverage || {}),
      confirmedRows: convertedRows.length,
      totalRows: currentRows.length,
      percent: coverage,
      settlementCurrency: 'RUB',
      targetCurrency: 'CNY',
    },
    currencyConversion: {
      status: conversionStatus,
      sourceCurrency: 'RUB',
      targetCurrency: 'CNY',
      convertedRows: convertedRows.length,
      totalRows: currentRows.length,
      rateMin: rates.length ? Math.min(...rates) : null,
      rateMax: rates.length ? Math.max(...rates) : null,
      rateSources: [...new Set(convertedRows.map((row) => row.rate?.source).filter(Boolean))],
    },
  };
}

function transformTraffic(traffic = {}, rateContext = {}) {
  const comparisonComparable = traffic?.quality?.comparisonComparable === true;
  const trafficRevenueMetric = (traffic.metrics || []).find((metric) => metric.id === 'trafficRevenueRub');
  const fallbackCurrency = String(trafficRevenueMetric?.currency || '').toUpperCase();
  const dailyTrend = (Array.isArray(traffic.dailyTrend) ? traffic.dailyTrend : []).map((row) => {
    const sourceCurrency = String(row.revenueCurrency || fallbackCurrency || '').toUpperCase();
    const rate = resolveCnyRate(sourceCurrency, row.date, rateContext);
    const revenueRub = toFiniteNumber(row.revenueRub);
    return {
      ...row,
      revenueCny: revenueRub === null || !rate ? null : round(revenueRub * rate.rate),
      revenueRate: rate?.rate || null,
    };
  });
  const comparisonDailyTrend = (Array.isArray(traffic.comparisonDailyTrend) ? traffic.comparisonDailyTrend : []).map((row) => {
    const sourceCurrency = String(row.revenueCurrency || fallbackCurrency || '').toUpperCase();
    const rate = resolveCnyRate(sourceCurrency, row.date, rateContext);
    const revenueRub = toFiniteNumber(row.revenueRub);
    return { ...row, revenueCny: revenueRub === null || !rate ? null : round(revenueRub * rate.rate) };
  });
  const convertedRows = dailyTrend.filter((row) => toFiniteNumber(row.revenueCny) !== null);
  const convertedComparisonRows = comparisonDailyTrend.filter((row) => toFiniteNumber(row.revenueCny) !== null);
  const revenueCny = convertedRows.length
    ? convertedRows.reduce((total, row) => total + (toFiniteNumber(row.revenueCny) || 0), 0)
    : null;
  const comparisonRevenueCny = comparisonComparable && convertedComparisonRows.length
    ? convertedComparisonRows.reduce((total, row) => total + (toFiniteNumber(row.revenueCny) || 0), 0)
    : null;
  const status = !dailyTrend.length
    ? 'not_returned'
    : convertedRows.length === dailyTrend.length
      ? 'confirmed'
      : convertedRows.length
        ? 'partial'
        : 'currency_unconfirmed';
  const comparisonStatus = !comparisonDailyTrend.length
    ? 'not_returned'
    : convertedComparisonRows.length === comparisonDailyTrend.length
      ? 'confirmed'
      : convertedComparisonRows.length
        ? 'partial'
        : 'currency_unconfirmed';
  const canCompareRevenue = comparisonComparable && status === 'confirmed' && comparisonStatus === 'confirmed';
  return {
    ...traffic,
    dailyTrend,
    comparisonDailyTrend,
    metrics: replaceMetric(traffic.metrics, 'trafficRevenueRub', {
      label: '官方成交额',
      value: round(revenueCny),
      comparisonValue: canCompareRevenue ? round(comparisonRevenueCny) : null,
      delta: canCompareRevenue ? calculateDelta(revenueCny, comparisonRevenueCny) : null,
      currency: 'CNY',
      status,
      breakdown: revenueCny === null ? [] : [{ currency: 'CNY', value: round(revenueCny) || 0 }],
      detail: '平台官方成交额按每日卢布兑人民币汇率折算。',
    }),
    currencyConversion: {
      sourceCurrency: 'RUB',
      targetCurrency: 'CNY',
      status,
      convertedDays: convertedRows.length,
      totalDays: dailyTrend.length,
    },
  };
}

function formatCnyBandValue(value) {
  const amount = toFiniteNumber(value);
  return amount === null
    ? ''
    : amount.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function transformProductPriceBand(row = {}, rateContext = {}, fallbackDate = '', fallbackCurrency = '') {
  const sourceCurrency = currencyCode(row.currency || fallbackCurrency);
  if (!isRubCurrency(sourceCurrency) && !isCnyCurrency(sourceCurrency)) return row;
  const rangeMatch = String(row.id || '').match(/^(\d+)-(\d+)$/u);
  const inferredMinimum = row.min ?? (rangeMatch ? Number(rangeMatch[1]) : null);
  const inferredMaximum = row.max ?? (rangeMatch ? Number(rangeMatch[2]) : null);
  const openEnded = row.openEnded ?? String(row.id || '').endsWith('+');
  const minimum = convertDirectMoneyToCny(inferredMinimum, sourceCurrency, fallbackDate, rateContext);
  const maximum = openEnded
    ? { value: null, status: 'empty' }
    : convertDirectMoneyToCny(inferredMaximum, sourceCurrency, fallbackDate, rateContext);
  const missingRate = minimum.status === 'currency_unconfirmed' || maximum.status === 'currency_unconfirmed';
  if (missingRate) {
    return {
      ...row,
      openEnded,
      min: null,
      max: null,
      label: '汇率未确认',
      currency: 'CNY',
      status: 'currency_unconfirmed',
    };
  }
  const label = openEnded
    ? `￥${formatCnyBandValue(minimum.value)}以上`
    : `￥${formatCnyBandValue(minimum.value)}–￥${formatCnyBandValue(maximum.value)}`;
  return {
    ...row,
    min: minimum.value,
    max: maximum.value,
    label,
    currency: 'CNY',
    status: 'confirmed',
  };
}

function transformProducts(products = {}, rateContext = {}, fallbackDate = '') {
  const sourceAveragePriceMetric = (products.metrics || []).find((metric) => metric.id === 'averageProductPrice') || {};
  const sourceCurrency = currencyCode(
    sourceAveragePriceMetric.currency
      || sourceAveragePriceMetric.breakdown?.[0]?.currency
      || products.priceBands?.[0]?.currency
  );
  return {
    ...products,
    metrics: (products.metrics || []).map((metric) => transformGenericMoneyMetric(
      metric,
      rateContext,
      fallbackDate,
      '商品价格按筛选截止日汇率折算为人民币。'
    )),
    priceBands: (Array.isArray(products.priceBands) ? products.priceBands : []).map((row) => (
      transformProductPriceBand(row, rateContext, fallbackDate, sourceCurrency)
    )),
  };
}

function transformAfterSales(afterSales = {}, rateContext = {}, fallbackDate = '') {
  const recentRows = (Array.isArray(afterSales.recentRows) ? afterSales.recentRows : []).map((row) => {
    if (!isRubCurrency(row.currency)) return row;
    const converted = convertDirectMoneyToCny(row.amount, row.currency, row.createdAt || fallbackDate, rateContext);
    return {
      ...row,
      amount: converted.value,
      currency: 'CNY',
      currencyStatus: converted.status,
      exchangeRate: converted.rate?.rate || null,
      exchangeRateDate: converted.rate?.date || null,
    };
  });
  const qualityBreakdown = convertMoneyBreakdownToCny(
    afterSales.dataQuality?.amountCurrencyBreakdown,
    fallbackDate,
    rateContext
  );
  return {
    ...afterSales,
    metrics: (afterSales.metrics || []).map((metric) => transformGenericMoneyMetric(
      metric,
      rateContext,
      fallbackDate,
      '售后商品金额按筛选截止日汇率折算为人民币；该金额仍不代表最终退款金额。'
    )),
    recentRows,
    dataQuality: {
      ...(afterSales.dataQuality || {}),
      amountCurrencyStatus: qualityBreakdown.totalRows ? qualityBreakdown.status : afterSales.dataQuality?.amountCurrencyStatus,
      amountCurrencyBreakdown: qualityBreakdown.totalRows ? qualityBreakdown.breakdown : afterSales.dataQuality?.amountCurrencyBreakdown || [],
      targetCurrency: 'CNY',
    },
  };
}

function transformMarketingProductRow(row = {}, rateContext = {}, fallbackDate = '') {
  if (!isRubCurrency(row.currency)) return row;
  const price = convertDirectMoneyToCny(row.price, row.currency, fallbackDate, rateContext);
  const activityPrice = convertDirectMoneyToCny(row.activityPrice, row.currency, fallbackDate, rateContext);
  const convertedPrice = price.value;
  const convertedActivityPrice = activityPrice.value;
  return {
    ...row,
    price: convertedPrice,
    activityPrice: convertedActivityPrice,
    currency: 'CNY',
    priceCurrencyStatus: price.status,
    activityPriceCurrencyStatus: activityPrice.status,
    discountAmount:
      convertedPrice !== null && convertedActivityPrice !== null
        ? round(Math.max(0, convertedPrice - convertedActivityPrice))
        : null,
    exchangeRate: price.rate?.rate || activityPrice.rate?.rate || null,
  };
}

function transformMarketing(marketing = {}, rateContext = {}, fallbackDate = '') {
  const activityPriceMetric = transformGenericMoneyMetric(
    {
      id: 'activityPriceAmount',
      unit: 'money',
      ...(marketing.activityPriceAmount || {}),
    },
    rateContext,
    fallbackDate,
    '活动商品价格按筛选截止日汇率折算为人民币。'
  );
  const { id: _id, unit: _unit, detail: _detail, ...activityPriceAmount } = activityPriceMetric;
  return {
    ...marketing,
    metrics: (marketing.metrics || []).map((metric) => transformGenericMoneyMetric(
      metric,
      rateContext,
      fallbackDate,
      '促销金额按筛选截止日汇率折算为人民币。'
    )),
    productRows: (Array.isArray(marketing.productRows) ? marketing.productRows : []).map((row) => (
      transformMarketingProductRow(row, rateContext, fallbackDate)
    )),
    activityPriceAmount,
  };
}

function marketRecordDate(record = {}, dataset = {}, fallbackDate = '') {
  return dateKey(record.date || record.capturedAt || dataset.newestCapturedAt || fallbackDate);
}

function formatCnyMarketBand(record = {}) {
  const from = toFiniteNumber(record.priceFrom);
  const to = toFiniteNumber(record.priceTo);
  if (from === null && to === null) return record.title;
  return `￥${formatCnyBandValue(from ?? 0)}–${to === null ? '以上' : `￥${formatCnyBandValue(to)}`}`;
}

function transformMarketRecord(record = {}, dataset = {}, rateContext = {}, fallbackDate = '') {
  const sourceCurrency = currencyCode(record.currency || dataset.currency || 'RUB');
  if (!isRubCurrency(sourceCurrency) && !isCnyCurrency(sourceCurrency)) return record;
  const effectiveDate = marketRecordDate(record, dataset, fallbackDate);
  const next = { ...record, currency: 'CNY' };
  const unconfirmedFields = [];
  MARKET_MONEY_FIELDS.forEach((field) => {
    const sourceValue = toFiniteNumber(record[field]);
    if (sourceValue === null) return;
    const converted = convertDirectMoneyToCny(sourceValue, sourceCurrency, effectiveDate, rateContext);
    next[field] = converted.status === 'confirmed' ? converted.rawValue : converted.value;
    if (converted.status === 'currency_unconfirmed') unconfirmedFields.push(field);
  });
  next.currencyStatus = unconfirmedFields.length ? 'currency_unconfirmed' : 'confirmed';
  next.currencyUnconfirmedFields = unconfirmedFields;
  if (String(record.dataset || dataset.dataset || dataset.id) === 'price-segments') {
    next.title = unconfirmedFields.length ? '汇率未确认' : formatCnyMarketBand(next);
  }
  return next;
}

function resolveMarketDatasetCurrency(dataset = {}) {
  const currencies = [...new Set(
    (Array.isArray(dataset.records) ? dataset.records : [])
      .map((record) => currencyCode(record.currency || dataset.currency || 'RUB'))
      .filter(Boolean)
  )];
  return currencies.length === 1 ? currencies[0] : currencyCode(dataset.currency || 'RUB');
}

function transformMarketMetric(metric = {}, sourceCurrency = 'RUB', date = '', rateContext = {}) {
  if (metric.kind !== 'money') return metric;
  const converted = convertDirectMoneyToCny(metric.value, sourceCurrency, date, rateContext);
  return {
    ...metric,
    value: converted.status === 'unchanged' ? metric.value : converted.value,
    currency: converted.status === 'unchanged' ? sourceCurrency : 'CNY',
    status: converted.status === 'confirmed'
      ? metric.status || 'confirmed'
      : converted.status === 'empty'
        ? metric.status || 'not_returned'
        : converted.status,
  };
}

function transformMarketDataset(dataset = {}, rateContext = {}, fallbackDate = '', { rebuildMetrics = true } = {}) {
  const sourceCurrency = resolveMarketDatasetCurrency(dataset);
  const effectiveDate = dateKey(dataset.newestCapturedAt || fallbackDate);
  const records = (Array.isArray(dataset.records) ? dataset.records : []).map((record) => (
    transformMarketRecord(record, dataset, rateContext, fallbackDate)
  ));
  const hasUnconfirmedMoney = records.some((record) => record.currencyStatus === 'currency_unconfirmed');
  const sourceMetrics = rebuildMetrics
    ? buildMarketDatasetMetrics(String(dataset.dataset || dataset.id || ''), records)
    : Array.isArray(dataset.metrics) ? dataset.metrics : [];
  return {
    ...dataset,
    currency: isRubCurrency(sourceCurrency) || isCnyCurrency(sourceCurrency) ? 'CNY' : sourceCurrency,
    records,
    metrics: sourceMetrics.map((metric) => {
      if (rebuildMetrics && metric.kind === 'money') {
        return {
          ...metric,
          value: hasUnconfirmedMoney ? null : metric.value,
          currency: 'CNY',
          status: hasUnconfirmedMoney ? 'currency_unconfirmed' : metric.status || 'confirmed',
        };
      }
      return transformMarketMetric(metric, sourceCurrency, effectiveDate, rateContext);
    }),
  };
}

export function collectDataAnalysisMarketRubDates(data = {}, fallbackDate = '') {
  if (!data || typeof data !== 'object') return [];
  const dates = [];
  const collectDataset = (dataset = {}) => {
    const datasetCurrency = resolveMarketDatasetCurrency(dataset);
    const records = Array.isArray(dataset.records) ? dataset.records : [];
    records.forEach((record) => {
      const hasMoney = MARKET_MONEY_FIELDS.some((field) => toFiniteNumber(record[field]) !== null);
      const sourceCurrency = currencyCode(record.currency || datasetCurrency || 'RUB');
      if (hasMoney && isRubCurrency(sourceCurrency)) {
        dates.push(marketRecordDate(record, dataset, fallbackDate));
      }
    });
    if ((dataset.metrics || []).some((metric) => metric.kind === 'money') && isRubCurrency(datasetCurrency)) {
      dates.push(dateKey(dataset.newestCapturedAt || fallbackDate));
    }
  };
  (Array.isArray(data.datasetViews) ? data.datasetViews : []).forEach(collectDataset);
  Object.values(data.sections || {}).forEach(collectDataset);
  return [...new Set(dates.filter(Boolean))];
}

export function convertDataAnalysisMarketToCny(data = {}, rateContext = {}, fallbackDate = '') {
  if (!data || typeof data !== 'object') return data;
  const sourceDatasets = augmentMarketOpportunityDatasetViews(
    Array.isArray(data.datasetViews) ? data.datasetViews : []
  );
  const datasetViews = sourceDatasets.map((dataset) => transformMarketDataset(dataset, rateContext, fallbackDate));
  const sections = Object.fromEntries(
    Object.entries(data.sections || {}).map(([id, section]) => [
      id,
      transformMarketDataset(section, rateContext, fallbackDate, { rebuildMetrics: false }),
    ])
  );
  const unconfirmedRows = datasetViews.reduce(
    (total, dataset) => total + dataset.records.filter((row) => row.currencyStatus === 'currency_unconfirmed').length,
    0
  );
  const convertedRows = datasetViews.reduce(
    (total, dataset) => total + dataset.records.filter((row) => row.currency === 'CNY').length,
    0
  );
  return {
    ...data,
    datasetViews,
    sections,
    currencyConversion: {
      sourceCurrency: 'RUB',
      targetCurrency: 'CNY',
      status: unconfirmedRows ? (convertedRows ? 'partial' : 'currency_unconfirmed') : 'confirmed',
      convertedRows,
      unconfirmedRows,
    },
  };
}

export function collectDataAnalysisRubDates(dashboard = {}) {
  const fallbackDate = dateKey(dashboard?.range?.endDate || '');
  const financeRows = [
    ...(dashboard?.finance?.currencyConversionRows || []),
    ...(dashboard?.finance?.comparisonCurrencyConversionRows || []),
  ];
  const financeDates = financeRows
    .filter((row) => ['RUB', 'RUR'].includes(String(row?.currency || '').toUpperCase()))
    .map((row) => dateKey(row.operationDate));
  const trafficDates = [
    ...(dashboard?.traffic?.dailyTrend || []),
    ...(dashboard?.traffic?.comparisonDailyTrend || []),
  ]
    .filter((row) => ['RUB', 'RUR'].includes(String(row?.revenueCurrency || 'RUB').toUpperCase()))
    .map((row) => dateKey(row.date));
  const salesDates = (dashboard?.sales?.trend || [])
    .filter((row) => (row?.sales?.breakdown || []).some((item) => ['RUB', 'RUR'].includes(String(item?.currency || '').toUpperCase())))
    .map((row) => dateKey(row.date));
  const sectionMetricDates = [
    ...(dashboard?.sales?.metrics || []),
    ...(dashboard?.products?.metrics || []),
    ...(dashboard?.finance?.metrics || []),
    ...(dashboard?.traffic?.metrics || []),
    ...(dashboard?.afterSales?.metrics || []),
    ...(dashboard?.marketing?.metrics || []),
  ].flatMap((metric) => collectMetricRubFallbackDate([metric], fallbackDate));
  const afterSalesDates = (dashboard?.afterSales?.recentRows || [])
    .filter((row) => isRubCurrency(row?.currency))
    .map((row) => dateKey(row.createdAt || fallbackDate));
  const marketingDates = (dashboard?.marketing?.productRows || [])
    .filter((row) => isRubCurrency(row?.currency) && (
      toFiniteNumber(row?.price) !== null || toFiniteNumber(row?.activityPrice) !== null
    ))
    .map(() => fallbackDate);
  const productBandDates = (dashboard?.products?.priceBands || [])
    .some((row) => isRubCurrency(row?.currency) && (
      toFiniteNumber(row?.min) !== null || toFiniteNumber(row?.max) !== null || /^\d+(?:-\d+|\+)$/u.test(String(row?.id || ''))
    ))
    ? [fallbackDate]
    : [];
  const afterSalesBreakdownDates = (dashboard?.afterSales?.dataQuality?.amountCurrencyBreakdown || [])
    .some((row) => isRubCurrency(row?.currency) && toFiniteNumber(row?.value) !== null)
    ? [fallbackDate]
    : [];
  const marketingAmountDates = (dashboard?.marketing?.activityPriceAmount?.breakdown || [])
    .some((row) => isRubCurrency(row?.currency) && toFiniteNumber(row?.value) !== null)
    ? [fallbackDate]
    : [];
  const marketDates = collectDataAnalysisMarketRubDates(dashboard?.market, fallbackDate);
  return [...new Set([
    ...financeDates,
    ...trafficDates,
    ...salesDates,
    ...sectionMetricDates,
    ...afterSalesDates,
    ...afterSalesBreakdownDates,
    ...marketingDates,
    ...marketingAmountDates,
    ...productBandDates,
    ...marketDates,
  ].filter(Boolean))];
}

export function convertDataAnalysisDashboardToCny(dashboard = {}, rateContext = {}) {
  if (!dashboard || typeof dashboard !== 'object') return dashboard;
  const sales = transformSales(dashboard.sales, rateContext, dashboard?.range?.endDate || '');
  const products = transformProducts(dashboard.products, rateContext, dashboard?.range?.endDate || '');
  const finance = transformFinance(dashboard.finance, rateContext);
  const traffic = transformTraffic(dashboard.traffic, rateContext);
  const afterSales = transformAfterSales(dashboard.afterSales, rateContext, dashboard?.range?.endDate || '');
  const marketing = transformMarketing(dashboard.marketing, rateContext, dashboard?.range?.endDate || '');
  const metricById = new Map([
    ...sales.metrics,
    ...products.metrics,
    ...finance.metrics,
    ...traffic.metrics,
    ...afterSales.metrics,
    ...marketing.metrics,
  ].map((metric) => [metric.id, metric]));
  const statusValues = [
    ...sales.metrics,
    ...products.metrics,
    ...finance.metrics,
    ...traffic.metrics,
    ...afterSales.metrics,
    ...marketing.metrics,
  ].filter((metric) => metric.unit === 'money' && (metricContainsRub(metric) || metric.currency === 'CNY'));
  const currencyStatus = !statusValues.length
    ? 'not_returned'
    : statusValues.some((metric) => ['currency_unconfirmed', 'partial'].includes(metric.status))
    ? statusValues.some((metric) => metric.status === 'confirmed') ? 'partial' : 'currency_unconfirmed'
    : 'confirmed';
  return {
    ...dashboard,
    sales,
    products,
    finance,
    traffic,
    afterSales,
    marketing,
    currencyConversion: {
      sourceCurrency: 'RUB',
      targetCurrency: 'CNY',
      status: currencyStatus,
    },
    overview: {
      ...(dashboard.overview || {}),
      metrics: (dashboard.overview?.metrics || []).map((metric) => metricById.get(metric.id) || transformGenericMoneyMetric(
        metric,
        rateContext,
        dashboard?.range?.endDate || '',
        '金额按筛选截止日汇率折算为人民币。'
      )),
      trend: sales.trend,
    },
  };
}

export function collectPerformanceRubDates(data = {}, fallbackDate = '') {
  const dailyDates = (Array.isArray(data?.dailyTrend) ? data.dailyTrend : [])
    .map((row) => dateKey(row?.date))
    .filter(Boolean);
  return [...new Set([...dailyDates, dateKey(fallbackDate)].filter(Boolean))];
}

export function convertPerformanceAnalysisToCny(data = {}, rateContext = {}, fallbackDate = '') {
  if (!data || typeof data !== 'object') return data;
  const convertValue = (value, date) => {
    const amount = toFiniteNumber(value);
    const rate = resolveCnyRate('RUB', date, rateContext);
    const rawValue = amount === null || !rate ? null : amount * rate.rate;
    return {
      value: round(rawValue),
      rawValue,
      rate,
    };
  };
  const dailyTrend = (Array.isArray(data.dailyTrend) ? data.dailyTrend : []).map((row) => {
    const spent = convertValue(row.spent, row.date);
    const revenue = convertValue(row.revenue, row.date);
    return {
      ...row,
      spentCny: spent.value,
      spentCnyRaw: spent.rawValue,
      revenueCny: revenue.value,
      revenueCnyRaw: revenue.rawValue,
      exchangeRate: spent.rate?.rate || revenue.rate?.rate || null,
    };
  });
  const summarizeDailyMoney = (sourceKey, convertedKey) => {
    const sourceRows = dailyTrend.filter((row) => toFiniteNumber(row?.[sourceKey]) !== null);
    const convertedRows = sourceRows.filter((row) => toFiniteNumber(row?.[convertedKey]) !== null);
    return {
      value: convertedRows.length
        ? round(
            convertedRows.reduce(
              (total, row) =>
                total +
                (toFiniteNumber(row?.[`${convertedKey}Raw`]) ?? toFiniteNumber(row?.[convertedKey]) ?? 0),
              0
            )
          )
        : null,
      sourceRows: sourceRows.length,
      convertedRows: convertedRows.length,
      status:
        !sourceRows.length
          ? 'not_returned'
          : convertedRows.length === sourceRows.length
            ? 'confirmed'
            : convertedRows.length
              ? 'partial'
              : 'currency_unconfirmed',
    };
  };
  const dailySpend = summarizeDailyMoney('spent', 'spentCny');
  const dailyRevenue = summarizeDailyMoney('revenue', 'revenueCny');
  const campaigns = (Array.isArray(data.campaigns) ? data.campaigns : []).map((row) => {
    const statisticRows = Array.isArray(row.statisticsRows) ? row.statisticsRows : [];
    const convertCampaignField = (key) => {
      const sourceRows = statisticRows
        .map((statistic) => ({
          value: toFiniteNumber(statistic?.[key]),
          date: dateKey(statistic?.date) || dateKey(fallbackDate),
        }))
        .filter((item) => item.value !== null);
      if (!sourceRows.length) return convertValue(row?.[key], fallbackDate);
      const convertedRows = sourceRows
        .map((item) => convertValue(item.value, item.date))
        .filter((item) => item.value !== null);
      return {
        value: convertedRows.length
          ? round(
              convertedRows.reduce(
                (total, item) => total + (toFiniteNumber(item.rawValue) ?? item.value),
                0
              )
            )
          : null,
        rate: convertedRows.length === 1 ? convertedRows[0].rate : null,
      };
    };
    const spent = convertCampaignField('spent');
    const revenue = convertCampaignField('revenue');
    return {
      ...row,
      spentCny: spent.value,
      revenueCny: revenue.value,
      exchangeRate: spent.rate?.rate || revenue.rate?.rate || null,
    };
  });
  let metrics = (Array.isArray(data.metrics) ? data.metrics : []).map((metric) => {
    if (metric.unit !== 'money' || String(metric.currency || '').toUpperCase() !== 'RUB') return metric;
    if (metric.id === 'adCpc') return metric;
    const dailySummary = metric.id === 'adSpend' ? dailySpend : metric.id === 'adRevenue' ? dailyRevenue : null;
    const converted = dailySummary?.sourceRows
      ? { value: dailySummary.value, status: dailySummary.status }
      : { ...convertValue(metric.value, fallbackDate), status: null };
    return {
      ...metric,
      value: converted.value,
      currency: 'CNY',
      status:
        converted.value === null && metric.value !== null
          ? 'currency_unconfirmed'
          : converted.status === 'partial'
            ? 'partial'
            : metric.status,
      breakdown: converted.value === null ? [] : [{ currency: 'CNY', value: converted.value }],
      detail: `${metric.detail || ''} ${dailySummary?.sourceRows ? '金额按每个统计日汇率逐日折算后汇总。' : '金额按筛选截止日汇率折算。'}`.trim(),
    };
  });
  const spendMetric = metrics.find((item) => item.id === 'adSpend');
  const clickMetric = metrics.find((item) => item.id === 'adClicks');
  metrics = metrics.map((metric) => {
    if (metric.id !== 'adCpc') return metric;
    const spend = toFiniteNumber(spendMetric?.value);
    const clicks = toFiniteNumber(clickMetric?.value);
    const value = spend !== null && clicks !== null && clicks > 0 ? round(spend / clicks) : null;
    return {
      ...metric,
      value,
      currency: 'CNY',
      status:
        value === null
          ? metric.value === null || metric.value === undefined
            ? metric.status
            : 'currency_unconfirmed'
          : spendMetric?.status === 'partial' || clickMetric?.status === 'partial'
            ? 'partial'
            : metric.status,
      breakdown: value === null ? [] : [{ currency: 'CNY', value }],
      detail: `${metric.detail || ''} 先按统计日汇率折算广告花费，再除以已返回点击数。`.trim(),
    };
  });
  const convertedMoneyMetrics = metrics.filter(
    (metric) => metric.unit === 'money' && toFiniteNumber(metric.value) !== null
  ).length;
  return {
    ...data,
    metrics,
    campaigns,
    dailyTrend,
    currencyConversion: {
      sourceCurrency: 'RUB',
      targetCurrency: 'CNY',
      status: convertedMoneyMetrics ? 'confirmed' : data.statisticsRead ? 'partial' : 'not_returned',
      fallbackDate: dateKey(fallbackDate) || null,
    },
  };
}

import { getOzonShopLabel } from '../../../entities/order/orderShopScope.jsx';

const RANGE_LABELS = Object.freeze({
  today: '今日',
  week: '近 7 天',
  month: '本月',
});

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metricValue(metric) {
  return toFiniteNumber(metric?.value);
}

function currencySymbol(currency = '') {
  return {
    CNY: '¥',
    RUB: '₽',
    USD: '$',
    EUR: '€',
    GBP: '£',
  }[String(currency || '').toUpperCase()] || `${String(currency || '').toUpperCase()} `;
}

export function formatDashboardMoney(value, currency = 'CNY', fallback = '待确认') {
  const number = toFiniteNumber(value);
  if (number === null) return fallback;
  return `${currencySymbol(currency)}${number.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDashboardPercent(value, fallback = '0.0%') {
  const number = toFiniteNumber(value);
  return number === null ? fallback : `${number.toFixed(1)}%`;
}

function createEmptyStoreRows(readableShops = []) {
  return readableShops.map((shop) => ({
    shopId: shop.id,
    name: getOzonShopLabel(shop),
    sales: '¥0.00',
    orders: 0,
    sharePercent: 0,
    status: '暂无期间订单',
  }));
}

export function createDashboardEmptySummary(readableShops = [], options = {}) {
  return {
    loaded: false,
    source: 'sqlite',
    scopeLabel: options.scopeLabel || '全部店铺',
    rangeKey: options.rangeKey || 'today',
    rangeLabel: RANGE_LABELS[options.rangeKey] || RANGE_LABELS.today,
    range: null,
    sourceUpdatedAt: null,
    generatedAt: null,
    freshnessSources: [],
    salesRows: [],
    salesOrderCount: 0,
    allOrderCount: 0,
    cancelledOrderCount: 0,
    salesTotalValue: null,
    salesCurrency: 'CNY',
    salesTotalDisplay: '待读取',
    salesDeltaPercent: null,
    averageOrderValue: null,
    averageOrderDisplay: '—',
    waitingDeliveryCount: 0,
    pendingPurchaseCount: 0,
    afterSalesTodoCount: 0,
    stockWarningCount: 0,
    outOfStockCount: 0,
    lowStockCount: 0,
    productIssueCount: 0,
    netProfitValue: null,
    netProfitStatus: 'not_returned',
    netProfitDisplay: '等待核算',
    profitCoverageValue: null,
    profitCoverageDisplay: '未覆盖',
    profitOrderCount: 0,
    profitReadyCount: 0,
    trendCategories: [],
    trendSalesData: [],
    trendOrderData: [],
    trendProfitData: [],
    hotProductRows: [],
    storePerformanceRows: createEmptyStoreRows(readableShops),
    businessShareCounts: {
      pendingPurchaseCount: 0,
      waitingDeliveryCount: 0,
      afterSalesTodoCount: 0,
      stockWarningCount: 0,
    },
  };
}

export function dashboardSummaryHasRows(summary = {}) {
  return Boolean(summary.loaded);
}

function resolveScopeLabel(payload = {}, readableShops = [], selectedShopId = 'all') {
  if (selectedShopId && selectedShopId !== 'all') {
    const selected = readableShops.find((shop) => String(shop.id) === String(selectedShopId));
    return selected ? getOzonShopLabel(selected) : payload?.scope?.shops?.[0]?.label || '当前店铺';
  }
  return `全部店铺（${payload?.scope?.shopIds?.length || readableShops.length}）`;
}

export function createDashboardSummaryFromOverview(payload = {}, readableShops = [], options = {}) {
  const metrics = payload?.metrics || {};
  const tasks = payload?.currentTasks || {};
  const salesAmountValue = metricValue(metrics.salesAmount);
  const salesCurrency = metrics.salesAmount?.currency || 'CNY';
  const netProfitValue = metricValue(metrics.actualNetProfit);
  const netProfitStatus = metrics.actualNetProfit?.status || 'not_returned';
  const profitCoverageValue = metricValue(metrics.actualNetProfitCoverage);
  const trend = Array.isArray(payload?.trend) ? payload.trend : [];
  const salesRows = (Array.isArray(payload?.latestOrders) ? payload.latestOrders : []).map((row) => ({
    ...row,
    shop: row.shopName,
    statusText: row.statusLabel,
    amountDisplay: formatDashboardMoney(row.amountValue, row.currency, '待确认'),
    date: row.occurredAt,
  }));
  const hotProductRows = (Array.isArray(payload?.hotProducts) ? payload.hotProducts : []).map((row) => ({
    ...row,
    profit: '利润需按订单确认',
  }));
  const storeColors = ['primary', 'success', 'warning', 'info'];
  const storePerformanceRows = (Array.isArray(payload?.shopPerformance) ? payload.shopPerformance : []).map(
    (row, index) => ({
      ...row,
      sales: formatDashboardMoney(row.salesValue, row.salesCurrency || salesCurrency, '—'),
      netProfit: formatDashboardMoney(row.netProfitValue, 'CNY', '等待核算'),
      status: row.orderCount ? '已读取' : '暂无期间订单',
      color: storeColors[index % storeColors.length],
    })
  );

  return {
    ...createDashboardEmptySummary(readableShops, options),
    loaded: true,
    scopeLabel: resolveScopeLabel(payload, readableShops, options.selectedShopId),
    rangeKey: options.rangeKey || 'today',
    rangeLabel: RANGE_LABELS[options.rangeKey] || RANGE_LABELS.today,
    range: payload?.scope?.range || null,
    sourceUpdatedAt: payload?.freshness?.sourceUpdatedAt || null,
    generatedAt: payload?.generatedAt || null,
    freshnessSources: Array.isArray(payload?.freshness?.sources) ? payload.freshness.sources : [],
    salesRows,
    salesOrderCount: metricValue(metrics.effectiveOrderCount) || 0,
    allOrderCount: metricValue(metrics.orderCount) || 0,
    cancelledOrderCount: metricValue(metrics.cancelledCount) || 0,
    salesTotalValue: salesAmountValue,
    salesCurrency,
    salesTotalDisplay: formatDashboardMoney(salesAmountValue, salesCurrency, '待确认'),
    salesDeltaPercent: toFiniteNumber(metrics.salesAmount?.delta?.percent),
    averageOrderValue: metricValue(metrics.averageOrderValue),
    averageOrderDisplay: formatDashboardMoney(
      metricValue(metrics.averageOrderValue),
      metrics.averageOrderValue?.currency || salesCurrency,
      '—'
    ),
    waitingDeliveryCount: Number(tasks.waitingDeliveryCount) || 0,
    pendingPurchaseCount: Number(tasks.pendingPurchaseCount) || 0,
    afterSalesTodoCount: Number(tasks.afterSalesTodoCount) || 0,
    stockWarningCount: Number(tasks.stockWarningCount) || 0,
    outOfStockCount: metricValue(metrics.outOfStockCount) || 0,
    lowStockCount: metricValue(metrics.lowStockCount) || 0,
    productIssueCount: Number(tasks.productIssueCount) || 0,
    netProfitValue,
    netProfitStatus,
    netProfitDisplay: formatDashboardMoney(netProfitValue, metrics.actualNetProfit?.currency || 'CNY', '等待核算'),
    profitCoverageValue,
    profitCoverageDisplay: formatDashboardPercent(profitCoverageValue, '未覆盖'),
    profitOrderCount: Number(metrics.profitLedgerRowCount) || 0,
    profitReadyCount: Number(metrics.profitLedgerReadyCount) || 0,
    trendCategories: trend.map((row) => row.label),
    trendSalesData: trend.map((row) => (row.salesStatus === 'confirmed' ? Number(row.salesValue) || 0 : 0)),
    trendOrderData: trend.map((row) => Number(row.orderCount) || 0),
    trendProfitData: trend.map((row) => (row.profitStatus === 'confirmed' ? Number(row.profitValue) || 0 : null)),
    hotProductRows,
    storePerformanceRows: storePerformanceRows.length ? storePerformanceRows : createEmptyStoreRows(readableShops),
    businessShareCounts: {
      pendingPurchaseCount: Number(tasks.pendingPurchaseCount) || 0,
      waitingDeliveryCount: Number(tasks.waitingDeliveryCount) || 0,
      afterSalesTodoCount: Number(tasks.afterSalesTodoCount) || 0,
      stockWarningCount: Number(tasks.stockWarningCount) || 0,
    },
  };
}

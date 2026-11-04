import {
  aggregatePromotionMetricRows,
  normalizePromotionMetricNumber,
} from './paidPromotionReportRows.js';

const BASE_METRIC_KEYS = ['impressions', 'clicks', 'spent', 'orders', 'revenue'];
const MONEY_METRIC_KEYS = new Set(['spent', 'revenue']);

function normalizeText(value) {
  return String(value ?? '').trim();
}

function isAuthoritativeDataSet(dataSet = null) {
  return ['success', 'empty'].includes(normalizeText(dataSet?.status).toLowerCase());
}

function isCompleteOrderReport(report = null) {
  return Boolean(report?.ok && report?.partial !== true && report?.complete !== false);
}

function metricTolerance(key) {
  return MONEY_METRIC_KEYS.has(key) ? 0.01 : 0;
}

function valuesMatch(key, left, right) {
  const normalizedLeft = normalizePromotionMetricNumber(left);
  const normalizedRight = normalizePromotionMetricNumber(right);
  if (normalizedLeft === null || normalizedRight === null) return false;
  return Math.abs(normalizedLeft - normalizedRight) <= metricTolerance(key);
}

function formatEvidenceNumber(value) {
  const number = normalizePromotionMetricNumber(value);
  if (number === null) return '未返回';
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function aggregateAuthoritativeRows(rows = [], dataSet = null) {
  if (!isAuthoritativeDataSet(dataSet)) return null;
  if (normalizeText(dataSet?.status).toLowerCase() === 'empty') {
    return Object.fromEntries(BASE_METRIC_KEYS.map((key) => [key, 0]));
  }
  return aggregatePromotionMetricRows(rows);
}

function getCampaignDateKey(row = {}) {
  const campaignId = normalizeText(row?.campaignId || row?.campaign_id);
  const date = normalizeText(row?.date || row?.day || row?.dateFrom || row?.date_from);
  return campaignId && date ? `${campaignId}:${date}` : '';
}

function hasCompleteExpenseCoverage(dailyRows = [], expenseRows = [], dailyDataSet = null, expenseDataSet = null) {
  if (!isAuthoritativeDataSet(dailyDataSet) || !isAuthoritativeDataSet(expenseDataSet)) return false;
  const positiveDailyKeys = new Set(
    (Array.isArray(dailyRows) ? dailyRows : [])
      .filter((row) => (normalizePromotionMetricNumber(row?.spent) ?? 0) > 0)
      .map(getCampaignDateKey)
      .filter(Boolean)
  );
  const expenseKeys = new Set((Array.isArray(expenseRows) ? expenseRows : []).map(getCampaignDateKey).filter(Boolean));
  if (!positiveDailyKeys.size) return expenseKeys.size === 0;
  return [...positiveDailyKeys].every((key) => expenseKeys.has(key));
}

function getDistinctPromotionProductCount(campaigns = []) {
  const identities = new Set();
  let anonymousCount = 0;
  for (const campaign of Array.isArray(campaigns) ? campaigns : []) {
    for (const product of Array.isArray(campaign?.products) ? campaign.products : []) {
      const sku = normalizeText(product?.sku || product?.ozonSku || product?.ozon_sku);
      const productId = normalizeText(product?.productId || product?.product_id);
      const offerId = normalizeText(product?.offerId || product?.offer_id);
      const identity = sku ? `sku:${sku}` : productId ? `product:${productId}` : offerId ? `offer:${offerId}` : '';
      if (identity) identities.add(identity);
      else anonymousCount += 1;
    }
  }
  return identities.size + anonymousCount;
}

function buildEvidenceState(key, sources = []) {
  const returnedSources = sources.filter((source) => normalizePromotionMetricNumber(source.value) !== null);
  if (!returnedSources.length) {
    return {
      state: 'missing',
      label: '未返回',
      note: '当前同店铺、同日期范围没有可核对的数据。',
      sources: [],
    };
  }
  if (returnedSources.length === 1) {
    return {
      state: 'single-source',
      label: '单一来源',
      note: `${returnedSources[0].label}返回 ${formatEvidenceNumber(returnedSources[0].value)}，暂无第二来源交叉核对。`,
      sources: returnedSources,
    };
  }
  const baseline = returnedSources[0];
  const mismatched = returnedSources.filter((source) => !valuesMatch(key, baseline.value, source.value));
  if (mismatched.length) {
    return {
      state: 'mismatch',
      label: '口径不一致',
      note: returnedSources.map((source) => `${source.label} ${formatEvidenceNumber(source.value)}`).join('；'),
      sources: returnedSources,
    };
  }
  return {
    state: 'verified',
    label: '已交叉核对',
    note: `${returnedSources.map((source) => source.label).join('、')}数值一致：${formatEvidenceNumber(
      baseline.value
    )}。`,
    sources: returnedSources,
  };
}

function getOrderReportSummary(report = null, rows = []) {
  const reportSummary = report?.summary || {};
  const safeRows = Array.isArray(rows) ? rows : [];
  const distinctOrderIds = new Set(safeRows.map((row) => normalizeText(row?.orderId)).filter(Boolean));
  const rowSummary = aggregatePromotionMetricRows(safeRows);
  const quantity = safeRows.reduce((total, row) => {
    const value = normalizePromotionMetricNumber(row?.quantity);
    return value === null ? total : total + value;
  }, 0);
  const rowCountFallback = distinctOrderIds.size || (safeRows.length ? safeRows.length : null);
  const hasReturnedOrderCount = Object.prototype.hasOwnProperty.call(reportSummary, 'orderCount');
  return {
    impressions: null,
    clicks: null,
    orders:
      hasReturnedOrderCount ? normalizePromotionMetricNumber(reportSummary.orderCount) : rowCountFallback,
    revenue: normalizePromotionMetricNumber(reportSummary.revenue) ?? rowSummary.revenue,
    spent: normalizePromotionMetricNumber(reportSummary.spent) ?? rowSummary.spent,
    rowCount: safeRows.length,
    quantity: safeRows.length ? quantity : null,
  };
}

export function verifyPromotionOverviewData(overview = {}) {
  const campaigns = Array.isArray(overview?.campaigns) ? overview.campaigns : [];
  const incomingSummary = overview?.summary || {};
  const dailySummary = aggregateAuthoritativeRows(overview?.dailyStats, overview?.dataSets?.dailyStatistics);
  const expenseSummary = aggregateAuthoritativeRows(overview?.expenseStats, overview?.dataSets?.expenseStatistics);
  const expenseComparable = hasCompleteExpenseCoverage(
    overview?.dailyStats,
    overview?.expenseStats,
    overview?.dataSets?.dailyStatistics,
    overview?.dataSets?.expenseStatistics
  );
  const cleanedSummary = { ...incomingSummary };
  for (const key of BASE_METRIC_KEYS) cleanedSummary[key] = normalizePromotionMetricNumber(incomingSummary?.[key]);

  // Campaign/status counts are verified against the exact campaign rows shown
  // on the page. This prevents a stale summary count from disagreeing with the
  // current list after a refresh or write/readback merge.
  const campaignCounts = {
    total: campaigns.length,
    running: campaigns.filter((campaign) => campaign?.statusLabel === '运行中').length,
    budgetExhausted: campaigns.filter((campaign) => campaign?.alerts?.budgetExhausted).length,
    reviewFailed: campaigns.filter((campaign) => campaign?.alerts?.moderationRejected).length,
  };
  Object.assign(cleanedSummary, campaignCounts);

  const productCatalogComplete =
    ['success', 'empty'].includes(normalizeText(overview?.dataSets?.campaignProducts?.status).toLowerCase()) ||
    (campaigns.length > 0 && campaigns.every((campaign) => campaign?.detailRead?.products === true));
  if (productCatalogComplete) {
    cleanedSummary.productCount = getDistinctPromotionProductCount(campaigns);
    cleanedSummary.productCountState = 'complete';
  } else {
    cleanedSummary.productCount = normalizePromotionMetricNumber(incomingSummary?.productCount);
  }

  const metrics = {};
  for (const key of ['total', 'running', 'budgetExhausted', 'reviewFailed']) {
    metrics[key] = buildEvidenceState(key, [
      { key: 'campaign-summary', label: '计划统计汇总', value: incomingSummary?.[key] },
      { key: 'campaign-list', label: '当前计划列表', value: campaignCounts[key] },
    ]);
  }
  metrics.productCount = buildEvidenceState(
    'productCount',
    productCatalogComplete
      ? [
          { key: 'campaign-summary', label: '商品统计汇总', value: incomingSummary?.productCount },
          { key: 'campaign-products', label: '推广商品列表', value: cleanedSummary.productCount },
        ]
      : [{ key: 'campaign-summary', label: '当前已回读商品', value: cleanedSummary.productCount }]
  );
  for (const key of BASE_METRIC_KEYS) {
    const sources = [
      { key: 'campaign-summary', label: '计划统计汇总', value: cleanedSummary[key] },
      ...(dailySummary ? [{ key: 'daily-statistics', label: '计划日报', value: dailySummary[key] }] : []),
      ...(key === 'spent' && expenseSummary && expenseComparable
        ? [{ key: 'expense-statistics', label: '花费明细', value: expenseSummary.spent }]
        : []),
    ];
    metrics[key] = buildEvidenceState(key, sources);
    if (key === 'spent' && expenseSummary && !expenseComparable) {
      metrics[key].note = `${metrics[key].note}；花费明细只覆盖部分计划/日期，未拿它与全店汇总硬比较。`;
    }
  }

  const derivedDependencies = {
    ctr: ['clicks', 'impressions'],
    cpc: ['spent', 'clicks'],
    acos: ['spent', 'revenue'],
    roas: ['revenue', 'spent'],
  };
  for (const [key, dependencyKeys] of Object.entries(derivedDependencies)) {
    const dependencyStates = dependencyKeys.map((dependencyKey) => metrics[dependencyKey]?.state);
    const state = dependencyStates.includes('mismatch')
      ? 'mismatch'
      : dependencyStates.every((dependencyState) => dependencyState === 'verified')
        ? 'verified'
        : dependencyStates.includes('missing')
          ? 'missing'
          : 'single-source';
    metrics[key] = {
      state,
      label:
        state === 'mismatch'
          ? '基础数据口径不一致'
          : state === 'verified'
            ? '由已核对数据计算'
            : state === 'missing'
              ? '基础数据未返回'
              : '由单一来源数据计算',
      note: `${dependencyKeys.map((dependencyKey) => metrics[dependencyKey]?.note).filter(Boolean).join('；')}`,
      sources: dependencyKeys.flatMap((dependencyKey) => metrics[dependencyKey]?.sources || []),
    };
  }

  const evidenceStates = Object.values(metrics).map((metric) => metric.state);
  const status = evidenceStates.includes('mismatch')
    ? 'mismatch'
    : evidenceStates.every((state) => state === 'verified')
      ? 'verified'
      : 'partial';
  return {
    status,
    label: status === 'mismatch' ? '存在口径不一致' : status === 'verified' ? '数据已交叉核对' : '部分数据待核对',
    summary: cleanedSummary,
    metrics,
    capturedAt: normalizeText(overview?.freshness?.capturedAt || overview?.finishedAt),
  };
}

export function verifyPromotionOrderReport({ overviewSummary = {}, report = null, rows = [], error = '' } = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const detailSummary = getOrderReportSummary(report, safeRows);
  const overviewOrders = normalizePromotionMetricNumber(overviewSummary?.orders);
  const overviewRevenue = normalizePromotionMetricNumber(overviewSummary?.revenue);
  const reportReturned = Boolean(report?.ok || report?.partial);
  const reportComplete = isCompleteOrderReport(report);
  const orderMismatch =
    reportComplete &&
    overviewOrders !== null &&
    detailSummary.orders !== null &&
    !valuesMatch('orders', overviewOrders, detailSummary.orders);
  const revenueMismatch =
    reportComplete &&
    overviewRevenue !== null &&
    detailSummary.revenue !== null &&
    !valuesMatch('revenue', overviewRevenue, detailSummary.revenue);

  let availability;
  if (report?.partial) {
    availability = { status: 'partial', tone: 'warning', label: '部分订单明细已返回' };
  } else if (reportComplete && (orderMismatch || revenueMismatch)) {
    availability = {
      status: 'mismatch',
      tone: 'warning',
      label:
        safeRows.length === 0 && (overviewOrders || 0) > 0
          ? `统计有 ${formatEvidenceNumber(overviewOrders)} 单，明细未返回`
          : '订单汇总与明细不一致',
    };
  } else if (reportComplete && safeRows.length) {
    availability = { status: 'success', tone: 'success', label: '订单汇总与明细一致' };
  } else if (reportComplete && overviewOrders === 0 && (overviewRevenue === null || overviewRevenue === 0)) {
    availability = { status: 'empty', tone: 'empty', label: '交叉核对后无推广订单' };
  } else if (reportComplete) {
    availability = { status: 'unverified', tone: 'warning', label: '订单明细为空，汇总待核对' };
  } else if (error) {
    availability = { status: 'failed', tone: 'error', label: '订单明细读取失败' };
  } else if (reportReturned) {
    availability = { status: 'partial', tone: 'warning', label: '部分订单明细已返回' };
  } else {
    availability = { status: 'skipped', tone: 'muted', label: '尚未读取订单明细' };
  }

  const displaySummary = safeRows.length
    ? detailSummary
    : {
        ...detailSummary,
        orders: overviewOrders,
        revenue: overviewRevenue,
        spent: normalizePromotionMetricNumber(overviewSummary?.spent),
      };
  const message =
    availability.status === 'mismatch' && safeRows.length === 0
      ? `Ozon 统计汇总确认有 ${formatEvidenceNumber(overviewOrders)} 单，但订单明细报表暂未返回；当前不生成虚假订单行。`
      : availability.status === 'mismatch'
        ? `Ozon 统计汇总为 ${formatEvidenceNumber(overviewOrders)} 单，订单明细为 ${formatEvidenceNumber(
            detailSummary.orders
          )} 单，当前存在接口口径差异。`
        : availability.status === 'empty'
          ? 'Ozon 统计汇总和订单明细均确认当前日期范围内没有推广订单。'
          : '';
  return {
    availability,
    summary: displaySummary,
    detailSummary,
    message,
    overviewOrders,
    detailOrders: detailSummary.orders,
  };
}

export function getPromotionMetricVerificationNote(verification = null, key = '') {
  return normalizeText(verification?.metrics?.[key]?.note);
}

import {
  formatDataAnalysisChineseText,
  formatDataAnalysisCount,
  formatDataAnalysisMetric,
  formatDataAnalysisMoney,
  formatDataAnalysisOperationType,
} from '../../dataAnalysis/lib/dataAnalysisFormatter.js';

const MARKETING_TYPE_LABELS = Object.freeze({
  ELASTIC_BOOSTING: '弹性促销',
  STOCK_DISCOUNT: '库存折扣',
  CURRENCY: '按金额优惠',
  PERCENT: '按比例优惠',
});

const AFTER_SALES_STATUS_LABELS = Object.freeze({
  MoneyReturned: '已退款',
  ReturnedToSeller: '已退回卖家',
  ReturningToSeller: '退回卖家途中',
  AcceptedFromCustomer: '已接收买家退货',
});

function text(value) {
  return String(value ?? '').trim();
}

function number(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.').replace(/[^\d.-]/gu, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstText(...values) {
  return values.map(text).find(Boolean) || '';
}

function section(title, rows = []) {
  return { title, rows: rows.map(text).filter(Boolean) };
}

function join(parts = []) {
  return parts.map(text).filter(Boolean).join('｜');
}

function count(value, unit = '') {
  return formatDataAnalysisCount(value, unit);
}

function money(value, currency = 'CNY') {
  if (value && typeof value === 'object') {
    return formatDataAnalysisMoney(value.value, value.currency || currency);
  }
  return formatDataAnalysisMoney(value, currency);
}

function dateOnly(value, fallback = '日期未返回') {
  const normalized = text(value);
  if (!normalized) return fallback;
  const exact = normalized.match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
  if (exact) return exact;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}

function chinese(value, fallback = '') {
  return formatDataAnalysisChineseText(value, fallback);
}

function productName(row = {}) {
  const name = firstText(row.name, row.productName, row.title);
  if (name) return chinese(name);
  const identifier = firstText(row.offerId, row.sku, row.productId);
  return identifier ? `商品名称未返回（商品标识 ${identifier}）` : '商品名称和商品标识均未返回';
}

function productIdentifiers(row = {}) {
  return [
    text(row.offerId) ? `商家货号 ${text(row.offerId)}` : '',
    text(row.sku) ? `商品编码 ${text(row.sku)}` : '',
    text(row.productId) ? `商品编号 ${text(row.productId)}` : '',
  ];
}

function formatMetricRows(value = {}) {
  return (Array.isArray(value.metrics) ? value.metrics : []).map((metric) => (
    `${chinese(metric.label, '经营指标名称未返回')}：${formatDataAnalysisMetric(metric)}`
  ));
}

function formatStatusRows(rows = [], unit = '项') {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const key = firstText(row.key, row.label, row.status);
    const label = key ? chinese(key) : '状态名称未返回';
    return join([label, `数量 ${count(row.count, unit)}`]);
  });
}

function formatSalesTrendRows(rows = []) {
  const normalized = (Array.isArray(rows) ? rows : []).filter((row) => [
    row.orderCount,
    row.effectiveOrderCount,
    row.cancelledOrderCount,
    row.itemCount,
    row.sales?.value,
  ].some((value) => (number(value) || 0) !== 0));
  return normalized.map((row) => join([
    dateOnly(row.date),
    `订单 ${count(row.orderCount, '单')}`,
    number(row.effectiveOrderCount) !== null ? `有效订单 ${count(row.effectiveOrderCount, '单')}` : '',
    number(row.cancelledOrderCount) !== null ? `取消 ${count(row.cancelledOrderCount, '单')}` : '',
    number(row.itemCount) !== null ? `商品 ${count(row.itemCount, '件')}` : '',
    row.sales ? `销售额 ${money(row.sales)}` : '',
  ]));
}

function formatProductRankingRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    number(row.rank) !== null ? `第 ${count(row.rank)} 名` : '',
    productName(row),
    ...productIdentifiers(row),
    number(row.quantity) !== null ? `销量 ${count(row.quantity, '件')}` : '',
    number(row.orderCount) !== null ? `订单 ${count(row.orderCount, '单')}` : '',
    row.sales ? `销售额 ${money(row.sales)}` : '',
  ]));
}

function formatStockRiskRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    productName(row),
    ...productIdentifiers(row),
    number(row.stock) !== null ? `库存 ${count(row.stock, '件')}` : '库存数量未返回',
    text(row.visibility) ? `状态 ${chinese(row.visibility)}` : '商品状态未返回',
    text(row.updatedAt) ? `更新 ${dateOnly(row.updatedAt)}` : '',
  ]));
}

function formatReplenishmentRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    productName(row),
    ...productIdentifiers(row),
    number(row.stock) !== null ? `库存 ${count(row.stock, '件')}` : '库存数量未返回',
    number(row.quantity) !== null ? `销量 ${count(row.quantity, '件')}` : '',
    number(row.orderCount) !== null ? `订单 ${count(row.orderCount, '单')}` : '',
    row.sales ? `销售额 ${money(row.sales)}` : '',
    text(row.visibility) ? `状态 ${chinese(row.visibility)}` : '',
  ]));
}

function formatCategoryRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    firstText(row.category, row.name, row.label) ? chinese(firstText(row.category, row.name, row.label)) : '类目名称未返回',
    `商品 ${count(row.count, '个')}`,
  ]));
}

function formatPriceBandRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    `价格区间 ${firstText(row.label, row.id) || '名称未返回'}`,
    `商品 ${count(row.count, '个')}`,
    number(row.min) !== null ? `最低 ${money(row.min, row.currency || 'CNY')}` : '',
    number(row.max) !== null ? `最高 ${money(row.max, row.currency || 'CNY')}` : '',
  ]));
}

function formatFinanceOperationRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    formatDataAnalysisOperationType(firstText(row.code, row.operationType, row.operationLabel)),
    number(row.count) !== null ? `发生 ${count(row.count, '笔')}` : '发生笔数未返回',
    row.amount !== undefined ? `合计 ${money(row.amount, row.currency || 'CNY')}` : '合计金额未返回',
  ]));
}

function formatLargestDeductionRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    dateOnly(firstText(row.operationDate, row.date, row.createdAt)),
    formatDataAnalysisOperationType(firstText(row.operationType, row.code, row.operationLabel)),
    text(row.postingNumber) ? `订单 ${text(row.postingNumber)}` : '未关联订单',
    row.amount !== undefined ? `扣费金额 ${money(row.amount, row.currency || 'CNY')}` : '扣费金额未返回',
    text(row.operationId) ? `流水号 ${text(row.operationId)}` : '流水号未返回',
  ]));
}

function formatAfterSalesReasonRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    firstText(row.reasonLabel, row.reason, row.label) ? chinese(firstText(row.reasonLabel, row.reason, row.label)) : '售后原因名称未返回',
    number(row.count) !== null ? `数量 ${count(row.count, '单')}` : '数量未返回',
    text(row.reasonId) ? `原因编号 ${text(row.reasonId)}` : '',
    typeof row.isDefect === 'boolean' ? (row.isDefect ? '质量问题' : '非质量问题') : '',
  ]));
}

function formatRecentAfterSalesRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const statusKey = firstText(row.statusLabel, AFTER_SALES_STATUS_LABELS[text(row.status)], row.status);
    return join([
      dateOnly(firstText(row.createdAt, row.date)),
      productName(row),
      ...productIdentifiers(row),
      statusKey ? `状态 ${chinese(statusKey)}` : '售后状态未返回',
      text(row.postingNumber) ? `订单 ${text(row.postingNumber)}` : '订单号未返回',
      row.amount !== undefined ? `商品金额 ${money(row.amount, row.currency || 'CNY')}` : '',
      text(row.returnId) ? `售后编号 ${text(row.returnId)}` : '售后编号未返回',
    ]);
  });
}

function marketingType(value) {
  const normalized = text(value);
  return MARKETING_TYPE_LABELS[normalized] || chinese(normalized, '活动类型未返回');
}

function formatMarketingTypeRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    marketingType(firstText(row.key, row.type, row.actionType)),
    `活动 ${count(row.count, '个')}`,
  ]));
}

function formatMarketingActivityRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    firstText(row.title, row.name, row.activityName) ? chinese(firstText(row.title, row.name, row.activityName)) : `活动名称未返回（活动编号 ${text(row.activityId) || '未返回'}）`,
    typeof row.active === 'boolean' ? (row.active ? '进行中' : '已结束') : '活动状态未返回',
    text(row.startDate) || text(row.endDate) ? `${dateOnly(row.startDate, '开始日期未返回')} 至 ${dateOnly(row.endDate, '结束日期未返回')}` : '',
    number(row.joinedCount) !== null ? `已参加商品 ${count(row.joinedCount, '个')}` : '',
    number(row.availableCount) !== null ? `可参加商品 ${count(row.availableCount, '个')}` : '',
    number(row.cachedProductCount) !== null ? `已读取商品 ${count(row.cachedProductCount, '个')}` : '',
    text(row.actionType) ? `类型 ${marketingType(row.actionType)}` : '',
    text(row.activityId) ? `活动编号 ${text(row.activityId)}` : '活动编号未返回',
  ]));
}

function formatMarketingProductRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => join([
    productName(row),
    ...productIdentifiers(row),
    text(row.rowStatus) ? `状态 ${chinese(row.rowStatus)}` : '',
    number(row.price) !== null ? `原价 ${money(row.price, row.currency || 'CNY')}` : '',
    number(row.activityPrice) !== null ? `活动价 ${money(row.activityPrice, row.currency || 'CNY')}` : '',
    number(row.discountAmount) !== null ? `优惠 ${money(row.discountAmount, row.currency || 'CNY')}` : '',
    number(row.stock) !== null ? `库存 ${count(row.stock, '件')}` : '',
    text(row.activityId) ? `活动编号 ${text(row.activityId)}` : '',
  ]));
}

export function buildOperationalReportSections(dashboard = {}, selected = 'all') {
  const definitions = {
    sales: [
      section('销售指标', formatMetricRows(dashboard.sales)),
      section('每日销售明细', formatSalesTrendRows(dashboard.sales?.trend)),
      section('销售状态', formatStatusRows(dashboard.sales?.statusBreakdown, '单')),
      section('商品销售排行', formatProductRankingRows(dashboard.sales?.productRanking)),
    ],
    products: [
      section('商品与库存指标', formatMetricRows(dashboard.products)),
      section('商品状态', formatStatusRows(dashboard.products?.visibilityBreakdown, '个商品')),
      section('类目分布', formatCategoryRows(dashboard.products?.categoryBreakdown)),
      section('价格区间', formatPriceBandRows(dashboard.products?.priceBands)),
      section('库存风险', formatStockRiskRows(dashboard.products?.stockRiskRows)),
      section('补货参考', formatReplenishmentRows(dashboard.products?.replenishmentRanking)),
    ],
    finance: [
      section('费用与结算指标', formatMetricRows(dashboard.finance)),
      section('费用构成', formatFinanceOperationRows(dashboard.finance?.operationBreakdown)),
      section('主要扣费明细', formatLargestDeductionRows(dashboard.finance?.largestDeductions)),
    ],
    afterSales: [
      section('售后指标', formatMetricRows(dashboard.afterSales)),
      section('售后状态', formatStatusRows(dashboard.afterSales?.statusBreakdown, '单')),
      section('售后原因', formatAfterSalesReasonRows(dashboard.afterSales?.reasonCodeBreakdown)),
      section('最近售后', formatRecentAfterSalesRows(dashboard.afterSales?.recentRows)),
    ],
    marketing: [
      section('营销指标', formatMetricRows(dashboard.marketing)),
      section('活动类型', formatMarketingTypeRows(dashboard.marketing?.activityTypeBreakdown)),
      section('营销活动', formatMarketingActivityRows(dashboard.marketing?.activityRows)),
      section('活动商品', formatMarketingProductRows(dashboard.marketing?.productRows)),
    ],
  };
  const keys = selected === 'all' || !definitions[selected] ? Object.keys(definitions) : [selected];
  return [section('经营概览', formatMetricRows(dashboard.overview)), ...keys.flatMap((key) => definitions[key])]
    .filter((item) => item.rows.length);
}

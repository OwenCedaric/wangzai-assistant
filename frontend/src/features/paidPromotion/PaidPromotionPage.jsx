import {
  executePerformanceAction,
  getDomainCache,
  getRubCnyDailyRate,
  listRubCnyRateCache,
  listPerformanceAccounts,
  readPerformanceAdvancedReport,
  readPerformanceOverview,
  readPerformanceOrders,
  readPerformanceProducts,
} from '../../api/localApiClient.js';
import { useSynchronizedOzonShopSelection } from '../../entities/order/useSynchronizedOzonShopSelection.jsx';
import { normalizeRubCnyRatePayload } from '../../services/exchangeRateClient.js';
import { mergePromotionProductRows } from './lib/paidPromotionProductRows.js';
import { mergePromotionCampaignSnapshot, mergePromotionSummary } from './lib/paidPromotionOverviewMerge.js';
import {
  getPromotionMetricVerificationNote,
  verifyPromotionOrderReport,
  verifyPromotionOverviewData,
} from './lib/paidPromotionDataVerification.js';
import {
  getPaidPromotionMetricValue,
} from './lib/paidPromotionMetrics.js';
import {
  formatCampaignMetric,
  formatCnyAmount,
  formatMetric,
  formatMoney,
  formatPercent,
  formatPlainNumber,
  formatPromotionMetric,
  getStatusTone,
  isMissingMetricValue,
  normalizeText,
} from './lib/paidPromotionFormatters.js';
import {
  aggregatePromotionMetricRows,
  buildCompletePromotionDailyTrend,
  getPromotionDataSetAvailability,
  getPromotionDataSetsAvailability,
  getPromotionScopedDataAvailability,
  mergePromotionExpenseRows,
  sortPromotionRowsNewestFirst,
} from './lib/paidPromotionReportRows.js';
import {
  ALL_PROMOTION_SCOPE,
  buildScopedPromotionOrderReport,
  filterPromotionRowsByCampaign,
  filterPromotionRowsByKeyword,
  filterPromotionRowsByProductScope,
  getPromotionProductScopeOptions,
} from './lib/paidPromotionScope.js';
import CampaignRounded from '@mui/icons-material/CampaignRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  CampaignListTable,
  PromotionMetricSummary,
  CampaignProductTable,
  TrendTable,
  CampaignObjectTable,
  AdvancedPerformanceReportTable,
  ExpenseTable,
  PromotionOrderTable,
  MediaStatsTable,
  DetailItem,
} from './components/PaidPromotionTables.jsx';

const PERFORMANCE_WRITE_CONFIRMATION_CODE = 'EXECUTE_OZON_PERFORMANCE_WRITE';
const PERFORMANCE_REALTIME_POLL_MS = 30_000;

function getShopLabel(shop = {}) {
  return shop.shopAlias || shop.alias || shop.name || shop.sellerName || shop.id || '当前店铺';
}

function buildPerformanceOverviewReadKey({
  accountId,
  shopId,
  dateFrom,
  dateTo,
  readDepth,
  campaignId,
  includeCampaignObjects,
  includeBidInsights,
} = {}) {
  return [
    normalizeText(accountId),
    normalizeText(shopId),
    normalizeText(dateFrom),
    normalizeText(dateTo),
    normalizeText(readDepth),
    normalizeText(campaignId),
    includeCampaignObjects === false ? 'no-objects' : 'with-objects',
    includeBidInsights === true ? 'with-bids' : 'no-bids',
  ].join('|');
}

function buildPerformanceOverviewSnapshotKey({ accountId, shopId, dateFrom, dateTo } = {}) {
  return [normalizeText(accountId), normalizeText(shopId), normalizeText(dateFrom), normalizeText(dateTo)].join('|');
}

// Renderer hot snapshots are scoped to one Performance account, Ozon shop and
// date range. They keep a previously verified screen visible while Ozon is
// slow, but never cross shops/accounts and never replace a fresh successful
// response.
const MAX_PERFORMANCE_HOT_SNAPSHOTS = 12;

function createPerformanceOverviewStore() {
  return new Map();
}

function mergePerformanceOverview(baseOverview, nextOverview) {
  if (!nextOverview?.ok) return baseOverview || nextOverview;
  if (!baseOverview?.ok) return nextOverview;
  const readDepth = normalizeText(nextOverview.readDepth);
  const nextCampaigns = Array.isArray(nextOverview.campaigns) ? nextOverview.campaigns : [];
  const baseCampaigns = Array.isArray(baseOverview.campaigns) ? baseOverview.campaigns : [];
  const baseCampaignById = new Map(baseCampaigns.map((campaign) => [normalizeText(campaign.id), campaign]));
  const mergeCampaign = (campaign) => {
    const previous = baseCampaignById.get(normalizeText(campaign.id));
    return mergePromotionCampaignSnapshot(previous, campaign);
  };
  const mergedCampaigns =
    readDepth === 'detail'
      ? baseCampaigns.map((campaign) => {
          const nextCampaign = nextCampaigns.find((item) => normalizeText(item.id) === normalizeText(campaign.id));
          return nextCampaign ? mergeCampaign(nextCampaign) : campaign;
        })
      : readDepth === 'catalog'
        ? baseCampaigns
        : nextCampaigns.map(mergeCampaign);
  const mergedDataSets = { ...(baseOverview.dataSets || {}) };
  // campaignProducts is a whole-account catalog in `products` reads. A
  // one-campaign detail response must not replace its authoritative count.
  const detailDataSetKeys = new Set(['campaignObjects', 'campaignBidInsights']);
  for (const [key, dataSet] of Object.entries(nextOverview.dataSets || {})) {
    if (readDepth === 'detail' && !detailDataSetKeys.has(key)) continue;
    if (dataSet?.status === 'skipped' && mergedDataSets[key]) continue;
    mergedDataSets[key] = dataSet;
  }
  const mergedDataCatalog = Object.values(mergedDataSets).map(({ rows, ...entry }) => entry);
  const preserveDashboardData = readDepth === 'detail' || readDepth === 'catalog';
  const keepBaseReferenceData = !['catalog', 'full'].includes(readDepth);
  const hasCompleteProductCatalog =
    normalizeText(mergedDataSets.campaignProducts?.status).toLowerCase() === 'success' ||
    (mergedCampaigns.length > 0 && mergedCampaigns.every((campaign) => campaign.detailRead?.products === true));
  const returnedProductCount = mergePromotionProductRows(mergedCampaigns).length;
  const mergedSummary = mergePromotionSummary(
    baseOverview.summary,
    preserveDashboardData ? baseOverview.summary : nextOverview.summary,
    { hasCompleteProductCatalog, productCount: returnedProductCount }
  );
  const mergedReadIssues = [...(baseOverview.readIssues || []), ...(nextOverview.readIssues || [])].filter(
    (issue, index, rows) =>
      rows.findIndex(
        (candidate) =>
          normalizeText(candidate?.kind) === normalizeText(issue?.kind) &&
          normalizeText(candidate?.campaignId) === normalizeText(issue?.campaignId) &&
          normalizeText(candidate?.endpoint) === normalizeText(issue?.endpoint) &&
          normalizeText(candidate?.message) === normalizeText(issue?.message)
      ) === index
  );
  return {
    ...baseOverview,
    ...nextOverview,
    summary: mergedSummary,
    ...(preserveDashboardData
      ? {
          dailyTrend: baseOverview.dailyTrend || [],
          dailyStats: baseOverview.dailyStats || [],
          campaignProductStats: baseOverview.campaignProductStats || [],
          productStats: baseOverview.productStats || [],
          expenseStats: baseOverview.expenseStats || [],
          mediaStats: baseOverview.mediaStats || [],
          searchPromoStats: baseOverview.searchPromoStats || [],
          searchPromoProductsReport: baseOverview.searchPromoProductsReport || null,
        }
      : {}),
    campaigns: mergedCampaigns,
    products: mergedCampaigns.flatMap((campaign) => campaign.products || []),
    objects: mergedCampaigns.flatMap((campaign) => campaign.objects || []),
    statisticsTasks: keepBaseReferenceData ? baseOverview.statisticsTasks || [] : nextOverview.statisticsTasks || [],
    externalReports: keepBaseReferenceData ? baseOverview.externalReports || [] : nextOverview.externalReports || [],
    ...(readDepth === 'catalog'
      ? {
          readDepth: baseOverview.readDepth,
          stages: baseOverview.stages || [],
          startedAt: baseOverview.startedAt,
          finishedAt: baseOverview.finishedAt,
        }
      : {}),
    readIssues: mergedReadIssues,
    dataCatalog: mergedDataCatalog,
    dataSets: mergedDataSets,
  };
}

function readPerformanceOverviewHotSnapshot(store, snapshotKey) {
  return store.get(normalizeText(snapshotKey)) || null;
}

function writePerformanceOverviewHotSnapshot(store, snapshotKey, payload) {
  const key = normalizeText(snapshotKey);
  if (!key || !payload?.ok) return;
  store.delete(key);
  store.set(key, payload);
  while (store.size > MAX_PERFORMANCE_HOT_SNAPSHOTS) {
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
  }
}

function toPerformanceAccounts(records = []) {
  return records
    .map((record, index) => {
      const values = record.values ?? {};
      const clientId = normalizeText(
        record.clientIdMasked || values.performanceClientId || values.clientId || values.client_id
      );
      const hasClientId = Boolean(record.hasClientId ?? clientId);
      const hasClientSecret = Boolean(record.hasClientSecret);
      return {
        id: record.id || `performance-${index + 1}`,
        title: record.title || record.name || values.platformName || `Ozon 推广接口 ${index + 1}`,
        meta: record.meta || values.apiType || '广告推广',
        clientId,
        configured: Boolean(hasClientId && hasClientSecret),
        hasClientId,
        hasClientSecret,
        shopId: normalizeText(record.shopId || values.shopId || values.shop_id),
      };
    })
    .filter((record) => record.configured);
}

function getLatestCachedRubCnyRate(payload = {}) {
  const records = Array.isArray(payload?.records) ? payload.records : [];
  return (
    records
      .map((record) => normalizeRubCnyRatePayload({ ...record, ok: true }))
      .filter(Boolean)
      .sort((left, right) =>
        String(right.date || right.requestedDate).localeCompare(String(left.date || left.requestedDate))
      )[0] || null
  );
}

function formatDateTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '未读取';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function toDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function offsetDateInputValue(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return toDateInputValue(date);
}

function getPerformanceReadErrorMessage(error) {
  const rawMessage = normalizeText(
    error?.payload?.error?.message || error?.payload?.message || error?.message || error
  );
  const errorCode = normalizeText(error?.payload?.error?.code || error?.code).toUpperCase();
  const message = rawMessage.toLowerCase();
  if (!rawMessage) return '推广数据读取失败，请稍后刷新。';
  if (
    message.includes('превышен лимит активных запросов') ||
    message.includes('too many') ||
    message.includes('active requests') ||
    message.includes('maximum 1') ||
    message.includes('максимум 1') ||
    message.includes('429')
  ) {
    return '请求过于频繁：Ozon 当前只允许同时读取 1 个推广请求，请稍后刷新。';
  }
  if (
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('invalid client') ||
    message.includes('client_id') ||
    message.includes('client_secret') ||
    message.includes('401') ||
    message.includes('403')
  ) {
    return '推广接口验证失败：请检查接口账号和接口密钥。';
  }
  if (
    errorCode.includes('PERFORMANCE_REMOTE_TIMEOUT') ||
    errorCode.includes('PERFORMANCE_REMOTE_NETWORK_FAILED') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('etimedout') ||
    message.includes('超过') ||
    message.includes('超时') ||
    message.includes('network') ||
    message.includes('fetch failed')
  ) {
    return 'Ozon 推广接口实时读取超时或网络波动，本次没有使用缓存数据，请稍后刷新。';
  }
  return '推广接口实时读取失败：本次没有使用缓存数据，请稍后刷新或检查接口配置。';
}

function getPerformanceActionErrorMessage(error) {
  const rawMessage = normalizeText(
    error?.payload?.error?.message || error?.payload?.message || error?.message || error
  );
  const readMessage = getPerformanceReadErrorMessage(error);
  if (readMessage.includes('请求过于频繁')) return readMessage;
  if (readMessage.includes('验证失败')) return readMessage;
  if (readMessage.includes('超时') || readMessage.includes('网络异常')) return readMessage;
  const code = normalizeText(error?.payload?.error?.code || error?.code).toUpperCase();
  if (code.includes('VALIDATION')) return rawMessage || '推广操作参数不完整，请检查后重试。';
  const message = rawMessage.toLowerCase();
  if (
    (message.includes('budget') || message.includes('бюджет') || message.includes('预算')) &&
    (message.includes('minimum') ||
      message.includes('minimal') ||
      message.includes('миним') ||
      message.includes('最低'))
  ) {
    return 'Ozon 拒绝修改预算：周预算低于当前计划按商品数计算的最低金额。';
  }
  if (
    message.includes('already added') ||
    message.includes('already exists') ||
    message.includes('уже добав') ||
    message.includes('已在')
  ) {
    return 'Ozon 拒绝添加商品：所选商品已经在当前推广计划中。';
  }
  if (
    (message.includes('sku') || message.includes('товар') || message.includes('商品')) &&
    (message.includes('not found') ||
      message.includes('invalid') ||
      message.includes('недоступ') ||
      message.includes('不可'))
  ) {
    return 'Ozon 拒绝商品操作：SKU 不存在、已下架或当前不可投放。';
  }
  if (rawMessage) {
    const compactMessage = rawMessage.length > 260 ? `${rawMessage.slice(0, 260)}…` : rawMessage;
    return compactMessage.startsWith('推广') || compactMessage.startsWith('Ozon')
      ? compactMessage
      : `Ozon 拒绝本次推广操作：${compactMessage}`;
  }
  return '推广操作失败：Ozon 未返回具体原因，请稍后重试。';
}

function getPerformanceOrdersErrorMessage(error) {
  const code = normalizeText(error?.payload?.error?.code || error?.code).toUpperCase();
  if (code === 'PERFORMANCE_ORDERS_REPORT_PENDING') {
    return 'Ozon 推广订单报表仍在生成，请稍后点击刷新。';
  }
  if (code === 'PERFORMANCE_ORDERS_REPORT_READ_FAILED') {
    return 'Ozon 推广订单报表读取失败，请稍后重新读取。';
  }
  return getPerformanceReadErrorMessage(error);
}

function formatPromotionProductCount(summary = {}) {
  const value = formatPlainNumber(summary.productCount);
  return summary.productCountState === 'partial' && value !== '未返回' ? `至少 ${value}` : value;
}

function buildSummaryCards(summary = {}, rubToCnyRate = null, verification = null) {
  const withVerification = (item, metricKey) => {
    const metric = verification?.metrics?.[metricKey] || null;
    const verificationCaption =
      metric?.state === 'verified'
        ? '已交叉核对'
        : metric?.state === 'mismatch'
          ? '口径不一致，悬停查看'
          : metric?.state === 'single-source'
            ? 'Ozon 单一来源'
            : metric?.state === 'missing'
              ? '数据未返回'
              : '';
    return {
      ...item,
      verificationState: metric?.state || 'unknown',
      verificationNote: getPromotionMetricVerificationNote(verification, metricKey),
      caption: verificationCaption ? `${item.caption} · ${verificationCaption}` : item.caption,
    };
  };
  return [
    withVerification(
      { label: '推广计划', value: formatPlainNumber(summary.total), caption: '实时读取计划数', tone: 'blue' },
      'total'
    ),
    withVerification(
      { label: '投放中', value: formatPlainNumber(summary.running), caption: '当前运行计划', tone: 'green' },
      'running'
    ),
    withVerification(
      { label: '已花费', value: formatMoney(summary.spent, rubToCnyRate), caption: '统计期汇总', tone: 'purple' },
      'spent'
    ),
    withVerification(
      { label: '销售额', value: formatMoney(summary.revenue, rubToCnyRate), caption: '统计期汇总', tone: 'cyan' },
      'revenue'
    ),
    withVerification({
      label: '广告投产比',
      value: formatPromotionMetric(summary, 'roas', formatMetric),
      caption: '销售额 ÷ 推广花费',
      tone: 'orange',
    }, 'roas'),
    withVerification({
      label: '广告费占比',
      value: formatPromotionMetric(summary, 'acos', formatPercent),
      caption: '推广花费 ÷ 销售额',
      tone: 'pink',
    }, 'acos'),
    withVerification(
      { label: '点击', value: formatPlainNumber(summary.clicks), caption: '统计期汇总', tone: 'slate' },
      'clicks'
    ),
    withVerification({
      label: '点击率',
      value: formatPromotionMetric(summary, 'ctr', formatPercent),
      caption: '点击 ÷ 展示',
      tone: 'slate',
    }, 'ctr'),
    withVerification({
      label: '单次点击成本',
      value: formatPromotionMetric(summary, 'cpc', formatMoney, rubToCnyRate),
      caption: '推广花费 ÷ 点击',
      tone: 'slate',
    }, 'cpc'),
    withVerification(
      { label: '订单', value: formatPlainNumber(summary.orders), caption: '统计期汇总', tone: 'slate' },
      'orders'
    ),
    withVerification({
      label: '推广商品',
      value: formatPromotionProductCount(summary),
      caption: summary.productCountState === 'partial' ? '当前已回读商品数' : '计划内商品数',
      tone: 'slate',
    }, 'productCount'),
    withVerification(
      { label: '预算花完', value: formatPlainNumber(summary.budgetExhausted), caption: '已接入小铃铛', tone: 'warning' },
      'budgetExhausted'
    ),
    withVerification(
      { label: '审核不通过', value: formatPlainNumber(summary.reviewFailed), caption: '已接入小铃铛', tone: 'danger' },
      'reviewFailed'
    ),
    withVerification(
      { label: '展示', value: formatPlainNumber(summary.impressions), caption: '统计期汇总', tone: 'slate' },
      'impressions'
    ),
  ];
}

function getUniqueOptions(rows, key) {
  return [...new Set(rows.map((row) => normalizeText(row[key])).filter(Boolean))];
}

function getCampaignMetric(campaign = {}, key) {
  return getPaidPromotionMetricValue(campaign, key);
}

function findDialogProductBySku(rows = [], sku = '') {
  const target = normalizeText(sku);
  return rows.find((row) => normalizeText(row.sku) === target) ?? null;
}

function resolveBidForSku({ sku, bidSource, manualBid, rows }) {
  if (bidSource === 'empty') return '';
  if (bidSource === 'recommended') return findDialogProductBySku(rows, sku)?.recommendedBid ?? '';
  if (bidSource === 'competitive') return findDialogProductBySku(rows, sku)?.competitiveBid ?? '';
  if (bidSource === 'minCpo') return findDialogProductBySku(rows, sku)?.minCpoBid ?? '';
  if (bidSource === 'minimumCpc') return findDialogProductBySku(rows, sku)?.minimumCpcBid ?? '';
  return manualBid;
}

function getSelectedCampaignTrend(campaign, overview) {
  if (campaign) {
    const dailyTrend = Array.isArray(campaign?.statistics?.dailyTrend) ? campaign.statistics.dailyTrend : [];
    if (dailyTrend.length) return dailyTrend;
    return Array.isArray(campaign?.statistics?.rows) ? campaign.statistics.rows : [];
  }
  return Array.isArray(overview?.dailyTrend) ? overview.dailyTrend : [];
}

function normalizeComparableMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isSameBudgetAmount(readValue, submittedRubles) {
  const current = normalizeComparableMoney(readValue);
  const expected = normalizeComparableMoney(submittedRubles);
  if (current === null || expected === null) return false;
  const candidates = [expected, expected * 1_000_000, expected / 1_000_000];
  return candidates.some((item) => Math.abs(current - item) < 0.01);
}

function getCampaignBudgetValue(campaign = {}, budgetKind = '') {
  if (budgetKind === 'weeklyBudget') return campaign.weeklyBudget ?? campaign.budget;
  if (budgetKind === 'dailyBudget') return campaign.dailyBudget ?? campaign.budget;
  return campaign.totalBudget ?? campaign.budget;
}

function normalizePromotionProductCandidate(row = {}) {
  return {
    key: normalizeText(row.sku || row.productId || row.product_id || row.offerId || row.offer_id),
    sku: normalizeText(row.sku),
    sourceSku: normalizeText(row.sourceSku || row.source_sku),
    offerId: normalizeText(row.offerId || row.offer_id || row.sourceSku || row.source_sku),
    productId: normalizeText(row.productId || row.product_id),
    name: normalizeText(row.name || row.title) || '未返回商品名',
    image: row.primaryImageUrl || row.primary_image || row.image || row.imageUrl || row.images?.[0] || '',
    stockValue: row.stockValue ?? row.stock_value ?? row.stock?.present ?? '',
    visibility: normalizeText(row.visibility || row.statusLabel || row.status_label || row.status),
    available: row.available !== false,
    recommendedBid: row.recommendedBid ?? null,
    competitiveBid: row.competitiveBid ?? null,
    minCpoBid: row.minCpoBid ?? null,
    minimumCpcBid: row.minimumCpcBid ?? null,
    previousBid: row.previousBid ?? null,
    price: row.price ?? null,
    visibilityIndex: row.visibilityIndex ?? '',
    source: row.source || 'performance',
  };
}

const PERFORMANCE_WEEKLY_BUDGET_PER_SKU_RUBLES = 2000;
const NON_PROMOTABLE_PRODUCT_STATUSES = '待销售,错误品,待修改,违规品,已下架';

function normalizeSellerPromotionProductCandidate(row = {}) {
  const visibility = normalizeText(
    row.visibility || row.productSnapshotVisibility || row.snapshotVisibilities?.[0] || row.status
  ).toUpperCase();
  const statusLabel = normalizeText(row.statusLabel || row.status_label);
  const sku = normalizeText(row.sku);
  const available = Boolean(sku && /^\d+$/u.test(sku) && (visibility === 'IN_SALE' || statusLabel === '出售中'));
  return normalizePromotionProductCandidate({
    ...row,
    title: row.name || row.title,
    available,
    source: 'ozon-seller-products',
  });
}

function getPromotionCampaignProductCount(campaign = {}, products = []) {
  const skuCount = new Set(
    (Array.isArray(products) ? products : []).map((row) => normalizeText(row?.sku)).filter(Boolean)
  ).size;
  if (skuCount > 0) return skuCount;
  const reportedCount = Number(campaign?.productCount ?? campaign?.productsCount ?? campaign?.skuCount);
  return Number.isFinite(reportedCount) && reportedCount > 0 ? Math.floor(reportedCount) : 1;
}

function getMinimumWeeklyBudgetRubles(productCount = 1) {
  return Math.max(1, Number(productCount) || 1) * PERFORMANCE_WEEKLY_BUDGET_PER_SKU_RUBLES;
}

function getWeeklyBudgetValidationMessage(action, payload = {}, campaignProductCount = 1) {
  if (normalizeText(payload.paymentType).toUpperCase() === 'CPO') return '';
  let rawValue = '';
  let productCount = campaignProductCount;
  if (action === 'createCampaign' || action === 'editCampaign') {
    rawValue = payload.weeklyBudgetRubles;
    if (action === 'createCampaign') productCount = payload.bids?.length || 1;
  } else if (action === 'updateBudget' && payload.budgetKind === 'weeklyBudget') {
    rawValue = payload.budgetRubles;
  } else {
    return '';
  }
  if (rawValue === '' || rawValue === null || rawValue === undefined) return '';
  const amount = Number(rawValue);
  if (!Number.isFinite(amount) || amount < 0) return '预算金额必须是大于或等于 0 的数字。';
  if (amount === 0) return '';
  const minimum = getMinimumWeeklyBudgetRubles(productCount);
  return amount < minimum
    ? `当前 ${Math.max(1, Number(productCount) || 1)} 个商品的周预算至少为 ${minimum} 卢布；0 表示取消限制。`
    : '';
}

function normalizeCampaignProductForPicker(row = {}) {
  const sku = normalizeText(row.sku || row.ozonSku || row.productSku);
  return {
    key: normalizeText(row.id || sku || row.offerId || row.offer_id),
    sku,
    offerId: normalizeText(row.offerId || row.offer_id),
    productId: normalizeText(row.productId || row.product_id),
    name: normalizeText(row.title || row.name) || '未返回商品名',
    image: row.image || row.imageUrl || row.primaryImageUrl || '',
    stockValue: row.stockValue ?? row.stock_value ?? '',
    visibility: normalizeText(row.statusLabel || row.status),
    bid: row.bid,
    recommendedBid: row.recommendedBid ?? null,
    competitiveBid: row.competitiveBid ?? null,
    minCpoBid: row.minCpoBid ?? null,
    minimumCpcBid: row.minimumCpcBid ?? null,
    previousBid: row.previousBid ?? null,
    price: row.price ?? null,
    visibilityIndex: row.visibilityIndex ?? '',
    clicks: row.clicks ?? null,
    spent: row.spent ?? null,
    orders: row.orders ?? null,
    acos: row.acos ?? null,
    ctr: row.ctr ?? null,
    cpc: row.cpc ?? null,
  };
}

const createPlanAction = {
  action: 'createCampaign',
  title: '创建推广计划',
  shortTitle: '创建计划',
  desc: '填写计划参数后立即提交 Ozon，并自动回读确认。',
};

const detailOperationItems = [
  { action: 'editCampaign', title: '编辑推广周期', shortTitle: '改周期', desc: '修改计划开始或结束日期。' },
  {
    action: 'addProducts',
    title: '添加商品到推广计划',
    shortTitle: '加商品',
    desc: '从当前店铺商品中选择商品，批量添加到当前推广计划。',
  },
  {
    action: 'removeProducts',
    title: '移除推广商品',
    shortTitle: '移除',
    desc: '从当前推广计划中选择商品移除，提交后回读确认。',
  },
  { action: 'updateBudget', title: '修改预算', shortTitle: '改预算', desc: '修改前后对比，回读确认后才显示完成。' },
  {
    action: 'setProductBids',
    title: '调整出价',
    shortTitle: '调出价',
    desc: '支持按商品批量调价，提交后立即生效并回读。',
  },
  {
    action: 'setSearchPromoBids',
    title: '设置搜索推广出价',
    shortTitle: '搜索出价',
    desc: '使用搜索推广新版出价接口，提交后立即写入。',
  },
  {
    action: 'deleteSearchPromoBids',
    title: '删除搜索推广出价',
    shortTitle: '删搜索价',
    desc: '从搜索推广中删除已选商品的出价。',
  },
  {
    action: 'toggleSearchPromoProduct',
    title: '开启 / 关闭商品搜索推广',
    shortTitle: '搜推启停',
    desc: '按商品开启或关闭搜索推广。',
  },
  { action: 'toggleCampaign', title: '启动 / 暂停', shortTitle: '启停', desc: '提交后立即启停，并回读最新状态。' },
];

const searchPromotionOperationItems = [
  ...detailOperationItems.filter((item) =>
    ['setSearchPromoBids', 'deleteSearchPromoBids', 'toggleSearchPromoProduct'].includes(item.action)
  ),
  {
    action: 'toggleAllSkuPromo',
    title: '开启 / 关闭全店按订单付费',
    shortTitle: '全店启停',
    desc: '直接调用 Ozon 全店按订单付费推广启停接口。',
  },
  {
    action: 'setAllSkuPromoBid',
    title: '设置全店按订单付费费率',
    shortTitle: '全店费率',
    desc: '按 Ozon 允许的 5%、7% 或 9% 设置全店费率。',
  },
  {
    action: 'toggleCarrots',
    title: '加入 / 退出 Морковск 活动',
    shortTitle: '活动启停',
    desc: '选择商品后直接加入或退出 Ozon Морковск 活动。',
  },
];

const GLOBAL_SEARCH_PROMO_ACTIONS = new Set([
  'setSearchPromoBids',
  'deleteSearchPromoBids',
  'toggleSearchPromoProduct',
  'toggleAllSkuPromo',
  'setAllSkuPromoBid',
  'toggleCarrots',
]);

function findCampaignByIdOrTitle(overview, campaignId, campaignTitle) {
  const rows = Array.isArray(overview?.campaigns) ? overview.campaigns : [];
  const id = normalizeText(campaignId);
  const title = normalizeText(campaignTitle);
  return (
    rows.find((campaign) => normalizeText(campaign.id) === id && id) ??
    rows.find((campaign) => normalizeText(campaign.title) === title && title) ??
    null
  );
}

function getSelectedSkusFromPayload(payload = {}) {
  if (Array.isArray(payload.selectedSkus)) return payload.selectedSkus.map(normalizeText).filter(Boolean);
  if (Array.isArray(payload.skus)) return payload.skus.map(normalizeText).filter(Boolean);
  if (Array.isArray(payload.sku)) return payload.sku.map(normalizeText).filter(Boolean);
  if (Array.isArray(payload.bids)) return payload.bids.map((item) => normalizeText(item?.sku)).filter(Boolean);
  const sku = normalizeText(payload.sku);
  return sku ? [sku] : [];
}

function getPerformanceWriteReadbackMessage({
  action,
  actionPayload,
  refreshedOverview,
  fallbackMessage,
  createdCampaignId,
}) {
  if (!refreshedOverview?.ok) return `${fallbackMessage}；实时回读失败，请稍后刷新核对。`;
  const campaignId = createdCampaignId || actionPayload.campaignId;
  const campaign = findCampaignByIdOrTitle(
    refreshedOverview,
    campaignId,
    actionPayload.campaignTitle || actionPayload.title
  );
  if (action === 'createCampaign') {
    if (campaign && actionPayload.bids?.length) {
      const skus = getSelectedSkusFromPayload(actionPayload);
      const productSkuSet = new Set((campaign.products || []).map((product) => normalizeText(product.sku)));
      const allVisible = skus.length > 0 && skus.every((sku) => productSkuSet.has(sku));
      return allVisible
        ? '创建计划和添加商品已提交，并已完成 Ozon 实时回读确认。'
        : '创建计划已完成回读确认，商品添加本次回读暂未全部出现，请稍后刷新核对。';
    }
    return campaign
      ? '创建计划已提交，并已完成 Ozon 实时回读确认。'
      : '创建计划已提交，但本次回读暂未看到新计划，请稍后刷新核对。';
  }
  if (!campaign) return `${fallbackMessage}；本次回读暂未找到对应计划，请稍后刷新核对。`;
  if (action === 'addProducts') {
    const skus = getSelectedSkusFromPayload(actionPayload);
    const productSkuSet = new Set((campaign.products || []).map((product) => normalizeText(product.sku)));
    const allVisible = skus.length > 0 && skus.every((sku) => productSkuSet.has(sku));
    return allVisible
      ? '添加商品已提交，并已完成 Ozon 实时回读确认。'
      : '添加商品已提交，本次回读暂未看到全部商品，请稍后刷新核对。';
  }
  if (action === 'removeProducts') {
    const skus = getSelectedSkusFromPayload(actionPayload);
    const productSkuSet = new Set((campaign.products || []).map((product) => normalizeText(product.sku)));
    const allRemoved = skus.length > 0 && skus.every((sku) => !productSkuSet.has(sku));
    return allRemoved
      ? '移除商品已提交，并已完成 Ozon 实时回读确认。'
      : '移除商品已提交，本次回读仍看到部分商品，请稍后刷新核对。';
  }
  if (action === 'toggleCampaign') {
    const expectedRunning = actionPayload.mode === 'activate';
    const confirmed = expectedRunning
      ? campaign.statusLabel === '运行中'
      : ['已暂停', '已停止', '已结束'].includes(campaign.statusLabel);
    return confirmed
      ? `${fallbackMessage}；已完成 Ozon 实时回读确认。`
      : `${fallbackMessage}；已刷新回读结果，请以页面状态为准。`;
  }
  if (action === 'updateBudget') {
    const budgetKind = normalizeText(actionPayload.budgetKind || 'weeklyBudget');
    const currentBudget = getCampaignBudgetValue(campaign, budgetKind);
    if (isSameBudgetAmount(currentBudget, actionPayload.budgetRubles)) {
      return '预算修改已提交，并已完成 Ozon 实时回读确认。';
    }
    return currentBudget !== null && currentBudget !== undefined
      ? '预算修改已提交，已回读到计划预算字段，请以页面当前显示为准。'
      : '预算修改已提交，本次回读未返回对应预算字段，请稍后刷新核对。';
  }
  if (action === 'setProductBids') {
    const expectedBids = Array.isArray(actionPayload.bids) ? actionPayload.bids : [];
    const skus = expectedBids.map((item) => normalizeText(item?.sku)).filter(Boolean);
    const products = campaign.products || [];
    const allMatched =
      expectedBids.length > 0 &&
      expectedBids.every((expected) => {
        const product = products.find((item) => normalizeText(item.sku) === normalizeText(expected.sku));
        if (!product) return false;
        if (!normalizeText(expected.bid)) return true;
        return isSameBudgetAmount(product.bid, expected.bid);
      });
    return allMatched
      ? '商品出价已提交，并已完成 Ozon 精确回读确认。'
      : `${fallbackMessage}；商品出价尚未精确回读为提交值。`;
  }
  if (action === 'editCampaign') {
    const expectedTitle = normalizeText(actionPayload.title);
    const titleMatched = !expectedTitle || normalizeText(campaign.title) === expectedTitle;
    const fromMatched =
      !normalizeText(actionPayload.fromDate) ||
      normalizeText(campaign.fromDate) === normalizeText(actionPayload.fromDate);
    const toMatched =
      !normalizeText(actionPayload.toDate) || normalizeText(campaign.toDate) === normalizeText(actionPayload.toDate);
    const placementMatched =
      !normalizeText(actionPayload.placement) ||
      normalizeText(campaign.placementCode) === normalizeText(actionPayload.placement);
    const strategyMatched =
      !normalizeText(actionPayload.productAutopilotStrategy) ||
      normalizeText(campaign.strategyCode) === normalizeText(actionPayload.productAutopilotStrategy);
    return titleMatched && fromMatched && toMatched && placementMatched && strategyMatched
      ? '计划编辑已提交，并已完成 Ozon 精确回读确认。'
      : `${fallbackMessage}；计划字段尚未全部精确回读为提交值。`;
  }
  if (['setSearchPromoBids', 'deleteSearchPromoBids', 'toggleSearchPromoProduct'].includes(action)) {
    return `${fallbackMessage}；当前页面回读不代替搜索推广全局 SKU 回读。`;
  }
  return `${fallbackMessage}；已完成 Ozon 实时回读刷新。`;
}

const placementOptions = [
  { value: 'PLACEMENT_SEARCH_AND_CATEGORY', label: '搜索和推荐' },
  { value: 'PLACEMENT_TOP_PROMOTION', label: '搜索置顶' },
  { value: 'PLACEMENT_INVALID', label: '未指定' },
];

const strategyOptions = [
  { value: 'MAX_CLICKS', label: '最大点击量' },
  { value: 'TOP_MAX_CLICKS', label: '搜索最大点击量' },
  { value: 'TARGET_BIDS', label: '平均点击成本' },
  { value: 'TOP_PROMOTION', label: '顶部推广' },
  { value: 'TARGET_CIR', label: '目标广告成本比' },
];

const bidSourceOptions = [
  { value: 'minimumCpc', label: '最低 CPC 出价', desc: '使用 Ozon 最低出价接口返回的当前最低 CPC。' },
  { value: 'recommended', label: '推荐出价', desc: '优先使用 Ozon 推广接口返回的推荐出价。' },
  { value: 'competitive', label: '竞争出价', desc: '优先使用当前计划的竞争出价。' },
  { value: 'minCpo', label: '最低订单出价', desc: '优先使用搜索推广接口返回的最低订单出价。' },
  { value: 'manual', label: '手动统一出价', desc: '所有已选商品使用同一个出价。' },
  { value: 'empty', label: 'Ozon 自动竞争出价', desc: '添加 CPC 商品时不传 bid，由 Ozon 自动设置竞争出价。' },
];

const promotionTabs = [
  { value: 'plans', label: '推广计划' },
  { value: 'products', label: '商品投放' },
  { value: 'objects', label: '投放对象' },
  { value: 'search', label: '搜索推广' },
  { value: 'stats', label: '统计报表' },
];

const reportViewOptions = [
  { value: 'trend', label: '日报趋势' },
  { value: 'orders', label: '推广订单' },
  { value: 'products', label: '商品效果' },
  { value: 'expense', label: '花费明细' },
  { value: 'media', label: '媒体统计' },
  { value: 'allSkuOrders', label: '全店订单' },
  { value: 'allSkuProducts', label: '全店商品' },
  { value: 'phrases', label: '搜索词' },
  { value: 'attribution', label: '归因统计' },
  { value: 'video', label: '视频统计' },
  { value: 'vendorTraffic', label: '外部流量' },
  { value: 'vendorOrders', label: '外部订单' },
];

const advancedReportViews = new Set([
  'allSkuOrders',
  'allSkuProducts',
  'phrases',
  'attribution',
  'video',
  'vendorTraffic',
  'vendorOrders',
]);

export function PaidPromotionPage({ shops = [], activeShopId = '', isActive = true, onNotificationsRefresh }) {
  const [accounts, setAccounts] = React.useState([]);
  const configuredAccounts = React.useMemo(() => accounts.filter((account) => account.configured), [accounts]);
  const [selectedAccountId, setSelectedAccountId] = React.useState('');
  const [activePromotionTab, setActivePromotionTab] = React.useState('plans');
  const [activeReportView, setActiveReportView] = React.useState('trend');
  const [overview, setOverview] = React.useState(null);
  const [selectedCampaignId, setSelectedCampaignId] = React.useState('');
  const [campaignKeyword, setCampaignKeyword] = React.useState('');
  const [productKeyword, setProductKeyword] = React.useState('');
  const [objectProductScope, setObjectProductScope] = React.useState(ALL_PROMOTION_SCOPE);
  const [reportCampaignId, setReportCampaignId] = React.useState(ALL_PROMOTION_SCOPE);
  const [reportProductKeyword, setReportProductKeyword] = React.useState('');
  const [productSortKey, setProductSortKey] = React.useState('spent');
  const [productSortDir, setProductSortDir] = React.useState('desc');
  const [statusFilter, setStatusFilter] = React.useState('全部状态');
  const [typeFilter, setTypeFilter] = React.useState('全部类型');
  const [dateFrom, setDateFrom] = React.useState(() => offsetDateInputValue(-6));
  const [dateTo, setDateTo] = React.useState(() => toDateInputValue());
  const [loading, setLoading] = React.useState(false);
  const [campaignDetailLoadingKeys, setCampaignDetailLoadingKeys] = React.useState({});
  const [error, setError] = React.useState('');
  const [actionNotice, setActionNotice] = React.useState('');
  const [writeDialog, setWriteDialog] = React.useState({
    open: false,
    action: '',
    title: '',
    values: {},
  });
  const [writeLoading, setWriteLoading] = React.useState(false);
  const [writeError, setWriteError] = React.useState('');
  const [productPickerRows, setProductPickerRows] = React.useState([]);
  const [productPickerTotal, setProductPickerTotal] = React.useState(0);
  const [productPickerPage, setProductPickerPage] = React.useState(1);
  const [productPickerHasNext, setProductPickerHasNext] = React.useState(false);
  const [productPickerAvailability, setProductPickerAvailability] = React.useState('all');
  const [productPickerLoading, setProductPickerLoading] = React.useState(false);
  const [rubCnyRateInfo, setRubCnyRateInfo] = React.useState(null);
  const [exchangeRateStatus, setExchangeRateStatus] = React.useState('人民币汇率读取中');
  const [promotionOrders, setPromotionOrders] = React.useState(null);
  const [promotionOrdersLoading, setPromotionOrdersLoading] = React.useState(false);
  const [promotionOrdersError, setPromotionOrdersError] = React.useState('');
  const [advancedReport, setAdvancedReport] = React.useState(null);
  const [advancedReportLoading, setAdvancedReportLoading] = React.useState(false);
  const [advancedReportError, setAdvancedReportError] = React.useState('');
  const overviewReadsRef = React.useRef(new Map());
  const promotionOrderReadsRef = React.useRef(new Map());
  const promotionOrdersScopeKeyRef = React.useRef('');
  const visibleOverviewReadCountRef = React.useRef(0);
  const overviewByScopeRef = React.useRef(createPerformanceOverviewStore());
  const overviewReadGenerationRef = React.useRef(0);
  const accountReadGenerationRef = React.useRef(0);
  const overviewRef = React.useRef(null);
  const overviewScopeKeyRef = React.useRef('');
  const rubToCnyRate = rubCnyRateInfo?.rubToCnyRate ?? null;
  const shopOptions = React.useMemo(() => shops.filter((shop) => shop?.id), [shops]);
  const resetPromotionShopScope = React.useCallback(() => {
    overviewReadGenerationRef.current += 1;
    accountReadGenerationRef.current += 1;
    overviewReadsRef.current.clear();
    promotionOrderReadsRef.current.clear();
    promotionOrdersScopeKeyRef.current = '';
    visibleOverviewReadCountRef.current = 0;
    overviewRef.current = null;
    overviewScopeKeyRef.current = '';
    setSelectedAccountId('');
    setOverview(null);
    setSelectedCampaignId('');
    setActiveReportView('trend');
    setCampaignKeyword('');
    setProductKeyword('');
    setObjectProductScope(ALL_PROMOTION_SCOPE);
    setReportCampaignId(ALL_PROMOTION_SCOPE);
    setReportProductKeyword('');
    setStatusFilter('全部状态');
    setTypeFilter('全部类型');
    setError('');
    setActionNotice('');
    setLoading(false);
    setCampaignDetailLoadingKeys({});
    setWriteDialog({ open: false, action: '', title: '', values: {} });
    setWriteLoading(false);
    setWriteError('');
    setProductPickerRows([]);
    setProductPickerTotal(0);
    setProductPickerPage(1);
    setProductPickerHasNext(false);
    setProductPickerLoading(false);
    setPromotionOrders(null);
    setPromotionOrdersLoading(false);
    setPromotionOrdersError('');
    setAdvancedReport(null);
    setAdvancedReportLoading(false);
    setAdvancedReportError('');
  }, []);
  const [selectedShopId, setSelectedShopId] = useSynchronizedOzonShopSelection({
    shops: shopOptions,
    activeShopId,
    allValue: shopOptions[0]?.id || '',
    onScopeChange: resetPromotionShopScope,
  });
  const shopScopedAccounts = React.useMemo(
    () => configuredAccounts.filter((account) => account.shopId === selectedShopId),
    [configuredAccounts, selectedShopId]
  );
  const activeShop = React.useMemo(
    () => shops.find((shop) => shop.id === selectedShopId) ?? {},
    [selectedShopId, shops]
  );
  const selectedAccount = React.useMemo(
    () => shopScopedAccounts.find((account) => account.id === selectedAccountId) ?? shopScopedAccounts[0] ?? null,
    [selectedAccountId, shopScopedAccounts]
  );
  const campaigns = React.useMemo(() => (Array.isArray(overview?.campaigns) ? overview.campaigns : []), [overview]);
  const statusOptions = React.useMemo(() => getUniqueOptions(campaigns, 'statusLabel'), [campaigns]);
  const typeOptions = React.useMemo(() => getUniqueOptions(campaigns, 'type'), [campaigns]);
  const displayedCampaigns = React.useMemo(() => {
    const keyword = campaignKeyword.trim().toLowerCase();
    return campaigns.filter((campaign) => {
      const statusMatched = statusFilter === '全部状态' || campaign.statusLabel === statusFilter;
      const typeMatched = typeFilter === '全部类型' || campaign.type === typeFilter;
      const keywordMatched =
        !keyword ||
        [campaign.title, campaign.id, campaign.type, campaign.statusLabel]
          .map((value) => String(value ?? '').toLowerCase())
          .some((value) => value.includes(keyword));
      return statusMatched && typeMatched && keywordMatched;
    });
  }, [campaignKeyword, campaigns, statusFilter, typeFilter]);
  const selectedCampaign =
    campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? displayedCampaigns[0] ?? campaigns[0] ?? null;
  const selectedReportCampaign =
    reportCampaignId === ALL_PROMOTION_SCOPE
      ? null
      : campaigns.find((campaign) => normalizeText(campaign.id) === normalizeText(reportCampaignId)) ?? null;
  const selectedProducts = React.useMemo(() => selectedCampaign?.products ?? [], [selectedCampaign]);
  const selectedCampaignProductCount = React.useMemo(
    () => getPromotionCampaignProductCount(selectedCampaign, selectedProducts),
    [selectedCampaign, selectedProducts]
  );
  const allPromotedProducts = React.useMemo(() => mergePromotionProductRows(campaigns), [campaigns]);
  const selectedObjects = React.useMemo(() => selectedCampaign?.objects ?? [], [selectedCampaign]);
  const objectProductOptions = React.useMemo(
    () => getPromotionProductScopeOptions(selectedProducts, selectedObjects),
    [selectedObjects, selectedProducts]
  );
  const displayedObjects = React.useMemo(
    () => filterPromotionRowsByProductScope(selectedObjects, objectProductScope),
    [objectProductScope, selectedObjects]
  );
  const filterAndSortPromotionProducts = React.useCallback(
    (sourceRows = []) => {
      const keyword = productKeyword.trim().toLowerCase();
      const rows = sourceRows.filter((product) => {
        if (!keyword) return true;
        return [product.title, product.sku, product.offerId, product.statusLabel, ...(product.campaignTitles || [])]
          .map((value) => String(value ?? '').toLowerCase())
          .some((value) => value.includes(keyword));
      });
      const direction = productSortDir === 'asc' ? 1 : -1;
      return [...rows].sort((a, b) => {
        const derivedSortKeys = new Set(['ctr', 'cpc', 'acos', 'roas', 'roi']);
        const aValue = derivedSortKeys.has(productSortKey)
          ? getPaidPromotionMetricValue(a, productSortKey)
          : a?.[productSortKey];
        const bValue = derivedSortKeys.has(productSortKey)
          ? getPaidPromotionMetricValue(b, productSortKey)
          : b?.[productSortKey];
        const aNumber = Number(aValue);
        const bNumber = Number(bValue);
        if (Number.isFinite(aNumber) || Number.isFinite(bNumber)) {
          return (
            ((Number.isFinite(aNumber) ? aNumber : -Infinity) - (Number.isFinite(bNumber) ? bNumber : -Infinity)) *
            direction
          );
        }
        return String(aValue ?? '').localeCompare(String(bValue ?? ''), 'zh-CN') * direction;
      });
    },
    [productKeyword, productSortDir, productSortKey]
  );
  const displayedAllPromotedProducts = React.useMemo(
    () => filterAndSortPromotionProducts(allPromotedProducts),
    [allPromotedProducts, filterAndSortPromotionProducts]
  );
  const displayedCampaignProducts = React.useMemo(
    () => filterAndSortPromotionProducts(selectedProducts),
    [filterAndSortPromotionProducts, selectedProducts]
  );
  const syncAccountsFromSettings = React.useCallback(
    async (preferredAccountId = selectedAccountId, preferredShopId = selectedShopId) => {
      const accountReadGeneration = accountReadGenerationRef.current;
      const accountPayload = await listPerformanceAccounts({ timeoutMs: 10000 });
      const nextAccounts = toPerformanceAccounts(accountPayload?.accounts || accountPayload?.rows || []);
      const nextConfigured = nextAccounts.filter((account) => account.configured && account.shopId === preferredShopId);
      const nextSelectedAccount =
        nextConfigured.find((account) => account.id === preferredAccountId) ?? nextConfigured[0] ?? null;
      setAccounts(nextAccounts);
      if (accountReadGenerationRef.current !== accountReadGeneration) return null;
      setSelectedAccountId(nextSelectedAccount?.id || '');
      return nextSelectedAccount;
    },
    [selectedAccountId, selectedShopId]
  );

  const loadPromotionExchangeRate = React.useCallback(async () => {
    setExchangeRateStatus('人民币汇率读取中');
    let cachedRate = null;
    try {
      const cachedPayload = await listRubCnyRateCache({ limit: 30, timeoutMs: 5000 });
      cachedRate = getLatestCachedRubCnyRate(cachedPayload);
      if (cachedRate) {
        setRubCnyRateInfo(cachedRate);
        setExchangeRateStatus(`汇率：1 卢布≈${formatCnyAmount(cachedRate.rubToCnyRate)}（最近官方）`);
      }
    } catch {
      // The current Ozon value still remains visible in RUB while the official
      // daily rate request below runs or recovers.
    }
    try {
      const payload = await getRubCnyDailyRate(toDateInputValue(), {
        timeoutMs: 30000,
        allowNearest: true,
        maxLookbackDays: 14,
      });
      const normalized = normalizeRubCnyRatePayload(payload);
      if (!normalized) throw new Error('RUB/CNY 汇率未返回有效比例');
      setRubCnyRateInfo(normalized);
      setExchangeRateStatus(`汇率：1 卢布≈${formatCnyAmount(normalized.rubToCnyRate)}`);
      return normalized;
    } catch (rateError) {
      if (cachedRate) return cachedRate;
      setRubCnyRateInfo((current) => current);
      setExchangeRateStatus(
        `当天汇率暂未更新，推广金额按卢布显示：${rateError instanceof Error ? rateError.message : String(rateError || '未知错误')}`
      );
      return null;
    }
  }, []);

  const loadRealtimeOverview = React.useCallback(
    async (accountOverride, readOptions = {}) => {
      const accountToUse = accountOverride ?? selectedAccount;
      if (!accountToUse) {
        setOverview(null);
        setError('当前店铺没有绑定可用的 Ozon 推广接口账号，请先到「设置 → 平台接口」绑定店铺。');
        return null;
      }
      if (dateFrom && dateTo && dateFrom > dateTo) {
        setError('统计范围开始日期不能晚于结束日期。');
        return null;
      }
      const shopId = activeShop.id || '';
      const overviewReadGeneration = overviewReadGenerationRef.current;
      const readDepth = normalizeText(readOptions.readDepth) || 'full';
      const overviewReadKey = buildPerformanceOverviewReadKey({
        accountId: accountToUse.id,
        shopId,
        dateFrom,
        dateTo,
        readDepth,
        campaignId: readOptions.campaignId,
        includeCampaignObjects: readOptions.includeCampaignObjects,
        includeBidInsights: readOptions.includeBidInsights,
      });
      const overviewSnapshotKey = buildPerformanceOverviewSnapshotKey({
        accountId: accountToUse.id,
        shopId,
        dateFrom,
        dateTo,
      });
      if (overviewScopeKeyRef.current !== overviewSnapshotKey) {
        overviewScopeKeyRef.current = overviewSnapshotKey;
        const hotSnapshot = readPerformanceOverviewHotSnapshot(overviewByScopeRef.current, overviewSnapshotKey);
        // A date-range change must not unmount the whole promotion workspace
        // while the new live request is running. Keep the last verified screen
        // visible, but reset the merge base so the old range cannot leak into
        // the new response. An exact hot snapshot may replace it immediately.
        overviewRef.current = hotSnapshot;
        if (hotSnapshot) {
          setOverview(hotSnapshot);
          setSelectedCampaignId(hotSnapshot.campaigns?.[0]?.id || '');
        }
      }
      const existingRead = overviewReadsRef.current.get(overviewReadKey);
      if (existingRead) return existingRead;

      if (!readOptions.silent) {
        visibleOverviewReadCountRef.current += 1;
        setLoading(true);
        setError('');
        setActionNotice('');
      }
      const overviewReadPromise = (async () => {
        try {
          const payload = await readPerformanceOverview(
            {
              type: 'ozon-performance',
              values: {
                accountId: accountToUse.id,
                shopId,
                shopName: getShopLabel(activeShop),
                dateFrom,
                dateTo,
                readDepth,
                campaignId: normalizeText(readOptions.campaignId),
                includeCampaignObjects: readOptions.includeCampaignObjects,
                includeBidInsights: readOptions.includeBidInsights === true,
                snapshotOnly: readOptions.snapshotOnly === true,
              },
            },
            { timeoutMs: Number(readOptions.timeoutMs) > 0 ? Number(readOptions.timeoutMs) : 240000 }
          );
          if (
            overviewReadGenerationRef.current !== overviewReadGeneration ||
            overviewScopeKeyRef.current !== overviewSnapshotKey
          )
            return null;
          const responseOverview = readOptions.snapshotOnly === true ? payload?.snapshot : payload;
          if (!responseOverview?.ok) return null;
          const nextOverview = mergePerformanceOverview(overviewRef.current, responseOverview);
          overviewRef.current = nextOverview;
          setOverview(nextOverview);
          writePerformanceOverviewHotSnapshot(overviewByScopeRef.current, overviewSnapshotKey, nextOverview);
          const preferredCampaignId = normalizeText(readOptions.preferredCampaignId);
          const nextCampaignId =
            nextOverview?.campaigns?.find((campaign) => normalizeText(campaign.id) === preferredCampaignId)?.id ||
            nextOverview?.campaigns?.[0]?.id ||
            '';
          setSelectedCampaignId((currentCampaignId) =>
            nextOverview?.campaigns?.some((campaign) => normalizeText(campaign.id) === normalizeText(currentCampaignId))
              ? currentCampaignId
              : nextCampaignId
          );
          if (payload?.notifications?.recorded > 0 && typeof onNotificationsRefresh === 'function') {
            onNotificationsRefresh();
          }
          return nextOverview;
        } catch (loadError) {
          if (
            overviewReadGenerationRef.current !== overviewReadGeneration ||
            overviewScopeKeyRef.current !== overviewSnapshotKey
          )
            return null;
          const message = getPerformanceReadErrorMessage(loadError);
          if (!readOptions.silent) {
            setError(
              overviewRef.current
                ? `${message.replace('本次没有使用缓存数据，', '')} 已保留当前已经返回的数据。`
                : message
            );
          }
          return null;
        }
      })();
      overviewReadsRef.current.set(overviewReadKey, overviewReadPromise);
      try {
        return await overviewReadPromise;
      } finally {
        const isCurrentRead = overviewReadsRef.current.get(overviewReadKey) === overviewReadPromise;
        if (isCurrentRead) overviewReadsRef.current.delete(overviewReadKey);
        if (!readOptions.silent) {
          visibleOverviewReadCountRef.current = Math.max(0, visibleOverviewReadCountRef.current - 1);
        }
        if (
          !readOptions.silent &&
          visibleOverviewReadCountRef.current === 0 &&
          overviewReadGenerationRef.current === overviewReadGeneration &&
          overviewScopeKeyRef.current === overviewSnapshotKey
        ) {
          setLoading(false);
        }
      }
    },
    [activeShop, dateFrom, dateTo, onNotificationsRefresh, selectedAccount]
  );

  const loadInitialPromotionOverview = React.useCallback(async () => {
    const initialGeneration = overviewReadGenerationRef.current;
    const instantSnapshot = await loadRealtimeOverview(undefined, {
      readDepth: 'snapshot',
      snapshotOnly: true,
      timeoutMs: 5000,
      silent: true,
    });
    if (overviewReadGenerationRef.current !== initialGeneration) return;
    const dashboardOverview = await loadRealtimeOverview(undefined, {
      readDepth: 'dashboard',
      timeoutMs: 90000,
      // A verified snapshot is already on screen. Refresh it in the background
      // instead of showing a second global loader for the same campaign list.
      silent: Boolean(instantSnapshot?.ok),
    });
    void dashboardOverview;
  }, [loadRealtimeOverview]);

  const handleRefreshOverview = React.useCallback(async () => {
    void loadPromotionExchangeRate();
    const latestAccount = await syncAccountsFromSettings();
    await loadRealtimeOverview(latestAccount, {
      preferredCampaignId: selectedCampaign?.id || selectedCampaignId,
      readDepth: 'dashboard',
      timeoutMs: 90000,
    });
  }, [
    loadPromotionExchangeRate,
    loadRealtimeOverview,
    selectedCampaign?.id,
    selectedCampaignId,
    syncAccountsFromSettings,
  ]);

  const handlePromotionTabChange = React.useCallback((nextTab) => {
    setActivePromotionTab(nextTab);
  }, []);

  const loadSelectedCampaignDetails = React.useCallback(async () => {
    if (!selectedCampaign?.id || !selectedAccount) return null;
    const detailKind = activePromotionTab === 'objects' ? 'objects' : 'search';
    const loadingKey = `${detailKind}:${selectedCampaign.id}`;
    setCampaignDetailLoadingKeys((current) => ({ ...current, [loadingKey]: true }));
    try {
      return await loadRealtimeOverview(selectedAccount, {
        preferredCampaignId: selectedCampaign.id,
        readDepth: 'detail',
        campaignId: selectedCampaign.id,
        includeCampaignObjects: activePromotionTab === 'objects',
        includeBidInsights: activePromotionTab === 'search',
        timeoutMs: 90000,
        silent: true,
      });
    } finally {
      setCampaignDetailLoadingKeys((current) => {
        const next = { ...current };
        delete next[loadingKey];
        return next;
      });
    }
  }, [activePromotionTab, loadRealtimeOverview, selectedAccount, selectedCampaign?.id]);

  const loadAllPromotedProducts = React.useCallback(async () => {
    if (!selectedAccount) return null;
    const loadingKey = 'products:all';
    setCampaignDetailLoadingKeys((current) => ({ ...current, [loadingKey]: true }));
    try {
      const missingCampaignIds = campaigns
        .filter((campaign) => campaign.detailRead?.products !== true)
        .map((campaign) => normalizeText(campaign.id))
        .filter(Boolean);
      // A persisted account catalog normally leaves only newly-created plans
      // without products. Reading those few plans directly avoids replaying
      // 40+ serial campaign-product requests on every page open.
      if (campaigns.length && missingCampaignIds.length > 0 && missingCampaignIds.length <= 4) {
        const detailResults = await Promise.all(
          missingCampaignIds.map((campaignId) =>
            loadRealtimeOverview(selectedAccount, {
              readDepth: 'detail',
              campaignId,
              includeCampaignObjects: false,
              includeBidInsights: false,
              timeoutMs: 90000,
              silent: true,
            })
          )
        );
        return detailResults.at(-1) || null;
      }
      return await loadRealtimeOverview(selectedAccount, {
        readDepth: 'products',
        includeCampaignObjects: false,
        timeoutMs: 120000,
        silent: true,
      });
    } finally {
      setCampaignDetailLoadingKeys((current) => {
        const next = { ...current };
        delete next[loadingKey];
        return next;
      });
    }
  }, [campaigns, loadRealtimeOverview, selectedAccount]);

  const loadPromotionOrders = React.useCallback(async () => {
    if (!selectedAccount) return null;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setPromotionOrdersError('统计范围开始日期不能晚于结束日期。');
      return null;
    }
    const generation = overviewReadGenerationRef.current;
    const requestKey = [selectedAccount.id, activeShop.id || '', dateFrom, dateTo].join('|');
    if (promotionOrdersScopeKeyRef.current !== requestKey) {
      promotionOrdersScopeKeyRef.current = requestKey;
      setPromotionOrders(null);
      setPromotionOrdersError('');
    }
    const existingRead = promotionOrderReadsRef.current.get(requestKey);
    if (existingRead) return existingRead;
    setPromotionOrdersLoading(true);
    setPromotionOrdersError('');
    const request = (async () => {
      try {
        const payload = await readPerformanceOrders(
          {
            type: 'ozon-performance',
            values: {
              accountId: selectedAccount.id,
              shopId: activeShop.id || '',
              shopName: getShopLabel(activeShop),
              dateFrom,
              dateTo,
            },
          },
          { timeoutMs: 120000 }
        );
        if (overviewReadGenerationRef.current !== generation || promotionOrdersScopeKeyRef.current !== requestKey)
          return null;
        setPromotionOrders(payload?.ok || payload?.partial ? payload : null);
        if (payload?.partial) {
          setPromotionOrdersError(payload?.error?.message || '部分日期的推广订单读取失败，已保留成功返回的订单。');
        }
        return payload;
      } catch (ordersError) {
        if (overviewReadGenerationRef.current !== generation || promotionOrdersScopeKeyRef.current !== requestKey)
          return null;
        setPromotionOrdersError(getPerformanceOrdersErrorMessage(ordersError));
        return null;
      } finally {
        if (promotionOrderReadsRef.current.get(requestKey) === request) {
          promotionOrderReadsRef.current.delete(requestKey);
        }
        if (overviewReadGenerationRef.current === generation && promotionOrdersScopeKeyRef.current === requestKey)
          setPromotionOrdersLoading(false);
      }
    })();
    promotionOrderReadsRef.current.set(requestKey, request);
    return request;
  }, [activeShop, dateFrom, dateTo, selectedAccount]);

  const loadAdvancedPromotionReport = React.useCallback(async () => {
    if (!selectedAccount || !advancedReportViews.has(activeReportView)) return null;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setAdvancedReportError('统计范围开始日期不能晚于结束日期。');
      return null;
    }
    setAdvancedReportLoading(true);
    setAdvancedReportError('');
    try {
      const campaignIds = selectedReportCampaign?.id
        ? [selectedReportCampaign.id]
        : campaigns.map((campaign) => campaign.id).filter(Boolean);
      const payload = await readPerformanceAdvancedReport(
        {
          type: 'ozon-performance',
          values: {
            accountId: selectedAccount.id,
            shopId: activeShop.id || '',
            shopName: getShopLabel(activeShop),
            reportKind: activeReportView,
            campaignIds,
            dateFrom,
            dateTo,
          },
        },
        { timeoutMs: 120000 }
      );
      setAdvancedReport(payload);
      if (!payload?.ok) setAdvancedReportError(payload?.error?.message || 'Ozon 报表读取失败。');
      return payload;
    } catch (reportError) {
      setAdvancedReport(null);
      setAdvancedReportError(getPerformanceReadErrorMessage(reportError));
      return null;
    } finally {
      setAdvancedReportLoading(false);
    }
  }, [activeReportView, activeShop, campaigns, dateFrom, dateTo, selectedAccount, selectedReportCampaign?.id]);

  const openWriteDialog = React.useCallback(
    (action) => {
      setError('');
      setActionNotice('');
      setWriteError('');
      if (action.action === 'createCampaign') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            title: '',
            createMode: 'productCpc',
            fromDate: toDateInputValue(),
            toDate: '',
            weeklyBudgetRubles: '',
            placement: 'PLACEMENT_SEARCH_AND_CATEGORY',
            productAutopilotStrategy: 'MAX_CLICKS',
            keyword: '',
            selectedSkus: [],
            bid: '',
            bidSource: 'empty',
            targetCir: '',
            topPosition: '',
          },
        });
        setProductPickerRows([]);
        setProductPickerTotal(0);
        setProductPickerPage(1);
        setProductPickerHasNext(false);
        setProductPickerAvailability('available');
        return;
      }
      if (!selectedCampaign && !GLOBAL_SEARCH_PROMO_ACTIONS.has(action.action)) {
        setError('请先选择一个推广计划。');
        return;
      }
      if (action.action === 'editCampaign') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            campaignId: selectedCampaign.id,
            campaignTitle: selectedCampaign.title,
            fromDate: selectedCampaign.fromDate || '',
            toDate: selectedCampaign.toDate || '',
          },
        });
        return;
      }
      if (action.action === 'updateBudget') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            campaignId: selectedCampaign.id,
            campaignTitle: selectedCampaign.title,
            budgetKind: 'weeklyBudget',
            budgetRubles: '',
            paymentType: selectedCampaign.paymentType || '',
          },
        });
        return;
      }
      if (action.action === 'setProductBids') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            campaignId: selectedCampaign.id,
            campaignTitle: selectedCampaign.title,
            selectedSkus: [],
            bid: '',
            bidSource: 'manual',
            strategyCode: selectedCampaign.strategyCode || '',
            targetCir: selectedCampaign.strategyCode === 'TARGET_CIR' ? '15' : '',
            topPosition: selectedCampaign.strategyCode === 'TOP_PROMOTION' ? 'Топ-20' : '',
          },
        });
        return;
      }
      if (action.action === 'setSearchPromoBids') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            campaignId: selectedCampaign?.id || '',
            campaignTitle: selectedCampaign?.title || '',
            keyword: '',
            selectedSkus: [],
            bid: '',
            bidSource: 'minCpo',
            targetCir: '15',
            topPosition: '',
          },
        });
        setProductPickerRows([]);
        setProductPickerTotal(0);
        setProductPickerPage(1);
        setProductPickerHasNext(false);
        setProductPickerAvailability('all');
        return;
      }
      if (action.action === 'removeProducts') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            campaignId: selectedCampaign.id,
            campaignTitle: selectedCampaign.title,
            selectedSkus: [],
          },
        });
        return;
      }
      if (action.action === 'deleteSearchPromoBids') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            campaignId: selectedCampaign?.id || '',
            campaignTitle: selectedCampaign?.title || '',
            selectedSkus: [],
          },
        });
        setProductPickerRows([]);
        setProductPickerTotal(0);
        setProductPickerPage(1);
        setProductPickerHasNext(false);
        setProductPickerAvailability('all');
        return;
      }
      if (action.action === 'toggleSearchPromoProduct') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            campaignId: selectedCampaign?.id || '',
            campaignTitle: selectedCampaign?.title || '',
            selectedSkus: [],
            mode: 'enable',
          },
        });
        setProductPickerRows([]);
        setProductPickerTotal(0);
        setProductPickerPage(1);
        setProductPickerHasNext(false);
        setProductPickerAvailability('all');
        return;
      }
      if (action.action === 'toggleAllSkuPromo') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: { mode: 'activate' },
        });
        return;
      }
      if (action.action === 'setAllSkuPromoBid') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: { bid: '5' },
        });
        return;
      }
      if (action.action === 'toggleCarrots') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            campaignId: selectedCampaign?.id || '',
            campaignTitle: selectedCampaign?.title || '',
            keyword: '',
            selectedSkus: [],
            mode: 'enable',
          },
        });
        setProductPickerRows([]);
        setProductPickerTotal(0);
        setProductPickerPage(1);
        setProductPickerHasNext(false);
        setProductPickerAvailability('all');
        return;
      }
      if (action.action === 'addProducts') {
        setWriteDialog({
          open: true,
          action: action.action,
          title: action.title,
          values: {
            campaignId: selectedCampaign.id,
            campaignTitle: selectedCampaign.title,
            keyword: '',
            selectedSkus: [],
            bid: '',
            bidSource: 'empty',
            strategyCode: selectedCampaign.strategyCode || '',
            targetCir: selectedCampaign.strategyCode === 'TARGET_CIR' ? '15' : '',
            topPosition: selectedCampaign.strategyCode === 'TOP_PROMOTION' ? 'Топ-20' : '',
          },
        });
        setProductPickerRows([]);
        setProductPickerTotal(0);
        setProductPickerPage(1);
        setProductPickerHasNext(false);
        setProductPickerAvailability('available');
        return;
      }
    },
    [selectedCampaign]
  );

  const closeWriteDialog = React.useCallback(() => {
    if (writeLoading) return;
    setWriteDialog({ open: false, action: '', title: '', values: {} });
    setWriteError('');
  }, [writeLoading]);

  const updateWriteValue = React.useCallback((key, value) => {
    setWriteDialog((current) => ({
      ...current,
      values: {
        ...current.values,
        [key]: value,
      },
    }));
    setWriteError('');
  }, []);

  const loadPromotionProductCandidates = React.useCallback(
    async (options = {}) => {
      if (!selectedAccount) {
        setWriteError('请先配置 Ozon 推广接口。');
        return;
      }
      const append = options.append === true;
      const nextPage = Math.max(1, Number(options.page) || 1);
      const keyword = options.keyword ?? '';
      const availabilityFilter = options.availabilityFilter ?? 'all';
      setProductPickerLoading(true);
      setWriteError('');
      try {
        const useSearchPromoPool = GLOBAL_SEARCH_PROMO_ACTIONS.has(writeDialog.action);
        const payload = useSearchPromoPool
          ? await readPerformanceProducts(
              {
                type: 'ozon-performance',
                values: {
                  accountId: selectedAccount.id,
                  shopId: activeShop.id || '',
                  shopName: getShopLabel(activeShop),
                  campaignId: options.campaignId || writeDialog.values.campaignId || selectedCampaign?.id || '',
                  page: nextPage,
                  pageSize: 80,
                  keyword,
                  availabilityFilter,
                },
              },
              { timeoutMs: 45000 }
            )
          : await getDomainCache(
              'products',
              {
                shopId: activeShop.id || '',
                page: nextPage,
                pageSize: 80,
                keyword,
                sort: 'stable',
                ...(availabilityFilter === 'available' ? { visibility: 'IN_SALE' } : {}),
                ...(availabilityFilter === 'unavailable' ? { productStatuses: NON_PROMOTABLE_PRODUCT_STATUSES } : {}),
              },
              { timeoutMs: 45000 }
            );
        const currentCampaignSkus = new Set(
          writeDialog.action === 'addProducts'
            ? selectedProducts.map((row) => normalizeText(row?.sku)).filter(Boolean)
            : []
        );
        const rows = (Array.isArray(payload?.rows) ? payload.rows : [])
          .map(useSearchPromoPool ? normalizePromotionProductCandidate : normalizeSellerPromotionProductCandidate)
          .filter((item) => item.key && item.sku && !currentCampaignSkus.has(item.sku));
        setProductPickerRows((current) => {
          if (!append) return rows;
          const seen = new Set(current.map((item) => item.sku));
          return [...current, ...rows.filter((item) => !seen.has(item.sku))];
        });
        const sourceTotal = Number(payload?.total);
        const effectiveTotal = Number.isFinite(sourceTotal)
          ? Math.max(rows.length, sourceTotal - currentCampaignSkus.size)
          : rows.length;
        setProductPickerTotal(effectiveTotal);
        setProductPickerPage(nextPage);
        setProductPickerHasNext(
          payload?.hasNext === true || (Number.isFinite(sourceTotal) && nextPage * 80 < sourceTotal)
        );
      } catch (productError) {
        if (!append) {
          setProductPickerRows([]);
          setProductPickerTotal(0);
          setProductPickerPage(1);
          setProductPickerHasNext(false);
        }
        const rawProductError =
          productError?.payload?.error?.message || productError?.payload?.message || productError?.message;
        setWriteError(
          writeDialog.action === 'setSearchPromoBids'
            ? getPerformanceReadErrorMessage(productError)
            : rawProductError || '当前店铺的 Ozon 商品目录读取失败。'
        );
      } finally {
        setProductPickerLoading(false);
      }
    },
    [
      activeShop,
      selectedAccount,
      selectedCampaign?.id,
      selectedProducts,
      writeDialog.action,
      writeDialog.values.campaignId,
    ]
  );

  React.useEffect(() => {
    if (
      !writeDialog.open ||
      ![
        'addProducts',
        'createCampaign',
        'setSearchPromoBids',
        'deleteSearchPromoBids',
        'toggleSearchPromoProduct',
        'toggleCarrots',
      ].includes(writeDialog.action)
    ) {
      return;
    }
    const availabilityFilter = ['addProducts', 'createCampaign'].includes(writeDialog.action) ? 'available' : 'all';
    loadPromotionProductCandidates({ keyword: '', availabilityFilter, page: 1 });
  }, [loadPromotionProductCandidates, writeDialog.action, writeDialog.open]);

  const togglePromotionProductSelection = React.useCallback((sku) => {
    setWriteDialog((current) => {
      const selectedSkus = Array.isArray(current.values.selectedSkus) ? current.values.selectedSkus : [];
      const nextSelectedSkus = selectedSkus.includes(sku)
        ? selectedSkus.filter((item) => item !== sku)
        : [...selectedSkus, sku];
      return {
        ...current,
        values: {
          ...current.values,
          selectedSkus: nextSelectedSkus,
        },
      };
    });
    setWriteError('');
  }, []);

  const toggleAllDialogProducts = React.useCallback((rows = []) => {
    const availableSkus = rows
      .filter((row) => row.available !== false)
      .map((row) => row.sku)
      .filter(Boolean);
    setWriteDialog((current) => {
      const selectedSkus = Array.isArray(current.values.selectedSkus) ? current.values.selectedSkus : [];
      const selectedSet = new Set(selectedSkus);
      const everySelected = availableSkus.length > 0 && availableSkus.every((sku) => selectedSet.has(sku));
      const nextSelectedSkus = everySelected
        ? selectedSkus.filter((sku) => !availableSkus.includes(sku))
        : [...new Set([...selectedSkus, ...availableSkus])];
      return {
        ...current,
        values: {
          ...current.values,
          selectedSkus: nextSelectedSkus,
        },
      };
    });
    setWriteError('');
  }, []);

  const handleProductAvailabilityChange = React.useCallback(
    (event) => {
      const nextValue = event.target.value;
      setProductPickerAvailability(nextValue);
      setProductPickerPage(1);
      setProductPickerHasNext(false);
      setProductPickerRows([]);
      loadPromotionProductCandidates({
        keyword: writeDialog.values.keyword || '',
        availabilityFilter: nextValue,
        page: 1,
      });
    },
    [loadPromotionProductCandidates, writeDialog.values.keyword]
  );

  const buildPerformanceWritePayload = React.useCallback(() => {
    if (
      writeDialog.action === 'removeProducts' ||
      writeDialog.action === 'deleteSearchPromoBids' ||
      writeDialog.action === 'toggleSearchPromoProduct' ||
      writeDialog.action === 'toggleCarrots'
    ) {
      const selectedSkus = Array.isArray(writeDialog.values.selectedSkus) ? writeDialog.values.selectedSkus : [];
      return {
        ...writeDialog.values,
        skus: selectedSkus,
      };
    }
    if (!['addProducts', 'createCampaign', 'setProductBids', 'setSearchPromoBids'].includes(writeDialog.action)) {
      return writeDialog.values;
    }
    const selectedSkus = Array.isArray(writeDialog.values.selectedSkus) ? writeDialog.values.selectedSkus : [];
    const targetSkus = selectedSkus.length
      ? selectedSkus
      : normalizeText(writeDialog.values.sku)
        ? [writeDialog.values.sku]
        : [];
    const sourceRows =
      writeDialog.action === 'setProductBids'
        ? selectedProducts.map(normalizeCampaignProductForPicker)
        : productPickerRows;
    const bidSource = writeDialog.values.bidSource || 'manual';
    const bids = targetSkus.map((sku) => ({
      sku,
      bid: resolveBidForSku({
        sku,
        bidSource,
        manualBid: writeDialog.values.bid,
        rows: sourceRows,
      }),
      targetCir: writeDialog.values.targetCir,
      topPosition: writeDialog.values.topPosition,
    }));
    return {
      ...writeDialog.values,
      campaignId: writeDialog.values.campaignId,
      bids,
    };
  }, [productPickerRows, selectedProducts, writeDialog.action, writeDialog.values]);

  const handleConfirmPerformanceWrite = React.useCallback(async () => {
    if (!selectedAccount) {
      setWriteError('请先配置 Ozon 推广接口。');
      return;
    }
    const builtActionPayload = buildPerformanceWritePayload();
    const actionPayload = ['updateBudget', 'editCampaign'].includes(writeDialog.action)
      ? { ...builtActionPayload, campaignProductCount: selectedCampaignProductCount }
      : builtActionPayload;
    if (writeDialog.action === 'addProducts' && !actionPayload.bids?.length) {
      setWriteError('请至少选择 1 个要加入推广计划的商品。');
      return;
    }
    if (writeDialog.action === 'removeProducts' && !actionPayload.skus?.length) {
      setWriteError('请至少选择 1 个要移除的推广商品。');
      return;
    }
    if (writeDialog.action === 'setProductBids' && !actionPayload.bids?.length) {
      setWriteError('请至少选择 1 个要调整出价的推广商品。');
      return;
    }
    if (writeDialog.action === 'setSearchPromoBids' && !actionPayload.bids?.length) {
      setWriteError('请至少选择 1 个要设置搜索推广出价的商品。');
      return;
    }
    if (writeDialog.action === 'deleteSearchPromoBids' && !actionPayload.skus?.length) {
      setWriteError('请至少选择 1 个要删除搜索推广出价的商品。');
      return;
    }
    if (writeDialog.action === 'toggleSearchPromoProduct' && !actionPayload.skus?.length) {
      setWriteError('请至少选择 1 个要开启或关闭搜索推广的商品。');
      return;
    }
    if (writeDialog.action === 'toggleCarrots' && !actionPayload.skus?.length) {
      setWriteError('请至少选择 1 个要加入或退出 Морковск 活动的商品。');
      return;
    }
    if (writeDialog.action === 'createCampaign' && !normalizeText(actionPayload.title)) {
      setWriteError('计划名称不能为空。');
      return;
    }
    const budgetValidationMessage = getWeeklyBudgetValidationMessage(
      writeDialog.action,
      actionPayload,
      selectedCampaignProductCount
    );
    if (budgetValidationMessage) {
      setWriteError(budgetValidationMessage);
      return;
    }
    const writeScopeGeneration = overviewReadGenerationRef.current;
    setWriteLoading(true);
    setWriteError('');
    try {
      const basePayload = {
        type: 'ozon-performance',
        values: {
          accountId: selectedAccount.id,
          shopId: activeShop.id || '',
          shopName: getShopLabel(activeShop),
        },
      };
      const submittedAction = writeDialog.action;
      const confirmedPayload = {
        ...basePayload,
        confirmWrite: true,
        confirmationCode: PERFORMANCE_WRITE_CONFIRMATION_CODE,
        realWrite: true,
        dryRun: false,
      };
      const payload = await executePerformanceAction(
        {
          ...confirmedPayload,
          action: submittedAction,
          payload: actionPayload,
        },
        { timeoutMs: 90000 }
      );
      let successMessage = payload?.message || `${writeDialog.title}已提交，正在刷新。`;
      let followupPayload = null;
      const createdCampaignId =
        payload?.remote?.payload?.campaignId ||
        payload?.remote?.payload?.id ||
        payload?.remote?.payload?.result?.campaignId ||
        payload?.remote?.payload?.result?.id ||
        payload?.remote?.payload?.campaign?.id ||
        payload?.readback?.actual?.campaignId ||
        '';
      if (submittedAction === 'createCampaign' && actionPayload.bids?.length && createdCampaignId) {
        followupPayload = await executePerformanceAction(
          {
            ...confirmedPayload,
            action: 'addProducts',
            payload: {
              campaignId: createdCampaignId,
              strategyCode: actionPayload.productAutopilotStrategy,
              bids: actionPayload.bids,
            },
          },
          { timeoutMs: 90000 }
        );
        successMessage =
          payload?.readback?.confirmed && followupPayload?.readback?.confirmed
            ? `创建计划并添加 ${actionPayload.bids.length} 个商品已生效，Ozon 已精确回读确认。`
            : `计划创建：${payload?.message || '已提交'}；商品添加：${followupPayload?.message || '已提交'}`;
      } else if (submittedAction === 'createCampaign' && actionPayload.bids?.length && !createdCampaignId) {
        successMessage = '计划已创建，但 Ozon 未返回 campaignId，商品未自动添加；请刷新后进入计划管理添加商品。';
      }
      if (overviewReadGenerationRef.current !== writeScopeGeneration) return;
      setWriteDialog({ open: false, action: '', title: '', values: {} });
      const readbackCampaignId = createdCampaignId || actionPayload.campaignId;
      const detailReadbackActions = new Set(['addProducts', 'removeProducts', 'setProductBids']);
      const shouldReadCampaignDetail =
        Boolean(readbackCampaignId) &&
        (detailReadbackActions.has(submittedAction) ||
          (submittedAction === 'createCampaign' && actionPayload.bids?.length > 0));
      const refreshedOverview = await loadRealtimeOverview(selectedAccount, {
        preferredCampaignId: readbackCampaignId,
        readDepth: shouldReadCampaignDetail ? 'detail' : 'dashboard',
        campaignId: shouldReadCampaignDetail ? readbackCampaignId : '',
        includeCampaignObjects: false,
        timeoutMs: 90000,
      });
      const hasBackendReadback = Boolean(payload?.readback);
      setActionNotice(
        hasBackendReadback
          ? successMessage
          : getPerformanceWriteReadbackMessage({
              action: submittedAction,
              actionPayload,
              refreshedOverview,
              fallbackMessage: successMessage,
              createdCampaignId,
            })
      );
    } catch (writeActionError) {
      if (overviewReadGenerationRef.current !== writeScopeGeneration) return;
      setWriteError(getPerformanceActionErrorMessage(writeActionError));
    } finally {
      if (overviewReadGenerationRef.current === writeScopeGeneration) setWriteLoading(false);
    }
  }, [
    activeShop,
    buildPerformanceWritePayload,
    loadRealtimeOverview,
    selectedAccount,
    selectedCampaignProductCount,
    writeDialog.action,
    writeDialog.title,
  ]);

  const handleDirectCampaignToggle = React.useCallback(async () => {
    if (!selectedAccount) {
      setError('请先配置 Ozon 推广接口。');
      return;
    }
    if (!selectedCampaign?.id) {
      setError('请先选择一个推广计划。');
      return;
    }
    const writeScopeGeneration = overviewReadGenerationRef.current;
    const mode = selectedCampaign.statusLabel === '运行中' ? 'deactivate' : 'activate';
    const actionPayload = {
      campaignId: selectedCampaign.id,
      campaignTitle: selectedCampaign.title,
      mode,
    };
    setWriteLoading(true);
    setError('');
    setActionNotice('');
    try {
      const payload = await executePerformanceAction(
        {
          type: 'ozon-performance',
          values: {
            accountId: selectedAccount.id,
            shopId: activeShop.id || '',
            shopName: getShopLabel(activeShop),
          },
          confirmWrite: true,
          confirmationCode: PERFORMANCE_WRITE_CONFIRMATION_CODE,
          realWrite: true,
          dryRun: false,
          action: 'toggleCampaign',
          payload: actionPayload,
        },
        { timeoutMs: 90000 }
      );
      if (overviewReadGenerationRef.current !== writeScopeGeneration) return;
      const refreshedOverview = await loadRealtimeOverview(selectedAccount, {
        preferredCampaignId: selectedCampaign.id,
        readDepth: 'dashboard',
        timeoutMs: 90000,
      });
      setActionNotice(
        payload?.readback
          ? payload.message
          : getPerformanceWriteReadbackMessage({
              action: 'toggleCampaign',
              actionPayload,
              refreshedOverview,
              fallbackMessage:
                payload?.message || (mode === 'activate' ? '启动推广计划已提交。' : '暂停推广计划已提交。'),
            })
      );
    } catch (writeActionError) {
      if (overviewReadGenerationRef.current !== writeScopeGeneration) return;
      setError(getPerformanceActionErrorMessage(writeActionError));
    } finally {
      if (overviewReadGenerationRef.current === writeScopeGeneration) setWriteLoading(false);
    }
  }, [activeShop, loadRealtimeOverview, selectedAccount, selectedCampaign]);

  const handleDetailOperationClick = React.useCallback(
    (operation) => {
      if (operation.action === 'toggleCampaign') {
        void handleDirectCampaignToggle();
        return;
      }
      openWriteDialog(operation);
    },
    [handleDirectCampaignToggle, openWriteDialog]
  );

  React.useEffect(() => {
    if (!isActive || !selectedAccount) return;
    if (activePromotionTab !== 'stats' || activeReportView !== 'orders') return;
    void loadPromotionOrders();
  }, [activePromotionTab, activeReportView, isActive, loadPromotionOrders, selectedAccount]);

  React.useEffect(() => {
    if (!isActive || !selectedAccount) return;
    if (activePromotionTab !== 'stats' || !advancedReportViews.has(activeReportView)) return;
    void loadAdvancedPromotionReport();
  }, [activePromotionTab, activeReportView, isActive, loadAdvancedPromotionReport, selectedAccount]);

  const handleShopChange = React.useCallback(
    (event) => {
      resetPromotionShopScope();
      setSelectedShopId(event.target.value);
    },
    [resetPromotionShopScope, setSelectedShopId]
  );

  const handleDateFromChange = React.useCallback((event) => {
    setDateFrom(event.target.value);
    promotionOrdersScopeKeyRef.current = '';
    setPromotionOrders(null);
    setPromotionOrdersLoading(false);
    setPromotionOrdersError('');
    setError('');
    setActionNotice('');
  }, []);

  const handleDateToChange = React.useCallback((event) => {
    setDateTo(event.target.value);
    promotionOrdersScopeKeyRef.current = '';
    setPromotionOrders(null);
    setPromotionOrdersLoading(false);
    setPromotionOrdersError('');
    setError('');
    setActionNotice('');
  }, []);

  React.useEffect(() => {
    if (!isActive) return;
    let disposed = false;
    syncAccountsFromSettings().catch((accountError) => {
      if (!disposed) setError(getPerformanceReadErrorMessage(accountError));
    });
    return () => {
      disposed = true;
    };
  }, [isActive, syncAccountsFromSettings]);

  React.useEffect(() => {
    if (!isActive) return;
    loadPromotionExchangeRate();
  }, [isActive, loadPromotionExchangeRate]);

  React.useEffect(() => {
    setSelectedAccountId((current) =>
      shopScopedAccounts.some((account) => account.id === current) ? current : shopScopedAccounts[0]?.id || ''
    );
  }, [shopScopedAccounts]);

  React.useEffect(() => {
    setReportCampaignId((current) =>
      current === ALL_PROMOTION_SCOPE || campaigns.some((campaign) => normalizeText(campaign.id) === normalizeText(current))
        ? current
        : ALL_PROMOTION_SCOPE
    );
  }, [campaigns]);

  React.useEffect(() => {
    setObjectProductScope(ALL_PROMOTION_SCOPE);
  }, [selectedCampaign?.id]);

  React.useEffect(() => {
    setObjectProductScope((current) =>
      current === ALL_PROMOTION_SCOPE || objectProductOptions.some((option) => option.key === current)
        ? current
        : ALL_PROMOTION_SCOPE
    );
  }, [objectProductOptions]);

  React.useEffect(() => {
    if (!isActive || !selectedAccount) return;
    loadInitialPromotionOverview();
  }, [isActive, loadInitialPromotionOverview, selectedAccount]);

  React.useEffect(() => {
    if (!isActive || !selectedAccount) return;
    const refreshVisibleOverview = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      // Interactive product/object/search reads share the same Ozon account
      // limit. Never enqueue a background dashboard refresh in front of them.
      if (overviewReadsRef.current.size > 0) return;
      void loadRealtimeOverview(selectedAccount, {
        readDepth: 'dashboard',
        timeoutMs: 90000,
        silent: true,
      });
    };
    const intervalId = window.setInterval(refreshVisibleOverview, PERFORMANCE_REALTIME_POLL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshVisibleOverview();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isActive, loadRealtimeOverview, selectedAccount]);

  React.useEffect(() => {
    if (!isActive) return;
    if (activePromotionTab === 'stats' && activeReportView === 'products') {
      if (campaignDetailLoadingKeys['products:all']) return;
      const allProductsRead =
        campaigns.length > 0 && campaigns.every((campaign) => campaign.detailRead?.products === true);
      if (!allProductsRead || !overview?.dataSets?.historicalProductStatistics) {
        loadAllPromotedProducts();
      }
      return;
    }
    if (!selectedCampaign?.id) return;
    if (!['products', 'objects', 'search'].includes(activePromotionTab)) return;
    if (activePromotionTab === 'products') {
      if (campaignDetailLoadingKeys['products:all']) return;
      const allProductsRead =
        campaigns.length > 0 && campaigns.every((campaign) => campaign.detailRead?.products === true);
      if (!allProductsRead) loadAllPromotedProducts();
      return;
    }
    const selectedDetailLoadingKey = `${activePromotionTab}:${selectedCampaign.id}`;
    if (campaignDetailLoadingKeys[selectedDetailLoadingKey]) return;
    const hasRequiredDetails =
      activePromotionTab === 'objects'
        ? selectedCampaign.detailRead?.objects === true
        : activePromotionTab === 'search'
          ? selectedCampaign.detailRead?.bidInsights === true
          : selectedCampaign.detailRead?.products === true;
    if (hasRequiredDetails) return;
    loadSelectedCampaignDetails();
  }, [
    activePromotionTab,
    activeReportView,
    campaignDetailLoadingKeys,
    isActive,
    loadSelectedCampaignDetails,
    loadAllPromotedProducts,
    campaigns,
    selectedCampaign?.detailRead?.objects,
    selectedCampaign?.detailRead?.bidInsights,
    selectedCampaign?.detailRead?.products,
    selectedCampaign?.id,
    overview?.dataSets?.historicalProductStatistics,
  ]);

  const showAccountSelect = shopScopedAccounts.length > 1;
  const selectedReportTrendRows = React.useMemo(
    () => getSelectedCampaignTrend(selectedReportCampaign, overview),
    [overview, selectedReportCampaign]
  );
  const allPromotionOrderRows = React.useMemo(
    () => sortPromotionRowsNewestFirst(Array.isArray(promotionOrders?.rows) ? promotionOrders.rows : []),
    [promotionOrders?.rows]
  );
  const promotionOrderRows = React.useMemo(
    () => filterPromotionRowsByCampaign(allPromotionOrderRows, reportCampaignId),
    [allPromotionOrderRows, reportCampaignId]
  );
  const scopedPromotionOrders = React.useMemo(
    () => buildScopedPromotionOrderReport(promotionOrders, promotionOrderRows, Boolean(selectedReportCampaign)),
    [promotionOrderRows, promotionOrders, selectedReportCampaign]
  );
  const overviewDataVerification = React.useMemo(
    () => verifyPromotionOverviewData(overview || {}),
    [overview]
  );
  const reportScopeSummary = React.useMemo(
    () =>
      selectedReportCampaign
        ? { ...selectedReportCampaign, ...(selectedReportCampaign.statistics || {}) }
        : overviewDataVerification.summary,
    [overviewDataVerification.summary, selectedReportCampaign]
  );
  const promotionOrderVerification = React.useMemo(
    () =>
      verifyPromotionOrderReport({
        overviewSummary: reportScopeSummary,
        report: scopedPromotionOrders,
        rows: promotionOrderRows,
        error: promotionOrdersError,
      }),
    [promotionOrderRows, promotionOrdersError, reportScopeSummary, scopedPromotionOrders]
  );
  const summaryCards = buildSummaryCards(overviewDataVerification.summary, rubToCnyRate, overviewDataVerification);
  const primarySummaryCards = summaryCards.slice(0, 4);
  const secondarySummaryCards = summaryCards.slice(4);
  const hasCompletePromotedProductCatalog =
    normalizeText(overview?.dataSets?.campaignProducts?.status).toLowerCase() === 'success' ||
    (campaigns.length > 0 && campaigns.every((campaign) => campaign.detailRead?.products === true));
  const promotionTabCounts = {
    plans: displayedCampaigns.length,
    products: hasCompletePromotedProductCatalog ? allPromotedProducts.length : '—',
    objects: selectedCampaign?.detailRead?.objects === true ? selectedObjects.length : '—',
    search:
      selectedCampaign?.detailRead?.products === true && selectedCampaign?.detailRead?.bidInsights === true
        ? selectedProducts.length
        : '—',
    stats: reportViewOptions.length,
  };
  const productsDetailLoading = Boolean(campaignDetailLoadingKeys['products:all']);
  const objectsDetailLoading = Boolean(
    selectedCampaign?.id && campaignDetailLoadingKeys[`objects:${selectedCampaign.id}`]
  );
  const searchDetailLoading = Boolean(
    selectedCampaign?.id && campaignDetailLoadingKeys[`search:${selectedCampaign.id}`]
  );
  const primaryDetailOperations = detailOperationItems.filter((item) =>
    ['editCampaign', 'addProducts', 'updateBudget', 'setProductBids'].includes(item.action)
  );
  const secondaryDetailOperations = detailOperationItems.filter((item) =>
    ['removeProducts', 'toggleCampaign'].includes(item.action)
  );
  const productSelectionDialogActions = [
    'addProducts',
    'createCampaign',
    'setProductBids',
    'setSearchPromoBids',
    'removeProducts',
    'deleteSearchPromoBids',
    'toggleSearchPromoProduct',
    'toggleCarrots',
  ];
  const currentPlanProductDialogActions = [
    'setProductBids',
    'removeProducts',
  ];
  const isProductSelectionDialog = productSelectionDialogActions.includes(writeDialog.action);
  const isCurrentPlanProductDialog = currentPlanProductDialogActions.includes(writeDialog.action);
  const dialogProductRows = isCurrentPlanProductDialog
    ? selectedProducts.map(normalizeCampaignProductForPicker).filter((item) => item.key && item.sku)
    : productPickerRows;
  const dialogProductTotal = isCurrentPlanProductDialog
    ? dialogProductRows.length
    : productPickerTotal || productPickerRows.length;
  const dialogCampaignProductCount =
    writeDialog.action === 'createCampaign'
      ? writeDialog.values.selectedSkus?.length || 1
      : selectedCampaignProductCount;
  const dialogMinimumWeeklyBudgetRubles = getMinimumWeeklyBudgetRubles(dialogCampaignProductCount);
  const dialogBidSourceOptions = ['addProducts', 'createCampaign'].includes(writeDialog.action)
    ? bidSourceOptions.filter((option) => ['empty', 'manual'].includes(option.value))
    : writeDialog.action === 'setSearchPromoBids'
      ? bidSourceOptions.filter((option) => ['minCpo', 'recommended', 'manual', 'empty'].includes(option.value))
      : bidSourceOptions;
  const isWideWriteDialog = isProductSelectionDialog || writeDialog.action === 'editCampaign';
  const productStatsRows = React.useMemo(
    () => (Array.isArray(overview?.productStats) ? overview.productStats : []),
    [overview?.productStats]
  );
  const expenseStatsRows = React.useMemo(
    () => (Array.isArray(overview?.expenseStats) ? overview.expenseStats : []),
    [overview?.expenseStats]
  );
  const mediaStatsRows = React.useMemo(
    () => (Array.isArray(overview?.mediaStats) ? overview.mediaStats : []),
    [overview?.mediaStats]
  );
  const dailyStatsRows = React.useMemo(
    () => (Array.isArray(overview?.dailyStats) ? overview.dailyStats : []),
    [overview?.dailyStats]
  );
  const rawDailyTrendRows = React.useMemo(
    () =>
      selectedReportCampaign
        ? selectedReportTrendRows
        : Array.isArray(overview?.dailyTrend)
          ? overview.dailyTrend
          : [],
    [overview?.dailyTrend, selectedReportCampaign, selectedReportTrendRows]
  );
  const dailyTrendRows = React.useMemo(
    () => buildCompletePromotionDailyTrend(rawDailyTrendRows, dateFrom, dateTo),
    [dateFrom, dateTo, rawDailyTrendRows]
  );
  const selectedCampaignProducts = React.useMemo(
    () =>
      activePromotionTab === 'products'
        ? displayedAllPromotedProducts
        : selectedCampaign
          ? displayedCampaignProducts
          : [],
    [activePromotionTab, displayedAllPromotedProducts, displayedCampaignProducts, selectedCampaign]
  );
  const selectedProductStatsRows = React.useMemo(
    () => {
      const campaignRows = selectedReportCampaign
        ? filterPromotionRowsByCampaign(productStatsRows, selectedReportCampaign.id)
        : productStatsRows;
      const sourceRows =
        selectedReportCampaign && !campaignRows.length
          ? Array.isArray(selectedReportCampaign.products)
            ? selectedReportCampaign.products
            : []
          : campaignRows;
      return sortPromotionRowsNewestFirst(filterPromotionRowsByKeyword(sourceRows, reportProductKeyword));
    },
    [productStatsRows, reportProductKeyword, selectedReportCampaign]
  );
  const selectedExpenseRows = React.useMemo(() => {
    const scopedExpenseRows = filterPromotionRowsByCampaign(expenseStatsRows, reportCampaignId);
    const scopedDailyRows = filterPromotionRowsByCampaign(dailyStatsRows, reportCampaignId);
    return mergePromotionExpenseRows(scopedExpenseRows, scopedDailyRows);
  }, [dailyStatsRows, expenseStatsRows, reportCampaignId]);
  const selectedMediaStatsRows = React.useMemo(() => {
    const scopedRows = filterPromotionRowsByCampaign(mediaStatsRows, reportCampaignId);
    return sortPromotionRowsNewestFirst(scopedRows);
  }, [mediaStatsRows, reportCampaignId]);
  const objectMetricSummary = React.useMemo(() => aggregatePromotionMetricRows(displayedObjects), [displayedObjects]);
  const searchMetricSummary = React.useMemo(
    () => aggregatePromotionMetricRows(selectedCampaignProducts),
    [selectedCampaignProducts]
  );
  const reportRowsForSummary =
    activeReportView === 'trend'
      ? dailyTrendRows.filter((row) => row.availabilityState !== 'no-record')
      : activeReportView === 'orders'
        ? promotionOrderRows
        : activeReportView === 'products'
          ? selectedProductStatsRows
          : activeReportView === 'expense'
            ? selectedExpenseRows
            : selectedMediaStatsRows;
  const activeReportSummary = React.useMemo(
    () =>
      activeReportView === 'orders'
        ? promotionOrderVerification.summary
        : aggregatePromotionMetricRows(reportRowsForSummary),
    [activeReportView, promotionOrderVerification.summary, reportRowsForSummary]
  );
  const reportDataSet =
    activeReportView === 'trend'
      ? overview?.dataSets?.dailyStatistics
      : activeReportView === 'products'
        ? null
        : activeReportView === 'expense'
          ? overview?.dataSets?.expenseStatistics
          : activeReportView === 'media'
            ? overview?.dataSets?.mediaStatistics
            : null;
  const objectDataAvailability = getPromotionDataSetAvailability(
    selectedCampaign?.detailAvailability?.objects || overview?.dataSets?.campaignObjects
  );
  const searchDataAvailability = getPromotionDataSetAvailability(
    selectedCampaign?.detailAvailability?.bidInsights || overview?.dataSets?.campaignBidInsights
  );
  const baseReportDataAvailability =
    activeReportView === 'orders'
      ? promotionOrderVerification.availability
      : activeReportView === 'products'
        ? getPromotionDataSetsAvailability([
            overview?.dataSets?.campaignProductStatistics,
            overview?.dataSets?.historicalProductStatistics,
            overview?.dataSets?.productSkuStatistics,
          ])
        : getPromotionDataSetAvailability(reportDataSet);
  const reportDataAvailability =
    activeReportView === 'trend'
      ? getPromotionScopedDataAvailability(baseReportDataAvailability, selectedReportTrendRows, undefined, {
          requireAllMetrics: true,
        })
      : activeReportView === 'products'
        ? getPromotionScopedDataAvailability(baseReportDataAvailability, selectedProductStatsRows, undefined, {
            requireAllMetrics: true,
          })
        : activeReportView === 'expense'
          ? getPromotionScopedDataAvailability(baseReportDataAvailability, selectedExpenseRows, undefined, {
              requireAllMetrics: true,
            })
          : activeReportView === 'media'
            ? getPromotionScopedDataAvailability(baseReportDataAvailability, selectedMediaStatsRows, undefined, {
                requireAllMetrics: true,
              })
          : baseReportDataAvailability;
  const promotionOrderCountLabel =
    activeReportView === 'orders' && promotionOrderVerification.overviewOrders !== null
      ? promotionOrderVerification.detailOrders === promotionOrderVerification.overviewOrders
        ? `${promotionOrderRows.length} 条 · ${formatPlainNumber(promotionOrderVerification.overviewOrders)} 单`
        : `明细 ${formatPlainNumber(promotionOrderVerification.detailOrders)} 单 · 汇总 ${formatPlainNumber(
            promotionOrderVerification.overviewOrders
          )} 单`
      : `${promotionOrderRows.length} 条`;
  const isAdvancedReportView = advancedReportViews.has(activeReportView);
  const activeAdvancedReport = advancedReport?.reportKind === activeReportView ? advancedReport : null;
  const advancedReportRows = Array.isArray(activeAdvancedReport?.rows) ? activeAdvancedReport.rows : [];
  const activeReportDataAvailability = isAdvancedReportView
    ? advancedReportLoading
      ? { status: 'loading', tone: 'info', label: '读取中' }
      : advancedReportError
        ? { status: 'failed', tone: 'error', label: '读取失败' }
        : activeAdvancedReport?.ok
          ? { status: advancedReportRows.length ? 'success' : 'empty', tone: 'success', label: advancedReportRows.length ? '已返回' : '无记录' }
          : { status: 'idle', tone: 'neutral', label: '待读取' }
    : reportDataAvailability;

  return (
    <Box className="paid-promotion-page paid-promotion-page-plain">
      <Box className="paid-promotion-page-head">
        <Box className="paid-promotion-title-line">
          <Typography variant="h4">付费推广</Typography>
          {error ? (
            <Typography className="paid-promotion-error-pill" title={error}>
              {error}
            </Typography>
          ) : actionNotice ? (
            <Typography className="paid-promotion-action-notice-pill" title={actionNotice}>
              {actionNotice}
            </Typography>
          ) : null}
        </Box>
        <Box className="paid-promotion-head-actions">
          {shopOptions.length ? (
            <TextField
              className="paid-promotion-shop-select"
              select
              size="small"
              inputProps={{ 'aria-label': '店铺' }}
              value={selectedShopId || ''}
              onChange={handleShopChange}
            >
              {shopOptions.map((shop) => (
                <MenuItem key={shop.id} value={shop.id}>
                  {getShopLabel(shop)}
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <Typography className="paid-promotion-head-text" variant="body2" noWrap>
              店铺：{getShopLabel(activeShop)}
            </Typography>
          )}
          <Box className="paid-promotion-head-api">
            {showAccountSelect ? (
              <TextField
                select
                size="small"
                value={selectedAccount?.id || ''}
                onChange={(event) => setSelectedAccountId(event.target.value)}
              >
                {shopScopedAccounts.map((account) => (
                  <MenuItem key={account.id} value={account.id}>
                    {account.title} · {account.clientId ? '已填写' : '未填写'}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Typography
                className="paid-promotion-head-text"
                variant="body2"
                noWrap
                title={selectedAccount?.title || '未配置'}
              >
                推广接口：{selectedAccount?.configured ? '已配置' : '未配置'}
              </Typography>
            )}
          </Box>
          <Typography className="paid-promotion-head-text" variant="body2" noWrap title={exchangeRateStatus}>
            {exchangeRateStatus}
          </Typography>
          <Button
            variant="contained"
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <RefreshRounded />}
            onClick={handleRefreshOverview}
            disabled={loading}
          >
            {loading ? '读取中' : '刷新'}
          </Button>
        </Box>
      </Box>

      {overview ? (
        <>
          <Card className="paid-promotion-overview-card">
            <CardContent>
              <Box className="paid-promotion-overview-compact-grid">
                <Box className="paid-promotion-overview-primary-grid">
                  {primarySummaryCards.map((item) => (
                    <Box
                      key={item.label}
                      className={`paid-promotion-overview-item primary tone-${item.tone} verification-${item.verificationState}`}
                      title={item.verificationNote || item.caption}
                    >
                      <Typography variant="body2" color="text.secondary">
                        {item.label}
                      </Typography>
                      <Typography variant="subtitle1">{item.value}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {item.caption}
                      </Typography>
                    </Box>
                  ))}
                </Box>
                <Box className="paid-promotion-overview-secondary-grid">
                  {secondarySummaryCards.map((item) => (
                    <Box
                      key={item.label}
                      className={`paid-promotion-overview-item compact tone-${item.tone} verification-${item.verificationState}`}
                      title={item.verificationNote || item.caption}
                    >
                      <Typography variant="caption" color="text.secondary">
                        {item.label}
                      </Typography>
                      <Typography variant="subtitle1">{item.value}</Typography>
                      {item.verificationState === 'mismatch' ? (
                        <Typography variant="caption" color="warning.main">
                          口径不一致
                        </Typography>
                      ) : null}
                    </Box>
                  ))}
                </Box>
              </Box>
            </CardContent>
          </Card>

          <Card className="paid-promotion-control-card">
            <CardContent>
              <Box className="paid-promotion-filter-layout">
                <TextField
                  size="small"
                  label="搜索计划"
                  placeholder="计划名称 / 计划编号"
                  value={campaignKeyword}
                  onChange={(event) => setCampaignKeyword(event.target.value)}
                />
                <TextField
                  select
                  size="small"
                  label="状态"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  <MenuItem value="全部状态">全部状态</MenuItem>
                  {statusOptions.map((status) => (
                    <MenuItem key={status} value={status}>
                      {status}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  size="small"
                  label="类型"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value)}
                >
                  <MenuItem value="全部类型">全部类型</MenuItem>
                  {typeOptions.map((type) => (
                    <MenuItem key={type} value={type}>
                      {type}
                    </MenuItem>
                  ))}
                </TextField>
                <Box className="paid-promotion-read-meta">
                  <Box className="paid-promotion-date-range-control">
                    <TextField
                      size="small"
                      label="开始日期"
                      type="date"
                      value={dateFrom}
                      onChange={handleDateFromChange}
                      InputLabelProps={{ shrink: true }}
                    />
                    <TextField
                      size="small"
                      label="结束日期"
                      type="date"
                      value={dateTo}
                      onChange={handleDateToChange}
                      InputLabelProps={{ shrink: true }}
                    />
                  </Box>
                </Box>
                <Box className="paid-promotion-read-meta">
                  <Typography variant="caption" color="text.secondary">
                    读取时间
                  </Typography>
                  <Typography variant="body2">{formatDateTime(overview.finishedAt)}</Typography>
                </Box>
              </Box>

              <Box className="paid-promotion-tab-bar">
                <Box className="sales-order-filter-copy paid-promotion-tab-copy">
                  <Typography variant="h6">推广管理</Typography>
                  <Typography variant="body2" color="text.secondary">
                    按计划、商品和统计分区查看
                  </Typography>
                </Box>
                <Box className="sales-order-status-grid paid-promotion-section-tabs">
                  {promotionTabs.map((tab) => (
                    <Box
                      key={tab.value}
                      component="button"
                      type="button"
                      className={`status-tab${activePromotionTab === tab.value ? ' active' : ''}`}
                      onClick={() => handlePromotionTabChange(tab.value)}
                    >
                      <span>{tab.label}</span>
                      <strong>{promotionTabCounts[tab.value] ?? 0}</strong>
                    </Box>
                  ))}
                </Box>
              </Box>
            </CardContent>
          </Card>

          <Box className={`paid-promotion-workspace-grid compact-workspace tab-${activePromotionTab}`}>
            <Card className="paid-promotion-list-card paid-promotion-work-card">
              <CardContent>
                {activePromotionTab === 'plans' ? (
                  <>
                    <Box className="paid-promotion-card-title-row">
                      <Box>
                        <Typography variant="h6">推广计划</Typography>
                        <Typography variant="body2" color="text.secondary">
                          共 {displayedCampaigns.length} 个计划，分页查看；商品明细按当前计划读取。
                        </Typography>
                      </Box>
                      <Box className="paid-promotion-card-title-actions">
                        <Button
                          className="paid-promotion-create-button"
                          size="small"
                          variant="contained"
                          startIcon={<CampaignRounded />}
                          onClick={() => openWriteDialog(createPlanAction)}
                        >
                          创建计划
                        </Button>
                        <Chip color="success" variant="outlined" label="实时" />
                      </Box>
                    </Box>
                    <CampaignListTable
                      rows={displayedCampaigns}
                      selectedCampaignId={selectedCampaign?.id}
                      onSelect={setSelectedCampaignId}
                      rubToCnyRate={rubToCnyRate}
                    />
                  </>
                ) : null}

                {activePromotionTab === 'products' ? (
                  <>
                    <Box className="paid-promotion-card-title-row">
                      <Box>
                        <Typography variant="h6">商品投放</Typography>
                        <Typography variant="body2" color="text.secondary" noWrap title={selectedCampaign?.title || ''}>
                          当前店铺全部推广商品，共 {allPromotedProducts.length} 个；跨计划合并并按商品编号去重。
                        </Typography>
                      </Box>
                      <Box className="paid-promotion-card-title-actions">
                        {productsDetailLoading ? <CircularProgress size={18} /> : null}
                        {detailOperationItems
                          .filter((item) => ['addProducts', 'setProductBids', 'removeProducts'].includes(item.action))
                          .map((item) => (
                            <Button
                              key={item.action}
                              size="small"
                              variant={item.action === 'addProducts' ? 'contained' : 'outlined'}
                              onClick={() => handleDetailOperationClick(item)}
                              disabled={writeLoading || !selectedCampaign}
                            >
                              {item.shortTitle}
                            </Button>
                          ))}
                      </Box>
                    </Box>
                    <Box className="paid-promotion-product-filter-row compact">
                      <TextField
                        size="small"
                        label="搜索商品"
                        value={productKeyword}
                        onChange={(event) => setProductKeyword(event.target.value)}
                        placeholder="商品编号 / 货号 / 商品名"
                      />
                      <TextField
                        select
                        size="small"
                        label="写入目标计划"
                        value={selectedCampaign?.id || ''}
                        onChange={(event) => setSelectedCampaignId(event.target.value)}
                        helperText="只决定加商品、移除和调价写入哪个计划"
                      >
                        {campaigns.map((campaign) => (
                          <MenuItem key={campaign.id} value={campaign.id}>
                            {campaign.title || campaign.id}
                          </MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        select
                        size="small"
                        label="排序"
                        value={productSortKey}
                        onChange={(event) => setProductSortKey(event.target.value)}
                      >
                        <MenuItem value="spent">花费</MenuItem>
                        <MenuItem value="clicks">点击</MenuItem>
                        <MenuItem value="orders">订单</MenuItem>
                        <MenuItem value="acos">广告费占比</MenuItem>
                        <MenuItem value="ctr">点击率</MenuItem>
                        <MenuItem value="cpc">单次点击成本</MenuItem>
                        <MenuItem value="bid">出价</MenuItem>
                      </TextField>
                      <TextField
                        select
                        size="small"
                        label="方向"
                        value={productSortDir}
                        onChange={(event) => setProductSortDir(event.target.value)}
                      >
                        <MenuItem value="desc">降序</MenuItem>
                        <MenuItem value="asc">升序</MenuItem>
                      </TextField>
                    </Box>
                    <CampaignProductTable rows={selectedCampaignProducts} mode="products" rubToCnyRate={rubToCnyRate} />
                  </>
                ) : null}

                {activePromotionTab === 'objects' ? (
                  <>
                    <Box className="paid-promotion-card-title-row">
                      <Box>
                        <Typography variant="h6">投放对象</Typography>
                        <Typography variant="body2" color="text.secondary" noWrap title={selectedCampaign?.title || ''}>
                          当前计划：{selectedCampaign?.title || '未选择'}；对象、商品和统计按计划与商品编号精确匹配。
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={1} alignItems="center">
                        {objectsDetailLoading ? <CircularProgress size={18} /> : null}
                        <Chip
                          className={`paid-promotion-availability-chip tone-${objectDataAvailability.tone}`}
                          variant="outlined"
                          label={objectDataAvailability.label}
                        />
                        <Chip
                          color="success"
                          variant="outlined"
                          label={
                            objectProductScope === ALL_PROMOTION_SCOPE
                              ? `${selectedObjects.length} 个对象`
                              : `筛选后 ${displayedObjects.length} / 共 ${selectedObjects.length}`
                          }
                        />
                      </Stack>
                    </Box>
                    <Box className="paid-promotion-scope-toolbar">
                      <TextField
                        select
                        size="small"
                        label="选择计划"
                        value={selectedCampaign?.id || ''}
                        onChange={(event) => setSelectedCampaignId(event.target.value)}
                        helperText="决定查看哪个计划的投放对象"
                      >
                        {!campaigns.length ? (
                          <MenuItem value="" disabled>
                            暂无推广计划
                          </MenuItem>
                        ) : null}
                        {campaigns.map((campaign) => (
                          <MenuItem key={campaign.id} value={campaign.id}>
                            {campaign.title || campaign.id}
                          </MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        select
                        size="small"
                        label="选择商品"
                        value={objectProductScope}
                        onChange={(event) => setObjectProductScope(event.target.value)}
                        helperText="只筛选当前计划内与该商品精确匹配的对象"
                      >
                        <MenuItem value={ALL_PROMOTION_SCOPE}>全部商品</MenuItem>
                        {objectProductOptions.map((option) => (
                          <MenuItem key={option.key} value={option.key}>
                            {[option.label, option.secondary].filter(Boolean).join(' · ')}
                          </MenuItem>
                        ))}
                      </TextField>
                    </Box>
                    <PromotionMetricSummary summary={objectMetricSummary} rubToCnyRate={rubToCnyRate} />
                    <CampaignObjectTable
                      rows={displayedObjects}
                      rubToCnyRate={rubToCnyRate}
                      availability={objectDataAvailability}
                      emptyMessage={
                        objectProductScope === ALL_PROMOTION_SCOPE ? '' : '所选商品在当前计划中没有投放对象。'
                      }
                    />
                  </>
                ) : null}

                {activePromotionTab === 'search' ? (
                  <>
                    <Box className="paid-promotion-card-title-row">
                      <Box>
                        <Typography variant="h6">搜索推广</Typography>
                        <Typography variant="body2" color="text.secondary" noWrap title={selectedCampaign?.title || ''}>
                          表格按查看计划展示；调价、删价和启停在弹窗中选择全店搜索推广商品并直接生效。
                        </Typography>
                      </Box>
                      <Box className="paid-promotion-card-title-actions">
                        {searchDetailLoading ? <CircularProgress size={18} /> : null}
                        <Chip
                          className={`paid-promotion-availability-chip tone-${searchDataAvailability.tone}`}
                          size="small"
                          variant="outlined"
                          label={searchDataAvailability.label}
                        />
                        {searchPromotionOperationItems.map((item) => (
                            <Button
                              key={item.action}
                              size="small"
                              variant={['setSearchPromoBids', 'toggleAllSkuPromo'].includes(item.action) ? 'contained' : 'outlined'}
                              onClick={() => handleDetailOperationClick(item)}
                              disabled={writeLoading || !selectedAccount}
                            >
                              {item.shortTitle}
                            </Button>
                          ))}
                      </Box>
                    </Box>
                    <PromotionMetricSummary summary={searchMetricSummary} rubToCnyRate={rubToCnyRate} />
                    <Box className="paid-promotion-product-filter-row compact">
                      <TextField
                        select
                        size="small"
                        label="查看计划"
                        value={selectedCampaign?.id || ''}
                        onChange={(event) => setSelectedCampaignId(event.target.value)}
                        helperText="只筛选当前表格，不限制写入弹窗的全店商品池"
                      >
                        {!campaigns.length ? (
                          <MenuItem value="" disabled>
                            暂无推广计划
                          </MenuItem>
                        ) : null}
                        {campaigns.map((campaign) => (
                          <MenuItem key={campaign.id} value={campaign.id}>
                            {campaign.title || campaign.id}
                          </MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        size="small"
                        label="搜索商品"
                        value={productKeyword}
                        onChange={(event) => setProductKeyword(event.target.value)}
                        placeholder="商品编号 / 货号 / 商品名"
                      />
                      <TextField
                        select
                        size="small"
                        label="排序"
                        value={productSortKey}
                        onChange={(event) => setProductSortKey(event.target.value)}
                      >
                        <MenuItem value="bid">出价</MenuItem>
                        <MenuItem value="clicks">点击</MenuItem>
                        <MenuItem value="acos">广告费占比</MenuItem>
                        <MenuItem value="ctr">点击率</MenuItem>
                        <MenuItem value="cpc">单次点击成本</MenuItem>
                      </TextField>
                      <TextField
                        select
                        size="small"
                        label="方向"
                        value={productSortDir}
                        onChange={(event) => setProductSortDir(event.target.value)}
                      >
                        <MenuItem value="desc">降序</MenuItem>
                        <MenuItem value="asc">升序</MenuItem>
                      </TextField>
                    </Box>
                    <CampaignProductTable
                      rows={selectedCampaignProducts}
                      mode="search"
                      rubToCnyRate={rubToCnyRate}
                      availability={searchDataAvailability}
                    />
                  </>
                ) : null}

                {activePromotionTab === 'stats' ? (
                  <>
                    <Box className="paid-promotion-card-title-row">
                      <Box>
                        <Typography variant="h6">统计报表</Typography>
                        <Typography variant="body2" color="text.secondary">
                          一次只看一类报表，避免数据拥挤；金额继续按当前汇率显示人民币。
                        </Typography>
                      </Box>
                      <Box className="paid-promotion-report-head-actions">
                        {activeReportView === 'products' ? (
                          <TextField
                            className="paid-promotion-report-head-product-filter"
                            size="small"
                            label="筛选商品"
                            value={reportProductKeyword}
                            onChange={(event) => setReportProductKeyword(event.target.value)}
                            placeholder="商品编号 / 货号 / 商品名"
                            inputProps={{ 'aria-label': '筛选商品' }}
                          />
                        ) : null}
                        <TextField
                          className="paid-promotion-report-head-scope"
                          select
                          size="small"
                          label="统计范围"
                          value={reportCampaignId}
                          onChange={(event) => setReportCampaignId(event.target.value)}
                          inputProps={{ 'aria-label': '统计范围' }}
                        >
                          <MenuItem value={ALL_PROMOTION_SCOPE}>全部计划</MenuItem>
                          {campaigns.map((campaign) => (
                            <MenuItem key={campaign.id} value={campaign.id}>
                              {campaign.title || campaign.id}
                            </MenuItem>
                          ))}
                        </TextField>
                        <Chip variant="outlined" label={`${dateFrom} 至 ${dateTo}`} />
                      </Box>
                    </Box>
                    <Box className="paid-promotion-report-switcher" role="tablist" aria-label="统计报表类型">
                      {reportViewOptions.map((item) => (
                        <Box
                          key={item.value}
                          component="button"
                          type="button"
                          role="tab"
                          aria-selected={activeReportView === item.value}
                          className={activeReportView === item.value ? 'active' : ''}
                          onClick={() => setActiveReportView(item.value)}
                        >
                          {item.label}
                        </Box>
                      ))}
                    </Box>
                    <Box className="paid-promotion-report-focus-panel">
                      <Box className="paid-promotion-report-focus-title">
                        <Box>
                          <Typography variant="subtitle1">
                            {reportViewOptions.find((item) => item.value === activeReportView)?.label}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {selectedReportCampaign?.title || '全部计划'} · {dateFrom} 至 {dateTo}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Chip
                            className={`paid-promotion-availability-chip tone-${activeReportDataAvailability.tone}`}
                            size="small"
                            variant="outlined"
                            label={activeReportDataAvailability.label}
                          />
                          <Chip
                            size="small"
                            variant="outlined"
                            label={
                              activeReportView === 'trend'
                                ? `${dailyTrendRows.length} 天`
                                : activeReportView === 'orders'
                                  ? promotionOrderCountLabel
                                  : activeReportView === 'products'
                                    ? `${selectedProductStatsRows.length} 条`
                                    : activeReportView === 'expense'
                                      ? `${selectedExpenseRows.length} 条`
                                      : isAdvancedReportView
                                        ? `${advancedReportRows.length} 条`
                                        : `${selectedMediaStatsRows.length} 条`
                            }
                          />
                          {activeReportView === 'orders' ? (
                            <Button
                              size="small"
                              variant="outlined"
                              disabled={promotionOrdersLoading}
                              startIcon={promotionOrdersLoading ? <CircularProgress size={14} /> : <RefreshRounded />}
                              onClick={loadPromotionOrders}
                            >
                              {promotionOrdersLoading ? '读取中' : '刷新订单'}
                            </Button>
                          ) : null}
                          {isAdvancedReportView ? (
                            <Button
                              size="small"
                              variant="outlined"
                              disabled={advancedReportLoading}
                              startIcon={advancedReportLoading ? <CircularProgress size={14} /> : <RefreshRounded />}
                              onClick={loadAdvancedPromotionReport}
                            >
                              {advancedReportLoading ? '读取中' : '刷新报表'}
                            </Button>
                          ) : null}
                        </Stack>
                      </Box>
                      {!isAdvancedReportView ? (
                        <PromotionMetricSummary summary={activeReportSummary} rubToCnyRate={rubToCnyRate} />
                      ) : null}
                      {activeReportView === 'trend' ? (
                        <TrendTable
                          rows={dailyTrendRows}
                          rubToCnyRate={rubToCnyRate}
                          availability={reportDataAvailability}
                        />
                      ) : null}
                      {activeReportView === 'orders' ? (
                        <PromotionOrderTable
                          rows={promotionOrderRows}
                          loading={promotionOrdersLoading}
                          error={promotionOrdersError}
                          rubToCnyRate={rubToCnyRate}
                          availability={promotionOrderVerification.availability}
                          verificationMessage={promotionOrderVerification.message}
                        />
                      ) : null}
                      {activeReportView === 'products' ? (
                        <CampaignProductTable
                          rows={selectedProductStatsRows}
                          mode="stats"
                          rubToCnyRate={rubToCnyRate}
                          availability={reportDataAvailability}
                        />
                      ) : null}
                      {activeReportView === 'expense' ? (
                        <ExpenseTable
                          rows={selectedExpenseRows}
                          rubToCnyRate={rubToCnyRate}
                          availability={reportDataAvailability}
                        />
                      ) : null}
                      {activeReportView === 'media' ? (
                        <MediaStatsTable
                          rows={selectedMediaStatsRows}
                          rubToCnyRate={rubToCnyRate}
                          availability={reportDataAvailability}
                        />
                      ) : null}
                      {isAdvancedReportView ? (
                        <AdvancedPerformanceReportTable
                          rows={advancedReportRows}
                          loading={advancedReportLoading}
                          error={advancedReportError}
                          emptyMessage={activeAdvancedReport?.message || ''}
                        />
                      ) : null}
                    </Box>
                  </>
                ) : null}
              </CardContent>
            </Card>

            <Box className="paid-promotion-right-stack one-screen-side">
              {activePromotionTab === 'plans' ? (
                <Card className="paid-promotion-detail-card paid-promotion-detail-compact-card">
                  <CardContent>
                    {selectedCampaign ? (
                      <Stack spacing={1} className="paid-promotion-plan-detail-shell">
                        <Box className="paid-promotion-plan-detail-head">
                          <Box>
                            <Typography variant="h6">计划管理</Typography>
                            <Typography variant="body2" color="text.secondary" noWrap title={selectedCampaign.id}>
                              {selectedCampaign.id}
                            </Typography>
                          </Box>
                          <Chip color={getStatusTone(selectedCampaign)} label={selectedCampaign.statusLabel} />
                        </Box>

                        <Box className="paid-promotion-plan-title-panel compact">
                          <Typography variant="subtitle1" noWrap title={selectedCampaign.title}>
                            {selectedCampaign.title}
                          </Typography>
                          <Box className="paid-promotion-plan-badges">
                            <Chip size="small" variant="outlined" label={selectedCampaign.type} />
                            <Chip size="small" variant="outlined" label={selectedCampaign.placement} />
                            {selectedCampaign.alerts?.budgetExhausted ? (
                              <Chip size="small" color="warning" icon={<WarningAmberRounded />} label="预算花完" />
                            ) : null}
                            {selectedCampaign.alerts?.moderationRejected ? (
                              <Chip size="small" color="error" icon={<WarningAmberRounded />} label="审核不通过" />
                            ) : null}
                          </Box>
                        </Box>

                        <Box className="paid-promotion-plan-actions-block compact">
                          <Box className="paid-promotion-action-strip all-actions">
                            {[...primaryDetailOperations, ...secondaryDetailOperations].map((item, index) => (
                              <Button
                                key={item.title}
                                size="small"
                                variant={index < primaryDetailOperations.length ? 'outlined' : 'text'}
                                title={item.desc}
                                onClick={() => handleDetailOperationClick(item)}
                                disabled={writeLoading}
                              >
                                {item.shortTitle}
                              </Button>
                            ))}
                          </Box>
                        </Box>

                        <Box className="paid-promotion-detail-sections-row">
                          <Box className="paid-promotion-detail-section compact">
                            <Typography variant="subtitle1" className="paid-promotion-detail-section-title">
                              计划信息
                            </Typography>
                            <Box className="paid-promotion-detail-compact-grid order-like">
                              <DetailItem label="策略" value={selectedCampaign.strategy} />
                              <DetailItem label="预算状态" value={selectedCampaign.budgetStatus} />
                              <DetailItem label="审核原因" value={selectedCampaign.reviewReason || '未返回'} />
                              <DetailItem
                                label="商品 / 对象"
                                value={`${formatPlainNumber(selectedCampaign.productCount)} / ${formatPlainNumber(
                                  selectedCampaign.objectCount
                                )}`}
                              />
                            </Box>
                          </Box>

                          <Box className="paid-promotion-detail-section compact">
                            <Typography variant="subtitle1" className="paid-promotion-detail-section-title">
                              预算与周期
                            </Typography>
                            <Box className="paid-promotion-detail-compact-grid order-like">
                              <DetailItem
                                label="日预算"
                                value={formatMoney(selectedCampaign.dailyBudget, rubToCnyRate)}
                              />
                              <DetailItem
                                label="周预算"
                                value={formatMoney(selectedCampaign.weeklyBudget, rubToCnyRate)}
                              />
                              <DetailItem
                                label="总预算"
                                value={formatMoney(
                                  selectedCampaign.totalBudget ?? selectedCampaign.budget,
                                  rubToCnyRate
                                )}
                              />
                              <DetailItem
                                label={selectedCampaign.budgetRemainingSource === 'calculated' ? '剩余（计算）' : '剩余'}
                                value={formatMoney(selectedCampaign.budgetRemaining, rubToCnyRate)}
                              />
                              <DetailItem
                                label="周期"
                                value={`${selectedCampaign.fromDate || '未返回'} 至 ${selectedCampaign.toDate || '未返回'}`}
                              />
                            </Box>
                          </Box>

                          <Box className="paid-promotion-detail-section compact">
                            <Typography variant="subtitle1" className="paid-promotion-detail-section-title">
                              效果数据
                            </Typography>
                            <Box className="paid-promotion-detail-compact-grid order-like">
                              <DetailItem
                                label="展示 / 点击"
                                value={`${formatPlainNumber(
                                  getCampaignMetric(selectedCampaign, 'impressions')
                                )} / ${formatPlainNumber(getCampaignMetric(selectedCampaign, 'clicks'))}`}
                              />
                              <DetailItem
                                label="花费"
                                value={formatMoney(getCampaignMetric(selectedCampaign, 'spent'), rubToCnyRate)}
                              />
                              <DetailItem
                                label="点击率"
                                value={formatCampaignMetric(selectedCampaign, 'ctr', formatPercent)}
                              />
                              <DetailItem
                                label="单次点击成本"
                                value={formatCampaignMetric(selectedCampaign, 'cpc', formatMoney, rubToCnyRate)}
                              />
                              <DetailItem
                                label="订单 / 销售额"
                                value={`${formatPlainNumber(getCampaignMetric(selectedCampaign, 'orders'))} / ${formatMoney(
                                  getCampaignMetric(selectedCampaign, 'revenue'),
                                  rubToCnyRate
                                )}`}
                              />
                              <DetailItem
                                label="广告费占比 / 广告投产比"
                                value={`${formatCampaignMetric(selectedCampaign, 'acos', formatPercent)} / ${formatCampaignMetric(
                                  selectedCampaign,
                                  'roas',
                                  formatMetric
                                )}`}
                              />
                            </Box>
                          </Box>
                        </Box>
                      </Stack>
                    ) : (
                      <Box className="paid-promotion-empty-state compact">
                        <Typography variant="body2">请选择左侧计划查看详情。</Typography>
                      </Box>
                    )}
                  </CardContent>
                </Card>
              ) : null}
            </Box>
          </Box>
        </>
      ) : !loading && !error ? (
        <Card className="paid-promotion-empty-card">
          <CardContent>
            <Stack spacing={1.5} alignItems="flex-start">
              <Stack direction="row" alignItems="center" spacing={1}>
                <CampaignRounded color="primary" />
                <Typography variant="h6">等待实时读取</Typography>
              </Stack>
              <Typography color="text.secondary">
                请先在设置的「平台接口」中配置 Ozon 推广接口。进入页面后会自动实时读取，不展示历史缓存。
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      ) : (
        <Card className="paid-promotion-overview-card paid-promotion-initial-state-card">
          <CardContent>
            <Stack direction="row" spacing={1.5} alignItems="center">
              {loading ? (
                <CircularProgress size={22} />
              ) : (
                <WarningAmberRounded color={error ? 'warning' : 'disabled'} />
              )}
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  {loading ? '正在读取推广计划基础数据' : '推广数据暂未返回'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {loading
                    ? '基础计划返回后立即显示；消耗与统计批量补齐，商品和投放对象在打开具体计划时读取。'
                    : error || '点击右上角“刷新”重新读取。'}
                </Typography>
              </Box>
            </Stack>
          </CardContent>
        </Card>
      )}

      <Dialog
        className="paid-promotion-write-dialog"
        open={writeDialog.open}
        onClose={closeWriteDialog}
        maxWidth={isWideWriteDialog ? 'md' : 'sm'}
        fullWidth
      >
        <DialogTitle>{writeDialog.title || '推广操作'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              填写或选择完成后点击「立即执行」，本次提交会直接写入 Ozon，并自动回读核对结果。
            </Typography>

            {writeDialog.action === 'createCampaign' ? (
              <>
                <Typography variant="body2" color="text.secondary">
                  创建 Ozon 当前开放的按点击收费商品计划；计划类型和付费方式由官方接口固定。
                </Typography>
                <TextField
                  label="计划名称"
                  value={writeDialog.values.title || ''}
                  onChange={(event) => updateWriteValue('title', event.target.value)}
                  fullWidth
                  autoFocus
                />
                <Stack direction="row" spacing={1}>
                  <TextField
                    label="开始日期"
                    type="date"
                    value={writeDialog.values.fromDate || ''}
                    onChange={(event) => updateWriteValue('fromDate', event.target.value)}
                    InputLabelProps={{ shrink: true }}
                    fullWidth
                  />
                  <TextField
                    label="结束日期"
                    type="date"
                    value={writeDialog.values.toDate || ''}
                    onChange={(event) => updateWriteValue('toDate', event.target.value)}
                    InputLabelProps={{ shrink: true }}
                    fullWidth
                  />
                </Stack>
                <Stack direction="row" spacing={1}>
                  <TextField
                    select
                    label="展示位置"
                    value={writeDialog.values.placement || 'PLACEMENT_SEARCH_AND_CATEGORY'}
                    onChange={(event) => updateWriteValue('placement', event.target.value)}
                    fullWidth
                  >
                    {placementOptions.map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    label="投放策略"
                    value={writeDialog.values.productAutopilotStrategy || 'MAX_CLICKS'}
                    onChange={(event) => updateWriteValue('productAutopilotStrategy', event.target.value)}
                    fullWidth
                  >
                    {strategyOptions.map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </TextField>
                </Stack>
                <TextField
                  label={`周预算（卢布，可留空；最低 ${dialogMinimumWeeklyBudgetRubles}）`}
                  value={writeDialog.values.weeklyBudgetRubles || ''}
                  onChange={(event) => updateWriteValue('weeklyBudgetRubles', event.target.value)}
                  placeholder={`例如 ${dialogMinimumWeeklyBudgetRubles}`}
                  type="number"
                  inputProps={{ min: 0, step: 1 }}
                  helperText={`Ozon 按每个商品 2000 卢布计算；0 表示取消限制。`}
                  fullWidth
                />
              </>
            ) : null}

            {writeDialog.action === 'editCampaign' ? (
              <>
                <Typography variant="body2">
                  当前计划：<strong>{writeDialog.values.campaignTitle}</strong>
                </Typography>
                <Stack direction="row" spacing={1}>
                  <TextField
                    label="开始日期"
                    type="date"
                    value={writeDialog.values.fromDate || ''}
                    onChange={(event) => updateWriteValue('fromDate', event.target.value)}
                    InputLabelProps={{ shrink: true }}
                    fullWidth
                  />
                  <TextField
                    label="结束日期"
                    type="date"
                    value={writeDialog.values.toDate || ''}
                    onChange={(event) => updateWriteValue('toDate', event.target.value)}
                    InputLabelProps={{ shrink: true }}
                    fullWidth
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Ozon 当前 PATCH 接口只允许修改投放日期；预算请使用“修改预算”。
                </Typography>
              </>
            ) : null}

            {writeDialog.action === 'updateBudget' ? (
              <>
                <Typography variant="body2">
                  当前计划：<strong>{writeDialog.values.campaignTitle}</strong>
                </Typography>
                <TextField
                  select
                  label="预算类型"
                  value={writeDialog.values.budgetKind || 'weeklyBudget'}
                  onChange={(event) => updateWriteValue('budgetKind', event.target.value)}
                  fullWidth
                >
                  <MenuItem value="weeklyBudget">周预算</MenuItem>
                  <MenuItem value="budget">总预算</MenuItem>
                </TextField>
                <TextField
                  label={
                    writeDialog.values.budgetKind === 'weeklyBudget'
                      ? `预算金额（卢布；周预算最低 ${dialogMinimumWeeklyBudgetRubles}）`
                      : '预算金额（卢布，0 表示取消限制）'
                  }
                  value={writeDialog.values.budgetRubles || ''}
                  onChange={(event) => updateWriteValue('budgetRubles', event.target.value)}
                  placeholder={
                    writeDialog.values.budgetKind === 'weeklyBudget'
                      ? `例如 ${dialogMinimumWeeklyBudgetRubles}`
                      : '请输入预算金额'
                  }
                  type="number"
                  inputProps={{ min: 0, step: 1 }}
                  helperText={
                    writeDialog.values.budgetKind === 'weeklyBudget'
                      ? `当前按 ${dialogCampaignProductCount} 个商品计算；0 表示取消限制。`
                      : '0 表示取消限制。'
                  }
                  fullWidth
                  autoFocus
                />
              </>
            ) : null}

            {writeDialog.action === 'toggleAllSkuPromo' ? (
              <TextField
                select
                label="全店按订单付费状态"
                value={writeDialog.values.mode || 'activate'}
                onChange={(event) => updateWriteValue('mode', event.target.value)}
                fullWidth
              >
                <MenuItem value="activate">开启全店推广</MenuItem>
                <MenuItem value="deactivate">关闭全店推广</MenuItem>
              </TextField>
            ) : null}

            {writeDialog.action === 'setAllSkuPromoBid' ? (
              <TextField
                select
                label="全店按订单付费费率"
                value={writeDialog.values.bid || '5'}
                onChange={(event) => updateWriteValue('bid', event.target.value)}
                fullWidth
              >
                {[5, 7, 9].map((bid) => (
                  <MenuItem key={bid} value={String(bid)}>
                    {bid}%
                  </MenuItem>
                ))}
              </TextField>
            ) : null}

            {writeDialog.action === 'setProductBids' ? (
              <>
                <Typography variant="body2">
                  当前计划：<strong>{writeDialog.values.campaignTitle}</strong>
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  请在下方当前计划商品中选择要调价的商品，可一次选择多个。
                </Typography>
              </>
            ) : null}

            {isProductSelectionDialog ? (
              <>
                {writeDialog.action === 'addProducts' ? (
                  <Typography variant="body2">
                    当前计划：<strong>{writeDialog.values.campaignTitle}</strong>
                  </Typography>
                ) : writeDialog.action === 'setSearchPromoBids' ? (
                  <Typography variant="body2">
                    从 Ozon 搜索推广商品池选择商品并设置出价。
                  </Typography>
                ) : writeDialog.action === 'removeProducts' ? (
                  <Typography variant="body2">
                    从当前计划 <strong>{writeDialog.values.campaignTitle}</strong> 中选择要移除的商品。
                  </Typography>
                ) : writeDialog.action === 'deleteSearchPromoBids' ? (
                  <Typography variant="body2">
                    从 Ozon 搜索推广商品池选择要删除搜索推广出价的商品。
                  </Typography>
                ) : writeDialog.action === 'toggleSearchPromoProduct' ? (
                  <Typography variant="body2">
                    从 Ozon 搜索推广商品池选择要开启或关闭搜索推广的商品。
                  </Typography>
                ) : writeDialog.action === 'toggleCarrots' ? (
                  <Typography variant="body2">
                    从 Ozon 商品池选择要加入或退出 Морковск 活动的商品。
                  </Typography>
                ) : writeDialog.action === 'setProductBids' ? (
                  <Typography variant="body2" fontWeight={900}>
                    选择要调价的当前计划商品
                  </Typography>
                ) : (
                  <Typography variant="body2" fontWeight={900}>
                    选择推广商品
                  </Typography>
                )}
                {!isCurrentPlanProductDialog ? (
                  <Box className="paid-promotion-product-picker-toolbar">
                    <TextField
                      label="搜索商品"
                      value={writeDialog.values.keyword || ''}
                      onChange={(event) => updateWriteValue('keyword', event.target.value)}
                      placeholder="商品名称 / 商家货号 / 商品编号"
                      fullWidth
                      autoFocus
                    />
                    <TextField
                      select
                      label="投放状态"
                      value={productPickerAvailability}
                      onChange={handleProductAvailabilityChange}
                    >
                      <MenuItem value="all">全部商品</MenuItem>
                      <MenuItem value="available">仅可投放</MenuItem>
                      <MenuItem value="unavailable">仅不可投放</MenuItem>
                    </TextField>
                    <Button
                      variant="outlined"
                      onClick={() =>
                        loadPromotionProductCandidates({
                          keyword: writeDialog.values.keyword || '',
                          availabilityFilter: productPickerAvailability,
                          page: 1,
                        })
                      }
                      disabled={productPickerLoading}
                    >
                      {productPickerLoading ? '读取中' : '搜索'}
                    </Button>
                    <Box className="paid-promotion-product-picker-extra-actions">
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => toggleAllDialogProducts(dialogProductRows)}
                        disabled={!dialogProductRows.length}
                      >
                        选中/取消当前展示
                      </Button>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() =>
                          loadPromotionProductCandidates({
                            keyword: writeDialog.values.keyword || '',
                            availabilityFilter: productPickerAvailability,
                            append: true,
                            page: productPickerPage + 1,
                          })
                        }
                        disabled={productPickerLoading || !productPickerHasNext}
                      >
                        {productPickerHasNext ? '加载更多' : '没有更多'}
                      </Button>
                    </Box>
                  </Box>
                ) : null}
                {['toggleSearchPromoProduct', 'toggleCarrots'].includes(writeDialog.action) ? (
                  <Box className="paid-promotion-product-picker-extra-actions current">
                    <TextField
                      select
                      size="small"
                      label="操作"
                      value={writeDialog.values.mode || 'enable'}
                      onChange={(event) => updateWriteValue('mode', event.target.value)}
                    >
                      <MenuItem value="enable">
                        {writeDialog.action === 'toggleCarrots' ? '加入 Морковск 活动' : '开启搜索推广'}
                      </MenuItem>
                      <MenuItem value="disable">
                        {writeDialog.action === 'toggleCarrots' ? '退出 Морковск 活动' : '关闭搜索推广'}
                      </MenuItem>
                    </TextField>
                  </Box>
                ) : null}
                {isCurrentPlanProductDialog ? (
                  <Box className="paid-promotion-product-picker-extra-actions current">
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => toggleAllDialogProducts(dialogProductRows)}
                      disabled={!dialogProductRows.length}
                    >
                      选中/取消全部计划商品
                    </Button>
                  </Box>
                ) : null}
                {['addProducts', 'createCampaign', 'setProductBids', 'setSearchPromoBids'].includes(
                  writeDialog.action
                ) ? (
                  <Box className="paid-promotion-bid-source-row">
                    <TextField
                      select
                      label="出价来源"
                      value={writeDialog.values.bidSource || 'manual'}
                      onChange={(event) => updateWriteValue('bidSource', event.target.value)}
                    >
                      {dialogBidSourceOptions.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      ))}
                    </TextField>
                    {writeDialog.values.bidSource === 'manual' ? (
                      <TextField
                        label={
                          writeDialog.action === 'setSearchPromoBids'
                            ? '订单出价（商品价格占比 %）'
                            : writeDialog.action === 'setProductBids'
                              ? '新 CPC 出价（卢布）'
                              : '默认 CPC 出价（卢布）'
                        }
                        value={writeDialog.values.bid || ''}
                        onChange={(event) => updateWriteValue('bid', event.target.value)}
                        placeholder={
                          writeDialog.action === 'setProductBids' ? '填写要调整的新出价' : '可留空，由 Ozon 自动设置'
                        }
                      />
                    ) : (
                      <Box className="paid-promotion-bid-source-note">
                        {dialogBidSourceOptions.find((option) => option.value === writeDialog.values.bidSource)?.desc ||
                          '按当前选择的出价来源直接提交 Ozon。'}
                      </Box>
                    )}
                    {writeDialog.action !== 'setSearchPromoBids' &&
                    (writeDialog.values.productAutopilotStrategy === 'TARGET_CIR' ||
                      writeDialog.values.strategyCode === 'TARGET_CIR') ? (
                      <TextField
                        label="目标广告成本比 %"
                        value={writeDialog.values.targetCir || ''}
                        onChange={(event) => updateWriteValue('targetCir', event.target.value)}
                      />
                    ) : null}
                    {writeDialog.action !== 'setSearchPromoBids' &&
                    (writeDialog.values.productAutopilotStrategy === 'TOP_PROMOTION' ||
                      writeDialog.values.strategyCode === 'TOP_PROMOTION') ? (
                      <TextField
                        select
                        label="目标位置"
                        value={writeDialog.values.topPosition || 'Топ-20'}
                        onChange={(event) => updateWriteValue('topPosition', event.target.value)}
                      >
                        {['Топ-4', 'Топ-12', 'Топ-20', 'Топ-30'].map((position) => (
                          <MenuItem key={position} value={position}>
                            {position}
                          </MenuItem>
                        ))}
                      </TextField>
                    ) : null}
                  </Box>
                ) : null}
                <Box className="paid-promotion-product-picker-summary">
                  已选 {writeDialog.values.selectedSkus?.length || 0} 个商品；当前展示 {dialogProductRows.length} /{' '}
                  {dialogProductTotal} 个 {isCurrentPlanProductDialog ? '计划内商品' : '可推广商品'}。
                </Box>
                <Box className="paid-promotion-product-picker-list">
                  {dialogProductRows.map((product) => {
                    const checked = writeDialog.values.selectedSkus?.includes(product.sku);
                    return (
                      <Box
                        key={product.key}
                        component="button"
                        type="button"
                        className={`paid-promotion-product-picker-row${checked ? ' selected' : ''}${product.available === false ? ' unavailable' : ''}`}
                        onClick={() => {
                          if (product.available === false) return;
                          togglePromotionProductSelection(product.sku);
                        }}
                        disabled={product.available === false}
                      >
                        <span className="paid-promotion-product-picker-check">{checked ? '✓' : ''}</span>
                        {product.image ? (
                          <img src={product.image} alt="" />
                        ) : (
                          <span className="paid-promotion-product-picker-image-empty">无图</span>
                        )}
                        <span className="paid-promotion-product-picker-main">
                          <strong title={product.name}>{product.name}</strong>
                          <small>
                            商品编号：{product.sku} {product.offerId ? `· 货号：${product.offerId}` : ''}{' '}
                            {product.stockValue !== '' ? `· 库存：${product.stockValue}` : ''}
                            {product.price !== null && product.price !== undefined
                              ? ` · 售价：${formatMoney(product.price, rubToCnyRate)}`
                              : ''}
                            {product.bid !== undefined && product.bid !== null
                              ? ` · 当前出价：${formatMoney(product.bid, rubToCnyRate)}`
                              : ''}
                            {product.recommendedBid !== null && product.recommendedBid !== undefined
                              ? ` · 推荐出价：${formatMoney(product.recommendedBid, rubToCnyRate)}`
                              : ''}
                            {product.competitiveBid !== null && product.competitiveBid !== undefined
                              ? ` · 竞争出价：${formatMoney(product.competitiveBid, rubToCnyRate)}`
                              : ''}
                            {product.minCpoBid !== null && product.minCpoBid !== undefined
                              ? ` · 最低订单出价：${formatMoney(product.minCpoBid, rubToCnyRate)}`
                              : ''}
                            {product.minimumCpcBid !== null && product.minimumCpcBid !== undefined
                              ? ` · 最低 CPC：${formatMoney(product.minimumCpcBid, rubToCnyRate)}`
                              : ''}
                            {product.previousBid !== null && product.previousBid !== undefined
                              ? ` · 上次出价：${formatMoney(product.previousBid, rubToCnyRate)}`
                              : ''}
                            {product.visibilityIndex ? ` · 曝光指数：${product.visibilityIndex}` : ''}
                            {product.clicks !== null && product.clicks !== undefined
                              ? ` · 点击：${formatPlainNumber(product.clicks)}`
                              : ''}
                            {getPaidPromotionMetricValue(product, 'acos') !== null
                              ? ` · 广告费占比：${formatPromotionMetric(product, 'acos', formatPercent)}`
                              : ''}
                            {product.available === false ? ' · 不可投放' : ''}
                          </small>
                        </span>
                      </Box>
                    );
                  })}
                  {!productPickerLoading && !dialogProductRows.length ? (
                    <Typography color="text.secondary" variant="body2">
                      {isCurrentPlanProductDialog
                        ? '当前计划没有可操作商品，请先确认计划商品是否已实时读取。'
                        : ['addProducts', 'createCampaign'].includes(writeDialog.action)
                          ? '当前店铺的 Ozon 商品目录没有可投放商品，请先同步商品或检查商品状态。'
                          : 'Ozon 暂未返回搜索推广商品，请刷新或检查推广接口权限。'}
                    </Typography>
                  ) : null}
                </Box>
              </>
            ) : null}

            {writeError ? (
              <Typography className="paid-promotion-dialog-error" variant="body2">
                {writeError}
              </Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeWriteDialog} disabled={writeLoading}>
            取消
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={handleConfirmPerformanceWrite}
            disabled={writeLoading}
            startIcon={writeLoading ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {writeLoading ? '写入并核对中' : '立即执行'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

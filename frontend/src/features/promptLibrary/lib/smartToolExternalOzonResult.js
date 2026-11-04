import {
  buildSmartToolExternalOzonAnalysis,
  isSmartToolExternalKeywordTool,
  isSmartToolExternalProductTool,
} from './smartToolExternalOzonAnalysis.js';
import {
  externalProductAnalysisModeLabel,
  normalizeExternalProductAnalysisMode,
} from './smartToolExternalProductAnalysisMode.js';

const FIELD_LABELS = Object.freeze({
  sku: 'SKU',
  productId: '商品 ID',
  offerId: '货号',
  title: '商品',
  name: '名称',
  productName: '商品',
  query: '关键词',
  keyword: '关键词',
  queryCn: '中文',
  translation: '中文',
  price: '价格',
  avgPrice: '均价',
  monthlySales: '月销量',
  sales: '销量',
  monthlyRevenue: '月销售额',
  revenue: '销售额',
  searchVolume: '搜索量',
  count30GrowthRate: '30 天增长',
  searchChange30: '30 天增长',
  productCount: '商品数',
  products: '商品数',
  competingProducts: '竞品数',
  sellers: '卖家数',
  reviewRating: '评分',
  rating: '评分',
  reviewCount: '评论数',
  reviews: '评论数',
  fulfillment: '配送',
  sellerName: '卖家',
  brandName: '品牌',
  brand: '品牌',
  relevancy: '相关性',
  exposure: '曝光',
  conversion: '转化',
  conversionSharing: '转化率',
  viewSharing: '浏览集中度',
  convToCartPdp: '加购转化',
  orderConversionRate: '下单转化',
  naturalRank: '自然排名',
  adRank: '广告排名',
  itemsViews: '商品可见度',
  views: '浏览量',
  marketSpace: '市场空间',
  uniqQueriesWCa: '加购数',
  ca: '加购转化率',
  platform: '平台',
  returnCancellationRate: '退货取消率',
  salesRate: '销量增长',
  revenueRate: '销售额增长',
  grossMargin: '毛利率',
  missedRevenue: '损失销售额',
  drr: '广告费用份额',
  stock: '库存',
  weight: '重量(g)',
  volume: '体积(L)',
  dimensions: '尺寸',
  upDays: '上架天数',
  variants: '变体数',
  questionsAndAnswers: '问答数',
  titleDensity: '标题密度',
  wordCount: '词数',
  categoryPath: '类目',
  productUrl: '商品链接',
  productPageUrl: '商品链接',
  date: '日期',
});

const PRIORITY_FIELDS = Object.freeze(Object.keys(FIELD_LABELS));
const QUERY_LABELS = Object.freeze({
  id: '店铺 ID',
  sku: '商品 SKU',
  categoryId: '类目 ID',
  skus: '商品 SKU',
  skuIds: '商品 SKU',
  keywords: '关键词',
  keyword: '种子词',
  dateRange: '统计范围',
  hasVariant: '剔除变体',
  variationsMerge: '合并变体',
  matchType: '匹配方式',
  categoryIds: '类目 ID',
  categories: '类目 ID',
  searchDate: '查询日期',
  searchVolume: '搜索量',
  searchChange30: '月搜增长',
  monthlySales: '月销量',
  monthlyRevenue: '月销售额',
  price: '价格',
  productViews: '商品浏览量',
  products: '商品数',
  volume: '体量',
  marketSpace: '市场空间',
  conversionSharing: '转化集中度',
  reviews: '评论数',
  ratings: '评分',
  sellers: '卖家数',
  weight: '权重',
  platformFilter: '平台',
  analysisMode: '分析对象',
  manualData: '补充经营数据',
});

const MANUAL_QUERY_LABELS = Object.freeze({
  productCostRub: ['商品成本', '₽'],
  commissionRate: ['平台佣金率', '%'],
  fulfillmentFeeRub: ['履约费用', '₽/单'],
  taxRate: ['税费率', '%'],
  returnCancelRate: ['退货取消率', '%'],
});

function text(value) {
  return String(value ?? '').trim();
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function presentValue(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map(presentValue).filter(Boolean).join('、');
  if (typeof value === 'object') {
    const simple = Object.values(value).every((item) => (
      item == null || ['string', 'number', 'boolean'].includes(typeof item)
    ));
    return simple
      ? Object.entries(value).map(([key, item]) => `${key}: ${presentValue(item)}`).join(' / ')
      : '';
  }
  return text(value);
}

export function formatExternalOzonRecord(record = {}) {
  const original = isRecord(record) ? record : {};
  const source = {
    ...original,
    ...(isRecord(original.dimension) ? original.dimension : {}),
  };
  if (!source.sku && source.productId) source.sku = source.productId;
  if (!source.title && source.productName) source.title = source.productName;
  if (!source.queryCn && source.translation) source.queryCn = source.translation;
  if (source.sales == null && source.monthlySalesUnits != null) source.sales = source.monthlySalesUnits;
  if (source.revenue == null && source.monthlySalesRevenue != null) source.revenue = source.monthlySalesRevenue;
  if (source.reviewRating == null && source.rating != null) source.reviewRating = source.rating;
  if (!source.brandName && source.brand) source.brandName = source.brand;
  if (!source.productUrl && source.productPageUrl) source.productUrl = source.productPageUrl;
  if (!source.dimensions && typeof original.dimension === 'string') source.dimensions = original.dimension;
  if (!source.categoryPath && isRecord(source.categoryInfo)) {
    source.categoryPath = source.categoryInfo.cnTitlePath
      || source.categoryInfo.titlePath
      || source.categoryInfo.enTitlePath
      || '';
  }
  delete source.productId;
  delete source.productName;
  delete source.translation;
  delete source.monthlySalesUnits;
  delete source.monthlySalesRevenue;
  delete source.rating;
  delete source.brand;
  delete source.productPageUrl;
  delete source.dimension;
  const pairs = [];
  const used = new Set();
  for (const key of PRIORITY_FIELDS) {
    const value = presentValue(source[key]);
    if (!value) continue;
    used.add(key);
    pairs.push(`${FIELD_LABELS[key]} ${value}`);
    if (pairs.length >= 12) break;
  }
  if (pairs.length < 4) {
    for (const [key, rawValue] of Object.entries(source)) {
      if (used.has(key)) continue;
      const value = presentValue(rawValue);
      if (!value) continue;
      pairs.push(`${key} ${value}`);
      if (pairs.length >= 12) break;
    }
  }
  return pairs.join(' · ') || '这条记录没有可展示字段';
}

function getRemoteData(response = {}) {
  const payload = isRecord(response?.data) ? response.data : (isRecord(response) ? response : {});
  return isRecord(payload?.data) ? payload.data : payload;
}

function firstArray(source = {}, keys = []) {
  for (const key of keys) {
    if (Array.isArray(source?.[key])) return source[key];
  }
  return [];
}

function formatQueryCondition(key, value) {
  if (key === 'page' && isRecord(value)) {
    const pageNumber = Number(value.pageNumber ?? value.page ?? 1) || 1;
    const pageSize = Number(value.pageSize ?? 20) || 20;
    const allPages = value.allPages === true;
    const loadedPages = Number(value.loadedPages) || 0;
    const firstOrder = Array.isArray(value.orders) ? value.orders[0] : null;
    const orderLabel = firstOrder?.field
      ? FIELD_LABELS[firstOrder.field] || firstOrder.field
      : '';
    const direction = String(firstOrder?.direction || '').toUpperCase() === 'ASC' ? '升序' : '降序';
    return allPages
      ? `已读取全部${loadedPages ? ` ${loadedPages} 页` : ''} · 每页 ${pageSize} 条${orderLabel ? ` · 按${orderLabel}${direction}` : ''}`
      : `第 ${pageNumber} 页 · 每页 ${pageSize} 条${orderLabel ? ` · 按${orderLabel}${direction}` : ''}`;
  }
  const rendered = presentValue(value);
  if (!rendered) return '';
  if (key === 'dateRange') {
    const dateRangeLabels = {
      past_7_days: '近 7 天',
      past_30_days: '近 30 天',
      past_60_days: '近 60 天',
      past_90_days: '近 90 天',
      past_180_days: '近 180 天',
      past_365_days: '近 365 天',
    };
    return `${QUERY_LABELS[key]} ${dateRangeLabels[rendered] || rendered}`;
  }
  if (key === 'hasVariant' || key === 'variationsMerge') {
    return `${QUERY_LABELS[key]} ${Number(value) === 1 ? '是' : '否'}`;
  }
  if (key === 'matchType') {
    return `${QUERY_LABELS[key]} ${Number(value) === 1 ? '模糊' : '精准'}`;
  }
  if (key === 'platformFilter') {
    const labels = (Array.isArray(value) ? value : [value]).map((item) => (
      Number(item) === 1 ? 'Wildberries' : 'Ozon'
    ));
    return `${QUERY_LABELS[key]} ${labels.join('、')}`;
  }
  if (key === 'analysisMode') {
    return `${QUERY_LABELS[key]} ${externalProductAnalysisModeLabel(value)}`;
  }
  if (key === 'manualData' && isRecord(value)) {
    const parts = Object.entries(MANUAL_QUERY_LABELS).map(([field, [label, unit]]) => {
      const item = presentValue(value[field]);
      return item ? `${label} ${item}${unit}` : '';
    }).filter(Boolean);
    return parts.length ? `${QUERY_LABELS[key]}：${parts.join(' / ')}` : '';
  }
  if (isRecord(value) && ('min' in value || 'max' in value)) {
    const parts = [
      value.min !== undefined && value.min !== null ? `最低 ${presentValue(value.min)}` : '',
      value.max !== undefined && value.max !== null ? `最高 ${presentValue(value.max)}` : '',
    ].filter(Boolean);
    return `${QUERY_LABELS[key] || key} ${parts.join(' / ')}`;
  }
  return `${QUERY_LABELS[key] || key} ${rendered}`;
}

function getResultTitle(toolId = '') {
  if (toolId.includes('keyword')) return '关键词结果';
  if (toolId.includes('shop')) return '店铺商品';
  if (toolId.includes('category')) return '类目商品';
  if (toolId.includes('product-detail')) return '商品详情';
  return '商品结果';
}

export function buildExternalOzonQueryResult(tool = {}, response = {}, queryInput = {}) {
  const data = getRemoteData(response);
  const mainRecords = firstArray(data, ['records', 'products', 'productList', 'rows', 'list', 'items', 'data']);
  const detailRecord = data?.product && typeof data.product === 'object' ? data.product : null;
  const trendRecords = firstArray(data, ['salesTrendVOList', 'trendList', 'dailyTrend', 'trends']);
  const total = Number(data?.total ?? data?.productCount ?? data?.totalCount ?? mainRecords.length) || mainRecords.length;
  const isKeywordResult = isSmartToolExternalKeywordTool(tool.id);
  const isMarketKeywordResult = tool.id === 'linkfox-seerfar-ozon-market-keyword-search';
  const sections = [];

  const overviewFields = [
    ['totalSales', '总销量'],
    ['dailySales', '日均销量'],
    ['totalRevenue', '总销售额'],
    ['avgPrice', '平均价格'],
    ['rating', '平均评分'],
    ['stock', '库存'],
    ['startDate', '统计开始'],
    ['endDate', '统计结束'],
  ].map(([key, label]) => {
    const value = presentValue(data?.[key]);
    return value ? `${label} ${value}` : '';
  }).filter(Boolean);
  if (overviewFields.length) {
    sections.push({ title: '数据概况', rows: [overviewFields.join(' · ')] });
  }

  if (detailRecord) {
    sections.push({ title: '商品概览', rows: [formatExternalOzonRecord(detailRecord)] });
  }
  if (mainRecords.length && !isKeywordResult) {
    sections.push({
      title: `${getResultTitle(tool.id)}（当前 ${mainRecords.length} 条）`,
      rows: mainRecords.map(formatExternalOzonRecord),
    });
  }
  if (trendRecords.length) {
    sections.push({
      title: `每日趋势（${trendRecords.length} 条）`,
      rows: trendRecords.map(formatExternalOzonRecord),
    });
  }
  if (!sections.length) {
    sections.push({ title: '查询结果', rows: ['没有查到符合当前条件的数据。'] });
  }
  const querySummary = Object.entries(queryInput)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => formatQueryCondition(key, value))
    .filter(Boolean)
    .join(' · ') || '已使用默认查询条件';
  sections.push({
    title: '本次查询',
    rows: [querySummary],
  });

  const computedAnalysis = buildSmartToolExternalOzonAnalysis({
    toolId: tool.id,
    data,
    records: mainRecords,
    detailRecord,
    trends: trendRecords,
    analysisMode: normalizeExternalProductAnalysisMode(queryInput?.analysisMode),
    manualData: queryInput?.manualData,
  });
  const externalAnalysis = computedAnalysis ? { ...computedAnalysis, querySummary } : null;
  const analyzedRecords = Array.isArray(externalAnalysis?.records)
    ? externalAnalysis.records
    : mainRecords;
  const keywordAnalysis = isKeywordResult ? {
    ...externalAnalysis,
    recordCount: analyzedRecords.length,
    records: analyzedRecords,
    platformCounts: analyzedRecords.reduce((counts, record) => {
      const key = Number(record?.platform) === 1 ? 'wildberries' : 'ozon';
      counts[key] += 1;
      return counts;
    }, { ozon: 0, wildberries: 0 }),
    categoryCount: new Set(analyzedRecords.flatMap((record) => (
      Array.isArray(record?.categories) ? record.categories.map(text).filter(Boolean) : []
    ))).size,
    topProductCount: analyzedRecords.reduce((count, record) => (
      count + (Array.isArray(record?.products) ? record.products.length : 0)
    ), 0),
    costTime: Number(data?.costTime) || 0,
    costToken: Number(data?.costToken) || 0,
    querySummary,
  } : null;
  const marketKeywordAnalysis = isMarketKeywordResult ? keywordAnalysis : null;
  const returned = mainRecords.length || (detailRecord ? 1 : 0);
  const empty = returned === 0;
  const requestedSku = text(queryInput?.sku);
  const emptySummary = tool.id === 'linkfox-seerfar-ozon-product-detail-search'
    ? `Seerfar 暂时没有收录 SKU ${requestedSku || '当前商品'} 的商品详情或近 30 天数据，请换一个在售 SKU 后重试。`
    : '没有查到符合当前条件的真实数据，请调整查询条件后重试。';

  return {
    status: empty ? 'empty' : 'ready',
    statusLabel: empty ? '没有查到数据' : '查询完成',
    summary: empty
      ? emptySummary
      : data?.allPagesLoaded === true
      ? `已完整读取 ${mainRecords.length || (detailRecord ? 1 : 0)} 条真实数据。`
      : data?.hasNextPage === true
      ? `本次返回 ${mainRecords.length || (detailRecord ? 1 : 0)} 条，还有下一页数据。`
      : total > mainRecords.length
        ? `共匹配 ${total} 条，本次返回 ${mainRecords.length || (detailRecord ? 1 : 0)} 条。`
        : `本次返回 ${mainRecords.length || (detailRecord ? 1 : 0)} 条真实数据。`,
    sections,
    nextActions: [],
    source: 'external-readonly',
    provider: response?.provider || tool?.providerType || '',
    operation: response?.operation || tool?.operation || '',
    total,
    returned,
    records: analyzedRecords,
    trends: trendRecords,
    viewType: isKeywordResult
      ? 'market-keywords'
      : isSmartToolExternalProductTool(tool.id)
        ? 'external-products'
        : 'default',
    externalAnalysis,
    keywordAnalysis,
    marketKeywordAnalysis,
    allPagesLoaded: data?.allPagesLoaded === true,
    loadedPages: Number(data?.loadedPages) || 1,
  };
}

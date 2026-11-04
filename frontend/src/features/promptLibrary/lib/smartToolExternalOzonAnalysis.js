import {
  EXTERNAL_PRODUCT_ANALYSIS_MODES,
  externalProductAnalysisModeLabel,
  normalizeExternalProductAnalysisMode,
} from './smartToolExternalProductAnalysisMode.js';
import {
  calculateExternalProductUnitProfit,
  hasExternalProductManualData,
  normalizeExternalProductManualData,
} from './smartToolExternalProductManualData.js';

const PRODUCT_TOOL_IDS = new Set([
  'linkfox-seerfar-ozon-shop-search',
  'linkfox-seerfar-ozon-product-detail-search',
  'linkfox-seerfar-ozon-category-search',
  'linkfox-seerfar-ozon-product-report-search',
]);

const KEYWORD_TOOL_IDS = new Set([
  'linkfox-seerfar-ozon-keyword-mining',
  'linkfox-seerfar-ozon-market-keyword-search',
  'linkfox-seerfar-ozon-keyword-back-search',
]);

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finite(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstText(...values) {
  return values.map(text).find(Boolean) || '';
}

function average(values = []) {
  const usable = values.map(finite).filter((value) => value !== null);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function sum(values = []) {
  const usable = values.map(finite).filter((value) => value !== null);
  return usable.length ? usable.reduce((total, value) => total + value, 0) : null;
}

function quantile(values = [], ratio = 0.5) {
  const usable = values.map(finite).filter((value) => value !== null).sort((left, right) => left - right);
  if (!usable.length) return null;
  const position = (usable.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return usable[lower];
  return usable[lower] + (usable[upper] - usable[lower]) * (position - lower);
}

function formatNumber(value) {
  const parsed = finite(value);
  return parsed === null ? '' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(parsed);
}

function formatMoney(value) {
  const rendered = formatNumber(value);
  return rendered ? `${rendered} ₽` : '';
}

function productCategory(record = {}) {
  const info = record?.categoryInfo || {};
  return firstText(
    record.category,
    record.categoryPath,
    info.cnTitlePath,
    info.titlePath,
    info.enTitlePath,
    info.category?.cnTitle,
    info.category?.title,
  );
}

function productImage(record = {}) {
  const imageUrls = Array.isArray(record.imageUrls) ? record.imageUrls : [];
  return firstText(record.imageUrl, record.image, record.picture, imageUrls[0]);
}

function productFulfillment(record = {}) {
  const values = Array.isArray(record.fulfillment) ? record.fulfillment : [record.fulfillment];
  return [...new Set(values.map(text).filter(Boolean))].join(' / ');
}

export function normalizeSmartToolExternalProduct(record = {}, detailData = {}, manualData = null) {
  const detailProduct = detailData?.product && typeof detailData.product === 'object'
    ? detailData.product
    : {};
  const source = { ...record, ...detailProduct };
  const sku = firstText(source.sku, source.ozonId, source.productId, source.id);
  const trends = Array.isArray(detailData?.salesTrendVOList)
    ? detailData.salesTrendVOList
    : Array.isArray(record?.salesTrendVOList)
      ? record.salesTrendVOList
      : [];
  const averageDailyRevenue = average(trends.map((item) => item?.revenue));
  const averageDailyUnits = firstFinite(
    detailData?.dailySales,
    average(trends.map((item) => item?.sales)),
    record.averageDailyUnits,
  );
  const category = productCategory(source);
  const categoryParts = category.split(/\s*(?:>|\/|›)\s*/u).map(text).filter(Boolean);
  const fulfillmentModel = productFulfillment(source);
  const productUrl = firstText(
    source.productUrl,
    source.productPageUrl,
    source.link,
    sku ? `https://www.ozon.ru/product/${sku}/` : '',
  );
  const normalizedManualData = normalizeExternalProductManualData(manualData || record.manualData);
  const usesManualData = hasExternalProductManualData(normalizedManualData);
  const price = firstFinite(source.price);
  const unitProfit = calculateExternalProductUnitProfit(price, normalizedManualData);
  const manualReturnCancelRate = finite(normalizedManualData.returnCancelRate);
  return {
    ...record,
    ...detailProduct,
    id: sku,
    sku,
    skuId: sku,
    productId: sku,
    title: firstText(source.title, source.productName, source.name) || (sku ? `Ozon 商品 ${sku}` : 'Ozon 商品'),
    imageUrl: productImage(source),
    productUrl,
    link: productUrl,
    brand: firstText(source.brandName, source.brand),
    seller: firstText(source.sellerName, source.seller),
    category,
    category1: categoryParts[0] || '',
    category2: categoryParts[1] || '',
    category3: categoryParts[2] || '',
    price,
    sales: firstFinite(detailData?.totalSales, source.sales, source.monthlySales),
    revenue: firstFinite(detailData?.totalRevenue, source.revenue, source.monthlyRevenue),
    stock: firstFinite(detailData?.stock, source.stock),
    averageDailyRevenue: firstFinite(averageDailyRevenue, source.averageDailyRevenue),
    averageDailyUnits,
    rating: firstFinite(source.reviewRating, source.rating, source.ratings),
    reviews: firstFinite(source.reviewCount, source.reviews),
    adSpendShare: firstFinite(source.drr, source.adSpendShare),
    productCardViews: firstFinite(source.sessionCount, source.productCardViews, source.views),
    productCardToCartRate: firstFinite(source.convToCartPdp, source.productCardToCartRate),
    searchCatalogViews: firstFinite(source.sessionCountSearch, source.searchCatalogViews),
    searchCatalogToCartRate: firstFinite(source.convToCartSearch, source.searchCatalogToCartRate),
    impressionToOrderRate: firstFinite(
      source.convViewToOrder,
      source.orderConversionRate,
      source.impressionToOrderRate,
    ),
    fulfillmentModel,
    returnCancelRate: firstFinite(
      manualReturnCancelRate,
      source.returnCancellationRate,
      source.returnCancelRate,
    ),
    returnCancelRateSource: manualReturnCancelRate !== null ? '手动补充' : '查询数据',
    ...(usesManualData ? { manualData: normalizedManualData } : {}),
    ...(unitProfit ? { unitProfit } : {}),
    packageDimensions: firstText(source.dimension, source.dimensions, source.packageDimensions),
    packageWeight: firstFinite(source.weight, source.packageWeight),
    listingDays: firstFinite(source.upDays, source.listingDays),
    followSellerCount: firstFinite(source.sellers, source.followSellerCount),
    trends,
    categoryRanks: Array.isArray(detailData?.categoryRanks)
      ? detailData.categoryRanks
      : Array.isArray(record.categoryRanks)
        ? record.categoryRanks
        : [],
    statisticStartDate: firstText(detailData?.startDate, record.statisticStartDate),
    statisticEndDate: firstText(detailData?.endDate, record.statisticEndDate),
    sfDetailComplete: Boolean(
      (detailData?.product && typeof detailData.product === 'object')
      || record.sfDetailComplete === true
    ),
    sfEnrich: true,
    sfSource: 'seerfar-open-api',
  };
}

export function normalizeSmartToolExternalKeyword(record = {}) {
  const dimension = record?.dimension && typeof record.dimension === 'object' ? record.dimension : {};
  const categoryInfos = Array.isArray(record.categoryInfos)
    ? record.categoryInfos
    : record.categoryInfos && typeof record.categoryInfos === 'object'
      ? [record.categoryInfos]
      : [];
  return {
    ...record,
    ...dimension,
    categoryInfos,
    products: (Array.isArray(record.products) ? record.products : []).map((product) => ({
      ...product,
      sfEnrich: true,
      sfSource: 'seerfar-open-api',
    })),
  };
}

function productInsights(records = []) {
  if (!records.length) return [];
  const byRevenue = [...records].filter((item) => finite(item.revenue) !== null)
    .sort((left, right) => Number(right.revenue) - Number(left.revenue))[0];
  const bySales = [...records].filter((item) => finite(item.sales) !== null)
    .sort((left, right) => Number(right.sales) - Number(left.sales))[0];
  const priceLow = quantile(records.map((item) => item.price), 0.25);
  const priceHigh = quantile(records.map((item) => item.price), 0.75);
  const lowRatingCount = records.filter((item) => finite(item.rating) !== null && Number(item.rating) < 4.3).length;
  const highReturnCount = records.filter((item) => (
    finite(item.returnCancelRate) !== null && Number(item.returnCancelRate) >= 10
  )).length;
  return [
    byRevenue ? `销售额最高：${byRevenue.title}，${formatMoney(byRevenue.revenue)}。` : '',
    bySales ? `销量最高：${bySales.title}，${formatNumber(bySales.sales)} 件。` : '',
    priceLow !== null && priceHigh !== null
      ? `中间 50% 商品价格集中在 ${formatMoney(priceLow)} 至 ${formatMoney(priceHigh)}。`
      : '',
    lowRatingCount ? `${lowRatingCount} 个商品评分低于 4.3，需要检查质量和评价风险。` : '',
    highReturnCount ? `${highReturnCount} 个商品退货取消率不低于 10%，不建议直接跟卖。` : '',
  ].filter(Boolean);
}

function salesTrendInsight(trends = []) {
  const orderedTrends = [...trends].sort((left, right) => text(left?.date).localeCompare(text(right?.date)));
  const recent = sum(orderedTrends.slice(-7).map((item) => item?.sales));
  const previous = sum(orderedTrends.slice(-14, -7).map((item) => item?.sales));
  const trendChange = recent !== null && previous !== null && previous > 0
    ? ((recent - previous) / previous) * 100
    : null;
  return trendChange !== null
    ? `近 7 天销量较前 7 天${trendChange >= 0 ? '增长' : '下降'} ${formatNumber(Math.abs(trendChange))}%。`
    : '';
}

function inventoryInsight(product = {}) {
  const stock = finite(product.stock);
  const dailyUnits = finite(product.averageDailyUnits);
  const stockDays = stock !== null && dailyUnits !== null && dailyUnits > 0 ? stock / dailyUnits : null;
  return stockDays !== null
    ? `按当前日均销量，库存约可销 ${formatNumber(stockDays)} 天${stockDays < 14 ? '，需关注缺货' : stockDays > 90 ? '，需关注积压' : ''}。`
    : '';
}

function productRiskInsights(product = {}) {
  const returnRate = finite(product.returnCancelRate);
  const rating = finite(product.rating);
  return [
    returnRate !== null
      ? `${product.returnCancelRateSource === '手动补充' ? '手动补充的' : ''}退货取消率 ${formatNumber(returnRate)}%${returnRate >= 10 ? '，属于较高风险' : '，当前未达 10% 高风险线'}。`
      : '',
    rating !== null && rating < 4.3 ? `评分为 ${formatNumber(rating)}，需优先检查差评和商品质量。` : '',
  ].filter(Boolean);
}

function productUnitProfitInsight(product = {}) {
  const unitProfit = product.unitProfit;
  if (unitProfit && finite(unitProfit.estimatedUnitProfitRub) !== null) {
    return `按手动补充的成本和费率估算，单件基础利润约 ${formatMoney(unitProfit.estimatedUnitProfitRub)}，基础利润率约 ${formatNumber(unitProfit.estimatedUnitProfitRate)}%；该结果未扣广告费和退货损失。`;
  }
  if (hasExternalProductManualData(product.manualData)) {
    return '已补充部分经营数据；补齐商品成本、平台佣金率、履约费用和税费率后，可继续判断单件基础利润。';
  }
  return '';
}

function competitorDetailInsights(product = {}, trends = []) {
  const categoryRanks = Array.isArray(product.categoryRanks) ? product.categoryRanks : [];
  const latestRank = [...categoryRanks]
    .filter((item) => finite(item?.rank) !== null)
    .sort((left, right) => text(left?.date).localeCompare(text(right?.date)))
    .at(-1);
  const performance = finite(product.sales) !== null || finite(product.revenue) !== null
    ? `近 30 天销量 ${formatNumber(product.sales) || '暂无'} 件，销售额 ${formatMoney(product.revenue) || '暂无'}，当前价格 ${formatMoney(product.price) || '暂无'}。`
    : '';
  const rankInsight = latestRank
    ? `最近类目排名第 ${formatNumber(latestRank.rank)}${finite(latestRank.count) !== null ? `，同类商品约 ${formatNumber(latestRank.count)} 个` : ''}。`
    : '';
  const operator = firstText(product.brand, product.seller)
    ? `当前品牌 ${firstText(product.brand, '暂无')}，卖家 ${firstText(product.seller, '暂无')}，用于核对竞对归属和持续跟踪。`
    : '';
  return [
    performance,
    salesTrendInsight(trends),
    rankInsight,
    inventoryInsight(product),
    productUnitProfitInsight(product),
    operator,
    ...productRiskInsights(product),
  ].filter(Boolean);
}

function ownProductDetailInsights(product = {}, trends = []) {
  const productViews = finite(product.productCardViews);
  const productCartRate = finite(product.productCardToCartRate);
  const searchViews = finite(product.searchCatalogViews);
  const searchCartRate = finite(product.searchCatalogToCartRate);
  const orderRate = finite(product.impressionToOrderRate);
  const adSpendShare = finite(product.adSpendShare);
  return [
    salesTrendInsight(trends),
    productViews !== null || productCartRate !== null
      ? `商品卡浏览 ${formatNumber(productViews) || '暂无'}，商品卡加购转化 ${productCartRate === null ? '暂无' : `${formatNumber(productCartRate)}%`}。`
      : '',
    searchViews !== null || searchCartRate !== null
      ? `搜索和目录浏览 ${formatNumber(searchViews) || '暂无'}，搜索加购转化 ${searchCartRate === null ? '暂无' : `${formatNumber(searchCartRate)}%`}。`
      : '',
    orderRate !== null ? `曝光到下单转化率 ${formatNumber(orderRate)}%，应结合流量和加购环节定位损失位置。` : '',
    adSpendShare !== null ? `广告费用占比 ${formatNumber(adSpendShare)}%，需要结合销售额和自然流量变化复核投放效率。` : '',
    inventoryInsight(product),
    productUnitProfitInsight(product),
    ...productRiskInsights(product),
  ].filter(Boolean);
}

function keywordOpportunity(record = {}) {
  const demand = Math.max(0, firstFinite(record.searchVolume, 0));
  const competition = Math.max(1, firstFinite(record.competingProducts, record.productCount, 1));
  const growth = Math.max(-90, firstFinite(record.count30GrowthRate, 0));
  const conversion = Math.max(0, firstFinite(record.searchUsersToOrdUsers, record.conversion, 0));
  return (demand / competition) * Math.max(0.1, 1 + growth / 100) * (1 + conversion / 100);
}

function keywordInsights(records = []) {
  if (!records.length) return [];
  const bySearch = [...records].filter((item) => finite(item.searchVolume) !== null)
    .sort((left, right) => Number(right.searchVolume) - Number(left.searchVolume))[0];
  const byGrowth = [...records].filter((item) => finite(item.count30GrowthRate) !== null)
    .sort((left, right) => Number(right.count30GrowthRate) - Number(left.count30GrowthRate))[0];
  const byOpportunity = [...records].sort((left, right) => right.opportunityScore - left.opportunityScore)[0];
  const naturalCount = records.filter((item) => finite(item.naturalRank) !== null).length;
  const adCount = records.filter((item) => finite(item.adRank) !== null).length;
  return [
    bySearch ? `搜索量最高：${firstText(bySearch.queryCn, bySearch.query)}，${formatNumber(bySearch.searchVolume)} 次。` : '',
    byGrowth ? `30 天增长最快：${firstText(byGrowth.queryCn, byGrowth.query)}，${formatNumber(byGrowth.count30GrowthRate)}%。` : '',
    byOpportunity ? `综合机会较高：${firstText(byOpportunity.queryCn, byOpportunity.query)}，已结合搜索量、增长和竞争量计算。` : '',
    naturalCount || adCount ? `已识别 ${naturalCount} 条自然排名数据、${adCount} 条广告排名数据。` : '',
  ].filter(Boolean);
}

function buildProductAnalysis(records = [], trends = [], manualData = null) {
  const normalized = records.map((record) => normalizeSmartToolExternalProduct(record, {}, manualData));
  const firstUnitProfit = normalized.find((item) => item.unitProfit)?.unitProfit || null;
  return {
    kind: 'products',
    records: normalized,
    trends,
    overview: {
      recordCount: normalized.length,
      totalSales: sum(normalized.map((item) => item.sales)),
      totalRevenue: sum(normalized.map((item) => item.revenue)),
      averagePrice: average(normalized.map((item) => item.price)),
      averageRating: average(normalized.map((item) => item.rating)),
      totalStock: sum(normalized.map((item) => item.stock)),
      averageReturnCancelRate: average(normalized.map((item) => item.returnCancelRate)),
      ...(firstUnitProfit ? {
        estimatedUnitProfitRub: firstUnitProfit.estimatedUnitProfitRub,
        estimatedUnitProfitRate: firstUnitProfit.estimatedUnitProfitRate,
      } : {}),
    },
    insights: productInsights(normalized),
  };
}

function buildKeywordAnalysis(records = []) {
  const normalized = records.map(normalizeSmartToolExternalKeyword).map((record) => ({
    ...record,
    opportunityScore: keywordOpportunity(record),
  }));
  return {
    kind: 'keywords',
    records: normalized,
    overview: {
      recordCount: normalized.length,
      totalSearchVolume: sum(normalized.map((item) => item.searchVolume)),
      averageGrowth: average(normalized.map((item) => item.count30GrowthRate)),
      averageCompetition: average(normalized.map((item) => item.competingProducts)),
      averageSellers: average(normalized.map((item) => item.sellers)),
      averageConversion: average(normalized.map((item) => item.searchUsersToOrdUsers)),
    },
    insights: keywordInsights(normalized),
  };
}

export function buildSmartToolExternalOzonAnalysis({
  toolId = '',
  data = {},
  records = [],
  detailRecord = null,
  trends = [],
  analysisMode = EXTERNAL_PRODUCT_ANALYSIS_MODES.competitor,
  manualData = null,
} = {}) {
  if (KEYWORD_TOOL_IDS.has(toolId)) return buildKeywordAnalysis(records);
  if (!PRODUCT_TOOL_IDS.has(toolId)) return null;
  if (detailRecord) {
    const normalizedMode = normalizeExternalProductAnalysisMode(analysisMode);
    const normalized = normalizeSmartToolExternalProduct(detailRecord, data, manualData);
    const analysis = buildProductAnalysis([normalized], trends, manualData);
    return {
      ...analysis,
      records: [normalized],
      analysisMode: normalizedMode,
      analysisModeLabel: externalProductAnalysisModeLabel(normalizedMode),
      insights: normalizedMode === EXTERNAL_PRODUCT_ANALYSIS_MODES.own
        ? ownProductDetailInsights(normalized, trends)
        : competitorDetailInsights(normalized, trends),
    };
  }
  return buildProductAnalysis(records, trends);
}

export function isSmartToolExternalKeywordTool(toolId = '') {
  return KEYWORD_TOOL_IDS.has(text(toolId));
}

export function isSmartToolExternalProductTool(toolId = '') {
  return PRODUCT_TOOL_IDS.has(text(toolId));
}

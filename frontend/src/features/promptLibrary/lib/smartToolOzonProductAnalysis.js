import {
  averageOzonMetrics as average,
  medianOzonMetrics as median,
  normalizeOzonMetricText as text,
  ozonMetricValues as metricValues,
  parseOzonProductMetric,
  sumOzonMetrics as sum,
} from './smartToolOzonProductMetricMath.js';
import { evaluateOzonProductDecision } from './smartToolOzonProductDecisionRules.js';

export { parseOzonProductMetric };

const PRICE_BANDS = Object.freeze([
  { key: 'under-1000', label: '1,000 ₽以下', min: 0, max: 1000 },
  { key: '1000-2999', label: '1,000–2,999 ₽', min: 1000, max: 3000 },
  { key: '3000-4999', label: '3,000–4,999 ₽', min: 3000, max: 5000 },
  { key: '5000-9999', label: '5,000–9,999 ₽', min: 5000, max: 10000 },
  { key: '10000-plus', label: '10,000 ₽以上', min: 10000, max: Number.POSITIVE_INFINITY },
]);

const COVERAGE_FIELDS = Object.freeze([
  { key: 'price', label: '售价' },
  { key: 'cardPrice', label: 'Card 价' },
  { key: 'sales', label: '销量' },
  { key: 'orders', label: '订单' },
  { key: 'revenue', label: '销售额' },
  { key: 'growth', label: '增长' },
  { key: 'averageDailyRevenue', label: '日均销售额' },
  { key: 'averageDailyUnits', label: '日均销量' },
  { key: 'stock', label: '库存' },
  { key: 'rating', label: '评分' },
  { key: 'reviews', label: '评价' },
  { key: 'adSpendShare', label: '广告占比' },
  { key: 'promoDays', label: '促销天数' },
  { key: 'promoDiscount', label: '促销折扣' },
  { key: 'promoRevenueShare', label: '促销销售占比' },
  { key: 'paidPromotionDays', label: '付费推广天数' },
  { key: 'productCardViews', label: '商品卡浏览' },
  { key: 'productCardToCartRate', label: '商品页加购率' },
  { key: 'searchCatalogViews', label: '搜索页浏览' },
  { key: 'searchCatalogToCartRate', label: '搜索页加购率' },
  { key: 'impressionToOrderRate', label: '浏览后下单率' },
  { key: 'clickThroughRate', label: '点击率' },
  { key: 'fulfillmentModel', label: '发货模式', kind: 'text' },
  { key: 'redemptionRate', label: '订单完成率' },
  { key: 'returnCancelRate', label: '退货取消率' },
  { key: 'packageDimensions', label: '包裹尺寸', kind: 'text' },
  { key: 'packageWeight', label: '包裹重量', kind: 'text' },
  { key: 'listedAt', label: '上架时间', kind: 'text' },
  { key: 'listingDays', label: '上架天数' },
  { key: 'followSellerCount', label: '跟卖数量' },
  { key: 'followMinPrice', label: '跟卖最低价' },
  { key: 'followMaxPrice', label: '跟卖最高价' },
  { key: 'rfbsRate', label: 'rFBS 佣金', kind: 'text' },
  { key: 'fbpRate', label: 'FBP 佣金', kind: 'text' },
]);

function uniqueCount(records, key) {
  return new Set(records.map((record) => text(record?.[key])).filter(Boolean)).size;
}

function buildFieldCoverage(records) {
  return COVERAGE_FIELDS.map((field) => {
    const count = field.kind === 'text'
      ? records.filter((record) => text(record?.[field.key])).length
      : metricValues(records, field.key, field.key === 'growth').length;
    return {
      ...field,
      count,
      total: records.length,
      percent: records.length ? Math.round((count / records.length) * 100) : 0,
    };
  });
}

function buildPriceBands(records) {
  const prices = metricValues(records, 'price');
  return PRICE_BANDS.map((band) => {
    const count = prices.filter((price) => price >= band.min && price < band.max).length;
    return {
      key: band.key,
      label: band.label,
      min: band.min,
      max: band.max,
      count,
      total: prices.length,
      percent: prices.length ? Math.round((count / prices.length) * 100) : 0,
    };
  });
}

function buildTopBrands(records) {
  const groups = new Map();
  records.forEach((record, index) => {
    const name = text(record?.brand);
    if (!name) return;
    const current = groups.get(name) || { name, count: 0, revenue: 0, revenueCount: 0, firstIndex: index };
    current.count += 1;
    const revenue = parseOzonProductMetric(record?.revenue);
    if (revenue !== null && revenue >= 0) {
      current.revenue += revenue;
      current.revenueCount += 1;
    }
    groups.set(name, current);
  });
  return [...groups.values()]
    .sort((left, right) => (
      right.count - left.count
      || right.revenue - left.revenue
      || left.firstIndex - right.firstIndex
    ))
    .slice(0, 8)
    .map(({ firstIndex: _firstIndex, ...brand }) => brand);
}

function buildTopProducts(records) {
  return records
    .map((record, index) => ({
      ...record,
      _originalIndex: index,
      _revenue: parseOzonProductMetric(record?.revenue),
      _sales: parseOzonProductMetric(record?.sales),
    }))
    .sort((left, right) => (
      (right._revenue ?? -1) - (left._revenue ?? -1)
      || (right._sales ?? -1) - (left._sales ?? -1)
      || left._originalIndex - right._originalIndex
    ))
    .slice(0, 10)
    .map(({ _originalIndex, _revenue, _sales, ...record }, index) => ({ ...record, rank: index + 1 }));
}

function buildInsights({ records, priceStats, revenueStats, priceBands, topBrands, periodComparison, growthStats }) {
  const insights = [];
  const leadingBand = [...priceBands].sort((left, right) => right.count - left.count)[0];
  if (leadingBand?.count) {
    insights.push({
      key: 'price-band',
      tone: 'primary',
      title: '常见售价区间',
      detail: `${leadingBand.label} 有 ${leadingBand.count} 款，占有价格商品的 ${leadingBand.percent}%。`,
    });
  }

  if (priceStats.median !== null && priceStats.average !== null) {
    const spread = priceStats.median ? Math.abs(priceStats.average - priceStats.median) / priceStats.median : 0;
    insights.push({
      key: 'price-shape',
      tone: spread >= 0.2 ? 'warning' : 'neutral',
      title: spread >= 0.2 ? '少数高价商品拉高了平均价' : '大部分商品价格相近',
      detail: spread >= 0.2
        ? '平均价和中间价差距较大，判断常见售价时优先看中间价。'
        : '平均价和中间价接近，可以直接参考常见售价区间。',
    });
  }

  if (revenueStats.total !== null) {
    const topRevenue = [...records]
      .map((record) => parseOzonProductMetric(record?.revenue))
      .filter((value) => value !== null && value >= 0)
      .sort((left, right) => right - left)
      .slice(0, 10)
      .reduce((total, value) => total + value, 0);
    const concentration = revenueStats.total > 0 ? Math.round((topRevenue / revenueStats.total) * 100) : 0;
    insights.push({
      key: 'gmv-concentration',
      tone: concentration >= 50 ? 'warning' : 'success',
      title: '热销商品销售额占比',
      detail: `销售额最高的前 10 款占总销售额 ${concentration}%${concentration >= 50 ? '，热销商品抢走了大部分销量。' : '，销量分布比较分散。'}`,
    });
  }

  if (topBrands[0]) {
    const share = records.length ? Math.round((topBrands[0].count / records.length) * 100) : 0;
    insights.push({
      key: 'brand-leader',
      tone: share >= 20 ? 'warning' : 'neutral',
      title: '头部品牌占比',
      detail: `${topBrands[0].name} 有 ${topBrands[0].count} 款，占本次商品的 ${share}%。`,
    });
  }

  if (growthStats.median !== null) {
    insights.push({
      key: 'product-growth',
      tone: growthStats.median >= 0 ? 'success' : 'warning',
      title: '商品销售额变化',
      detail: `${growthStats.count} 款有变化数据，中间水平为 ${growthStats.median.toFixed(1)}%。`,
    });
  }

  if (periodComparison.revenueGrowthPercent !== null) {
    const growth = periodComparison.revenueGrowthPercent;
    insights.push({
      key: 'period-growth',
      tone: growth >= 0 ? 'success' : 'warning',
      title: '和上个周期相比',
      detail: `同一批商品的销售额比上个同样长的周期${growth >= 0 ? '增长' : '下降'} ${Math.abs(growth).toFixed(1)}%。`,
    });
  }

  if (periodComparison.lostProfitTotal !== null && periodComparison.lostProfitTotal > 0) {
    insights.push({
      key: 'lost-profit',
      tone: 'warning',
      title: '缺货可能少卖',
      detail: `${periodComparison.lostProfitCount} 款商品有缺货损失数据，少卖金额合计 ${periodComparison.lostProfitTotal.toFixed(2)} ₽。`,
    });
  }

  const salesMedian = median(metricValues(records, 'sales'));
  const stockRisks = records.filter((record) => {
    const stock = parseOzonProductMetric(record?.stock);
    const sales = parseOzonProductMetric(record?.sales);
    return stock !== null && stock <= 10 && sales !== null && salesMedian !== null && sales >= salesMedian;
  });
  if (stockRisks.length) {
    insights.push({
      key: 'stock-risk',
      tone: 'warning',
      title: '热销商品快没库存',
      detail: `${stockRisks.length} 款商品库存不超过 10 件，而且销量不低，容易断货。`,
    });
  }

  return insights.slice(0, 5);
}

export function analyzeOzonProductRecords(records = [], { query = '', capturedAt = '' } = {}) {
  const safeRecords = Array.isArray(records) ? records.filter(Boolean) : [];
  const prices = metricValues(safeRecords, 'price');
  const cardPrices = metricValues(safeRecords, 'cardPrice');
  const revenues = metricValues(safeRecords, 'revenue');
  const sales = metricValues(safeRecords, 'sales');
  const orders = metricValues(safeRecords, 'orders');
  const growth = metricValues(safeRecords, 'growth', true);
  const averageDailyRevenue = metricValues(safeRecords, 'averageDailyRevenue');
  const averageDailyUnits = metricValues(safeRecords, 'averageDailyUnits');
  const stocks = metricValues(safeRecords, 'stock');
  const ratings = metricValues(safeRecords, 'rating');
  const lostProfit = metricValues(safeRecords, 'lostProfit');
  const previousRevenue = metricValues(safeRecords, 'previousRevenue');
  const revenuePotential = metricValues(safeRecords, 'revenuePotential');
  const comparableRevenue = safeRecords.reduce((current, record) => {
    const previous = parseOzonProductMetric(record?.previousRevenue);
    const revenue = parseOzonProductMetric(record?.revenue);
    if (previous === null || previous < 0 || revenue === null || revenue < 0) return current;
    return {
      count: current.count + 1,
      previous: current.previous + previous,
      current: current.current + revenue,
    };
  }, { count: 0, previous: 0, current: 0 });
  const priceStats = {
    count: prices.length,
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    average: average(prices),
    median: median(prices),
  };
  const revenueStats = {
    count: revenues.length,
    total: sum(revenues),
    average: average(revenues),
    median: median(revenues),
  };
  const priceBands = buildPriceBands(safeRecords);
  const topBrands = buildTopBrands(safeRecords);
  const periodComparison = {
    comparableCount: comparableRevenue.count,
    currentRevenueTotal: comparableRevenue.count ? comparableRevenue.current : null,
    previousRevenueCount: previousRevenue.length,
    previousRevenueTotal: sum(previousRevenue),
    revenueGrowthPercent: comparableRevenue.count && comparableRevenue.previous > 0
      ? ((comparableRevenue.current - comparableRevenue.previous) / comparableRevenue.previous) * 100
      : null,
    revenuePotentialCount: revenuePotential.length,
    revenuePotentialTotal: sum(revenuePotential),
    lostProfitCount: lostProfit.length,
    lostProfitTotal: sum(lostProfit),
  };
  const analysis = {
    version: 2,
    query: text(query),
    capturedAt: text(capturedAt),
    recordCount: safeRecords.length,
    currency: 'RUB',
    priceStats,
    cardPriceStats: { count: cardPrices.length, average: average(cardPrices), median: median(cardPrices) },
    revenueStats,
    salesStats: { count: sales.length, total: sum(sales), average: average(sales), median: median(sales) },
    ordersStats: { count: orders.length, total: sum(orders), average: average(orders), median: median(orders) },
    growthStats: { count: growth.length, average: average(growth), median: median(growth) },
    averageDailyRevenueStats: { count: averageDailyRevenue.length, total: sum(averageDailyRevenue), average: average(averageDailyRevenue), median: median(averageDailyRevenue) },
    averageDailyUnitsStats: { count: averageDailyUnits.length, total: sum(averageDailyUnits), average: average(averageDailyUnits), median: median(averageDailyUnits) },
    stockStats: { count: stocks.length, total: sum(stocks), average: average(stocks), median: median(stocks) },
    ratingStats: { count: ratings.length, average: average(ratings), median: median(ratings) },
    periodComparison,
    brandCount: uniqueCount(safeRecords, 'brand'),
    sellerCount: uniqueCount(safeRecords, 'seller'),
    fieldCoverage: buildFieldCoverage(safeRecords),
    priceBands,
    topBrands,
    topProducts: buildTopProducts(safeRecords),
    records: safeRecords,
  };
  const decision = evaluateOzonProductDecision(safeRecords, {
    priceBands,
    periodComparison,
  });
  analysis.decision = decision;
  analysis.insights = [
    ...decision.insights,
    ...buildInsights({
      records: safeRecords,
      priceStats,
      revenueStats,
      priceBands,
      topBrands,
      periodComparison,
      growthStats: analysis.growthStats,
    }),
  ].slice(0, 10);
  return analysis;
}

import {
  averageOzonMetrics,
  clampOzonMetric,
  medianOzonMetrics,
  normalizeOzonMetricText,
  ozonMetricValues,
  parseOzonProductMetric,
  pearsonOzonMetricPairs,
  percentageOzonMetric,
  roundOzonMetric,
  sumOzonMetrics,
} from './smartToolOzonProductMetricMath.js';

export const OZON_PRODUCT_DECISION_RULES_VERSION = 'ozon-product-decision-v1';

const SCORE_DIMENSIONS = Object.freeze([
  { key: 'momentum', label: '销量趋势', weight: 20 },
  { key: 'competition', label: '市场竞争', weight: 20 },
  { key: 'conversion', label: '浏览下单', weight: 15 },
  { key: 'promotion', label: '广告影响', weight: 10 },
  { key: 'inventory', label: '库存情况', weight: 15 },
  { key: 'fulfillment', label: '退货取消', weight: 10 },
  { key: 'followSellers', label: '跟卖竞争', weight: 10 },
]);

const CONVERSION_RULES = Object.freeze([
  { key: 'clickThroughRate', label: '点击率', good: 8, bad: 2 },
  { key: 'productCardToCartRate', label: '商品页加购率', good: 10, bad: 3 },
  { key: 'searchCatalogToCartRate', label: '搜索页加购率', good: 7, bad: 2 },
  { key: 'impressionToOrderRate', label: '浏览后下单率', good: 3, bad: 0.8 },
]);

function round(value, digits = 1) {
  return roundOzonMetric(value, digits);
}

function metric(value) {
  return parseOzonProductMetric(value);
}

function scoreHigher(value, good, bad) {
  if (!Number.isFinite(value)) return null;
  if (good <= bad) return null;
  return round(clampOzonMetric(((value - bad) / (good - bad)) * 100), 0);
}

function scoreLower(value, good, bad) {
  if (!Number.isFinite(value)) return null;
  if (bad <= good) return null;
  return round(clampOzonMetric(((bad - value) / (bad - good)) * 100), 0);
}

function scoreGrowth(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 50) return 100;
  if (value >= 30) return 85;
  if (value >= 10) return 70;
  if (value >= 0) return 58;
  if (value >= -10) return 42;
  if (value >= -20) return 28;
  return 15;
}

function scoreTone(score) {
  if (!Number.isFinite(score)) return 'neutral';
  if (score >= 70) return 'success';
  if (score >= 50) return 'neutral';
  return 'warning';
}

function concentrationByField(records, key) {
  const groups = new Map();
  records.forEach((record) => {
    const value = normalizeOzonMetricText(record?.[key]);
    if (value) groups.set(value, (groups.get(value) || 0) + 1);
  });
  const counts = [...groups.entries()].sort((left, right) => right[1] - left[1]);
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  const leader = counts[0] || null;
  return {
    groupCount: groups.size,
    leaderName: leader?.[0] || '',
    leaderCount: leader?.[1] || 0,
    leaderShare: leader ? percentageOzonMetric(leader[1], total, 1) : null,
  };
}

function buildMarketStructure(records) {
  const revenues = ozonMetricValues(records, 'revenue').sort((left, right) => right - left);
  const revenueTotal = sumOzonMetrics(revenues);
  const top10RevenueShare = revenueTotal > 0
    ? percentageOzonMetric(sumOzonMetrics(revenues.slice(0, 10)), revenueTotal, 1)
    : null;
  const brand = concentrationByField(records, 'brand');
  const seller = concentrationByField(records, 'seller');
  const scoreParts = [
    revenues.length < 20 || top10RevenueShare === null ? null : clampOzonMetric(100 - top10RevenueShare),
    brand.leaderShare === null ? null : clampOzonMetric(100 - brand.leaderShare * 1.5),
    seller.leaderShare === null ? null : clampOzonMetric(100 - seller.leaderShare * 1.5),
  ].filter(Number.isFinite);
  const score = round(averageOzonMetrics(scoreParts), 0);
  const level = score === null ? 'unknown' : score >= 70 ? 'low' : score >= 45 ? 'medium' : 'high';
  return {
    score,
    level,
    levelLabel: level === 'low' ? '品牌和卖家比较分散' : level === 'medium' ? '部分品牌和卖家占比较高' : level === 'high' ? '少数品牌和卖家占了大头' : '暂时看不准',
    revenueCount: revenues.length,
    top10RevenueShare,
    brand,
    seller,
  };
}

function buildPricePerformance(records, priceBands = []) {
  const priceSalesPairs = records.map((record) => {
    const price = metric(record?.price);
    const sales = metric(record?.sales);
    return price > 0 && sales !== null && sales >= 0
      ? [Math.log1p(price), Math.log1p(sales)]
      : null;
  }).filter(Boolean);
  const correlation = round(pearsonOzonMetricPairs(priceSalesPairs), 2);
  const bands = priceBands.map((band) => {
    const matching = records.filter((record) => {
      const price = metric(record?.price);
      return price !== null && price >= band.min && price < band.max;
    });
    const sales = ozonMetricValues(matching, 'sales');
    const revenue = ozonMetricValues(matching, 'revenue');
    return {
      key: band.key,
      label: band.label,
      productCount: matching.length,
      salesCount: sales.length,
      salesTotal: sumOzonMetrics(sales),
      averageSales: averageOzonMetrics(sales),
      revenueCount: revenue.length,
      revenueTotal: sumOzonMetrics(revenue),
      averageRevenue: averageOzonMetrics(revenue),
    };
  });
  const bestRevenueBand = [...bands]
    .filter((band) => band.revenueCount > 0)
    .sort((left, right) => right.revenueTotal - left.revenueTotal)[0] || null;
  const bestVelocityBand = [...bands]
    .filter((band) => band.salesCount > 0)
    .sort((left, right) => right.averageSales - left.averageSales)[0] || null;
  const relation = correlation === null
    ? 'unknown'
    : correlation <= -0.35
      ? 'lower-price-faster'
      : correlation >= 0.35
        ? 'higher-price-supported'
        : 'weak';
  return {
    pairCount: priceSalesPairs.length,
    priceSalesCorrelation: correlation,
    relation,
    relationLabel: relation === 'lower-price-faster'
      ? '低价商品卖得更快'
      : relation === 'higher-price-supported'
        ? '高价商品也能卖得动'
        : relation === 'weak'
          ? '价格变化对销量影响不大'
          : '暂时看不准',
    bands,
    bestRevenueBand,
    bestVelocityBand,
  };
}

function buildTrafficConversion(records) {
  const stages = CONVERSION_RULES.map((rule) => {
    const values = ozonMetricValues(records, rule.key);
    const value = medianOzonMetrics(values);
    return {
      ...rule,
      count: values.length,
      median: value,
      score: scoreHigher(value, rule.good, rule.bad),
    };
  }).filter((stage) => stage.count > 0);
  const score = round(averageOzonMetrics(stages.map((stage) => stage.score).filter(Number.isFinite)), 0);
  const bottleneck = [...stages]
    .filter((stage) => Number.isFinite(stage.score))
    .sort((left, right) => left.score - right.score)[0] || null;
  return {
    score,
    status: score === null ? 'unknown' : score >= 70 ? 'healthy' : score >= 45 ? 'watch' : 'weak',
    stages,
    bottleneck,
  };
}

function buildPromotionDependency(records) {
  const adSpendShares = ozonMetricValues(records, 'adSpendShare');
  const promoRevenueShares = ozonMetricValues(records, 'promoRevenueShare');
  const paidPromotionDays = ozonMetricValues(records, 'paidPromotionDays');
  const adSpendMedian = medianOzonMetrics(adSpendShares);
  const promoRevenueMedian = medianOzonMetrics(promoRevenueShares);
  const scoreParts = [
    scoreLower(adSpendMedian, 5, 20),
    scoreLower(promoRevenueMedian, 20, 70),
  ].filter(Number.isFinite);
  const score = round(averageOzonMetrics(scoreParts), 0);
  const paidProductShare = paidPromotionDays.length
    ? percentageOzonMetric(paidPromotionDays.filter((value) => value > 0).length, paidPromotionDays.length, 1)
    : null;
  return {
    score,
    dependency: score === null ? 'unknown' : score >= 70 ? 'low' : score >= 45 ? 'medium' : 'high',
    adSpendCount: adSpendShares.length,
    adSpendMedian,
    promoRevenueCount: promoRevenueShares.length,
    promoRevenueMedian,
    paidPromotionCount: paidPromotionDays.length,
    paidProductShare,
  };
}

function scoreInventoryCoverDays(days) {
  if (!Number.isFinite(days)) return null;
  if (days < 3) return 10;
  if (days < 7) return 35;
  if (days < 14) return 70;
  if (days <= 45) return 100;
  if (days <= 60) return 75;
  if (days <= 90) return 50;
  return 25;
}

function buildInventoryHealth(records) {
  const coverRows = records.map((record) => {
    const stock = metric(record?.stock);
    const dailyUnits = metric(record?.averageDailyUnits);
    if (stock === null || stock < 0 || dailyUnits === null || dailyUnits <= 0) return null;
    return { id: record?.id, days: stock / dailyUnits };
  }).filter(Boolean);
  const coverScores = coverRows.map((row) => scoreInventoryCoverDays(row.days)).filter(Number.isFinite);
  const salesMedian = medianOzonMetrics(ozonMetricValues(records, 'sales'));
  const fallbackComparable = records.filter((record) => (
    metric(record?.stock) !== null && metric(record?.sales) !== null
  ));
  const highVelocityLowStock = salesMedian === null ? [] : fallbackComparable.filter((record) => (
    metric(record.stock) <= 10 && metric(record.sales) >= salesMedian
  ));
  const fallbackRiskShare = fallbackComparable.length
    ? percentageOzonMetric(highVelocityLowStock.length, fallbackComparable.length, 1)
    : null;
  const score = coverScores.length
    ? round(averageOzonMetrics(coverScores), 0)
    : fallbackRiskShare === null
      ? null
      : round(clampOzonMetric(100 - fallbackRiskShare * 0.8), 0);
  const lowCoverCount = coverRows.filter((row) => row.days < 7).length;
  const overstockCount = coverRows.filter((row) => row.days > 90).length;
  return {
    score,
    status: score === null ? 'unknown' : score >= 70 ? 'healthy' : score >= 45 ? 'watch' : 'risk',
    coverageCount: coverRows.length,
    medianCoverDays: round(medianOzonMetrics(coverRows.map((row) => row.days)), 1),
    lowCoverCount,
    overstockCount,
    fallbackComparableCount: fallbackComparable.length,
    highVelocityLowStockCount: highVelocityLowStock.length,
    fallbackRiskShare,
  };
}

function buildFulfillmentHealth(records) {
  const redemptionValues = ozonMetricValues(records, 'redemptionRate');
  const returnValues = ozonMetricValues(records, 'returnCancelRate');
  const redemptionMedian = medianOzonMetrics(redemptionValues);
  const returnCancelMedian = medianOzonMetrics(returnValues);
  const score = round(averageOzonMetrics([
    scoreHigher(redemptionMedian, 95, 70),
    scoreLower(returnCancelMedian, 5, 20),
  ].filter(Number.isFinite)), 0);
  return {
    score,
    status: score === null ? 'unknown' : score >= 70 ? 'healthy' : score >= 45 ? 'watch' : 'risk',
    redemptionCount: redemptionValues.length,
    redemptionMedian,
    returnCancelCount: returnValues.length,
    returnCancelMedian,
  };
}

function buildFollowSellerPressure(records) {
  const followCounts = ozonMetricValues(records, 'followSellerCount');
  const followMedian = medianOzonMetrics(followCounts);
  const followedProductCount = followCounts.filter((value) => value > 0).length;
  const pressuredCount = followCounts.filter((value) => value >= 3).length;
  const pricePairs = records.map((record) => {
    const price = metric(record?.price);
    const followMinPrice = metric(record?.followMinPrice);
    return price !== null && price > 0 && followMinPrice !== null
      ? { price, followMinPrice }
      : null;
  }).filter(Boolean);
  const undercutCount = pricePairs.filter(({ price, followMinPrice }) => followMinPrice < price).length;
  const undercutShare = pricePairs.length
    ? percentageOzonMetric(undercutCount, pricePairs.length, 1)
    : null;
  const scoreParts = [
    followMedian === null ? null : scoreLower(followMedian, 0, 5),
    undercutShare === null ? null : scoreLower(undercutShare, 0, 60),
  ].filter(Number.isFinite);
  const score = round(averageOzonMetrics(scoreParts), 0);
  return {
    score,
    pressure: score === null ? 'unknown' : score >= 70 ? 'low' : score >= 45 ? 'medium' : 'high',
    count: followCounts.length,
    followedProductCount,
    median: followMedian,
    pressuredCount,
    comparedPriceCount: pricePairs.length,
    undercutCount,
    undercutShare,
  };
}

function buildListingMomentum(records) {
  const salesMedian = medianOzonMetrics(ozonMetricValues(records, 'sales'));
  const listingRows = records.map((record) => {
    const listingDays = metric(record?.listingDays);
    if (listingDays === null || listingDays < 0) return null;
    const sales = metric(record?.sales);
    const growth = metric(record?.growth);
    const newProduct = listingDays <= 90;
    const winner = newProduct && (
      growth !== null && growth > 0
      || sales !== null && salesMedian !== null && sales >= salesMedian
    );
    return { newProduct, winner };
  }).filter(Boolean);
  const newCount = listingRows.filter((row) => row.newProduct).length;
  const newWinnerCount = listingRows.filter((row) => row.winner).length;
  return {
    count: listingRows.length,
    newCount,
    newShare: percentageOzonMetric(newCount, listingRows.length, 1),
    newWinnerCount,
    newWinnerShare: percentageOzonMetric(newWinnerCount, newCount, 1),
  };
}

function buildMarketMomentum(records, periodComparison = {}) {
  const growthValues = ozonMetricValues(records, 'growth', true);
  const growthMedian = medianOzonMetrics(growthValues);
  const periodGrowth = Number.isFinite(periodComparison?.revenueGrowthPercent)
    ? periodComparison.revenueGrowthPercent
    : null;
  const score = round(averageOzonMetrics([
    scoreGrowth(growthMedian),
    scoreGrowth(periodGrowth),
  ].filter(Number.isFinite)), 0);
  return {
    score,
    growthCount: growthValues.length,
    growthMedian,
    periodGrowth,
  };
}

function dimensionDetail(key, context) {
  switch (key) {
    case 'momentum':
      return context.marketMomentum.growthMedian === null
        ? `和上个周期相比，销售额变化 ${round(context.marketMomentum.periodGrowth, 1)}%。`
        : `商品销售额变化的中间水平是 ${round(context.marketMomentum.growthMedian, 1)}%。`;
    case 'competition':
      return context.marketStructure.top10RevenueShare === null
        ? `${context.marketStructure.levelLabel}。`
        : `销售额最高的前 10 款占总销售额 ${context.marketStructure.top10RevenueShare}%。`;
    case 'conversion':
      return context.trafficConversion.bottleneck
        ? `${context.trafficConversion.bottleneck.label}的中间水平是 ${round(context.trafficConversion.bottleneck.median, 1)}%。`
        : '已有浏览和下单数据。';
    case 'promotion':
      return context.promotionDependency.adSpendMedian === null
        ? `促销带来的销售额占比，中间水平为 ${round(context.promotionDependency.promoRevenueMedian, 1)}%。`
        : `广告销售占比的中间水平是 ${round(context.promotionDependency.adSpendMedian, 1)}%。`;
    case 'inventory':
      return context.inventoryHealth.medianCoverDays === null
        ? `热销但库存不多的商品有 ${context.inventoryHealth.highVelocityLowStockCount} 款。`
        : `按当前销量，库存通常还能卖 ${context.inventoryHealth.medianCoverDays} 天。`;
    case 'fulfillment':
      return context.fulfillmentHealth.returnCancelMedian === null
        ? `订单完成率的中间水平是 ${round(context.fulfillmentHealth.redemptionMedian, 1)}%。`
        : `退货取消率的中间水平是 ${round(context.fulfillmentHealth.returnCancelMedian, 1)}%。`;
    case 'followSellers':
      return context.followSellerPressure.undercutShare === null
        ? `常见跟卖数量是 ${round(context.followSellerPressure.median, 1)} 个。`
        : `有跟卖价格的商品中，${context.followSellerPressure.undercutShare}% 遇到了更低价。`;
    default:
      return '';
  }
}

function buildOpportunityDecision(context) {
  const scoreByKey = {
    momentum: context.marketMomentum.score,
    competition: context.marketStructure.score,
    conversion: context.trafficConversion.score,
    promotion: context.promotionDependency.score,
    inventory: context.inventoryHealth.score,
    fulfillment: context.fulfillmentHealth.score,
    followSellers: context.followSellerPressure.score,
  };
  const breakdown = SCORE_DIMENSIONS.map((dimension) => ({
    ...dimension,
    score: scoreByKey[dimension.key],
    tone: scoreTone(scoreByKey[dimension.key]),
    detail: Number.isFinite(scoreByKey[dimension.key]) ? dimensionDetail(dimension.key, context) : '暂无足够数据。',
  }));
  const available = breakdown.filter((item) => Number.isFinite(item.score));
  const availableWeight = available.reduce((total, item) => total + item.weight, 0);
  const weightedScore = availableWeight > 0
    ? available.reduce((total, item) => total + item.score * item.weight, 0) / availableWeight
    : null;
  const evidenceCoveragePercent = round((availableWeight / 100) * 100, 0);
  const score = available.length >= 3 ? round(weightedScore, 0) : null;
  const confidence = evidenceCoveragePercent >= 70 ? 'high' : evidenceCoveragePercent >= 45 ? 'medium' : 'low';
  const label = score === null
    ? '暂时看不准'
    : score >= 75
      ? '重点关注'
      : score >= 60
        ? '可以验证'
        : score >= 45
          ? '谨慎试款'
          : '暂缓跟进';
  const recommendation = score === null
    ? '现有数据还不够，补充销售变化、下单、库存或退货数据后再判断。'
    : score >= 75
      ? '整体表现不错，可以列为重点候选，再少量进货验证。'
      : score >= 60
        ? '值得继续测试，先用少量商品验证下单和利润。'
        : score >= 45
          ? '有一定机会，但问题也比较明显，先解决短板再试款。'
          : '目前问题比机会多，不建议直接大量铺货。';
  const positive = available.filter((item) => item.score >= 65).sort((left, right) => right.score - left.score);
  const negative = available.filter((item) => item.score < 50).sort((left, right) => left.score - right.score);
  const topFallback = [...available].sort((left, right) => right.score - left.score).slice(0, 2);
  const reasons = (positive.length ? positive : topFallback).slice(0, 3).map((item) => ({
    key: item.key,
    title: item.label,
    detail: item.detail,
    score: item.score,
  }));
  const risks = negative.map((item) => ({
    key: item.key,
    title: item.label,
    detail: item.detail,
    score: item.score,
  }));
  const missingDimensions = breakdown
    .filter((item) => !Number.isFinite(item.score))
    .map((item) => ({ key: item.key, label: item.label }));
  const actionByKey = {
    momentum: '看看最近 30 天的增长能不能持续，不要只看某一天的高销量。',
    competition: '避开卖得最火但款式雷同的商品，优先找品牌和卖家更分散的细分类目。',
    conversion: `先改善最弱的下单环节（${context.trafficConversion.bottleneck?.label || '暂时看不出来'}），再增加曝光。`,
    promotion: '单独看不投广告时的订单，确认停止广告或促销后还能正常卖。',
    inventory: '根据每天实际销量设置补货线，避免断货或压货。',
    fulfillment: '先查看退货原因、包装和发货方式，再决定要不要增加备货。',
    followSellers: '查看最低跟卖价和可降价空间，避免上架后马上打价格战。',
  };
  const actions = negative.map((item) => actionByKey[item.key]).filter(Boolean);
  if (context.pricePerformance.bestRevenueBand) {
    actions.push(`优先在 ${context.pricePerformance.bestRevenueBand.label} 这个价位选几款商品测试。`);
  }
  if (!actions.length && score !== null) actions.push('选择 3–5 款商品少量测试，再查看下单、退货和实际利润。');
  if (missingDimensions.length) actions.push(`补齐${missingDimensions.slice(0, 3).map((item) => item.label).join('、')}数据后再看评分。`);
  return {
    score,
    label,
    recommendation,
    confidence,
    confidenceLabel: confidence === 'high' ? '数据较全' : confidence === 'medium' ? '数据一般' : '数据较少',
    evidenceCoveragePercent,
    availableDimensionCount: available.length,
    totalDimensionCount: SCORE_DIMENSIONS.length,
    breakdown,
    reasons,
    risks,
    missingDimensions,
    actions: [...new Set(actions)].slice(0, 4),
  };
}

function buildDecisionInsights(context) {
  const insights = [];
  const { pricePerformance, trafficConversion, promotionDependency, inventoryHealth, fulfillmentHealth, followSellerPressure, listingMomentum } = context;
  if (pricePerformance.priceSalesCorrelation !== null) {
    insights.push({
      key: 'price-sales-relation',
      tone: pricePerformance.relation === 'lower-price-faster' ? 'warning' : 'neutral',
      title: '价格对销量的影响',
      detail: `${pricePerformance.relationLabel}，本次比较了 ${pricePerformance.pairCount} 款商品。`,
    });
  }
  if (trafficConversion.bottleneck) {
    insights.push({
      key: 'conversion-bottleneck',
      tone: scoreTone(trafficConversion.bottleneck.score),
      title: '下单环节问题',
      detail: `${trafficConversion.bottleneck.label}表现最弱，中间水平是 ${round(trafficConversion.bottleneck.median, 1)}%。`,
    });
  }
  if (promotionDependency.score !== null) {
    insights.push({
      key: 'promotion-dependency',
      tone: promotionDependency.dependency === 'high' ? 'warning' : 'neutral',
      title: '广告带来的销量',
      detail: promotionDependency.adSpendMedian !== null
        ? `广告销售占比的中间水平是 ${round(promotionDependency.adSpendMedian, 1)}%，广告影响${promotionDependency.dependency === 'high' ? '较大' : promotionDependency.dependency === 'medium' ? '一般' : '较小'}。`
        : `促销带来的销售额占比，中间水平为 ${round(promotionDependency.promoRevenueMedian, 1)}%。`,
    });
  }
  if (inventoryHealth.score !== null) {
    insights.push({
      key: 'inventory-health',
      tone: inventoryHealth.status === 'risk' ? 'warning' : inventoryHealth.status === 'healthy' ? 'success' : 'neutral',
      title: '库存情况',
      detail: inventoryHealth.medianCoverDays !== null
        ? `按当前销量，库存通常还能卖 ${inventoryHealth.medianCoverDays} 天；不足 7 天的有 ${inventoryHealth.lowCoverCount} 款，超过 90 天的有 ${inventoryHealth.overstockCount} 款。`
        : `热销但库存不多的商品有 ${inventoryHealth.highVelocityLowStockCount} 款。`,
    });
  }
  if (fulfillmentHealth.score !== null) {
    insights.push({
      key: 'fulfillment-health',
      tone: fulfillmentHealth.status === 'risk' ? 'warning' : fulfillmentHealth.status === 'healthy' ? 'success' : 'neutral',
      title: '退货和取消情况',
      detail: `订单完成率的中间水平是 ${round(fulfillmentHealth.redemptionMedian, 1) ?? '—'}%，退货取消率的中间水平是 ${round(fulfillmentHealth.returnCancelMedian, 1) ?? '—'}%。`,
    });
  }
  if (followSellerPressure.score !== null) {
    insights.push({
      key: 'follow-seller-pressure',
      tone: followSellerPressure.pressure === 'high' ? 'warning' : 'neutral',
      title: '跟卖竞争',
      detail: followSellerPressure.undercutShare === null
        ? `常见跟卖数量是 ${round(followSellerPressure.median, 1)} 个。`
        : `${followSellerPressure.undercutShare}% 的商品遇到了更低的跟卖价。`,
    });
  }
  if (listingMomentum.newCount > 0) {
    insights.push({
      key: 'new-product-momentum',
      tone: listingMomentum.newWinnerShare >= 50 ? 'success' : 'neutral',
      title: '新品销售情况',
      detail: `上架 90 天内的商品有 ${listingMomentum.newCount} 款，其中 ${listingMomentum.newWinnerCount} 款销量不低或还在增长。`,
    });
  }
  return insights.slice(0, 6);
}

export function evaluateOzonProductDecision(records = [], {
  priceBands = [],
  periodComparison = {},
} = {}) {
  const safeRecords = Array.isArray(records) ? records.filter(Boolean) : [];
  const context = {
    marketStructure: buildMarketStructure(safeRecords),
    pricePerformance: buildPricePerformance(safeRecords, priceBands),
    trafficConversion: buildTrafficConversion(safeRecords),
    promotionDependency: buildPromotionDependency(safeRecords),
    inventoryHealth: buildInventoryHealth(safeRecords),
    fulfillmentHealth: buildFulfillmentHealth(safeRecords),
    followSellerPressure: buildFollowSellerPressure(safeRecords),
    listingMomentum: buildListingMomentum(safeRecords),
    marketMomentum: buildMarketMomentum(safeRecords, periodComparison),
  };
  const opportunity = buildOpportunityDecision(context);
  return {
    rulesVersion: OZON_PRODUCT_DECISION_RULES_VERSION,
    opportunity,
    ...context,
    profitability: {
      ready: false,
      missingFields: ['采购成本', '平台佣金', '物流费用'],
    },
    insights: buildDecisionInsights(context),
  };
}

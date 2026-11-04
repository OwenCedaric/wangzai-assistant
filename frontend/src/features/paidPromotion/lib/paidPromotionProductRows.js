function normalizeText(value) {
  return String(value ?? '').trim();
}

function isMissingMetricValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function toOptionalNumber(value) {
  if (isMissingMetricValue(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isKnownStatusLabel(value) {
  const label = normalizeText(value);
  return Boolean(label) && !['未知状态', '未识别状态', '未返回'].includes(label);
}

export function sumOptionalPromotionMetric(...values) {
  const numbers = values.map(toOptionalNumber).filter((value) => value !== null);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

export function getPromotionProductKey(product = {}, fallback = '') {
  const sku = normalizeText(product.sku);
  if (sku) return `sku:${sku}`;
  const productId = normalizeText(product.productId || product.product_id);
  if (productId) return `product:${productId}`;
  const offerId = normalizeText(product.offerId || product.offer_id);
  if (offerId) return `offer:${offerId}`;
  return normalizeText(fallback) ? `fallback:${normalizeText(fallback)}` : '';
}

function resolveMergedStatus(current = {}, incoming = {}) {
  const statusLabels = [...new Set([
    ...(current.statusLabels || []),
    current.statusLabel,
    incoming.statusLabel,
  ].filter(isKnownStatusLabel))];
  const statusValues = [...new Set([
    ...(current.statusValues || []),
    current.status,
    incoming.status,
  ].map(normalizeText).filter((value) => value && value !== 'unknown'))];
  return {
    statusLabels,
    statusValues,
    status: statusValues.length === 1 ? statusValues[0] : statusValues.length > 1 ? 'multiple' : 'unknown',
    statusLabel: statusLabels.length === 1 ? statusLabels[0] : statusLabels.length > 1 ? '多计划状态' : '已加入推广计划',
  };
}

function deriveRate({ numerator, denominator, multiplier = 1, fallback }) {
  const normalizedNumerator = toOptionalNumber(numerator);
  const normalizedDenominator = toOptionalNumber(denominator);
  if (normalizedNumerator === null || normalizedDenominator === null) return toOptionalNumber(fallback);
  if (normalizedDenominator > 0) {
    return Number(((normalizedNumerator / normalizedDenominator) * multiplier).toFixed(2));
  }
  return normalizedNumerator === 0 && normalizedDenominator === 0 ? 0 : toOptionalNumber(fallback);
}

export function mergePromotionProductRows(campaigns = []) {
  const productByKey = new Map();
  for (const campaign of campaigns) {
    const campaignId = normalizeText(campaign?.id);
    const campaignTitle = normalizeText(campaign?.title) || '未命名计划';
    const campaignProducts = Array.isArray(campaign?.products) ? campaign.products : [];
    campaignProducts.forEach((product, index) => {
      const key = getPromotionProductKey(product, `${campaignId || 'campaign'}:${index}`);
      if (!key) return;
      const current = productByKey.get(key);
      const campaignRef = { id: campaignId, title: campaignTitle };
      if (!current) {
        const status = resolveMergedStatus({}, product);
        productByKey.set(key, {
          ...product,
          ...status,
          aggregationKey: key,
          campaignIds: campaignRef.id ? [campaignRef.id] : [],
          campaignTitles: [campaignRef.title],
          campaignCount: 1,
        });
        return;
      }
      const campaignIds = [...new Set([...(current.campaignIds || []), campaignRef.id].filter(Boolean))];
      const campaignTitles = [...new Set([...(current.campaignTitles || []), campaignRef.title].filter(Boolean))];
      productByKey.set(key, {
        ...current,
        ...resolveMergedStatus(current, product),
        title: current.title || product.title,
        productId: current.productId || product.productId || product.product_id,
        offerId: current.offerId || product.offerId || product.offer_id,
        bid: current.bid ?? product.bid,
        impressions: sumOptionalPromotionMetric(current.impressions, product.impressions),
        clicks: sumOptionalPromotionMetric(current.clicks, product.clicks),
        spent: sumOptionalPromotionMetric(current.spent, product.spent),
        orders: sumOptionalPromotionMetric(current.orders, product.orders),
        revenue: sumOptionalPromotionMetric(current.revenue, product.revenue),
        campaignIds,
        campaignTitles,
        campaignCount: campaignIds.length || campaignTitles.length,
      });
    });
  }
  return [...productByKey.values()].map((product) => ({
    ...product,
    ctr: deriveRate({
      numerator: product.clicks,
      denominator: product.impressions,
      multiplier: 100,
      fallback: product.ctr,
    }),
    cpc: deriveRate({ numerator: product.spent, denominator: product.clicks, fallback: product.cpc }),
    acos: deriveRate({
      numerator: product.spent,
      denominator: product.revenue,
      multiplier: 100,
      fallback: product.acos,
    }),
  }));
}

export function formatPromotionCampaignAssignment(product = {}, maxVisible = 2) {
  const titles = [...new Set((product.campaignTitles || []).map(normalizeText).filter(Boolean))];
  if (!titles.length) return '计划未返回';
  const visible = titles.slice(0, Math.max(1, maxVisible));
  return titles.length > visible.length
    ? `${visible.join('、')} 等 ${titles.length} 个计划`
    : visible.join('、');
}

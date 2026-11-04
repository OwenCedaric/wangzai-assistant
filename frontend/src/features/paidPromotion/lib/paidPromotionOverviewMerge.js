function normalizeText(value) {
  return String(value ?? '').trim();
}

const PRESERVED_METRIC_KEYS = [
  'impressions',
  'clicks',
  'spent',
  'orders',
  'revenue',
  'ctr',
  'cpc',
  'acos',
  'roas',
  'bonusSpent',
  'prepaymentSpent',
];

const PRESERVED_CAMPAIGN_BUDGET_KEYS = [
  'budget',
  'dailyBudget',
  'weeklyBudget',
  'totalBudget',
  'budgetRemaining',
];

function isMissingValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

function getRowIdentity(row = {}, fallback = '') {
  const objectId = normalizeText(row.objectId || row.object_id);
  if (objectId) return `object:${objectId}`;
  const sku = normalizeText(row.sku || row.ozonSku || row.ozon_sku);
  if (sku) return `sku:${sku}`;
  const productId = normalizeText(row.productId || row.product_id);
  if (productId) return `product:${productId}`;
  const offerId = normalizeText(row.offerId || row.offer_id);
  if (offerId) return `offer:${offerId}`;
  const id = normalizeText(row.id);
  return id ? `id:${id}` : normalizeText(fallback);
}

function mergeReturnedRow(previous = null, incoming = {}) {
  if (!previous) return incoming;
  const merged = {
    ...previous,
    ...incoming,
    bidAvailability: {
      ...(previous.bidAvailability || {}),
      ...(incoming.bidAvailability || {}),
    },
  };
  for (const key of PRESERVED_METRIC_KEYS) {
    if (isMissingValue(incoming[key]) && !isMissingValue(previous[key])) merged[key] = previous[key];
  }
  return merged;
}

function mergeAuthoritativeRows(previousRows = [], incomingRows = []) {
  const previousByIdentity = new Map();
  for (const [index, row] of (Array.isArray(previousRows) ? previousRows : []).entries()) {
    const identity = getRowIdentity(row, `previous:${index}`);
    if (identity) previousByIdentity.set(identity, row);
  }
  return (Array.isArray(incomingRows) ? incomingRows : []).map((row, index) => {
    const identity = getRowIdentity(row, `incoming:${index}`);
    return mergeReturnedRow(previousByIdentity.get(identity), row);
  });
}

export function mergePromotionDetailRead(previous = {}, incoming = {}) {
  return {
    ...previous,
    ...incoming,
    products: previous.products === true || incoming.products === true,
    objects: previous.objects === true || incoming.objects === true,
    bidInsights: previous.bidInsights === true || incoming.bidInsights === true,
    finishedAt: normalizeText(incoming.finishedAt) || normalizeText(previous.finishedAt),
  };
}

/**
 * The dashboard endpoint intentionally skips campaign products, so its
 * `productCount: 0` is not authoritative. Once every campaign has a completed
 * product read, use the de-duplicated catalog count instead. This also accepts
 * a real zero when the completed catalog is genuinely empty.
 */
export function mergePromotionSummary(
  previous = {},
  incoming = {},
  { hasCompleteProductCatalog = false, productCount = 0 } = {}
) {
  const summary = { ...(previous || {}), ...(incoming || {}) };
  if (isMissingValue(incoming?.productCount) && !isMissingValue(previous?.productCount)) {
    summary.productCount = previous.productCount;
  }
  if (hasCompleteProductCatalog) {
    summary.productCount = Number(productCount) || 0;
    summary.productCountState = 'complete';
  } else if (Number(productCount) > 0) {
    summary.productCount = Number(productCount);
    summary.productCountState = 'partial';
  } else if (Number(summary.total) > 0) {
    // The campaign list's zero product count is not authoritative because the
    // dashboard read intentionally skips campaign-product endpoints.
    summary.productCount = null;
    summary.productCountState = 'unavailable';
  } else if (Number(summary.total) === 0) {
    summary.productCount = 0;
    summary.productCountState = 'complete';
  }
  return summary;
}

/**
 * Merge one campaign without allowing a detail request for one tab to erase
 * another tab's already verified data. A true detailRead flag makes the
 * incoming list authoritative (including a real empty list); skipped fields
 * keep the previous list. Numeric zero is never treated as missing.
 */
export function mergePromotionCampaignSnapshot(previous = null, incoming = {}) {
  if (!previous) return incoming;
  const incomingRead = incoming.detailRead || {};
  const products = incomingRead.products === true
    ? mergeAuthoritativeRows(previous.products, incoming.products)
    : previous.products?.length
      ? previous.products
      : incoming.products || [];
  const objects = incomingRead.objects === true
    ? mergeAuthoritativeRows(previous.objects, incoming.objects)
    : previous.objects?.length
      ? previous.objects
      : incoming.objects || [];
  const previousStatistics = previous.statistics || {};
  const incomingStatistics = incoming.statistics || {};
  const statistics = { ...previousStatistics, ...incomingStatistics };
  for (const key of PRESERVED_METRIC_KEYS) {
    if (isMissingValue(incomingStatistics[key]) && !isMissingValue(previousStatistics[key])) {
      statistics[key] = previousStatistics[key];
    }
  }
  const mergedCampaign = {
    ...previous,
    ...incoming,
    products,
    objects,
    productCount:
      incomingRead.products === true
        ? products.length
        : products.length
          ? products.length
          : !isMissingValue(incoming.productCount)
            ? incoming.productCount
            : previous.productCount,
    productCountSource:
      incomingRead.products === true
        ? 'campaign-products'
        : normalizeText(incoming.productCountSource) || normalizeText(previous.productCountSource),
    objectCount:
      incomingRead.objects === true
        ? objects.length
        : objects.length
          ? objects.length
          : !isMissingValue(incoming.objectCount)
            ? incoming.objectCount
            : previous.objectCount,
    objectCountSource:
      incomingRead.objects === true
        ? 'campaign-objects'
        : normalizeText(incoming.objectCountSource) || normalizeText(previous.objectCountSource),
    statistics,
    detailRead: mergePromotionDetailRead(previous.detailRead, incoming.detailRead),
    detailAvailability: {
      ...(previous.detailAvailability || {}),
      ...(incoming.detailAvailability || {}),
    },
  };
  for (const key of PRESERVED_CAMPAIGN_BUDGET_KEYS) {
    if (isMissingValue(incoming[key]) && !isMissingValue(previous[key])) {
      mergedCampaign[key] = previous[key];
    }
  }
  if (isMissingValue(incoming.budgetRemaining) && !isMissingValue(previous.budgetRemaining)) {
    mergedCampaign.budgetRemainingSource = previous.budgetRemainingSource;
    mergedCampaign.budgetRemainingPeriod = previous.budgetRemainingPeriod;
  }
  if (
    (!normalizeText(incoming.budgetStatus) || incoming.budgetStatus === '未返回') &&
    normalizeText(previous.budgetStatus)
  ) {
    mergedCampaign.budgetStatus = previous.budgetStatus;
  }
  return mergedCampaign;
}

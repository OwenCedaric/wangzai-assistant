import { aggregatePromotionMetricRows, normalizePromotionMetricNumber } from './paidPromotionReportRows.js';

export const ALL_PROMOTION_SCOPE = 'all';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getIdentityEntries(row = {}) {
  return [
    ['sku', row.sku || row.ozonSku || row.ozon_sku],
    ['product', row.productId || row.product_id],
    ['offer', row.offerId || row.offer_id || row.sourceSku || row.source_sku],
    ['object', row.objectId || row.object_id],
  ]
    .map(([kind, value]) => [kind, normalizeText(value)])
    .filter(([, value]) => Boolean(value));
}

export function getPromotionProductScopeKey(row = {}) {
  const [first] = getIdentityEntries(row);
  return first ? `${first[0]}:${first[1]}` : '';
}

export function getPromotionProductScopeOptions(...rowGroups) {
  const options = new Map();
  for (const row of rowGroups.flatMap((rows) => (Array.isArray(rows) ? rows : []))) {
    const key = getPromotionProductScopeKey(row);
    if (!key || options.has(key)) continue;
    const title = normalizeText(row.title || row.productTitle || row.name);
    const sku = normalizeText(row.sku || row.ozonSku || row.ozon_sku);
    const offerId = normalizeText(row.offerId || row.offer_id || row.sourceSku || row.source_sku);
    options.set(key, {
      key,
      label: title || sku || offerId || key.split(':').slice(1).join(':'),
      secondary: [sku ? `SKU ${sku}` : '', offerId ? `货号 ${offerId}` : ''].filter(Boolean).join(' · '),
    });
  }
  return [...options.values()];
}

export function filterPromotionRowsByProductScope(rows = [], scopeKey = ALL_PROMOTION_SCOPE) {
  const normalizedScope = normalizeText(scopeKey);
  if (!normalizedScope || normalizedScope === ALL_PROMOTION_SCOPE) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    getIdentityEntries(row).some(([kind, value]) => `${kind}:${value}` === normalizedScope)
  );
}

export function filterPromotionRowsByCampaign(rows = [], campaignId = ALL_PROMOTION_SCOPE) {
  const target = normalizeText(campaignId);
  if (!target || target === ALL_PROMOTION_SCOPE) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => normalizeText(row?.campaignId || row?.campaign_id) === target
  );
}

export function filterPromotionRowsByKeyword(rows = [], keyword = '') {
  const target = normalizeText(keyword).toLowerCase();
  if (!target) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    [
      row?.title,
      row?.productTitle,
      row?.name,
      row?.sku,
      row?.ozonSku,
      row?.offerId,
      row?.sourceSku,
      row?.orderId,
      row?.orderNumber,
    ]
      .map((value) => normalizeText(value).toLowerCase())
      .some((value) => value.includes(target))
  );
}

export function buildScopedPromotionOrderReport(report = null, rows = [], scoped = false) {
  if (!scoped || !report) return report;
  const safeRows = Array.isArray(rows) ? rows : [];
  const aggregate = aggregatePromotionMetricRows(safeRows);
  const orderIds = safeRows.map((row) => normalizeText(row?.orderId)).filter(Boolean);
  const exactOrderCount = safeRows.length === 0 ? 0 : orderIds.length === safeRows.length ? new Set(orderIds).size : null;
  const itemQuantity = safeRows.reduce((total, row) => {
    const quantity = normalizePromotionMetricNumber(row?.quantity);
    return quantity === null ? total : total + quantity;
  }, 0);
  return {
    ...report,
    rows: safeRows,
    total: safeRows.length,
    summary: {
      rowCount: safeRows.length,
      orderCount: exactOrderCount,
      itemQuantity: safeRows.length ? itemQuantity : 0,
      revenue: safeRows.length ? aggregate.revenue : 0,
      spent: safeRows.length ? aggregate.spent : 0,
    },
  };
}

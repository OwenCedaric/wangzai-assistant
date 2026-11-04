export const PROFIT_PRODUCT_SUPPLEMENT_BACKGROUND_BATCH_SIZE = 80;
export const PROFIT_LOCAL_DEPENDENCY_TIMEOUT_MS = 10_000;

const PRODUCT_IMAGE_FIELDS = [
  'image',
  'skuImage',
  'sku_image',
  'primaryImage',
  'primary_image',
  'mainImage',
  'productMainImage',
  'imageUrl',
];
const PRODUCT_IMAGE_ARRAY_FIELDS = ['images', 'skuImages', 'mainImages', 'productMainImages', 'imageUrls'];

function normalizeImageValues(value) {
  return (Array.isArray(value) ? value : [value])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

export function createProfitLedgerPersistenceComparableRow(row = {}) {
  const products = Array.isArray(row?.orderSnapshot?.products) ? row.orderSnapshot.products : null;
  if (!products) return row;
  return {
    ...row,
    orderSnapshot: {
      ...row.orderSnapshot,
      products: products.map((product = {}) => {
        const comparable = { ...product };
        [...PRODUCT_IMAGE_FIELDS, ...PRODUCT_IMAGE_ARRAY_FIELDS].forEach((field) => {
          delete comparable[field];
        });
        return comparable;
      }),
    },
  };
}

function mergeProfitProduct(current = {}, incoming = {}) {
  const next = { ...current, ...incoming };
  PRODUCT_IMAGE_FIELDS.forEach((field) => {
    const incomingValue = normalizeImageValues(incoming[field])[0] || '';
    const currentValue = normalizeImageValues(current[field])[0] || '';
    if (incomingValue || currentValue) next[field] = incomingValue || currentValue;
  });
  PRODUCT_IMAGE_ARRAY_FIELDS.forEach((field) => {
    const images = [...new Set([...normalizeImageValues(incoming[field]), ...normalizeImageValues(current[field])])];
    if (images.length) next[field] = images;
  });

  const fallbackImage =
    PRODUCT_IMAGE_FIELDS.map((field) => normalizeImageValues(next[field])[0] || '').find(Boolean) ||
    PRODUCT_IMAGE_ARRAY_FIELDS.flatMap((field) => normalizeImageValues(next[field])).find(Boolean) ||
    '';
  if (fallbackImage) {
    if (!normalizeImageValues(next.image).length) next.image = fallbackImage;
    if (!normalizeImageValues(next.skuImage).length) next.skuImage = fallbackImage;
    if (!normalizeImageValues(next.primaryImage).length) next.primaryImage = fallbackImage;
  }
  return next;
}

export function mergeProfitProductSupplementRows(current = {}, incoming = {}) {
  const currentProducts = Array.isArray(current?.products) ? current.products : [];
  const incomingProducts = Array.isArray(incoming?.products) ? incoming.products : [];
  const products = incomingProducts.length
    ? incomingProducts.map((product, index) => mergeProfitProduct(currentProducts[index] || {}, product || {}))
    : currentProducts;
  return {
    ...current,
    ...incoming,
    ...(products.length ? { products } : {}),
  };
}

function toRows(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

export function shouldCountProfitMaterialGap({
  includeVisibleFields = false,
  logisticsDependencyMissing = false,
  materialGap = false,
} = {}) {
  return materialGap === true && (includeVisibleFields === true || logisticsDependencyMissing === true);
}

export function selectProfitProductSupplementBatch({
  visibleOrders = [],
  profitRows = [],
  enhancedRowsByKey = new Map(),
  getRecordKey,
  getGapCount,
  backgroundBatchSize = PROFIT_PRODUCT_SUPPLEMENT_BACKGROUND_BATCH_SIZE,
} = {}) {
  if (typeof getRecordKey !== 'function' || typeof getGapCount !== 'function') {
    return { rows: [], visibleOrderKeys: new Set(), deferredCount: 0 };
  }

  const visibleOrderKeys = new Set(toRows(visibleOrders).map(getRecordKey).filter(Boolean));
  const selected = new Map();
  const enhanced = enhancedRowsByKey instanceof Map ? enhancedRowsByKey : new Map();

  const addVisible = (order) => {
    const key = getRecordKey(order);
    if (!key) return;
    const candidate = enhanced.get(key) || order;
    if (getGapCount(candidate, { includeVisibleFields: true }) > 0) selected.set(key, candidate);
  };
  toRows(visibleOrders).forEach(addVisible);

  const limit = Math.max(1, Math.floor(Number(backgroundBatchSize) || 1));
  let backgroundCount = 0;
  let deferredCount = 0;
  for (const order of toRows(profitRows)) {
    const key = getRecordKey(order);
    if (!key || visibleOrderKeys.has(key) || selected.has(key)) continue;
    const candidate = enhanced.get(key) || order;
    if (getGapCount(candidate, { includeVisibleFields: false }) <= 0) continue;
    if (backgroundCount >= limit) {
      deferredCount += 1;
      continue;
    }
    selected.set(key, candidate);
    backgroundCount += 1;
  }

  return { rows: [...selected.values()], visibleOrderKeys, deferredCount };
}

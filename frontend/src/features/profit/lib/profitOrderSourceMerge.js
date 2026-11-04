import { getProfitOrderRecordKey } from '../../../entities/profit/profitOrderRecordRules.jsx';

const PRODUCT_IMAGE_FIELDS = Object.freeze([
  'image', 'skuImage', 'sku_image', 'primaryImage', 'primary_image',
  'mainImage', 'productMainImage', 'imageUrl', 'image_url',
]);
const PRODUCT_IMAGE_ARRAY_FIELDS = Object.freeze([
  'images', 'skuImages', 'mainImages', 'productMainImages', 'imageUrls',
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function imageValues(value) {
  return (Array.isArray(value) ? value : [value]).map(normalizeText).filter(Boolean);
}

function productIdentityValues(product = {}) {
  const raw = product?.raw && typeof product.raw === 'object' ? product.raw : {};
  return new Set([
    product.productId,
    product.product_id,
    product.offerId,
    product.offer_id,
    product.sku,
    product.skuId,
    product.sku_id,
    raw.product_id,
    raw.offer_id,
    raw.sku,
  ].map(normalizeText).filter(Boolean));
}

function productsMatch(left = {}, right = {}) {
  const leftValues = productIdentityValues(left);
  if (!leftValues.size) return false;
  return [...productIdentityValues(right)].some((value) => leftValues.has(value));
}

function mergeProductPreservingImages(snapshotProduct = {}, canonicalProduct = {}) {
  const merged = { ...snapshotProduct, ...canonicalProduct };
  PRODUCT_IMAGE_FIELDS.forEach((field) => {
    const value = imageValues(canonicalProduct[field])[0] || imageValues(snapshotProduct[field])[0] || '';
    if (value) merged[field] = value;
  });
  PRODUCT_IMAGE_ARRAY_FIELDS.forEach((field) => {
    const values = [...new Set([
      ...imageValues(canonicalProduct[field]),
      ...imageValues(snapshotProduct[field]),
    ])];
    if (values.length) merged[field] = values;
  });
  return merged;
}

function mergeProductsPreservingSnapshotImages(canonicalProducts = [], snapshotProducts = []) {
  if (!canonicalProducts.length) return snapshotProducts;
  if (!snapshotProducts.length) return canonicalProducts;
  const usedSnapshotIndexes = new Set();
  return canonicalProducts.map((canonicalProduct, canonicalIndex) => {
    let snapshotIndex = snapshotProducts.findIndex(
      (candidate, index) => !usedSnapshotIndexes.has(index) && productsMatch(canonicalProduct, candidate)
    );
    if (snapshotIndex < 0 && canonicalProducts.length === snapshotProducts.length) snapshotIndex = canonicalIndex;
    if (snapshotIndex < 0 || usedSnapshotIndexes.has(snapshotIndex)) return canonicalProduct;
    usedSnapshotIndexes.add(snapshotIndex);
    return mergeProductPreservingImages(snapshotProducts[snapshotIndex], canonicalProduct);
  });
}

/**
 * The canonical sales-order SQLite cache owns the current order universe.
 * Profit snapshots may enrich matching orders, but must never replace that
 * complete universe with a smaller date-limited subset.
 */
export function mergeProfitSnapshotWithSharedOrders(sharedRows = [], snapshotRows = []) {
  const canonicalRows = Array.isArray(sharedRows) ? sharedRows.filter(Boolean) : [];
  const profitRows = Array.isArray(snapshotRows) ? snapshotRows.filter(Boolean) : [];
  if (!canonicalRows.length) return [];

  const snapshotByKey = new Map();
  profitRows.forEach((row) => {
    const key = getProfitOrderRecordKey(row);
    if (key) snapshotByKey.set(key, row);
  });

  return canonicalRows.map((canonical) => {
    const key = getProfitOrderRecordKey(canonical);
    const snapshot = key ? snapshotByKey.get(key) : null;
    if (!snapshot) return canonical;
    return {
      ...snapshot,
      ...canonical,
      products:
        Array.isArray(canonical.products) && canonical.products.length
          ? mergeProductsPreservingSnapshotImages(
              canonical.products,
              Array.isArray(snapshot.products) ? snapshot.products : []
            )
          : snapshot.products,
      profitLedger: canonical.profitLedger ?? snapshot.profitLedger,
      exchangeRates: {
        ...(snapshot.exchangeRates ?? {}),
        ...(canonical.exchangeRates ?? {}),
      },
    };
  });
}

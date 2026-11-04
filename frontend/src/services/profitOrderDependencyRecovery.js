import { getOzonOrderProductSalesAmount } from '../entities/order/orderProductAmountRules.jsx';
import { getProfitOrderRecordKey } from '../entities/profit/profitOrderRecordRules.jsx';
import { readSalesOrderPagedCache } from './salesOrderPagedCacheClient.js';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (normalizeText(value)) return value;
  }
  return '';
}

function getPostingNumber(order = {}) {
  const snapshot = order?.profitLedger?.orderSnapshot ?? order?.orderSnapshot ?? {};
  const direct = firstFilled(
    order.posting,
    order.postingNumber,
    order.posting_number,
    snapshot.posting,
    snapshot.postingNumber,
    snapshot.posting_number,
    order.raw?.posting_number,
    order.raw?.postingNumber
  );
  if (normalizeText(direct)) return normalizeText(direct);
  const key = normalizeText(getProfitOrderRecordKey(order));
  const match = key.match(/(?:^|:)(\d{6,}-\d{3,}(?:-\d+)?)$/u);
  return match?.[1] || '';
}

function getShopId(order = {}) {
  const snapshot = order?.profitLedger?.orderSnapshot ?? order?.orderSnapshot ?? {};
  return normalizeText(firstFilled(order.shopId, order.shop_id, snapshot.shopId, snapshot.shop_id));
}

function getProductIdentityValues(product = {}) {
  return new Set(
    [
      product.offerId,
      product.offer_id,
      product.sellerSku,
      product.seller_sku,
      product.sku,
      product.skuId,
      product.sku_id,
      product.productId,
      product.product_id,
      product.raw?.offer_id,
      product.raw?.sku,
      product.raw?.product_id,
    ]
      .map(normalizeText)
      .filter(Boolean)
  );
}

function identitiesOverlap(left = {}, right = {}) {
  const leftValues = getProductIdentityValues(left);
  if (!leftValues.size) return false;
  return [...getProductIdentityValues(right)].some((value) => leftValues.has(value));
}

function mergeCanonicalProduct(current = {}, canonical = {}) {
  const canonicalSalesAmount = getOzonOrderProductSalesAmount(canonical);
  return {
    ...canonical,
    ...current,
    offerId: normalizeText(firstFilled(current.offerId, current.offer_id, canonical.offerId, canonical.offer_id)),
    sku: normalizeText(firstFilled(current.sku, canonical.sku, canonical.offerId, canonical.offer_id)),
    skuId: normalizeText(firstFilled(current.skuId, current.sku_id, canonical.skuId, canonical.sku_id, canonical.raw?.sku)),
    productId: normalizeText(
      firstFilled(current.productId, current.product_id, canonical.productId, canonical.product_id, canonical.raw?.product_id)
    ),
    qty: firstFilled(canonical.qty, canonical.quantity, current.qty, current.quantity, 1),
    price: firstFilled(canonical.price, canonical.priceValue, current.price, current.priceValue),
    priceValue: firstFilled(canonical.priceValue, canonical.price, current.priceValue, current.price),
    ...(canonicalSalesAmount !== null ? { salesAmountValue: canonicalSalesAmount } : {}),
    raw: {
      ...(current.raw && typeof current.raw === 'object' ? current.raw : {}),
      ...(canonical.raw && typeof canonical.raw === 'object' ? canonical.raw : {}),
    },
    financialRaw: {
      ...(current.financialRaw && typeof current.financialRaw === 'object' ? current.financialRaw : {}),
      ...(canonical.financialRaw && typeof canonical.financialRaw === 'object' ? canonical.financialRaw : {}),
    },
  };
}

function mergeCanonicalProducts(currentProducts = [], canonicalProducts = []) {
  if (!canonicalProducts.length) return currentProducts;
  if (!currentProducts.length) return canonicalProducts;
  const usedCanonicalIndexes = new Set();
  const merged = currentProducts.map((current, currentIndex) => {
    let canonicalIndex = canonicalProducts.findIndex(
      (candidate, index) => !usedCanonicalIndexes.has(index) && identitiesOverlap(current, candidate)
    );
    if (canonicalIndex < 0 && currentProducts.length === canonicalProducts.length) canonicalIndex = currentIndex;
    if (canonicalIndex < 0 || usedCanonicalIndexes.has(canonicalIndex)) return current;
    usedCanonicalIndexes.add(canonicalIndex);
    return mergeCanonicalProduct(current, canonicalProducts[canonicalIndex]);
  });
  canonicalProducts.forEach((product, index) => {
    if (!usedCanonicalIndexes.has(index)) merged.push(product);
  });
  return merged;
}

export function mergeProfitOrderCanonicalDependency(order = {}, canonicalOrder = {}) {
  const canonicalProducts = Array.isArray(canonicalOrder.products) ? canonicalOrder.products : [];
  const currentProducts = Array.isArray(order.products) ? order.products : [];
  return {
    ...order,
    products: mergeCanonicalProducts(currentProducts, canonicalProducts),
    raw: {
      ...(order.raw && typeof order.raw === 'object' ? order.raw : {}),
      ...(canonicalOrder.raw && typeof canonicalOrder.raw === 'object' ? canonicalOrder.raw : {}),
    },
    logistics: normalizeText(canonicalOrder.logistics) && canonicalOrder.logistics !== '未返回'
      ? canonicalOrder.logistics
      : order.logistics,
    deliveryMethod: normalizeText(canonicalOrder.deliveryMethod) && canonicalOrder.deliveryMethod !== '未返回'
      ? canonicalOrder.deliveryMethod
      : order.deliveryMethod,
    warehouse: normalizeText(canonicalOrder.warehouse) && canonicalOrder.warehouse !== '未返回'
      ? canonicalOrder.warehouse
      : order.warehouse,
  };
}

function getCanonicalDependencyKey(order = {}) {
  const shopId = getShopId(order);
  const postingNumber = getPostingNumber(order);
  return shopId && postingNumber ? `${shopId}:${postingNumber}` : '';
}

export async function readProfitOrderCanonicalDependencyRows(rows = [], shops = [], options = {}) {
  const sourceRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const groups = new Map();
  sourceRows.forEach((row) => {
    const shopId = getShopId(row);
    const postingNumber = getPostingNumber(row);
    if (!shopId || !postingNumber) return;
    if (!groups.has(shopId)) groups.set(shopId, new Set());
    groups.get(shopId).add(postingNumber);
  });
  if (!groups.size) return { rows: sourceRows, matchedKeys: new Set() };

  const payloads = await Promise.all(
    [...groups.entries()].map(async ([shopId, postingNumbers]) => {
      try {
        return await readSalesOrderPagedCache(
          {
            shops,
            shop: shopId,
            postingNumbers: [...postingNumbers],
            page: 1,
            pageSize: Math.max(1, Math.min(postingNumbers.size, 1000)),
            includeSummary: false,
          },
          {
            bypassMemory: true,
            timeoutMs: options.timeoutMs || 3000,
            signal: options.signal,
          }
        );
      } catch {
        return { rows: [] };
      }
    })
  );
  const canonicalByKey = new Map();
  payloads.flatMap((payload) => (Array.isArray(payload?.rows) ? payload.rows : [])).forEach((row) => {
    const key = getCanonicalDependencyKey(row);
    if (key) canonicalByKey.set(key, row);
  });
  const matchedKeys = new Set();
  const mergedRows = sourceRows.map((row) => {
    const key = getCanonicalDependencyKey(row);
    const canonical = key ? canonicalByKey.get(key) : null;
    if (!canonical) return row;
    matchedKeys.add(getProfitOrderRecordKey(row));
    return mergeProfitOrderCanonicalDependency(row, canonical);
  });
  return { rows: mergedRows, matchedKeys };
}

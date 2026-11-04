import { getFriendlyOzonOrderError } from '../../entities/marketing/marketingSnapshotRuntime.jsx';
import { getSalesOrderPaymentDateKey, normalizeSalesOrderDateFilter } from '../../entities/order/orderDateRules.jsx';
import { firstUsableOzonId } from '../../entities/order/orderShopScope.jsx';
import {
  createEmptyProductStatusCounts,
  getOzonLocalProductShopKeys,
  getOzonLocalUniqueValues,
  getOzonShopCacheKey,
  getOzonShopCacheKeyCandidates,
  PRODUCT_LIST_CACHE_VERSION,
  PRODUCT_PAGE_SIZE_OPTIONS,
} from '../../entities/product/productLocalData.jsx';
import { firstFiniteNumber } from '../../entities/product/productAttributes.jsx';
import {
  getProductSelectionKey,
  normalizeImageList,
  safeImageUrl,
} from '../../entities/product/productWriteHelpers.jsx';
import { getProfitPostingLookupKeys } from '../../entities/profit/profitPostingRules.jsx';
import { getProfitOrderRecordKey } from '../../entities/profit/profitOrderRecordRules.jsx';
import { readOzonProductSnapshotFromLocalStore } from '../../services/ozonLocalDataLayer';
import { normalizeOzonImageUrlsForPreload, preloadOzonImageUrls } from '../../services/ozonOrderExperience';
import {
  normalizeProductStatusLabel,
  productStatusTabs,
  productStatusToneMap,
} from '../../entities/product/productStatusRules.jsx';
import { normalizeLocalMirrorProductRow } from '../../services/localMirrorProductRows';
import React from 'react';

export function getProductOfferLookupId(product = {}) {
  return firstUsableOzonId(
    product.offerId,
    product.sku,
    product.raw?.entity?.offerId,
    product.raw?.entity?.offer_id,
    product.raw?.entity?.productNo,
    product.raw?.listItem?.offer_id
  );
}

export function canResolveProductOzonOperation(product = {}) {
  return Boolean(product?.productId || getProductOfferLookupId(product));
}

export function getOzonLocalProductShopKeysForShops(shops = []) {
  return getOzonLocalUniqueValues((Array.isArray(shops) ? shops : [shops]).flatMap(getOzonLocalProductShopKeys));
}

export function getOzonShopByLocalProductShopKey(shops = [], localShopKey = '') {
  const target = String(localShopKey || '').trim();
  if (!target) return null;
  return (
    (Array.isArray(shops) ? shops : [shops]).find((shop) =>
      getOzonLocalProductShopKeys(shop).some((key) => key === target)
    ) ?? null
  );
}

export function getProductSnapshotVisibilityForStatusLabel(statusLabel = '全部商品') {
  return (productStatusTabs.find((tab) => tab.label === statusLabel) ?? productStatusTabs[0]).visibility;
}

export function getProductListSnapshotPrefixesForShop(store = {}, shop = {}) {
  const snapshots = store?.snapshots && typeof store.snapshots === 'object' ? store.snapshots : {};
  const primaryPrefix = `${PRODUCT_LIST_CACHE_VERSION}:${getOzonShopCacheKey(shop)}:`;
  if (Object.keys(snapshots).some((key) => key.startsWith(primaryPrefix))) return [primaryPrefix];
  return getOzonShopCacheKeyCandidates(shop).map((shopKey) => `${PRODUCT_LIST_CACHE_VERSION}:${shopKey}:`);
}

export function productListSnapshotKeyMatchesVisibility(snapshotKey = '', prefix = '', visibilities = []) {
  if (!snapshotKey.startsWith(prefix)) return false;
  const suffix = snapshotKey.slice(prefix.length);
  return visibilities.some((visibility) => suffix === visibility || suffix.startsWith(`${visibility}:`));
}

export function getProductListSnapshotRecordsForShop(store = {}, shop = {}, options = {}) {
  const snapshots = store?.snapshots && typeof store.snapshots === 'object' ? store.snapshots : {};
  const visibilities = options.includeAllVisibilities
    ? productStatusTabs.map((tab) => tab.visibility)
    : [getProductSnapshotVisibilityForStatusLabel(options.statusLabel)];
  const prefixes = getProductListSnapshotPrefixesForShop(store, shop);
  const records = Object.entries(snapshots)
    .filter(
      ([key, snapshot]) =>
        snapshot?.type === 'products' &&
        Array.isArray(snapshot.productKeys) &&
        prefixes.some((prefix) => productListSnapshotKeyMatchesVisibility(key, prefix, visibilities))
    )
    .sort(([leftKey, leftSnapshot], [rightKey, rightSnapshot]) => {
      const leftPage = Number(leftSnapshot?.page) || Number(leftKey.match(/:(\d+)$/)?.[1]) || 1;
      const rightPage = Number(rightSnapshot?.page) || Number(rightKey.match(/:(\d+)$/)?.[1]) || 1;
      if (leftPage !== rightPage) return leftPage - rightPage;
      return String(rightSnapshot?.updatedAt || '').localeCompare(String(leftSnapshot?.updatedAt || ''));
    });
  if (options.includePageSnapshots === true) return records;
  const fullSnapshotVisibilities = new Set(
    records.flatMap(([key]) => visibilities.filter((visibility) => key.endsWith(`:${visibility}:full`)))
  );
  if (!fullSnapshotVisibilities.size) return records;
  return records.filter(([key]) => {
    const matchedPrefix = prefixes.find((prefix) => key.startsWith(prefix)) || '';
    const matchedVisibility = visibilities.find((visibility) =>
      productListSnapshotKeyMatchesVisibility(key, matchedPrefix, [visibility])
    );
    return (
      !matchedVisibility ||
      !fullSnapshotVisibilities.has(matchedVisibility) ||
      key.endsWith(`:${matchedVisibility}:full`)
    );
  });
}

export function getProductStatusLabelFromSnapshotKey(snapshotKey = '') {
  const segments = String(snapshotKey || '')
    .split(':')
    .filter(Boolean);
  const matchedTab = productStatusTabs.find((tab) => tab.visibility !== 'ALL' && segments.includes(tab.visibility));
  return matchedTab?.label || '';
}

export function getProductVisibilityFromSnapshotKey(snapshotKey = '') {
  const segments = String(snapshotKey || '')
    .split(':')
    .filter(Boolean);
  return productStatusTabs.find((tab) => segments.includes(tab.visibility))?.visibility || '';
}

export function buildProductStatusBySnapshotProductKey(store = {}, shop = {}) {
  const statusByProductKey = new Map();
  getProductListSnapshotRecordsForShop(store, shop, { includeAllVisibilities: true }).forEach(
    ([snapshotKey, snapshot]) => {
      const statusLabel = getProductStatusLabelFromSnapshotKey(snapshotKey);
      if (!statusLabel || !Array.isArray(snapshot?.productKeys)) return;
      const updatedAt = String(snapshot?.updatedAt || snapshot?.fetchedAt || '');
      snapshot.productKeys.forEach((productKey) => {
        const safeProductKey = String(productKey || '').trim();
        if (!safeProductKey) return;
        const current = statusByProductKey.get(safeProductKey);
        if (current && updatedAt.localeCompare(current.updatedAt) < 0) return;
        statusByProductKey.set(safeProductKey, { statusLabel, updatedAt });
      });
    }
  );
  return new Map([...statusByProductKey.entries()].map(([key, value]) => [key, value.statusLabel]));
}

export function applySnapshotProductStatus(row = {}, statusLabel = '') {
  const normalizedStatus = normalizeProductStatusLabel(statusLabel);
  if (!normalizedStatus || !productStatusToneMap[normalizedStatus]) return row;
  return {
    ...row,
    status: normalizedStatus,
    tone: productStatusToneMap[normalizedStatus] || row.tone || 'default',
  };
}

export function readLocalProductCatalogRowsFromStore(store = {}, shops = [], options = {}) {
  const rowsByKey = new Map();
  (Array.isArray(shops) ? shops : [shops]).filter(Boolean).forEach((shop) => {
    const statusByProductKey = buildProductStatusBySnapshotProductKey(store, shop);
    getProductListSnapshotRecordsForShop(store, shop, options).forEach(([snapshotKey]) => {
      const snapshotStatus = getProductStatusLabelFromSnapshotKey(snapshotKey);
      const snapshotVisibility = getProductVisibilityFromSnapshotKey(snapshotKey);
      const snapshot = readOzonProductSnapshotFromLocalStore(store, snapshotKey);
      (snapshot?.rows || []).forEach((entity) => {
        const baseRow = normalizeLocalMirrorProductRow(
          entity,
          getOzonShopByLocalProductShopKey([shop], entity.localShopKey) ?? shop
        );
        const statusFromSnapshot =
          snapshotStatus || statusByProductKey.get(entity.localProductKey || baseRow.localProductKey || '');
        const row = {
          ...(statusFromSnapshot ? applySnapshotProductStatus(baseRow, statusFromSnapshot) : baseRow),
          productSnapshotVisibility: snapshotVisibility,
          productSnapshotVisibilities: getOzonLocalUniqueValues([snapshotVisibility]),
          productSnapshotStatus: snapshotStatus || statusFromSnapshot || '',
        };
        const key = getProductSelectionKey(row) || row.localProductKey || row.id;
        if (!key) return;
        if (rowsByKey.has(key)) {
          const currentRow = rowsByKey.get(key);
          rowsByKey.set(key, {
            ...currentRow,
            productSnapshotVisibilities: getOzonLocalUniqueValues([
              ...(Array.isArray(currentRow.productSnapshotVisibilities) ? currentRow.productSnapshotVisibilities : []),
              currentRow.productSnapshotVisibility,
              snapshotVisibility,
            ]),
            productSnapshotStatus: getOzonLocalUniqueValues([
              currentRow.productSnapshotStatus,
              snapshotStatus || statusFromSnapshot || '',
            ]).join(' / '),
          });
          return;
        }
        rowsByKey.set(key, row);
      });
    });
  });
  return [...rowsByKey.values()];
}

export function selectProductStatusCountsFromSnapshotRecords(records = []) {
  const candidates = records
    .map(([key, snapshot]) => ({ key, snapshot, counts: snapshot?.statusCounts }))
    .filter((item) => item.counts && typeof item.counts === 'object' && !Array.isArray(item.counts));
  if (!candidates.length) return null;
  const baseCounts = { ...createEmptyProductStatusCounts() };
  const bestFullCounts = candidates.slice().sort((left, right) => {
    const leftDefaultPage = Number(left.snapshot?.pageSize) === PRODUCT_PAGE_SIZE_OPTIONS[0] ? 1 : 0;
    const rightDefaultPage = Number(right.snapshot?.pageSize) === PRODUCT_PAGE_SIZE_OPTIONS[0] ? 1 : 0;
    if (leftDefaultPage !== rightDefaultPage) return rightDefaultPage - leftDefaultPage;
    const leftSize = Object.keys(left.counts).length;
    const rightSize = Object.keys(right.counts).length;
    if (leftSize !== rightSize) return rightSize - leftSize;
    return String(right.snapshot?.updatedAt || '').localeCompare(String(left.snapshot?.updatedAt || ''));
  })[0]?.counts;
  Object.assign(baseCounts, bestFullCounts);
  productStatusTabs.forEach((tab) => {
    const preferred = candidates
      .filter(
        (item) =>
          item.counts[tab.label] !== undefined && item.counts[tab.label] !== null && item.counts[tab.label] !== ''
      )
      .map((item) => ({
        value: item.counts[tab.label],
        updatedAt: String(item.snapshot?.updatedAt || ''),
        defaultPage: Number(item.snapshot?.pageSize) === PRODUCT_PAGE_SIZE_OPTIONS[0],
        statusSpecific: item.key.includes(`:${tab.visibility}:`) || item.key.endsWith(`:${tab.visibility}`),
      }))
      .sort((left, right) => {
        if (left.statusSpecific !== right.statusSpecific) return right.statusSpecific ? 1 : -1;
        if (left.defaultPage !== right.defaultPage) return right.defaultPage ? 1 : -1;
        return right.updatedAt.localeCompare(left.updatedAt);
      })[0];
    if (preferred) baseCounts[tab.label] = Number(preferred.value) || 0;
  });
  return baseCounts;
}

export function readLocalProductCatalogStatusCountsFromStore(store = {}, shops = []) {
  const counts = createEmptyProductStatusCounts();
  let hasCounts = false;
  (Array.isArray(shops) ? shops : [shops]).filter(Boolean).forEach((shop) => {
    const records = getProductListSnapshotRecordsForShop(store, shop, { includeAllVisibilities: true });
    const shopCounts = selectProductStatusCountsFromSnapshotRecords(records);
    if (!shopCounts) return;
    hasCounts = true;
    productStatusTabs.forEach((tab) => {
      counts[tab.label] += Number(shopCounts[tab.label]) || 0;
    });
  });
  return hasCounts ? counts : null;
}

export function getProductSortValue(product = {}, key = '') {
  if (key === 'price') return firstFiniteNumber(product.priceValue, product.price);
  if (key === 'stock') return firstFiniteNumber(product.stock);
  if (key === 'fee') return firstFiniteNumber(product.feeTotalValue, product.feeTotal);
  if (key === 'profit') return firstFiniteNumber(product.estimatedProfitValue, product.estimatedProfit);
  if (key === 'weight') return firstFiniteNumber(product.weight);
  if (key === 'status') {
    const statusIndex = productStatusTabs.findIndex((tab) => tab.label === product.status);
    return statusIndex === -1 ? productStatusTabs.length : statusIndex;
  }
  return null;
}

export function compareProductSortValue(leftProduct = {}, rightProduct = {}, key = '', direction = 'desc') {
  const multiplier = direction === 'asc' ? 1 : -1;
  const left = getProductSortValue(leftProduct, key);
  const right = getProductSortValue(rightProduct, key);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left > right ? multiplier : -multiplier;
  }
  return String(left).localeCompare(String(right), 'zh-CN') * multiplier;
}

export { getSalesOrderPaymentDateKey, normalizeSalesOrderDateFilter };

export function getSalesOrderPreviewImages(order = {}) {
  const product = order?.products?.[0] ?? {};
  const raw = product.raw ?? {};
  const skuImages = normalizeImageList([
    product.skuImage,
    product.sku_image,
    ...(Array.isArray(product.skuImages) ? product.skuImages : []),
    raw.sku_image,
    raw.skuImage,
    raw.sku_picture,
    raw.skuPicture,
  ]);
  const mainImages = normalizeImageList([
    product.mainImage,
    product.productMainImage,
    product.primaryImage,
    product.primary_image,
    ...(Array.isArray(product.mainImages) ? product.mainImages : []),
    ...(Array.isArray(product.productMainImages) ? product.productMainImages : []),
    raw.primary_image,
    raw.primaryImage,
    raw.main_image,
    raw.mainImage,
  ]);
  const skuImage = skuImages.map(safeImageUrl).find(Boolean) || '';
  const productMainImage = mainImages.map(safeImageUrl).find(Boolean) || '';
  const firstImage = skuImage || productMainImage;

  return [
    {
      image: firstImage,
      label: skuImage ? 'SKU图' : productMainImage ? '主图' : '未返回',
      alt: skuImage ? product.name || order.product || '订单 SKU 图' : product.name || order.product || 'Ozon 产品主图',
    },
    {
      image: productMainImage,
      label: productMainImage ? '主图' : '未返回',
      alt: product.name || order.product || 'Ozon 产品主图',
    },
  ];
}

export function getOrderPreviewImageUrls(rows = [], getPreviewImages = () => [], limit = 80) {
  return normalizeOzonImageUrlsForPreload(
    rows.flatMap((row) => getPreviewImages(row).map((preview) => preview.image)),
    { limit }
  );
}

export function useOzonOrderImagePreload(imageUrls = [], limit = 80) {
  const imageUrlKey = imageUrls.join('|');
  React.useEffect(() => {
    if (!imageUrlKey) return undefined;
    preloadOzonImageUrls(imageUrls, { limit, concurrency: 8 }).catch(() => undefined);
    return undefined;
  }, [imageUrlKey, imageUrls, limit]);
}

export function getProfitValueClass(value) {
  if (String(value).startsWith('+')) return 'profit-value-positive';
  if (String(value).startsWith('-')) return 'profit-value-negative';
  return '';
}

export { getProfitOrderRecordKey };

export function getProfitReadMessage(errorOrMessage) {
  const message = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage || '');
  if (!message) return '读取失败，请重试。';
  if (message.includes('Client ID') || message.includes('API Key') || message.includes('密钥')) {
    return '请先在设置里配置 Ozon 店铺。';
  }
  return getFriendlyOzonOrderError(errorOrMessage instanceof Error ? errorOrMessage : new Error(message));
}

export function normalizeProfitSearchText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function compactProfitSearchText(value) {
  return normalizeProfitSearchText(value).replace(/[\s\-_/]+/g, '');
}

export function getAssociatedOrderSearchValues(order = {}, extraValues = []) {
  const rawRows = order.raw ? [order.raw] : [];
  const products = Array.isArray(order.products)
    ? order.products.filter((product) => product && typeof product === 'object')
    : [];
  const values = [
    order.id,
    order.posting,
    order.postingNumber,
    order.posting_number,
    ...(Array.isArray(order.postingNumbers) ? order.postingNumbers : []),
    order.salesOrder,
    order.shipmentNo,
    order.ozonOrderId,
    order.softwareOrderId,
    order.orderId,
    order.order_id,
    order.orderNumber,
    order.order_number,
    order.recordKey,
    order.profitRecordKey,
    order.returnNo,
    order.purchaseOrderNo,
    order.packageOrderId,
    order.crossBorderOrderId,
    order.busOrderNo,
    order.productNo,
    order.sku,
    order.offerId,
    order.skuId,
    order.product,
    order.buyer,
    order.supplier,
    order.reason,
    order.status,
    order.searchText,
    order.afterSalesSearchText,
    ...(Array.isArray(order.afterSalesSearchValues) ? order.afterSalesSearchValues : []),
    ...extraValues,
    ...rawRows.flatMap((raw) => [
      raw?.posting_number,
      raw?.postingNumber,
      raw?.order_number,
      raw?.orderNumber,
      raw?.order_id,
      raw?.orderId,
      raw?.analytics_data?.posting_number,
      raw?.analytics_data?.order_number,
      raw?.analytics_data?.order_id,
      raw?.posting?.posting_number,
      raw?.posting?.postingNumber,
      raw?.posting?.order_id,
      raw?.posting?.orderId,
    ]),
    ...products.flatMap((product) => [
      product.name,
      product.product,
      product.title,
      product.sku,
      product.offerId,
      product.skuId,
      product.productId,
      product.raw?.posting_number,
      product.raw?.postingNumber,
      product.raw?.order_number,
      product.raw?.orderNumber,
      product.raw?.order_id,
      product.raw?.orderId,
      product.raw?.offer_id,
      product.raw?.offerId,
      product.raw?.sku,
      product.raw?.sku_id,
      product.raw?.product_id,
      product.financialRaw?.posting_number,
      product.financialRaw?.postingNumber,
      product.financialRaw?.order_number,
      product.financialRaw?.orderNumber,
      product.financialRaw?.order_id,
      product.financialRaw?.orderId,
      product.financialRaw?.offer_id,
      product.financialRaw?.offerId,
      product.financialRaw?.sku,
      product.financialRaw?.sku_id,
      product.financialRaw?.product_id,
    ]),
  ];
  const normalizedValues = values
    .flat()
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && value !== '未返回' && value !== '待确认');
  return [...new Set([...normalizedValues, ...getProfitPostingLookupKeys(normalizedValues)])];
}

export function doesAssociatedOrderMatchKeyword(order = {}, keyword = '', extraValues = []) {
  const normalizedKeyword = normalizeProfitSearchText(keyword);
  if (!normalizedKeyword) return true;
  const values = getAssociatedOrderSearchValues(order, extraValues);
  const searchText = values.map(normalizeProfitSearchText).filter(Boolean).join(' ');
  if (searchText.includes(normalizedKeyword)) return true;
  const compactKeyword = compactProfitSearchText(normalizedKeyword);
  if (!compactKeyword) return false;
  return values.map(compactProfitSearchText).filter(Boolean).join('').includes(compactKeyword);
}

export function getProfitOrderSearchValues(order = {}) {
  const rawRows = order.raw ? [order.raw] : [];
  const products = Array.isArray(order.products)
    ? order.products.filter((product) => product && typeof product === 'object')
    : [];

  return [
    ...getAssociatedOrderSearchValues(order),
    order.id,
    order.posting,
    ...(Array.isArray(order.postingNumbers) ? order.postingNumbers : []),
    order.softwareOrderId,
    order.salesOrder,
    order.recordKey,
    order.profitRecordKey,
    order.offerId,
    order.skuId,
    order.sku,
    order.product,
    order.shop,
    order.buyer,
    ...rawRows.flatMap((raw) => [
      raw?.posting_number,
      raw?.postingNumber,
      raw?.order_number,
      raw?.orderNumber,
      raw?.order_id,
      raw?.orderId,
      raw?.analytics_data?.posting_number,
      raw?.analytics_data?.order_number,
    ]),
    ...products.flatMap((product) => [
      product.name,
      product.sku,
      product.offerId,
      product.skuId,
      product.raw?.offer_id,
      product.raw?.offerId,
      product.raw?.sku,
      product.raw?.sku_id,
      product.raw?.product_id,
      product.financialRaw?.offer_id,
      product.financialRaw?.offerId,
      product.financialRaw?.sku,
      product.financialRaw?.sku_id,
      product.financialRaw?.product_id,
    ]),
  ];
}

export function doesProfitOrderMatchKeyword(order = {}, keyword = '') {
  const normalizedKeyword = normalizeProfitSearchText(keyword);
  if (!normalizedKeyword) return true;
  const compactKeyword = compactProfitSearchText(normalizedKeyword);
  const values = getProfitOrderSearchValues(order);
  const searchText = values.map(normalizeProfitSearchText).filter(Boolean).join(' ');
  if (searchText.includes(normalizedKeyword)) return true;
  if (!compactKeyword) return false;
  return values.map(compactProfitSearchText).filter(Boolean).join('').includes(compactKeyword);
}

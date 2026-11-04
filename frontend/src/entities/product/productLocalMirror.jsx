import { normalizeOzonProductRow } from '../../services/productRowRuntime.js';
import { getSalesOrderPaymentDateKey } from '../order/orderDateRules.jsx';
import {
  normalizeCommissionRateHistory,
  resolveDailyCommissionRateSnapshot,
} from '../../services/commissionRateSnapshot';
import { normalizeEstimatedCommissionPercent } from '../../services/feeCalculationService';
import { readOzonProductEntitiesFromLocalStore } from '../../services/ozonLocalDataLayer';
import { readProductListCache } from '../../services/productListSyncClient';
import { readSalesOrderProductSummaryEntities } from '../../services/salesOrderProductSummaryService';
import { OZON_RFBS_COMMISSION_RATE_SOURCE, PURCHASE_PLUGIN_BRIDGE_BASE } from '../../shared/config/appConfigCore.jsx';
import { scheduleIdleTask } from '../../shared/ozon/ozonRuntime.jsx';
import { firstFilled, firstUsableOzonId, getOzonSnapshotSourceKey } from '../order/orderIdentityRules.jsx';
import { hasSalesOrderProductImage } from '../order/orderProductImageRules.jsx';
import { getOzonOrderProductSalesAmount } from '../order/orderProductAmountRules.jsx';
import { getSalesOrderRecordKey } from '../order/orderRecordRules.jsx';
import { normalizeProductSourceRecord } from '../order/orderSourceRecordRules.jsx';
import {
  createEmptyProductStatusCounts,
  getOzonLocalImageUrls,
  getOzonLocalOrderProductLookupKey,
  getOzonLocalOrderRecordKey,
  getOzonLocalProductShopKeysForOrder,
  getOzonLocalUniqueValues,
  getProductListPageCacheKeyCandidates,
  getProductListPageCacheKeyForScopeKey,
  PRODUCT_LIST_CACHE_TTL_MS,
  PRODUCT_PAGE_SIZE_OPTIONS,
  productListMemoryCache,
  readLocalDataFile,
  readTimedCacheCandidates,
  writeProductListPageMemoryCache,
} from './productLocalData.jsx';
import { getProductListQueryFilterSignature, normalizeProductListQueryFilters } from './productListQuery.jsx';
import { formatOzonPrice, normalizeProductListPriceCurrencyCode } from './productPriceRules.jsx';
import { normalizeProductStatusLabel, productStatusTabs } from './productStatusRules.jsx';
import { firstFiniteNumber, toFiniteNumber } from './productAttributes.jsx';

export {
  configurePurchasePluginContextStore,
  flushPurchasePluginContextWritesForTest,
  getPlainPurchasePluginSourceContext,
  hydratePurchasePluginSourceContextFromLocalFile,
  migrateLegacyPurchasePluginSourceContextAtStartup,
  normalizePurchasePluginSourceContext,
  normalizePurchasePluginSourceContextStore,
  purchasePluginSourceContextMemory,
  resetPurchasePluginContextStoreForTest,
  savePurchasePluginSourceContext,
} from '../../services/purchasePluginContextStore.js';

const PRODUCT_FULL_HYDRATION_FACETS = Object.freeze([
  ['detail', 'detailSyncedAt', 'detail_synced_at'],
  ['pictures', 'picturesSyncedAt', 'pictures_synced_at'],
  ['prices', 'pricesSyncedAt', 'prices_synced_at'],
  ['stocks', 'stocksSyncedAt', 'stocks_synced_at'],
  ['attributes', 'attributesSyncedAt', 'attributes_synced_at'],
]);

export function isProductFullyHydrated(row = {}) {
  if (row?.hydrationComplete === true || row?.hydration_complete === true) return true;
  if (row?.hydrationComplete === false || row?.hydration_complete === false) return false;
  const coverage = row?.hydrationCoverage || row?.hydration_coverage;
  if (coverage && typeof coverage === 'object') {
    return PRODUCT_FULL_HYDRATION_FACETS.every(([facet]) => coverage[facet] === true);
  }
  return PRODUCT_FULL_HYDRATION_FACETS.every(([, camelKey, snakeKey]) => Boolean(row?.[camelKey] || row?.[snakeKey]));
}

export function prefetchLocalApiProductNeighborPages(shops = [], selectedTab, options = {}) {
  const scopedShops = (Array.isArray(shops) ? shops : [shops]).filter((shop) => shop?.id);
  if (!scopedShops.length) return;
  const pageSizeValue = Math.max(1, Math.min(Number(options.pageSize) || PRODUCT_PAGE_SIZE_OPTIONS[0], 100));
  const pageValue = Math.max(1, Number(options.page) || 1);
  const totalRows = Math.max(0, Number(options.total) || 0);
  const totalPagesValue = totalRows > 0 ? Math.max(1, Math.ceil(totalRows / pageSizeValue)) : pageValue + 1;
  const sort = String(options.sort || 'stable').trim() || 'stable';
  const targetPages = [...new Set([pageValue - 1, pageValue + 1])].filter(
    (targetPage) => targetPage >= 1 && targetPage <= totalPagesValue
  );
  if (!targetPages.length) return;
  const keyword = String(options.keyword || '').trim();
  const queryFilters = normalizeProductListQueryFilters(options.filters);
  const filterSignature = getProductListQueryFilterSignature(queryFilters);
  const scopeKey = getOzonSnapshotSourceKey(scopedShops);
  scheduleIdleTask(() => {
    Promise.allSettled(
      targetPages.map((targetPage) =>
        readLocalApiProductPage(scopedShops, selectedTab, {
          pageSize: pageSizeValue,
          page: targetPage,
          keyword,
          sort,
          filters: queryFilters,
          timeoutMs: 2500,
          observe: false,
        }).then((pageResult) => {
          if (!Array.isArray(pageResult?.rows)) return null;
          const cacheKey = getProductListPageCacheKeyForScopeKey(
            scopeKey,
            selectedTab?.visibility || 'ALL',
            pageSizeValue,
            targetPage,
            keyword,
            sort,
            filterSignature
          );
          writeProductListPageMemoryCache(cacheKey, pageResult.rows, {
            scopeKey,
            status: selectedTab?.label || '',
            keyword,
            page: targetPage,
            pageSize: pageSizeValue,
            total: Number(pageResult?.total) || pageResult.rows.length,
            sort,
            filterSignature,
            source: pageResult?.source || 'sqlite-prefetch',
          });
          return pageResult;
        })
      )
    ).catch(() => undefined);
  }, 300);
}

export function getOzonLocalEntityImageBundle(entity = {}, product = {}) {
  const raw = product.raw ?? {};
  const skuImages = getOzonLocalImageUrls([
    entity.skuImage,
    entity.sku_image,
    ...(Array.isArray(entity.skuImages) ? entity.skuImages : []),
    product.skuImage,
    product.sku_image,
    ...(Array.isArray(product.skuImages) ? product.skuImages : []),
    raw.sku_image,
    raw.skuImage,
    raw.sku_picture,
    raw.skuPicture,
  ]);
  const mainImages = getOzonLocalImageUrls([
    entity.mainImage,
    entity.productMainImage,
    entity.primaryImage,
    entity.primary_image,
    ...(Array.isArray(entity.mainImages) ? entity.mainImages : []),
    ...(Array.isArray(entity.productMainImages) ? entity.productMainImages : []),
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
  const images = getOzonLocalImageUrls([
    ...skuImages,
    ...mainImages,
    entity.image,
    ...(Array.isArray(entity.images) ? entity.images : []),
    product.image,
    ...(Array.isArray(product.images) ? product.images : []),
    raw.image,
    raw.picture,
  ]);
  return { images, skuImages, mainImages };
}

export function getOzonLocalCommissionPercent(value) {
  return normalizeEstimatedCommissionPercent(value);
}

export function mergeOzonCommissionRateHistories(...histories) {
  return histories.reduce(
    (merged, history) => ({
      ...merged,
      ...normalizeCommissionRateHistory(history),
    }),
    {}
  );
}

function normalizeOzonCommissionRateMode(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token.includes('rfbs')) return 'rfbs';
  if (token.includes('fbs')) return 'fbs';
  if (token.includes('fbo')) return 'fbo';
  if (token.includes('fbp')) return 'fbp';
  return '';
}

function getOzonOrderCommissionRateMode(row = {}) {
  return normalizeOzonCommissionRateMode(
    row.commissionRateMode ||
      row.commissionMode ||
      row.fulfillment ||
      row.fulfillmentType ||
      row.deliverySchema ||
      row.source ||
      row.raw?.delivery_schema
  );
}

export function resolveOzonLocalCommissionSnapshot(product = {}, entity = {}) {
  const mode =
    normalizeOzonCommissionRateMode(
      product.commissionRateMode || product.commissionMode || entity.commissionRateMode || entity.commissionMode
    ) || 'rfbs';
  const productMode = normalizeOzonCommissionRateMode(product.commissionRateMode || product.commissionMode);
  const entityMode = normalizeOzonCommissionRateMode(entity.commissionRateMode || entity.commissionMode);
  const modeRate = getOzonLocalCommissionPercent(entity.commissionPercents?.[mode]);
  const fallbackRate =
    modeRate ??
    (productMode === mode ? getOzonLocalCommissionPercent(product.commissionPercent) : null) ??
    (entityMode === mode ? getOzonLocalCommissionPercent(entity.commissionPercent) : null);
  return resolveDailyCommissionRateSnapshot(
    mergeOzonCommissionRateHistories(entity.commissionPercentDailyRates, product.commissionPercentDailyRates),
    {
      lockedDateKey: product.commissionRateDate,
      orderDateKey: product.commissionOrderDateKey,
      fallbackRate,
      readAt: product.commissionRateReadAt || entity.commissionRateReadAt || new Date(),
      mode,
      source: product.commissionRateSource || entity.commissionRateSource || OZON_RFBS_COMMISSION_RATE_SOURCE,
    }
  );
}

export function applyOzonLocalProductEntity(product = {}, entity = {}) {
  const imageBundle = getOzonLocalEntityImageBundle(entity, product);
  const productId = firstUsableOzonId(entity.productId, entity.product_id, entity.id);
  const commissionSnapshot = resolveOzonLocalCommissionSnapshot(product, entity);
  const commissionPercent = commissionSnapshot.rate;
  const currencyCode = entity.currencyCode || product.currencyCode || 'RUB';
  const salesAmountValue = getOzonOrderProductSalesAmount(product);
  const qty = toFiniteNumber(product.qty) ?? 1;
  const entityName = firstFilled(entity.name, entity.title, entity.productName, entity.product_name);
  const shouldUseEntityName =
    entityName && ['', '未返回', '读取失败', '待确认'].includes(String(product.name || '').trim());
  const acquiringUnitValue = firstFiniteNumber(
    entity.acquiringUnitValue,
    entity.acquiringFeeValue,
    entity.acquiring,
    product.acquiringUnitValue
  );
  const productSourceRecord = normalizeProductSourceRecord(
    product.sourceRecord ||
      product.productSourceRecord || {
        links: Array.isArray(product.sourceLinks) ? product.sourceLinks : [],
      }
  );
  const entitySourceRecord = normalizeProductSourceRecord(
    entity.sourceRecord ||
      entity.productSourceRecord || {
        links: Array.isArray(entity.sourceLinks) ? entity.sourceLinks : [],
      }
  );
  const shouldUseEntitySourceRecord = !productSourceRecord.links.length && entitySourceRecord.links.length;
  const entityMaterialProfile =
    entity.materialProfile && typeof entity.materialProfile === 'object' && !Array.isArray(entity.materialProfile)
      ? entity.materialProfile
      : null;
  const entityMaterialProfiles = Array.isArray(entity.materialProfiles) ? entity.materialProfiles : [];
  const entityMaterialCandidates = Array.isArray(entity.materialCandidates) ? entity.materialCandidates : [];
  const shouldUseEntityMaterialProfile = entityMaterialProfile && !product.materialProfile;
  const commissionAmountValue =
    salesAmountValue === null || commissionPercent === null ? null : (salesAmountValue * commissionPercent) / 100;

  return {
    ...product,
    ...(imageBundle.images.length
      ? {
          image: imageBundle.images[0],
          images: imageBundle.images,
        }
      : {}),
    ...(imageBundle.skuImages.length
      ? {
          skuImage: imageBundle.skuImages[0],
          skuImages: imageBundle.skuImages,
        }
      : {}),
    ...(imageBundle.mainImages.length
      ? {
          mainImage: imageBundle.mainImages[0],
          mainImages: imageBundle.mainImages,
          productMainImage: imageBundle.mainImages[0],
          productMainImages: imageBundle.mainImages,
        }
      : {}),
    ...(productId
      ? {
          productId,
          productIdSource: product.productIdSource || 'localProduct',
        }
      : {}),
    ...(shouldUseEntityName
      ? {
          name: entityName,
          title: entityName,
          product: entityName,
        }
      : {}),
    ...(commissionPercent !== null
      ? {
          currencyCode,
          salesAmountValue,
          commissionPercent,
          commissionPercentText: `${commissionPercent}%`,
          commissionAmountValue,
          acquiringUnitValue,
          acquiringValue: acquiringUnitValue === null ? null : acquiringUnitValue * qty,
          commissionAmount:
            commissionAmountValue === null
              ? product.commissionAmount || '未返回'
              : formatOzonPrice(commissionAmountValue, currencyCode),
          commissionMode: product.commissionMode || entity.commissionMode || commissionSnapshot.mode || 'rFBS',
          commissionRateMode: commissionSnapshot.mode || 'rFBS',
          commissionRateDate: product.commissionRateDate || commissionSnapshot.dateKey,
          commissionRateReadAt: commissionSnapshot.readAt,
          commissionRateSource: commissionSnapshot.source || OZON_RFBS_COMMISSION_RATE_SOURCE,
          commissionPercentDailyRates: commissionSnapshot.history,
        }
      : {}),
    ...(shouldUseEntitySourceRecord
      ? {
          sourceRecord: entitySourceRecord,
          productSourceRecord: entitySourceRecord,
          sourceLinks: entitySourceRecord.links,
        }
      : {}),
    ...(shouldUseEntityMaterialProfile
      ? {
          materialProfile: entityMaterialProfile,
          materialSource: entity.materialSource || entityMaterialProfile.source || product.materialSource || '',
        }
      : {}),
    ...(entityMaterialProfiles.length && !(Array.isArray(product.materialProfiles) && product.materialProfiles.length)
      ? {
          materialProfiles: entityMaterialProfiles,
        }
      : {}),
    ...(entityMaterialCandidates.length &&
    !(Array.isArray(product.materialCandidates) && product.materialCandidates.length)
      ? {
          materialCandidates: entityMaterialCandidates,
        }
      : {}),
    ...(Array.isArray(entity.imageHealth) &&
    entity.imageHealth.length &&
    !(Array.isArray(product.imageHealth) && product.imageHealth.length)
      ? {
          imageHealth: entity.imageHealth,
        }
      : {}),
  };
}

export function applyOzonLocalCommissionSummary(row = {}, products = []) {
  const orderSalesAmountValue = firstFiniteNumber(row.amountValue, row.amount);
  const productFeeParts = products.map((product) => ({
    rate: getOzonLocalCommissionPercent(product.commissionPercent),
    amount: product.salesAmountValue,
  }));
  const commissionRates = [
    ...new Set(productFeeParts.map((part) => part.rate).filter((value) => value !== null && value !== undefined)),
  ];
  if (!commissionRates.length) return { ...row, products };

  const canUseProductLineAmounts =
    productFeeParts.length > 0 &&
    productFeeParts.every((part) => part.rate !== null && part.amount !== null && part.amount !== undefined);
  const amountValue =
    commissionRates.length === 1
      ? orderSalesAmountValue === null
        ? canUseProductLineAmounts
          ? (productFeeParts.reduce((sum, part) => sum + part.amount, 0) * commissionRates[0]) / 100
          : null
        : (orderSalesAmountValue * commissionRates[0]) / 100
      : canUseProductLineAmounts
        ? productFeeParts.reduce((sum, part) => sum + (part.amount * part.rate) / 100, 0)
        : null;
  const currencyCode = row.currencyCode || products.find((product) => product.currencyCode)?.currencyCode || 'RUB';
  const percentText =
    commissionRates.length === 1 ? `${commissionRates[0]}%` : commissionRates.length > 1 ? '多比例' : '未返回';
  const commissionSource =
    amountValue === null
      ? '未返回'
      : commissionRates.length === 1 && orderSalesAmountValue !== null
        ? '订单金额'
        : '商品成交金额';

  return {
    ...row,
    products,
    commissionMode: row.commissionMode || 'rFBS',
    commissionPercent: percentText,
    commissionAmount:
      amountValue === null ? row.commissionAmount || '未返回' : formatOzonPrice(amountValue, currencyCode),
    commissionSource,
  };
}

export function applyOzonLocalProductEntitiesToRows(
  rows = [],
  entityMap = new Map(),
  getRecordKey = getSalesOrderRecordKey,
  options = {}
) {
  if (!entityMap.size) return rows;
  const forcedCommissionRateMode = normalizeOzonCommissionRateMode(options.commissionRateMode);
  return rows.map((row) => {
    const products = Array.isArray(row.products) ? row.products : [];
    const enrichedProducts = products.map((product, index) => {
      const lookupKey = getOzonLocalOrderProductLookupKey(row, index, getRecordKey);
      const entity = lookupKey ? entityMap.get(lookupKey) : null;
      return entity
        ? applyOzonLocalProductEntity(
            {
              ...product,
              commissionOrderDateKey: product.commissionOrderDateKey || getSalesOrderPaymentDateKey(row),
              commissionRateMode:
                forcedCommissionRateMode || product.commissionRateMode || getOzonOrderCommissionRateMode(row),
            },
            entity
          )
        : product;
    });
    return applyOzonLocalCommissionSummary(row, enrichedProducts);
  });
}

export function getOzonLocalRowsWithProductImages(rows = [], getRecordKey = getSalesOrderRecordKey) {
  return new Set(
    rows
      .filter((row) => (Array.isArray(row.products) ? row.products : []).some(hasSalesOrderProductImage))
      .map((row) => getOzonLocalOrderRecordKey(row, getRecordKey))
      .filter(Boolean)
  );
}

export function hasOzonOrderRowProductImage(row = {}) {
  return (Array.isArray(row.products) ? row.products : []).some(hasSalesOrderProductImage);
}

export function hasOzonOrderRowEstimatedCommission(row = {}) {
  const rowRate = normalizeEstimatedCommissionPercent(row.commissionPercent);
  if (rowRate !== null) return true;

  const products = Array.isArray(row.products) ? row.products : [];
  if (!products.length) return false;
  return products.every(
    (product) =>
      normalizeEstimatedCommissionPercent(product.commissionPercent) !== null ||
      normalizeEstimatedCommissionPercent(product.raw?.commissionPercent) !== null ||
      normalizeEstimatedCommissionPercent(product.raw?.commission_percent) !== null
  );
}

export function getOzonLocalRowsWithEstimatedCommissions(rows = [], getRecordKey = getSalesOrderRecordKey) {
  return new Set(
    rows
      .filter(hasOzonOrderRowEstimatedCommission)
      .map((row) => getOzonLocalOrderRecordKey(row, getRecordKey))
      .filter(Boolean)
  );
}

export async function readOzonLocalProductEntityRows(
  fileKey,
  rows = [],
  shops = [],
  getRecordKey = getSalesOrderRecordKey,
  options = {}
) {
  if (!fileKey || !rows.length) return { rows: [], entityMap: new Map(), matchedOrderKeys: new Set() };
  const entityMap = new Map();
  const matchedOrderKeys = new Set();
  const summaryResult = await readSalesOrderProductSummaryEntities(rows, shops, {
    getRecordKey,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    hydrateMissing: options.hydrateMissing,
    hydrateTimeoutMs: options.hydrateTimeoutMs,
    requireImages: options.requireImages,
    enableSkuFallback: options.enableSkuFallback === true,
    requestedBy: options.requestedBy,
  }).catch(() => null);
  if (summaryResult?.entityMap?.size) {
    summaryResult.entityMap.forEach((entity, lookupKey) => {
      if (lookupKey && !entityMap.has(lookupKey)) entityMap.set(lookupKey, entity);
    });
    summaryResult.matchedOrderKeys?.forEach((key) => matchedOrderKeys.add(key));
  }
  const rowsMissingSummary = rows.filter((row) => {
    const products = Array.isArray(row.products) ? row.products : [];
    return products.some((_, index) => {
      const lookupKey = getOzonLocalOrderProductLookupKey(row, index, getRecordKey);
      return lookupKey && !entityMap.has(lookupKey);
    });
  });
  if (rowsMissingSummary.length) {
    const store = await readLocalDataFile(fileKey).catch(() => ({}));

    rowsMissingSummary.forEach((row) => {
      const products = Array.isArray(row.products) ? row.products : [];
      const shopKeys = getOzonLocalProductShopKeysForOrder(row, shops);
      products.forEach((product, index) => {
        const lookupKey = getOzonLocalOrderProductLookupKey(row, index, getRecordKey);
        if (!lookupKey || entityMap.has(lookupKey) || !shopKeys.length) return;
        const entities = readOzonProductEntitiesFromLocalStore(
          store,
          [
            {
              ...product,
              shopClientId: row.shopClientId,
              shopId: row.shopId,
              shop: row.shop,
              shopName: row.shopName,
            },
          ],
          { shopKeys }
        );
        if (!entities.length) return;
        entityMap.set(lookupKey, entities[0]);
        const orderKey = getOzonLocalOrderRecordKey(row, getRecordKey);
        if (orderKey) matchedOrderKeys.add(orderKey);
      });
    });
  }

  if (!entityMap.size) return { rows: [], entityMap, matchedOrderKeys };
  return {
    rows: applyOzonLocalProductEntitiesToRows(rows, entityMap, getRecordKey, {
      commissionRateMode: options.commissionRateMode,
    }),
    entityMap,
    matchedOrderKeys,
  };
}

let purchasePluginBridgeEnabledMemory = false;
let purchasePluginBridgeUnavailableUntil = 0;
const PURCHASE_PLUGIN_BRIDGE_RETRY_MS = 60_000;

export function isPurchasePluginBridgeEnabled() {
  if (purchasePluginBridgeEnabledMemory) return true;
  if (typeof window === 'undefined') return false;
  return (
    window.__WANGZAI_PURCHASE_PLUGIN_BRIDGE_ENABLED__ === true ||
    new URLSearchParams(window.location.search).get('purchasePluginBridge') === '1'
  );
}

export function setPurchasePluginBridgeEnabled(enabled) {
  purchasePluginBridgeEnabledMemory = enabled === true;
  if (typeof window !== 'undefined') {
    window.__WANGZAI_PURCHASE_PLUGIN_BRIDGE_ENABLED__ = enabled === true;
  }
}

export async function requestPurchasePluginBridge(path, options = {}) {
  if (options.force !== true && !isPurchasePluginBridgeEnabled()) {
    return { ok: false, bridgeSkipped: true, reason: 'purchase_plugin_bridge_disabled' };
  }
  if (options.force !== true && purchasePluginBridgeUnavailableUntil > Date.now()) {
    return { ok: false, bridgeSkipped: true, reason: 'purchase_plugin_bridge_unavailable' };
  }
  const desktopRequest = globalThis.wangzaiDesktop?.purchaseBridgeRequest;
  if (typeof desktopRequest === 'function') {
    const result = await desktopRequest({
      method: options.method || 'GET',
      path,
      body: options.data,
    });
    if (!result?.ok) {
      const error = new Error(result?.error || result?.data?.message || '桌面拍单服务请求失败');
      error.status = result?.status || 0;
      throw error;
    }
    return result.data;
  }
  let response;
  try {
    response = await fetch(`${PURCHASE_PLUGIN_BRIDGE_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
    });
  } catch (error) {
    purchasePluginBridgeUnavailableUntil = Date.now() + PURCHASE_PLUGIN_BRIDGE_RETRY_MS;
    if (options.force === true) throw error;
    return { ok: false, bridgeSkipped: true, reason: 'purchase_plugin_bridge_unavailable' };
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || `本地插件服务 HTTP ${response.status}`);
  }
  return payload;
}

export function sendPurchasePluginContext(context, options = {}) {
  return requestPurchasePluginBridge('/api/purchase/plugin-context', {
    method: 'POST',
    data: context,
    force: options.force === true,
  });
}

export function readPurchasePluginCaptures(after = 0) {
  if (!isPurchasePluginBridgeEnabled()) return Promise.resolve({ ok: false, captures: [], bridgeSkipped: true });
  const query = after ? `?after=${encodeURIComponent(after)}` : '';
  return requestPurchasePluginBridge(`/api/purchase/plugin-captures${query}`);
}

export function getLocalRecordTimestamp(record) {
  if (!record || typeof record !== 'object') return 0;
  const raw = record.updatedAt || record.savedAt || record.ozonSyncedAt || '';
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : 0;
}

export function mergeLocalRecordMaps(current = {}, incoming = {}) {
  const next = { ...(incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {}) };
  Object.entries(current && typeof current === 'object' && !Array.isArray(current) ? current : {}).forEach(
    ([key, value]) => {
      const existing = next[key];
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        next[key] = value;
        return;
      }
      next[key] = getLocalRecordTimestamp(value) >= getLocalRecordTimestamp(existing) ? value : existing;
    }
  );
  return next;
}

export function readProductListInitialSnapshot(shop, statusLabel, canReadOzon) {
  if (!canReadOzon) {
    return { rows: [] };
  }

  const selectedTab = productStatusTabs.find((tab) => tab.label === statusLabel) ?? productStatusTabs[0];
  const rows =
    readTimedCacheCandidates(
      productListMemoryCache,
      getProductListPageCacheKeyCandidates(shop, selectedTab.visibility, PRODUCT_PAGE_SIZE_OPTIONS[0], 1),
      PRODUCT_LIST_CACHE_TTL_MS
    ) ?? [];
  return { rows };
}

export function buildProductStatusCountsFromPages(pages) {
  const counts = createEmptyProductStatusCounts();
  pages.forEach((page) => {
    counts[page.tab.label] = page.total || page.items?.length || 0;
  });
  return counts;
}

export function toOzonProductCacheItem(row = {}) {
  const productId = row.productId ?? row.product_id ?? '';
  const offerId = row.offerId ?? row.offer_id ?? '';
  const images = Array.isArray(row.images) ? row.images.filter(Boolean) : [];
  const primaryImage = row.primaryImageUrl || row.primary_image || images[0] || '';
  const stockValue = row.stockValue ?? row.stock_value;
  const hasStock = stockValue === null || stockValue === undefined ? undefined : Number(stockValue) > 0;
  const stockJson = row.stockJson ?? row.stock_json;
  const warehouseStocks = Array.isArray(row.warehouseStocks)
    ? row.warehouseStocks
    : Array.isArray(row.warehouse_stocks)
      ? row.warehouse_stocks
      : undefined;
  const sellerWarehouseStockTotal = toFiniteNumber(row.sellerWarehouseStockTotal ?? row.seller_warehouse_stock_total);
  const warehouseStockComplete = row.warehouseStockComplete === true || row.warehouse_stock_complete === true;
  const warehouseStockObservation = row.warehouseStockObservation ?? row.warehouse_stock_observation ?? null;
  const stockInfo =
    stockJson && typeof stockJson === 'object' && !Array.isArray(stockJson)
      ? stockJson
      : stockValue === null || stockValue === undefined
        ? undefined
        : { present: stockValue, has_stock: hasStock };
  const visibility = String(row.visibility || '')
    .trim()
    .toUpperCase();
  const snapshotVisibilities = (row.productSnapshotVisibilities || row.snapshotVisibilities || [])
    .map((value) =>
      String(value || '')
        .trim()
        .toUpperCase()
    )
    .filter(Boolean);
  return {
    product_id: productId ? Number(productId) || productId : undefined,
    id: productId ? Number(productId) || productId : undefined,
    offer_id: offerId,
    sku: row.sku || '',
    name: row.name || '未返回',
    visibility,
    visibility_status: visibility,
    archived: visibility === 'ARCHIVED' || snapshotVisibilities.includes('ARCHIVED'),
    status: row.statusLabel || row.status || visibility,
    status_label: row.statusLabel || row.status || '',
    primary_image: primaryImage,
    images: images.length ? images : primaryImage ? [primaryImage] : [],
    price: row.priceValue ?? undefined,
    currency_code: normalizeProductListPriceCurrencyCode(row.currencyCode || row.currency_code),
    acquiring: row.acquiringFeeValue ?? row.acquiring_fee_value ?? undefined,
    acquiring_amount: row.acquiringFeeValue ?? row.acquiring_fee_value ?? undefined,
    commissions: {
      sales_percent_fbo: row.commissionPercents?.fbo ?? undefined,
      sales_percent_fbs: row.commissionPercents?.fbs ?? undefined,
      sales_percent_rfbs: row.commissionPercents?.rfbs ?? undefined,
      sales_percent_fbp: row.commissionPercents?.fbp ?? undefined,
    },
    commission_status: row.commissionStatus || 'pending',
    commission_provenance: row.commissionProvenance || null,
    acquiring_status: row.acquiringStatus || 'pending',
    acquiring_provenance: row.acquiringProvenance || null,
    // Keep the complete warehouse payload for warehouse-scoped reads. The
    // scalar stockValue remains the canonical all-warehouse total returned by
    // local-api; replacing stockJson with a synthetic single row would make a
    // selected warehouse accidentally read that total as its own quantity.
    stocks: stockInfo,
    stock_json: stockJson,
    stockInfo,
    warehouse_stocks: warehouseStocks,
    warehouseStocks,
    seller_warehouse_stock_total: sellerWarehouseStockTotal,
    sellerWarehouseStockTotal,
    warehouse_stock_complete: warehouseStockComplete,
    warehouseStockComplete,
    warehouse_stock_observation: warehouseStockObservation,
    warehouseStockObservation,
    has_fbo_stocks: hasStock,
    has_fbs_stocks: hasStock,
    description_category_id: row.categoryId || '',
    type_id: row.typeId || row.type_id || '',
    category_name: row.categoryName || '',
    weight: row.weightKg ?? undefined,
    width: row.widthCm ?? undefined,
    height: row.heightCm ?? undefined,
    depth: row.depthCm ?? undefined,
    length: row.depthCm ?? undefined,
    weight_unit: 'kg',
    dimension_unit: 'cm',
    dimensions: {
      weight: row.weightKg ?? undefined,
      width: row.widthCm ?? undefined,
      height: row.heightCm ?? undefined,
      depth: row.depthCm ?? undefined,
      length: row.depthCm ?? undefined,
      weight_unit: 'kg',
      dimension_unit: 'cm',
    },
    productSnapshotVisibility: row.productSnapshotVisibility || snapshotVisibilities[0] || '',
    productSnapshotVisibilities: snapshotVisibilities,
    snapshotVisibilities,
    attributes: row.attributes || [],
    hydrated_at: row.hydratedAt || '',
  };
}

export function normalizeLocalApiProductRows(rows = [], shopOrShops, selectedTab, options = {}) {
  const shops = (Array.isArray(shopOrShops) ? shopOrShops : [shopOrShops]).filter(Boolean);
  const fallbackShop = shops[0] || {};
  const statusByProductId = new Map(
    rows
      .map((row) => [
        String(row.productId || row.product_id || ''),
        normalizeProductStatusLabel(row.statusLabel || row.status),
      ])
      .filter(([productId, statusLabel]) => productId && statusLabel && statusLabel !== '未知状态')
  );
  return rows.map((row) => {
    const rowShopId = String(row.shopId ?? row.shop_id ?? '').trim();
    const rowShopClientId = String(row.shopClientId ?? row.shop_client_id ?? row.clientId ?? '').trim();
    const shop =
      shops.find((item) => rowShopId && String(item?.id || '').trim() === rowShopId) ||
      shops.find((item) => rowShopClientId && String(item?.clientId || '').trim() === rowShopClientId) ||
      fallbackShop;
    const item = toOzonProductCacheItem(row);
    const backendStockValue = toFiniteNumber(row.stockValue ?? row.stock_value);
    const warehouseStocks = Array.isArray(row.warehouseStocks)
      ? row.warehouseStocks
      : Array.isArray(row.warehouse_stocks)
        ? row.warehouse_stocks
        : [];
    const sellerWarehouseStockTotal = toFiniteNumber(row.sellerWarehouseStockTotal ?? row.seller_warehouse_stock_total);
    const warehouseStockComplete = row.warehouseStockComplete === true || row.warehouse_stock_complete === true;
    const warehouseStockObservation = row.warehouseStockObservation ?? row.warehouse_stock_observation ?? null;
    const commissionPercents = row.commissionPercents || {};
    const commissionFulfillmentType =
      ['rfbs', 'fbs', 'fbo', 'fbp'].find((mode) => Number(commissionPercents?.[mode]) > 0) || null;
    const commissionStatus = row.commissionStatus || 'pending';
    const snapshotVisibilities = getOzonLocalUniqueValues([
      row.productSnapshotVisibility,
      ...(Array.isArray(row.productSnapshotVisibilities) ? row.productSnapshotVisibilities : []),
      ...(Array.isArray(row.snapshotVisibilities) ? row.snapshotVisibilities : []),
      selectedTab?.visibility,
    ])
      .map((value) =>
        String(value || '')
          .trim()
          .toUpperCase()
      )
      .filter(Boolean);
    const normalizedRow = normalizeOzonProductRow(
      item,
      item,
      item,
      item,
      item,
      item,
      shop,
      selectedTab?.label || '',
      statusByProductId,
      { rubToCnyRate: options.rubToCnyRate }
    );
    return {
      ...normalizedRow,
      // The product-list column is the backend's canonical all-warehouse
      // aggregate. Warehouse facts stay in raw.stockInfo for per-warehouse
      // operations and must not replace this scalar with a first-warehouse
      // value (or a second frontend aggregation rule).
      stock: backendStockValue,
      stockValue: backendStockValue,
      warehouseStocks,
      sellerWarehouseStockTotal,
      warehouseStockComplete,
      warehouseStockObservation,
      materialProfile: row.materialProfile || null,
      materialSource: row.materialSource || row.materialProfile?.source || '',
      sourceLinks: Array.isArray(row.sourceLinks) ? row.sourceLinks : [],
      sourceRecord: row.sourceRecord || null,
      imageHealth: Array.isArray(row.imageHealth) ? row.imageHealth : [],
      acquiringFeeValue: row.acquiringFeeValue ?? row.acquiring_fee_value ?? null,
      acquiringPercent: row.acquiringPercent ?? row.acquiring_percent ?? null,
      acquiringStatus: row.acquiringStatus || 'pending',
      acquiringProvenance: row.acquiringProvenance || null,
      commissionPercent: row.commissionPercent ?? null,
      commissionPercents,
      commissionStatuses: row.commissionStatuses || {},
      commissionStatus,
      commissionProvenance: row.commissionProvenance || null,
      commissionFulfillmentType: commissionFulfillmentType?.toUpperCase() || null,
      commissionRateMode: commissionFulfillmentType || null,
      commissionEvidenceKind:
        row.commissionPercent != null
          ? 'ozon_direct'
          : ['unavailable', 'not_returned', 'returned_empty'].includes(commissionStatus)
            ? 'ozon_not_returned'
            : commissionStatus,
      commissionText:
        row.commissionPercent == null
          ? ['unavailable', 'not_returned', 'contract_invalid'].includes(commissionStatus)
            ? 'Ozon 未返回'
            : '待确认'
          : commissionStatus === 'stale_previous'
            ? `${row.commissionPercent}%（上次）`
            : `${row.commissionPercent}%`,
      facetObservations: row.facetObservations || {},
      factSource: row.factSource || 'sqlite',
      productSnapshotVisibility: snapshotVisibilities[0] || selectedTab?.visibility || '',
      productSnapshotVisibilities: snapshotVisibilities,
      liveHydrated: isProductFullyHydrated(row),
    };
  });
}

export async function readLocalApiProductPage(shopOrShops, selectedTab, options = {}) {
  const shops = (Array.isArray(shopOrShops) ? shopOrShops : [shopOrShops]).filter(Boolean);
  const shopIds = shops
    .map((shop) => String(shop?.id || '').trim())
    .filter((shopId, index, values) => shopId && values.indexOf(shopId) === index);
  if (!shopIds.length) return null;
  const pageSizeValue = Math.max(1, Math.min(Number(options.pageSize) || PRODUCT_PAGE_SIZE_OPTIONS[0], 1000));
  const pageValue = Math.max(1, Number(options.page) || 1);
  const sort = String(options.sort || 'stable').trim() || 'stable';
  const filters = normalizeProductListQueryFilters(options.filters);
  const cache = await readProductListCache(
    {
      ...(shopIds.length === 1 ? { shopId: shopIds[0] } : {}),
      shopIds,
      visibility: selectedTab?.visibility || 'ALL',
      pageSize: pageSizeValue,
      page: pageValue,
      keyword: options.keyword || '',
      sort,
      ...filters,
    },
    {
      signal: options.signal,
      timeoutMs: options.timeoutMs || 3500,
      observe: options.observe,
    }
  );
  const rows = Array.isArray(cache?.rows) ? cache.rows : [];
  const total = Number(cache?.total);
  return {
    rows: normalizeLocalApiProductRows(rows, shops, selectedTab, { rubToCnyRate: options.rubToCnyRate }),
    total: Number.isFinite(total) && total >= 0 ? total : rows.length,
    counts: cache?.counts || null,
    sort: cache?.sort || sort,
    filterSignature: getProductListQueryFilterSignature(filters),
    source: cache?.source || 'sqlite',
    durationMs: Number(cache?.durationMs) || 0,
  };
}

import { getOzonApiErrorMessage as getOzonApiErrorMessageSafe } from '../../services/ozonOrderSafety';
import { safeWarn } from '../../services/safeLog';
import { OZON_PRODUCT_INFO_CHUNK_SIZE } from '../../shared/config/appConfigCore.jsx';
import { isOzonAbortReadError, isOzonRetryableReadError, requestOzonReadOnly } from '../../shared/ozon/ozonRuntime.jsx';
import {
  firstFilled,
  getOzonShopClientId,
  getOzonSnapshotSourceKey,
  normalizeOzonId,
} from '../order/orderIdentityRules.jsx';
import { formatOzonPrice, normalizeProductListPriceCurrencyCode } from './productPriceRules.jsx';
import { normalizeProductStatusLabel, productStatusToneMap } from './productStatusRules.jsx';
import { getProductStatusLabelByVisibility } from './productLocalData.jsx';
import { getOzonImages } from './productImageRules.jsx';

export async function requestOzonProductInfoListSafely(shop, fieldName, values = [], options = {}) {
  const details = [];
  const uniqueValues = [...new Set(values.map((value) => normalizeOzonId(value).trim()).filter(Boolean))];
  const chunkSize = options.chunkSize || OZON_PRODUCT_INFO_CHUNK_SIZE;
  const allowPartial = Boolean(options.allowPartial);

  const readChunk = async (chunk) => {
    if (chunk.length === 0) return;
    try {
      const data = await requestOzonReadOnly(
        '/v3/product/info/list',
        shop,
        {
          [fieldName]: chunk,
        },
        { signal: options.signal }
      );
      details.push(...getOzonPayloadItems(data));
    } catch (error) {
      if (allowPartial && isOzonAbortReadError(error)) return;
      const canSplitAndContinue = allowPartial || isOzonRetryableReadError(error);
      if (!canSplitAndContinue) throw error;
      if (chunk.length === 1) {
        if (allowPartial) {
          safeWarn(`Ozon 商品详情单项读取失败：${fieldName}=${chunk[0]}`, error);
          return;
        }
        throw error;
      }
      const middle = Math.ceil(chunk.length / 2);
      await readChunk(chunk.slice(0, middle));
      await readChunk(chunk.slice(middle));
    }
  };

  for (let index = 0; index < uniqueValues.length; index += chunkSize) {
    await readChunk(uniqueValues.slice(index, index + chunkSize));
  }

  return details;
}

export async function requestOzonProductDetails(shop, productIds, options = {}) {
  return requestOzonProductInfoListSafely(shop, 'product_id', productIds, options);
}

export async function requestOzonProductDetailsByOfferIds(shop, offerIds, options = {}) {
  return requestOzonProductInfoListSafely(shop, 'offer_id', offerIds, options);
}

export { formatOzonPrice, normalizeProductListPriceCurrencyCode };

export function getOzonProductVisibilityStatus(listItem, detail) {
  const visibilityCandidates = [
    listItem?.visibility,
    listItem?.visibility_status,
    listItem?.visibilityStatus,
    listItem?.status,
    listItem?.state,
    detail?.visibility,
    detail?.visibility_status,
    detail?.visibilityStatus,
    detail?.status,
    detail?.state,
    detail?.visibility_details?.visibility,
    detail?.visibility_details?.status,
    detail?.visibility_details?.state,
    listItem?.productSnapshotVisibility,
    ...(Array.isArray(listItem?.productSnapshotVisibilities) ? listItem.productSnapshotVisibilities : []),
    ...(Array.isArray(listItem?.snapshotVisibilities) ? listItem.snapshotVisibilities : []),
  ];
  for (const value of visibilityCandidates) {
    const status = getProductStatusLabelByVisibility(value);
    if (status) return status;
  }
  return '';
}

export function fallbackProductStatus(listItem, detail) {
  if (detail?.is_archived || listItem?.archived) return '已下架';
  if (Array.isArray(detail?.errors) && detail.errors.length > 0) return '待修改';
  return '未知状态';
}

export function resolveOzonProductStatus(listItem, detail, requestStatusLabel, statusByProductId, productId) {
  const platformStatus = getOzonProductVisibilityStatus(listItem, detail);
  if (platformStatus) return platformStatus;

  const mappedStatus = normalizeProductStatusLabel(statusByProductId?.get(String(productId)));
  if (mappedStatus && mappedStatus !== '未知状态') return mappedStatus;

  const requestStatus = normalizeProductStatusLabel(requestStatusLabel);
  if (requestStatus && requestStatus !== '全部商品' && productStatusToneMap[requestStatus]) return requestStatus;

  return fallbackProductStatus(listItem, detail);
}

export function getOzonPayloadItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.postings)) return data.postings;
  if (Array.isArray(data?.returns)) return data.returns;
  if (Array.isArray(data?.conditional_cancellations)) return data.conditional_cancellations;
  if (Array.isArray(data?.cancellations)) return data.cancellations;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.result?.items)) return data.result.items;
  if (Array.isArray(data?.result?.postings)) return data.result.postings;
  if (Array.isArray(data?.result?.products)) return data.result.products;
  if (Array.isArray(data?.result?.returns)) return data.result.returns;
  if (Array.isArray(data?.result?.conditional_cancellations)) return data.result.conditional_cancellations;
  if (Array.isArray(data?.result?.cancellations)) return data.result.cancellations;
  if (Array.isArray(data?.products)) return data.products;
  return [];
}

export function getOzonNestedItems(data, keys) {
  const sources = [data, data?.result, data?.data];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      if (Array.isArray(source[key])) return source[key];
    }
  }
  return [];
}

export function getOzonWarehouseItems(data) {
  const directItems = getOzonPayloadItems(data);
  if (directItems.length) return directItems;
  return getOzonNestedItems(data, ['warehouses', 'warehouse_list']);
}

export function getOzonDeliveryMethodItems(data) {
  const directItems = getOzonPayloadItems(data);
  if (directItems.length) return directItems;
  const nestedItems = getOzonNestedItems(data, [
    'delivery_methods',
    'deliveryMethods',
    'methods',
    'delivery_method_list',
  ]);
  if (nestedItems.length) return nestedItems;
  return collectOzonDeliveryMethodItems(data);
}

export function looksLikeOzonDeliveryMethod(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  return Boolean(
    item.delivery_method_id ||
    item.deliveryMethodId ||
    item.method_id ||
    item.delivery_method_name ||
    item.deliveryMethodName ||
    item.method_name ||
    item.tpl_provider_name ||
    item.provider_name
  );
}

export function collectOzonDeliveryMethodItems(source, inheritedWarehouseId = '', seen = new Set()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return [];
  seen.add(source);

  if (Array.isArray(source)) {
    return source.flatMap((item) => collectOzonDeliveryMethodItems(item, inheritedWarehouseId, seen));
  }

  const warehouseId = normalizeOzonId(
    firstFilled(
      inheritedWarehouseId,
      source?.warehouse_id,
      source?.warehouseId,
      source?.warehouse?.id,
      source?.warehouse?.warehouse_id
    )
  );
  const methodKeys = ['delivery_methods', 'deliveryMethods', 'methods', 'delivery_method_list'];
  const collected = [];

  methodKeys.forEach((key) => {
    if (!Array.isArray(source[key])) return;
    source[key].forEach((method) => {
      if (method && typeof method === 'object') {
        collected.push(
          warehouseId && !method.warehouse_id && !method.warehouseId ? { ...method, warehouse_id: warehouseId } : method
        );
      }
    });
  });

  if (looksLikeOzonDeliveryMethod(source)) {
    collected.push(source);
  }

  Object.values(source).forEach((value) => {
    collected.push(...collectOzonDeliveryMethodItems(value, warehouseId, seen));
  });

  return collected;
}

export function normalizeOzonWarehouse(item, index = 0) {
  const id = normalizeOzonId(
    firstFilled(item?.warehouse_id, item?.warehouseId, item?.id, item?.warehouse?.id, item?.warehouse?.warehouse_id)
  );
  const isArchived = item?.is_archived === true || item?.is_archive === true || item?.archived === true;
  const isActive = firstFilled(item?.is_active, item?.active, item?.is_available);
  const isDefault = item?.is_default === true || item?.default === true || item?.isDefault === true;
  const rawStatus = firstFilled(item?.status, item?.state, item?.warehouse_status);
  const status = isArchived ? '已归档' : isDefault ? '默认仓库' : isActive === false ? '停用' : rawStatus || '可选择';

  return {
    id: id || `warehouse-${index + 1}`,
    name:
      firstFilled(item?.name, item?.warehouse_name, item?.warehouseName, item?.title, item?.warehouse?.name) ||
      `未命名仓库 ${index + 1}`,
    status,
    rawId: id || '未返回',
    address: firstFilled(item?.address, item?.location, item?.city, item?.warehouse?.address) || '未返回',
    raw: item,
  };
}

export function normalizeOzonDeliveryMethod(item, index = 0) {
  const id = normalizeOzonId(firstFilled(item?.delivery_method_id, item?.deliveryMethodId, item?.method_id, item?.id));
  const warehouseId = normalizeOzonId(
    firstFilled(
      item?.warehouse_id,
      item?.warehouseId,
      item?.warehouse?.id,
      item?.warehouse?.warehouse_id,
      item?.rfbs_warehouse_id
    )
  );
  const provider = firstFilled(
    item?.provider_name,
    item?.providerName,
    item?.provider,
    item?.tpl_provider_name,
    item?.tplProviderName
  );
  const type = firstFilled(
    item?.delivery_type,
    item?.deliveryType,
    item?.type,
    item?.shipping_type,
    item?.delivery_schema
  );
  const status = firstFilled(item?.status, item?.state, item?.is_active === false ? '停用' : '', '启用');

  return {
    id: id || `delivery-method-${index + 1}`,
    rawId: id || '未返回',
    warehouseId,
    name:
      firstFilled(
        item?.name,
        item?.delivery_method_name,
        item?.deliveryMethodName,
        item?.title,
        item?.method_name,
        provider
      ) || `未命名配送方式 ${index + 1}`,
    type: [type, provider].filter(Boolean).join(' / ') || '未返回',
    status,
    raw: item,
  };
}

export function isInactiveOzonWarehouseStatus(status) {
  const text = String(status || '')
    .trim()
    .toLowerCase();
  if (!text) return false;
  return (
    text.includes('disabled') ||
    text.includes('inactive') ||
    text.includes('archived') ||
    text.includes('archive') ||
    text.includes('deleted') ||
    text.includes('blocked') ||
    text.includes('suspended') ||
    text.includes('paused') ||
    text.includes('disable') ||
    text.includes('已归档') ||
    text.includes('停用') ||
    text.includes('禁用') ||
    text.includes('关闭') ||
    text.includes('暂停') ||
    text.includes('未启用') ||
    text.includes('不启用')
  );
}

export function isVisibleOzonWarehouse(warehouse) {
  const raw = warehouse?.raw || {};
  const archived = raw.is_archived === true || raw.is_archive === true || raw.archived === true;
  const inactive =
    raw.is_active === false || raw.active === false || raw.is_available === false || raw.enabled === false;
  return !archived && !inactive && !isInactiveOzonWarehouseStatus(warehouse?.status);
}

export function isVisibleOzonDeliveryMethod(method) {
  const raw = method?.raw || {};
  const inactive =
    raw.is_active === false || raw.active === false || raw.enabled === false || raw.is_available === false;
  return !inactive && !isInactiveOzonWarehouseStatus(method?.status);
}

export const DEFAULT_WAREHOUSE_NAME = '无敌仓';

export function getDefaultOzonWarehouse(warehouses = [], preferredWarehouseId = '') {
  const preferredId = normalizeOzonId(preferredWarehouseId);
  return (
    warehouses.find(
      (warehouse) =>
        warehouse?.id === preferredWarehouseId || (preferredId && normalizeOzonId(warehouse?.rawId) === preferredId)
    ) ??
    warehouses.find((warehouse) => String(warehouse?.name || '').trim() === DEFAULT_WAREHOUSE_NAME) ??
    warehouses.find((warehouse) => String(warehouse?.name || '').includes(DEFAULT_WAREHOUSE_NAME)) ??
    warehouses[0] ??
    null
  );
}

export function getWarehouseStatusColor(status) {
  if (!status) return 'default';
  const statusText = String(status);
  const lowerStatusText = statusText.toLowerCase();
  if (statusText.includes('默认')) return 'primary';
  if (
    lowerStatusText.includes('blocked') ||
    lowerStatusText.includes('disabled') ||
    lowerStatusText.includes('inactive') ||
    statusText.includes('归档') ||
    statusText.includes('停') ||
    statusText.includes('禁用') ||
    statusText.includes('关闭') ||
    statusText.includes('暂停')
  ) {
    return 'warning';
  }
  if (lowerStatusText.includes('active') || statusText.includes('可') || statusText.includes('启')) return 'success';
  return 'default';
}

export function getDeliveryMethodStatusColor(status) {
  return getWarehouseStatusColor(status);
}

export function getOzonLogisticsStatusLabel(status) {
  const text = String(status || '').trim();
  if (!text) return '未返回';
  const lowerText = text.toLowerCase();

  if (lowerText.includes('blocked')) return '阻断';
  if (lowerText.includes('disabled')) return '停用';
  if (lowerText.includes('inactive')) return '停用';
  if (lowerText.includes('archived') || lowerText.includes('archive')) return '已归档';
  if (lowerText.includes('suspended') || lowerText.includes('paused')) return '暂停';
  if (lowerText.includes('deleted')) return '已删除';
  if (lowerText.includes('active') || lowerText.includes('enabled')) return '启用';

  if (text.includes('默认')) return '默认仓库';
  if (text.includes('归档')) return '已归档';
  if (text.includes('阻断')) return '阻断';
  if (text.includes('暂停')) return '暂停';
  if (text.includes('停') || text.includes('禁用') || text.includes('关闭')) return '停用';
  if (text.includes('启') || text.includes('可选择')) return '启用';

  return text;
}

export function getWarehouseStatusLabel(status) {
  return getOzonLogisticsStatusLabel(status);
}

export function getDeliveryMethodStatusLabel(status) {
  return getOzonLogisticsStatusLabel(status);
}

export function getOzonDeliveryMethodDisplayName(methodOrName) {
  const rawName = typeof methodOrName === 'string' ? methodOrName : methodOrName?.name;
  const name = String(rawName || '').trim();
  if (!name) return '未命名配送方式';

  return name
    .replace(/配送点\s*PUDO/giu, '配送点')
    .replace(/PUDO/giu, '配送点')
    .replace(/Courier/giu, '快递')
    .replace(/Pickup/giu, '自提')
    .replace(/Express/giu, '加急')
    .replace(/Delivery/giu, '配送')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function getOzonApiErrorMessage(error) {
  return getOzonApiErrorMessageSafe(error);
}

export async function requestOzonReadOnlyVariants(endpoint, shop, bodies, options = {}) {
  let lastError = null;
  for (const body of bodies) {
    try {
      return await requestOzonReadOnly(endpoint, shop, body, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${endpoint} 请求失败`);
}

export async function requestOzonReadOnlyVariantsWithRows(endpoint, shop, bodies, extractRows) {
  let lastError = null;
  let firstEmptyData = null;
  for (const body of bodies) {
    try {
      const data = await requestOzonReadOnly(endpoint, shop, body);
      const rows = typeof extractRows === 'function' ? extractRows(data) : [];
      if (Array.isArray(rows) && rows.length > 0) return data;
      if (!firstEmptyData) firstEmptyData = data;
    } catch (error) {
      if (endpoint === '/v1/rating/index/fbs/posting/list' && (
        isOzonAbortReadError(error)
        || ['LOCAL_RATING_CACHE_INCOMPLETE', 'LOCAL_RATING_SYNC_NOT_ACCEPTED'].includes(error?.code)
        || (error?.code === 'LOCAL_RATING_SYNC_INCOMPLETE' && error?.payload?.status !== 'failed')
      )) throw error;
      lastError = error;
    }
  }
  if (firstEmptyData) return firstEmptyData;
  throw lastError ?? new Error(`${endpoint} 请求失败`);
}

function applyWarehouseConfigReadOptions(body = {}, options = {}) {
  return {
    ...body,
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
    ...(options.backgroundRefresh ? { backgroundRefresh: true } : {}),
  };
}

export async function requestOzonWarehouseConfigSnapshot(shop, options = {}) {
  const waitsForFreshCache = options.forceRefresh === true && options.backgroundRefresh !== true;
  const requestOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    maxRetries: 0,
    timeoutMs: options.timeoutMs ?? (options.backgroundRefresh ? 3000 : waitsForFreshCache ? 25_000 : 6000),
    ...(waitsForFreshCache
      ? {
          logisticsSyncTimeoutMs: options.logisticsSyncTimeoutMs ?? 20_000,
          logisticsSyncPollIntervalMs: options.logisticsSyncPollIntervalMs ?? 250,
        }
      : {}),
  };
  const warehouseBodies = [{ limit: 100, cursor: '' }, { limit: 100 }].map((body) =>
    applyWarehouseConfigReadOptions(body, options)
  );
  const deliveryMethodBodies = [{ limit: 100, filter: {} }, { limit: 100 }].map((body) =>
    applyWarehouseConfigReadOptions(body, options)
  );
  const warehouseRequest = options.backgroundRefresh
    ? requestOzonReadOnly('/v2/warehouse/list', shop, warehouseBodies[0], requestOptions)
    : requestOzonReadOnlyVariants('/v2/warehouse/list', shop, warehouseBodies, requestOptions);
  const deliveryMethodRequest = options.backgroundRefresh
    ? requestOzonReadOnly('/v2/delivery-method/list', shop, deliveryMethodBodies[0], requestOptions)
    : requestOzonReadOnlyVariants('/v2/delivery-method/list', shop, deliveryMethodBodies, requestOptions);
  const [warehouseResult, deliveryMethodResult] = await Promise.allSettled([warehouseRequest, deliveryMethodRequest]);

  const issues = [];
  const warehouseData = warehouseResult.status === 'fulfilled' ? warehouseResult.value : null;
  const deliveryMethodData = deliveryMethodResult.status === 'fulfilled' ? deliveryMethodResult.value : null;

  if (warehouseResult.status === 'rejected') {
    issues.push(`仓库读取失败：${getOzonApiErrorMessage(warehouseResult.reason)}`);
  }
  if (deliveryMethodResult.status === 'rejected') {
    issues.push(`配送方式读取失败：${getOzonApiErrorMessage(deliveryMethodResult.reason)}`);
  }
  if (warehouseData?.localApiCache?.syncError?.message) {
    issues.push(`仓库同步未完成：${warehouseData.localApiCache.syncError.message}`);
  }
  if (deliveryMethodData?.localApiCache?.syncError?.message) {
    issues.push(`配送方式同步未完成：${deliveryMethodData.localApiCache.syncError.message}`);
  }

  if (!warehouseData && !deliveryMethodData) {
    throw new Error(issues.join('；') || 'Ozon 仓库配置读取失败');
  }

  const includeInactive = options.includeInactive === true;
  const allWarehouses = warehouseData ? getOzonWarehouseItems(warehouseData).map(normalizeOzonWarehouse) : [];
  const inactiveWarehouses = allWarehouses.filter((warehouse) => !isVisibleOzonWarehouse(warehouse));
  const visibleWarehouses = includeInactive ? allWarehouses : allWarehouses.filter(isVisibleOzonWarehouse);
  const hiddenWarehouseIds = new Set(
    inactiveWarehouses.map((warehouse) => normalizeOzonId(warehouse.rawId)).filter(Boolean)
  );
  const allDeliveryMethods = deliveryMethodData
    ? getOzonDeliveryMethodItems(deliveryMethodData).map(normalizeOzonDeliveryMethod)
    : [];
  const visibleDeliveryMethods = includeInactive
    ? allDeliveryMethods
    : allDeliveryMethods.filter(isVisibleOzonDeliveryMethod).filter((method) => {
        const warehouseId = normalizeOzonId(method.warehouseId);
        return !warehouseId || !hiddenWarehouseIds.has(warehouseId);
      });

  return {
    status: issues.length ? 'partial' : 'success',
    warnings: issues,
    warehouses: visibleWarehouses,
    deliveryMethods: visibleDeliveryMethods,
    allWarehouseCount: allWarehouses.length,
    inactiveWarehouseCount: inactiveWarehouses.length,
    allDeliveryMethodCount: allDeliveryMethods.length,
    inactiveDeliveryMethodCount: allDeliveryMethods.filter((method) => !isVisibleOzonDeliveryMethod(method)).length,
    fetchedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
}

export function getOzonProductListItems(data) {
  if (Array.isArray(data?.result?.items)) return data.result.items;
  return getOzonPayloadItems(data);
}

export function getOzonProductListTotal(data, fallbackCount) {
  const total = firstFilled(data?.result?.total, data?.total, data?.count);
  return total === '' || total === undefined ? fallbackCount : Number(total);
}

export function getOzonProductListLastId(data) {
  return normalizeOzonId(
    firstFilled(
      data?.result?.last_id,
      data?.result?.lastId,
      data?.result?.next_last_id,
      data?.result?.nextLastId,
      data?.last_id,
      data?.lastId,
      data?.next_last_id,
      data?.nextLastId
    )
  );
}

export function collectWarehouseProductStockItems(stockInfo) {
  // The local canonical DTO keeps seller-warehouse (v2 FBS) facts separate
  // from the authoritative v4 total. When this explicit projection exists it
  // is the only valid source for warehouse-scoped quantities; merging v4
  // stocks here would double count or assign FBO/FBS totals to a seller
  // warehouse.
  if (Array.isArray(stockInfo)) return stockInfo;
  if (Array.isArray(stockInfo?.warehouse_stocks)) return stockInfo.warehouse_stocks;
  if (Array.isArray(stockInfo?.warehouseStocks)) return stockInfo.warehouseStocks;
  return [
    stockInfo,
    ...(Array.isArray(stockInfo?.stocks) ? stockInfo.stocks : []),
    ...(Array.isArray(stockInfo?.stocks?.stocks) ? stockInfo.stocks.stocks : []),
  ].filter((item) => item && typeof item === 'object');
}

export function getWarehouseProductWarehouseIds(stockInfo) {
  const ids = collectWarehouseProductStockItems(stockInfo)
    .map((item) =>
      normalizeOzonId(
        firstFilled(
          item?.warehouse_id,
          item?.warehouseId,
          item?.warehouse?.id,
          item?.warehouse?.warehouse_id,
          item?.warehouse?.warehouseId
        )
      )
    )
    .filter((value, index, values) => value && value !== '未返回' && values.indexOf(value) === index);
  return ids;
}

export function normalizeWarehouseProductRow(listItem, detail, pictures, stockInfo, index = 0) {
  const productId = normalizeOzonId(
    firstFilled(listItem?.product_id, listItem?.id, detail?.id, pictures?.product_id, stockInfo?.product_id)
  );
  const offerId = normalizeOzonId(
    firstFilled(detail?.offer_id, pictures?.offer_id, stockInfo?.offer_id, listItem?.offer_id, listItem?.offerId)
  );
  const ozonSku = normalizeOzonId(
    firstFilled(detail?.sku, stockInfo?.sku, listItem?.sku, listItem?.sku_id, listItem?.skuId)
  );
  const name = firstFilled(detail?.name, listItem?.name) || '未返回';
  const images = getOzonImages(detail, listItem, pictures);
  const warehouseIds = getWarehouseProductWarehouseIds(stockInfo);
  const status =
    firstFilled(
      detail?.status,
      detail?.state,
      listItem?.status,
      listItem?.visibility,
      detail?.visibility_details?.has_price === false ? '价格未返回' : '',
      detail?.visibility_details?.has_stock === false ? '库存未返回' : ''
    ) || '未返回';

  return {
    id: productId || offerId || `warehouse-product-${index + 1}`,
    productId: productId || '未返回',
    offerId: offerId || '未返回',
    ozonSku: ozonSku || '未返回',
    name,
    image: images[0] || '',
    images,
    status,
    warehouseId: warehouseIds[0] || '',
    warehouseIds,
    warehouseStatus: warehouseIds.length ? warehouseIds.join(' / ') : '未返回',
    warehouseSource: warehouseIds.length ? 'Ozon 库存返回' : '未返回',
    raw: { listItem, detail, pictures, stockInfo },
  };
}

const OZON_WAREHOUSE_PRODUCT_LIST_LIMIT = 5000;
const OZON_WAREHOUSE_PRODUCT_MAX_PAGES = 100;
const OZON_WAREHOUSE_LOCAL_READ_TIMEOUT_MS = 3000;

export async function requestOzonWarehouseProductsSnapshot(shop, options = {}) {
  const listItems = [];
  const seenProductKeys = new Set();
  let lastId = '';
  let total = 0;
  let page = 0;
  let pageWarning = '';

  while (page < OZON_WAREHOUSE_PRODUCT_MAX_PAGES) {
    const data = await requestOzonReadOnly(
      '/v3/product/list',
      shop,
      {
        filter: { visibility: 'ALL' },
        last_id: lastId,
        limit: OZON_WAREHOUSE_PRODUCT_LIST_LIMIT,
        projection: 'warehouse-picker',
        forceRefresh: page === 0 && options.forceRefresh === true,
        autoSync: page === 0 && options.autoSync !== false,
      },
      {
        signal: options.signal,
        maxRetries: 0,
        timeoutMs: options.timeoutMs ?? OZON_WAREHOUSE_LOCAL_READ_TIMEOUT_MS,
      }
    );
    const pageItems = getOzonProductListItems(data);
    total = Math.max(total, getOzonProductListTotal(data, listItems.length + pageItems.length));
    pageItems.forEach((item) => {
      const key =
        normalizeOzonId(firstFilled(item?.product_id, item?.id)) ||
        normalizeOzonId(firstFilled(item?.offer_id, item?.offerId)) ||
        `page-${page}-row-${listItems.length}`;
      if (key && seenProductKeys.has(key)) return;
      if (key) seenProductKeys.add(key);
      listItems.push(item);
    });

    const nextLastId = getOzonProductListLastId(data);
    if (!nextLastId || nextLastId === lastId || pageItems.length === 0) break;
    lastId = nextLastId;
    page += 1;
  }

  if (page >= OZON_WAREHOUSE_PRODUCT_MAX_PAGES && total > listItems.length) {
    pageWarning = `商品列表分页超过 ${OZON_WAREHOUSE_PRODUCT_MAX_PAGES} 页，本次已读取 ${listItems.length} 条，请缩小范围后重试`;
  }

  const productIds = listItems
    .map((item) => Number(firstFilled(item?.product_id, item?.id)))
    .filter((value) => Number.isFinite(value) && value > 0);
  let details = [];
  let pictures = [];
  let stocks = [];
  let warning = '';
  let pictureWarning = '';
  let stockWarning = '';

  if (options.hydrate !== false && productIds.length) {
    try {
      details = await requestOzonProductDetails(shop, productIds);
    } catch {
      warning = '商品详情读取失败，已显示商品列表返回字段';
    }
    try {
      stocks = await requestOzonProductStocks(shop, productIds);
    } catch {
      stockWarning = '商品库存仓库读取失败，已显示商品基础信息';
    }
    try {
      pictures = await requestOzonProductPictures(shop, productIds);
    } catch {
      pictureWarning = '商品图片读取失败，已显示商品编号信息';
    }
  }

  const detailMap = new Map(details.map((detail) => [String(detail?.id), detail]));
  const pictureMap = buildOzonProductMap(pictures);
  const stockMap = buildOzonProductMap(stocks);
  const rows = listItems.map((item, index) => {
    const productId = normalizeOzonId(firstFilled(item?.product_id, item?.id));
    const offerId = normalizeOzonId(firstFilled(item?.offer_id, item?.offerId));
    const row = normalizeWarehouseProductRow(
      item,
      detailMap.get(productId),
      pictureMap.get(productId) ?? pictureMap.get(offerId),
      stockMap.get(productId) ??
        stockMap.get(offerId) ??
        item?.stockInfo ??
        item?.stock_json ??
        item?.warehouse_stocks ??
        item?.warehouseStocks ??
        item?.stocks,
      index
    );
    return {
      ...row,
      shop: shop?.name || shop?.shopAlias || row.shop || '',
      shopName: shop?.name || shop?.shopAlias || row.shopName || '',
      shopId: shop?.id || row.shopId || '',
      shopClientId: getOzonShopClientId(shop) || row.shopClientId || '',
    };
  });

  return {
    rows,
    total: total || rows.length,
    warnings: [pageWarning, warning, stockWarning, pictureWarning].filter(Boolean),
    fetchedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
}

export function getOzonProductKey(item) {
  const productId = item?.product_id ?? item?.id;
  if (productId !== undefined && productId !== null && productId !== '') return String(productId);
  const offerId = item?.offer_id ?? item?.offerId;
  return offerId ? String(offerId) : '';
}

export function buildOzonProductMap(items) {
  const map = new Map();
  items.forEach((item) => {
    const key = getOzonProductKey(item);
    if (key) map.set(key, item);
    const offerId = item?.offer_id ?? item?.offerId;
    if (offerId) map.set(String(offerId), item);
    const sku = item?.sku ?? item?.sku_id ?? item?.skuId;
    if (sku) map.set(normalizeOzonId(sku).trim(), item);
  });
  return map;
}

export async function requestOzonProductAttributes(shop, productIds, options = {}) {
  const attributes = [];

  for (let index = 0; index < productIds.length; index += 100) {
    const chunk = productIds.slice(index, index + 100);
    if (chunk.length === 0) continue;
    const data = await requestOzonReadOnly(
      '/v4/product/info/attributes',
      shop,
      {
        filter: { product_id: chunk },
        limit: 1000,
      },
      { signal: options.signal }
    );
    attributes.push(...getOzonPayloadItems(data));
  }

  return attributes;
}

export async function requestOzonCategoryAttributeDefinitions(shop, descriptionCategoryId, typeId) {
  if (!descriptionCategoryId || !typeId) return [];
  const data = await requestOzonReadOnly('/v1/description-category/attribute', shop, {
    description_category_id: Number(descriptionCategoryId),
    type_id: Number(typeId),
    language: 'DEFAULT',
  });
  return getOzonPayloadItems(data);
}

export async function requestOzonProductPictures(shop, productIds, options = {}) {
  const pictures = [];

  for (let index = 0; index < productIds.length; index += 100) {
    const chunk = productIds.slice(index, index + 100);
    if (chunk.length === 0) continue;
    const data = await requestOzonReadOnly(
      '/v2/product/pictures/info',
      shop,
      {
        product_id: chunk,
      },
      { signal: options.signal }
    );
    pictures.push(...getOzonPayloadItems(data));
  }

  return pictures;
}

export async function requestOzonProductPrices(shop, productIds, options = {}) {
  const prices = [];

  for (let index = 0; index < productIds.length; index += 100) {
    const chunk = productIds.slice(index, index + 100);
    if (chunk.length === 0) continue;
    const data = await requestOzonReadOnly(
      '/v5/product/info/prices',
      shop,
      {
        filter: { product_id: chunk },
        limit: 1000,
      },
      { signal: options.signal }
    );
    prices.push(...getOzonPayloadItems(data));
  }

  return prices;
}

export async function requestOzonProductStocks(shop, productIds, options = {}) {
  const stocks = [];

  for (let index = 0; index < productIds.length; index += 100) {
    const chunk = productIds.slice(index, index + 100);
    if (chunk.length === 0) continue;
    const data = await requestOzonReadOnly(
      '/v4/product/info/stocks',
      shop,
      {
        filter: { product_id: chunk },
        limit: 1000,
      },
      { signal: options.signal }
    );
    stocks.push(...getOzonPayloadItems(data));
  }

  return stocks;
}

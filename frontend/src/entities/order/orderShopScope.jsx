import { formatLocalChineseDate } from '../../shared/lib/dateTimeFormat.js';
import { normalizeSalesOrderDateFilter } from './orderDateRules.jsx';
import { getOzonOrderDateRange as getOzonOrderDateRangeSafe } from '../../services/ozonOrderSafety';
import {
  defaultOzonShops,
  OZON_INITIAL_ORDER_QUICK_RANGE_DAYS,
} from '../../shared/config/appConfigCore.jsx';
import { getOzonLocalUniqueValues } from '../product/productLocalData.jsx';
import {
  getOzonGenerationAwareShopSourceKey,
  getOzonLegacyClientGenerationAwareShopSourceKey,
  hasCompleteOzonShopGeneration,
} from '../../shared/ozon/ozonShopGeneration.js';
export {
  MARKETING_ACTIVITY_CACHE_PRODUCT_FIELDS,
  buildFastMarketingSummary,
  fenceAndDrainMarketingActivityViewStateWrites,
  filterOnlineMarketingActivities,
  findMarketingActivityByIdentity,
  flushMarketingActivityViewStateWritesForTest,
  getMarketingActivityCache,
  getMarketingActivityCacheKey,
  getMarketingActivityDateRange,
  getMarketingActivityIdentity,
  getMarketingActivityIdentityKey,
  getMarketingActivityLocalCache,
  getMarketingActivityViewStateFenceStatus,
  isMarketingActivityOnline,
  isMarketingActivityOwnerFenced,
  isSameMarketingActivity,
  marketingActivityRuntimeCacheStore,
  marketingActivityViewStateWriteQueue,
  mergeMarketingActivityCache,
  normalizeMarketingActivitySourceType,
  normalizeMarketingCacheActivity,
  normalizeMarketingCacheProduct,
  normalizeMarketingCacheSnapshot,
  parseMarketingActivityDateMs,
  pickMarketingCacheFields,
  releaseMarketingActivityOwnerFence,
  rememberMarketingActivityCacheSnapshot,
  resolveMarketingActivitySelection,
  saveMarketingActivityCache,
} from "../marketing/marketingActivityCache.jsx";
export {
  buildMarketingProductPoolCacheResult,
  fixedMarketingActivityTitleById,
  formatMarketingActivityPrice,
  formatMarketingEstimate,
  formatMarketingProductActionPrice,
  formatMarketingStatValue,
  getMarketingProductIssue,
  getMarketingProductPoolCacheKey,
  getMarketingProductPoolSnapshotResult,
  getMarketingProgressValue,
  getMarketingStatResolvedValue,
  isMarketingMissingPrice,
  isMarketingOutOfStock,
  normalizeMarketingPercent,
  parseMarketingNumber,
} from "../marketing/marketingActivityDisplay.jsx";
export {
  getMarketingActivitySnapshotDigest,
  getMarketingActivitySnapshotSemanticDto,
  migrateLegacyMarketingActivityCacheStore,
} from "../marketing/marketingActivityLegacyMigration.jsx";

export function getMarketingProductOfferDisplay(product = {}) {
  const raw = product.raw || {};
  const productId = firstUsableOzonId(product.productId, product.product_id, raw.product_id, raw.productId, product.id);
  const offerId = firstUsableOzonId(product.offerId, product.offer_id, raw.offer_id, raw.offerId);
  return offerId && offerId !== productId ? offerId : '待补水';
}

export function getMarketingProductSkuDisplay(product = {}) {
  const raw = product.raw || {};
  const productId = firstUsableOzonId(product.productId, product.product_id, raw.product_id, raw.productId, product.id);
  const ozonSku = firstUsableOzonId(
    product.ozonSku,
    product.ozon_sku,
    product.skuId,
    raw.ozonSku,
    raw.ozon_sku,
    raw.sku,
    product.sku
  );
  return ozonSku && ozonSku !== productId ? ozonSku : '待补水';
}

export function getOzonPayloadOptionalTotal(data) {
  const candidates = [
    data?.total,
    data?.result?.total,
    data?.result?.total_count,
    data?.total_count,
    data?.count,
    data?.result?.count,
  ];
  const total = candidates.find(
    (value) => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))
  );
  return total === undefined ? null : Number(total);
}

export function getOzonPayloadHasNext(data) {
  const candidates = [data?.has_next, data?.hasNext, data?.result?.has_next, data?.result?.hasNext];
  const value = candidates.find((item) => item !== undefined && item !== null && item !== '');
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^true$/i.test(value)) return true;
    if (/^false$/i.test(value)) return false;
  }
  return null;
}

export function normalizeOzonId(value) {
  if (value === undefined || value === null || value === '') return '';
  return String(value);
}

export const ozonProtectedOrderOperations = {
  cancelOrder: { endpoint: '/v1/order/cancel', endpointKey: 'orders.cancelOrder', title: '取消订单' },
  createOrder: { endpoint: '/v2/order/create', endpointKey: 'orders.createOrder', title: '创建订单' },
  cancelFboPosting: {
    endpoint: '/v1/posting/cancel',
    endpointKey: 'orders.cancelFboPosting',
    title: '取消 FBO 发货单',
  },
  cancelFbsPosting: {
    endpoint: '/v2/posting/fbs/cancel',
    endpointKey: 'orders.cancelFbsPosting',
    title: '取消 FBS 发货单',
  },
  cancelFbsProduct: {
    endpoint: '/v2/posting/fbs/product/cancel',
    endpointKey: 'orders.cancelFbsProduct',
    title: '取消 FBS 部分商品发货',
  },
  setFbsAwaitingDelivery: {
    endpoint: '/v2/posting/fbs/awaiting-delivery',
    endpointKey: 'orders.setFbsAwaitingDelivery',
    title: '提交 FBS 等待交付',
  },
  shipFbsPosting: {
    endpoint: '/v4/posting/fbs/ship',
    endpointKey: 'orders.shipFbsPosting',
    title: '确认 FBS/rFBS 发货',
  },
  shipFbsPackage: {
    endpoint: '/v4/posting/fbs/ship/package',
    endpointKey: 'orders.shipFbsPackage',
    title: '确认多包裹发货',
  },
  createFbsPackageLabel: {
    endpoint: '/v2/posting/fbs/package-label/create',
    endpointKey: 'orders.createFbsPackageLabel',
    title: '创建 FBS 面单任务',
  },
  getFbsPackageLabel: {
    endpoint: '/v1/posting/fbs/package-label/get',
    endpointKey: 'orders.getFbsPackageLabel',
    title: '获取 FBS 面单文件',
  },
  splitFbsPosting: {
    endpoint: '/v1/posting/fbs/split',
    endpointKey: 'orders.splitFbsPosting',
    title: '拆分 FBS 发货单',
  },
  splitTraceableFbsPosting: {
    endpoint: '/v1/posting/fbs/traceable/split',
    endpointKey: 'orders.splitTraceableFbsPosting',
    title: '拆分可追溯发货单',
  },
  setMultiboxQty: {
    endpoint: '/v3/posting/multiboxqty/set',
    endpointKey: 'orders.setMultiboxQty',
    title: '设置多箱数量',
  },
  updateFbsExemplar: {
    endpoint: '/v1/fbs/posting/product/exemplar/update',
    endpointKey: 'orders.updateFbsExemplar',
    title: '更新商品实例/标记码',
  },
  setFbsExemplar: {
    endpoint: '/v6/fbs/posting/product/exemplar/set',
    endpointKey: 'orders.setFbsExemplar',
    title: '保存商品实例/标记码',
  },
  createOrGetFbsExemplar: {
    endpoint: '/v6/fbs/posting/product/exemplar/create-or-get',
    endpointKey: 'orders.createOrGetFbsExemplar',
    title: '创建或读取商品实例/标记码',
  },
  createCarriage: { endpoint: '/v1/carriage/create', title: '创建 FBS 交接批次' },
  approveCarriage: { endpoint: '/v1/carriage/approve', title: '确认 FBS 交接' },
  setCarriagePostings: { endpoint: '/v1/carriage/set-postings', title: '修改交接批次发货单' },
  cancelCarriage: { endpoint: '/v1/carriage/cancel', title: '取消 FBS 交接批次' },
  createFbsAct: { endpoint: '/v2/posting/fbs/act/create', title: '确认 FBS 发货并生成交接文件' },
  setRfbsTimeslot: { endpoint: '/v1/posting/fbs/timeslot/set', title: '修改 rFBS 配送日期' },
  setPostingCutoff: { endpoint: '/v1/posting/cutoff/set', title: '调整发货截止时间' },
  setRfbsTrackingNumber: { endpoint: '/v2/fbs/posting/tracking-number/set', title: '添加 rFBS 物流追踪号' },
  setRfbsDelivering: { endpoint: '/v2/fbs/posting/delivering', title: '设置 rFBS 配送中' },
  setRfbsLastMile: { endpoint: '/v2/fbs/posting/last-mile', title: '设置 rFBS 最后一公里' },
  setRfbsDelivered: { endpoint: '/v2/fbs/posting/delivered', title: '设置 rFBS 已送达' },
  setFbsProductCountry: { endpoint: '/v2/posting/fbs/product/country/set', title: '设置商品生产国家' },
  setRfbsReturnAction: {
    endpoint: '/v1/returns/rfbs/action/set',
    domain: 'returns',
    endpointKey: 'returns.setRfbsReturnAction',
    title: '提交 rFBS 退货处理动作',
  },
  rejectRfbsReturn: {
    endpoint: '/v2/returns/rfbs/reject',
    domain: 'returns',
    endpointKey: 'returns.rejectRfbsReturn',
    title: '拒绝 rFBS 退货',
  },
  compensateRfbsReturn: {
    endpoint: '/v2/returns/rfbs/compensate',
    domain: 'returns',
    endpointKey: 'returns.compensateRfbsReturn',
    title: 'rFBS 部分退款或补偿',
  },
  verifyRfbsReturn: {
    endpoint: '/v2/returns/rfbs/verify',
    domain: 'returns',
    endpointKey: 'returns.verifyRfbsReturn',
    title: '同意 rFBS 退货',
  },
  receiveRfbsReturn: {
    endpoint: '/v2/returns/rfbs/receive-return',
    domain: 'returns',
    endpointKey: 'returns.receiveRfbsReturn',
    title: '确认收到退货并检查',
  },
  refundRfbsReturn: {
    endpoint: '/v2/returns/rfbs/return-money',
    domain: 'returns',
    endpointKey: 'returns.refundRfbsReturn',
    title: '给买家退款',
  },
  approveConditionalCancellation: {
    endpoint: '/v2/conditional-cancellation/approve',
    domain: 'returns',
    endpointKey: 'returns.approveConditionalCancellation',
    title: '同意 rFBS 条件取消',
  },
  rejectConditionalCancellation: {
    endpoint: '/v2/conditional-cancellation/reject',
    domain: 'returns',
    endpointKey: 'returns.rejectConditionalCancellation',
    title: '拒绝 rFBS 条件取消',
  },
};

export const crossBorderProtectedOrderOperations = {
  createOrder: {
    endpoint: '/erpapi/order/createOrder',
    endpointKey: 'orders.createOrder',
    title: '创建跨境巴士预报订单',
  },
  updateOrder: { endpoint: '/erpapi/order/updateOrder', title: '更新跨境巴士订单' },
  updateOrderSheet: { endpoint: '/erpapi/order/updateOrderSheet', title: '更新跨境巴士面单' },
  updateOrderPackage: { endpoint: '/erpapi/order/updateOrderPackage', title: '更新跨境巴士包裹' },
  cancelOrder: { endpoint: '/erpapi/order/cancelOrder', endpointKey: 'orders.cancelOrder', title: '废弃跨境巴士订单' },
  syncOrderStatus: { endpoint: '/erpapi/ordersync/order_update', title: '同步跨境巴士平台订单状态' },
  associateOrder: { endpoint: '/erpapi/orderassociation/association_order_account', title: '关联跨境巴士平台订单' },
};

export function getActiveOzonShop(shops = [], activeShopId) {
  const safeShops = Array.isArray(shops) && shops.length ? shops : defaultOzonShops;
  return safeShops.find((shop) => shop.id === activeShopId) ?? safeShops[0] ?? null;
}

export function canUseOzonShop(shop) {
  const clientId = String(shop?.clientId || '').trim();
  const apiKey = String(shop?.apiKey || '').trim();
  const shopId = String(shop?.id || shop?.shopId || '').trim();
  const hasClientId = Boolean(clientId || shop?.hasClientId === true);
  const hasApiKey = Boolean(apiKey || shop?.hasApiKey === true);
  // Runtime shop objects carry an explicit server-verified card state.  Once
  // that marker exists, credentials alone never make a shop readable.  Older
  // pure helpers/tests without the runtime marker keep their historical
  // credential-only behavior; App marks every real shop as `checking` before
  // any business page or hot-cache task receives it.
  const authorizationStatus = String(shop?.licenseAuthorizationStatus || '').trim();
  const authorizationVerified = !authorizationStatus
    || (authorizationStatus === 'active' && shop?.licenseAuthorized === true);
  return Boolean(
    authorizationVerified
    && (shopId || clientId)
    && hasClientId
    && hasApiKey
  );
}

export function getOzonShopLabel(shop) {
  return shop?.shopAlias || shop?.sellerName || 'Ozon 店铺';
}

export function getOzonShopClientId(shop) {
  return String(shop?.clientId || '').trim();
}

export function getOzonReadableShops(shops = []) {
  return (Array.isArray(shops) ? shops : []).filter(canUseOzonShop);
}

export function getOzonStableShopSourceKey(shop) {
  return getOzonGenerationAwareShopSourceKey(shop);
}

export function getOzonShopSelectionId(shop = {}) {
  return String(shop?.id || shop?.shopId || shop?.shop_id || '').trim();
}

/**
 * All renderer identities that may legitimately describe one configured
 * shop. Order snapshots created by older builds can contain a client id,
 * label or generation-aware key instead of the current local `shops.id`.
 * Client-side order filters must query the whole unambiguous identity set.
 */
export function getOzonConfiguredShopScopeValues(shop = {}, shops = []) {
  const shopIds = getOzonLocalUniqueValues([shop?.id, shop?.shopId, shop?.shop_id]);
  const shopClientIds = getOzonLocalUniqueValues([
    shop?.clientId,
    shop?.client_id,
    shop?.shopClientId,
    shop?.shop_client_id,
  ]);
  const shopLabel = String(getOzonShopLabel(shop) || '').trim();
  const configuredShops = Array.isArray(shops) ? shops.filter(Boolean) : [];
  const labelIsUnambiguous = !shopLabel || !configuredShops.length || configuredShops.filter(
    (candidate) => String(getOzonShopLabel(candidate) || '').trim() === shopLabel
  ).length === 1;
  return getOzonLocalUniqueValues([
    ...shopIds,
    ...shopClientIds,
    labelIsUnambiguous ? shopLabel : '',
    getOzonStableShopSourceKey(shop),
    getOzonLegacyClientGenerationAwareShopSourceKey(shop),
    ...shopIds.map((shopId) => `ozon-shop:id:${shopId}`),
    ...shopClientIds.map((shopClientId) => `ozon-shop:client:${shopClientId}`),
    labelIsUnambiguous && shopLabel ? `ozon-shop:label:${shopLabel}` : '',
  ]);
}

export function resolveOzonConfiguredShop(shops = [], selectedShop = '') {
  const selected = String(selectedShop ?? '').trim();
  if (!selected || selected === 'all') return null;
  const matches = (Array.isArray(shops) ? shops : []).filter((shop) =>
    getOzonConfiguredShopScopeValues(shop).includes(selected)
  );
  return matches.length === 1 ? matches[0] : null;
}

export function resolveOzonShopSelectionId(
  shops = [],
  selectedShop = '',
  { allValue = 'all', emptyValue = '' } = {}
) {
  const selected = String(selectedShop ?? '').trim();
  if (!selected || selected === allValue) return emptyValue;
  const matchedShop = resolveOzonConfiguredShop(shops, selected);
  return matchedShop ? getOzonShopSelectionId(matchedShop) || selected : selected;
}

export function getOzonShopScopeForSelection(shops = [], selectedShop = '', { allValue = 'all' } = {}) {
  const selected = String(selectedShop ?? '').trim();
  if (!selected || selected === allValue) return allValue;
  const matchedShop = resolveOzonConfiguredShop(shops, selected);
  return matchedShop ? getOzonConfiguredShopScopeValues(matchedShop, shops) : selected;
}

export function getOzonRowShopScopeValues(row = {}) {
  const shopClientIds = getOzonLocalUniqueValues([
    row.shopClientId,
    row.shop_client_id,
    row.clientId,
    row.client_id,
  ]);
  const shopIds = getOzonLocalUniqueValues([row.shopId, row.shop_id]);
  const shopLabel = String(row.shop || row.shopName || row.storeName || '').trim();
  return [
    ...shopClientIds,
    ...shopIds,
    shopLabel,
    row.shopName,
    row.shop_name,
    row.storeName,
    row.store_name,
    ...shopClientIds.map((shopClientId) => `ozon-shop:client:${shopClientId}`),
    ...shopIds.map((shopId) => `ozon-shop:id:${shopId}`),
    shopLabel ? `ozon-shop:label:${shopLabel}` : '',
  ];
}

export function attachOzonShopIdentityToRow(row = {}, shops = []) {
  if (!row || typeof row !== 'object') return row;
  const readableShops = getOzonReadableShops(shops);
  if (!readableShops.length) return row;

  const rowClientId = String(
    row.shopClientId || row.shop_client_id || row.clientId || row.client_id || ''
  ).trim();
  const rowShopId = String(row.shopId || row.shop_id || '').trim();
  const rowLabel = String(firstFilled(row.shop, row.shopName, row.shop_name, row.storeName, row.store_name) || '').trim();
  const matchedByClient = rowClientId ? readableShops.find((shop) => getOzonShopClientId(shop) === rowClientId) : null;
  const matchedById = rowShopId ? readableShops.find((shop) => String(shop.id || '').trim() === rowShopId) : null;
  const labelMatches = rowLabel ? readableShops.filter((shop) => getOzonShopLabel(shop) === rowLabel) : [];
  // The internal shop id is the canonical owner. Client-Id and labels are
  // compatibility hints only and may be stale after a delete/rebind cycle.
  const matchedShop = matchedById || matchedByClient || (labelMatches.length === 1 ? labelMatches[0] : null);
  if (!matchedShop) return row;

  const shopClientId = getOzonShopClientId(matchedShop);
  const shopId = String(matchedShop.id || '').trim();
  const shopLabel = getOzonShopLabel(matchedShop);
  return {
    ...row,
    shop: shopLabel,
    shopName: shopLabel,
    shop_name: shopLabel,
    storeName: shopLabel,
    store_name: shopLabel,
    shopId,
    shop_id: shopId,
    shopClientId,
    shop_client_id: shopClientId,
    clientId: shopClientId,
    client_id: shopClientId,
    shopIncarnation: row.shopIncarnation || matchedShop.shopIncarnation || '',
    credentialRevision: row.credentialRevision || matchedShop.credentialRevision || 0,
  };
}

export function getOzonLegacyShopSourceKey(shop) {
  return `${shop?.id || ''}:${getOzonShopClientId(shop)}`;
}

export function getOzonSnapshotSourceKey(source) {
  const sources = Array.isArray(source) ? source : [source];
  return sources.filter(Boolean).map(getOzonStableShopSourceKey).sort().join('|');
}

export function getOzonLegacySnapshotSourceKey(source) {
  const sources = Array.isArray(source) ? source : [source];
  return sources.filter(Boolean).map(getOzonLegacyShopSourceKey).join('|');
}

export function getOzonSnapshotSourceKeyCandidates(source) {
  const sources = (Array.isArray(source) ? source : [source]).filter(Boolean);
  return getOzonLocalUniqueValues([
    getOzonSnapshotSourceKey(sources),
    sources.map(getOzonLegacyClientGenerationAwareShopSourceKey).sort().join('|'),
    ...(sources.some(hasCompleteOzonShopGeneration) ? [] : [getOzonLegacySnapshotSourceKey(sources)]),
  ]);
}

export function canUseOzonSnapshotSource(source) {
  return Array.isArray(source) ? source.some(canUseOzonShop) : canUseOzonShop(source);
}

export function getOzonShopForOrder(order, shops = [], fallback = null) {
  if (!order) return fallback;
  const orderShopId = String(order.shopId || '').trim();
  const orderClientId = String(order.shopClientId || '').trim();
  return (
    shops.find((shop) => orderShopId && shop.id === orderShopId) ??
    shops.find((shop) => orderClientId && getOzonShopClientId(shop) === orderClientId) ??
    fallback
  );
}

export function firstFilled(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

export function firstUsableOzonId(...values) {
  for (const value of values) {
    const text = normalizeOzonId(value).trim();
    if (text && text !== '-' && text !== '未返回') return text;
  }
  return '';
}

export function formatOzonOrderDate(value, fallback = '未返回') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return formatLocalChineseDate(date, true);
}

export function formatOzonOrderDateTime(value, fallback = '未返回') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`;
}

export function formatLocalDateKey(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function getOzonOrderDateRange(days = OZON_INITIAL_ORDER_QUICK_RANGE_DAYS, now = new Date()) {
  return getOzonOrderDateRangeSafe(days, now);
}

export function normalizeCacheScopeToken(value) {
  return (
    String(value || 'all')
      .trim()
      .replace(/[^a-zA-Z0-9._:-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'all'
  );
}

export function toOzonDateBoundaryIso(dateKey, endOfDay = false) {
  if (!dateKey) return '';
  const match = String(dateKey).match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return '';
  const boundaryMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    - 8 * 60 * 60 * 1000
    + (endOfDay ? 24 * 60 * 60 * 1000 - 1 : 0);
  const date = new Date(boundaryMs);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export function resolveOzonTimeRange(input = {}, defaultDays = OZON_INITIAL_ORDER_QUICK_RANGE_DAYS) {
  const directRange = input.apiRange || input.dateRange || input.timeRange || input;
  const directSince = firstFilled(
    directRange?.since,
    directRange?.from,
    directRange?.date_from,
    directRange?.created_since
  );
  const directTo = firstFilled(directRange?.to, directRange?.date_to, directRange?.created_to);
  if (directSince && directTo) {
    return { since: String(directSince), to: String(directTo) };
  }

  const startDateKey = normalizeSalesOrderDateFilter(firstFilled(input.startDate, input.start, input.dateFrom));
  const endDateKey = normalizeSalesOrderDateFilter(firstFilled(input.endDate, input.end, input.dateTo));
  const defaultRange = getOzonOrderDateRange(defaultDays, input.now);
  return {
    since: toOzonDateBoundaryIso(startDateKey, false) || defaultRange.since,
    to: toOzonDateBoundaryIso(endDateKey, true) || defaultRange.to,
  };
}

export function createOzonTimeRangeScope(options = {}) {
  const defaultDays = options.defaultDays ?? OZON_INITIAL_ORDER_QUICK_RANGE_DAYS;
  const explicitStartDateKey = normalizeSalesOrderDateFilter(
    firstFilled(options.startDate, options.start, options.dateFrom)
  );
  const explicitEndDateKey = normalizeSalesOrderDateFilter(
    firstFilled(options.endDate, options.end, options.dateTo)
  );
  const apiRange = resolveOzonTimeRange(options, defaultDays);
  const startDateKey =
    explicitStartDateKey ||
    formatLocalDateKey(apiRange.since) ||
    String(apiRange.since || '').slice(0, 10);
  const endDateKey =
    explicitEndDateKey ||
    formatLocalDateKey(apiRange.to) ||
    String(apiRange.to || '').slice(0, 10);
  const page = normalizeCacheScopeToken(options.page || options.module || 'shared');
  const filterScope = normalizeCacheScopeToken(options.filterScope || 'all');
  const version = normalizeCacheScopeToken(options.version || 'time-v1');
  return {
    page,
    filterScope,
    version,
    defaultDays,
    hasExplicitStartDate: Boolean(explicitStartDateKey),
    hasExplicitEndDate: Boolean(explicitEndDateKey),
    startDateKey,
    endDateKey,
    since: apiRange.since,
    to: apiRange.to,
    apiRange,
    cachePart: `${page}:range:${startDateKey || 'open'}_${endDateKey || 'open'}:filter:${filterScope}:v:${version}`,
  };
}

export function refreshOzonTimeRangeScope(scope = {}, now = new Date()) {
  if (scope?.hasExplicitEndDate) return scope;
  return createOzonTimeRangeScope({
    page: scope?.page,
    filterScope: scope?.filterScope,
    version: scope?.version,
    startDate: scope?.hasExplicitStartDate ? scope.startDateKey : '',
    endDate: '',
    defaultDays: scope?.defaultDays,
    now,
  });
}

export function getExplicitOzonTimeRange(options = {}) {
  const directRange = options.apiRange || options.dateRange || options.timeRange || options.timeScope || options;
  const directSince = firstFilled(
    directRange?.since,
    directRange?.from,
    directRange?.date_from,
    directRange?.created_since
  );
  const directTo = firstFilled(directRange?.to, directRange?.date_to, directRange?.created_to);
  if (directSince && directTo) return resolveOzonTimeRange(directRange);

  const startDateKey = normalizeSalesOrderDateFilter(firstFilled(options.startDate, options.start, options.dateFrom));
  const endDateKey = normalizeSalesOrderDateFilter(firstFilled(options.endDate, options.end, options.dateTo));
  if (startDateKey && endDateKey) return resolveOzonTimeRange(options);

  return null;
}

export function appendOzonSnapshotScopeKey(baseKey, scope = null) {
  const cachePart = typeof scope === 'string' ? scope : scope?.cachePart;
  return cachePart ? `${baseKey}:${normalizeCacheScopeToken(cachePart)}` : baseKey;
}

export function appendLegacyOzonDateRangeToSnapshotKey(baseKey, dateRange = null) {
  const text = String(baseKey || '').trim();
  if (!text || !dateRange) return text;
  const range = resolveOzonTimeRange(dateRange);
  const sinceKey = String(range.since || '').slice(0, 10);
  const toKey = String(range.to || '').slice(0, 10);
  return sinceKey && toKey ? `${text}:range:${sinceKey}:${toKey}` : text;
}

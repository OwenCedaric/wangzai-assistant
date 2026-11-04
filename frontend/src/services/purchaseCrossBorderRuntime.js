import {
  assertFbsSalesOrder,
  requestProtectedOzonOrderOperation,
} from '../entities/marketing/marketingOrderFields.jsx';
import {
  canUseOzonShop,
  firstFilled,
  firstUsableOzonId,
  normalizeOzonId,
} from '../entities/order/orderShopScope.jsx';
import {
  getCrossBorderStoreForPurchaseOrder,
  getPurchaseCrossBorderProducts,
} from '../entities/order/crossBorderPackageRules.jsx';
import {
  canUseCrossBorderOrderOutInfoRead,
  getCrossBorderLocalApiAccountId,
  requestCrossBorderOrderSearch,
  requestCrossBorderReadOnly,
  requestPurchaseOrderOutInfo,
} from '../entities/order/crossBorderOrderApi.jsx';
import {
  getProductSourceLinkKey,
  getProductSourceRecordFromLinks,
  normalizeProductSourceRecord,
} from '../entities/order/orderSourceLinks.jsx';
import {
  getCrossBorderPayloadObject,
  normalizeCrossBorderOrderInfo,
} from '../entities/order/orderSourceLinkFields.jsx';
import { compactObject, safeImageUrl } from '../entities/product/productWriteHelpers.jsx';
import {
  getOzonDeliveryMethodItems,
  normalizeOzonDeliveryMethod,
  requestOzonReadOnlyVariants,
} from '../entities/product/productOzonApi.jsx';
import { getCrossBorderPayload, normalizeCrossBorderServices } from '../shared/ozon/ozonRuntime.jsx';
import { readCrossBorderEndpoint } from './crossBorderReadClient.js';
import { normalizeProductBusMatchValue } from './productBusMaterialService';
import { getPurchaseOrderKeys } from './purchaseOrderRuntime.js';
import {
  getLogisticsFreightForPurchaseOrder,
  getOzonPostingFamilyKey,
  getPurchaseOrderVolumeItems,
} from './purchaseLogisticsRuntime.js';
import {
  appendUniqueText,
  getCrossBorderSheetInfo,
  getNormalizedDeliveryRouteLine,
  getOzonDeliveryMethodIdFromPosting,
  getOzonPostingDetailPayload,
  getPurchaseCrossBorderStrictOrderId,
  getPurchaseOrderDisplayOrderId,
  getPurchaseOrderOzonMainImageUrl,
  getPurchaseOrderSkuImageUrl,
} from './purchaseImageRuntime.js';

export { getOzonPostingFamilyKey };

export function appendUniqueRouteLine(target, value) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text === '未返回') return;
  const normalized = getNormalizedDeliveryRouteLine(text);
  if (!normalized) return;
  if (target.some((item) => getNormalizedDeliveryRouteLine(item) === normalized)) return;
  target.push(text);
}

export function formatOzonDeliveryRouteText(...values) {
  const lines = [];
  const fragments = values
    .flatMap((value) => String(value || '').split(/\n+/))
    .map((value) => value.trim())
    .filter(Boolean);

  fragments.forEach((fragment) => {
    const englishMatches =
      fragment.match(/GUOO\s+[A-Za-z\s]+?(?:Extra Small|Small|Big|Budget|Premium Small|Premium Big)/gi) || [];
    englishMatches.forEach((match) => appendUniqueRouteLine(lines, match));
  });

  fragments.forEach((fragment) => {
    const withoutEnglish = fragment
      .replace(/GUOO\s+[A-Za-z\s]+?(?:Extra Small|Small|Big|Budget|Premium Small|Premium Big)/gi, ' ')
      .trim();
    if (!withoutEnglish) return;
    withoutEnglish
      .split(/\s{2,}|[;；]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => appendUniqueRouteLine(lines, item));
  });

  return lines.join('\n');
}

export function getOzonDeliveryRouteTextFromPosting(source = {}) {
  const payload = getOzonPostingDetailPayload(source);
  const deliveryMethod = payload?.delivery_method ?? payload?.deliveryMethod ?? payload?.delivery ?? {};
  const analytics = payload?.analytics_data ?? payload?.analyticsData ?? {};
  const values = [];

  [
    deliveryMethod.name,
    deliveryMethod.delivery_method_name,
    deliveryMethod.deliveryMethodName,
    deliveryMethod.method_name,
    deliveryMethod.methodName,
    deliveryMethod.title,
    deliveryMethod.provider_name,
    deliveryMethod.providerName,
    deliveryMethod.delivery_type,
    deliveryMethod.deliveryType,
    payload.delivery_method_name,
    payload.deliveryMethodName,
    payload.provider_name,
    payload.providerName,
    payload.tpl_provider_name,
    payload.tplProviderName,
    payload.delivery_type,
    payload.deliveryType,
    payload.delivery_schema,
    analytics.delivery_method_name,
    analytics.deliveryMethodName,
    analytics.delivery_method,
    analytics.deliveryMethod,
    analytics.delivery_type,
    analytics.deliveryType,
    analytics.provider_name,
    analytics.providerName,
    analytics.tpl_provider_name,
    analytics.tplProviderName,
    analytics.warehouse_name,
    analytics.warehouseName,
  ].forEach((value) => appendUniqueText(values, value));

  return values.join(' ');
}

export function findOzonDeliveryMethodById(methods = [], deliveryMethodId = '') {
  const targetId = normalizeOzonId(deliveryMethodId).trim();
  if (!targetId) return null;
  return (
    methods.find((method) => normalizeOzonId(method.rawId).trim() === targetId) ??
    methods.find((method) => normalizeOzonId(method.id).trim() === targetId) ??
    methods.find((method) => normalizeOzonId(method.raw?.delivery_method_id).trim() === targetId) ??
    methods.find((method) => normalizeOzonId(method.raw?.deliveryMethodId).trim() === targetId) ??
    null
  );
}

export async function requestOzonDeliveryMethodTextById(shop, deliveryMethodId) {
  if (!canUseOzonShop(shop) || !deliveryMethodId) return '';
  const data = await requestOzonReadOnlyVariants('/v2/delivery-method/list', shop, [
    { limit: 100, filter: { delivery_method_id: [deliveryMethodId] } },
    { limit: 100, filter: {} },
    { limit: 100 },
  ]);
  const methods = getOzonDeliveryMethodItems(data).map(normalizeOzonDeliveryMethod);
  const method = findOzonDeliveryMethodById(methods, deliveryMethodId);
  if (!method) return '';

  const values = [];
  [method.name, method.type].forEach((value) => appendUniqueText(values, value));
  return values.join(' ');
}

export async function requestPurchaseOrderOzonDeliveryRoute(shop, order = {}) {
  if (!canUseOzonShop(shop)) return null;
  const postingNumber = firstUsableOzonId(
    order.salesOrder,
    order.shipmentNo,
    order.id,
    order.sourceOrder?.posting,
    order.sourceOrder?.id,
    order.raw?.posting_number,
    order.raw?.postingNumber
  );
  if (!postingNumber) return null;

  const fulfillmentText = String(
    firstFilled(order.fulfillment, order.sourceOrder?.fulfillment, order.channel)
  ).toUpperCase();
  if (fulfillmentText.includes('FBO')) return null;

  const data = await requestOzonReadOnlyVariants('/v3/posting/fbs/get', shop, [
    {
      posting_number: postingNumber,
      translit: true,
      with: {
        analytics_data: true,
        barcodes: true,
        financial_data: true,
        related_postings: true,
        translit: true,
      },
    },
    {
      posting_number: postingNumber,
      translit: true,
      with: {
        analytics_data: true,
        translit: true,
      },
    },
    { posting_number: postingNumber, translit: true },
    { posting_number: postingNumber },
  ]);
  const posting = getOzonPostingDetailPayload(data);
  const deliveryMethodId = getOzonDeliveryMethodIdFromPosting(posting);
  const routeTextFromPosting = getOzonDeliveryRouteTextFromPosting(posting);
  const routeTextFromMethod = deliveryMethodId
    ? await requestOzonDeliveryMethodTextById(shop, deliveryMethodId).catch(() => '')
    : '';
  const deliveryMethod = formatOzonDeliveryRouteText(routeTextFromMethod, routeTextFromPosting);

  return deliveryMethod
    ? {
        deliveryMethod,
        logistics: deliveryMethod,
        deliveryMethodId,
      }
    : null;
}

export function hasCrossBorderVerifiedSheet(item = {}) {
  const sheet = getCrossBorderSheetInfo(item);
  return Boolean(sheet.sheetOrderSn || sheet.sheetUrl);
}

export function getPurchaseOrderShop(shops = [], order = {}, fallbackShop = null) {
  const safeShops = Array.isArray(shops) ? shops : [];
  const shopId = normalizeOzonId(order.shopId).trim();
  const shopClientId = normalizeOzonId(order.shopClientId).trim();
  if (shopId) {
    return safeShops.find((shop) => normalizeOzonId(shop.id).trim() === shopId) ?? null;
  }
  if (shopClientId) {
    return safeShops.find((shop) => normalizeOzonId(shop.clientId).trim() === shopClientId) ?? null;
  }
  const fallbackId = normalizeOzonId(fallbackShop?.id).trim();
  if (fallbackId) {
    return safeShops.find((shop) => normalizeOzonId(shop.id).trim() === fallbackId) ?? null;
  }
  return safeShops.length === 1 ? safeShops[0] : null;
}

export function getFriendlyPurchaseOperationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\/erpapi\/[^\s，。；:：]+/g, '跨境巴士')
    .replace(/\/v\d+\/[^\s，。；:：]+/g, 'Ozon')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
}

export function getPurchaseOrderCrossBorderLookupKey(order = {}) {
  return [order.id, getPurchaseOrderDisplayOrderId(order), ...getPurchaseOrderKeys(order)].join('|');
}

export function areCrossBorderOrderKeysEquivalent(value = '', key = '') {
  const normalizedValue = normalizeProductBusMatchValue(value);
  const normalizedKey = normalizeProductBusMatchValue(key);
  if (!normalizedValue || !normalizedKey) return false;
  if (normalizedValue === normalizedKey) return true;
  const valueFamily = getOzonPostingFamilyKey(normalizedValue);
  const keyFamily = getOzonPostingFamilyKey(normalizedKey);
  return Boolean(valueFamily && keyFamily && valueFamily === keyFamily);
}

export function getPurchaseOrderCrossBorderSearchKeys(order = {}) {
  const keys = getPurchaseOrderKeys(order);
  const expandedKeys = keys.flatMap((key) => {
    const familyKey = getOzonPostingFamilyKey(key);
    return familyKey && familyKey !== normalizeProductBusMatchValue(key) ? [key, familyKey] : [key];
  });
  return expandedKeys.filter((value, index, values) => value && values.indexOf(value) === index);
}

export function crossBorderOrderMatchesPurchaseKey(item = {}, key = '') {
  const normalizedKey = normalizeProductBusMatchValue(key);
  if (!normalizedKey) return false;
  const values = [
    item.id,
    item.order_id,
    item.orderId,
    item.platform_order,
    item.platformOrder,
    item.order_number,
    item.orderNumber,
    item.sheet_order_sn,
    item.sheetOrderNumber,
    item.logistics_order,
    item.logisticsOrder,
    item.trackingNumber,
    item.tracking_number,
    item.from_order,
    item.fromOrder,
  ];
  return values.some((value) => areCrossBorderOrderKeysEquivalent(value, normalizedKey));
}

export function pickCrossBorderMatchesByKey(items = [], key = '') {
  const matches = items.filter((item) => crossBorderOrderMatchesPurchaseKey(item, key));
  if (matches.length) return matches;
  return items.length === 1 ? items : [];
}

export async function findPurchaseCrossBorderOrders(settings = {}, order = {}) {
  const shopId = normalizeOzonId(order.shopId ?? order.shop_id).trim();
  const shopClientId = normalizeOzonId(order.shopClientId).trim();
  const shopScope = { shopId, shopClientId };
  const sourceOrder = order.sourceOrder ?? {};
  const existingOrderId = firstUsableOzonId(
    order.packageOrderId,
    order.crossBorderOrderId,
    sourceOrder.packageOrderId,
    sourceOrder.crossBorderOrderId,
  );

  if (existingOrderId) {
    const result = await requestCrossBorderOrderSearch(settings, { order_id: existingOrderId }, shopScope);
    const matches = pickCrossBorderMatchesByKey(result.items, existingOrderId);
    if (matches.length) return { items: matches, matchedKey: existingOrderId, matchedBy: 'order_id' };
  }

  const orderKey = firstUsableOzonId(
    order.returnNo,
    order.shipmentNo,
    order.salesOrder,
    order.ozonOrderId,
    sourceOrder.returnNo,
    sourceOrder.shipmentNo,
    sourceOrder.salesOrder,
    sourceOrder.ozonOrderId,
    getOzonPostingFamilyKey(order.id),
    order.id,
  );
  const purchaseOrderKey = firstUsableOzonId(
    order.purchaseOrderNo,
    sourceOrder.purchaseOrderNo,
  );
  const searches = [
    ...(orderKey
      ? [
          { field: 'order_number', key: orderKey },
          { field: 'platform_order', key: orderKey },
        ]
      : []),
    ...(purchaseOrderKey ? [{ field: 'from_order', key: purchaseOrderKey }] : []),
  ];
  for (const { field, key } of searches) {
    const result = await requestCrossBorderOrderSearch(settings, { [field]: key }, shopScope);
    const matches = pickCrossBorderMatchesByKey(result.items, key);
    if (matches.length) return { items: matches, matchedKey: key, matchedBy: field };
  }

  return { items: [], matchedKey: '', matchedBy: '' };
}

export async function requestPurchaseCrossBorderDetail(settings = {}, order = {}, ozonShop = null) {
  const found = await findPurchaseCrossBorderOrders(settings, order);
  const orderItem = found.items[0] ?? null;
  const orderId = getPurchaseCrossBorderStrictOrderId(orderItem) || getPurchaseOrderDisplayOrderId(order);
  if (!orderId) {
    return {
      orderId: '',
      orderItem: null,
      orderCount: 0,
      orderIds: [],
      matchedKey: found.matchedKey,
      message: '未查到预报订单',
      volumeItems: [],
    };
  }

  const ozonRoutePromise = canUseOzonShop(ozonShop)
    ? requestPurchaseOrderOzonDeliveryRoute(ozonShop, order).catch(() => null)
    : Promise.resolve(null);
  const shopScope = {
    shopId: normalizeOzonId(order.shopId ?? order.shop_id ?? ozonShop?.id).trim(),
    shopClientId: normalizeOzonId(order.shopClientId ?? ozonShop?.clientId).trim(),
  };
  const [statusPayload, outPayload, ozonRoute] = await Promise.all([
    requestCrossBorderReadOnly('/erpapi/orderlist/status', settings, { order_id: orderId }, shopScope).catch(() => null),
    requestPurchaseOrderOutInfo(settings, { ...order, packageOrderId: orderId }, orderId, shopScope).catch(() => null),
    ozonRoutePromise,
  ]);
  const remoteStatusInfo = statusPayload ? getCrossBorderPayloadObject(statusPayload) : {};
  const remoteOutInfo = outPayload ? getCrossBorderPayloadObject(outPayload) : {};
  const effectiveStatusPayload = Object.keys(remoteStatusInfo).length
    ? statusPayload
    : orderItem?.statusPayload ?? null;
  const effectiveOutPayload = Object.keys(remoteOutInfo).length
    ? outPayload
    : orderItem?.outPayload ?? null;
  const payloadVolumeItems = effectiveOutPayload ? getPurchaseOrderVolumeItems(effectiveOutPayload) : [];
  const volumeItems = payloadVolumeItems.length
    ? payloadVolumeItems
    : Array.isArray(orderItem?.volumeItems)
      ? orderItem.volumeItems
      : [];
  const info = normalizeCrossBorderOrderInfo(
    orderItem ?? { id: orderId },
    effectiveStatusPayload,
    effectiveOutPayload
  );
  const routeInfo = ozonRoute?.deliveryMethod
    ? {
        deliveryMethod: ozonRoute.deliveryMethod,
        logistics: ozonRoute.logistics || ozonRoute.deliveryMethod,
        deliveryMethodId: ozonRoute.deliveryMethodId || '',
      }
    : {};
  const orderIds = found.items.map(getPurchaseCrossBorderStrictOrderId).filter(Boolean);
  const sheetInfo = getCrossBorderSheetInfo(orderItem ?? {});
  const logisticsFreightResult = getLogisticsFreightForPurchaseOrder(order, { ...info, ...routeInfo, volumeItems });
  const logisticsFreight = logisticsFreightResult.ok ? logisticsFreightResult : null;

  return {
    ...info,
    ...routeInfo,
    orderId,
    orderItem,
    orderCount: found.items.length || 1,
    orderIds,
    matchedKey: found.matchedKey,
    matchedBy: found.matchedBy,
    sheetOrderSn: sheetInfo.sheetOrderSn,
    sheetUrl: sheetInfo.sheetUrl,
    message: volumeItems.length ? '已读取材积' : '已查到预报，未返回材积',
    volumeItems,
    logisticsFreight,
    guooFreight: logisticsFreight?.providerId === 'guoo' ? logisticsFreight : null,
    freightCostValue: logisticsFreight?.amount ?? null,
    freightCost: logisticsFreight?.display || '',
  };
}

export async function requestPurchaseCrossBorderDetailByOrderId(
  settings = {},
  order = {},
  orderId = '',
  ozonShop = null
) {
  const strictOrderId = firstUsableOzonId(orderId, getPurchaseOrderDisplayOrderId(order));
  if (!strictOrderId) return requestPurchaseCrossBorderDetail(settings, order, ozonShop);
  if (!canUseCrossBorderOrderOutInfoRead(settings)) {
    throw new Error('请先在设置里保存跨境巴士企业接口和账号授权。');
  }

  const ozonRoutePromise = canUseOzonShop(ozonShop)
    ? requestPurchaseOrderOzonDeliveryRoute(ozonShop, order).catch(() => null)
    : Promise.resolve(null);
  const shopScope = {
    shopId: normalizeOzonId(order.shopId ?? order.shop_id ?? ozonShop?.id).trim(),
    shopClientId: normalizeOzonId(order.shopClientId ?? ozonShop?.clientId).trim(),
  };
  const [searchPayload, statusPayload, outPayload, ozonRoute] = await Promise.all([
    requestCrossBorderOrderSearch(settings, { order_id: strictOrderId }, shopScope).catch(() => null),
    requestCrossBorderReadOnly('/erpapi/orderlist/status', settings, { order_id: strictOrderId }, shopScope).catch(() => null),
    requestPurchaseOrderOutInfo(
      settings,
      { ...order, packageOrderId: strictOrderId },
      strictOrderId,
      shopScope,
    ).catch(() => null),
    ozonRoutePromise,
  ]);
  const orderItem = Array.isArray(searchPayload?.items) ? searchPayload.items[0] ?? null : null;
  const volumeItems = outPayload ? getPurchaseOrderVolumeItems(outPayload) : [];
  const info = normalizeCrossBorderOrderInfo(orderItem ?? { id: strictOrderId }, statusPayload, outPayload);
  const crossBorderRoute = firstFilled(
    orderItem?.logistics,
    orderItem?.delivery_method,
    orderItem?.deliveryMethod,
    orderItem?.introduce,
  );
  const routeText = ozonRoute?.deliveryMethod || crossBorderRoute;
  const routeInfo = routeText
    ? {
        deliveryMethod: routeText,
        logistics: ozonRoute?.logistics || routeText,
        deliveryMethodId: ozonRoute?.deliveryMethodId || '',
      }
    : {};
  const logisticsFreightResult = getLogisticsFreightForPurchaseOrder(order, { ...info, ...routeInfo, volumeItems });
  const logisticsFreight = logisticsFreightResult.ok ? logisticsFreightResult : null;

  return {
    ...info,
    ...routeInfo,
    orderId: strictOrderId,
    orderItem: orderItem ?? { id: strictOrderId },
    orderCount: 1,
    orderIds: [strictOrderId],
    matchedKey: strictOrderId,
    matchedBy: 'order_id',
    message: volumeItems.length ? '已读取材积' : '已查到预报，未返回材积',
    volumeItems,
    logisticsFreight,
    guooFreight: logisticsFreight?.providerId === 'guoo' ? logisticsFreight : null,
    freightCostValue: logisticsFreight?.amount ?? null,
    freightCost: logisticsFreight?.display || '',
  };
}

export function normalizeCrossBorderOrderCreateResult(data = {}) {
  const payload = getCrossBorderPayload(data);
  const item =
    (Array.isArray(payload) ? payload[0] : null) ??
    (Array.isArray(payload?.list) ? payload.list[0] : null) ??
    (Array.isArray(payload?.order_list) ? payload.order_list[0] : null) ??
    getCrossBorderPayloadObject(data);
  return {
    orderId: getPurchaseCrossBorderStrictOrderId(item),
    orderNumber: firstUsableOzonId(item.order_number, item.orderNumber, item.platform_order, item.platformOrder),
    raw: data,
  };
}

export function getCrossBorderDuplicateOrderText(item = {}) {
  const orderId = getPurchaseCrossBorderStrictOrderId(item);
  const orderNumber = firstUsableOzonId(item.order_number, item.orderNumber, item.platform_order, item.platformOrder);
  return (
    [orderId ? `ID ${orderId}` : '', orderNumber ? `单号 ${orderNumber}` : ''].filter(Boolean).join('，') || '已有订单'
  );
}

export async function assertNoExistingPurchaseCrossBorderForecast(settings = {}, order = {}) {
  const found = await findPurchaseCrossBorderOrders(settings, order);
  if (!found.items.length) return found;
  if (found.items.length > 1) {
    throw new Error(`跨境巴士已查到 ${found.items.length} 个疑似预报订单，已停止重复预报，请先人工核对。`);
  }
  throw new Error(`跨境巴士已查到预报订单（${getCrossBorderDuplicateOrderText(found.items[0])}），已停止重复预报。`);
}

export function getPurchaseOrderDefaultCountry(order = {}) {
  const raw = order.raw ?? order.sourceOrder?.raw ?? {};
  const value = firstFilled(
    raw.analytics_data?.delivery_country,
    raw.analytics_data?.country,
    raw.country_code,
    raw.country,
    order.country
  );
  return value ? String(value).toUpperCase() : 'RU';
}

export function getPurchaseOperationInitialFields(_type = '', order = {}, crossBorderRead = {}, options = {}) {
  const orderId = crossBorderRead.orderId || getPurchaseOrderDisplayOrderId(order);
  const orderNumber =
    crossBorderRead.orderNumber ||
    firstUsableOzonId(
      crossBorderRead.orderItem?.order_number,
      crossBorderRead.orderItem?.platform_order,
      order.returnNo,
      order.shipmentNo,
      order.salesOrder,
      order.id
    );
  return {
    orderNumber,
    orderId,
    dataStatus: '1',
    country: getPurchaseOrderDefaultCountry(order),
    purchasePlatform: getPurchaseOrderDefaultPurchasePlatform(order, options),
    purchaseOrderNo: order.purchaseOrderNo || '',
    logisticsOrder: firstFilled(
      crossBorderRead.trackingNumber,
      crossBorderRead.tracking_number,
      crossBorderRead.logisticsOrder,
      crossBorderRead.logistics_order,
      crossBorderRead.orderItem?.trackingNumber,
      crossBorderRead.orderItem?.tracking_number,
      order.domesticTrackingNumber,
      order.purchaseTrackingNumber,
      order.trackingNumber,
      order.logisticsOrder,
      order.purchaseOverride?.domesticTrackingNumber,
      order.purchaseOverride?.trackingNumber,
    ) || '',
    logisticsCompany: firstFilled(
      crossBorderRead.carrierName,
      crossBorderRead.carrier,
      crossBorderRead.orderItem?.carrierName,
      crossBorderRead.orderItem?.carrier,
      order.domesticCourierCompany,
      order.purchaseCourierCompany,
      order.carrierName,
      order.purchaseOverride?.domesticCourierCompany,
      order.purchaseOverride?.carrierName,
    ) || '',
    packageQty: String(order.items || 1),
    packageDesc: order.product && order.product !== '未返回' ? order.product : order.productNo || '',
    sheetOrderSn: '',
    sheetUrl: '',
    routeRemark: getPurchaseCrossBorderRouteRemark(
      order,
      {},
      { routeText: crossBorderRead.deliveryMethod || crossBorderRead.logistics }
    ),
    remark: '',
  };
}

export { getCrossBorderStoreForPurchaseOrder };

export function getPurchasePlatformCode(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (!text) return '';
  if (text === '1688') return 1;
  if (text.includes('淘宝') || text === 'taobao') return 2;
  if (text.includes('天猫') || text === 'tmall') return 2;
  if (text.includes('拼多多') || text === 'pdd' || text === '3') return 3;
  const number = Number(value);
  return [1, 2, 3].includes(number) ? number : '';
}

export { getPurchaseCrossBorderProducts };

export function getPurchaseCrossBorderProductSourceRecord(order = {}, product = {}, options = {}) {
  const sourceLinks =
    options.productSourceLinks && typeof options.productSourceLinks === 'object' ? options.productSourceLinks : {};
  const legacySourceLinks =
    options.legacySourceLinks && typeof options.legacySourceLinks === 'object' ? options.legacySourceLinks : {};
  const sourceKey = getProductSourceLinkKey(product, {
    id: order.shopId || order.shopClientId || order.shop || 'default',
    clientId: order.shopClientId,
  });
  const legacyProductKey = normalizeOzonId(
    product.offerId || product.sku || product.productId || product.id || order.productNo || order.sku
  );
  const orderSourceRecords =
    order.manualSourceRecords && typeof order.manualSourceRecords === 'object' ? order.manualSourceRecords : {};

  const sharedRecord = getProductSourceRecordFromLinks(
    sourceLinks,
    product,
    {
      id: order.shopId || order.shopClientId || order.shop || 'default',
      clientId: order.shopClientId,
    },
    { productNo: order.productNo, sku: order.sku }
  );
  if (sharedRecord.links.length) return sharedRecord;

  const orderRecord = normalizeProductSourceRecord(
    orderSourceRecords[sourceKey] ??
      orderSourceRecords[legacyProductKey] ??
      (getPurchaseCrossBorderProducts(order).length <= 1 ? order.manualSourceRecord : {}) ??
      {}
  );
  if (orderRecord.links.length) return orderRecord;

  return normalizeProductSourceRecord(
    sourceLinks[sourceKey] ??
      sourceLinks[legacyProductKey] ??
      (getPurchaseCrossBorderProducts(order).length <= 1 ? legacySourceLinks[order.id] : {}) ??
      {}
  );
}

export function removePurchaseSourceRecordsFromOverrides(overrides = {}, orderKey = '', sourceKeys = []) {
  const safeOrderKey = String(orderKey || '').trim();
  const keySet = new Set(sourceKeys.map((key) => String(key || '').trim()).filter(Boolean));
  if (!safeOrderKey || keySet.size === 0) return { overrides, changed: false };

  const currentOverride = overrides?.[safeOrderKey];
  if (!currentOverride || typeof currentOverride !== 'object' || Array.isArray(currentOverride)) {
    return { overrides, changed: false };
  }

  const nextOverride = { ...currentOverride };
  let changed = false;
  if (nextOverride.manualSourceRecords && typeof nextOverride.manualSourceRecords === 'object') {
    const nextRecords = { ...nextOverride.manualSourceRecords };
    keySet.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(nextRecords, key)) {
        delete nextRecords[key];
        changed = true;
      }
    });
    if (Object.keys(nextRecords).length) {
      nextOverride.manualSourceRecords = nextRecords;
    } else {
      delete nextOverride.manualSourceRecords;
    }
  }
  if (Object.prototype.hasOwnProperty.call(nextOverride, 'manualSourceRecord')) {
    delete nextOverride.manualSourceRecord;
    changed = true;
  }
  if (!changed) return { overrides, changed: false };

  const nextOverrides = { ...(overrides && typeof overrides === 'object' ? overrides : {}) };
  if (Object.keys(nextOverride).length) {
    nextOverrides[safeOrderKey] = nextOverride;
  } else {
    delete nextOverrides[safeOrderKey];
  }
  return { overrides: nextOverrides, changed: true };
}

export function getPurchaseCrossBorderPrimarySourceEntry(order = {}, product = {}, options = {}) {
  const record = getPurchaseCrossBorderProductSourceRecord(order, product, options);
  return record.links[record.primaryIndex] ?? record.links[0] ?? {};
}

export function getPurchaseCrossBorderProductSku(order = {}, product = {}) {
  const raw = product.raw ?? {};
  return firstUsableOzonId(
    product.offerId,
    product.sku,
    raw.offer_id,
    raw.offerId,
    product.skuId,
    raw.sku,
    raw.sku_id,
    raw.skuId,
    order.productNo,
    order.offerId,
    order.sku
  );
}

export function getPurchaseCrossBorderProductQty(order = {}, product = {}) {
  const raw = product.raw ?? {};
  const qty = Number(firstFilled(product.qty, product.quantity, raw.quantity, raw.qty, raw.count, order.items, 1));
  return Number.isFinite(qty) && qty > 0 ? qty : 1;
}

export function getPurchaseCrossBorderProductImage(product = {}) {
  return (
    getPurchaseOrderSkuImageUrl(product) ||
    getPurchaseOrderOzonMainImageUrl(product) ||
    safeImageUrl(product.image) ||
    ''
  );
}

export function getPurchaseCrossBorderPackagePlatform(fields = {}, order = {}, product = {}, sourceEntry = {}) {
  const candidates = [
    sourceEntry.platform,
    product.purchasePlatform,
    product.buyerPlatform,
    product.sourcePlatform,
    product.source_platform,
    product.purchase_platform,
    order.buyerPlatform,
    order.manualBuyerPlatform,
    order.supplier,
    fields.purchasePlatform,
  ];
  for (const candidate of candidates) {
    const code = getPurchasePlatformCode(candidate);
    if (code) return code;
  }
  return '';
}

export function getPurchaseCrossBorderPackageOrderNo(fields = {}, order = {}, product = {}, sourceEntry = {}) {
  return String(
    firstFilled(
      sourceEntry.purchaseOrderNo,
      sourceEntry.purchase_order_no,
      sourceEntry.orderNo,
      sourceEntry.orderNumber,
      sourceEntry.order_id,
      sourceEntry.orderId,
      product.purchaseOrderNo,
      product.purchase_order_no,
      product.sourceOrderNo,
      product.source_order_no,
      order.purchaseOrderNo,
      order.manualPurchaseOrderNo,
      fields.purchaseOrderNo
    ) || ''
  ).trim();
}

export function getPurchaseCrossBorderPackageDescription(fields = {}, order = {}, product = {}, sourceEntry = {}) {
  return String(
    firstFilled(
      product.name,
      product.title,
      sourceEntry.title,
      sourceEntry.name,
      fields.packageDesc,
      order.product,
      order.productNo
    ) || ''
  ).trim();
}

export function getPurchaseCrossBorderRouteRemark(order = {}, fields = {}, options = {}) {
  const routeText = String(
    firstFilled(options.routeText, fields.routeRemark, order.deliveryMethod, order.logistics) || ''
  ).trim();
  const isGenericRoute = /^(ozon|fbs|rfbs|ozon\s+fbs|ozon\s+rfbs|未返回|路线待确认)$/i.test(routeText);
  if (routeText && !isGenericRoute) return normalizePurchaseRouteRemarkText(routeText);
  return normalizePurchaseRouteRemarkText(fields.remark);
}

export function normalizePurchaseRouteRemarkText(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lines = [];
  raw
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const collapsed = collapseRepeatedRouteSegment(item);
      appendUniqueRouteLine(lines, collapsed);
    });
  return lines.join('\n');
}

export function collapseRepeatedRouteSegment(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ');
  if (compact.length % 2 === 0) {
    const half = compact.length / 2;
    const left = compact.slice(0, half).trim();
    const right = compact.slice(half).trim();
    if (left && getNormalizedDeliveryRouteLine(left) === getNormalizedDeliveryRouteLine(right)) {
      return left;
    }
  }
  return compact;
}

export function getPurchaseOrderDefaultPurchasePlatform(order = {}, options = {}) {
  const products = getPurchaseCrossBorderProducts(order);
  const useProductOnlyPlatform = products.length > 1;
  for (const product of products) {
    const sourceEntry = getPurchaseCrossBorderPrimarySourceEntry(order, product, options);
    const platformOrder = useProductOnlyPlatform
      ? { ...order, buyerPlatform: '', manualBuyerPlatform: '', supplier: '' }
      : order;
    const platformCode = getPurchaseCrossBorderPackagePlatform({}, platformOrder, product, sourceEntry);
    if (platformCode) return String(platformCode);
  }
  return '';
}

export function getCrossBorderPackageServiceId(settings = {}) {
  const serviceOptions = Array.isArray(settings.serviceOptions) ? settings.serviceOptions : [];
  const selectedServiceValue = String(settings.packageService || '').trim();
  const selectedService =
    serviceOptions.find((option) => String(option.value || '') === selectedServiceValue) ??
    serviceOptions.find((option) => String(option.id || '') === selectedServiceValue) ??
    null;
  return firstUsableOzonId(
    selectedService?.id,
    selectedService?.service_id,
    selectedServiceValue,
    settings.onlyLabelServiceId,
    settings.onlyLabelService_id
  );
}

export function normalizePurchaseForecastServiceOptions(serviceOptions = []) {
  const seen = new Set();
  return (Array.isArray(serviceOptions) ? serviceOptions : [])
    .map((option) => {
      const id = String(option?.id || option?.service_id || option?.value || '').trim();
      const selectionType = option?.selectionType === 'optional' ? 'optional' : 'required';
      return {
        ...option,
        id,
        value: id,
        label: String(option?.label || option?.name || id).trim(),
        selectionType,
      };
    })
    .filter((option) => {
      if (!option.id || seen.has(option.id)) return false;
      seen.add(option.id);
      return true;
    });
}

export function getPurchaseForecastServiceSelection(settings = {}, fields = {}) {
  const fieldOptions = normalizePurchaseForecastServiceOptions(fields.forecastServiceOptions);
  const settingsOptions = normalizePurchaseForecastServiceOptions(settings.serviceOptions);
  const options = fieldOptions.length ? fieldOptions : settingsOptions;
  const requiredOptions = options.filter((option) => option.selectionType === 'required');
  const optionalOptions = options.filter((option) => option.selectionType === 'optional');
  const requestedRequiredId = String(fields.requiredServiceId || settings.packageService || '').trim();
  const requiredId = requiredOptions.some((option) => option.id === requestedRequiredId)
    ? requestedRequiredId
    : fieldOptions.length
      ? ''
      : String(getCrossBorderPackageServiceId(settings) || '').trim();
  const requestedOptionalIds = Array.isArray(fields.optionalServiceIds)
    ? fields.optionalServiceIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const optionalIdSet = new Set(optionalOptions.map((option) => option.id));
  const optionalIds = [...new Set(requestedOptionalIds.filter((id) => optionalIdSet.has(id)))];
  const hasInvalidOptionalSelection = requestedOptionalIds.some((id) => !optionalIdSet.has(id));
  return {
    options,
    requiredOptions,
    optionalOptions,
    requiredId,
    optionalIds,
    hasInvalidOptionalSelection,
    serviceIds: [...new Set([requiredId, ...optionalIds].filter(Boolean))],
  };
}

export async function requestPurchaseForecastServiceOptions(settings = {}, order = {}) {
  const store = getCrossBorderStoreForPurchaseOrder(settings, order);
  if (!store.sid || !store.sectionId) throw new Error('请先在店铺管理中选择跨境巴士合作仓库。');
  const result = await readCrossBorderEndpoint({
    endpointKey: 'warehouse.searchStorehouseSection',
    accountId: getCrossBorderLocalApiAccountId(settings),
    shopId: String(order.shopId || order.shopClientId || '').trim(),
    body: {
      sid: store.sid,
      section_id: store.sectionId,
    },
  });
  const options = normalizePurchaseForecastServiceOptions(
    normalizeCrossBorderServices(result?.data ?? result),
  );
  if (!options.some((option) => option.selectionType === 'required')) {
    throw new Error('跨境巴士没有返回必选打包服务。');
  }
  return options;
}

export function buildPurchaseCrossBorderPackage(fields = {}, order = {}, product = null, sourceEntry = {}) {
  const safeProduct = product || getPurchaseCrossBorderProducts(order)[0] || {};
  const sku = getPurchaseCrossBorderProductSku(order, safeProduct);
  const platformCode = getPurchaseCrossBorderPackagePlatform(fields, order, safeProduct, sourceEntry);
  const purchaseOrderNo = getPurchaseCrossBorderPackageOrderNo(fields, order, safeProduct, sourceEntry);
  const description = getPurchaseCrossBorderPackageDescription(fields, order, safeProduct, sourceEntry);
  return {
    package_of: 1,
    num: getPurchaseCrossBorderProductQty(order, safeProduct),
    sku_id: 0,
    sku: sku || 0,
    logistics_order: String(fields.logisticsOrder || '').trim(),
    from_platform: platformCode,
    from_order: purchaseOrderNo,
    describe: description,
    img: getPurchaseCrossBorderProductImage(safeProduct),
    problem_id: 0,
  };
}


export function buildPurchaseCrossBorderSheetBody(fields = {}) {
  const missing = [];
  if (!String(fields.orderNumber || '').trim()) missing.push('???????');
  if (!String(fields.sheetOrderSn || '').trim() && !String(fields.sheetUrl || '').trim()) {
    missing.push('????????');
  }
  return {
    missing,
    body: compactObject({
      order_number: String(fields.orderNumber || '').trim(),
      sheet_order_sn: String(fields.sheetOrderSn || '').trim(),
      sheet: String(fields.sheetUrl || '').trim(),
    }),
  };
}

export function buildPurchaseCrossBorderPackageBody(order = {}, fields = {}) {
  const missing = [];
  if (!String(fields.orderId || '').trim()) missing.push('order_id');
  if (!String(fields.purchaseOrderNo || '').trim()) missing.push('?????');
  if (!String(fields.logisticsOrder || '').trim()) missing.push('??????');
  if (!String(fields.packageDesc || '').trim()) missing.push('????');
  return {
    missing,
    body: {
      order_id: String(fields.orderId || '').trim(),
      package_list: [buildPurchaseCrossBorderPackage(fields, order)],
    },
  };
}

export function buildPurchaseCrossBorderCancelBody(fields = {}) {
  const missing = [];
  if (!String(fields.orderNumber || '').trim()) missing.push('???????');
  return {
    missing,
    body: {
      order_number: String(fields.orderNumber || '').trim(),
    },
  };
}

export async function submitPurchaseOzonAwaitingDelivery(shop, order) {
  const postingNumber = assertFbsSalesOrder(order, '?????');
  return requestProtectedOzonOrderOperation(
    'setFbsAwaitingDelivery',
    shop,
    { posting_number: postingNumber },
    { confirmed: true }
  );
}

export function buildPurchaseCrossBorderCreateBody(settings = {}, order = {}, fields = {}, options = {}) {
  const store = getCrossBorderStoreForPurchaseOrder(settings, order);
  const serviceSelection = getPurchaseForecastServiceSelection(settings, fields);
  const missing = [];
  const requireSheet = options.requireSheet !== false;
  if (!store.sid) missing.push('仓库');
  if (!store.sectionId) missing.push('店铺平台');
  if (!serviceSelection.requiredId) missing.push('必选打包服务');
  if (serviceSelection.hasInvalidOptionalSelection) missing.push('有效的可选增值服务');
  if (!String(fields.country || '').trim()) missing.push('目的国家');
  if (requireSheet && !String(fields.sheetOrderSn || '').trim()) missing.push('Ozon 面单号');
  if (requireSheet && !String(fields.sheetUrl || '').trim()) missing.push('Ozon 面单文件');

  const products = getPurchaseCrossBorderProducts(order);
  if (!products.length) missing.push('商品明细');
  const useProductOnlyPlatform = products.length > 1;
  const packageList = products.map((product, index) => {
    const sourceEntry = getPurchaseCrossBorderPrimarySourceEntry(order, product, options);
    const platformFields = useProductOnlyPlatform ? { ...fields, purchasePlatform: '' } : fields;
    const platformOrder = useProductOnlyPlatform
      ? { ...order, buyerPlatform: '', manualBuyerPlatform: '', supplier: '' }
      : order;
    const platformCode = getPurchaseCrossBorderPackagePlatform(platformFields, platformOrder, product, sourceEntry);
    const purchaseOrderNo = getPurchaseCrossBorderPackageOrderNo(fields, order, product, sourceEntry);
    const description = getPurchaseCrossBorderPackageDescription(fields, order, product, sourceEntry);
    if (!platformCode) missing.push(`第 ${index + 1} 个商品采购平台`);
    if (!purchaseOrderNo) missing.push(`第 ${index + 1} 个商品采购订单号`);
    if (!description) missing.push(`第 ${index + 1} 个商品包裹说明`);
    return buildPurchaseCrossBorderPackage(
      {
        ...fields,
        purchasePlatform: platformCode,
        purchaseOrderNo,
        packageDesc: description,
      },
      platformOrder,
      product,
      sourceEntry
    );
  });
  const orderData = compactObject({
    order_number: firstUsableOzonId(fields.orderNumber, order.shipmentNo, order.salesOrder, order.id),
    country: String(fields.country || '')
      .trim()
      .toUpperCase(),
    sheet_order_sn: String(fields.sheetOrderSn || '').trim(),
    sheet: String(fields.sheetUrl || '').trim(),
    introduce: getPurchaseCrossBorderRouteRemark(order, fields, options),
    add_service: serviceSelection.serviceIds.map((serviceId) => ({
      id: Number(serviceId) || serviceId,
    })),
    package_list: packageList,
  });

  return {
    missing,
    body: compactObject({
      sid: store.sid,
      section_id: store.sectionId,
      data_status: String(fields.dataStatus) === '1' ? 1 : 0,
      is_check_section_order: 0,
      order_data: [orderData],
    }),
  };
}

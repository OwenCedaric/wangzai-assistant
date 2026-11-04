import {
  PRODUCT_MATERIAL_SOURCE_CROSS_BORDER,
  getProductMaterialProfile,
  getProductMaterialProfileKey,
  hasCompleteProductMaterial,
  readProductMaterialProfiles,
  saveProductMaterialProfile,
  saveProductMaterialProfileCanonical,
} from './productMaterialProfileStore';

let readLocalCrossBorderOrderRecordsAdapter = async () => [];
let normalizeCrossBorderLocalOrderRecordAdapter = (record) => record;
let requestCrossBorderReadOnlyAdapter = async () => ({});
let canUseCrossBorderOrderOutInfoReadAdapter = () => false;
let getCrossBorderOrderIdAdapter = (item = {}) => {
  const safeItem = item && typeof item === 'object' ? item : {};
  return firstUsableProductBusId(safeItem.id, safeItem.order_id, safeItem.orderId, safeItem.platform_order);
};
let getPurchaseOrderVolumeItemsAdapter = () => [];
let getOzonShopClientIdAdapter = (shop = {}) => firstUsableProductBusId(shop.clientId, shop.client_id, shop.id);

export function configureProductBusMaterialService({
  readLocalCrossBorderOrderRecords,
  normalizeCrossBorderLocalOrderRecord,
  requestCrossBorderReadOnly,
  canUseCrossBorderOrderOutInfoRead,
  getCrossBorderOrderId,
  getPurchaseOrderVolumeItems,
  getOzonShopClientId,
} = {}) {
  if (typeof readLocalCrossBorderOrderRecords === 'function') {
    readLocalCrossBorderOrderRecordsAdapter = readLocalCrossBorderOrderRecords;
  }
  if (typeof normalizeCrossBorderLocalOrderRecord === 'function') {
    normalizeCrossBorderLocalOrderRecordAdapter = normalizeCrossBorderLocalOrderRecord;
  }
  if (typeof requestCrossBorderReadOnly === 'function') requestCrossBorderReadOnlyAdapter = requestCrossBorderReadOnly;
  if (typeof canUseCrossBorderOrderOutInfoRead === 'function') {
    canUseCrossBorderOrderOutInfoReadAdapter = canUseCrossBorderOrderOutInfoRead;
  }
  if (typeof getCrossBorderOrderId === 'function') getCrossBorderOrderIdAdapter = getCrossBorderOrderId;
  if (typeof getPurchaseOrderVolumeItems === 'function') getPurchaseOrderVolumeItemsAdapter = getPurchaseOrderVolumeItems;
  if (typeof getOzonShopClientId === 'function') getOzonShopClientIdAdapter = getOzonShopClientId;
}

export function resetProductBusMaterialServiceForTest() {
  readLocalCrossBorderOrderRecordsAdapter = async () => [];
  normalizeCrossBorderLocalOrderRecordAdapter = (record) => record;
  requestCrossBorderReadOnlyAdapter = async () => ({});
  canUseCrossBorderOrderOutInfoReadAdapter = () => false;
  getCrossBorderOrderIdAdapter = (item = {}) => {
    const safeItem = item && typeof item === 'object' ? item : {};
    return firstUsableProductBusId(safeItem.id, safeItem.order_id, safeItem.orderId, safeItem.platform_order);
  };
  getPurchaseOrderVolumeItemsAdapter = () => [];
  getOzonShopClientIdAdapter = (shop = {}) => firstUsableProductBusId(shop.clientId, shop.client_id, shop.id);
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function formatTrimmedNumber(value) {
  const number = toFiniteNumber(value);
  if (number === null) return '';
  return String(Number(number.toFixed(6)));
}

function normalizeProductBusId(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return text && text !== '0' && text !== 'undefined' && text !== 'null' ? text : '';
}

function firstFilledProductBusValue(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function firstUsableProductBusId(...values) {
  for (const value of values) {
    const text = normalizeProductBusId(value).trim();
    if (text && text !== '-' && text !== '未返回') return text;
  }
  return '';
}

function getInlineUnit(value) {
  const text = String(value ?? '').toLowerCase();
  if (/毫米|mm\b/.test(text)) return 'mm';
  if (/厘米|cm\b/.test(text)) return 'cm';
  if (/千克|公斤|kg\b/.test(text)) return 'kg';
  if (/克|g\b/.test(text)) return 'g';
  if (/米|m\b/.test(text)) return 'm';
  return '';
}

export function normalizeProductBusMaterialDimensionCm(value, unit = 'cm') {
  const number = toFiniteNumber(value);
  if (number === null) return '';
  const normalizedUnit = getInlineUnit(value) || String(unit || 'cm').toLowerCase();
  if (normalizedUnit === 'mm') return formatTrimmedNumber(number / 10);
  if (normalizedUnit === 'm') return formatTrimmedNumber(number * 100);
  return formatTrimmedNumber(number);
}

export function normalizeProductBusMaterialWeightKg(value, unit = 'kg') {
  const number = toFiniteNumber(value);
  if (number === null) return '';
  const normalizedUnit = getInlineUnit(value) || String(unit || 'kg').toLowerCase();
  if (normalizedUnit === 'g') return formatTrimmedNumber(number / 1000);
  return formatTrimmedNumber(number);
}

export function getCompleteProductMaterialFromVolumeItem(item = {}) {
  const material = {
    weight: normalizeProductBusMaterialWeightKg(item.grossWeight ?? item.gross_weight ?? item.weight, 'kg'),
    length: normalizeProductBusMaterialDimensionCm(item.length, 'cm'),
    width: normalizeProductBusMaterialDimensionCm(item.width, 'cm'),
    height: normalizeProductBusMaterialDimensionCm(item.height, 'cm'),
  };
  return hasCompleteProductMaterial(material) ? material : null;
}

export function getProductBusOfferId(product = {}) {
  return firstUsableProductBusId(product?.offerId, product?.sku);
}

export function normalizeProductBusMatchValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function collectCrossBorderProductMatchValues(source, seen = new Set()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return [];
  seen.add(source);

  if (Array.isArray(source)) {
    return source.flatMap((item) => collectCrossBorderProductMatchValues(item, seen));
  }

  const matchKeys = new Set([
    'sku',
    'goods_sku',
    'goodssku',
    'offer_id',
    'offerid',
    'product_sku',
    'productsku',
    'platform_sku',
    'platformsku',
    'seller_sku',
    'sellersku',
    'product_no',
    'productno',
    'describe',
    'description',
    'introduce',
    'remark',
    'goods_name',
    'goodsname',
  ]);
  const values = [];

  Object.entries(source).forEach(([key, value]) => {
    const normalizedKey = key.toLowerCase();
    if (matchKeys.has(normalizedKey) && value !== undefined && value !== null && typeof value !== 'object') {
      values.push(String(value));
    }
    if (value && typeof value === 'object') {
      values.push(...collectCrossBorderProductMatchValues(value, seen));
    }
  });

  return values;
}

export function crossBorderOrderMatchesProduct(order = {}, product = {}) {
  const offerId = normalizeProductBusMatchValue(getProductBusOfferId(product));
  if (!offerId) return false;
  const values = collectCrossBorderProductMatchValues(order);
  if (
    values.some((value) => {
      const normalized = normalizeProductBusMatchValue(value);
      return normalized === offerId || (offerId.length >= 4 && normalized.includes(offerId));
    })
  ) {
    return true;
  }

  const packageSources = [
    order?.package_list,
    order?.packageList,
    order?.packages,
    order?.products,
    order?.goods,
    order?.items,
  ].filter(Boolean);
  return packageSources.some((source) => normalizeProductBusMatchValue(JSON.stringify(source)).includes(offerId));
}

export function getCrossBorderOrderTimestamp(order = {}) {
  const safeOrder = order && typeof order === 'object' ? order : {};
  const raw = firstFilledProductBusValue(
    safeOrder.updatedAt,
    safeOrder.updated_at,
    safeOrder.updateTime,
    safeOrder.update_time,
    safeOrder.confirmTime,
    safeOrder.confirm_time,
    safeOrder.createdAt,
    safeOrder.created_at,
    safeOrder.createTime,
    safeOrder.create_time,
    safeOrder.sendTime,
    safeOrder.send_time,
    safeOrder.packTime,
    safeOrder.pack_time
  );
  const number = Number(raw);
  if (Number.isFinite(number) && number > 0) {
    return number > 100000000000 ? number : number * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getCrossBorderProductBusMaterialScore(order = {}) {
  const text = [
    order.packageWeight,
    order.package_weight,
    order.weight,
    order.packageSize,
    order.package_size,
    order.size,
    order.volume,
    order.volumeItems,
    order.package_list,
    order.packageList,
  ]
    .map((value) => (value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')))
    .join(' ')
    .toLowerCase();
  let score = 0;
  if (/\d/.test(text)) score += 1;
  if (/kg|кг|cm|厘米|重量|weight|long|width|height|volume/.test(text)) score += 1;
  if (firstUsableProductBusId(order.orderId, order.order_id, order.id)) score += 1;
  return score;
}

export function pickProductBusCrossBorderOrder(items = []) {
  if (!items.length) return null;
  return items
    .map((item, index) => ({
      item,
      index,
      materialScore: getCrossBorderProductBusMaterialScore(item),
      timestamp: getCrossBorderOrderTimestamp(item),
    }))
    .sort((a, b) => b.materialScore - a.materialScore || b.timestamp - a.timestamp || a.index - b.index)[0].item;
}

export function getProductSavedBusTarget(product = {}, shop = {}) {
  const profile = getProductMaterialProfile(product, shop);
  const orderId = firstUsableProductBusId(profile?.sourceOrderId, product?.sourceOrderId, product?.crossBorderOrderId, product?.packageOrderId);
  if (!orderId) return null;
  return {
    orderId,
    orderItem: {
      order_number: profile?.sourceOrderNumber || '',
      from_order: profile?.sourcePurchaseOrderNumber || '',
    },
    orderNumber: profile?.sourceOrderNumber || '',
    source: 'saved-profile',
  };
}

export async function readRecentCrossBorderOrdersForProductBus(settings = {}, shopClientId = '') {
  const records = await readLocalCrossBorderOrderRecordsAdapter(settings, shopClientId).catch(() => []);
  return records.map(normalizeCrossBorderLocalOrderRecordAdapter);
}

export async function findLatestProductBusTarget({ settings = {}, shop = {}, product = {}, recentOrders } = {}) {
  const savedTarget = getProductSavedBusTarget(product, shop);
  if (savedTarget) return savedTarget;

  const offerId = getProductBusOfferId(product);
  if (!offerId) return null;

  const shopClientId = getOzonShopClientIdAdapter(shop);
  const orders = Array.isArray(recentOrders)
    ? recentOrders
    : await readRecentCrossBorderOrdersForProductBus(settings, shopClientId);
  const order = pickProductBusCrossBorderOrder(orders.filter((item) => crossBorderOrderMatchesProduct(item, product)));
  const orderId = getCrossBorderOrderIdAdapter(order);
  if (!order || !orderId) return null;
  return {
    orderId,
    orderItem: order,
    orderNumber: firstUsableProductBusId(order.order_number, order.orderNumber, order.sheet_order_sn, order.platform_order),
    source: 'order-search',
  };
}

export function getProductBusOutInfoSectionCode(orderItem = {}) {
  const safeOrderItem = orderItem && typeof orderItem === 'object' ? orderItem : {};
  return firstUsableProductBusId(
    safeOrderItem.order_number,
    safeOrderItem.orderNumber,
    safeOrderItem.sheet_order_sn,
    safeOrderItem.sheetOrderNumber,
    safeOrderItem.trackingNumber,
    safeOrderItem.logistics_order,
    safeOrderItem.logisticsOrder,
    safeOrderItem.platform_order,
    safeOrderItem.platformOrder
  );
}

export async function requestProductBusOutInfo(settings = {}, target = {}) {
  if (!target.orderId) throw new Error('未找到跨境巴士 order_id，不能读取出库信息。');

  return requestCrossBorderReadOnlyAdapter('/erpapi/order/get_order_out_info', settings, {
    order_id: target.orderId,
    section_code: getProductBusOutInfoSectionCode(target.orderItem),
  });
}

export function getCompleteProductBusVolumeItem(outPayload = {}) {
  return getPurchaseOrderVolumeItemsAdapter(outPayload).find((item) => getCompleteProductMaterialFromVolumeItem(item)) ?? null;
}

export function saveCrossBorderProductMaterialProfile(product = {}, shop = {}, material = {}, options = {}) {
  const key = getProductMaterialProfileKey(product, shop);
  if (!key) return null;
  const existingProfile = readProductMaterialProfiles()[key] ?? {};
  return saveProductMaterialProfile({
    ...existingProfile,
    key,
    shopId: shop.id,
    offerId: product.offerId || existingProfile.offerId || '',
    productId: product.productId || existingProfile.productId || '',
    ozonSku: product.ozonSku || product.sku || existingProfile.ozonSku || '',
    ...material,
    source: PRODUCT_MATERIAL_SOURCE_CROSS_BORDER,
    sourceOrderId: options.orderId || existingProfile.sourceOrderId || '',
    sourceOrderNumber: options.orderNumber || existingProfile.sourceOrderNumber || '',
    sourcePurchaseOrderNumber: options.purchaseOrderNumber || existingProfile.sourcePurchaseOrderNumber || '',
    applyToProduct: true,
    ozonSyncedAt: options.ozonSyncedAt || existingProfile.ozonSyncedAt || '',
    ozonSyncTaskId: options.ozonSyncTaskId || existingProfile.ozonSyncTaskId || '',
    ozonSyncStatus: options.ozonSyncStatus || existingProfile.ozonSyncStatus || '跨境巴士实测',
  });
}

export function saveCrossBorderProductMaterialProfileCanonical(product = {}, shop = {}, material = {}, options = {}) {
  const key = getProductMaterialProfileKey(product, shop);
  if (!key) return Promise.reject(new Error('PRODUCT_MATERIAL_PRODUCT_KEY_REQUIRED'));
  const existingProfile = readProductMaterialProfiles()[key] ?? {};
  return saveProductMaterialProfileCanonical({
    ...existingProfile,
    key,
    shopId: shop.id,
    offerId: product.offerId || existingProfile.offerId || '',
    productId: product.productId || existingProfile.productId || '',
    ozonSku: product.ozonSku || product.sku || existingProfile.ozonSku || '',
    ...material,
    source: PRODUCT_MATERIAL_SOURCE_CROSS_BORDER,
    sourceOrderId: options.orderId || existingProfile.sourceOrderId || '',
    sourceOrderNumber: options.orderNumber || existingProfile.sourceOrderNumber || '',
    sourcePurchaseOrderNumber: options.purchaseOrderNumber || existingProfile.sourcePurchaseOrderNumber || '',
    applyToProduct: true,
    ozonSyncedAt: options.ozonSyncedAt || existingProfile.ozonSyncedAt || '',
    ozonSyncTaskId: options.ozonSyncTaskId || existingProfile.ozonSyncTaskId || '',
    ozonSyncStatus: options.ozonSyncStatus || existingProfile.ozonSyncStatus || '跨境巴士实测',
  });
}

export async function saveProductBusMaterialFromRead({ shop = {}, product = {}, target = {}, volumeItem = {} } = {}) {
  const material = getCompleteProductMaterialFromVolumeItem(volumeItem);
  if (!material) return { status: 'no-data', reason: '跨境巴士未返回完整长宽高重量。' };

  const offerId = getProductBusOfferId(product);
  if (!offerId) return { status: 'no-data', reason: '当前商品缺少货号，不能保存巴士实测资料。' };
  const orderNumber = target.orderNumber || getProductBusOutInfoSectionCode(target.orderItem);
  const finalProfile = await saveCrossBorderProductMaterialProfileCanonical(product, shop, material, {
    orderId: target.orderId,
    orderNumber,
    purchaseOrderNumber: firstUsableProductBusId(target.orderItem?.from_order, target.orderItem?.fromOrder),
    ozonSyncStatus: '跨境巴士实测，已保存本地，待确认回传 Ozon',
  });
  return {
    status: 'saved-local',
    offerId,
    orderId: target.orderId,
    material: finalProfile,
  };
}

export async function readAndSaveProductBusMeasurement({ shop = {}, settings = {}, product = {}, recentOrders } = {}) {
  if (!canUseCrossBorderOrderOutInfoReadAdapter(settings)) {
    throw new Error('请先在设置里保存跨境巴士企业接口和账号授权。');
  }
  const target = await findLatestProductBusTarget({ settings, shop, product, recentOrders });
  if (!target) {
    return {
      status: 'no-data',
      offerId: getProductBusOfferId(product),
      reason: '没有找到这个商品最近一单跨境巴士订单。',
    };
  }

  const outPayload = await requestProductBusOutInfo(settings, target);
  const volumeItem = getCompleteProductBusVolumeItem(outPayload);
  if (!volumeItem) {
    return {
      status: 'no-data',
      offerId: getProductBusOfferId(product),
      orderId: target.orderId,
      reason: '跨境巴士出库信息没有完整长宽高重量。',
    };
  }

  return saveProductBusMaterialFromRead({ shop, product, target, volumeItem });
}

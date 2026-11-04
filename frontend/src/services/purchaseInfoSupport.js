import { readCrossBorderRecords } from './crossBorderOrderRecordClient';
import { readPurchaseOverrides } from './purchaseOrderOverrideClient';
import { resolvePurchaseOrderDetailUrl } from './purchaseOrderDetailUrl';

const EMPTY_PURCHASE_INFO_VALUES = new Set([
  '',
  '-',
  '--',
  '未返回',
  '待补录',
  '待拍单',
  '待确认',
  'null',
  'undefined',
  '0',
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeLookupKey(value) {
  const text = normalizeText(value);
  return text && !EMPTY_PURCHASE_INFO_VALUES.has(text) && !EMPTY_PURCHASE_INFO_VALUES.has(text.toLowerCase())
    ? text
    : '';
}

function firstUsable(...values) {
  for (const value of values) {
    const text = normalizeLookupKey(value);
    if (text) return text;
  }
  return '';
}

function firstRaw(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function uniqueValues(values = []) {
  const seen = new Set();
  return values.map(normalizeLookupKey).filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function getRawOrder(order = {}) {
  return order?.raw && typeof order.raw === 'object' && !Array.isArray(order.raw) ? order.raw : {};
}

function getPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getFirstProduct(order = {}) {
  return Array.isArray(order?.products) ? getPlainObject(order.products[0]) : {};
}

function getMaterialSource(source = {}) {
  return getPlainObject(source.materialSource || source.material_source || source.source || source.sourceEntry);
}

function getOverrideNestedSources(override = {}) {
  const safeOverride = getPlainObject(override);
  const raw = getPlainObject(safeOverride.raw);
  return [
    safeOverride,
    getPlainObject(safeOverride.patch),
    getPlainObject(safeOverride.order),
    getPlainObject(raw.patch),
    getPlainObject(raw.order),
  ];
}

function isTruthyPurchaseFlag(value) {
  return value === true || value === 1 || ['true', '1'].includes(String(value ?? '').trim().toLowerCase());
}

export function isVoidedPurchaseInfo(order = {}, override = {}) {
  const safeOrder = getPlainObject(order);
  const safeOverride = getPlainObject(override);
  const orderRaw = getRawOrder(safeOrder);
  const overrideRaw = getRawOrder(safeOverride);
  const sources = [
    safeOrder,
    safeOverride,
    orderRaw,
    overrideRaw,
    ...getOverrideNestedSources(safeOverride),
  ];
  const refundConfirmed = sources.some((source) => isTruthyPurchaseFlag(source.purchaseRefundConfirmed));
  const forceStatus = firstUsable(...sources.map((source) => source.forcePurchaseStatus));
  const voidedOrderNumber = firstUsable(...sources.map((source) => source.voidedPurchaseOrderNo));
  const purchaseRecordStatus = firstUsable(...sources.map((source) => source.purchaseRecordStatus)).toLowerCase();
  return Boolean(
    refundConfirmed ||
    (forceStatus === '待拍单' && voidedOrderNumber) ||
    ['void', 'voided', 'refunded'].includes(purchaseRecordStatus)
  );
}

export function clearVoidedPurchaseDisplayFields(order = {}, override = {}) {
  const safeOrder = getPlainObject(order);
  if (!isVoidedPurchaseInfo(safeOrder, override)) return safeOrder;
  return {
    ...safeOrder,
    buyerPlatform: '待拍单',
    supplier: '待拍单',
    purchasePlatform: '',
    purchaseOrderNumber: '',
    purchaseOrderNo: '',
    purchaseOrderUrl: '',
    sourceCostCny: null,
    purchaseCostCny: null,
    purchasePrice: '待确认',
    purchasePriceValue: null,
    manualBuyerPlatform: '',
    manualPurchaseOrderNo: '',
    manualPurchasePrice: '',
    manualPurchasePriceValue: null,
    manualPurchaseOrderStatus: '',
    purchaseOrderStatus: '',
    forcePurchaseStatus: '待拍单',
    profitLedger: null,
  };
}

function firstFromSources(sources = [], fieldNames = []) {
  return firstUsable(...sources.flatMap((source) => fieldNames.map((field) => source?.[field])));
}

function firstRawFromSources(sources = [], fieldNames = []) {
  return firstRaw(...sources.flatMap((source) => fieldNames.map((field) => source?.[field])));
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const matched = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!matched) return null;
  const number = Number(matched[0]);
  return Number.isFinite(number) ? number : null;
}

function normalizeVolumeItem(item = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const length = toFiniteNumber(firstRaw(item.length, item.long, item.lengthCm, item.length_cm));
  const width = toFiniteNumber(firstRaw(item.width, item.widthCm, item.width_cm));
  const height = toFiniteNumber(firstRaw(item.height, item.heightCm, item.height_cm));
  const grossWeight = toFiniteNumber(
    firstRaw(item.grossWeight, item.gross_weight, item.weight, item.weightKg, item.weight_kg, item.packageWeight)
  );
  const sizeText = firstUsable(item.sizeText, item.packageSize, item.size);
  const weightText = firstUsable(item.weightText, item.packageWeight, item.weight);
  if (!length && !width && !height && !grossWeight && !sizeText && !weightText) return null;
  return {
    ...item,
    ...(length ? { length } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(grossWeight ? { grossWeight } : {}),
    ...(sizeText ? { sizeText } : length && width && height ? { sizeText: `${length} x ${width} x ${height} cm` } : {}),
    ...(weightText ? { weightText } : grossWeight ? { weightText: `${grossWeight} kg` } : {}),
  };
}

function getVolumeItemsFromSource(source, seen = new Set()) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || seen.has(source)) return [];
  seen.add(source);
  const directItems = [
    ...(Array.isArray(source.volumeItems) ? source.volumeItems : []),
    ...(Array.isArray(source.volume_items) ? source.volume_items : []),
    ...(Array.isArray(source.volume) ? source.volume : []),
    ...(Array.isArray(source.packages) ? source.packages : []),
    ...(Array.isArray(source.package_list) ? source.package_list : []),
  ];
  const nestedItems = ['outPayload', 'out_payload', 'outInfo', 'out_info', 'payload', 'data', 'result'].flatMap((field) =>
    getVolumeItemsFromSource(source[field], seen)
  );
  return [...directItems.map(normalizeVolumeItem).filter(Boolean), ...nestedItems];
}

function getVolumeItems(...sources) {
  const seenKeys = new Set();
  return sources.flatMap((source) => getVolumeItemsFromSource(source)).filter((item) => {
    const key = JSON.stringify([
      item.sizeText,
      item.weightText,
      item.length,
      item.width,
      item.height,
      item.grossWeight,
    ]);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
}

function getVolumeSizeText(item = {}) {
  const directText = firstUsable(item.sizeText, item.packageSize, item.size);
  if (directText) return directText;
  const dimensions = [item.length, item.width, item.height]
    .map((value) => toFiniteNumber(value))
    .filter((value) => value > 0);
  return dimensions.length === 3 ? `${dimensions[0]} x ${dimensions[1]} x ${dimensions[2]} cm` : '';
}

function getVolumeWeightText(item = {}) {
  const directText = firstUsable(item.weightText, item.packageWeight, item.weight);
  if (directText) return directText;
  const weight = toFiniteNumber(item.grossWeight ?? item.gross_weight ?? item.weight);
  return weight > 0 ? `${weight} kg` : '';
}

function stripScopedLookupKey(value = '') {
  const text = normalizeLookupKey(value);
  if (!text || !text.includes(':')) return text;
  return normalizeLookupKey(text.split(':').pop());
}

function getShopKeys(source = {}) {
  return uniqueValues([
    source.shopId,
    source.shop_id,
    source.shopClientId,
    source.shop_client_id,
    source.clientId,
    source.client_id,
    source.shop,
  ]);
}

export function getPurchaseInfoLookupKeys(order = {}) {
  const raw = getRawOrder(order);
  const analytics = raw.analytics_data && typeof raw.analytics_data === 'object' ? raw.analytics_data : {};
  return uniqueValues([
    order.orderKey,
    order.order_key,
    order.recordKey,
    order.record_key,
    order.postingNumber,
    order.posting_number,
    order.posting,
    order.id,
    order.softwareOrderId,
    order.ozonOrderId,
    order.ozon_order_id,
    order.orderId,
    order.order_id,
    order.orderNumber,
    order.order_number,
    raw.posting_number,
    raw.postingNumber,
    raw.order_number,
    raw.orderNumber,
    raw.order_id,
    raw.orderId,
    analytics.posting_number,
    analytics.postingNumber,
    analytics.order_id,
    analytics.orderId,
  ]);
}

export function buildPurchaseInfoOverrideIndex(rows = []) {
  const byKey = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const keys = uniqueValues([
      row.orderKey,
      row.order_key,
      row.recordKey,
      row.record_key,
      row.postingNumber,
      row.posting_number,
      row.ozonOrderId,
      row.ozon_order_id,
      row.orderId,
      row.order_id,
    ]);
    const shopKeys = getShopKeys(row);
    keys.forEach((key) => {
      if (!byKey.has(key)) byKey.set(key, row);
      shopKeys.forEach((shopKey) => {
        const scopedKey = `${shopKey}:${key}`;
        if (!byKey.has(scopedKey)) byKey.set(scopedKey, row);
      });
    });
  });
  return byKey;
}

function getPurchaseInfoCrossBorderLookupKeys(row = {}) {
  const raw = getPlainObject(row.raw);
  const nestedSources = [
    row,
    getPlainObject(row.patch),
    getPlainObject(row.order),
    raw,
    getPlainObject(raw.patch),
    getPlainObject(raw.order),
  ];
  return uniqueValues(
    nestedSources.flatMap((source) => [
      source.packageOrderId,
      source.crossBorderOrderId,
      source.crossBorderOrderNumber,
      source.orderId,
      source.order_id,
      source.recordKey,
      source.record_key,
      source.orderKey,
      source.order_key,
      stripScopedLookupKey(source.orderKey),
      stripScopedLookupKey(source.order_key),
      source.postingNumber,
      source.posting_number,
      stripScopedLookupKey(source.postingNumber),
      stripScopedLookupKey(source.posting_number),
      source.orderNumber,
      source.order_number,
      source.platformOrder,
      source.platform_order,
      source.sheetOrderNumber,
      source.sheet_order_sn,
      source.purchaseOrderNumber,
      source.purchase_order_number,
      source.fromOrder,
      source.from_order,
      source.offerId,
      source.offer_id,
      source.sku,
    ])
  );
}

function getCrossBorderRecordScore(record = {}) {
  const info = getPurchaseInfoCrossBorderInfo({}, record);
  return (
    (info.volumeItems.length ? 100 : 0) +
    (normalizeLookupKey(info.packageSize) ? 30 : 0) +
    (normalizeLookupKey(info.packageWeight) ? 20 : 0) +
    (normalizeLookupKey(info.readStatus) ? 5 : 0)
  );
}

function buildCrossBorderRecordIndex(records = []) {
  const byKey = new Map();
  (Array.isArray(records) ? records : []).forEach((record) => {
    const score = getCrossBorderRecordScore(record);
    getPurchaseInfoCrossBorderLookupKeys(record).forEach((key) => {
      const current = byKey.get(key);
      if (!current || score > current.score) byKey.set(key, { record, score });
    });
  });
  return byKey;
}

export function mergePurchaseInfoOverridesWithCrossBorderRecords(rows = [], crossBorderRows = []) {
  const crossBorderIndex = buildCrossBorderRecordIndex(crossBorderRows);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const matched = getPurchaseInfoCrossBorderLookupKeys(row)
      .map((key) => crossBorderIndex.get(key)?.record)
      .find(Boolean);
    if (!matched) return row;
    const rowInfo = getPurchaseInfoCrossBorderInfo({}, row);
    const matchedInfo = getPurchaseInfoCrossBorderInfo({}, matched);
    const volumeItems = rowInfo.volumeItems.length ? rowInfo.volumeItems : matchedInfo.volumeItems;
    return {
      ...row,
      crossBorderOrderFound: row.crossBorderOrderFound ?? true,
      crossBorderRecord: matched,
      packageOrderId: firstUsable(row.packageOrderId, row.crossBorderOrderId, matchedInfo.orderId),
      crossBorderOrderId: firstUsable(row.crossBorderOrderId, row.packageOrderId, matchedInfo.orderId),
      readStatus: firstUsable(row.readStatus, row.crossBorderStatus, matchedInfo.readStatus),
      packageWeight: firstUsable(row.packageWeight, matchedInfo.packageWeight),
      packageSize: firstUsable(row.packageSize, matchedInfo.packageSize),
      volumeItems,
    };
  });
}

export function findPurchaseInfoOverride(order = {}, overrideIndex = new Map()) {
  const lookupKeys = getPurchaseInfoLookupKeys(order);
  const shopKeys = uniqueValues([...getShopKeys(order), ...getShopKeys(getRawOrder(order))]);
  for (const key of lookupKeys) {
    for (const shopKey of shopKeys) {
      const scoped = overrideIndex.get(`${shopKey}:${key}`);
      if (scoped) return scoped;
    }
    const unscoped = overrideIndex.get(key);
    if (unscoped) return unscoped;
  }
  return null;
}

export function getPurchaseInfoSupport(order = {}, override = {}) {
  const safeOrder = order && typeof order === 'object' ? order : {};
  const safeOverride = override && typeof override === 'object' ? override : {};
  const raw = getRawOrder(safeOrder);
  const firstProduct = getFirstProduct(safeOrder);
  const materialSources = [
    getMaterialSource(safeOverride),
    getMaterialSource(raw),
    getMaterialSource(safeOrder),
    getMaterialSource(firstProduct),
  ];
  const purchaseVoided = isVoidedPurchaseInfo(safeOrder, safeOverride);
  const platform = purchaseVoided ? '' : firstUsable(
    safeOverride.purchasePlatform,
    safeOverride.purchase_platform,
    safeOverride.platform,
    safeOverride.manualBuyerPlatform,
    safeOverride.buyerPlatform,
    safeOrder.purchasePlatform,
    safeOrder.purchase_platform,
    safeOrder.manualBuyerPlatform,
    safeOrder.buyerPlatform,
    safeOrder.supplier,
    raw.purchasePlatform,
    raw.purchase_platform,
    raw.platform
  );
  const orderNumber = purchaseVoided ? '' : firstUsable(
    safeOverride.purchaseOrderNumber,
    safeOverride.purchase_order_number,
    safeOverride.purchaseOrderNo,
    safeOverride.purchase_order_no,
    safeOverride.orderNo,
    safeOverride.order_no,
    safeOverride.manualPurchaseOrderNo,
    safeOrder.purchaseOrderNumber,
    safeOrder.purchase_order_number,
    safeOrder.purchaseOrderNo,
    safeOrder.purchase_order_no,
    safeOrder.manualPurchaseOrderNo,
    raw.purchaseOrderNumber,
    raw.purchase_order_number,
    raw.purchaseOrderNo,
    raw.purchase_order_no,
    raw.orderNo,
    raw.order_no
  );
  const explicitUrl = purchaseVoided ? '' : firstUsable(
    safeOverride.purchaseOrderUrl,
    safeOverride.purchase_order_url,
    safeOverride.orderUrl,
    safeOverride.order_url,
    safeOverride.purchaseOrderLink,
    safeOverride.purchase_order_link,
    safeOrder.purchaseOrderUrl,
    safeOrder.purchase_order_url,
    safeOrder.orderUrl,
    safeOrder.order_url,
    raw.purchaseOrderUrl,
    raw.purchase_order_url,
    raw.orderUrl,
    raw.order_url
  );
  const orderUrl = resolvePurchaseOrderDetailUrl({
    platform,
    orderNumber,
    explicitUrl,
  });
  const sourceLink = firstUsable(
    safeOverride.sourceLink,
    safeOverride.source_link,
    safeOverride.productUrl,
    safeOverride.product_url,
    safeOverride.materialSource?.link,
    safeOverride.materialSource?.url,
    safeOrder.sourceLink,
    safeOrder.source_link,
    safeOrder.sourceUrl,
    safeOrder.source_url,
    safeOrder.productUrl,
    safeOrder.product_url,
    raw.sourceLink,
    raw.source_link
  );
  const sourceTitle = firstUsable(
    ...materialSources.flatMap((source) => [
      source.title,
      source.name,
      source.productTitle,
      source.product_title,
      source.sourceTitle,
      source.source_title,
      source.goodsTitle,
      source.goods_title,
    ]),
    safeOverride.sourceTitle,
    safeOverride.source_title,
    safeOverride.productTitle,
    safeOverride.product_title,
    safeOrder.sourceTitle,
    safeOrder.source_title,
    firstProduct.sourceTitle,
    firstProduct.source_title,
    firstProduct.purchaseTitle,
    firstProduct.purchase_title,
    firstProduct.name,
    safeOrder.product
  );
  const sourceImage = firstUsable(
    ...materialSources.flatMap((source) => [
      source.image,
      source.imageUrl,
      source.image_url,
      source.picture,
      source.pictureUrl,
      source.picUrl,
      Array.isArray(source.images) ? source.images[0] : '',
      Array.isArray(source.pictures) ? source.pictures[0] : '',
    ]),
    safeOverride.sourceImage,
    safeOverride.source_image,
    safeOverride.imageUrl,
    safeOverride.image_url,
    safeOrder.sourceImage,
    safeOrder.source_image,
    firstProduct.sourceImage,
    firstProduct.source_image,
    firstProduct.image,
    firstProduct.imageUrl,
    firstProduct.primaryImage
  );
  const sourceProductId = firstUsable(
    ...materialSources.flatMap((source) => [
      source.productId,
      source.product_id,
      source.itemId,
      source.item_id,
      source.offerId,
      source.offer_id,
    ]),
    safeOverride.sourceProductId,
    safeOverride.source_product_id,
    safeOverride.productId,
    safeOverride.product_id,
    safeOrder.sourceProductId,
    safeOrder.source_product_id,
    firstProduct.sourceProductId,
    firstProduct.source_product_id,
    firstProduct.productId,
    firstProduct.product_id
  );
  const cost = purchaseVoided ? '' : firstRaw(
    safeOverride.sourceCostCny,
    safeOverride.source_cost_cny,
    safeOverride.purchaseCostCny,
    safeOverride.purchase_cost_cny,
    safeOverride.cost,
    safeOverride.manualPurchasePriceValue,
    safeOverride.manualPurchasePrice,
    safeOrder.sourceCostCny,
    safeOrder.source_cost_cny,
    safeOrder.purchaseCostCny,
    safeOrder.purchase_cost_cny,
    safeOrder.purchasePriceValue,
    safeOrder.purchasePrice,
    safeOrder.manualPurchasePriceValue,
    safeOrder.manualPurchasePrice,
    ...materialSources.flatMap((source) => [
      source.price,
      source.priceValue,
      source.price_value,
      source.purchasePrice,
      source.purchase_price,
      source.cost,
    ])
  );
  const qty = firstRaw(
    ...materialSources.flatMap((source) => [source.qty, source.quantity, source.purchaseQty, source.purchase_qty]),
    safeOverride.purchaseQty,
    safeOverride.purchase_qty,
    safeOrder.purchaseQty,
    safeOrder.purchase_qty,
    firstProduct.purchaseQty,
    firstProduct.purchase_qty,
    firstProduct.qty,
    safeOrder.items
  );
  const status = purchaseVoided ? '待拍单' : firstUsable(
    safeOverride.manualStatus,
    safeOverride.manual_status,
    safeOverride.purchaseOrderStatus,
    safeOverride.purchase_order_status,
    safeOverride.manualPurchaseOrderStatus,
    safeOrder.purchaseOrderStatus,
    safeOrder.purchase_order_status,
    safeOrder.manualPurchaseOrderStatus,
    safeOrder.purchaseStatus
  );
  const orderLabel = firstUsable(
    safeOrder.postingNumber,
    safeOrder.posting_number,
    safeOrder.posting,
    safeOrder.id,
    safeOrder.orderKey,
    safeOrder.recordKey
  );
  const hasPurchaseOrder = Boolean(
    !purchaseVoided &&
    platform &&
    orderNumber &&
    orderUrl
  );

  return {
    platform: platform || (purchaseVoided ? '待补录' : '未返回'),
    orderNumber: orderNumber || '未返回',
    orderUrl,
    hasOrderUrl: Boolean(orderUrl),
    sourceLink,
    hasSourceLink: Boolean(sourceLink),
    cost: normalizeLookupKey(cost) || (purchaseVoided ? '待确认' : '未返回'),
    status: status || '未返回',
    orderLabel: orderLabel || '未返回',
    sourceTitle: sourceTitle || '未返回',
    sourceImage,
    sourceProductId: sourceProductId || '未返回',
    qty: normalizeLookupKey(qty) || '1',
    hasPurchaseOrder,
    purchaseVoided,
  };
}

export function resolvePurchaseInfoOpenAction(order = {}, override = {}) {
  const support = getPurchaseInfoSupport(order, override);
  if (!support.hasPurchaseOrder || !support.orderUrl) {
    return {
      canOpen: false,
      url: '',
      message: '该笔订单未采购。',
      support,
    };
  }
  return {
    canOpen: true,
    url: support.orderUrl,
    message: '',
    support,
  };
}

export function getPurchaseInfoCrossBorderInfo(order = {}, override = {}, fallback = {}) {
  const safeOrder = order && typeof order === 'object' ? order : {};
  const raw = getRawOrder(safeOrder);
  const crossBorderInfo = getPlainObject(safeOrder.crossBorderInfo);
  const nestedSources = [
    ...getOverrideNestedSources(override),
    getPlainObject(raw.crossBorderInfo),
    crossBorderInfo,
    getPlainObject(fallback),
  ];
  const volumeItems = getVolumeItems(...nestedSources, safeOrder, fallback);
  const primaryVolumeItem = volumeItems[0] ?? {};
  const orderId = firstFromSources(nestedSources, [
    'packageOrderId',
    'crossBorderOrderId',
    'orderId',
    'crossBorderOrderNumber',
  ]);
  const packageWeight =
    firstUsable(
      firstFromSources(nestedSources, ['packageWeight', 'packageWeightKg']),
      getVolumeWeightText(primaryVolumeItem)
    ) || '';
  const packageSize =
    firstUsable(getVolumeSizeText(primaryVolumeItem), firstFromSources(nestedSources, ['packageSize'])) || '';
  const readStatus = firstFromSources(nestedSources, ['readStatus', 'crossBorderStatus', 'message']);
  const warehouse = firstFromSources(nestedSources, ['warehouse', 'storehouseName', 'storehouse_name']);
  const logistics = firstFromSources(nestedSources, ['logistics', 'deliveryMethod', 'delivery_method']);
  const freightCost = firstRawFromSources(nestedSources, ['freightCost', 'freightCostValue']);

  return {
    orderId: orderId || '未返回',
    packageWeight: packageWeight || '未返回',
    packageSize: packageSize || '未返回',
    readStatus: readStatus || '未返回',
    warehouse: warehouse || '未返回',
    logistics: logistics || '未返回',
    freightCost: normalizeLookupKey(freightCost) || '未返回',
    volumeItems,
  };
}

export async function readPurchaseInfoOverrideRows(query = {}, options = {}) {
  const rows = [];
  const pageSize = Math.min(Math.max(Number(options.pageSize) || 1000, 1), 1000);
  const maxPages = Math.min(Math.max(Number(options.maxPages) || 5, 1), 20);
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await readPurchaseOverrides({ ...query, page, pageSize }, options.fetchOptions);
    const pageRows = Array.isArray(result?.rows) ? result.rows : [];
    rows.push(...pageRows);
    const total = Number(result?.total) || rows.length;
    if (rows.length >= total || pageRows.length < pageSize) break;
  }
  try {
    const crossBorderRows = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await readCrossBorderRecords(
        { shopId: options.crossBorderShopId || 'all', page, pageSize },
        options.fetchOptions
      );
      const pageRows = Array.isArray(result?.rows) ? result.rows : [];
      crossBorderRows.push(...pageRows);
      const total = Number(result?.total) || crossBorderRows.length;
      if (crossBorderRows.length >= total || pageRows.length < pageSize) break;
    }
    return mergePurchaseInfoOverridesWithCrossBorderRecords(rows, crossBorderRows);
  } catch {
    return rows;
  }
}

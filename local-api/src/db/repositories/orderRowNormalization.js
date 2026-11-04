import { createStableHash } from "../../utils/stableHash.js";

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

export function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== '0' && text !== '未返回' ? text : '';
}

export function compactJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function firstFilled(...values) {
  for (const value of values) {
    if (normalizeText(value)) return value;
  }
  return '';
}

export function extractProducts(row = {}) {
  if (Array.isArray(row.products)) return row.products;
  if (Array.isArray(row.items)) return row.items;
  if (Array.isArray(row.posting?.products)) return row.posting.products;
  return [];
}

export const ORDER_PRODUCT_IMAGE_SCALAR_FIELDS = Object.freeze([
  'image',
  'skuImage',
  'sku_image',
  'primaryImage',
  'primary_image',
  'mainImage',
  'productMainImage',
  'imageUrl',
  'image_url',
]);

export const ORDER_PRODUCT_IMAGE_ARRAY_FIELDS = Object.freeze([
  'images',
  'skuImages',
  'mainImages',
  'productMainImages',
  'imageUrls',
]);

export const ORDER_PRODUCT_IMAGE_LOOKUP_CHUNK_SIZE = 300;

export const ORDER_MERGE_RAW_FIELDS = Object.freeze([
  'paymentAt', 'payment_at', 'inProcessAt', 'in_process_at', 'updated_at',
  'postingNumber', 'posting_number', 'orderId', 'order_id',
]);

// -> retains JSON scalar types (including booleans) inside json_object. Never
// transport every product/image/raw field just to compare two order headers.
export const ORDER_MERGE_RAW_SQL = `CASE WHEN json_valid(raw_json) THEN
  CASE WHEN json_type(raw_json) = 'object' THEN json_object(
    ${ORDER_MERGE_RAW_FIELDS.map(field => `'${field}', raw_json -> '$.${field}'`).join(', ')}
  ) ELSE raw_json END ELSE raw_json END`;

export function normalizeImageValues(value) {
  return (Array.isArray(value) ? value : [value]).map(normalizeText).filter(Boolean);
}

export function orderProductHasImage(product = {}) {
  return (
    ORDER_PRODUCT_IMAGE_SCALAR_FIELDS.some((field) => normalizeImageValues(product[field]).length > 0) ||
    ORDER_PRODUCT_IMAGE_ARRAY_FIELDS.some((field) => normalizeImageValues(product[field]).length > 0)
  );
}

export function getOrderProductIdentity(product = {}) {
  const raw = product?.raw && typeof product.raw === 'object' ? product.raw : {};
  return {
    productId: normalizeId(firstFilled(product.productId, product.product_id, raw.productId, raw.product_id)),
    offerId: normalizeId(firstFilled(product.offerId, product.offer_id, raw.offerId, raw.offer_id)),
    sku: normalizeId(firstFilled(product.sku, product.skuId, product.sku_id, raw.sku, raw.sku_id)),
  };
}

export function cachedProductImages(row = {}) {
  const primaryImage = normalizeText(row.primary_image_url);
  if (primaryImage) return [primaryImage];
  const fallbackImage = normalizeImageValues(parseJson(row.images_json, []))[0] || '';
  return fallbackImage ? [fallbackImage] : [];
}

export function applyCachedProductImages(product = {}, cachedRow = null) {
  if (!cachedRow || orderProductHasImage(product)) return product;
  const images = cachedProductImages(cachedRow);
  const primaryImage = images[0] || '';
  if (!primaryImage) return product;
  return {
    ...product,
    primary_image: primaryImage,
    images,
  };
}

export function chunkValues(values = [], chunkSize = ORDER_PRODUCT_IMAGE_LOOKUP_CHUNK_SIZE) {
  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

export function queryFlagEnabled(value) {
  return value === true || value === 1 || ['1', 'true', 'yes'].includes(normalizeText(value).toLowerCase());
}

export function getOrderProductAmount(product = {}) {
  const source = product && typeof product === 'object' ? product : {};
  const raw = source.raw && typeof source.raw === 'object' ? source.raw : source;
  const financial = source.financialRaw && typeof source.financialRaw === 'object' ? source.financialRaw : {};
  const quantity = toFiniteNumber(firstFilled(source.qty, source.quantity, source.count, raw.qty, raw.quantity, raw.count)) ?? 1;
  const explicit = [
    financial.total_price, financial.totalPrice, financial.total_amount, financial.totalAmount,
    financial.row_price, financial.rowPrice, financial.line_price, financial.linePrice, financial.final_price, financial.finalPrice,
    raw.total_price, raw.totalPrice, raw.total_amount, raw.totalAmount,
    raw.row_price, raw.rowPrice, raw.line_price, raw.linePrice, raw.final_price, raw.finalPrice,
  ].map(toFiniteNumber).find((value) => value !== null);
  if (explicit !== undefined) return explicit;
  const unit = [
    financial.price?.price, financial.price, financial.offer_price, financial.offerPrice, financial.item_price, financial.itemPrice,
    raw.price?.price, raw.price, raw.offer_price, raw.offerPrice, raw.item_price, raw.itemPrice,
    source.priceValue, source.price,
  ].map(toFiniteNumber).find((value) => value !== null);
  return unit === undefined ? null : unit * quantity;
}

export function getOrderAmountValue(row = {}, products = []) {
  const productAmounts = products.map(getOrderProductAmount).filter((value) => value !== null);
  if (productAmounts.length) return productAmounts.reduce((sum, value) => sum + value, 0);
  return [
    row.total_price, row.totalPrice, row.order_price, row.orderPrice, row.sum_price, row.sumPrice,
    row.total_amount, row.totalAmount, row.order_amount, row.orderAmount,
  ].map(toFiniteNumber).find((value) => value !== null) ?? null;
}

export function normalizeOrder(row = {}, { shopId, source = 'FBS' } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const postingNumber = normalizeId(firstFilled(row.posting_number, row.postingNumber, row.posting?.posting_number));
  const orderId = normalizeId(firstFilled(row.order_id, row.orderId, row.order_number, row.orderNumber, row.posting?.order_id));
  const orderKey = postingNumber || orderId;
  if (!orderKey) return null;
  const normalizedSource = normalizeText(firstFilled(row.source, row.fulfillment, source)).toUpperCase() || source;
  const status = normalizeText(firstFilled(row.status, row.status_raw, row.state));
  const substatus = normalizeText(firstFilled(row.substatus, row.sub_status));
  const fulfillment = normalizedSource.includes('FBO') ? 'FBO' : 'FBS';
  const products = extractProducts(row);
  const analytics = row.analytics_data ?? row.analyticsData ?? null;
  const financial = row.financial_data ?? row.financialData ?? null;
  const inProcessAt = normalizeText(firstFilled(row.in_process_at, row.inProcessAt, row.created_at, row.createdAt));
  const shipmentDate = normalizeText(firstFilled(row.shipment_date, row.shipmentDate, row.delivering_date));
  const deliveringDate = normalizeText(firstFilled(row.delivering_date, row.deliveringDate));
  const cutoffAt = normalizeText(firstFilled(row.cutoff_at, row.cutoffAt, row.shipment_date));
  const paymentAt = normalizeText(firstFilled(row.paid_at, row.paidAt, row.payment_date, row.paymentDate, inProcessAt));
  const amountValue = getOrderAmountValue(row, products);
  const remoteHash = createStableHash({ row, normalized: { orderKey, status, substatus, source: fulfillment, products } }, { length: 40 });
  return {
    id: `order_${createStableHash({ shopId, orderKey }, { length: 32 })}`,
    shopId,
    orderKey,
    postingNumber,
    orderId,
    source: fulfillment,
    status,
    substatus,
    fulfillment,
    inProcessAt,
    shipmentDate,
    deliveringDate,
    cutoffAt,
    paymentAt,
    amountValue,
    products,
    analytics,
    financial,
    raw: { ...row, source: row.source || fulfillment },
    remoteHash,
  };
}

export function toPublicOrder(row = {}) {
  const raw = parseJson(row.raw_json, {});
  const products = parseJson(row.products_json, []);
  const analytics = parseJson(row.analytics_json, raw.analytics_data ?? null);
  const financial = parseJson(row.financial_json, raw.financial_data ?? null);
  return {
    ...raw,
    id: row.posting_number || row.order_id || row.id,
    localId: row.id,
    shopId: row.shop_id,
    orderKey: row.order_key,
    posting_number: row.posting_number || raw.posting_number || null,
    postingNumber: row.posting_number || raw.postingNumber || null,
    order_id: row.order_id || raw.order_id || null,
    orderId: row.order_id || raw.orderId || null,
    source: row.source || raw.source || null,
    fulfillment: row.fulfillment || row.source || raw.fulfillment || null,
    status: row.status || raw.status || null,
    substatus: row.substatus || raw.substatus || null,
    in_process_at: row.in_process_at || raw.in_process_at || null,
    inProcessAt: row.in_process_at || raw.inProcessAt || null,
    shipment_date: row.shipment_date || raw.shipment_date || null,
    delivering_date: row.delivering_date || raw.delivering_date || null,
    cutoff_at: row.cutoff_at || raw.cutoff_at || null,
    paid_at: row.payment_at || raw.paid_at || raw.payment_date || null,
    paymentDate: row.payment_at || raw.paid_at || raw.payment_date || null,
    amount_value: row.amount_value ?? null,
    products,
    analytics_data: analytics,
    financial_data: financial,
    raw,
    isStale: Boolean(row.is_stale),
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

// Keep the existing public-row comparator inputs, including its legacy raw
// aliases. Only these fields are retained while selecting a federated page;
// products, amounts, historical facts and split details are hydrated afterward.
export function toOrderMergeKey(row, projection) {
  const keys = { shopId: row.shop_id, orderKey: row.order_key, postingNumber: row.posting_number, orderId: row.order_id };
  const raw = projection === 'keys' ? {} : parseJson(row.raw_json, {});
  return {
    shopId: row.shop_id,
    localId: row.id,
    remoteHash: row.remote_hash,
    updatedAt: row.updated_at,
    sortKey: projection === 'keys' ? keys : {
      id: row.posting_number || row.order_id || row.id,
      shopId: row.shop_id,
      postingNumber: row.posting_number || raw.postingNumber || null,
      posting_number: row.posting_number || raw.posting_number || null,
      orderId: row.order_id || raw.orderId || null,
      order_id: row.order_id || raw.order_id || null,
      paymentAt: raw.paymentAt,
      payment_at: raw.payment_at,
      inProcessAt: row.in_process_at || raw.inProcessAt || null,
      in_process_at: row.in_process_at || raw.in_process_at || null,
      updatedAt: row.updated_at,
      updated_at: raw.updated_at,
    },
  };
}

export function toPublicHistoricalOrderFact(row = {}) {
  const amount = (value) => (value === null || value === undefined ? null : Number(value) / 100);
  const measure = (value, factor) => (
    value === null || value === undefined ? null : Number(value) / factor
  );
  return {
    sourceType: row.source_type || 'historical_order_import',
    orderNumber: row.posting_number || '',
    orderId: row.order_id || '',
    productIdentityId: row.product_identity_id || '',
    productId: row.product_id || '',
    offerId: row.offer_id || '',
    sku: row.sku || '',
    productName: row.product_name || '',
    purchaseCostCny: amount(row.purchase_cost_minor),
    crossBorderCostCny: amount(row.cross_border_cost_minor),
    domesticFreightCny: amount(row.domestic_freight_minor),
    packagingCostCny: amount(row.packaging_cost_minor),
    otherCostCny: amount(row.other_cost_minor),
    currencyCode: row.currency_code || 'CNY',
    lengthCm: measure(row.length_mm, 10),
    widthCm: measure(row.width_mm, 10),
    heightCm: measure(row.height_mm, 10),
    weightKg: measure(row.weight_g, 1000),
    sourcePlatform: row.source_platform || '',
    sourceUrl: row.source_url || '',
    purchaseOrderNumber: row.purchase_order_number || '',
    trackingNumber: row.tracking_number || '',
    note: row.note || '',
    originImportId: row.origin_import_id || '',
    updatedAt: row.updated_at || '',
  };
}

export function normalizePageSize(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

export function splitIds(value) {
  if (Array.isArray(value)) return value.map(normalizeId).filter(Boolean);
  return normalizeText(value).split(',').map((item) => item.trim()).filter(Boolean);
}

export const PRINT_SHIPPING_WAREHOUSE_EXPRESSION = `COALESCE(
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.delivery_method.warehouse_name') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.delivery_method.warehouse') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.analytics_data.warehouse_name') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.warehouse_name') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.warehouse.name') AS TEXT)), ''),
  ''
)`;

export const PRINT_SHIPPING_DELIVERY_METHOD_EXPRESSION = `COALESCE(
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.delivery_method.name') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.delivery_method.tpl_provider') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.delivery_method_name') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.provider_name') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.analytics_data.delivery_type') AS TEXT)), ''),
  ''
)`;

export const PRINT_SHIPPING_TRACKING_EXPRESSION = `COALESCE(
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.tracking_number') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.trackingNumber') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.posting.tracking_number') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.barcode') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.barcode_number') AS TEXT)), ''),
  ''
)`;

export const PRINT_SHIPPING_CARRIAGE_EXPRESSION = `COALESCE(
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.carriage_id') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.carriageId') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.delivery_method.carriage_id') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.posting.carriage_id') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.act_id') AS TEXT)), ''),
  NULLIF(TRIM(CAST(json_extract(raw_json, '$.actId') AS TEXT)), ''),
  ''
)`;

export const PRINT_SHIPPING_DEADLINE_EXPRESSION = "datetime(COALESCE(cutoff_at, shipment_date, delivering_date, ''))";

export function normalizePostingNumber(row = {}) {
  return normalizeId(firstFilled(row.posting_number, row.postingNumber, row.posting?.posting_number, row.id));
}

export function normalizePostingList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => (item && typeof item === 'object' ? normalizePostingNumber(item) : normalizeId(item))).filter(Boolean))];
  }
  return splitIds(value);
}

export function normalizeQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

export function normalizeQuantityRows(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      posting_number: normalizePostingNumber(item),
      quantity: normalizeQuantity(item?.quantity ?? item?.qty ?? item?.count),
      offer_id: normalizeText(firstFilled(item?.offer_id, item?.offerId, item?.sku, item?.skuId)),
    }))
    .filter((item) => item.posting_number || item.quantity > 0 || item.offer_id);
}

export function normalizeNullableBoolean(value) {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return null;
}

export function hasOwnField(source = {}, field) {
  return Object.prototype.hasOwnProperty.call(source, field);
}

export function relationLockReason(relation = {}) {
  const status = normalizeText(relation.readbackStatus || relation.readback_status || relation.status);
  if (status === 'merged') return '该订单已拆单，母单未在 Ozon 当前回读中确认，默认只读保留。';
  if (status === 'partial') return '拆单已提交 Ozon，但回读结果不完整，需要重新刷新确认。';
  if (status === 'mismatch') return '拆单回读与提交数量不一致，需要重新对账。';
  return '拆单已提交 Ozon，等待回读确认。';
}

export function toPublicSplitRelation(row = {}) {
  const childPostingNumbers = parseJson(row.child_posting_numbers_json, []);
  const splitQuantities = parseJson(row.split_quantities_json, []);
  return {
    id: row.id,
    shopId: row.shop_id,
    parentPostingNumber: row.parent_posting_number,
    childPostingNumbers: Array.isArray(childPostingNumbers) ? childPostingNumbers : [],
    splitQuantities: Array.isArray(splitQuantities) ? splitQuantities : [],
    status: row.status || 'submitted_waiting_readback',
    readbackStatus: row.readback_status || 'pending',
    parentOzonVisible: row.parent_ozon_visible == null ? null : Boolean(row.parent_ozon_visible),
    childrenConfirmed: Boolean(row.children_confirmed),
    childCount: Number(row.child_count) || 0,
    quantitySum: Number(row.quantity_sum) || 0,
    submittedPayload: parseJson(row.submitted_payload_json, null),
    ozonResponse: parseJson(row.ozon_response_json, null),
    parentSnapshot: parseJson(row.parent_snapshot_json, null),
    childSnapshots: parseJson(row.child_snapshots_json, []),
    readBackRows: parseJson(row.readback_rows_json, []),
    mismatchReason: row.mismatch_reason || null,
    submittedAt: row.submitted_at,
    readbackAt: row.readback_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function annotateOrdersWithSplitRelations(orders = [], relationRows = []) {
  if (!orders.length || !relationRows.length) return orders;
  const relations = relationRows.map(toPublicSplitRelation);
  const byParent = new Map();
  const byChild = new Map();
  for (const relation of relations) {
    const parentKey = `${relation.shopId}:${relation.parentPostingNumber}`;
    byParent.set(parentKey, relation);
    for (const childPostingNumber of relation.childPostingNumbers || []) {
      byChild.set(`${relation.shopId}:${childPostingNumber}`, relation);
    }
  }
  return orders.map((order) => {
    const shopId = normalizeText(order.shopId || order.shop_id);
    const postingNumber = normalizePostingNumber(order);
    if (!shopId || !postingNumber) return order;
    const parentRelation = byParent.get(`${shopId}:${postingNumber}`);
    if (parentRelation) {
      const parentVisible = parentRelation.parentOzonVisible === true;
      return {
        ...order,
        splitRelation: parentRelation,
        splitRole: 'parent',
        isSplitParent: true,
        isSplitChild: false,
        splitParentPostingNumber: parentRelation.parentPostingNumber,
        splitChildPostingNumbers: parentRelation.childPostingNumbers,
        splitReadbackStatus: parentRelation.readbackStatus,
        splitBusinessLocked: !parentVisible,
        splitLockReason: parentVisible ? '' : relationLockReason(parentRelation),
        splitDefaultBusinessHidden:
          parentRelation.childrenConfirmed === true && !parentVisible,
        splitOzonDisplayStatus:
          parentVisible
            ? 'parent_visible_after_readback'
            : parentRelation.childrenConfirmed
              ? 'parent_not_visible_after_readback'
              : 'parent_visible_or_pending',
      };
    }
    const childRelation = byChild.get(`${shopId}:${postingNumber}`);
    if (childRelation) {
      return {
        ...order,
        splitRelation: childRelation,
        splitRole: 'child',
        isSplitParent: false,
        isSplitChild: true,
        splitParentPostingNumber: childRelation.parentPostingNumber,
        splitChildPostingNumbers: childRelation.childPostingNumbers,
        splitReadbackStatus: childRelation.readbackStatus,
        splitBusinessLocked: false,
        splitLockReason: '',
        splitDefaultBusinessHidden: false,
        splitOzonDisplayStatus: 'child_visible',
      };
    }
    return order;
  });
}

export const HISTORICAL_ORDER_FACT_BATCH_SIZE = 400;

export function chunkRows(rows = [], size = HISTORICAL_ORDER_FACT_BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

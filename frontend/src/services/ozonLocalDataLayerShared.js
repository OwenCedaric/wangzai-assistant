export const OZON_LOCAL_DATA_LAYER_VERSION = 2;

export const MAX_ORDERS = 5000;

export const MAX_PRODUCTS = 5000;

export const MAX_IMAGES = 20000;

export const MAX_SNAPSHOTS = 1000;

export const MAX_DOMAIN_SNAPSHOTS = 500;

export const MAX_REFRESH_LOGS = 200;

export const MAX_RETRY_FAILURES = 500;

export const MAX_SNAPSHOT_RETRY_ATTEMPTS = 8;

export const SNAPSHOT_TYPE_ORDER = 'orders';

export const SNAPSHOT_TYPE_PRODUCT = 'products';

export const SNAPSHOT_TYPE_DOMAIN = 'domain';

export const IMAGE_FIELDS = [
  'image',
  'primaryImage',
  'primary_image',
  'mainImage',
  'productMainImage',
  'skuImage',
  'sku_image',
];

export const IMAGE_ARRAY_FIELDS = ['images', 'mainImages', 'productMainImages', 'skuImages'];

export const OMIT_ORDER_FIELDS = new Set(['products', 'raw']);

export const OMIT_PRODUCT_FIELDS = new Set(['raw', 'financialRaw']);

export const PRODUCT_SNAPSHOT_ROW_FIELD_KEYS = [
  'productId',
  'product_id',
  'offerId',
  'offer_id',
  'sku',
  'skuId',
  'sku_id',
  'ozonSku',
  'name',
  'title',
  'product',
  'category',
  'categoryName',
  'categoryPath',
  'descriptionCategoryId',
  'typeId',
  'shop',
  'shopName',
  'shopId',
  'shopClientId',
  'warehouseId',
  'price',
  'priceValue',
  'oldPriceValue',
  'currencyCode',
  'currency',
  'stock',
  'commissionPercent',
  'commissionText',
  'commissionPercentText',
  'commissionRateMode',
  'commissionRateDate',
  'commissionRateReadAt',
  'commissionRateSource',
  'commissionPercentDailyRates',
  'commissionAmountValue',
  'commissionAmount',
  'acquiringFeeValue',
  'acquiringFee',
  'mileageFeeValue',
  'mileageFee',
  'mileageFeeSource',
  'feeTotalValue',
  'feeTotal',
  'estimatedProfit',
  'weight',
  'length',
  'width',
  'height',
  'weightUnit',
  'dimensionUnit',
  'sourceWeightUnit',
  'sourceDimensionUnit',
  'status',
  'tone',
  'vat',
  'minPrice',
];

export function normalizeText(value) {
  return String(value ?? '').trim();
}

export function normalizeFieldKey(value) {
  return normalizeText(value)
    .replace(/[-_\s]/g, '')
    .toLowerCase();
}

export const PRODUCT_IMAGE_PAYLOAD_FIELD_KEYS = new Set(
  [
    ...IMAGE_FIELDS,
    ...IMAGE_ARRAY_FIELDS,
    'image_url',
    'imageUrl',
    'picture',
    'picture_url',
    'pictureUrl',
    'pictures',
    'primaryImage',
    'primary_image',
    'main_image',
    'mainImage',
    'product_main_image',
    'productMainImage',
    'sku_picture',
    'skuPicture',
    'sku_pictures',
    'skuPictures',
  ].map((key) => normalizeFieldKey(key))
);

const MISSING_TEXT_VALUES = new Set(['未返回', '读取失败', '待确认', '']);

export const AFTER_SALES_CLEARABLE_CLASSIFICATION_FIELDS = new Set([
  'refusedEvidence',
  'destroyedEvidence',
  'blockedEvidence',
  'deliveredEvidence',
  'shippedEvidence',
  'originalOrderCancelledEvidence',
  'originalOrderDeliveredEvidence',
]);

export const DEFAULT_RETRY_DELAY_MS = 30_000;

export const MAX_RETRY_DELAY_MS = 15 * 60_000;

export function nowIso() {
  return new Date().toISOString();
}

export function isMissingTextValue(value) {
  return typeof value === 'string' && MISSING_TEXT_VALUES.has(normalizeText(value));
}

export function hasEffectiveFieldValue(value) {
  if (value === undefined || value === null) return false;
  if (isMissingTextValue(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.values(value).some(hasEffectiveFieldValue);
  return true;
}

export function firstFilled(...values) {
  return values.map(normalizeText).find(Boolean) || '';
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

export function normalizeImageUrl(value) {
  const text = normalizeText(value);
  if (!/^https?:\/\//i.test(text)) return '';
  return text;
}

export function uniqueValues(values = []) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

export function uniqueImageUrls(values = []) {
  return [...new Set(values.map(normalizeImageUrl).filter(Boolean))];
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

export function createSignature(value) {
  return stableJson(value);
}

export function createCompactSignature(value) {
  const text = createSignature(value);
  let hashA = 2166136261;
  let hashB = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    hashA ^= code;
    hashA = Math.imul(hashA, 16777619);
    hashB = Math.imul(hashB, 33) ^ code;
  }
  return `h2:${text.length.toString(36)}:${(hashA >>> 0).toString(36)}:${(hashB >>> 0).toString(36)}`;
}

export function cloneJsonSafe(value) {
  if (value === undefined || typeof value === 'function') return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export function firstEffective(...values) {
  for (const value of values) {
    if (hasEffectiveFieldValue(value)) return normalizeText(value);
  }
  return '';
}

export function keepCurrentUnlessFresh(currentValue, ...freshValues) {
  const freshValue = firstEffective(...freshValues);
  return freshValue || currentValue || '';
}

export function mergeEffectiveObjectValue(currentValue, freshValue) {
  const currentObject = isPlainObject(currentValue) ? currentValue : {};
  const merged = { ...currentObject };
  for (const [key, value] of Object.entries(freshValue || {})) {
    const cloned = cloneJsonSafe(value);
    if (isPlainObject(cloned)) {
      if (hasEffectiveFieldValue(cloned)) {
        merged[key] = mergeEffectiveObjectValue(currentObject[key], cloned);
      }
      continue;
    }
    if (hasEffectiveFieldValue(cloned)) {
      merged[key] = cloned;
    }
  }
  return merged;
}

export function compactFieldMetaEntry(entry = {}) {
  if (!isPlainObject(entry)) return entry;
  const compacted = { ...entry };
  delete compacted.endpoint;
  if (compacted.verifiedAt === compacted.readAt) delete compacted.verifiedAt;
  if (compacted.version === OZON_LOCAL_DATA_LAYER_VERSION) delete compacted.version;
  return compacted;
}

export function compactFieldMetaMap(fieldMeta = {}) {
  if (!isPlainObject(fieldMeta)) return {};
  return Object.fromEntries(Object.entries(fieldMeta).map(([field, entry]) => [field, compactFieldMetaEntry(entry)]));
}

export function createRecordSignature(record = {}) {
  return createCompactSignature(record);
}

export function compactObject(source = {}, omittedFields = new Set()) {
  const output = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (omittedFields.has(key)) continue;
    if (/raw$/i.test(key) || /Raw$/.test(key)) continue;
    const cloned = cloneJsonSafe(value);
    if (cloned !== undefined) output[key] = cloned;
  }
  return output;
}

export function isProductImagePayloadField(key) {
  return PRODUCT_IMAGE_PAYLOAD_FIELD_KEYS.has(normalizeFieldKey(key));
}

export function omitProductImagePayloadFields(fields = {}) {
  if (!isPlainObject(fields)) return {};
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !isProductImagePayloadField(key)));
}

export function scopeProductSnapshotRow(row = {}, options = {}) {
  const shopKey = normalizeText(options.shopKey);
  return shopKey
    ? {
        ...row,
        shopClientId: row.shopClientId || shopKey,
        shopId: row.shopId || shopKey,
      }
    : row;
}

export function compactProductSnapshotRowFields(row = {}) {
  const fields = omitProductImagePayloadFields(compactObject(row, OMIT_PRODUCT_FIELDS));
  const output = {};
  PRODUCT_SNAPSHOT_ROW_FIELD_KEYS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) return;
    const value = fields[field];
    if (!hasEffectiveFieldValue(value)) return;
    const cloned = cloneJsonSafe(value);
    if (cloned !== undefined) output[field] = cloned;
  });
  return output;
}

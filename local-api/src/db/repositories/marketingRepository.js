import { createStableHash } from '../../utils/stableHash.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== '0' && text !== '未返回' ? text : '';
}

function normalizeMarketingSourceType(value) {
  const text = normalizeText(value).toLowerCase();
  const compact = text.replace(/[\s_-]+/gu, '');
  return compact === 'seller' || compact === 'selleractions' || compact === 'selleraction' || /商家|自主/u.test(text)
    ? 'seller'
    : 'official';
}

function getMarketingSourceLabel(sourceType, value = '') {
  return normalizeText(value) || (sourceType === 'seller' ? '商家自主' : '平台活动');
}

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function toSqlBool(value) {
  return value ? 1 : 0;
}

function fromSqlBool(value) {
  return Number(value) === 1;
}

function toSqlIntBool(value) {
  return value ? 1 : 0;
}

function safeJsonParse(text, fallback = {}) {
  try {
    return JSON.parse(text || '');
  } catch {
    return fallback;
  }
}

const LEGACY_MARKETING_SNAPSHOT_MAX_ACTIVITIES = 2_000;
const LEGACY_MARKETING_SNAPSHOT_MAX_PRODUCTS = 10_000;
const LEGACY_MARKETING_SNAPSHOT_MAX_SELECTED_PRODUCTS = 10_000;
const LEGACY_MARKETING_SNAPSHOT_MAX_TEXT = 8_192;
const LEGACY_MARKETING_ACTIVITY_FIELDS = new Set([
  'id',
  'title',
  'originalTitle',
  'source',
  'sourceTone',
  'count',
  'description',
  'available',
  'hasAvailableCount',
  'estimate',
  'dateStart',
  'dateEnd',
  'isOnline',
  'sourceType',
]);
const LEGACY_MARKETING_PRODUCT_FIELDS = new Set([
  'id',
  'name',
  'offerId',
  'ozonSku',
  'sku',
  'price',
  'sourceActivityPrice',
  'activityPrice',
  'stock',
  'status',
  'statusTone',
  'review',
  'reviewTone',
]);
const LEGACY_MARKETING_SUMMARY_FIELDS = new Set([
  'activityTotal',
  'joinedActivityTotal',
  'joinedProductTotal',
  'issueProductTotal',
]);
const LEGACY_MARKETING_SNAPSHOT_FIELDS = new Set([
  'activityRows',
  'productPool',
  'marketingSummary',
  'selectedActivityId',
  'selectedSourceType',
  'productScope',
  'selectedProductIds',
  'cachedAt',
]);
const LEGACY_MARKETING_SOURCE_TYPE_ALIASES = new Map([
  ['official', 'official'],
  ['officialaction', 'official'],
  ['officialactions', 'official'],
  ['action', 'official'],
  ['actions', 'official'],
  ['platform', 'official'],
  ['platformaction', 'official'],
  ['platformactions', 'official'],
  ['平台', 'official'],
  ['平台活动', 'official'],
  ['官方', 'official'],
  ['官方活动', 'official'],
  ['seller', 'seller'],
  ['selleraction', 'seller'],
  ['selleractions', 'seller'],
  ['商家', 'seller'],
  ['商家活动', 'seller'],
  ['商家自主', 'seller'],
  ['自主', 'seller'],
  ['自主活动', 'seller'],
]);

function legacyError(code, path = '') {
  return new Error(path ? `${code}:${path}` : code);
}

function assertLegacyPlainObject(value, path) {
  if (!isPlainObject(value)) throw legacyError('MARKETING_LEGACY_OBJECT_REQUIRED', path);
  return value;
}

function assertLegacyAllowedFields(value, allowedFields, path) {
  Object.keys(value).forEach((field) => {
    if (!allowedFields.has(field)) throw legacyError('MARKETING_LEGACY_UNKNOWN_FIELD', `${path}.${field}`);
  });
}

function normalizeLegacyText(value, {
  path,
  maxLength = LEGACY_MARKETING_SNAPSHOT_MAX_TEXT,
  allowNumber = false,
  fallback = '',
} = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && allowNumber && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw legacyError('MARKETING_LEGACY_TEXT_REQUIRED', path);
  if (value.length > maxLength) throw legacyError('MARKETING_LEGACY_TEXT_TOO_LONG', path);
  return value;
}

function normalizeLegacyId(value, path) {
  const text = normalizeLegacyText(value, { path, maxLength: 260, allowNumber: true }).trim();
  if (!text || text === '0' || text === '未返回') throw legacyError('MARKETING_LEGACY_ID_REQUIRED', path);
  return text;
}

function normalizeLegacyNonNegativeInt(value, { path, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw legacyError('MARKETING_LEGACY_NONNEGATIVE_INTEGER_REQUIRED', path);
  return number;
}

function normalizeLegacyBoolean(value, { path, fallback = false } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw legacyError('MARKETING_LEGACY_BOOLEAN_REQUIRED', path);
  return value;
}

function normalizeLegacySourceType(value, path) {
  if (value === undefined || value === null || value === '') return 'official';
  if (typeof value !== 'string') throw legacyError('MARKETING_LEGACY_SOURCE_TYPE_INVALID', path);
  const compact = value.trim().toLowerCase().replace(/[\s_-]+/gu, '');
  const sourceType = LEGACY_MARKETING_SOURCE_TYPE_ALIASES.get(compact);
  if (!sourceType) throw legacyError('MARKETING_LEGACY_SOURCE_TYPE_INVALID', path);
  return sourceType;
}

function normalizeLegacyProductScope(value, path) {
  if (value === undefined || value === null || value === '') return 'joined';
  if (typeof value !== 'string' || !['joined', 'available', 'all'].includes(value)) {
    throw legacyError('MARKETING_LEGACY_PRODUCT_SCOPE_INVALID', path);
  }
  return value;
}

function parseSelectedProductIds(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw legacyError('MARKETING_LEGACY_ARRAY_REQUIRED', path);
  if (value.length > LEGACY_MARKETING_SNAPSHOT_MAX_SELECTED_PRODUCTS) {
    throw legacyError('MARKETING_LEGACY_ARRAY_TOO_LARGE', path);
  }
  const ids = value.map((item, index) => normalizeLegacyId(item, `${path}[${index}]`));
  if (new Set(ids).size !== ids.length) throw legacyError('MARKETING_LEGACY_SELECTED_PRODUCT_DUPLICATE', path);
  return ids;
}

function stringify(value) {
  return JSON.stringify(value ?? {});
}

function parseDateMs(value) {
  if (!value) return null;
  const time = Date.parse(String(value));
  return Number.isNaN(time) ? null : time;
}

function firstFilled(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function getMarketingActivityDateFields(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : safeJsonParse(row.raw_json, {});
  return {
    dateStart: firstFilled(row.date_start, row.dateStart, raw.date_start, raw.dateStart, raw.start_at, raw.startAt),
    dateEnd: firstFilled(row.date_end, row.dateEnd, raw.date_end, raw.dateEnd, raw.end_at, raw.endAt),
  };
}

export function isMarketingActivityOnline(row = {}, nowMs = Date.now()) {
  const { dateStart, dateEnd } = getMarketingActivityDateFields(row);
  const startMs = parseDateMs(dateStart);
  const endMs = parseDateMs(dateEnd);
  if (endMs !== null && endMs < nowMs) return false;
  if (startMs !== null && startMs > nowMs) return false;
  return true;
}

export function normalizeMarketingActivityRow(row = {}, { sourceType = 'official', sourceLabel = '' } = {}) {
  const activityId = normalizeId(row.id ?? row.action_id ?? row.seller_action_id ?? row.actionId);
  const normalizedSourceType = normalizeMarketingSourceType(sourceType ?? row.sourceType ?? row.source_type);
  const originalTitle = normalizeText(row.title ?? row.name ?? row.action_name ?? row.actionName ?? activityId);
  const { dateStart, dateEnd } = getMarketingActivityDateFields(row);
  const joinedCount =
    row.participating_products_count ??
    row.products_count ??
    row.product_count ??
    row.current_products_count ??
    row.count ??
    0;
  const availableValue =
    row.potential_products_count ??
    row.candidates_count ??
    row.available_products_count ??
    row.candidate_count ??
    row.available;
  const hasAvailableCount = availableValue !== undefined && availableValue !== null && availableValue !== '';
  const normalized = {
    activityId,
    sourceType: normalizedSourceType,
    sourceLabel: getMarketingSourceLabel(normalizedSourceType, sourceLabel ?? row.source ?? row.sourceLabel),
    sourceTone: normalizeText(row.sourceTone ?? row.source_tone ?? ''),
    title: normalizeText(row.displayTitle ?? row.titleCn ?? originalTitle) || originalTitle || `活动 ${activityId}`,
    originalTitle,
    description: normalizeText(row.description ?? row.desc ?? ''),
    joinedCount: toInt(joinedCount),
    availableCount: toInt(availableValue),
    hasAvailableCount,
    estimate: normalizeText(row.estimate ?? row.date_range ?? row.dateRange ?? ''),
    dateStart,
    dateEnd,
    raw: row,
  };
  normalized.remoteHash = createStableHash(normalized, { length: 32 });
  return normalized.activityId ? normalized : null;
}

export function toPublicMarketingActivity(row = {}) {
  const raw = safeJsonParse(row.raw_json, {});
  const { dateStart, dateEnd } = getMarketingActivityDateFields({ ...row, raw });
  return {
    id: row.activity_id,
    activityId: row.activity_id,
    title: row.title,
    originalTitle: row.original_title,
    source: row.source_label,
    sourceType: row.source_type,
    sourceTone: row.source_tone || '',
    count: Number(row.joined_count) || 0,
    available: Number(row.available_count) || 0,
    hasAvailableCount: fromSqlBool(row.has_available_count),
    description: row.description || '',
    estimate: row.estimate || '',
    dateStart,
    dateEnd,
    isOnline: isMarketingActivityOnline({ ...row, raw }),
    raw,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function getMarketingProductCacheId(row = {}) {
  return normalizeId(row.product_id ?? row.productId ?? row.id ?? row.ozon_sku ?? row.ozonSku ?? row.sku ?? row.offer_id ?? row.offerId);
}

function normalizeMarketingProductStatus(status = '') {
  const raw = normalizeText(status);
  const text = raw.toLowerCase();
  if (text === 'joined' || text === 'participating' || text === 'active' || raw === '已参加') return '已添加';
  if (text === 'available' || text === 'candidate' || raw === '候选') return '可添加';
  if (raw === '已添加' || raw === '可添加') return raw;
  return raw || '已添加';
}

function pickFirstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text && text !== '未返回') return text;
  }
  return '';
}

function pickMarketingPublicIdentifier(productId, ...values) {
  const safeProductId = normalizeId(productId);
  for (const value of values) {
    const text = normalizeId(value);
    if (text && text !== safeProductId) return text;
  }
  return '';
}

function parseMarketingNumber(value) {
  const rawValue = value && typeof value === 'object'
    ? value.marketing_seller_price ?? value.price ?? value.value ?? value.amount
    : value;
  const parsed = Number.parseFloat(String(rawValue ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function getMarketingSummaryProductKey(product = {}) {
  return normalizeId(product.productId ?? product.id ?? product.ozonSku ?? product.offerId ?? product.sku);
}

function getMarketingProductIssue(product = {}) {
  const price = parseMarketingNumber(product.price);
  const actionPrice = parseMarketingNumber(product.sourceActivityPrice);
  if (price === null && actionPrice === null) return '缺售价';
  const stock = parseMarketingNumber(product.stock);
  if (stock !== null && stock <= 0) return '库存不足';
  return '';
}

function getMarketingProductJoinSelectSql() {
  return `
    SELECT
      m.*,
      p.offer_id AS product_offer_id,
      p.sku AS product_sku,
      p.name AS product_name,
      p.price_value AS product_price_value,
      p.stock_value AS product_stock_value
    FROM ozon_marketing_activity_products m
    LEFT JOIN ozon_products p
      ON p.shop_id = m.shop_id
     AND p.product_id = m.product_id
     AND p.is_stale = 0
  `;
}

export function normalizeMarketingActivityProductRow(row = {}, { rowStatus = '已添加', sourceType = 'official' } = {}) {
  const productId = getMarketingProductCacheId(row);
  const offerId = normalizeId(row.offer_id ?? row.offerId);
  const raw = isPlainObject(row.raw) ? row.raw : {};
  const sku = normalizeId(row.sku ?? raw.sku);
  const ozonSku = normalizeId(row.ozon_sku ?? row.ozonSku ?? row.skuId ?? raw.ozon_sku ?? raw.ozonSku ?? sku);
  const status = normalizeMarketingProductStatus(row.status ?? row.rowStatus ?? rowStatus);
  const sourceActivityPrice = pickFirstText(row.action_price, row.actionPrice, row.discount_price, row.discountPrice, row.price?.action_price);
  const activityPrice = pickFirstText(row.activityPrice, row.activity_price, sourceActivityPrice);
  const price = pickFirstText(row.price?.price, row.marketing_seller_price, row.price, row.base_price, row.basePrice);
  const stock = pickFirstText(row.stock, row.stocks?.present, row.present, row.available_stock, row.availableStock);
  const review = pickFirstText(row.review, row.status_description, row.statusDescription) || (status === '已添加' ? '已确认' : '可处理');
  const normalized = {
    productId,
    sourceType: normalizeMarketingSourceType(sourceType ?? row.sourceType ?? row.source_type),
    name: pickFirstText(row.name, row.title, row.offer_name, row.product_name) || productId || offerId || sku,
    offerId,
    sku,
    ozonSku,
    rowStatus: status,
    sourceActivityPrice,
    activityPrice,
    price,
    stock,
    review,
    statusTone: status === '已添加' ? 'success' : 'warning',
    reviewTone: /缺|不足|错误|失败|invalid|error/iu.test(review) ? 'error' : status === '已添加' ? 'success' : 'warning',
    raw: row,
  };
  normalized.remoteHash = createStableHash(normalized, { length: 32 });
  return normalized.productId ? normalized : null;
}

export function toPublicMarketingActivityProduct(row = {}) {
  const raw = safeJsonParse(row.raw_json, {});
  const productId = row.product_id || raw.product_id || raw.productId || raw.id || '';
  const offerId = pickMarketingPublicIdentifier(productId, row.offer_id, raw.offer_id, raw.offerId, row.product_offer_id);
  const ozonSku = pickMarketingPublicIdentifier(
    productId,
    row.ozon_sku,
    raw.ozon_sku,
    raw.ozonSku,
    raw.sku,
    row.product_sku,
    row.sku,
  );
  const sku = pickMarketingPublicIdentifier(productId, row.sku, raw.sku);
  const price = pickFirstText(row.price, raw.price?.price, raw.price?.marketing_seller_price, raw.marketing_seller_price, raw.base_price, raw.basePrice, row.product_price_value);
  const stock = pickFirstText(row.product_stock_value, row.stock, raw.stock, raw.stocks?.present, raw.present, raw.available_stock, raw.availableStock);
  return {
    id: productId,
    productId,
    name: row.product_name || row.name || raw.name || raw.title || productId,
    offerId,
    ozonSku,
    sku: sku || offerId || ozonSku || '',
    price,
    sourceActivityPrice: row.source_activity_price || raw.action_price || raw.actionPrice || '',
    activityPrice: row.activity_price || row.source_activity_price || raw.action_price || raw.actionPrice || '',
    stock,
    status: row.row_status || '',
    statusTone: row.status_tone || (row.row_status === '已添加' ? 'success' : 'warning'),
    review: row.review || '',
    reviewTone: row.review_tone || (row.row_status === '已添加' ? 'success' : 'warning'),
    raw,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function normalizeLegacyMarketingActivity(row, index) {
  const source = assertLegacyPlainObject(row, `snapshot.activityRows[${index}]`);
  assertLegacyAllowedFields(source, LEGACY_MARKETING_ACTIVITY_FIELDS, `snapshot.activityRows[${index}]`);
  const activityId = normalizeLegacyId(source.id, `snapshot.activityRows[${index}].id`);
  const sourceType = normalizeLegacySourceType(source.sourceType, `snapshot.activityRows[${index}].sourceType`);
  const originalTitle = normalizeLegacyText(source.originalTitle, {
    path: `snapshot.activityRows[${index}].originalTitle`,
    maxLength: 2_048,
  });
  const title = normalizeLegacyText(source.title, {
    path: `snapshot.activityRows[${index}].title`,
    maxLength: 2_048,
  }) || originalTitle || `活动 ${activityId}`;
  const availableWasSupplied = Object.hasOwn(source, 'available');
  return {
    activityId,
    sourceType,
    sourceLabel: normalizeLegacyText(source.source, {
      path: `snapshot.activityRows[${index}].source`,
      maxLength: 256,
    }) || (sourceType === 'seller' ? '商家自主' : '平台活动'),
    sourceTone: normalizeLegacyText(source.sourceTone, {
      path: `snapshot.activityRows[${index}].sourceTone`,
      maxLength: 80,
    }),
    title,
    originalTitle: originalTitle || title,
    description: normalizeLegacyText(source.description, {
      path: `snapshot.activityRows[${index}].description`,
      maxLength: 8_192,
    }),
    joinedCount: normalizeLegacyNonNegativeInt(source.count, {
      path: `snapshot.activityRows[${index}].count`,
    }),
    availableCount: normalizeLegacyNonNegativeInt(source.available, {
      path: `snapshot.activityRows[${index}].available`,
    }),
    hasAvailableCount: normalizeLegacyBoolean(source.hasAvailableCount, {
      path: `snapshot.activityRows[${index}].hasAvailableCount`,
      fallback: availableWasSupplied,
    }),
    estimate: normalizeLegacyText(source.estimate, {
      path: `snapshot.activityRows[${index}].estimate`,
      maxLength: 1_024,
    }),
    dateStart: normalizeLegacyText(source.dateStart, {
      path: `snapshot.activityRows[${index}].dateStart`,
      maxLength: 128,
    }),
    dateEnd: normalizeLegacyText(source.dateEnd, {
      path: `snapshot.activityRows[${index}].dateEnd`,
      maxLength: 128,
    }),
    // isOnline is intentionally validated but not stored: it is a derived view
    // of date_start/date_end, not a second mutable marketing fact.
    isOnline: normalizeLegacyBoolean(source.isOnline, {
      path: `snapshot.activityRows[${index}].isOnline`,
      fallback: true,
    }),
  };
}

function normalizeLegacyMarketingProduct(row, index) {
  const source = assertLegacyPlainObject(row, `snapshot.productPool[${index}]`);
  assertLegacyAllowedFields(source, LEGACY_MARKETING_PRODUCT_FIELDS, `snapshot.productPool[${index}]`);
  const rawStatus = normalizeLegacyText(source.status, {
    path: `snapshot.productPool[${index}].status`,
    maxLength: 80,
  });
  const rowStatus = normalizeMarketingProductStatus(rawStatus || '已添加');
  if (!['已添加', '可添加'].includes(rowStatus)) {
    throw legacyError('MARKETING_LEGACY_PRODUCT_STATUS_INVALID', `snapshot.productPool[${index}].status`);
  }
  return {
    productId: normalizeLegacyId(source.id, `snapshot.productPool[${index}].id`),
    name: normalizeLegacyText(source.name, {
      path: `snapshot.productPool[${index}].name`,
      maxLength: 2_048,
    }),
    offerId: normalizeLegacyText(source.offerId, {
      path: `snapshot.productPool[${index}].offerId`,
      maxLength: 260,
      allowNumber: true,
    }),
    ozonSku: normalizeLegacyText(source.ozonSku, {
      path: `snapshot.productPool[${index}].ozonSku`,
      maxLength: 260,
      allowNumber: true,
    }),
    sku: normalizeLegacyText(source.sku, {
      path: `snapshot.productPool[${index}].sku`,
      maxLength: 260,
      allowNumber: true,
    }),
    rowStatus,
    sourceActivityPrice: normalizeLegacyText(source.sourceActivityPrice, {
      path: `snapshot.productPool[${index}].sourceActivityPrice`,
      maxLength: 160,
      allowNumber: true,
    }),
    activityPrice: normalizeLegacyText(source.activityPrice, {
      path: `snapshot.productPool[${index}].activityPrice`,
      maxLength: 160,
      allowNumber: true,
    }),
    price: normalizeLegacyText(source.price, {
      path: `snapshot.productPool[${index}].price`,
      maxLength: 160,
      allowNumber: true,
    }),
    stock: normalizeLegacyText(source.stock, {
      path: `snapshot.productPool[${index}].stock`,
      maxLength: 160,
      allowNumber: true,
    }),
    review: normalizeLegacyText(source.review, {
      path: `snapshot.productPool[${index}].review`,
      maxLength: 2_048,
    }) || (rowStatus === '已添加' ? '已确认' : '可处理'),
    statusTone: normalizeLegacyText(source.statusTone, {
      path: `snapshot.productPool[${index}].statusTone`,
      maxLength: 80,
    }) || (rowStatus === '已添加' ? 'success' : 'warning'),
    reviewTone: normalizeLegacyText(source.reviewTone, {
      path: `snapshot.productPool[${index}].reviewTone`,
      maxLength: 80,
    }) || (rowStatus === '已添加' ? 'success' : 'warning'),
  };
}

function normalizeLegacyMarketingSummary(value, { activities, products } = {}) {
  const source = value === undefined || value === null
    ? {}
    : assertLegacyPlainObject(value, 'snapshot.marketingSummary');
  assertLegacyAllowedFields(source, LEGACY_MARKETING_SUMMARY_FIELDS, 'snapshot.marketingSummary');
  const defaultActivityTotal = activities.length;
  const defaultJoinedActivityTotal = activities.filter((activity) => activity.joinedCount > 0).length;
  const defaultJoinedProductTotal = products.filter((product) => product.rowStatus === '已添加').length;
  const defaultIssueProductTotal = products.filter((product) => (
    product.reviewTone === 'error' || /缺|不足|错误|失败|invalid|error/iu.test(product.review)
  )).length;
  return {
    activityTotal: normalizeLegacyNonNegativeInt(source.activityTotal, {
      path: 'snapshot.marketingSummary.activityTotal',
      fallback: defaultActivityTotal,
    }),
    joinedActivityTotal: normalizeLegacyNonNegativeInt(source.joinedActivityTotal, {
      path: 'snapshot.marketingSummary.joinedActivityTotal',
      fallback: defaultJoinedActivityTotal,
    }),
    joinedProductTotal: normalizeLegacyNonNegativeInt(source.joinedProductTotal, {
      path: 'snapshot.marketingSummary.joinedProductTotal',
      fallback: defaultJoinedProductTotal,
    }),
    issueProductTotal: normalizeLegacyNonNegativeInt(source.issueProductTotal, {
      path: 'snapshot.marketingSummary.issueProductTotal',
      fallback: defaultIssueProductTotal,
    }),
  };
}

function normalizeLegacyMarketingSnapshot(value) {
  const source = assertLegacyPlainObject(value, 'snapshot');
  assertLegacyAllowedFields(source, LEGACY_MARKETING_SNAPSHOT_FIELDS, 'snapshot');
  if (!Array.isArray(source.activityRows)) throw legacyError('MARKETING_LEGACY_ARRAY_REQUIRED', 'snapshot.activityRows');
  if (!Array.isArray(source.productPool)) throw legacyError('MARKETING_LEGACY_ARRAY_REQUIRED', 'snapshot.productPool');
  if (source.activityRows.length > LEGACY_MARKETING_SNAPSHOT_MAX_ACTIVITIES) {
    throw legacyError('MARKETING_LEGACY_ARRAY_TOO_LARGE', 'snapshot.activityRows');
  }
  if (source.productPool.length > LEGACY_MARKETING_SNAPSHOT_MAX_PRODUCTS) {
    throw legacyError('MARKETING_LEGACY_ARRAY_TOO_LARGE', 'snapshot.productPool');
  }
  const activities = source.activityRows.map(normalizeLegacyMarketingActivity);
  const products = source.productPool.map(normalizeLegacyMarketingProduct);
  if (!activities.length) throw legacyError('MARKETING_LEGACY_SNAPSHOT_EMPTY', 'snapshot.activityRows');
  const activityKeys = new Set();
  activities.forEach((activity) => {
    const key = `${activity.activityId}:${activity.sourceType}`;
    if (activityKeys.has(key)) throw legacyError('MARKETING_LEGACY_ACTIVITY_DUPLICATE', key);
    activityKeys.add(key);
  });
  const productIds = new Set();
  products.forEach((product) => {
    if (productIds.has(product.productId)) throw legacyError('MARKETING_LEGACY_PRODUCT_DUPLICATE', product.productId);
    productIds.add(product.productId);
  });

  const selectedActivityId = Object.hasOwn(source, 'selectedActivityId') && source.selectedActivityId !== ''
    ? normalizeLegacyId(source.selectedActivityId, 'snapshot.selectedActivityId')
    : activities[0].activityId;
  const selectedSourceWasSupplied = Object.hasOwn(source, 'selectedSourceType')
    && source.selectedSourceType !== '';
  const requestedSourceType = selectedSourceWasSupplied
    ? normalizeLegacySourceType(source.selectedSourceType, 'snapshot.selectedSourceType')
    : '';
  const activityCandidates = activities.filter((activity) => activity.activityId === selectedActivityId);
  if (!activityCandidates.length) throw legacyError('MARKETING_LEGACY_SELECTED_ACTIVITY_UNMAPPED', selectedActivityId);
  const selectedCandidates = requestedSourceType
    ? activityCandidates.filter((activity) => activity.sourceType === requestedSourceType)
    : activityCandidates;
  if (!selectedCandidates.length) throw legacyError('MARKETING_LEGACY_SELECTED_SOURCE_UNMAPPED', selectedActivityId);
  if (selectedCandidates.length !== 1) throw legacyError('MARKETING_LEGACY_SELECTED_ACTIVITY_AMBIGUOUS', selectedActivityId);
  const selectedActivity = selectedCandidates[0];
  const selectedProductIds = parseSelectedProductIds(source.selectedProductIds, 'snapshot.selectedProductIds');
  selectedProductIds.forEach((productId) => {
    if (!productIds.has(productId)) {
      throw legacyError('MARKETING_LEGACY_SELECTED_PRODUCT_UNMAPPED', productId);
    }
  });
  const productScope = normalizeLegacyProductScope(source.productScope, 'snapshot.productScope');
  const summary = normalizeLegacyMarketingSummary(source.marketingSummary, { activities, products });
  const cachedAt = normalizeLegacyText(source.cachedAt, {
    path: 'snapshot.cachedAt',
    maxLength: 128,
  });
  return {
    activities,
    products,
    viewState: {
      selectedActivityId,
      selectedSourceType: selectedActivity.sourceType,
      productScope,
      selectedProductIds,
      ...summary,
      cachedAt,
    },
  };
}

function safeSelectedProductIdsJson(value) {
  const parsed = safeJsonParse(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item))
    .filter(Boolean)
    .slice(0, LEGACY_MARKETING_SNAPSHOT_MAX_SELECTED_PRODUCTS);
}

function toPublicMarketingViewState(row = {}) {
  if (!row?.shop_id) return null;
  return {
    shopId: row.shop_id,
    selectedActivityId: row.selected_activity_id || '',
    selectedSourceType: row.selected_source_type || '',
    productScope: ['joined', 'available', 'all'].includes(row.product_scope) ? row.product_scope : 'joined',
    selectedProductIds: safeSelectedProductIdsJson(row.selected_product_ids_json),
    marketingSummary: {
      activityTotal: Number(row.activity_total) || 0,
      joinedActivityTotal: Number(row.joined_activity_total) || 0,
      joinedProductTotal: Number(row.joined_product_total) || 0,
      issueProductTotal: Number(row.issue_product_total) || 0,
    },
    // 054 marks pre-counter rows as uninitialized. Their stored zero defaults
    // are not a business summary and must be derived from canonical facts.
    summaryInitialized: Number(row.summary_initialized) === 1,
    cachedAt: row.cached_at || '',
    updatedAt: row.updated_at || null,
  };
}

const MARKETING_VIEW_STATE_FIELDS = new Set([
  'selectedActivityId',
  'selectedSourceType',
  'productScope',
  'selectedProductIds',
  'marketingSummary',
  'cachedAt',
]);

function runMarketingWriteTransaction(db, work) {
  if (db.isTransaction) return work();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

function normalizeMarketingViewStateInput(value, { fallback = {} } = {}) {
  const source = assertLegacyPlainObject(value, 'viewState');
  assertLegacyAllowedFields(source, MARKETING_VIEW_STATE_FIELDS, 'viewState');
  const rawFallbackSummary = isPlainObject(fallback.marketingSummary) ? fallback.marketingSummary : {};
  const fallbackSummary = Object.fromEntries(
    Object.entries(rawFallbackSummary).filter(([key]) => LEGACY_MARKETING_SUMMARY_FIELDS.has(key)),
  );
  const selectedActivityId = Object.hasOwn(source, 'selectedActivityId')
    ? (source.selectedActivityId === '' ? '' : normalizeLegacyId(source.selectedActivityId, 'viewState.selectedActivityId'))
    : String(fallback.selectedActivityId || '');
  const selectedSourceType = Object.hasOwn(source, 'selectedSourceType')
    ? (source.selectedSourceType === '' ? '' : normalizeLegacySourceType(source.selectedSourceType, 'viewState.selectedSourceType'))
    : String(fallback.selectedSourceType || '');
  const productScope = Object.hasOwn(source, 'productScope')
    ? normalizeLegacyProductScope(source.productScope, 'viewState.productScope')
    : normalizeLegacyProductScope(fallback.productScope, 'viewState.productScope');
  const selectedProductIds = Object.hasOwn(source, 'selectedProductIds')
    ? parseSelectedProductIds(source.selectedProductIds, 'viewState.selectedProductIds')
    : Array.isArray(fallback.selectedProductIds) ? fallback.selectedProductIds.map(String) : [];
  const explicitSummary = Object.hasOwn(source, 'marketingSummary')
    ? assertLegacyPlainObject(source.marketingSummary, 'viewState.marketingSummary')
    : {};
  assertLegacyAllowedFields(explicitSummary, LEGACY_MARKETING_SUMMARY_FIELDS, 'viewState.marketingSummary');
  const summarySource = { ...fallbackSummary, ...explicitSummary };
  const summary = normalizeLegacyMarketingSummary(summarySource, {
    activities: Array.from({ length: Number(fallbackSummary.activityTotal) || 0 }, () => ({ joinedCount: 0 })),
    products: [],
  });
  const cachedAt = Object.hasOwn(source, 'cachedAt')
    ? normalizeLegacyText(source.cachedAt, { path: 'viewState.cachedAt', maxLength: 128 })
    : String(fallback.cachedAt || '');
  return {
    selectedActivityId,
    selectedSourceType,
    productScope,
    selectedProductIds,
    ...summary,
    cachedAt,
  };
}

export function createMarketingRepository(db) {
  function upsertActivities({ shopId, sourceType = 'official', sourceLabel = '', rows = [] } = {}) {
    const safeShopId = normalizeId(shopId);
    if (!safeShopId) throw new Error('marketing activity upsert requires shopId.');
    const timestamp = nowIso();
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;
    const normalizedRows = rows
      .map((row) => normalizeMarketingActivityRow(row, { sourceType, sourceLabel }))
      .filter(Boolean);

    const existingStatement = db.prepare(`
      SELECT remote_hash FROM ozon_marketing_activities
      WHERE shop_id = ? AND activity_id = ? AND source_type = ?
    `);
    const upsertStatement = db.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end, raw_json, remote_hash,
        first_seen_at, last_seen_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, activity_id, source_type) DO UPDATE SET
        source_label = excluded.source_label,
        source_tone = excluded.source_tone,
        title = excluded.title,
        original_title = excluded.original_title,
        description = excluded.description,
        joined_count = excluded.joined_count,
        available_count = excluded.available_count,
        has_available_count = excluded.has_available_count,
        estimate = excluded.estimate,
        date_start = excluded.date_start,
        date_end = excluded.date_end,
        raw_json = excluded.raw_json,
        remote_hash = excluded.remote_hash,
        last_seen_at = excluded.last_seen_at,
        updated_at = CASE
          WHEN ozon_marketing_activities.remote_hash = excluded.remote_hash THEN ozon_marketing_activities.updated_at
          ELSE excluded.updated_at
        END
    `);

    runMarketingWriteTransaction(db, () => {
      for (const item of normalizedRows) {
        if (!item.activityId) {
          skipped += 1;
          continue;
        }
        const existing = existingStatement.get(safeShopId, item.activityId, item.sourceType);
        if (existing?.remote_hash === item.remoteHash) unchanged += 1;
        else changed += 1;
        upsertStatement.run(
          safeShopId,
          item.activityId,
          item.sourceType,
          item.sourceLabel,
          item.sourceTone,
          item.title,
          item.originalTitle,
          item.description,
          item.joinedCount,
          item.availableCount,
          toSqlBool(item.hasAvailableCount),
          item.estimate,
          item.dateStart,
          item.dateEnd,
          stringify(item.raw),
          item.remoteHash,
          timestamp,
          timestamp,
          timestamp,
        );
      }
    });
    return { ok: true, changed, unchanged, skipped, rows: normalizedRows.length };
  }

  function upsertActivityProducts({ shopId, activityId, sourceType = 'official', rowStatus = '已添加', rows = [], markStale = true } = {}) {
    const safeShopId = normalizeId(shopId);
    const safeActivityId = normalizeId(activityId);
    const safeSourceType = normalizeMarketingSourceType(sourceType);
    const safeRowStatus = normalizeMarketingProductStatus(rowStatus);
    if (!safeShopId) throw new Error('marketing product upsert requires shopId.');
    if (!safeActivityId) throw new Error('marketing product upsert requires activityId.');
    const timestamp = nowIso();
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;
    const normalizedRows = rows
      .map((row) => normalizeMarketingActivityProductRow(row, { rowStatus: safeRowStatus, sourceType: safeSourceType }))
      .filter(Boolean);

    const existingStatement = db.prepare(`
      SELECT remote_hash FROM ozon_marketing_activity_products
      WHERE shop_id = ? AND activity_id = ? AND source_type = ? AND product_id = ?
    `);
    const upsertStatement = db.prepare(`
      INSERT INTO ozon_marketing_activity_products (
        shop_id, activity_id, source_type, product_id, offer_id, sku, ozon_sku, name, row_status,
        source_activity_price, activity_price, price, stock, review, status_tone, review_tone,
        raw_json, remote_hash, is_stale, first_seen_at, last_seen_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(shop_id, activity_id, source_type, product_id) DO UPDATE SET
        offer_id = excluded.offer_id,
        sku = excluded.sku,
        ozon_sku = excluded.ozon_sku,
        name = excluded.name,
        row_status = excluded.row_status,
        source_activity_price = excluded.source_activity_price,
        activity_price = excluded.activity_price,
        price = excluded.price,
        stock = excluded.stock,
        review = excluded.review,
        status_tone = excluded.status_tone,
        review_tone = excluded.review_tone,
        raw_json = excluded.raw_json,
        remote_hash = excluded.remote_hash,
        is_stale = 0,
        last_seen_at = excluded.last_seen_at,
        updated_at = CASE
          WHEN ozon_marketing_activity_products.remote_hash = excluded.remote_hash THEN ozon_marketing_activity_products.updated_at
          ELSE excluded.updated_at
        END
    `);

    const seen = new Set();
    runMarketingWriteTransaction(db, () => {
      if (markStale) {
        db.prepare(`
          UPDATE ozon_marketing_activity_products
          SET is_stale = 1, updated_at = ?
          WHERE shop_id = ? AND activity_id = ? AND source_type = ? AND row_status = ?
        `).run(timestamp, safeShopId, safeActivityId, safeSourceType, safeRowStatus);
      }
      for (const item of normalizedRows) {
        if (!item.productId || seen.has(item.productId)) {
          skipped += 1;
          continue;
        }
        seen.add(item.productId);
        const existing = existingStatement.get(safeShopId, safeActivityId, safeSourceType, item.productId);
        if (existing?.remote_hash === item.remoteHash) unchanged += 1;
        else changed += 1;
        upsertStatement.run(
          safeShopId,
          safeActivityId,
          safeSourceType,
          item.productId,
          item.offerId,
          item.sku,
          item.ozonSku,
          item.name,
          item.rowStatus,
          item.sourceActivityPrice,
          item.activityPrice,
          item.price,
          item.stock,
          item.review,
          item.statusTone,
          item.reviewTone,
          stringify(item.raw),
          item.remoteHash,
          timestamp,
          timestamp,
          timestamp,
        );
      }
    });
    return { ok: true, changed, unchanged, skipped, rows: seen.size, rowStatus: safeRowStatus };
  }

  function listActivities(query = {}) {
    const shopId = normalizeId(query.shopId ?? query.shop_id);
    const sourceTypeInput = normalizeText(query.sourceType ?? query.source_type);
    const sourceType = sourceTypeInput ? normalizeMarketingSourceType(sourceTypeInput) : '';
    const includeEnded = query.includeEnded === true || normalizeText(query.includeEnded ?? query.include_ended) === 'true';
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? query.limit) || 100, 1), 1000);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const where = [];
    const params = [];
    if (shopId) {
      where.push('shop_id = ?');
      params.push(shopId);
    }
    if (sourceType) {
      where.push('source_type = ?');
      params.push(sourceType);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const allRows = db.prepare(`
      SELECT * FROM ozon_marketing_activities
      ${whereSql}
      ORDER BY updated_at DESC, source_type ASC, activity_id ASC
    `).all(...params);
    const onlineRows = includeEnded ? allRows : allRows.filter((row) => isMarketingActivityOnline(row));
    const rows = onlineRows.slice(offset, offset + pageSize);
    return {
      ok: true,
      domain: 'marketing',
      scope: 'activities',
      page,
      pageSize,
      total: onlineRows.length,
      activityRows: rows.map(toPublicMarketingActivity),
      rows: rows.map(toPublicMarketingActivity),
      source: 'sqlite',
    };
  }

  function listActivityProducts(query = {}) {
    const shopId = normalizeId(query.shopId ?? query.shop_id);
    const activityId = normalizeId(query.activityId ?? query.activity_id);
    const sourceTypeInput = normalizeText(query.sourceType ?? query.source_type);
    const sourceType = sourceTypeInput ? normalizeMarketingSourceType(sourceTypeInput) : '';
    const scope = normalizeText(query.scope || 'products');
    const productScope = normalizeText(query.productScope ?? query.product_scope ?? query.range) || 'all';
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? query.limit) || 100, 1), 1000);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const where = ['m.is_stale = 0'];
    const params = [];
    if (shopId) {
      where.push('m.shop_id = ?');
      params.push(shopId);
    }
    if (activityId) {
      where.push('m.activity_id = ?');
      params.push(activityId);
    }
    if (sourceType) {
      where.push('m.source_type = ?');
      params.push(sourceType);
    }
    if (productScope === 'joined') {
      where.push('m.row_status = ?');
      params.push('已添加');
    } else if (productScope === 'available') {
      where.push('m.row_status = ?');
      params.push('可添加');
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS count FROM ozon_marketing_activity_products m ${whereSql}`).get(...params).count;
    const countsWhere = ['m.is_stale = 0'];
    const countsParams = [];
    if (shopId) {
      countsWhere.push('m.shop_id = ?');
      countsParams.push(shopId);
    }
    if (activityId) {
      countsWhere.push('m.activity_id = ?');
      countsParams.push(activityId);
    }
    if (sourceType) {
      countsWhere.push('m.source_type = ?');
      countsParams.push(sourceType);
    }
    const counts = db.prepare(`
      SELECT m.row_status, COUNT(*) AS count
      FROM ozon_marketing_activity_products m
      WHERE ${countsWhere.join(' AND ')}
      GROUP BY m.row_status
    `).all(...countsParams);
    const countMap = Object.fromEntries(counts.map((row) => [row.row_status, Number(row.count) || 0]));
    const rows = db.prepare(`
      ${getMarketingProductJoinSelectSql()}
      ${whereSql}
      ORDER BY m.row_status ASC, m.updated_at DESC, m.product_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    const productPool = rows.map(toPublicMarketingActivityProduct);
    return {
      ok: true,
      domain: 'marketing',
      scope,
      productScope,
      page,
      pageSize,
      total,
      joinedTotal: countMap['已添加'] || 0,
      availableTotal: countMap['可添加'] || 0,
      productPool,
      rows: productPool,
      source: 'sqlite',
    };
  }

  function readSummary(query = {}) {
    const shopId = normalizeId(query.shopId ?? query.shop_id);
    const sourceTypeInput = normalizeText(query.sourceType ?? query.source_type);
    const sourceType = sourceTypeInput ? normalizeMarketingSourceType(sourceTypeInput) : '';
    const activityWhere = [];
    const activityParams = [];
    if (shopId) {
      activityWhere.push('shop_id = ?');
      activityParams.push(shopId);
    }
    if (sourceType) {
      activityWhere.push('source_type = ?');
      activityParams.push(sourceType);
    }
    const activityWhereSql = activityWhere.length ? `WHERE ${activityWhere.join(' AND ')}` : '';
    const activitySummary = db.prepare(`
      SELECT
        COUNT(*) AS activity_total,
        SUM(CASE WHEN joined_count > 0 THEN 1 ELSE 0 END) AS joined_activity_total,
        MAX(updated_at) AS activity_updated_at
      FROM ozon_marketing_activities
      ${activityWhereSql}
    `).get(...activityParams);

    const productWhere = ['m.is_stale = 0'];
    const productParams = [];
    if (shopId) {
      productWhere.push('m.shop_id = ?');
      productParams.push(shopId);
    }
    if (sourceType) {
      productWhere.push('m.source_type = ?');
      productParams.push(sourceType);
    }
    const productSummary = db.prepare(`
      SELECT
        COUNT(*) AS cached_product_rows,
        COUNT(DISTINCT CASE WHEN m.row_status = '已添加' THEN m.product_id END) AS joined_product_total,
        COUNT(DISTINCT CASE
          WHEN (
            NULLIF(TRIM(COALESCE(m.price, '')), '') IS NULL
            AND NULLIF(TRIM(COALESCE(m.source_activity_price, '')), '') IS NULL
            AND NULLIF(TRIM(CAST(p.price_value AS TEXT)), '') IS NULL
          ) OR (
            COALESCE(
              NULLIF(TRIM(CAST(p.stock_value AS TEXT)), ''),
              NULLIF(TRIM(COALESCE(m.stock, '')), '')
            ) IS NOT NULL
            AND CAST(COALESCE(
              NULLIF(TRIM(CAST(p.stock_value AS TEXT)), ''),
              NULLIF(TRIM(COALESCE(m.stock, '')), '')
            ) AS REAL) <= 0
          )
          THEN m.product_id
        END) AS issue_product_total,
        COUNT(DISTINCT m.source_type || char(31) || m.activity_id) AS cached_activity_product_total
      FROM ozon_marketing_activity_products m
      LEFT JOIN ozon_products p
        ON p.shop_id = m.shop_id
       AND p.product_id = m.product_id
       AND p.is_stale = 0
      WHERE ${productWhere.join(' AND ')}
    `).get(...productParams);

    const summary = {
      activityTotal: Number(activitySummary?.activity_total) || 0,
      joinedActivityTotal: Number(activitySummary?.joined_activity_total) || 0,
      joinedProductTotal: Number(productSummary?.joined_product_total) || 0,
      issueProductTotal: Number(productSummary?.issue_product_total) || 0,
      cachedProductRows: Number(productSummary?.cached_product_rows) || 0,
      cachedActivityProductTotal: Number(productSummary?.cached_activity_product_total) || 0,
      source: 'sqlite',
      updatedAt: activitySummary?.activity_updated_at || null,
    };

    return {
      ok: true,
      domain: 'marketing',
      scope: 'summary',
      source: 'sqlite',
      summary,
      ...summary,
    };
  }

  function requireKnownShopId(value) {
    const shopId = normalizeId(value);
    if (!shopId) throw new Error('MARKETING_SHOP_ID_REQUIRED');
    const exists = db.prepare('SELECT 1 AS present FROM shops WHERE id = ?').get(shopId)?.present;
    if (!exists) throw new Error('MARKETING_SHOP_SCOPE_UNMAPPED');
    return shopId;
  }

  function getViewStateRow(shopId) {
    return db.prepare(`
      SELECT shop_id, selected_activity_id, selected_source_type, product_scope,
        selected_product_ids_json, activity_total, joined_activity_total,
        joined_product_total, issue_product_total, summary_initialized,
        cached_at, created_at, updated_at
      FROM marketing_view_state
      WHERE shop_id = ?
    `).get(shopId) || null;
  }

  function hasCanonicalSnapshotData(shopId) {
    const activityCount = Number(db.prepare(
      'SELECT COUNT(*) AS count FROM ozon_marketing_activities WHERE shop_id = ?',
    ).get(shopId)?.count) || 0;
    const productCount = Number(db.prepare(
      'SELECT COUNT(*) AS count FROM ozon_marketing_activity_products WHERE shop_id = ?',
    ).get(shopId)?.count) || 0;
    return {
      activityCount,
      productCount,
      hasViewState: Boolean(getViewStateRow(shopId)),
      hasAny: activityCount > 0 || productCount > 0 || Boolean(getViewStateRow(shopId)),
    };
  }

  function marketingVerificationKey(...values) {
    return values.map((value) => String(value ?? '')).join('\u001f');
  }

  /**
   * Reads the just-written canonical rows through fresh SELECT statements.  It is
   * intentionally not based on INSERT return values: a mismatch aborts the
   * surrounding transaction before the old JSON source can be considered moved.
   */
  function assertLegacyImportReadback(entry) {
    const activityRows = db.prepare(`
      SELECT activity_id, source_type, source_label, source_tone, title, original_title,
        description, joined_count, available_count, has_available_count, estimate,
        date_start, date_end
      FROM ozon_marketing_activities
      WHERE shop_id = ?
    `).all(entry.shopId);
    if (activityRows.length !== entry.snapshot.activities.length) {
      throw new Error('MARKETING_LEGACY_READBACK_ACTIVITY_COUNT_MISMATCH');
    }
    const activitiesByKey = new Map(activityRows.map((row) => [
      marketingVerificationKey(row.activity_id, row.source_type),
      row,
    ]));
    for (const activity of entry.snapshot.activities) {
      const row = activitiesByKey.get(marketingVerificationKey(activity.activityId, activity.sourceType));
      if (
        !row
        || row.source_label !== activity.sourceLabel
        || row.source_tone !== activity.sourceTone
        || row.title !== activity.title
        || row.original_title !== activity.originalTitle
        || row.description !== activity.description
        || Number(row.joined_count) !== activity.joinedCount
        || Number(row.available_count) !== activity.availableCount
        || fromSqlBool(row.has_available_count) !== activity.hasAvailableCount
        || row.estimate !== activity.estimate
        || row.date_start !== activity.dateStart
        || row.date_end !== activity.dateEnd
      ) {
        throw new Error('MARKETING_LEGACY_READBACK_ACTIVITY_MISMATCH');
      }
    }

    const productRows = db.prepare(`
      SELECT activity_id, source_type, product_id, offer_id, sku, ozon_sku, name, row_status,
        source_activity_price, activity_price, price, stock, review, status_tone, review_tone,
        is_stale
      FROM ozon_marketing_activity_products
      WHERE shop_id = ?
    `).all(entry.shopId);
    if (productRows.length !== entry.snapshot.products.length) {
      throw new Error('MARKETING_LEGACY_READBACK_PRODUCT_COUNT_MISMATCH');
    }
    const productsByKey = new Map(productRows.map((row) => [
      marketingVerificationKey(row.activity_id, row.source_type, row.product_id),
      row,
    ]));
    for (const product of entry.snapshot.products) {
      const row = productsByKey.get(marketingVerificationKey(
        entry.snapshot.viewState.selectedActivityId,
        entry.snapshot.viewState.selectedSourceType,
        product.productId,
      ));
      if (
        !row
        || row.offer_id !== product.offerId
        || row.sku !== product.sku
        || row.ozon_sku !== product.ozonSku
        || row.name !== product.name
        || row.row_status !== product.rowStatus
        || row.source_activity_price !== product.sourceActivityPrice
        || row.activity_price !== product.activityPrice
        || row.price !== product.price
        || row.stock !== product.stock
        || row.review !== product.review
        || row.status_tone !== product.statusTone
        || row.review_tone !== product.reviewTone
        || Number(row.is_stale) !== 0
      ) {
        throw new Error('MARKETING_LEGACY_READBACK_PRODUCT_MISMATCH');
      }
    }

    const viewState = toPublicMarketingViewState(getViewStateRow(entry.shopId));
    const expected = entry.snapshot.viewState;
    if (
      !viewState
      || !viewState.summaryInitialized
      || viewState.selectedActivityId !== expected.selectedActivityId
      || viewState.selectedSourceType !== expected.selectedSourceType
      || viewState.productScope !== expected.productScope
      || JSON.stringify(viewState.selectedProductIds) !== JSON.stringify(expected.selectedProductIds)
      || viewState.marketingSummary.activityTotal !== expected.activityTotal
      || viewState.marketingSummary.joinedActivityTotal !== expected.joinedActivityTotal
      || viewState.marketingSummary.joinedProductTotal !== expected.joinedProductTotal
      || viewState.marketingSummary.issueProductTotal !== expected.issueProductTotal
      || viewState.cachedAt !== expected.cachedAt
    ) {
      throw new Error('MARKETING_LEGACY_READBACK_VIEW_STATE_MISMATCH');
    }
  }

  function listSnapshotActivityRows(shopId) {
    return db.prepare(`
      SELECT * FROM ozon_marketing_activities
      WHERE shop_id = ?
      ORDER BY updated_at DESC, source_type ASC, activity_id ASC
    `).all(shopId).map(toPublicMarketingActivity);
  }

  function listSnapshotProductRows(shopId, activityId, sourceType) {
    if (!activityId || !sourceType) return [];
    return db.prepare(`
      ${getMarketingProductJoinSelectSql()}
      WHERE m.shop_id = ? AND m.activity_id = ? AND m.source_type = ? AND m.is_stale = 0
      ORDER BY m.row_status ASC, m.updated_at DESC, m.product_id ASC
      LIMIT ?
    `).all(shopId, activityId, sourceType, LEGACY_MARKETING_SNAPSHOT_MAX_PRODUCTS)
      .map(toPublicMarketingActivityProduct);
  }

  function resolveSnapshotSelection(activityRows, viewState) {
    const selectedActivityId = viewState?.selectedActivityId || activityRows[0]?.activityId || '';
    const candidates = activityRows.filter((activity) => activity.activityId === selectedActivityId);
    const selectedSourceType = viewState?.selectedSourceType || (
      candidates.length === 1 ? candidates[0].sourceType : ''
    );
    const selected = candidates.find((activity) => activity.sourceType === selectedSourceType) || null;
    return {
      selectedActivityId: selected?.activityId || '',
      selectedSourceType: selected?.sourceType || '',
    };
  }

  function readSnapshot(query = {}) {
    const shopId = normalizeId(query.shopId ?? query.shop_id);
    if (!shopId) {
      return {
        ok: false,
        domain: 'marketing',
        scope: 'snapshot',
        error: { code: 'MARKETING_SHOP_ID_REQUIRED', message: 'marketing snapshot requires shopId.' },
      };
    }
    const activityRows = listSnapshotActivityRows(shopId);
    const viewState = toPublicMarketingViewState(getViewStateRow(shopId));
    const found = activityRows.length > 0 || Boolean(viewState) || Number(db.prepare(
      'SELECT COUNT(*) AS count FROM ozon_marketing_activity_products WHERE shop_id = ?',
    ).get(shopId)?.count) > 0;
    if (!found) {
      return {
        ok: true,
        domain: 'marketing',
        scope: 'snapshot',
        source: 'sqlite',
        shopId,
        found: false,
        snapshot: null,
      };
    }
    const selection = resolveSnapshotSelection(activityRows, viewState);
    const includeProductPool = !['0', 'false', 'no'].includes(
      normalizeText(query.includeProductPool ?? query.include_product_pool).toLowerCase(),
    );
    const productPool = includeProductPool
      ? listSnapshotProductRows(shopId, selection.selectedActivityId, selection.selectedSourceType)
      : [];
    const fallbackSummary = readSummary({ shopId }).summary;
    // View state only owns the user's selection/filter.  Marketing totals are
    // facts and must always come from the canonical activity/product tables.
    // A renderer timeout or process restart can leave the persisted view-state
    // summary behind the product rows; allowing that stale value to win makes a
    // populated joined pool appear as zero on every later launch.
    const marketingSummary = {
      activityTotal: fallbackSummary.activityTotal,
      joinedActivityTotal: fallbackSummary.joinedActivityTotal,
      joinedProductTotal: fallbackSummary.joinedProductTotal,
      issueProductTotal: fallbackSummary.issueProductTotal,
    };
    const snapshot = {
      activityRows,
      productPool,
      marketingSummary,
      selectedActivityId: selection.selectedActivityId,
      selectedSourceType: selection.selectedSourceType,
      productScope: viewState?.productScope || 'joined',
      selectedProductIds: viewState?.selectedProductIds || [],
      cachedAt: viewState?.cachedAt || '',
    };
    return {
      ok: true,
      domain: 'marketing',
      scope: 'snapshot',
      source: 'sqlite',
      shopId,
      found: true,
      includesProductPool: includeProductPool,
      snapshot,
      ...snapshot,
    };
  }

  function resolveViewStateSelection(shopId, viewState) {
    if (!viewState.selectedActivityId) {
      if (viewState.selectedSourceType) throw new Error('MARKETING_VIEW_STATE_SOURCE_WITHOUT_ACTIVITY');
      return { ...viewState, selectedSourceType: '' };
    }
    const candidates = db.prepare(`
      SELECT activity_id, source_type
      FROM ozon_marketing_activities
      WHERE shop_id = ? AND activity_id = ?
      ORDER BY source_type ASC
    `).all(shopId, viewState.selectedActivityId);
    if (!candidates.length) throw new Error('MARKETING_VIEW_STATE_SELECTED_ACTIVITY_UNMAPPED');
    if (viewState.selectedSourceType) {
      if (!candidates.some((candidate) => candidate.source_type === viewState.selectedSourceType)) {
        throw new Error('MARKETING_VIEW_STATE_SELECTED_SOURCE_UNMAPPED');
      }
      return viewState;
    }
    if (candidates.length !== 1) throw new Error('MARKETING_VIEW_STATE_SELECTED_ACTIVITY_AMBIGUOUS');
    return { ...viewState, selectedSourceType: candidates[0].source_type };
  }

  function writeViewState(shopId, viewState, { createdAt = null, updatedAt = nowIso() } = {}) {
    const created = createdAt || updatedAt;
    db.prepare(`
      INSERT INTO marketing_view_state (
        shop_id, selected_activity_id, selected_source_type, product_scope,
        selected_product_ids_json, activity_total, joined_activity_total,
        joined_product_total, issue_product_total, summary_initialized,
        cached_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(shop_id) DO UPDATE SET
        selected_activity_id = excluded.selected_activity_id,
        selected_source_type = excluded.selected_source_type,
        product_scope = excluded.product_scope,
        selected_product_ids_json = excluded.selected_product_ids_json,
        activity_total = excluded.activity_total,
        joined_activity_total = excluded.joined_activity_total,
        joined_product_total = excluded.joined_product_total,
        issue_product_total = excluded.issue_product_total,
        summary_initialized = excluded.summary_initialized,
        cached_at = excluded.cached_at,
        updated_at = excluded.updated_at
    `).run(
      shopId,
      viewState.selectedActivityId,
      viewState.selectedSourceType,
      viewState.productScope,
      JSON.stringify(viewState.selectedProductIds),
      viewState.activityTotal,
      viewState.joinedActivityTotal,
      viewState.joinedProductTotal,
      viewState.issueProductTotal,
      viewState.cachedAt,
      created,
      updatedAt,
    );
    return toPublicMarketingViewState(getViewStateRow(shopId));
  }

  function saveViewState(input = {}) {
    const shopId = requireKnownShopId(input.shopId ?? input.shop_id);
    const existing = toPublicMarketingViewState(getViewStateRow(shopId));
    const fallbackSummary = existing?.summaryInitialized
      ? existing.marketingSummary
      : readSummary({ shopId }).summary;
    const flatViewState = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== 'shopId' && key !== 'shop_id'),
    );
    const viewState = normalizeMarketingViewStateInput(input.viewState ?? flatViewState, {
      fallback: {
        ...(existing || {}),
        marketingSummary: fallbackSummary,
      },
    });
    const resolved = resolveViewStateSelection(shopId, viewState);
    const saved = writeViewState(shopId, resolved, {
      createdAt: getViewStateRow(shopId)?.created_at || null,
      updatedAt: nowIso(),
    });
    return { ok: true, domain: 'marketing', scope: 'view-state', source: 'sqlite', viewState: saved };
  }

  function normalizeLegacyImportEntry(value, index) {
    const source = assertLegacyPlainObject(value, `entries[${index}]`);
    assertLegacyAllowedFields(source, new Set(['legacyScope', 'shopId', 'snapshot']), `entries[${index}]`);
    const shopId = normalizeLegacyId(source.shopId, `entries[${index}].shopId`);
    if (!Object.hasOwn(source, 'snapshot')) throw legacyError('MARKETING_LEGACY_SNAPSHOT_REQUIRED', `entries[${index}].snapshot`);
    return {
      legacyScope: Object.hasOwn(source, 'legacyScope')
        ? normalizeLegacyText(source.legacyScope, { path: `entries[${index}].legacyScope`, maxLength: 260 })
        : '',
      shopId,
      snapshot: normalizeLegacyMarketingSnapshot(source.snapshot),
    };
  }

  function importLegacySnapshots({ entries } = {}) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 64) {
      throw new Error('MARKETING_LEGACY_IMPORT_ENTRIES_INVALID');
    }
    // Validate every source before opening a transaction. Invalid, ambiguous or
    // unmapped input therefore cannot leave a partial canonical snapshot behind.
    const normalizedEntries = entries.map(normalizeLegacyImportEntry);
    const shopIds = new Set();
    normalizedEntries.forEach((entry) => {
      if (shopIds.has(entry.shopId)) throw new Error('MARKETING_LEGACY_IMPORT_SHOP_DUPLICATE');
      shopIds.add(entry.shopId);
    });

    const activityInsert = db.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end, raw_json, remote_hash,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `);
    const productInsert = db.prepare(`
      INSERT INTO ozon_marketing_activity_products (
        shop_id, activity_id, source_type, product_id, offer_id, sku, ozon_sku, name, row_status,
        source_activity_price, activity_price, price, stock, review, status_tone, review_tone,
        raw_json, remote_hash, is_stale, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 0, ?, ?, ?)
    `);
    const imported = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      // The lock closes the gap between preflight and the first INSERT.  Every
      // database-backed check runs before any shop gets a canonical row.
      normalizedEntries.forEach((entry) => {
        requireKnownShopId(entry.shopId);
        if (hasCanonicalSnapshotData(entry.shopId).hasAny) {
          throw new Error('MARKETING_LEGACY_CANONICAL_EXISTS');
        }
      });
      for (const entry of normalizedEntries) {
        const timestamp = entry.snapshot.viewState.cachedAt || nowIso();
        for (const activity of entry.snapshot.activities) {
          activityInsert.run(
            entry.shopId,
            activity.activityId,
            activity.sourceType,
            activity.sourceLabel,
            activity.sourceTone,
            activity.title,
            activity.originalTitle,
            activity.description,
            activity.joinedCount,
            activity.availableCount,
            toSqlBool(activity.hasAvailableCount),
            activity.estimate,
            activity.dateStart,
            activity.dateEnd,
            createStableHash({ shopId: entry.shopId, activity }, { length: 32 }),
            timestamp,
            timestamp,
            timestamp,
          );
        }
        for (const product of entry.snapshot.products) {
          productInsert.run(
            entry.shopId,
            entry.snapshot.viewState.selectedActivityId,
            entry.snapshot.viewState.selectedSourceType,
            product.productId,
            product.offerId,
            product.sku,
            product.ozonSku,
            product.name,
            product.rowStatus,
            product.sourceActivityPrice,
            product.activityPrice,
            product.price,
            product.stock,
            product.review,
            product.statusTone,
            product.reviewTone,
            createStableHash({ shopId: entry.shopId, product }, { length: 32 }),
            timestamp,
            timestamp,
            timestamp,
          );
        }
        writeViewState(entry.shopId, entry.snapshot.viewState, {
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        imported.push({
          shopId: entry.shopId,
          legacyScope: entry.legacyScope || null,
          activityCount: entry.snapshot.activities.length,
          productCount: entry.snapshot.products.length,
        });
      }
      normalizedEntries.forEach(assertLegacyImportReadback);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
      throw error;
    }
    return {
      ok: true,
      domain: 'marketing',
      scope: 'legacy-import',
      source: 'sqlite',
      imported,
      importedShopCount: imported.length,
      activityCount: imported.reduce((total, item) => total + item.activityCount, 0),
      productCount: imported.reduce((total, item) => total + item.productCount, 0),
      readbackVerified: true,
    };
  }

  return {
    upsertActivities,
    upsertActivityProducts,
    listActivities,
    listActivityProducts,
    readSummary,
    readSnapshot,
    saveViewState,
    importLegacySnapshots,
  };
}

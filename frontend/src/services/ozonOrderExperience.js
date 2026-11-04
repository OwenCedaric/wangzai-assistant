import { translateAfterSalesReasonToChinese } from './afterSalesReasonTranslate';
import {
  getAfterSalesCanonicalEntityKeyCandidates,
  getAfterSalesExactPostingNumber,
  getAfterSalesReturnIdentity,
} from '../shared/lib/afterSalesIdentity.js';

export const OZON_ORDER_SUPPLEMENT_CACHE_TTL_MS = 30 * 60 * 1000;
export const OZON_ORDER_SUPPLEMENT_CACHE_MAX_ENTRIES = 1200;
export const OZON_ORDER_IMAGE_PRELOAD_MAX_ENTRIES = 240;

const supplementCache = new Map();
const imagePreloadCache = new Map();
const PRODUCT_PICTURE_LOOKUP_SOURCES = new Set(['priceInfo', 'productInfo', 'pictures', 'orderRaw', 'localProduct']);

const ORDER_KEY_FIELDS = [
  'recordKey',
  'posting',
  'postingNumber',
  'posting_number',
  'salesOrder',
  'ozonPostingNumber',
  'ozonOrderId',
  'orderId',
  'id',
];

const SHOP_KEY_FIELDS = ['shopClientId', 'shopId', 'sellerId', 'shopName', 'storeName'];

const ORDER_SUPPLEMENT_FIELDS = [
  'recordKey',
  'id',
  'posting',
  'postingNumber',
  'posting_number',
  'salesOrder',
  'ozonPostingNumber',
  'ozonOrderId',
  'orderId',
  'shopClientId',
  'shopId',
  'sellerId',
  'shopName',
  'storeName',
  'commissionMode',
  'commissionPercent',
  'commissionAmount',
  'commissionSource',
];

const PRODUCT_SUPPLEMENT_FIELDS = [
  'id',
  'sku',
  'skuId',
  'offerId',
  'offer_id',
  'productId',
  'productIdSource',
  'name',
  'title',
  'image',
  'images',
  'skuImage',
  'sku_image',
  'skuImages',
  'mainImage',
  'mainImages',
  'productMainImage',
  'productMainImages',
  'primaryImage',
  'primary_image',
  'commissionMode',
  'commissionPercent',
  'commissionAmount',
  'commissionSource',
  'currencyCode',
  'salesAmountValue',
  'acquiringAmount',
  'acquiringPercent',
];

const AFTER_SALES_LOCKED_CLASSIFICATION_FIELDS = [
  'status',
  'type',
  'tone',
  'classificationVersion',
  'classificationConfidence',
  'classificationReason',
  'excludeFromAfterSales',
  'refusedEvidence',
  'destroyedEvidence',
  'blockedEvidence',
  'deliveredEvidence',
  'shippedEvidence',
  'originalOrderCancelledEvidence',
  'originalOrderDeliveredEvidence',
  'timeline',
];

const AFTER_SALES_CLASSIFICATION_EVIDENCE_FIELDS = [
  'refusedEvidence',
  'destroyedEvidence',
  'blockedEvidence',
  'deliveredEvidence',
  'shippedEvidence',
  'originalOrderCancelledEvidence',
  'originalOrderDeliveredEvidence',
  'timeline',
];

const AFTER_SALES_REFUSED_REFUND_STATUS = '拒收后退款';
const AFTER_SALES_SIGNED_REFUND_STATUS = '签收后退款';
const AFTER_SALES_CLASSIFICATION_VALUES = new Set([
  '发货前取消',
  '发货后取消',
  AFTER_SALES_REFUSED_REFUND_STATUS,
  AFTER_SALES_SIGNED_REFUND_STATUS,
]);

const AFTER_SALES_REASON_FIELD_KEYS = new Set([
  'reason',
  'reason_name',
  'reasonname',
  'reason_message',
  'reasonmessage',
  'return_reason',
  'returnreason',
  'return_reason_name',
  'returnreasonname',
  'return_reason_message',
  'returnreasonmessage',
  'refund_reason',
  'refundreason',
  'refund_reason_name',
  'refundreasonname',
  'cancel_reason',
  'cancelreason',
  'cancel_reason_name',
  'cancelreasonname',
  'cancel_reason_message',
  'cancelreasonmessage',
  'cancellation_reason',
  'cancellationreason',
  'cancellation_reason_name',
  'cancellationreasonname',
  'cancellation_reason_message',
  'cancellationreasonmessage',
  'buyer_comment',
  'buyercomment',
  'customer_comment',
  'customercomment',
  'comment',
  'message',
  'explanation',
]);

const AFTER_SALES_REASON_TEXT_KEYS = [
  'name',
  'title',
  'text',
  'message',
  'description',
  'value',
  'comment',
  'display_name',
  'displayName',
  'localized_name',
  'localizedName',
];

const AFTER_SALES_REASON_SKIP_OBJECT_KEYS =
  /^(skus?|images?|pictures?|barcodes?|financial|finance|financeRefundEvidence|finance_refund_evidence|analytics_data|customer|buyer|delivery_address|address|prices?)$/i;
const AFTER_SALES_REASON_MAX_DEPTH = 8;

const OZON_AFTER_SALES_REASON_ID_TRANSLATIONS = new Map([
  ['20', '配件或商品不完整'],
  ['22', '配送了错误的商品'],
  ['32', '商品不合适'],
  ['79', '买家收货时拒收：商品不合适'],
  ['352', '仓库商品已售完'],
  ['402', '卖家取消订单'],
  ['506', '买家取消订单：找到了更便宜的商品'],
  ['505', '买家取消订单：配送时效不符合预期'],
  ['508', '买家取消订单'],
  ['512', '未能配送商品'],
  ['537', '买家未取件'],
  ['578', '买家收货时拒收：商品不合适'],
  ['587', '买家拒收：对商品质量不满意'],
  ['665', '买家未取件'],
  ['685', '买家应您的请求取消订单'],
  ['686', '您未按时发货'],
  ['710', '买家取消订单'],
  ['940', '货件未通过清关'],
  ['992', 'Ozon 检查商品是否符合商品卡描述'],
]);

export function translateOzonAfterSalesReasonToChinese(value = '') {
  return translateAfterSalesReasonToChinese(value);
}

function nowMs() {
  return Date.now();
}

function normalizeKeyPart(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeAfterSalesClassificationStatus(value) {
  return normalizeKeyPart(value);
}

function isAfterSalesRefusedRefundStatus(value) {
  const status = normalizeAfterSalesClassificationStatus(value);
  return status === AFTER_SALES_REFUSED_REFUND_STATUS || status === '\u62d2\u6536\u540e\u9000\u6b3e';
}

function isAfterSalesSignedRefundStatus(value) {
  const status = normalizeAfterSalesClassificationStatus(value);
  return status === AFTER_SALES_SIGNED_REFUND_STATUS || status === '\u7b7e\u6536\u540e\u9000\u6b3e';
}

function firstFilled(...values) {
  return values.map(normalizeKeyPart).find(Boolean) || '';
}

function normalizeReasonKey(key) {
  return normalizeKeyPart(key)
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function isAfterSalesReasonKey(key) {
  const normalized = normalizeReasonKey(key);
  if (normalized === 'classification_reason' || normalized === 'classificationreason') return false;
  return (
    AFTER_SALES_REASON_FIELD_KEYS.has(normalized) || /(^|_)(reason|comment|message|explanation)(_|$)/i.test(normalized)
  );
}

function isUsableAfterSalesReasonText(value) {
  const text = normalizeKeyPart(value);
  if (!text || text === '-' || text === '未返回' || text === '待确认' || text === '读取失败') return false;
  if (text === '[object Object]' || /^https?:\/\//i.test(text)) return false;
  if (/财务流水.*(退款|扣款|冲正|核查|证据)|已同时核查母单/.test(text)) return false;
  return !/^\d+$/.test(text);
}

function readAfterSalesReasonId(source, seen = new WeakSet(), depth = 0) {
  if (source === null || source === undefined || depth > AFTER_SALES_REASON_MAX_DEPTH) return '';
  if (Array.isArray(source)) {
    for (const item of source) {
      const candidate = readAfterSalesReasonId(item, seen, depth + 1);
      if (candidate) return candidate;
    }
    return '';
  }
  if (typeof source !== 'object') return '';
  if (seen.has(source)) return '';
  seen.add(source);

  const explicit = firstFilled(
    source.cancel_reason_id,
    source.cancelReasonId,
    source.cancellation_reason_id,
    source.cancellationReasonId,
    source.reason_id,
    source.reasonId,
    source.return_reason_id,
    source.returnReasonId,
    source.refund_reason_id,
    source.refundReasonId
  );
  if (explicit) return explicit;

  for (const [key, value] of Object.entries(source)) {
    if (value === null || typeof value !== 'object') continue;
    if (AFTER_SALES_REASON_SKIP_OBJECT_KEYS.test(key)) continue;
    const candidate = readAfterSalesReasonId(value, seen, depth + 1);
    if (candidate) return candidate;
  }
  return '';
}

function getAfterSalesReasonIdLabel(source = {}) {
  const reasonId = firstFilled(
    source.return_reason?.id,
    source.returnReason?.id,
    source.raw?.return_reason?.id,
    source.detail?.return_reason?.id,
    source.listItem?.return_reason?.id,
    readAfterSalesReasonId(source)
  );
  return reasonId ? OZON_AFTER_SALES_REASON_ID_TRANSLATIONS.get(String(reasonId)) || '' : '';
}

function isGenericAfterSalesReasonLabel(value = '') {
  return normalizeKeyPart(value) === '其他售后原因';
}

function isAfterSalesReasonTranslationPlaceholder(value = '') {
  const text = normalizeKeyPart(value);
  return text === '售后原因翻译中' || text === '售后原因翻译暂不可用';
}

function readAfterSalesReasonCandidate(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = readAfterSalesReasonCandidate(item, seen, depth + 1);
      if (candidate) return candidate;
    }
    return '';
  }
  if (typeof value !== 'object') {
    const text = normalizeKeyPart(value);
    return isUsableAfterSalesReasonText(text) ? text : '';
  }
  if (seen.has(value) || depth > AFTER_SALES_REASON_MAX_DEPTH) return '';
  seen.add(value);

  for (const key of AFTER_SALES_REASON_TEXT_KEYS) {
    const candidate = readAfterSalesReasonCandidate(value[key], seen, depth + 1);
    if (candidate) return candidate;
  }

  for (const [key, nextValue] of Object.entries(value)) {
    if (!isAfterSalesReasonKey(key)) continue;
    const candidate = readAfterSalesReasonCandidate(nextValue, seen, depth + 1);
    if (candidate) return candidate;
  }
  return '';
}

function collectAfterSalesReasonCandidates(source, candidates, seen = new WeakSet(), depth = 0) {
  if (source === null || source === undefined || depth > AFTER_SALES_REASON_MAX_DEPTH) return;
  if (Array.isArray(source)) {
    source.forEach((item) => collectAfterSalesReasonCandidates(item, candidates, seen, depth + 1));
    return;
  }
  if (typeof source !== 'object') return;
  if (seen.has(source)) return;
  seen.add(source);

  for (const [key, value] of Object.entries(source)) {
    if (!isAfterSalesReasonKey(key)) continue;
    const candidate = readAfterSalesReasonCandidate(value, seen, depth + 1);
    if (candidate) candidates.push(candidate);
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === null || typeof value !== 'object') continue;
    if (AFTER_SALES_REASON_SKIP_OBJECT_KEYS.test(key)) continue;
    collectAfterSalesReasonCandidates(value, candidates, seen, depth + 1);
  }
}

export function getOzonAfterSalesReasonText(source = {}) {
  const reasonIdLabel = getAfterSalesReasonIdLabel(source);
  if (reasonIdLabel) return reasonIdLabel;
  const reason = getOzonAfterSalesReasonRawText(source);
  const translated = translateOzonAfterSalesReasonToChinese(reason);
  if (translated && !isGenericAfterSalesReasonLabel(translated)) return translated;
  return translated;
}

export function getOzonAfterSalesReasonRawText(source = {}) {
  const preferredSources = [
    source.reasonRaw,
    source.reason_raw,
    source.return_reason_raw,
    source.return_reason,
    source.returnReason,
    source.raw?.return_reason,
    source.raw?.returnReason,
    source.detail?.return_reason,
    source.detail?.returnReason,
    source.raw?.detail?.return_reason,
    source.raw?.detail?.returnReason,
    source.listItem?.return_reason,
    source.raw?.listItem?.return_reason,
    source.refund_reason,
    source.refundReason,
    source.cancellation?.cancel_reason,
    source.cancellation?.cancelReason,
    source.raw?.cancellation?.cancel_reason,
    source.raw?.cancellation?.cancelReason,
    source.cancel_reason,
    source.cancelReason,
    source.cancellation_reason,
    source.cancellationReason,
    source.reason,
  ];
  let genericFallback = '';
  for (const value of preferredSources) {
    const candidate = readAfterSalesReasonCandidate(value);
    if (!candidate) continue;
    if (isAfterSalesReasonTranslationPlaceholder(candidate)) continue;
    if (isGenericAfterSalesReasonLabel(candidate)) {
      genericFallback ||= candidate;
      continue;
    }
    return candidate;
  }

  const candidates = [];
  collectAfterSalesReasonCandidates(source, candidates);
  return (
    candidates.find(
      (candidate) =>
        candidate && !isAfterSalesReasonTranslationPlaceholder(candidate) && !isGenericAfterSalesReasonLabel(candidate)
    ) || genericFallback
  );
}

function isUnknownDisplayValue(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') return false;
  const text = normalizeKeyPart(value);
  return !text || text === '-' || text === '未返回' || text === '待确认' || text === '读取失败';
}

function toClassificationNumber(value) {
  const text = normalizeKeyPart(value);
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function hasAfterSalesClassificationEvidence(row = {}) {
  if (AFTER_SALES_CLASSIFICATION_EVIDENCE_FIELDS.some((field) => !isUnknownDisplayValue(row[field]))) return true;
  const reason = normalizeKeyPart(row.classificationReason);
  return Boolean(reason && !/未命中|兜底|按.*处理|按.*归类/.test(reason) && !isUnknownDisplayValue(reason));
}

function getAfterSalesFinanceEvidence(row = {}) {
  return row.financeRefundEvidence && typeof row.financeRefundEvidence === 'object'
    ? row.financeRefundEvidence
    : row.raw?.financeRefundEvidence && typeof row.raw.financeRefundEvidence === 'object'
      ? row.raw.financeRefundEvidence
      : {};
}

function hasAfterSalesExplicitFinanceNonConfirmation(row = {}) {
  const financeEvidence = getAfterSalesFinanceEvidence(row);
  const hasCheckedResult = Boolean(row.financeRefundChecked || financeEvidence.checked);
  return Boolean(
    hasCheckedResult &&
    !row.financeRefundConfirmed &&
    !financeEvidence.confirmed &&
    !financeEvidence.signedRefundConfirmed
  );
}

function hasAfterSalesDurableRefusedFinanceConfirmation(row = {}) {
  return Boolean(
    !isUnknownDisplayValue(row.refusedEvidence) &&
    !isUnknownDisplayValue(row.destroyedEvidence) &&
    isUnknownDisplayValue(row.originalOrderDeliveredEvidence)
  );
}

function hasAfterSalesDurableFinanceConfirmation(row = {}) {
  const status = normalizeAfterSalesClassificationStatus(row.status || row.type);
  if (isAfterSalesRefusedRefundStatus(status)) return hasAfterSalesDurableRefusedFinanceConfirmation(row);
  return false;
}

function getAfterSalesClassificationConfidence(row = {}, hasEvidence = false) {
  const explicit = toClassificationNumber(row.classificationConfidence);
  if (explicit !== null) return explicit;
  return hasEvidence ? 50 : 0;
}

function pickField(source, fields) {
  for (const field of fields) {
    const value = normalizeKeyPart(source?.[field]);
    if (value) return value;
  }
  return '';
}

function pickRawOrderKey(order = {}) {
  const raw = order.raw && typeof order.raw === 'object' ? order.raw : {};
  return firstFilled(raw.posting_number, raw.postingNumber, raw.posting, raw.order_id, raw.orderId, raw.id);
}

function pickRawShopKey(order = {}) {
  const raw = order.raw && typeof order.raw === 'object' ? order.raw : {};
  return firstFilled(raw.client_id, raw.clientId, raw.seller_id, raw.sellerId, raw.shop_id, raw.shopId);
}

export function getOzonOrderExperienceKey(order = {}) {
  const recordKey = normalizeKeyPart(order.recordKey);
  const shopKey = pickField(order, SHOP_KEY_FIELDS) || pickRawShopKey(order);
  if (!shopKey) return '';
  if (recordKey) return recordKey.startsWith(`${shopKey}:`) ? recordKey : `${shopKey}:${recordKey}`;

  const orderKey = pickField(order, ORDER_KEY_FIELDS) || pickRawOrderKey(order);
  if (!orderKey) return '';
  return `${shopKey}:${orderKey}`;
}

export function getOzonProductPictureLookupId(product = {}) {
  const source = normalizeKeyPart(product.productIdSource);
  if (source && !PRODUCT_PICTURE_LOOKUP_SOURCES.has(source)) return null;
  const raw = product.raw && typeof product.raw === 'object' ? product.raw : {};
  const text = firstFilled(product.productId, product.product_id, product.id, raw.product_id, raw.productId, raw.id);
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function pruneSupplementCache(maxEntries = OZON_ORDER_SUPPLEMENT_CACHE_MAX_ENTRIES) {
  while (supplementCache.size > maxEntries) {
    const oldestKey = supplementCache.keys().next().value;
    if (!oldestKey) break;
    supplementCache.delete(oldestKey);
  }
}

function sanitizeArray(value) {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map(normalizeKeyPart).filter(Boolean))];
}

function sanitizeProductSupplement(product = {}) {
  const sanitized = {};
  for (const field of PRODUCT_SUPPLEMENT_FIELDS) {
    if (!(field in product)) continue;
    const value = product[field];
    if (Array.isArray(value)) {
      const arrayValue = sanitizeArray(value);
      if (arrayValue?.length) sanitized[field] = arrayValue;
      continue;
    }
    if (value !== null && value !== undefined && value !== '') {
      sanitized[field] = value;
    }
  }
  return sanitized;
}

function sanitizeOrderSupplement(row = {}) {
  const sanitized = {};
  for (const field of ORDER_SUPPLEMENT_FIELDS) {
    if (row[field] !== null && row[field] !== undefined && row[field] !== '') {
      sanitized[field] = row[field];
    }
  }

  if (Array.isArray(row.products)) {
    sanitized.products = row.products.map(sanitizeProductSupplement);
  }

  return sanitized;
}

export function writeOzonOrderSupplementCache(row = {}, options = {}) {
  const key = getOzonOrderExperienceKey(row);
  if (!key) return false;

  supplementCache.set(key, {
    cachedAt: options.now ?? nowMs(),
    row: sanitizeOrderSupplement(row),
  });
  pruneSupplementCache(options.maxEntries);
  return true;
}

export function writeOzonOrderSupplementCacheRows(rows = [], options = {}) {
  return rows.reduce((count, row) => count + (writeOzonOrderSupplementCache(row, options) ? 1 : 0), 0);
}

export function readOzonOrderSupplementCache(row = {}, options = {}) {
  const key = getOzonOrderExperienceKey(row);
  if (!key) return null;

  const entry = supplementCache.get(key);
  if (!entry) return null;

  const ttlMs = options.ttlMs ?? OZON_ORDER_SUPPLEMENT_CACHE_TTL_MS;
  const currentTime = options.now ?? nowMs();
  if (ttlMs > 0 && currentTime - entry.cachedAt > ttlMs) {
    supplementCache.delete(key);
    return null;
  }

  return entry.row;
}

export function readOzonOrderSupplementCacheRows(rows = [], options = {}) {
  return rows.map((row) => readOzonOrderSupplementCache(row, options)).filter(Boolean);
}

export function clearOzonOrderSupplementCacheForRows(rows = []) {
  let deleted = 0;
  for (const row of rows) {
    const key = getOzonOrderExperienceKey(row);
    if (key && supplementCache.delete(key)) deleted += 1;
  }
  return deleted;
}

export function clearOzonOrderSupplementCache() {
  supplementCache.clear();
  imagePreloadCache.clear();
}

function getAfterSalesLegacyCacheKey(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const orderKey = firstFilled(
    row.recordKey,
    row.id,
    row.returnId,
    row.return_id,
    row.salesOrder,
    row.posting,
    row.postingNumber,
    row.posting_number,
    raw.return_id,
    raw.returnId,
    raw.id,
    raw.posting_number,
    raw.postingNumber,
    raw.order_id,
    raw.orderId
  );
  if (!orderKey) return '';
  if (orderKey.includes(':')) return orderKey;
  const shopKey = firstFilled(row.shopClientId, row.shopId, row.sellerId, row.shop, row.shopName, row.storeName);
  return shopKey ? `${shopKey}:${orderKey}` : '';
}

function getAfterSalesCacheKeyCandidates(row = {}) {
  const canonicalCandidates = getAfterSalesCanonicalEntityKeyCandidates(row);
  const returnId = getAfterSalesReturnIdentity(row);
  const exactPosting = getAfterSalesExactPostingNumber(row);
  // 无售后编号时不能带入旧母单键，否则 -1/-2/-3 会再次被缓存层合并。
  const legacyKey = returnId || !exactPosting ? getAfterSalesLegacyCacheKey(row) : '';
  return [...canonicalCandidates, legacyKey]
    .map(normalizeKeyPart)
    .filter((key, index, values) => key && values.indexOf(key) === index);
}

function getAfterSalesCacheKey(row = {}) {
  return getAfterSalesCacheKeyCandidates(row)[0] || '';
}

function mergeUnknownSafeFields(cached = {}, fresh = {}) {
  const merged = { ...cached, ...fresh };
  for (const key of Object.keys(cached)) {
    if (key === 'products' || key === 'raw') continue;
    if (isUnknownDisplayValue(merged[key]) && !isUnknownDisplayValue(cached[key])) {
      merged[key] = cached[key];
    }
  }
  return merged;
}

function getProductDisplayCurrencyCode(product = {}) {
  return normalizeKeyPart(
    product.sourceCurrencyCode ||
      product.raw?.currency_code ||
      product.raw?.currency ||
      product.currencyCode ||
      product.currency ||
      product.financialRaw?.currency_code ||
      product.financialRaw?.currency
  ).toUpperCase();
}

function inferProductDisplayCurrencyCode(product = {}) {
  const currencyCode = getProductDisplayCurrencyCode(product);
  if (currencyCode) return currencyCode;
  const priceText = normalizeKeyPart(product.price || product.refundAmount || product.amount).toUpperCase();
  if (priceText.includes('¥') || priceText.includes('￥') || priceText.includes('CNY') || priceText.includes('RMB')) {
    return 'CNY';
  }
  if (priceText.includes('RUB') || priceText.includes('RUR') || priceText.includes('₽')) return 'RUB';
  return '';
}

function getAfterSalesProductAmountRank(product = {}) {
  const currencyCode = inferProductDisplayCurrencyCode(product);
  const hasPrice = !isUnknownDisplayValue(product.price) || !isUnknownDisplayValue(product.priceValue);
  if (!hasPrice) return 0;
  if (currencyCode === 'CNY' || currencyCode === 'RMB') return 100;
  if (currencyCode === 'RUB' || currencyCode === 'RUR') return 10;
  return 40;
}

function hasFreshOzonAfterSalesAmount(product = {}) {
  const source = normalizeKeyPart(product.afterSalesAmountSource).toLowerCase();
  const hasPrice = !isUnknownDisplayValue(product.price) || !isUnknownDisplayValue(product.priceValue);
  return hasPrice && (source === 'ozon-return-rub' || source === 'ozon-return-cny');
}

function mergeAfterSalesProductAmountFields(merged = {}, cached = {}, fresh = {}) {
  const cachedRank = getAfterSalesProductAmountRank(cached);
  const freshRank = getAfterSalesProductAmountRank(fresh);
  const preferred = hasFreshOzonAfterSalesAmount(fresh)
    ? fresh
    : cachedRank > freshRank
      ? cached
      : freshRank > 0
        ? fresh
        : cachedRank > 0
          ? cached
          : null;
  if (!preferred) return merged;

  const next = { ...merged };
  [
    'price',
    'priceValue',
    'currencyCode',
    'sourceCurrencyCode',
    'sourcePriceValue',
    'afterSalesAmountSource',
    'refundAmount',
    'refundAmountValue',
    'amount',
    'amountValue',
  ].forEach((field) => {
    if (!isUnknownDisplayValue(preferred[field])) next[field] = preferred[field];
  });
  return next;
}

function mergeAfterSalesProducts(cachedProducts = [], freshProducts = []) {
  const cached = Array.isArray(cachedProducts) ? cachedProducts : [];
  const fresh = Array.isArray(freshProducts) ? freshProducts : [];
  const maxLength = Math.max(cached.length, fresh.length);
  const products = [];
  for (let index = 0; index < maxLength; index += 1) {
    const cachedProduct = cached[index] || {};
    const freshProduct = fresh[index] || {};
    products.push(
      mergeAfterSalesProductAmountFields(
        mergeUnknownSafeFields(cachedProduct, freshProduct),
        cachedProduct,
        freshProduct
      )
    );
  }
  return products.filter((item) => Object.keys(item).length > 0);
}

function mergeAfterSalesRawPayload(cached = {}, fresh = {}) {
  const cachedRaw = cached.raw && typeof cached.raw === 'object' ? cached.raw : {};
  const freshRaw = fresh.raw && typeof fresh.raw === 'object' ? fresh.raw : {};
  if (!Object.keys(cachedRaw).length && !Object.keys(freshRaw).length) return null;
  return mergeUnknownSafeFields(cachedRaw, freshRaw);
}

function protectAfterSalesStrongEvidenceFields(merged = {}, cached = {}, fresh = {}) {
  const next = { ...merged };
  for (const field of AFTER_SALES_CLASSIFICATION_EVIDENCE_FIELDS) {
    const cachedValue = cached[field];
    const freshValue = fresh[field];
    const freshCanClearStaleDeliveryEvidence =
      ['deliveredEvidence', 'originalOrderDeliveredEvidence'].includes(field) &&
      Object.prototype.hasOwnProperty.call(fresh, field) &&
      isUnknownDisplayValue(freshValue) &&
      (toClassificationNumber(fresh.classificationVersion) ?? 0) >=
        (toClassificationNumber(cached.classificationVersion) ?? 0);
    if (freshCanClearStaleDeliveryEvidence) {
      next[field] = '';
      continue;
    }
    if (!isUnknownDisplayValue(freshValue)) {
      next[field] = freshValue;
    } else if (!isUnknownDisplayValue(cachedValue)) {
      next[field] = cachedValue;
    }
  }
  return next;
}

function mergeAfterSalesFinanceRefundEvidence(merged = {}, cached = {}, fresh = {}) {
  const cachedFinance = getAfterSalesFinanceEvidence(cached);
  const freshFinance = getAfterSalesFinanceEvidence(fresh);
  const freshClearsStaleFinance =
    hasAfterSalesExplicitFinanceNonConfirmation(fresh) && !hasAfterSalesDurableFinanceConfirmation(cached);
  const financeConfirmed = freshClearsStaleFinance
    ? false
    : Boolean(
        fresh.financeRefundConfirmed ||
        cached.financeRefundConfirmed ||
        freshFinance.confirmed ||
        cachedFinance.confirmed
      );
  const financeChecked = Boolean(
    financeConfirmed ||
    fresh.financeRefundChecked ||
    cached.financeRefundChecked ||
    freshFinance.checked ||
    cachedFinance.checked
  );
  const next = { ...merged };
  if (financeChecked) next.financeRefundChecked = true;
  if (financeChecked) next.financeRefundConfirmed = financeConfirmed;
  if (Object.keys(cachedFinance).length || Object.keys(freshFinance).length) {
    next.financeRefundEvidence = {
      ...cachedFinance,
      ...freshFinance,
      checked: financeChecked || freshFinance.checked || cachedFinance.checked,
      confirmed: financeConfirmed,
    };
  }
  const financeClassificationRow = [fresh, cached].find((row) => {
    const status = row.status || row.type;
    return isAfterSalesRefusedRefundStatus(status);
  });
  if (financeConfirmed && financeClassificationRow) {
    next.status = financeClassificationRow.status || financeClassificationRow.type;
    next.type = financeClassificationRow.type || financeClassificationRow.status;
    next.tone = financeClassificationRow.tone || (isAfterSalesSignedRefundStatus(next.status) ? 'error' : 'success');
    if (!isUnknownDisplayValue(financeClassificationRow.classificationReason)) {
      next.classificationReason = financeClassificationRow.classificationReason;
    }
    if (!isUnknownDisplayValue(financeClassificationRow.classificationConfidence)) {
      next.classificationConfidence = financeClassificationRow.classificationConfidence;
    }
  }
  return next;
}

function mergeAfterSalesCachedRow(cached = {}, fresh = {}) {
  let merged = mergeUnknownSafeFields(cached, fresh);
  const products = mergeAfterSalesProducts(cached.products, fresh.products);
  if (products.length) merged.products = products;
  const raw = mergeAfterSalesRawPayload(cached, fresh);
  if (raw) merged.raw = raw;

  const cachedStatus = normalizeAfterSalesClassificationStatus(cached.status);
  const freshStatus = normalizeAfterSalesClassificationStatus(fresh.status);
  const cachedHasEvidence = hasAfterSalesClassificationEvidence(cached);
  const freshHasEvidence = hasAfterSalesClassificationEvidence(fresh);
  const cachedVersion = toClassificationNumber(cached.classificationVersion) ?? 1;
  const freshVersion = toClassificationNumber(fresh.classificationVersion) ?? 1;
  const cachedConfidence = getAfterSalesClassificationConfidence(cached, cachedHasEvidence);
  const freshConfidence = getAfterSalesClassificationConfidence(fresh, freshHasEvidence);
  const shouldKeepCachedClassification =
    cachedStatus &&
    freshStatus &&
    cachedStatus !== freshStatus &&
    AFTER_SALES_CLASSIFICATION_VALUES.has(cachedStatus) &&
    AFTER_SALES_CLASSIFICATION_VALUES.has(freshStatus) &&
    cachedVersion >= freshVersion &&
    cachedHasEvidence &&
    !freshHasEvidence &&
    cachedConfidence >= freshConfidence;

  if (shouldKeepCachedClassification) {
    for (const field of AFTER_SALES_LOCKED_CLASSIFICATION_FIELDS) {
      if (cached[field] !== undefined) merged[field] = cached[field];
    }
  }

  if (
    toClassificationNumber(fresh.classificationVersion) !== null &&
    freshVersion >= cachedVersion &&
    freshStatus &&
    AFTER_SALES_CLASSIFICATION_VALUES.has(freshStatus)
  ) {
    for (const field of AFTER_SALES_LOCKED_CLASSIFICATION_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(fresh, field)) merged[field] = fresh[field];
    }
  }

  merged = protectAfterSalesStrongEvidenceFields(merged, cached, fresh);
  merged = mergeAfterSalesFinanceRefundEvidence(merged, cached, fresh);

  return merged;
}

export function mergeOzonAfterSalesCachedRows(cachedRows = [], freshRows = []) {
  const mergedByKey = new Map();
  const canonicalKeyByCandidate = new Map();
  const orderKeys = [];

  const append = (row, source) => {
    const candidates = getAfterSalesCacheKeyCandidates(row);
    const key =
      candidates.map((candidate) => canonicalKeyByCandidate.get(candidate)).find(Boolean) ||
      candidates[0] ||
      getAfterSalesCacheKey(row);
    if (!key) return;
    if (!mergedByKey.has(key)) orderKeys.push(key);
    candidates.forEach((candidate) => canonicalKeyByCandidate.set(candidate, key));
    const current = mergedByKey.get(key);
    mergedByKey.set(key, current && source === 'fresh' ? mergeAfterSalesCachedRow(current, row) : current || row);
  };

  (Array.isArray(freshRows) ? freshRows : []).forEach((row) => append(row, 'fresh'));
  (Array.isArray(cachedRows) ? cachedRows : []).forEach((row) => {
    const candidates = getAfterSalesCacheKeyCandidates(row);
    const key =
      candidates.map((candidate) => canonicalKeyByCandidate.get(candidate)).find(Boolean) ||
      candidates[0] ||
      getAfterSalesCacheKey(row);
    if (!key) return;
    candidates.forEach((candidate) => canonicalKeyByCandidate.set(candidate, key));
    const current = mergedByKey.get(key);
    if (current) {
      mergedByKey.set(key, mergeAfterSalesCachedRow(row, current));
      return;
    }
    append(row, 'cached');
  });

  return orderKeys.map((key) => mergedByKey.get(key)).filter(Boolean);
}

export function normalizeOzonImageUrlsForPreload(urls = [], options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 80;
  const uniqueUrls = [];
  const seen = new Set();

  for (const value of urls) {
    const url = normalizeKeyPart(value);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    uniqueUrls.push(url);
    if (uniqueUrls.length >= limit) break;
  }

  return uniqueUrls;
}

function pruneImagePreloadCache(maxEntries = OZON_ORDER_IMAGE_PRELOAD_MAX_ENTRIES) {
  while (imagePreloadCache.size > maxEntries) {
    const oldestKey = imagePreloadCache.keys().next().value;
    if (!oldestKey) break;
    imagePreloadCache.delete(oldestKey);
  }
}

function preloadSingleImageUrl(url) {
  if (typeof Image === 'undefined') {
    imagePreloadCache.set(url, { status: 'unsupported', cachedAt: nowMs() });
    return Promise.resolve({ url, status: 'unsupported' });
  }

  const image = new Image();
  image.decoding = 'async';
  image.loading = 'eager';
  const promise = new Promise((resolve) => {
    image.onload = () => {
      imagePreloadCache.set(url, { status: 'loaded', cachedAt: nowMs() });
      resolve({ url, status: 'loaded' });
    };
    image.onerror = () => {
      imagePreloadCache.set(url, { status: 'error', cachedAt: nowMs() });
      resolve({ url, status: 'error' });
    };
  });

  imagePreloadCache.set(url, { status: 'loading', cachedAt: nowMs(), promise });
  image.src = url;
  return promise;
}

export async function preloadOzonImageUrls(urls = [], options = {}) {
  const normalizedUrls = normalizeOzonImageUrlsForPreload(urls, options);
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 8, 16));
  const pendingUrls = normalizedUrls.filter((url) => {
    const entry = imagePreloadCache.get(url);
    return !entry || entry.status === 'error';
  });
  let cursor = 0;
  let started = 0;

  const workers = Array.from({ length: Math.min(concurrency, pendingUrls.length) }, async () => {
    while (cursor < pendingUrls.length) {
      const url = pendingUrls[cursor];
      cursor += 1;
      started += 1;
      await preloadSingleImageUrl(url);
    }
  });

  await Promise.all(workers);
  pruneImagePreloadCache(options.maxEntries);

  return {
    requested: normalizedUrls.length,
    started,
    cached: normalizedUrls.length - started,
  };
}

function readStatusValue(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  return firstFilled(
    row.status,
    row.statusText,
    row.orderStatus,
    row.ozonStatus,
    row.ozonRawStatus,
    raw.status,
    raw.statusText,
    raw.order_status,
    raw.orderStatus
  );
}

function readRefundSignal(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const signals = [
    row.afterSalesStatus,
    row.refundStatus,
    row.returnStatus,
    row.cancelReason,
    row.statusTags,
    row.tags,
    raw.cancel_reason,
    raw.cancelReason,
    raw.cancellation?.cancel_reason,
    raw.cancellation?.cancelReason,
    raw.return_status,
    raw.returnStatus,
    raw.refund_status,
    raw.refundStatus,
    readStatusValue(row),
  ];
  return signals
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map(normalizeKeyPart)
    .filter(Boolean)
    .join('|')
    .toLowerCase();
}

function isRefundLike(row = {}) {
  return /退款|退货|售后|取消|已取消|refund|return|cancel|canceled|cancelled/.test(readRefundSignal(row));
}

function getOrderDisplayName(row = {}) {
  return (
    firstFilled(
      row.salesOrder,
      row.posting,
      row.postingNumber,
      row.posting_number,
      row.ozonPostingNumber,
      row.ozonOrderId,
      row.orderId,
      row.id
    ) || getOzonOrderExperienceKey(row)
  );
}

function getNotificationProducts(order = {}) {
  const raw = order.raw && typeof order.raw === 'object' ? order.raw : {};
  const sources = [
    order.products,
    order.items,
    order.financial_data?.products,
    order.financialData?.products,
    order.product && typeof order.product === 'object' && !Array.isArray(order.product) ? [order.product] : [],
    raw.products,
    raw.items,
    raw.financial_data?.products,
    raw.financialData?.products,
  ];
  const rows = sources.find((items) => Array.isArray(items) && items.length) || [];
  return rows.filter((item) => item && typeof item === 'object');
}

function readNotificationProduct(order = {}) {
  const products = getNotificationProducts(order);
  const product = products[0] || {};
  const rawProduct = product.raw && typeof product.raw === 'object' ? product.raw : {};
  const images = normalizeOzonImageUrlsForPreload(
    [
      product.image,
      product.imageUrl,
      product.image_url,
      product.skuImage,
      product.sku_image,
      product.primaryImage,
      product.primary_image,
      product.mainImage,
      product.main_image,
      rawProduct.image,
      rawProduct.imageUrl,
      rawProduct.image_url,
      rawProduct.sku_image,
      rawProduct.primary_image,
      ...(Array.isArray(product.images) ? product.images : []),
      ...(Array.isArray(product.pictures) ? product.pictures : []),
    ],
    { limit: 1 }
  );
  return {
    productName: firstFilled(
      product.name,
      product.title,
      product.productName,
      product.product_name,
      product.offerName,
      product.offer_name,
      rawProduct.name,
      rawProduct.title,
      rawProduct.product_name,
      typeof order.product === 'string' ? order.product : '',
      order.productName
    ),
    productImage: images[0] || '',
    offerId: firstFilled(product.offerId, product.offer_id, rawProduct.offerId, rawProduct.offer_id),
    productId: firstFilled(product.productId, product.product_id, rawProduct.productId, rawProduct.product_id),
    productSku: firstFilled(
      product.offerId,
      product.offer_id,
      product.sku,
      product.skuId,
      product.sku_id,
      rawProduct.offerId,
      rawProduct.offer_id,
      rawProduct.sku,
      rawProduct.sku_id
    ),
    productCount: products.length,
  };
}

function readNotificationRefundAmount(order = {}) {
  const raw = order.raw && typeof order.raw === 'object' ? order.raw : {};
  return firstFilled(
    order.refundAmount,
    order.refund_amount,
    order.amount,
    order.totalRefundAmount,
    order.total_refund_amount,
    raw.refundAmount,
    raw.refund_amount,
    raw.amount,
    raw.refund?.amount
  );
}

function buildOrderNotificationValueSnapshot(order = {}, status = '') {
  const raw = order.raw && typeof order.raw === 'object' ? order.raw : {};
  const snapshot = {
    status: status || readStatusValue(order),
    refundStatus: firstFilled(
      order.refundStatus,
      order.refund_status,
      order.afterSalesStatus,
      order.returnStatus,
      raw.refundStatus,
      raw.refund_status,
      raw.returnStatus,
      raw.return_status
    ),
    refundAmount: readNotificationRefundAmount(order),
    currencyCode: firstFilled(order.currencyCode, order.currency, raw.currency_code, raw.currency),
    reason: getOzonAfterSalesReasonText(order),
  };
  return Object.fromEntries(Object.entries(snapshot).filter(([, value]) => normalizeKeyPart(value)));
}

function createNotification({ type, order, previousOrder, previousStatus, nextStatus, createdAt }) {
  const key = getOzonOrderExperienceKey(order);
  const name = getOrderDisplayName(order);
  const product = readNotificationProduct(order);
  const shopIdentity = {
    shopId: firstFilled(order.shopId, order.shop_id),
    shopClientId: firstFilled(order.shopClientId, order.shop_client_id, order.clientId, order.client_id),
    shopName: firstFilled(order.shop, order.shopName, order.storeName),
  };
  const common = {
    orderKey: key,
    postingNumber: name,
    entityType: 'order',
    entityId: key,
    oldValue: buildOrderNotificationValueSnapshot(previousOrder || {}, previousStatus),
    newValue: buildOrderNotificationValueSnapshot(order, nextStatus),
    refundAmount: readNotificationRefundAmount(order),
    refundReason: getOzonAfterSalesReasonText(order),
    currencyCode: firstFilled(order.currencyCode, order.currency, order.raw?.currency_code, order.raw?.currency),
    ...product,
    createdAt,
    ...shopIdentity,
  };
  if (type === 'new_order') {
    return {
      id: `new:${key}`,
      type,
      title: '新订单',
      message: `${name} 有新订单`,
      ...common,
    };
  }

  if (type === 'refund_or_after_sale') {
    return {
      id: `refund:${key}:${previousStatus || 'unknown'}:${nextStatus || 'unknown'}`,
      type,
      title: '订单售后/退款变化',
      message: `${name}：${previousStatus || '未知'} -> ${nextStatus || '未知'}`,
      ...common,
    };
  }

  return {
    id: `status:${key}:${previousStatus || 'unknown'}:${nextStatus || 'unknown'}`,
    type,
    title: '订单状态变化',
    message: `${name}：${previousStatus || '未知'} -> ${nextStatus || '未知'}`,
    ...common,
  };
}

export function createOzonOrderChangeNotifications(previousRows = [], nextRows = [], options = {}) {
  const previousByKey = new Map();
  for (const row of previousRows) {
    const key = getOzonOrderExperienceKey(row);
    if (key) previousByKey.set(key, row);
  }

  const createdAt = options.createdAt ?? new Date().toISOString();
  const notifications = [];
  for (const row of nextRows) {
    const key = getOzonOrderExperienceKey(row);
    if (!key) continue;

    const previous = previousByKey.get(key);
    if (!previous) {
      notifications.push(createNotification({ type: 'new_order', order: row, createdAt }));
      continue;
    }

    const previousStatus = readStatusValue(previous);
    const nextStatus = readStatusValue(row);
    if (previousStatus && nextStatus && previousStatus !== nextStatus) {
      notifications.push(
        createNotification({
          type: isRefundLike(row) || isRefundLike(previous) ? 'refund_or_after_sale' : 'status_change',
          order: row,
          previousOrder: previous,
          previousStatus,
          nextStatus,
          createdAt,
        })
      );
      continue;
    }

    const previousRefundSignal = readRefundSignal(previous);
    const nextRefundSignal = readRefundSignal(row);
    if (nextRefundSignal && previousRefundSignal !== nextRefundSignal && isRefundLike(row)) {
      notifications.push(
        createNotification({
          type: 'refund_or_after_sale',
          order: row,
          previousOrder: previous,
          previousStatus: previousStatus || '无售后',
          nextStatus: nextStatus || '售后变化',
          createdAt,
        })
      );
    }
  }

  return notifications;
}

export function createOzonAfterSalesChangeNotifications(previousRows = [], nextRows = [], options = {}) {
  return createOzonOrderChangeNotifications(previousRows, nextRows, options).map((notification) => {
    const isNewAfterSales = notification.type === 'new_order';
    return {
      ...notification,
      id: `after-sales:${notification.id}`,
      domain: 'returns',
      eventType: isNewAfterSales ? 'return_created' : 'return_status_changed',
      type: isNewAfterSales ? 'new_after_sale' : 'refund_or_after_sale',
      title: isNewAfterSales ? '新增售后/退款' : '售后状态变化',
      message: isNewAfterSales ? notification.message.replace('有新订单', '有新的售后/退款记录') : notification.message,
    };
  });
}

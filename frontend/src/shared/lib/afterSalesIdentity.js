const UNKNOWN_IDENTITY_VALUES = new Set(['', '-', '未返回']);

export function normalizeAfterSalesIdentityPart(value) {
  return String(value ?? '').trim();
}

function firstUsableAfterSalesIdentityPart(...values) {
  for (const value of values) {
    const text = normalizeAfterSalesIdentityPart(value);
    if (!UNKNOWN_IDENTITY_VALUES.has(text)) return text;
  }
  return '';
}

function getAfterSalesRaw(row = {}) {
  return row.raw && typeof row.raw === 'object' ? row.raw : {};
}

/**
 * 完整发货单号才是无售后编号记录的业务身份。
 * 例如 09362844-0405-1、09362844-0405-2 必须是两条记录。
 */
export function getAfterSalesExactPostingNumber(row = {}) {
  const raw = getAfterSalesRaw(row);
  return firstUsableAfterSalesIdentityPart(
    row.salesOrder,
    row.posting,
    row.postingNumber,
    row.posting_number,
    row.ozonPostingNumber,
    row.orderNumber,
    row.order_number,
    raw.posting_number,
    raw.postingNumber,
    raw.posting,
    raw.order_number,
    raw.orderNumber,
    raw.order_id,
    raw.orderId
  );
}

/**
 * 母单号只用于关联查询，不能用于售后实体去重。
 */
export function getAfterSalesPostingBaseKey(value) {
  const text = normalizeAfterSalesIdentityPart(value);
  if (UNKNOWN_IDENTITY_VALUES.has(text)) return '';
  const match = text.match(/^(\d{6,}-\d{3,})-\d+$/);
  return match ? match[1] : text;
}

export function getAfterSalesBasePostingNumber(row = {}) {
  return getAfterSalesPostingBaseKey(getAfterSalesExactPostingNumber(row));
}

export function getAfterSalesStableIdentityKey(row = {}, options = {}) {
  const raw = getAfterSalesRaw(row);
  return firstUsableAfterSalesIdentityPart(
    row.clientId,
    row.client_id,
    row.shopClientId,
    row.sellerId,
    raw.clientId,
    raw.client_id,
    raw.sellerId,
    raw.seller_id,
    options.clientId,
    options.shopClientId,
    row.shopId,
    row.shop_id,
    raw.shopId,
    raw.shop_id,
    options.shopId
  );
}

function getSafeLegacyReturnId(value, exactPosting, basePosting) {
  const text = firstUsableAfterSalesIdentityPart(value);
  if (!text || text === exactPosting || text === basePosting) return '';
  if (/^(posting|order|return):/i.test(text)) return '';
  return text;
}

/**
 * Ozon 明确返回的售后/退货编号优先级最高。
 * row.id/raw.id 仅作旧数据兼容；若它实际是完整发货单号、母单号或生成键，不得冒充售后编号。
 */
export function getAfterSalesReturnIdentity(row = {}) {
  const raw = getAfterSalesRaw(row);
  const source = normalizeAfterSalesIdentityPart(row.source || raw.source).toLowerCase();
  if (source === 'order-cancelled') return '';

  const explicitReturnId = firstUsableAfterSalesIdentityPart(
    row.afterSalesId,
    row.after_sales_id,
    row.returnId,
    row.return_id,
    raw.afterSalesId,
    raw.after_sales_id,
    raw.return_id,
    raw.returnId,
    raw.request_id,
    raw.requestId
  );
  if (explicitReturnId) return explicitReturnId;

  const exactPosting = getAfterSalesExactPostingNumber(row);
  const basePosting = getAfterSalesPostingBaseKey(exactPosting);
  return (
    getSafeLegacyReturnId(raw.id, exactPosting, basePosting) ||
    getSafeLegacyReturnId(row.id, exactPosting, basePosting)
  );
}

/**
 * 统一售后实体键：
 * 1. 有明确售后编号：店铺 + 售后编号；
 * 2. 无明确售后编号：店铺 + 完整发货单号（保留 -1/-2/-3）。
 */
export function getAfterSalesCanonicalEntityKey(row = {}, options = {}, { includeIdentity = true } = {}) {
  const identity = includeIdentity ? getAfterSalesStableIdentityKey(row, options) : '';
  const identityPrefix = identity ? `${identity}:` : '';
  const returnId = getAfterSalesReturnIdentity(row);
  if (returnId) return `${identityPrefix}return:${returnId}`;

  const exactPosting = getAfterSalesExactPostingNumber(row);
  return exactPosting ? `${identityPrefix}order:${exactPosting}` : '';
}

export function getAfterSalesCanonicalEntityKeyCandidates(row = {}, options = {}) {
  return [
    getAfterSalesCanonicalEntityKey(row, options, { includeIdentity: true }),
    getAfterSalesCanonicalEntityKey(row, options, { includeIdentity: false }),
  ]
    .map(normalizeAfterSalesIdentityPart)
    .filter((key, index, values) => key && values.indexOf(key) === index);
}

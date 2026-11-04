const RATING_ROW_ARRAY_PATHS = [
  [],
  ['items'],
  ['errors'],
  ['result'],
  ['result', 'items'],
  ['result', 'errors'],
  ['result', 'postings'],
  ['result', 'data'],
  ['postings'],
  ['data'],
];

const POSTING_NUMBER_PATHS = [
  ['posting_number'],
  ['postingNumber'],
  ['posting', 'posting_number'],
  ['posting', 'postingNumber'],
  ['posting', 'number'],
  ['shipment_number'],
  ['shipmentNumber'],
  ['shipment', 'posting_number'],
  ['order', 'posting_number'],
  ['order', 'postingNumber'],
  ['order_id'],
  ['orderId'],
];

const OPERATION_ID_PATHS = [
  ['operation_id'],
  ['operationId'],
  ['transaction_id'],
  ['transactionId'],
  ['accrual_id'],
  ['accrualId'],
  ['id'],
];

const OPERATION_DATE_PATHS = [
  ['operation_date'],
  ['operationDate'],
  ['error_date'],
  ['errorDate'],
  ['error_at'],
  ['errorAt'],
  ['date'],
  ['created_at'],
  ['createdAt'],
  ['period_date'],
  ['periodDate'],
];

const ERROR_TYPE_PATHS = [
  ['error_type'],
  ['errorType'],
  ['posting_error_type'],
  ['postingErrorType'],
  ['type'],
  ['reason'],
  ['error_reason'],
  ['errorReason'],
  ['name'],
];

const DIRECT_ERROR_FEE_PATHS = [
  ['error_fee_cny'],
  ['errorFeeCny'],
  ['error_fee'],
  ['errorFee'],
  ['charge_price'],
  ['chargePrice'],
  ['error_fee_amount'],
  ['errorFeeAmount'],
  ['error_cost'],
  ['errorCost'],
  ['error_cost_amount'],
  ['errorCostAmount'],
  ['actual_error_fee'],
  ['actualErrorFee'],
  ['actual_error_cost'],
  ['actualErrorCost'],
  ['mistake_fee'],
  ['mistakeFee'],
  ['mistake_cost'],
  ['mistakeCost'],
  ['错误费用'],
  ['错误费用金额'],
  ['错误扣费'],
  ['错误费'],
];

const PLACEHOLDER_VALUES = new Set(['', '-', '--', '—', '未返回', '待确认', 'null', 'undefined']);

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function getByPath(source, path) {
  let current = source;
  for (const key of path) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

function getFirstByPaths(source, paths) {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .replace(/[_\-\s]+/g, '')
    .toLowerCase();
}

function parseNumberLike(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || PLACEHOLDER_VALUES.has(text.toLowerCase())) return null;
  if (/%/.test(text)) return null;
  const cleaned = text
    .replace(/\s+/g, '')
    .replace(/[¥￥元₽]/g, '')
    .replace(/\b(?:cny|rmb|rub|rur)\b/gi, '')
    .replace(/руб\.?/gi, '')
    .replace(/,/g, '.')
    .replace(/[^0-9.+-]/g, '');
  const number = Number.parseFloat(cleaned);
  return Number.isFinite(number) ? number : null;
}

function detectCurrency(value) {
  const text = normalizeText(value).toLowerCase();
  if (text.includes('₽') || text.includes('руб') || text.includes('rub') || text.includes('rur')) {
    return 'RUB';
  }
  return 'CNY';
}

function isDirectErrorFeeKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (/(rate|percent|percentage|index|ratio|coef|коэф|индекс|比例|指数)/i.test(normalized)) return false;
  const hasFeeWord = /(fee|cost|amount|sum|charge|扣费|费用|金额|费)/i.test(normalized);
  const hasErrorWord = /(error|mistake|defect|fault|错误|过失|违规)/i.test(normalized);
  return hasFeeWord && hasErrorWord;
}

function parseDirectErrorFeeValue(value) {
  const amount = parseNumberLike(value);
  if (amount == null) return null;
  return {
    value: Math.abs(amount),
    currencyCode: detectCurrency(value),
    rawValue: value,
  };
}

function findDirectErrorFeeDeep(source, depth = 0) {
  if (!isPlainObject(source) || depth > 4) return null;
  for (const [key, value] of Object.entries(source)) {
    if (isDirectErrorFeeKey(key)) {
      const parsed = parseDirectErrorFeeValue(value);
      if (parsed) return parsed;
    }
    if (isPlainObject(value)) {
      const nested = findDirectErrorFeeDeep(value, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

export function extractOzonRatingPenaltyRows(data) {
  for (const path of RATING_ROW_ARRAY_PATHS) {
    const value = path.length === 0 ? data : getByPath(data, path);
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function getOzonRatingPenaltyPostingNumber(row) {
  const value = getFirstByPaths(row, POSTING_NUMBER_PATHS);
  const text = normalizeText(value);
  return text || null;
}

export function getOzonRatingPenaltyLookupKeys(value) {
  const text = normalizeText(value);
  if (!text) return [];
  const keys = new Set([text]);
  const base = text.replace(/-\d+$/, '');
  if (base && base !== text) keys.add(base);
  return [...keys];
}

export function getOzonRatingPenaltyOperationPostingKeys(operation) {
  return getOzonRatingPenaltyLookupKeys(
    operation?.posting?.posting_number ||
      operation?.posting_number ||
      operation?.postingNumber ||
      operation?.posting?.postingNumber
  );
}

export function getOzonRatingDirectErrorFee(row) {
  for (const path of DIRECT_ERROR_FEE_PATHS) {
    const value = getByPath(row, path);
    const parsed = parseDirectErrorFeeValue(value);
    if (parsed) return parsed;
  }
  return findDirectErrorFeeDeep(row);
}

function matchesPostingFilter(rowPostingNumber, postingNumbers) {
  if (!postingNumbers?.length) return true;
  const rowKeys = getOzonRatingPenaltyLookupKeys(rowPostingNumber);
  return postingNumbers.some((postingNumber) => {
    const filterKeys = getOzonRatingPenaltyLookupKeys(postingNumber);
    return filterKeys.some((key) => rowKeys.includes(key));
  });
}

function makeRatingPenaltyOperationId(row, postingNumber, directFee, options) {
  const explicitId = normalizeText(getFirstByPaths(row, OPERATION_ID_PATHS));
  if (explicitId) return `rating:${explicitId}`;
  const date = normalizeText(getFirstByPaths(row, OPERATION_DATE_PATHS));
  const type = normalizeText(getFirstByPaths(row, ERROR_TYPE_PATHS));
  const shopId = normalizeText(options.shopClientId || options.shopId);
  const amount = directFee ? directFee.value : 'pending';
  return `rating:${shopId}:${postingNumber}:${date}:${type}:${amount}`;
}

export function normalizeOzonRatingPenaltyOperation(row, options = {}) {
  if (!isPlainObject(row)) return null;
  const postingNumber = getOzonRatingPenaltyPostingNumber(row);
  if (!postingNumber) return null;
  if (!matchesPostingFilter(postingNumber, options.postingNumbers)) return null;
  const directFee = getOzonRatingDirectErrorFee(row);
  const operation = {
    operation_id: makeRatingPenaltyOperationId(row, postingNumber, directFee, options),
    operation_type: 'OzonRatingIndexErrorFee',
    operation_type_name: normalizeText(getFirstByPaths(row, ERROR_TYPE_PATHS)) || 'Ozon rating index error fee',
    operation_date: normalizeText(getFirstByPaths(row, OPERATION_DATE_PATHS)) || null,
    posting_number: postingNumber,
    posting: {
      posting_number: postingNumber,
    },
    currency_code: directFee?.currencyCode || 'CNY',
    __source: 'ozon_rating_index_fbs_posting_list',
    __raw: row,
  };
  if (directFee) {
    if (directFee.currencyCode === 'CNY') {
      operation.error_fee_cny = directFee.value;
    } else {
      operation.error_fee = directFee.rawValue ?? directFee.value;
    }
  }
  return operation;
}

export function createOzonRatingPenaltyOperations(data, options = {}) {
  const rows = extractOzonRatingPenaltyRows(data);
  return rows
    .map((row) => normalizeOzonRatingPenaltyOperation(row, options))
    .filter(Boolean);
}

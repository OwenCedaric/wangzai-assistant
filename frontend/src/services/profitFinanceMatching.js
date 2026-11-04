const PLACEHOLDER_VALUES = new Set(['', '未返回', '待确认', '读取失败', '未读取', 'null', 'undefined', 'nan']);

function flattenValues(values = []) {
  return values.flat(Infinity);
}

export function normalizeFinancePostingId(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '');
}

function isUsableFinancePostingId(value) {
  const text = normalizeFinancePostingId(value);
  return Boolean(text) && !PLACEHOLDER_VALUES.has(text) && !PLACEHOLDER_VALUES.has(text.toLowerCase());
}

export function getFinancePostingBaseKey(value) {
  const text = normalizeFinancePostingId(value);
  const match = text.match(/^(\d{6,}-\d{3,})-\d+$/);
  return match ? match[1] : '';
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === 0 || value === false) return value;
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text && !PLACEHOLDER_VALUES.has(text) && !PLACEHOLDER_VALUES.has(text.toLowerCase())) return value;
  }
  return '';
}

function getFinanceShopScopeKey(row = {}) {
  return (
    normalizeFinancePostingId(
      firstFilled(row.shopClientId, row.clientId, row.shopId, row.shopName, row.shop, row.storeName)
    ) || 'unknown-shop'
  );
}

function getFinanceParentScopeKey(row = {}, baseKey = '') {
  const base = normalizeFinancePostingId(baseKey);
  if (!base) return '';
  return `${getFinanceShopScopeKey(row)}:${base}`;
}

function getFinanceChildPostingKeys(row = {}) {
  return getFinancePostingLookupGroups([
    ...(Array.isArray(row.postingNumbers) ? row.postingNumbers : []),
    row.posting,
    row.id,
    row.softwareOrderId,
    row.raw?.posting_number,
    row.raw?.postingNumber,
    row.raw?.analytics_data?.posting_number,
  ]).exactKeys.filter((key) => Boolean(getFinancePostingBaseKey(key)));
}

export function buildFinanceParentFallbackIndex(rows = []) {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const orderKey = normalizeFinancePostingId(firstFilled(row.profitRecordKey, row.recordKey, row.id, row.posting));
    getFinanceChildPostingKeys(row).forEach((childKey) => {
      const baseKey = getFinancePostingBaseKey(childKey);
      const scopeKey = getFinanceParentScopeKey(row, baseKey);
      if (!scopeKey) return;
      const entry = map.get(scopeKey) ?? {
        baseKey,
        childKeys: new Set(),
        orderKeys: new Set(),
      };
      entry.childKeys.add(childKey);
      if (orderKey) entry.orderKeys.add(orderKey);
      map.set(scopeKey, entry);
    });
  });
  return map;
}

export function canUseFinanceParentFallback(
  row = {},
  groups = {},
  financeIndex = new Map(),
  parentFallbackIndex = new Map(),
  options = {}
) {
  if (!groups?.hasChildExactKey) return false;
  const exactOperations = collectFinanceOperationsByKeys(financeIndex, groups.exactKeys);
  if (exactOperations.length > 0 && options.allowWhenExactExists !== true) return false;
  if (!groups.fallbackKeys?.some((key) => Array.isArray(financeIndex.get(key)) && financeIndex.get(key).length > 0)) {
    return false;
  }

  return groups.exactKeys
    .filter((key) => Boolean(getFinancePostingBaseKey(key)))
    .some((childKey) => {
      const scopeKey = getFinanceParentScopeKey(row, getFinancePostingBaseKey(childKey));
      const entry = scopeKey ? parentFallbackIndex.get(scopeKey) : null;
      return Boolean(entry && entry.childKeys.size === 1 && entry.orderKeys.size === 1);
    });
}

export function getFinancePostingLookupGroups(exactValues = [], options = {}) {
  const exactKeys = uniqueValues(
    flattenValues(exactValues).map(normalizeFinancePostingId).filter(isUsableFinancePostingId)
  );
  const fallbackKeys = uniqueValues(
    [
      ...exactKeys.map(getFinancePostingBaseKey),
      ...flattenValues(options.fallbackValues ?? []).map(normalizeFinancePostingId),
    ].filter(isUsableFinancePostingId)
  ).filter((key) => !exactKeys.includes(key));

  return {
    exactKeys,
    fallbackKeys,
    hasChildExactKey: exactKeys.some((key) => Boolean(getFinancePostingBaseKey(key))),
  };
}

function collectFinanceOperationsByKeys(
  financeIndex = new Map(),
  keys = [],
  getDedupKey = JSON.stringify,
  seen = new Set()
) {
  const operations = [];
  keys.forEach((key) => {
    const matched = financeIndex.get(key);
    if (!Array.isArray(matched)) return;
    matched.forEach((operation) => {
      const operationKey = getDedupKey(operation);
      if (seen.has(operationKey)) return;
      seen.add(operationKey);
      operations.push(operation);
    });
  });
  return operations;
}

export function selectFinanceOperationsExactFirst(groups = {}, financeIndex = new Map(), options = {}) {
  const exactOperations = collectFinanceOperationsByKeys(financeIndex, groups.exactKeys, options.getDedupKey);
  if (exactOperations.length > 0) {
    if (options.includeFallbackWithExact === true && options.allowParentFallbackForChild === true) {
      const seen = new Set(exactOperations.map((operation) => (options.getDedupKey ?? JSON.stringify)(operation)));
      const fallbackOperations = collectFinanceOperationsByKeys(
        financeIndex,
        groups.fallbackKeys,
        options.getDedupKey,
        seen
      );
      return [...exactOperations, ...fallbackOperations];
    }
    return exactOperations;
  }
  if (groups.hasChildExactKey && options.allowParentFallbackForChild !== true) return [];
  return collectFinanceOperationsByKeys(financeIndex, groups.fallbackKeys, options.getDedupKey);
}

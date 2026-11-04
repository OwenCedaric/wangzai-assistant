import { getFinancePostingBaseKey, normalizeFinancePostingId } from './profitFinanceMatching.js';

const PLACEHOLDER_VALUES = new Set(['', '未返回', '待确认', '读取失败', '未读取', 'null', 'undefined', 'nan']);
const MONEY_EPSILON = 0.005;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value)
    .trim()
    .replace(/[¥￥元₽]/g, '')
    .replace(/\b(?:cny|rmb|rub|rur)\b/gi, '')
    .replace(/руб\.?/gi, '')
    .replace(/,/g, '.')
    .replace(/[^0-9.+-]/g, '');
  if (!normalized || normalized === '-' || normalized === '.' || normalized === '-.') return null;
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeMoney(value) {
  const number = toFiniteNumber(value);
  return number === null ? null : Math.abs(number);
}

function roundMoney(value) {
  const number = toFiniteNumber(value);
  return number === null ? null : Number(number.toFixed(4));
}

function getRowShopScope(row = {}) {
  return (
    normalizeFinancePostingId(
      firstFilled(row.shopClientId, row.clientId, row.shopId, row.shopName, row.shop, row.storeName)
    ) || 'unknown-shop'
  );
}

function getDetailShopScope(detail = {}) {
  return (
    normalizeFinancePostingId(
      firstFilled(detail.shopClientId, detail.clientId, detail.shopId, detail.shopName, detail.shop, detail.storeName)
    ) || 'unknown-shop'
  );
}

function getRowPostingNumber(row = {}) {
  return normalizeFinancePostingId(
    firstFilled(
      row.posting,
      row.id,
      row.postingNumber,
      row.posting_number,
      row.softwareOrderId,
      row.raw?.posting_number,
      row.raw?.postingNumber,
      row.raw?.analytics_data?.posting_number,
      row.profitLedger?.orderSnapshot?.posting,
      row.profitLedger?.orderSnapshot?.id
    )
  );
}

function getDetailPostingNumber(detail = {}) {
  return normalizeFinancePostingId(
    firstFilled(
      detail.postingNumber,
      detail.posting_number,
      detail.posting?.posting_number,
      detail.posting?.postingNumber,
      detail.orderId,
      detail.order_id
    )
  );
}

function getScopedBaseKey(scope, baseKey) {
  const normalizedBase = normalizeFinancePostingId(baseKey);
  if (!normalizedBase) return '';
  return `${normalizeFinancePostingId(scope) || 'unknown-shop'}:${normalizedBase}`;
}

function getRowAmountWeight(row = {}) {
  return normalizeMoney(
    firstFilled(
      row.amountValue,
      row.salesAmountValue,
      row.orderAmountValue,
      row.profitLedger?.amounts?.salesAmountCny?.value,
      row.salesAmount,
      row.amount
    )
  );
}

function getRowQuantityWeight(row = {}) {
  const productQty = Array.isArray(row.products)
    ? row.products.reduce((sum, product) => sum + (normalizeMoney(firstFilled(product?.qty, product?.quantity, product?.count)) ?? 0), 0)
    : 0;
  return normalizeMoney(firstFilled(row.qty, row.quantity, row.count, row.items, productQty || ''));
}

function getChildRowsForGroup(group = {}) {
  return [...group.childRows.values()].sort((left, right) => {
    const leftPosting = getRowPostingNumber(left);
    const rightPosting = getRowPostingNumber(right);
    return leftPosting.localeCompare(rightPosting, 'en', { numeric: true });
  });
}

function createAllocationShares(totalAmount, childRows = []) {
  const total = normalizeMoney(totalAmount);
  if (total === null || !childRows.length) return [];
  const amountWeights = childRows.map(getRowAmountWeight);
  const amountTotal = amountWeights.reduce((sum, value) => sum + (value ?? 0), 0);
  const quantityWeights = childRows.map(getRowQuantityWeight);
  const quantityTotal = quantityWeights.reduce((sum, value) => sum + (value ?? 0), 0);
  const weights = amountTotal > 0 ? amountWeights : quantityTotal > 0 ? quantityWeights : childRows.map(() => 1);
  const weightTotal = amountTotal > 0 ? amountTotal : quantityTotal > 0 ? quantityTotal : childRows.length;
  let allocated = 0;
  return childRows.map((row, index) => {
    const isLast = index === childRows.length - 1;
    const value = isLast ? roundMoney(total - allocated) : roundMoney((total * (weights[index] ?? 0)) / weightTotal);
    allocated += value ?? 0;
    return { row, amountCny: value ?? 0 };
  });
}

function normalizePenaltyDetailRecords(source) {
  if (!source) return [];
  if (source instanceof Map) return [...source.values()].flatMap(normalizePenaltyDetailRecords);
  if (Array.isArray(source)) return source.flatMap(normalizePenaltyDetailRecords);
  if (!isPlainObject(source)) return [];
  if (Array.isArray(source.records)) return normalizePenaltyDetailRecords(source.records);
  if (isPlainObject(source.profitPenaltyDetails) || isPlainObject(source.penaltyDetails)) {
    return [
      ...normalizePenaltyDetailRecords(source.profitPenaltyDetails),
      ...normalizePenaltyDetailRecords(source.penaltyDetails),
    ];
  }
  if (source.postingNumber || source.posting_number || source.operationId || source.operation_id || source.dedupeKey) {
    return [source];
  }
  return Object.values(source).flatMap(normalizePenaltyDetailRecords);
}

function getPenaltyDetailAmount(detail = {}) {
  return normalizeMoney(
    firstFilled(
      detail.amountCny,
      detail.error_fee_cny,
      detail.errorFeeCny,
      detail.penaltyFeeCny,
      detail.fineFeeCny,
      detail.rawAmount
    )
  );
}

function getPenaltyDetailOperationId(detail = {}, postingNumber = '') {
  return normalizeFinancePostingId(
    firstFilled(detail.operationId, detail.operation_id, detail.transactionId, detail.transaction_id, detail.dedupeKey)
  ) || `local-penalty:${postingNumber}:${getPenaltyDetailAmount(detail) ?? 'pending'}:${firstFilled(detail.operationDate, detail.date)}`;
}

function createPenaltyOperation(detail = {}, postingNumber = '', amountCny = getPenaltyDetailAmount(detail), options = {}) {
  const operationIdBase = getPenaltyDetailOperationId(detail, postingNumber);
  const operationId = options.allocationId ? `${operationIdBase}:allocated:${options.allocationId}` : operationIdBase;
  const normalizedAmount = roundMoney(amountCny);
  const operation = {
    operation_id: operationId,
    operation_type: firstFilled(detail.operation_type, detail.operationType, detail.operationTypeName) || 'DefectFineCancellation',
    operation_type_name: firstFilled(detail.operation_type_name, detail.operationName, detail.type) || 'Ozon penalty fee',
    operation_date: firstFilled(detail.operation_date, detail.operationDate, detail.date) || null,
    posting_number: postingNumber,
    posting: {
      posting_number: postingNumber,
    },
    order_id: firstFilled(detail.orderId, detail.order_id, getFinancePostingBaseKey(postingNumber), postingNumber),
    shopId: firstFilled(detail.shopId, detail.shop_id),
    shopClientId: firstFilled(detail.shopClientId, detail.clientId),
    currency_code: 'CNY',
    __source: options.source || detail.source || 'local_profit_penalty_detail',
    __raw: detail,
  };
  if (normalizedAmount !== null) operation.error_fee_cny = normalizedAmount;
  return operation;
}

function getOperationDedupKey(operation = {}) {
  return [
    normalizeFinancePostingId(operation.operation_id),
    normalizeFinancePostingId(operation.posting_number || operation.posting?.posting_number),
    operation.error_fee_cny ?? 'pending',
  ].join(':');
}

function addOperationToIndex(index, key, operation) {
  const normalizedKey = normalizeFinancePostingId(key);
  if (!normalizedKey || !operation) return;
  const current = index.get(normalizedKey) ?? [];
  const operationKey = getOperationDedupKey(operation);
  if (current.some((item) => getOperationDedupKey(item) === operationKey)) return;
  index.set(normalizedKey, [...current, operation]);
}

function addOperationPostingKeys(index, operation = {}) {
  const postingNumber = normalizeFinancePostingId(operation.posting_number || operation.posting?.posting_number);
  if (!postingNumber) return;
  addOperationToIndex(index, postingNumber, operation);
  const baseKey = getFinancePostingBaseKey(postingNumber);
  if (baseKey) addOperationToIndex(index, baseKey, operation);
  const shopScope = normalizeFinancePostingId(firstFilled(operation.shopClientId, operation.shopId));
  if (shopScope) {
    addOperationToIndex(index, `${shopScope}:${postingNumber}`, operation);
    if (baseKey) addOperationToIndex(index, `${shopScope}:${baseKey}`, operation);
  }
}

function getPenaltyGroups(rows = [], details = []) {
  const groups = new Map();
  const ensureGroup = (scope, baseKey) => {
    const scopedBaseKey = getScopedBaseKey(scope, baseKey);
    if (!scopedBaseKey) return null;
    const group = groups.get(scopedBaseKey) ?? {
      scope: normalizeFinancePostingId(scope) || 'unknown-shop',
      baseKey: normalizeFinancePostingId(baseKey),
      childRows: new Map(),
      parentRows: [],
      childDetails: [],
      parentDetails: [],
    };
    groups.set(scopedBaseKey, group);
    return group;
  };

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const postingNumber = getRowPostingNumber(row);
    const baseKey = getFinancePostingBaseKey(postingNumber) || postingNumber;
    const group = ensureGroup(getRowShopScope(row), baseKey);
    if (!group) return;
    if (getFinancePostingBaseKey(postingNumber)) {
      group.childRows.set(postingNumber, row);
    } else {
      group.parentRows.push(row);
    }
  });

  details.forEach((detail) => {
    const postingNumber = getDetailPostingNumber(detail);
    if (!postingNumber) return;
    const baseKey = getFinancePostingBaseKey(postingNumber) || postingNumber;
    const group = ensureGroup(getDetailShopScope(detail), baseKey);
    if (!group) return;
    if (getFinancePostingBaseKey(postingNumber)) {
      group.childDetails.push(detail);
    } else {
      group.parentDetails.push(detail);
    }
  });

  return groups;
}

function sumReadyDetails(details = []) {
  const amounts = details.map(getPenaltyDetailAmount).filter((value) => value !== null);
  return amounts.length ? amounts.reduce((sum, value) => sum + value, 0) : null;
}

function addChildDetails(index, childDetails = []) {
  childDetails.forEach((detail) => {
    const postingNumber = getDetailPostingNumber(detail);
    if (!postingNumber) return;
    addOperationPostingKeys(index, createPenaltyOperation(detail, postingNumber));
  });
}

function addAllocatedParentDetails(index, group = {}) {
  const childRows = getChildRowsForGroup(group);
  if (!childRows.length) {
    group.parentDetails.forEach((detail) => {
      const postingNumber = getDetailPostingNumber(detail);
      if (postingNumber) addOperationPostingKeys(index, createPenaltyOperation(detail, postingNumber));
    });
    return;
  }

  const childTotal = sumReadyDetails(group.childDetails);
  const parentTotal = sumReadyDetails(group.parentDetails);
  if (parentTotal !== null && childTotal !== null && parentTotal <= childTotal + MONEY_EPSILON) return;

  if (parentTotal !== null) {
    const amountToAllocate = childTotal === null ? parentTotal : parentTotal - childTotal;
    createAllocationShares(amountToAllocate, childRows).forEach(({ row, amountCny }) => {
      const postingNumber = getRowPostingNumber(row);
      if (!postingNumber || amountCny <= 0) return;
      const detail = group.parentDetails[0] ?? {};
      addOperationPostingKeys(
        index,
        createPenaltyOperation(detail, postingNumber, amountCny, {
          allocationId: `${group.baseKey}:${postingNumber}`,
          source: 'allocated_parent_profit_penalty_detail',
        })
      );
    });
    return;
  }

  if (group.childDetails.length) return;
  group.parentDetails.forEach((detail) => {
    childRows.forEach((row) => {
      const postingNumber = getRowPostingNumber(row);
      if (!postingNumber) return;
      addOperationPostingKeys(
        index,
        createPenaltyOperation(detail, postingNumber, null, {
          allocationId: `${group.baseKey}:${postingNumber}:pending`,
          source: 'allocated_parent_profit_penalty_detail',
        })
      );
    });
  });
}

export function buildProfitPenaltyAttributionIndex(rows = [], detailSource = {}) {
  const index = new Map();
  const details = normalizePenaltyDetailRecords(detailSource);
  const groups = getPenaltyGroups(rows, details);
  groups.forEach((group) => {
    addChildDetails(index, group.childDetails);
    addAllocatedParentDetails(index, group);
  });
  return index;
}

export function mergeProfitPenaltyOperationIndexes(...indexes) {
  const merged = new Map();
  indexes.forEach((index) => {
    if (!(index instanceof Map)) return;
    index.forEach((operations, key) => {
      (Array.isArray(operations) ? operations : []).forEach((operation) => {
        addOperationToIndex(merged, key, operation);
      });
    });
  });
  return merged;
}

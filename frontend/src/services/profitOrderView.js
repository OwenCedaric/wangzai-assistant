function toFiniteProfitNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).replace(/[^\d.-]/g, '');
  if (!normalized || normalized === '-' || normalized === '.' || normalized === '-.') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeProfitOrderId(value = '') {
  return String(value ?? '').trim().replace(/\s+/g, '');
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === 0 || value === false) return value;
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text && !['未返回', '待确认', '读取失败', '未读取', 'null', 'undefined', 'nan'].includes(text.toLowerCase())) {
      return value;
    }
  }
  return '';
}

function hasProfitOrderSplitSuffix(value = '') {
  return /^.+?-\d{3,}-\d+$/.test(normalizeProfitOrderId(value));
}

function getProfitOrderId(order = {}) {
  const snapshot = order.profitLedger?.orderSnapshot ?? {};
  const candidates = [
    order.id ||
      order.posting ||
      order.postingNumber ||
      order.posting_number ||
      order.salesOrder ||
      order.raw?.posting_number ||
      order.raw?.postingNumber,
    order.posting,
    order.postingNumber,
    order.posting_number,
    order.salesOrder,
    order.raw?.posting_number,
    order.raw?.postingNumber,
    order.raw?.analytics_data?.posting_number,
    snapshot.id,
    snapshot.posting,
    snapshot.salesOrder,
  ].filter(Boolean);
  const splitCandidate = candidates.find(hasProfitOrderSplitSuffix);
  return normalizeProfitOrderId(splitCandidate || candidates[0]);
}

function getProfitOrderShopScope(order = {}) {
  const snapshot = order.profitLedger?.orderSnapshot ?? {};
  return normalizeProfitOrderId(
    order.shopClientId ||
      order.clientId ||
      order.shopId ||
      order.shop ||
      snapshot.shopClientId ||
      snapshot.clientId ||
      snapshot.shopId ||
      snapshot.shop
  );
}

function getProfitOrderSplitInfo(order = {}) {
  const id = getProfitOrderId(order);
  const match = id.match(/^(.+?-\d{3,})(?:-(\d+))$/);
  const shopScope = getProfitOrderShopScope(order);
  if (match) {
    return { id, baseKey: `${shopScope || 'unknown-shop'}:${match[1]}`, suffix: Number(match[2]) };
  }
  return { id, baseKey: id ? `${shopScope || 'unknown-shop'}:${id}` : '', suffix: null };
}

function getProfitOrderPaymentSortTime(row = {}) {
  const snapshot = row.profitLedger?.orderSnapshot ?? {};
  const raw = firstFilled(
    row.paymentDate,
    row.paymentTime,
    row.paidAt,
    row.inProcessAt,
    row.raw?.paid_at,
    row.raw?.payment_date,
    row.raw?.paymentDate,
    row.raw?.in_process_at,
    row.raw?.created_at,
    row.raw?.createdAt,
    snapshot.paymentDate,
    snapshot.paymentTime
  );
  if (!raw) return 0;
  const directTime = new Date(raw).getTime();
  if (Number.isFinite(directTime)) return directTime;
  const text = String(raw).trim();
  const fullDateTime = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (fullDateTime) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = fullDateTime;
    const time = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ).getTime();
    return Number.isFinite(time) ? time : 0;
  }
  return 0;
}

function getProfitOrderStableSortKey(row = {}) {
  const snapshot = row.profitLedger?.orderSnapshot ?? {};
  const posting = normalizeProfitOrderId(
    firstFilled(row.posting, row.id, row.postingNumber, row.posting_number, snapshot.posting, snapshot.id)
  );
  const splitInfo = getProfitOrderSplitInfo({ ...row, posting: posting || row.posting });
  const suffix = splitInfo.suffix === null ? Number.MAX_SAFE_INTEGER : splitInfo.suffix;
  return {
    base: splitInfo.baseKey || posting || normalizeProfitOrderId(row.salesOrder || snapshot.salesOrder),
    suffix,
    posting,
  };
}

export function sortProfitOrdersByPaymentDateDesc(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
    const leftTime = getProfitOrderPaymentSortTime(left);
    const rightTime = getProfitOrderPaymentSortTime(right);
    if (leftTime !== rightTime) return rightTime - leftTime;
    const leftKey = getProfitOrderStableSortKey(left);
    const rightKey = getProfitOrderStableSortKey(right);
    const baseCompare = leftKey.base.localeCompare(rightKey.base, 'en', { numeric: true });
    if (baseCompare !== 0) return baseCompare;
    if (leftKey.suffix !== rightKey.suffix) return leftKey.suffix - rightKey.suffix;
    return leftKey.posting.localeCompare(rightKey.posting, 'en', { numeric: true });
  });
}

function getProfitLedgerResultEntry(order = {}, resultKey = '') {
  const result = order.profitLedger?.results?.[resultKey];
  return result && typeof result === 'object' ? result : null;
}

function getProfitLedgerResultValue(order = {}, resultKey = '') {
  const result = getProfitLedgerResultEntry(order, resultKey);
  if (!result) return null;
  const status = String(result.status ?? '').trim();
  if (status && status !== 'ready') return null;
  return toFiniteProfitNumber(result.value);
}

function firstProfitNumber(...values) {
  for (const value of values) {
    const number = toFiniteProfitNumber(value);
    if (number !== null) return number;
  }
  return null;
}

export function getProfitOrderEstimatedValue(order = {}) {
  if (getProfitLedgerResultEntry(order, 'estimatedProfitCny')) {
    return getProfitLedgerResultValue(order, 'estimatedProfitCny');
  }
  return firstProfitNumber(
    order.estimatedProfitValue
  );
}

export function getProfitOrderActualValue(order = {}) {
  if (getProfitLedgerResultEntry(order, 'actualProfitCny')) {
    return getProfitLedgerResultValue(order, 'actualProfitCny');
  }
  return firstProfitNumber(
    order.actualProfitValue
  );
}

export function getProfitOrderRefundLossValue(order = {}) {
  if (getProfitLedgerResultEntry(order, 'refundLossCny')) {
    const refundLossValue = getProfitLedgerResultValue(order, 'refundLossCny');
    return refundLossValue === null ? null : -refundLossValue;
  }
  return firstProfitNumber(order.signedRefundLossValue);
}

export function getProfitOrderBestValue(order = {}) {
  if (getProfitLedgerResultEntry(order, 'bestProfitCny')) {
    return getProfitLedgerResultValue(order, 'bestProfitCny');
  }
  return firstProfitNumber(
    order.profitLossValue
  );
}

export function getProfitOrderProfitLossInfo(order = {}) {
  const refundLossValue = getProfitOrderRefundLossValue(order);
  if (refundLossValue !== null) {
    return {
      value: refundLossValue,
      source: 'actual-refund-loss',
      isEstimatedFallback: false,
    };
  }
  const actualValue = getProfitOrderActualValue(order);
  if (actualValue !== null) {
    return {
      value: actualValue,
      source: 'actual',
      isEstimatedFallback: false,
    };
  }
  const estimatedValue = getProfitOrderEstimatedValue(order);
  if (estimatedValue !== null) {
    return {
      value: estimatedValue,
      source: 'estimated',
      isEstimatedFallback: true,
    };
  }
  return {
    value: null,
    source: 'pending',
    isEstimatedFallback: false,
  };
}

export function getProfitOrderProfitLossValue(order = {}) {
  return getProfitOrderProfitLossInfo(order).value;
}

export function getProfitOrderModeValue(order = {}, mode = 'mixed') {
  if (mode === 'actual') return getProfitOrderActualValue(order);
  if (mode === 'estimated') return getProfitOrderEstimatedValue(order);
  return getProfitOrderProfitLossValue(order);
}

export function hasProfitCalculationResult(order = {}, mode = 'mixed') {
  return getProfitOrderModeValue(order, mode) !== null;
}

function doesProfitOrderMatchAllTab(order = {}, mode = 'mixed') {
  if (mode === 'mixed') return true;
  return hasProfitCalculationResult(order, mode);
}

export function getProfitTabCount(rows = [], tabValue = 'all', mode = 'mixed') {
  if (tabValue === 'all') {
    return rows.filter((order) => doesProfitOrderMatchAllTab(order, mode)).length;
  }
  if (tabValue === 'loss') {
    return rows.filter((order) => {
      const value = getProfitOrderModeValue(order, mode);
      return value !== null && value < 0;
    }).length;
  }
  if (tabValue === 'profit') {
    return rows.filter((order) => {
      const value = getProfitOrderModeValue(order, mode);
      return value !== null && value > 0;
    }).length;
  }
  if (tabValue === 'estimated') {
    return rows.filter((order) => getProfitOrderEstimatedValue(order) !== null).length;
  }
  return rows.filter((order) => getProfitOrderActualValue(order) !== null).length;
}

export function doesProfitOrderMatchTab(order = {}, tabValue = 'all', mode = 'mixed') {
  if (tabValue === 'all') return doesProfitOrderMatchAllTab(order, mode);
  if (tabValue === 'estimated') return getProfitOrderEstimatedValue(order) !== null;
  if (tabValue === 'actual') return getProfitOrderActualValue(order) !== null;
  const value = getProfitOrderModeValue(order, mode);
  if (tabValue === 'loss') return value !== null && value < 0;
  if (tabValue === 'profit') return value !== null && value > 0;
  return doesProfitOrderMatchAllTab(order, mode);
}

import {
  addMoney,
  countBy,
  createMetric,
  createMoneyAccumulator,
  latestTimestamp,
  normalizeText,
  parseJson,
  roundNumber,
  toFiniteNumber,
  toMoneyBreakdown,
} from '../lib/dataAnalysisUtils.js';

const RETURN_STATUS_LABELS = Object.freeze({
  Utilizing: '处理中',
  Utilized: '已处理',
  UtilizedByOzon: 'Ozon已处理',
  UtilizingByOzon: 'Ozon处理中',
  MoneyReturned: '已退款',
  PartialCompensationReturnedByOzon: 'Ozon已部分补偿',
});

const RETURN_REASON_LABELS = Object.freeze({
  20: '配件或商品不完整',
  22: '发错商品',
  32: '商品不合适',
  79: '买家收货时拒收：商品不合适',
  352: '仓库缺货',
  402: '卖家取消订单',
  506: '买家找到更低价格后取消',
  512: '配送失败',
  537: '买家未取件',
  578: '买家收货时拒收：商品不合适',
  587: '买家拒收：不满意商品质量',
  665: '买家未取件',
  685: '买家应卖家要求取消订单',
  686: '未按时发货',
  940: '海关清关失败',
});

function getReturnProduct(row = {}) {
  const value = parseJson(row.product_json, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getReturnStatusLabel(status = '') {
  const code = normalizeText(status, 'unknown');
  return RETURN_STATUS_LABELS[code] || code;
}

function buildReturnAmount(rows = []) {
  const amount = createMoneyAccumulator();
  let amountKnownCount = 0;
  rows.forEach((row) => {
    const product = getReturnProduct(row);
    const value = toFiniteNumber(product.price);
    if (value !== null) amountKnownCount += 1;
    addMoney(amount, value, product.currency_code || product.currencyCode);
  });
  const result = toMoneyBreakdown(amount);
  const status = !rows.length
    ? 'empty'
    : !amountKnownCount
      ? 'not_returned'
      : result.status !== 'confirmed'
        ? result.status
        : amountKnownCount === rows.length
          ? 'confirmed'
          : 'partial';
  return { ...result, status, amountKnownCount, totalCount: rows.length };
}

function buildReasonCodeBreakdown(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const raw = parseJson(row.raw_json, {});
    const reason = raw?.return_reason && typeof raw.return_reason === 'object' ? raw.return_reason : {};
    const reasonId = normalizeText(reason.id, 'not-returned');
    const sourceName = normalizeText(reason.name || row.return_reason);
    const key = reasonId;
    const current = map.get(key) || {
      reasonId,
      reasonLabel: RETURN_REASON_LABELS[reasonId] || sourceName || '官方原因名称未返回',
      sourceName,
      count: 0,
      isDefect: Boolean(reason.is_defect),
    };
    current.count += 1;
    current.isDefect = current.isDefect || Boolean(reason.is_defect);
    map.set(key, current);
  });
  return [...map.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 20)
    .map((row) => ({ ...row, sourceId: 'returns' }));
}

function buildRecentReturns(rows = []) {
  return rows
    .map((row) => {
      const product = getReturnProduct(row);
      return {
        returnId: normalizeText(row.return_id || row.return_key || row.id),
        postingNumber: normalizeText(row.posting_number),
        status: normalizeText(row.status),
        statusLabel: getReturnStatusLabel(row.status),
        createdAt: row.created_at_remote || null,
        productName: normalizeText(product.name, product.offer_id || product.sku || '商品名未返回'),
        offerId: normalizeText(product.offer_id),
        sku: normalizeText(product.sku),
        amount: toFiniteNumber(product.price),
        currency: normalizeText(product.currency_code || product.currencyCode, 'UNKNOWN').toUpperCase(),
        sourceId: 'returns',
      };
    })
    .sort((left, right) => normalizeText(right.createdAt).localeCompare(normalizeText(left.createdAt)))
    .slice(0, 30);
}

function getDistinctPostingCount(rows = []) {
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => normalizeText(row.posting_number))
      .filter(Boolean)
  ).size;
}

function countReturnsLinkedToSelectedOrders(allRows = [], orderRows = []) {
  const orderPostings = new Set(
    (Array.isArray(orderRows) ? orderRows : [])
      .map((row) => normalizeText(row.posting_number))
      .filter(Boolean)
  );
  if (!orderPostings.size) return 0;
  return getDistinctPostingCount(
    (Array.isArray(allRows) ? allRows : []).filter((row) => orderPostings.has(normalizeText(row.posting_number)))
  );
}

export function calculateAfterSalesAnalysis({ rows = [], comparisonRows = [], allRows = [], orderRows = [] } = {}) {
  const sourceSyncedAt = latestTimestamp([...rows, ...comparisonRows], [
    'updated_at',
    'updated_at_remote',
    'last_seen_at',
  ]);
  const currentAmount = buildReturnAmount(rows);
  const previousAmount = buildReturnAmount(comparisonRows);
  const statusBreakdown = countBy(rows, (row) => getReturnStatusLabel(row.status));
  const processingCount = rows.filter((row) => ['Utilizing', 'UtilizingByOzon'].includes(normalizeText(row.status))).length;
  const defectCount = rows.filter((row) => Boolean(parseJson(row.raw_json, {})?.return_reason?.is_defect)).length;
  const currentReturnOrderCount = getDistinctPostingCount(rows);
  const previousReturnOrderCount = getDistinctPostingCount(comparisonRows);
  const linkedSelectedOrderReturnCount = countReturnsLinkedToSelectedOrders(allRows, orderRows);

  return {
    sourceSyncedAt,
    metrics: [
      createMetric({
        id: 'returnCount',
        label: '本期新建售后单',
        value: rows.length,
        unit: 'count',
        sourceId: 'returns',
        sourceLabel: 'Ozon售后SQLite缓存',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        comparisonValue: comparisonRows.length,
        detail: '按平台售后编号去重后的本期新建售后记录数。售后创建时间与下单时间不是同一口径。',
      }),
      createMetric({
        id: 'returnOrderCount',
        label: '本期涉及订单',
        value: currentReturnOrderCount,
        unit: 'count',
        sourceId: 'returns',
        sourceLabel: '平台售后订单关联',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        comparisonValue: previousReturnOrderCount,
        detail: '本期新建售后涉及的去重订单数；一笔订单可能包含多笔售后。',
      }),
      createMetric({
        id: 'processingReturnCount',
        label: '本期仍处理中',
        value: processingCount,
        unit: 'count',
        sourceId: 'returns',
        sourceLabel: 'Ozon售后状态',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: '所选期间新建且当前状态为Utilizing或UtilizingByOzon的售后。',
      }),
      createMetric({
        id: 'defectReturnCount',
        label: '本期质量问题',
        value: defectCount,
        unit: 'count',
        sourceId: 'returns',
        sourceLabel: 'Ozon return_reason.is_defect',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: '仅统计所选期间平台明确返回is_defect=true的售后。',
      }),
      createMetric({
        id: 'returnProductAmount',
        label: '售后商品金额',
        value: currentAmount.value,
        unit: 'money',
        currency: currentAmount.currency,
        status: currentAmount.status,
        sourceId: 'returns',
        sourceLabel: 'Ozon售后商品金额',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        comparisonValue:
          currentAmount.status === 'confirmed' &&
          previousAmount.status === 'confirmed' &&
          currentAmount.currency &&
          currentAmount.currency === previousAmount.currency
            ? previousAmount.value
            : null,
        detail: `售后商品金额字段返回 ${currentAmount.amountKnownCount}/${currentAmount.totalCount} 行；不是最终实际退款金额。`,
        breakdown: currentAmount.breakdown,
      }),
    ],
    statusBreakdown,
    reasonCodeBreakdown: buildReasonCodeBreakdown(rows),
    recentRows: buildRecentReturns(rows),
    dataQuality: {
      reasonTextStatus: 'confirmed',
      reasonTextNote: '售后原因名称已按官方原因编号映射为中文；未知编号保留平台原始名称。',
      reasonCodeReturnedCount: rows.filter((row) =>
        normalizeText(parseJson(row.raw_json, {})?.return_reason?.id)
      ).length,
      currentReturnOrderCount,
      linkedSelectedOrderReturnCount,
      selectedOrderRateStatus:
        orderRows.length && linkedSelectedOrderReturnCount >= 0
          ? 'available_for_manual_review'
          : 'orders_not_available',
      selectedOrderRateNote:
        '售后创建期与下单期不同，页面不再把两类独立期间直接相除为百分比。',
      amountCurrencyStatus: currentAmount.status,
      amountCurrencyBreakdown: currentAmount.breakdown,
      amountKnownCount: currentAmount.amountKnownCount,
      amountExpectedCount: currentAmount.totalCount,
    },
    rowCount: rows.length,
  };
}

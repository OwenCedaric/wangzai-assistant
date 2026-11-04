import {
  addMoney,
  calculateDelta,
  calculatePercent,
  countBy,
  createMetric,
  createMoneyAccumulator,
  latestTimestamp,
  normalizeText,
  roundNumber,
  toFiniteNumber,
  toMoneyBreakdown,
} from '../lib/dataAnalysisUtils.js';

const DEFAULT_OZON_SETTLEMENT_CURRENCY = 'RUB';

function resolveFinanceCurrency(row = {}) {
  const direct = normalizeText(row.currency_code).toUpperCase();
  if (direct) return { currency: direct, source: 'finance.currency_code', inferred: false };
  return {
    currency: DEFAULT_OZON_SETTLEMENT_CURRENCY,
    source: 'ozon_finance_settlement_currency',
    inferred: true,
  };
}

function summarizeFinanceRows(rows = []) {
  const net = createMoneyAccumulator();
  const positive = createMoneyAccumulator();
  const negative = createMoneyAccumulator();
  const acquiring = createMoneyAccumulator();
  const commission = createMoneyAccumulator();
  let officialCurrencyRows = 0;
  let inferredCurrencyRows = 0;

  rows.forEach((row) => {
    const resolved = resolveFinanceCurrency(row);
    const amount = toFiniteNumber(row.amount_total);
    if (resolved.inferred) inferredCurrencyRows += 1;
    else officialCurrencyRows += 1;
    addMoney(net, amount, resolved.currency);
    if (amount !== null && amount >= 0) addMoney(positive, amount, resolved.currency);
    if (amount !== null && amount < 0) addMoney(negative, Math.abs(amount), resolved.currency);
    addMoney(acquiring, row.acquiring_fee_cny, resolved.currency);
    addMoney(commission, row.sale_commission_cny, resolved.currency);
  });

  return {
    rowCount: rows.length,
    officialCurrencyRows,
    inferredCurrencyRows,
    settlementCurrencyRows: officialCurrencyRows + inferredCurrencyRows,
    currencyCoveragePercent: rows.length
      ? roundNumber(((officialCurrencyRows + inferredCurrencyRows) / rows.length) * 100, 2)
      : null,
    net: toMoneyBreakdown(net),
    positive: toMoneyBreakdown(positive),
    negative: toMoneyBreakdown(negative),
    acquiring: toMoneyBreakdown(acquiring),
    commission: toMoneyBreakdown(commission),
  };
}

function metricFromMoney({ id, label, money, previousMoney, sourceSyncedAt, detail }) {
  const comparable =
    money.currency &&
    previousMoney.currency &&
    money.currency !== 'MIXED' &&
    money.currency !== 'UNKNOWN' &&
    money.currency === previousMoney.currency;
  return createMetric({
    id,
    label,
    value: money.value,
    unit: 'money',
    currency: money.currency,
    status: money.status,
    sourceId: 'finance',
    sourceLabel: 'Ozon财务流水SQLite缓存',
    sourceType: 'official-cache',
    syncedAt: sourceSyncedAt,
    comparisonValue: comparable ? previousMoney.value : null,
    delta: comparable ? calculateDelta(money.value, previousMoney.value) : null,
    detail,
    breakdown: money.breakdown,
  });
}

function buildOperationBreakdown(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const code = normalizeText(row.operation_type, '未返回操作类型');
    const current = map.get(code) || {
      code,
      count: 0,
      amount: createMoneyAccumulator(),
    };
    current.count += 1;
    const resolved = resolveFinanceCurrency(row);
    addMoney(current.amount, row.amount_total, resolved.currency);
    map.set(code, current);
  });
  return [...map.values()]
    .sort((left, right) => right.count - left.count)
    .map((row) => ({
      code: row.code,
      count: row.count,
      amount: toMoneyBreakdown(row.amount),
      sourceId: 'finance',
    }));
}

function buildLargestDeductions(rows = []) {
  return rows
    .map((row) => {
      const amount = toFiniteNumber(row.amount_total);
      const resolved = resolveFinanceCurrency(row);
      return {
        operationId: normalizeText(row.operation_id || row.operation_key || row.id),
        postingNumber: normalizeText(row.posting_number),
        operationType: normalizeText(row.operation_type, '未返回操作类型'),
        operationDate: row.operation_date || null,
        amount: amount === null ? null : roundNumber(amount, 2),
        currency: resolved.currency,
        currencySource: resolved.source,
        sourceId: 'finance',
      };
    })
    .filter((row) => row.amount !== null && row.amount < 0)
    .sort((left, right) => left.amount - right.amount)
    .slice(0, 30);
}

function buildCurrencyConversionRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const resolved = resolveFinanceCurrency(row);
    return {
      operationId: normalizeText(row.operation_id || row.operation_key || row.id),
      postingNumber: normalizeText(row.posting_number),
      operationType: normalizeText(row.operation_type, '未返回操作类型'),
      operationDate: row.operation_date || row.created_at || null,
      amount: toFiniteNumber(row.amount_total),
      currency: resolved.currency,
      currencySource: resolved.source,
      sourceId: 'finance',
    };
  });
}

function buildPurchaseCostSummary(overrides = [], currentOrderRows = []) {
  const identityCandidates = (value) => {
    const text = normalizeText(value);
    if (!text) return [];
    const suffix = text.includes(':') ? normalizeText(text.split(':').at(-1)) : '';
    return [...new Set([text, suffix].filter(Boolean))];
  };
  const canonicalIdentity = (value) => {
    const candidates = identityCandidates(value);
    return candidates.find((candidate) => !candidate.includes(':')) || candidates[0] || '';
  };
  const eligibleOrders = currentOrderRows.filter(
    (row) => normalizeText(row.status).toLowerCase() !== 'cancelled'
  );
  const currentPostings = new Set(
    eligibleOrders
      .map((row) => canonicalIdentity(row.posting_number || row.order_key || row.order_id))
      .filter(Boolean)
  );
  const latestByPosting = new Map();
  overrides.forEach((row) => {
    const identity = canonicalIdentity(row.posting_number || row.order_key || row.ozon_order_id);
    if (!identity || !currentPostings.has(identity)) return;
    const current = latestByPosting.get(identity);
    const currentUpdatedAt = normalizeText(current?.updated_at || current?.created_at);
    const nextUpdatedAt = normalizeText(row.updated_at || row.created_at);
    const currentHasCost = toFiniteNumber(current?.source_cost_cny) !== null;
    const nextHasCost = toFiniteNumber(row.source_cost_cny) !== null;
    if (
      !current ||
      (nextHasCost && !currentHasCost) ||
      (nextHasCost === currentHasCost && nextUpdatedAt >= currentUpdatedAt)
    ) {
      latestByPosting.set(identity, row);
    }
  });
  const relevant = [...latestByPosting.values()];
  const confirmed = relevant.filter((row) => toFiniteNumber(row.source_cost_cny) !== null);
  const cost = confirmed.reduce((total, row) => total + (toFiniteNumber(row.source_cost_cny) || 0), 0);
  return {
    relevantCount: relevant.length,
    confirmedCount: confirmed.length,
    orderCount: currentPostings.size,
    value: roundNumber(cost, 2) || 0,
    coveragePercent: currentPostings.size
      ? roundNumber((confirmed.length / currentPostings.size) * 100, 2)
      : null,
    sourceSyncedAt: latestTimestamp(confirmed, ['updated_at']),
  };
}

function summarizeProfitLedger(rows = [], sourceSyncedAt = null) {
  const scopedRows = Array.isArray(rows) ? rows : [];
  const readyRows = scopedRows.filter((row) => {
    const result = row?.results?.actualProfitCny;
    return normalizeText(result?.status).toLowerCase() === 'ready' && toFiniteNumber(result?.value) !== null;
  });
  const actualNetProfit = roundNumber(
    readyRows.reduce((total, row) => total + (toFiniteNumber(row?.results?.actualProfitCny?.value) || 0), 0),
    2
  ) || 0;
  const coveragePercent = scopedRows.length
    ? roundNumber((readyRows.length / scopedRows.length) * 100, 2)
    : null;
  return {
    rowCount: scopedRows.length,
    readyCount: readyRows.length,
    pendingCount: Math.max(0, scopedRows.length - readyRows.length),
    actualNetProfit,
    coveragePercent,
    sourceSyncedAt,
  };
}

export function calculateFinanceAnalysis({
  rows = [],
  comparisonRows = [],
  currentOrderRows = [],
  purchaseOverrides = [],
  profitLedgerRows = [],
  profitLedgerSourceSyncedAt = null,
} = {}) {
  const current = summarizeFinanceRows(rows);
  const previous = summarizeFinanceRows(comparisonRows);
  const sourceSyncedAt = latestTimestamp([...rows, ...comparisonRows], ['updated_at', 'last_seen_at']);
  const purchase = buildPurchaseCostSummary(purchaseOverrides, currentOrderRows);
  const purchaseCostStatus = !purchase.orderCount
    ? 'empty'
    : !purchase.confirmedCount
      ? 'not_returned'
      : purchase.confirmedCount === purchase.orderCount
        ? 'confirmed'
        : 'partial';
  const negativeCount = rows.filter((row) => (toFiniteNumber(row.amount_total) || 0) < 0).length;
  const profitLedger = summarizeProfitLedger(profitLedgerRows, profitLedgerSourceSyncedAt);
  const actualNetProfitStatus = !profitLedger.rowCount
    ? 'insufficient_sources'
    : profitLedger.readyCount === profitLedger.rowCount
      ? 'confirmed'
      : profitLedger.readyCount
        ? 'partial'
        : 'not_returned';

  return {
    sourceSyncedAt,
    metrics: [
      metricFromMoney({
        id: 'financeNetAmount',
        label: '平台流水净额',
        money: current.net,
        previousMoney: previous.net,
        sourceSyncedAt,
        detail: '所选期间Ozon财务流水amount汇总；币种缺失的流水单独标记，不与已确认币种合并。',
      }),
      metricFromMoney({
        id: 'financeIncomeAmount',
        label: '正向流水',
        money: current.positive,
        previousMoney: previous.positive,
        sourceSyncedAt,
        detail: 'amount大于等于0的财务流水汇总。',
      }),
      metricFromMoney({
        id: 'financeDeductionAmount',
        label: '扣减流水',
        money: current.negative,
        previousMoney: previous.negative,
        sourceSyncedAt,
        detail: 'amount小于0的财务流水绝对值汇总。',
      }),
      createMetric({
        id: 'financeTransactionCount',
        label: '财务流水数',
        value: current.rowCount,
        unit: 'count',
        sourceId: 'finance',
        sourceLabel: 'Ozon财务流水SQLite缓存',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        comparisonValue: previous.rowCount,
        detail: '按operation_key去重后的财务流水数。',
      }),
      createMetric({
        id: 'negativeTransactionCount',
        label: '扣减笔数',
        value: negativeCount,
        unit: 'count',
        sourceId: 'finance',
        sourceLabel: 'Ozon财务流水SQLite缓存',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: 'amount小于0的流水笔数。',
      }),
      createMetric({
        id: 'financeCurrencyCoverage',
        label: '结算币种判定率',
        value: current.currencyCoveragePercent,
        unit: 'percent',
        status: current.rowCount ? 'confirmed' : 'empty',
        sourceId: 'finance',
        sourceLabel: '平台财务流水结算币种',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        detail: `财务接口直接返回币种 ${current.officialCurrencyRows}/${current.rowCount} 笔；其余 ${current.inferredCurrencyRows} 笔按当前店铺的平台结算规则判定为卢布。`,
      }),
      createMetric({
        id: 'confirmedPurchaseCost',
        label: '已确认采购成本',
        value: purchase.value,
        unit: 'money',
        currency: 'CNY',
        status: purchaseCostStatus,
        sourceId: 'purchase',
        sourceLabel: '拍单人工确认成本SQLite',
        sourceType: 'manual-confirmed',
        syncedAt: purchase.sourceSyncedAt,
        detail: `所选期间未取消订单中 ${purchase.confirmedCount}/${purchase.orderCount} 笔存在人工确认采购成本；取消订单不要求采购成本。`,
      }),
      createMetric({
        id: 'purchaseCostCoverage',
        label: '采购成本覆盖率',
        value: purchase.coveragePercent,
        unit: 'percent',
        status: purchase.orderCount ? 'confirmed' : 'empty',
        sourceId: 'purchase',
        sourceLabel: '拍单人工确认成本SQLite',
        sourceType: 'derived-manual',
        syncedAt: purchase.sourceSyncedAt,
        detail: '已确认采购成本的未取消订单数÷所选期间未取消订单数；按订单身份去重。',
      }),
      createMetric({
        id: 'actualNetProfit',
        label: '实际净利润',
        value: profitLedger.readyCount ? profitLedger.actualNetProfit : null,
        unit: 'money',
        currency: 'CNY',
        status: actualNetProfitStatus,
        sourceId: 'profit-ledger',
        sourceLabel: '利润账本SQLite快照',
        sourceType: 'derived-confirmed',
        syncedAt: profitLedger.sourceSyncedAt,
        detail: profitLedger.rowCount
          ? `当前日期范围共 ${profitLedger.rowCount} 笔利润账本，其中 ${profitLedger.readyCount} 笔已形成实际净利润；未完成订单和费用不完整订单不会伪造结果。`
          : '当前店铺和日期范围没有利润账本；不会用平台流水减采购成本伪造净利润。',
      }),
      createMetric({
        id: 'actualNetProfitCoverage',
        label: '实际利润覆盖率',
        value: profitLedger.coveragePercent,
        unit: 'percent',
        status: profitLedger.rowCount ? 'confirmed' : 'empty',
        sourceId: 'profit-ledger',
        sourceLabel: '利润账本SQLite快照',
        sourceType: 'derived-confirmed',
        syncedAt: profitLedger.sourceSyncedAt,
        detail: '已形成实际净利润的账本数÷当前店铺和日期范围内的利润账本数。',
      }),
    ],
    operationBreakdown: buildOperationBreakdown(rows),
    largestDeductions: buildLargestDeductions(rows),
    currencyConversionRows: buildCurrencyConversionRows(rows),
    comparisonCurrencyConversionRows: buildCurrencyConversionRows(comparisonRows),
    purchaseCost: purchase,
    profitLedger,
    currencyCoverage: {
      confirmedRows: current.settlementCurrencyRows,
      totalRows: current.rowCount,
      percent: current.currencyCoveragePercent,
      settlementCurrency: DEFAULT_OZON_SETTLEMENT_CURRENCY,
      officialCurrencyRows: current.officialCurrencyRows,
      inferredCurrencyRows: current.inferredCurrencyRows,
    },
    rowCount: rows.length,
  };
}

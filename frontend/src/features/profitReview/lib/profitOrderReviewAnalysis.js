function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const number = finite(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function entryValue(entry = null) {
  if (!entry || typeof entry !== 'object') return null;
  return entry.status === 'ready' ? finite(entry.value) : null;
}

function unique(values = []) {
  return [...new Set(values.map(text).filter(Boolean))];
}

const ACTUAL_EXPENSES = Object.freeze([
  ['采购成本', 'sourcePurchaseCostCny'],
  ['实际佣金', 'actualCommissionFeeCny'],
  ['罚款', 'actualPenaltyFeeCny'],
  ['实际收单费', 'actualAcquiringFeeCny'],
  ['实际配送服务费', 'actualDeliveryServiceFeeCny'],
  ['实际物流费', 'actualLogisticsFeeCny'],
  ['实际巴士费', 'actualCrossBorderBusFeeCny'],
]);

const ESTIMATED_EXPENSES = Object.freeze([
  ['采购成本', 'sourcePurchaseCostCny'],
  ['预估佣金', 'estimatedCommissionFeeCny'],
  ['预估收单费', 'estimatedAcquiringFeeCny'],
  ['预估配送服务费', 'estimatedDeliveryServiceFeeCny'],
  ['预估巴士费', 'estimatedCrossBorderBusFeeCny'],
  ['物流费', 'logisticsFeeCny'],
]);

function expenseRows(ledger = {}, mode = 'estimated') {
  const definitions = mode === 'actual' ? ACTUAL_EXPENSES : ESTIMATED_EXPENSES;
  return definitions.map(([label, key]) => {
    const entry = ledger?.amounts?.[key] || null;
    return {
      key,
      label,
      value: entryValue(entry),
      status: text(entry?.status) || 'pending',
      source: text(entry?.source),
      reason: text(entry?.reason),
      updatedAt: text(entry?.updatedAt),
    };
  });
}

function analyzeLedger(ledger = {}) {
  const actualResult = ledger?.results?.actualProfitCny || null;
  const estimatedResult = ledger?.results?.estimatedProfitCny || null;
  const actualReady = entryValue(actualResult) !== null;
  const mode = actualReady ? 'actual' : 'estimated';
  const result = actualReady ? actualResult : estimatedResult;
  const profit = entryValue(result);
  const actualSales = entryValue(ledger?.amounts?.actualSalesAmountCny);
  const estimatedSales = entryValue(ledger?.amounts?.salesAmountCny);
  const revenue = mode === 'actual' && actualSales !== null ? actualSales : estimatedSales;
  const expenses = expenseRows(ledger, mode);
  const knownExpenses = expenses.filter((item) => item.value !== null);
  const expenseTotal = round(knownExpenses.reduce((sum, item) => sum + item.value, 0));
  const margin = profit !== null && revenue !== null && revenue > 0 ? round((profit / revenue) * 100) : null;
  const biggestDrag = [...knownExpenses].sort((left, right) => right.value - left.value)[0] || null;
  const resultMissing = Array.isArray(result?.missing) ? result.missing : [];
  const missing = unique([
    ...resultMissing,
    ...expenses.filter((item) => item.value === null).map((item) => item.reason || `${item.label}待确认`),
  ]);
  return {
    mode,
    modeLabel: mode === 'actual' ? '实际利润' : '预估利润',
    profit,
    revenue,
    expenseTotal,
    margin,
    formula: text(result?.formula),
    expenses,
    biggestDrag,
    missing,
    complete: profit !== null && missing.length === 0,
  };
}

export function resolveProfitOrderReviewProductIdentity(ledger = {}, product = null) {
  const order = ledger?.orderSnapshot || {};
  const firstProduct = Array.isArray(order.products) ? order.products[0] || {} : {};
  return {
    title: text(product?.name || order.product || firstProduct.name) || '当前订单商品',
    sku: text(product?.sku || order.sku || order.skuId || firstProduct.sku || firstProduct.skuId),
    offerId: text(product?.offer_id || order.offerId || firstProduct.offerId),
    productId: text(product?.product_id || firstProduct.productId),
    category: text(product?.category_name),
    imageUrl: text(firstProduct.imageUrl || firstProduct.primaryImageUrl),
  };
}

function analyzeOwnProduct(rows = []) {
  const analyzed = (Array.isArray(rows) ? rows : []).map((row) => ({ row, profit: analyzeLedger(row) }));
  const ready = analyzed.filter((item) => item.profit.profit !== null);
  const revenue = round(ready.reduce((sum, item) => sum + (item.profit.revenue || 0), 0));
  const profit = round(ready.reduce((sum, item) => sum + item.profit.profit, 0));
  return {
    orderCount: analyzed.length,
    readyProfitCount: ready.length,
    actualProfitCount: ready.filter((item) => item.profit.mode === 'actual').length,
    lossOrderCount: ready.filter((item) => item.profit.profit < 0).length,
    profitableOrderCount: ready.filter((item) => item.profit.profit >= 0).length,
    totalRevenue: revenue,
    totalProfit: profit,
    averageProfit: ready.length ? round(profit / ready.length) : null,
    margin: revenue !== null && revenue > 0 && profit !== null ? round((profit / revenue) * 100) : null,
  };
}

function recentTrend(trends = []) {
  const rows = (Array.isArray(trends) ? trends : [])
    .filter((item) => text(item?.date))
    .sort((left, right) => text(left.date).localeCompare(text(right.date)));
  const sum = (source) => source.reduce((total, item) => total + (finite(item?.sales) || 0), 0);
  const recent = sum(rows.slice(-7));
  const previous = sum(rows.slice(-14, -7));
  return previous > 0 ? round(((recent - previous) / previous) * 100) : null;
}

function analyzeMarket(marketDraft = null, error = '', skipped = false) {
  const result = marketDraft?.result || {};
  const analysis = result.externalAnalysis || result.keywordAnalysis || {};
  const record = Array.isArray(analysis.records) ? analysis.records[0] || null : null;
  if (!record) {
    return {
      status: skipped ? 'skipped' : (error ? 'unavailable' : 'missing'),
      sourceLabel: skipped ? '' : 'Seerfar',
      message: skipped
        ? '本次未使用 Seerfar，报告仅根据订单和店内历史生成。'
        : (text(error) || '没有查询到这个 SKU 的市场数据。'),
      metrics: {},
      insights: [],
      record: null,
    };
  }
  const metrics = {
    priceRub: finite(record.price),
    sales30d: finite(record.sales),
    revenue30d: finite(record.revenue),
    averageDailyUnits: finite(record.averageDailyUnits),
    stock: finite(record.stock),
    rating: finite(record.rating),
    reviews: finite(record.reviews),
    returnCancelRate: finite(record.returnCancelRate),
    listingDays: finite(record.listingDays),
    followSellerCount: finite(record.followSellerCount),
    recentSalesChange: recentTrend(record.trends),
  };
  return {
    status: 'ready',
    sourceLabel: 'Seerfar',
    message: text(result.summary) || '已读取该 SKU 的近 30 天市场表现。',
    statisticStartDate: text(record.statisticStartDate),
    statisticEndDate: text(record.statisticEndDate),
    metrics,
    insights: unique(analysis.insights || []).slice(0, 8),
    record: {
      sku: text(record.sku),
      title: text(record.title),
      category: text(record.category),
      seller: text(record.seller),
      brand: text(record.brand),
      fulfillmentModel: text(record.fulfillmentModel),
      latestCategoryRank: Array.isArray(record.categoryRanks) ? record.categoryRanks.at(-1) || null : null,
    },
  };
}

function marketSignal(market = {}) {
  if (market.status !== 'ready') return 'unknown';
  const metrics = market.metrics || {};
  const positive = [
    metrics.sales30d !== null && metrics.sales30d >= 30,
    metrics.averageDailyUnits !== null && metrics.averageDailyUnits >= 1,
    metrics.recentSalesChange !== null && metrics.recentSalesChange >= 0,
    metrics.rating !== null && metrics.rating >= 4.4,
  ].filter(Boolean).length;
  const negative = [
    metrics.sales30d !== null && metrics.sales30d <= 5,
    metrics.recentSalesChange !== null && metrics.recentSalesChange <= -20,
    metrics.rating !== null && metrics.rating < 4.2,
    metrics.returnCancelRate !== null && metrics.returnCancelRate >= 10,
  ].filter(Boolean).length;
  if (negative >= 2) return 'weak';
  if (positive >= 2) return 'strong';
  return 'neutral';
}

function createDecision(profit = {}, history = {}, market = {}) {
  const marketState = marketSignal(market);
  const margin = profit.margin;
  const historyMargin = history.margin;
  let label = '数据不足，暂缓追加投入';
  let tone = 'warning';
  if (profit.profit !== null && profit.profit < 0) {
    if (marketState === 'strong') {
      label = '市场仍有需求，先修复成本再继续';
      tone = 'warning';
    } else {
      label = '暂停追加投入，先解决亏损';
      tone = 'error';
    }
  } else if (margin !== null && margin >= 15 && (historyMargin === null || historyMargin >= 8) && marketState !== 'weak') {
    label = '可以继续投入';
    tone = 'success';
  } else if (margin !== null && margin >= 5 && marketState !== 'weak') {
    label = '优化后继续，小批量观察';
    tone = 'primary';
  } else if (profit.profit !== null) {
    label = marketState === 'strong' ? '有市场但利润偏低，谨慎投入' : '减少投入并继续观察';
    tone = 'warning';
  }
  const reasons = unique([
    profit.profit === null ? '当前订单利润字段不完整。' : `${profit.modeLabel}${profit.profit < 0 ? '为亏损' : '已形成'}。`,
    profit.margin === null ? '' : `当前订单利润率约 ${profit.margin}%。`,
    history.readyProfitCount ? `同商品 ${history.readyProfitCount} 笔可核算订单中有 ${history.lossOrderCount} 笔亏损。` : '',
    marketState === 'strong' ? '该商品近 30 天市场表现有正向信号。' : '',
    marketState === 'weak' ? '该商品市场表现出现弱势或风险信号。' : '',
    marketState === 'unknown' && market.status === 'skipped'
      ? '本次未使用 Seerfar，投入判断仅参考订单和店内历史。'
      : '',
    marketState === 'unknown' && market.status !== 'skipped'
      ? '外部市场数据暂时不足，投入判断需要保守。'
      : '',
  ]);
  return { label, tone, marketSignal: marketState, reasons };
}

function createActions(profit = {}, history = {}, market = {}) {
  const drag = profit.biggestDrag?.label;
  const actions = [
    drag ? `优先复核${drag}，它是当前已知费用中金额最大的一项。` : '',
    profit.profit !== null && profit.profit < 0 ? '在补货前重新核算目标售价和最低可接受毛利。' : '',
    history.lossOrderCount > 0 ? `抽查同 SKU 的 ${history.lossOrderCount} 笔亏损订单，确认是否为持续性问题。` : '',
    market.status === 'ready' && market.metrics?.recentSalesChange !== null && market.metrics.recentSalesChange < 0
      ? '近 7 天销量走弱，先降低补货批量并观察价格和排名。'
      : '',
    market.status === 'ready' && market.metrics?.returnCancelRate !== null && market.metrics.returnCancelRate >= 10
      ? '退货取消率偏高，先检查商品质量、描述一致性和履约问题。'
      : '',
  ];
  return unique(actions).slice(0, 6);
}

export function analyzeProfitOrderReview({
  ledgerRow = {},
  relatedLedgerRows = [],
  product = null,
  marketDraft = null,
  marketError = '',
  marketSkipped = false,
} = {}) {
  const profit = analyzeLedger(ledgerRow);
  const productInfo = resolveProfitOrderReviewProductIdentity(ledgerRow, product);
  const ownProduct = analyzeOwnProduct(relatedLedgerRows);
  const market = analyzeMarket(marketDraft, marketError, marketSkipped);
  const decision = createDecision(profit, ownProduct, market);
  const actions = createActions(profit, ownProduct, market);
  const dataGaps = unique([
    ...profit.missing,
    market.status !== 'ready' && market.status !== 'skipped' ? market.message : '',
    ownProduct.readyProfitCount < ownProduct.orderCount ? '部分同商品订单尚未形成完整利润。' : '',
  ]);
  return {
    order: {
      orderNumber: text(ledgerRow?.orderSnapshot?.posting || ledgerRow?.orderSnapshot?.salesOrder || ledgerRow?.orderKey),
      shop: text(ledgerRow?.orderSnapshot?.shop),
      status: text(ledgerRow?.orderSnapshot?.statusLabel || ledgerRow?.orderSnapshot?.status),
      paymentDate: text(ledgerRow?.orderSnapshot?.paymentDate || ledgerRow?.orderSnapshot?.paymentTime),
    },
    product: productInfo,
    profit,
    ownProduct,
    market,
    decision,
    actions,
    dataGaps,
  };
}

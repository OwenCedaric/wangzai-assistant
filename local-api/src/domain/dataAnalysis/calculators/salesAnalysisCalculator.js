import {
  addMoney,
  buildDailyKeys,
  calculateDelta,
  calculatePercent,
  countBy,
  createMetric,
  createMoneyAccumulator,
  latestTimestamp,
  normalizeText,
  parseJson,
  roundNumber,
  toDateKey,
  toFiniteNumber,
  toMoneyBreakdown,
} from '../lib/dataAnalysisUtils.js';

const ORDER_STATUS_LABELS = Object.freeze({
  awaiting_packaging: '等待备货',
  awaiting_deliver: '等待发货',
  delivering: '配送中',
  delivered: '已送达',
  cancelled: '已取消',
});

function getOrderProducts(row = {}) {
  const products = parseJson(row.products_json, []);
  return Array.isArray(products) ? products : [];
}

function getProductCurrency(product = {}) {
  return normalizeText(product.currency_code || product.currencyCode, 'UNKNOWN').toUpperCase();
}

function getProductQuantity(product = {}) {
  const value = toFiniteNumber(product.quantity ?? product.qty ?? product.count);
  return value === null ? null : Math.max(0, value);
}

function getProductAmount(product = {}) {
  const price = toFiniteNumber(product.price);
  const quantity = getProductQuantity(product);
  if (price === null || quantity === null) return null;
  return price * quantity;
}

function getOrderAmount(row = {}) {
  const accumulator = createMoneyAccumulator();
  getOrderProducts(row).forEach((product) => addMoney(accumulator, getProductAmount(product), getProductCurrency(product)));
  return toMoneyBreakdown(accumulator);
}

function getOrderItemCount(row = {}) {
  return getOrderProducts(row).reduce((total, product) => total + (getProductQuantity(product) ?? 0), 0);
}

function getStatusLabel(status = '') {
  const code = normalizeText(status, 'unknown');
  return ORDER_STATUS_LABELS[code] || code;
}

function isCancelledOrder(row = {}) {
  return normalizeText(row.status).toLowerCase() === 'cancelled';
}

function summarizeOrderRows(rows = []) {
  const sales = createMoneyAccumulator();
  let itemCount = 0;
  let productLineCount = 0;
  let quantityKnownCount = 0;
  let amountKnownCount = 0;
  rows.forEach((row) => {
    getOrderProducts(row).forEach((product) => {
      productLineCount += 1;
      const quantity = getProductQuantity(product);
      const amount = getProductAmount(product);
      if (quantity !== null) {
        quantityKnownCount += 1;
        itemCount += quantity;
      }
      if (amount !== null) amountKnownCount += 1;
      addMoney(sales, amount, getProductCurrency(product));
    });
  });
  const salesBreakdown = toMoneyBreakdown(sales);
  const itemStatus = !rows.length
    ? 'empty'
    : !productLineCount
      ? 'not_returned'
    : !quantityKnownCount
      ? 'not_returned'
      : quantityKnownCount === productLineCount
        ? 'confirmed'
        : 'partial';
  const salesStatus = !rows.length
    ? 'empty'
    : !productLineCount || !amountKnownCount
      ? 'not_returned'
    : salesBreakdown.status !== 'confirmed'
      ? salesBreakdown.status
      : amountKnownCount === productLineCount
        ? 'confirmed'
        : 'partial';
  return {
    orderCount: rows.length,
    itemCount,
    itemStatus,
    productLineCount,
    quantityKnownCount,
    amountKnownCount,
    sales: { ...salesBreakdown, status: salesStatus },
  };
}

function buildTrend(rows = [], range = {}) {
  const dateKeys = buildDailyKeys(range);
  const trendByDate = new Map(
    dateKeys.map((date) => [
      date,
      {
        date,
        orderCount: 0,
        effectiveOrderCount: 0,
        cancelledOrderCount: 0,
        itemCount: 0,
        productLineCount: 0,
        quantityKnownCount: 0,
        amountKnownCount: 0,
        sales: createMoneyAccumulator(),
      },
    ])
  );
  rows.forEach((row) => {
    const date = toDateKey(row.in_process_at || row.created_at || row.updated_at);
    if (!date) return;
    const current = trendByDate.get(date) || {
      date,
      orderCount: 0,
      effectiveOrderCount: 0,
      cancelledOrderCount: 0,
      itemCount: 0,
      productLineCount: 0,
      quantityKnownCount: 0,
      amountKnownCount: 0,
      sales: createMoneyAccumulator(),
    };
    current.orderCount += 1;
    if (isCancelledOrder(row)) {
      current.cancelledOrderCount += 1;
      trendByDate.set(date, current);
      return;
    }
    current.effectiveOrderCount += 1;
    getOrderProducts(row).forEach((product) => {
      current.productLineCount += 1;
      const quantity = getProductQuantity(product);
      const amount = getProductAmount(product);
      if (quantity !== null) {
        current.quantityKnownCount += 1;
        current.itemCount += quantity;
      }
      if (amount !== null) current.amountKnownCount += 1;
      addMoney(current.sales, amount, getProductCurrency(product));
    });
    trendByDate.set(date, current);
  });
  return [...trendByDate.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((row) => {
      const sales = toMoneyBreakdown(row.sales);
      return {
        date: row.date,
        orderCount: row.orderCount,
        effectiveOrderCount: row.effectiveOrderCount,
        cancelledOrderCount: row.cancelledOrderCount,
        itemCount: !row.effectiveOrderCount ? 0 : row.quantityKnownCount ? row.itemCount : null,
        itemStatus:
          !row.effectiveOrderCount
            ? 'empty'
            : !row.productLineCount || !row.quantityKnownCount
              ? 'not_returned'
            : row.quantityKnownCount === row.productLineCount
              ? 'confirmed'
              : 'partial',
        sales: {
          ...sales,
          status:
            !row.effectiveOrderCount
              ? 'empty'
              : !row.productLineCount || !row.amountKnownCount
                ? 'not_returned'
              : sales.status !== 'confirmed'
                ? sales.status
                : row.amountKnownCount === row.productLineCount
                  ? 'confirmed'
                  : 'partial',
        },
      };
    });
}

function buildProductRanking(rows = []) {
  const productMap = new Map();
  rows.forEach((row) => {
    getOrderProducts(row).forEach((product) => {
      const shopId = normalizeText(row.shop_id, 'unknown-shop');
      const offerId = normalizeText(product.offer_id || product.offerId);
      const sku = normalizeText(product.sku);
      const productIdentity = offerId || sku || normalizeText(product.name);
      if (!productIdentity) return;
      const key = `${shopId}:${productIdentity}`;
      const current = productMap.get(key) || {
        key,
        shopId,
        shopName: normalizeText(row.shop_name || row.shopName, shopId),
        offerId,
        sku,
        name: normalizeText(product.name, offerId || sku || '商品名未返回'),
        quantity: 0,
        quantityKnownCount: 0,
        productLineCount: 0,
        amountKnownCount: 0,
        orderKeys: new Set(),
        sales: createMoneyAccumulator(),
      };
      const quantity = getProductQuantity(product);
      const amount = getProductAmount(product);
      current.productLineCount += 1;
      if (quantity !== null) {
        current.quantityKnownCount += 1;
        current.quantity += quantity;
      }
      if (amount !== null) current.amountKnownCount += 1;
      current.orderKeys.add(normalizeText(row.posting_number || row.order_key || row.id));
      addMoney(current.sales, amount, getProductCurrency(product));
      productMap.set(key, current);
    });
  });
  return [...productMap.values()]
    .sort((left, right) => right.quantity - left.quantity || right.orderKeys.size - left.orderKeys.size)
    .slice(0, 30)
    .map((row, index) => {
      const sales = toMoneyBreakdown(row.sales);
      return {
        rank: index + 1,
        key: row.key,
        shopId: row.shopId,
        shopName: row.shopName,
        offerId: row.offerId,
        sku: row.sku,
        name: row.name,
        quantity: row.quantityKnownCount ? roundNumber(row.quantity, 2) : null,
        quantityStatus:
          !row.quantityKnownCount
            ? 'not_returned'
            : row.quantityKnownCount === row.productLineCount
              ? 'confirmed'
              : 'partial',
        orderCount: row.orderKeys.size,
        sales: {
          ...sales,
          status:
            !row.amountKnownCount
              ? 'not_returned'
              : sales.status !== 'confirmed'
                ? sales.status
                : row.amountKnownCount === row.productLineCount
                  ? 'confirmed'
                  : 'partial',
        },
        sourceId: 'orders',
      };
    });
}

function buildShopRanking(rows = []) {
  const shopMap = new Map();
  rows.forEach((row) => {
    const shopId = normalizeText(row.shop_id, 'unknown-shop');
    const current = shopMap.get(shopId) || {
      shopId,
      shopName: normalizeText(row.shop_name || row.shopName, shopId),
      orderCount: 0,
      itemCount: 0,
      sales: createMoneyAccumulator(),
    };
    current.orderCount += 1;
    current.itemCount += getOrderItemCount(row);
    getOrderProducts(row).forEach((product) =>
      addMoney(current.sales, getProductAmount(product), getProductCurrency(product))
    );
    shopMap.set(shopId, current);
  });
  return [...shopMap.values()]
    .sort((left, right) => right.orderCount - left.orderCount)
    .map((row) => ({
      ...row,
      sales: toMoneyBreakdown(row.sales),
      sourceId: 'orders',
    }));
}

function metricFromMoney({ id, label, money, comparisonMoney, sourceSyncedAt, detail }) {
  const comparable =
    money.status === 'confirmed' &&
    comparisonMoney.status === 'confirmed' &&
    money.currency &&
    comparisonMoney.currency &&
    money.currency !== 'MIXED' &&
    money.currency !== 'UNKNOWN' &&
    money.currency === comparisonMoney.currency;
  return createMetric({
    id,
    label,
    value: money.value,
    unit: 'money',
    currency: money.currency,
    status: money.status,
    sourceId: 'orders',
    sourceLabel: 'Ozon订单SQLite缓存',
    sourceType: 'official-cache',
    syncedAt: sourceSyncedAt,
    comparisonValue: comparable ? comparisonMoney.value : null,
    delta: comparable ? calculateDelta(money.value, comparisonMoney.value) : null,
    detail,
    breakdown: money.breakdown,
  });
}

export function calculateSalesAnalysis({ rows = [], comparisonRows = [], range = {}, comparisonRange = {} } = {}) {
  const effectiveRows = rows.filter((row) => !isCancelledOrder(row));
  const previousEffectiveRows = comparisonRows.filter((row) => !isCancelledOrder(row));
  const current = summarizeOrderRows(effectiveRows);
  const previous = summarizeOrderRows(previousEffectiveRows);
  const sourceSyncedAt = latestTimestamp([...rows, ...comparisonRows], ['updated_at', 'last_seen_at']);
  const deliveredCount = rows.filter((row) => normalizeText(row.status) === 'delivered').length;
  const cancelledCount = rows.filter((row) => normalizeText(row.status) === 'cancelled').length;
  const pendingCount = rows.filter((row) =>
    ['awaiting_packaging', 'awaiting_deliver', 'delivering'].includes(normalizeText(row.status))
  ).length;
  const previousCancelledCount = comparisonRows.filter((row) => normalizeText(row.status) === 'cancelled').length;

  const averageOrderValue =
    current.orderCount && current.sales.value !== null ? roundNumber(current.sales.value / current.orderCount, 2) : null;
  const previousAverage =
    previous.orderCount && previous.sales.value !== null ? roundNumber(previous.sales.value / previous.orderCount, 2) : null;

  return {
    range,
    comparisonRange,
    sourceSyncedAt,
    metrics: [
      createMetric({
        id: 'orderCount',
        label: '下单订单',
        value: rows.length,
        unit: 'count',
        sourceId: 'orders',
        sourceLabel: 'Ozon订单SQLite缓存',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        comparisonValue: comparisonRows.length,
        detail: '所选期间平台订单记录数，包含后续取消的订单；订单缓存已按posting唯一保存。',
      }),
      createMetric({
        id: 'effectiveOrderCount',
        label: '有效订单',
        value: effectiveRows.length,
        unit: 'count',
        sourceId: 'orders',
        sourceLabel: 'Ozon订单状态',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        comparisonValue: previousEffectiveRows.length,
        detail: '所选期间状态不为已取消的订单数；履约中和已送达均计入。',
      }),
      createMetric({
        id: 'itemCount',
        label: '有效销售件数',
        value: current.itemCount,
        unit: 'count',
        status: current.itemStatus,
        sourceId: 'orders',
        sourceLabel: 'Ozon订单商品明细',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        comparisonValue: previous.itemStatus === 'confirmed' ? previous.itemCount : null,
        detail: `未取消订单的商品数量汇总；取消订单商品不计入。数量字段返回 ${current.quantityKnownCount}/${current.productLineCount} 行。`,
      }),
      metricFromMoney({
        id: 'salesAmount',
        label: '有效订单金额',
        money: current.sales,
        comparisonMoney: previous.sales,
        sourceSyncedAt,
        detail: '未取消订单的商品成交价×数量；取消订单不计入，不等同平台财务结算额。',
      }),
      createMetric({
        id: 'averageOrderValue',
        label: '平均有效订单金额',
        value: averageOrderValue,
        unit: 'money',
        currency: current.sales.currency,
        status: averageOrderValue === null ? 'unavailable' : current.sales.status,
        sourceId: 'orders',
        sourceLabel: 'Ozon订单SQLite缓存',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        comparisonValue: previous.sales.status === 'confirmed' ? previousAverage : null,
        detail: '有效订单金额÷有效订单数；取消订单不进入分子和分母，多币种时不合并。',
      }),
      createMetric({
        id: 'deliveredCount',
        label: '已送达',
        value: deliveredCount,
        unit: 'count',
        sourceId: 'orders',
        sourceLabel: 'Ozon订单状态',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: 'status=delivered。',
      }),
      createMetric({
        id: 'pendingCount',
        label: '履约中',
        value: pendingCount,
        unit: 'count',
        sourceId: 'orders',
        sourceLabel: 'Ozon订单状态',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        detail: '等待备货、等待发货和配送中订单。',
      }),
      createMetric({
        id: 'cancelledCount',
        label: '已取消',
        value: cancelledCount,
        unit: 'count',
        sourceId: 'orders',
        sourceLabel: 'Ozon订单状态',
        sourceType: 'official-cache',
        syncedAt: sourceSyncedAt,
        comparisonValue: previousCancelledCount,
        detail: 'status=cancelled。',
      }),
      createMetric({
        id: 'cancellationRate',
        label: '期间取消占比',
        value: calculatePercent(cancelledCount, rows.length),
        unit: 'percent',
        status: rows.length ? 'confirmed' : 'empty',
        sourceId: 'orders',
        sourceLabel: 'Ozon订单状态',
        sourceType: 'derived-official',
        syncedAt: sourceSyncedAt,
        comparisonValue: calculatePercent(previousCancelledCount, comparisonRows.length),
        detail: '所选期间取消订单数÷所选期间订单数，不等同平台考核取消率。',
      }),
    ],
    trend: buildTrend(rows, range),
    statusBreakdown: countBy(rows, (row) => getStatusLabel(row.status)),
    fulfillmentBreakdown: countBy(rows, (row) => normalizeText(row.fulfillment || row.source, '未返回')),
    productRanking: buildProductRanking(effectiveRows),
    shopRanking: buildShopRanking(effectiveRows),
    quality: {
      totalOrderCount: rows.length,
      effectiveOrderCount: effectiveRows.length,
      cancelledOrderCount: cancelledCount,
      excludedCancelledAmountPolicy: true,
      productLineCount: current.productLineCount,
      quantityKnownCount: current.quantityKnownCount,
      amountKnownCount: current.amountKnownCount,
    },
    rowCount: rows.length,
  };
}

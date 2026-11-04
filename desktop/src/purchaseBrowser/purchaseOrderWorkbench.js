const MAX_PROFIT_ITEMS = 8;
const SIDEBAR_KINDS = new Set(['order', 'profit', 'after-sales']);

function text(value, maxLength = 180) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function record(value, fields) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(fields.map(([name, maxLength]) => [name, text(input[name], maxLength)]));
}

export function sanitizePurchaseOrderWorkbench(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (text(value.kind, 40) !== 'purchase-order') return null;
  const profitItems = Array.isArray(value.profitItems)
    ? value.profitItems.slice(0, MAX_PROFIT_ITEMS).map((item) => record(item, [
      ['label', 40],
      ['value', 80],
      ['tone', 24],
    ])).filter((item) => item.label)
    : [];
  const profitEstimateItems = Array.isArray(value.profit?.estimateItems)
    ? value.profit.estimateItems.slice(0, MAX_PROFIT_ITEMS).map((item) => record(item, [
      ['label', 40],
      ['value', 80],
      ['tone', 24],
      ['hint', 240],
    ])).filter((item) => item.label)
    : [];
  const profitActualFeeItems = Array.isArray(value.profit?.actualFeeItems)
    ? value.profit.actualFeeItems.slice(0, MAX_PROFIT_ITEMS).map((item) => record(item, [
      ['label', 40],
      ['value', 80],
      ['tone', 24],
      ['hint', 240],
    ])).filter((item) => item.label)
    : [];
  const sidebarKind = SIDEBAR_KINDS.has(text(value.sidebarKind, 24))
    ? text(value.sidebarKind, 24)
    : 'order';
  return {
    version: 1,
    kind: 'purchase-order',
    displayMode: text(value.displayMode, 24) === 'embedded' ? 'embedded' : 'window',
    ...(text(value.sidebarKind, 24) ? { sidebarKind } : {}),
    title: text(value.title, 80) || '订单操作台',
    ...(text(value.subtitle, 180) ? { subtitle: text(value.subtitle, 180) } : {}),
    ...(text(value.browserLabel, 80) ? { browserLabel: text(value.browserLabel, 80) } : {}),
    order: record(value.order, [
      ['orderNo', 120],
      ['goodsNo', 120],
      ['ozonOrderId', 120],
      ['shop', 80],
      ['status', 60],
      ['salesAmount', 80],
      ['purchasePlatform', 80],
      ['purchaseOrderNo', 120],
      ['ozonStatus', 80],
      ['paymentTime', 80],
    ]),
    product: record(value.product, [
      ['title', 240],
      ['sku', 120],
      ['quantity', 40],
      ['imageUrl', 1200],
    ]),
    source: record(value.source, [
      ['platform', 80],
      ['amount', 80],
      ['url', 1800],
    ]),
    logistics: record(value.logistics, [
      ['orderId', 120],
      ['weight', 80],
      ['size', 100],
      ['route', 180],
      ['readStatus', 180],
    ]),
    profitItems,
    ...(sidebarKind === 'profit' ? {
      profit: {
        ...record(value.profit, [
          ['realStatus', 80],
          ['resultStatus', 80],
          ['actualProfit', 80],
          ['actualProfitTone', 24],
        ]),
        estimateItems: profitEstimateItems,
        actualFeeItems: profitActualFeeItems,
      },
    } : {}),
    ...(sidebarKind === 'after-sales' ? {
      afterSales: record(value.afterSales, [
        ['originalOrderNo', 120],
        ['afterSalesId', 120],
        ['type', 80],
        ['status', 80],
        ['shop', 80],
        ['logistics', 180],
        ['refundAmount', 80],
        ['refundStatus', 100],
        ['refundTime', 80],
        ['responsibilityParty', 80],
        ['sourceLabel', 80],
        ['updatedAt', 80],
        ['reason', 300],
        ['purchasePlatform', 80],
        ['purchaseOrderNo', 120],
      ]),
    } : {}),
    notice: text(value.notice, 240),
  };
}

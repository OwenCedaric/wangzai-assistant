function firstFilledProfitRecordValue(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text && text !== '未返回' && text !== '-') return text;
  }
  return '';
}

function normalizeProfitRecordOzonId(value) {
  return String(value ?? '').trim();
}

export function getProfitOrderStableRecordKey(order = {}) {
  const shopKey =
    normalizeProfitRecordOzonId(
      firstFilledProfitRecordValue(order.shopId, order.shopClientId, order.shopName, order.shop)
    ).trim() || 'unknown-shop';
  const postingKey =
    firstFilledProfitRecordValue(
      order.posting,
      order.id,
      order.salesOrder,
      order.raw?.posting_number,
      order.raw?.postingNumber,
      order.raw?.analytics_data?.posting_number,
      order.softwareOrderId,
      order.raw?.order_number,
      order.raw?.orderNumber,
      order.raw?.order_id,
      order.raw?.orderId
    ) || 'unknown-order';
  return `${shopKey}:${postingKey}`;
}

export function getProfitOrderRecordKey(order = {}) {
  const stableKey = getProfitOrderStableRecordKey(order);
  return stableKey.includes('unknown-order') ? order.profitRecordKey || stableKey : stableKey;
}

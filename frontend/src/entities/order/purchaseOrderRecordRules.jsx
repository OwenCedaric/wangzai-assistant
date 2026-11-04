function firstUsablePurchaseOrderId(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text && text !== '未返回' && text !== '-') return text;
  }
  return '';
}

export function getPurchaseOrderRecordKey(order = {}) {
  return firstUsablePurchaseOrderId(order.recordKey, order.id, order.salesOrder, order.shipmentNo, order.ozonOrderId);
}

export function getPurchaseOrderSourceMapKey(order = {}, shop = {}) {
  const shopId = firstUsablePurchaseOrderId(
    shop.id,
    shop.shopId,
    shop.shop_id,
    order.shopId,
    order.shop_id,
    order.shopClientId,
    order.shop_client_id
  );
  const orderKey = getPurchaseOrderRecordKey(order);
  return shopId && orderKey ? `${shopId}:${orderKey}` : '';
}

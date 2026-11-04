import { getProfitPostingLookupKeys } from './profitPostingRules.jsx';

export function getProfitValueClass(value) {
  if (String(value).startsWith('+')) return 'profit-value-positive';
  if (String(value).startsWith('-')) return 'profit-value-negative';
  return '';
}

export function normalizeProfitSearchText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function compactProfitSearchText(value) {
  return normalizeProfitSearchText(value).replace(/[\s\-_/]+/g, '');
}

export function getAssociatedOrderSearchValues(order = {}, extraValues = []) {
  const rawRows = order.raw ? [order.raw] : [];
  const products = Array.isArray(order.products)
    ? order.products.filter((product) => product && typeof product === 'object')
    : [];
  const values = [
    order.id,
    order.posting,
    order.postingNumber,
    order.posting_number,
    ...(Array.isArray(order.postingNumbers) ? order.postingNumbers : []),
    order.salesOrder,
    order.shipmentNo,
    order.ozonOrderId,
    order.softwareOrderId,
    order.orderId,
    order.order_id,
    order.orderNumber,
    order.order_number,
    order.recordKey,
    order.profitRecordKey,
    order.returnNo,
    order.purchaseOrderNo,
    order.packageOrderId,
    order.crossBorderOrderId,
    order.busOrderNo,
    order.productNo,
    order.sku,
    order.offerId,
    order.skuId,
    order.product,
    order.buyer,
    order.supplier,
    order.reason,
    order.status,
    order.searchText,
    order.afterSalesSearchText,
    ...(Array.isArray(order.afterSalesSearchValues) ? order.afterSalesSearchValues : []),
    ...extraValues,
    ...rawRows.flatMap((raw) => [
      raw?.posting_number,
      raw?.postingNumber,
      raw?.order_number,
      raw?.orderNumber,
      raw?.order_id,
      raw?.orderId,
      raw?.analytics_data?.posting_number,
      raw?.analytics_data?.order_number,
      raw?.analytics_data?.order_id,
      raw?.posting?.posting_number,
      raw?.posting?.postingNumber,
      raw?.posting?.order_id,
      raw?.posting?.orderId,
    ]),
    ...products.flatMap((product) => [
      product.name,
      product.product,
      product.title,
      product.sku,
      product.offerId,
      product.skuId,
      product.productId,
      product.raw?.posting_number,
      product.raw?.postingNumber,
      product.raw?.order_number,
      product.raw?.orderNumber,
      product.raw?.order_id,
      product.raw?.orderId,
      product.raw?.offer_id,
      product.raw?.offerId,
      product.raw?.sku,
      product.raw?.sku_id,
      product.raw?.product_id,
      product.financialRaw?.posting_number,
      product.financialRaw?.postingNumber,
      product.financialRaw?.order_number,
      product.financialRaw?.orderNumber,
      product.financialRaw?.order_id,
      product.financialRaw?.orderId,
      product.financialRaw?.offer_id,
      product.financialRaw?.offerId,
      product.financialRaw?.sku,
      product.financialRaw?.sku_id,
      product.financialRaw?.product_id,
    ]),
  ];
  const normalizedValues = values
    .flat()
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && value !== '未返回' && value !== '待确认');
  return [...new Set([...normalizedValues, ...getProfitPostingLookupKeys(normalizedValues)])];
}

export function doesAssociatedOrderMatchKeyword(order = {}, keyword = '', extraValues = []) {
  const normalizedKeyword = normalizeProfitSearchText(keyword);
  if (!normalizedKeyword) return true;
  const values = getAssociatedOrderSearchValues(order, extraValues);
  const searchText = values.map(normalizeProfitSearchText).filter(Boolean).join(' ');
  if (searchText.includes(normalizedKeyword)) return true;
  const compactKeyword = compactProfitSearchText(normalizedKeyword);
  if (!compactKeyword) return false;
  return values.map(compactProfitSearchText).filter(Boolean).join('').includes(compactKeyword);
}

export function getProfitOrderSearchValues(order = {}) {
  const rawRows = order.raw ? [order.raw] : [];
  const products = Array.isArray(order.products)
    ? order.products.filter((product) => product && typeof product === 'object')
    : [];

  return [
    ...getAssociatedOrderSearchValues(order),
    order.id,
    order.posting,
    ...(Array.isArray(order.postingNumbers) ? order.postingNumbers : []),
    order.softwareOrderId,
    order.salesOrder,
    order.recordKey,
    order.profitRecordKey,
    order.offerId,
    order.skuId,
    order.sku,
    order.product,
    order.shop,
    order.buyer,
    ...rawRows.flatMap((raw) => [
      raw?.posting_number,
      raw?.postingNumber,
      raw?.order_number,
      raw?.orderNumber,
      raw?.order_id,
      raw?.orderId,
      raw?.analytics_data?.posting_number,
      raw?.analytics_data?.order_number,
    ]),
    ...products.flatMap((product) => [
      product.name,
      product.sku,
      product.offerId,
      product.skuId,
      product.raw?.offer_id,
      product.raw?.offerId,
      product.raw?.sku,
      product.raw?.sku_id,
      product.raw?.product_id,
      product.financialRaw?.offer_id,
      product.financialRaw?.offerId,
      product.financialRaw?.sku,
      product.financialRaw?.sku_id,
      product.financialRaw?.product_id,
    ]),
  ]
    .flat()
    .map((value) => String(value ?? '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

export function doesProfitOrderMatchKeyword(order = {}, keyword = '') {
  const normalizedKeyword = normalizeProfitSearchText(keyword);
  if (!normalizedKeyword) return true;
  const compactKeyword = compactProfitSearchText(normalizedKeyword);
  const values = getProfitOrderSearchValues(order);
  const searchText = values.map(normalizeProfitSearchText).filter(Boolean).join(' ');
  if (searchText.includes(normalizedKeyword)) return true;
  if (!compactKeyword) return false;
  return values.map(compactProfitSearchText).filter(Boolean).join('').includes(compactKeyword);
}

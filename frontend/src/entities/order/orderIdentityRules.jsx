import {
  getOzonGenerationAwareShopSourceKey,
} from '../../shared/ozon/ozonShopGeneration.js';

export function normalizeOzonId(value) {
  return String(value ?? '').trim();
}

export function firstFilled(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

export function firstUsableOzonId(...values) {
  for (const value of values) {
    const text = normalizeOzonId(value).trim();
    if (text && text !== '-' && text !== '未返回') return text;
  }
  return '';
}

export function getOzonShopLabel(shop) {
  return shop?.shopAlias || shop?.sellerName || 'Ozon 店铺';
}

export function getOzonShopClientId(shop) {
  return String(shop?.clientId || '').trim();
}

export function getOzonStableShopSourceKey(shop) {
  return getOzonGenerationAwareShopSourceKey(shop);
}

export function getOzonSnapshotSourceKey(source) {
  const sources = Array.isArray(source) ? source : [source];
  return sources.filter(Boolean).map(getOzonStableShopSourceKey).sort().join('|');
}

export function getOzonRowShopScopeValues(row = {}) {
  const shopClientId = String(row.shopClientId || row.clientId || '').trim();
  const shopId = String(row.shopId || '').trim();
  const shopLabel = String(row.shop || row.shopName || row.storeName || '').trim();
  return [
    shopClientId,
    shopId,
    shopLabel,
    row.shopName,
    row.storeName,
    shopClientId ? `ozon-shop:client:${shopClientId}` : '',
    shopId ? `ozon-shop:id:${shopId}` : '',
    shopLabel ? `ozon-shop:label:${shopLabel}` : '',
  ];
}

export function getOzonShopForOrder(order, shops = [], fallback = null) {
  if (!order) return fallback;
  const orderShopId = String(order.shopId || '').trim();
  const orderClientId = String(order.shopClientId || '').trim();
  return (
    shops.find((shop) => orderShopId && shop.id === orderShopId) ??
    shops.find((shop) => orderClientId && getOzonShopClientId(shop) === orderClientId) ??
    fallback
  );
}

export function getCanonicalProductShopId(product = {}) {
  return String(product?.shopId ?? product?.shop_id ?? '').trim();
}

export function resolveCanonicalProductOwnerShop(product = {}, shops = []) {
  const shopId = getCanonicalProductShopId(product);
  if (!shopId) {
    const error = new Error('PRODUCT_CANONICAL_SHOP_ID_REQUIRED');
    error.code = 'PRODUCT_CANONICAL_SHOP_ID_REQUIRED';
    throw error;
  }
  const ownerShop = (Array.isArray(shops) ? shops : []).find(
    (shop) => String(shop?.id || '').trim() === shopId
  );
  if (!ownerShop) {
    const error = new Error('PRODUCT_OWNER_SHOP_NOT_BOUND');
    error.code = 'PRODUCT_OWNER_SHOP_NOT_BOUND';
    error.shopId = shopId;
    throw error;
  }
  return ownerShop;
}

export function getSingleProductOwnerShop(products = [], shops = []) {
  const rows = Array.isArray(products) ? products : [products];
  if (!rows.length) return null;
  const shopIds = [...new Set(rows.map(getCanonicalProductShopId).filter(Boolean))];
  if (shopIds.length !== 1 || rows.some((row) => !getCanonicalProductShopId(row))) {
    const error = new Error('PRODUCT_BATCH_SINGLE_SHOP_REQUIRED');
    error.code = 'PRODUCT_BATCH_SINGLE_SHOP_REQUIRED';
    error.shopIds = shopIds;
    throw error;
  }
  return resolveCanonicalProductOwnerShop(rows[0], shops);
}

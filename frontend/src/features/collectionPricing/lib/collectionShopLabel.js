function text(value) {
  return String(value ?? '').trim();
}

export function getCollectionShopId(shop = {}, fallbackShopId = '') {
  return text(shop.id || shop.shopId || shop.shop_id || fallbackShopId);
}

export function getCollectionShopName(shop = {}) {
  return text(
    shop.displayName
      || shop.shopAlias
      || shop.alias
      || shop.shopName
      || shop.shortName
      || shop.sellerName
      || shop.companyName
      || shop.name
      || shop.label,
  );
}

export function formatCollectionShopLabel(shop = {}, fallbackShopId = '') {
  const id = getCollectionShopId(shop, fallbackShopId);
  const name = getCollectionShopName(shop);
  if (name && id && name !== id) return `${name} · ${id}`;
  return name || (id ? `Ozon 店铺 · ${id}` : 'Ozon 店铺');
}

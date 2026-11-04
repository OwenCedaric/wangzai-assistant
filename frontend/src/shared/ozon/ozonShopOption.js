function firstText(...values) {
  const value = values.find((item) => String(item ?? '').trim());
  return value === undefined ? '' : String(value).trim();
}

/**
 * Keep the three pieces of seller identity used by shop selectors in one
 * shape. `shopId` is the local selector value; `shopExternalId` is the
 * seller/client id shown to the user.
 */
export function normalizeOzonShopOption(shop = {}) {
  const shopId = firstText(shop.shopId, shop.id);
  const shopAlias = firstText(shop.shopAlias, shop.alias, shop.displayName);
  const shopName = firstText(
    shop.sellerName,
    shop.shopName,
    shop.name,
    shop.displayName,
    shopAlias,
    shopId,
  );

  return {
    shopId,
    shopExternalId: firstText(shop.clientId, shop.sellerId, shop.seller_id, shop.shopExternalId, shopId),
    shopName,
    shopAlias,
    displayName: firstText(shop.displayName, shopAlias, shopName, shopId),
  };
}

export function getOzonShopAlias(option = {}) {
  const alias = firstText(option.shopAlias, option.alias);
  const name = firstText(option.shopName, option.displayName);
  return alias && alias !== name ? alias : '';
}


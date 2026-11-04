function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function scopeError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

export function resolveCrossBorderAccountShop(credentials = {}, requestedShopId = '', { requireShop = true } = {}) {
  const accountId = normalizeText(credentials.accountId);
  const shopIds = [...new Set((Array.isArray(credentials.shopIds) ? credentials.shopIds : [])
    .map(normalizeText)
    .filter(Boolean))];
  const requested = normalizeText(requestedShopId);

  if (!accountId) {
    throw scopeError('CROSS_BORDER_ACCOUNT_NOT_FOUND', '跨境巴士授权账号不存在。');
  }
  if (!shopIds.length) {
    throw scopeError('CROSS_BORDER_ACCOUNT_SHOP_BINDING_REQUIRED', '跨境巴士账号尚未绑定 Ozon 店铺。');
  }
  if (requested) {
    if (!shopIds.includes(requested)) {
      throw scopeError('CROSS_BORDER_ACCOUNT_SHOP_MISMATCH', '当前跨境巴士账号未绑定所选 Ozon 店铺。');
    }
    return { accountId, shopId: requested, shopIds };
  }
  if (shopIds.length === 1) return { accountId, shopId: shopIds[0], shopIds };
  if (requireShop) {
    throw scopeError('CROSS_BORDER_SHOP_ID_REQUIRED', '跨境巴士账号绑定了多个店铺，本次操作必须明确内部 shopId。');
  }
  return { accountId, shopId: '', shopIds };
}

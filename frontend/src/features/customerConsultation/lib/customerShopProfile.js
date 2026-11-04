function normalizeText(value) {
  return String(value ?? '').trim();
}

function getNestedValue(source, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const nested = normalizeText(value.url || value.href || value.src);
      if (nested) return nested;
    }
  }
  return '';
}

function getProfileCandidates(payload = {}) {
  const candidates = [
    payload,
    payload?.data,
    payload?.data?.result,
    payload?.result,
    payload?.sellerInfo,
    payload?.seller_info,
    payload?.data?.sellerInfo,
    payload?.data?.seller_info,
  ];
  return candidates.filter((candidate) => candidate && typeof candidate === 'object');
}

export function normalizeCustomerShopProfile(payload = {}, { shopId = '' } = {}) {
  const candidates = getProfileCandidates(payload);
  const logoKeys = [
    'logo_url',
    'logoUrl',
    'seller_logo_url',
    'sellerLogoUrl',
    'shop_logo_url',
    'shopLogoUrl',
    'logo',
    'avatar_url',
    'avatarUrl',
    'avatar',
  ];
  const nameKeys = ['seller_name', 'sellerName', 'company_name', 'companyName', 'name'];

  for (const candidate of candidates) {
    const logoUrl = getNestedValue(candidate, logoKeys);
    if (logoUrl) {
      return {
        shopId: normalizeText(shopId),
        logoUrl,
        logoField: logoKeys.find((key) => candidate?.[key]) || 'logo',
        sellerName: getNestedValue(candidate, nameKeys),
        source: 'shop.sellerInfo',
      };
    }
  }

  return {
    shopId: normalizeText(shopId),
    logoUrl: '',
    logoField: '',
    sellerName: '',
    source: 'shop.sellerInfo',
  };
}

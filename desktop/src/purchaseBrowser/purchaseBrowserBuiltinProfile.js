export const OZON_PUBLIC_PROFILE_ACCOUNT_ID = 'builtin-ozon-public';
export const BUILTIN_PUBLIC_PROFILE_OWNER_TYPE = 'builtin_public_profile';
export const CROSS_BORDER_LOGISTICS_PROFILE_ACCOUNT_ID = 'builtin-cross-border-logistics';
export const BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE = 'builtin_cross_border_profile';

const OZON_PUBLIC_BINDING = Object.freeze({
  accountId: OZON_PUBLIC_PROFILE_ACCOUNT_ID,
  accountIncarnation: 'ozon-public-browser-v1',
  platformName: 'Ozon买家',
  ownerType: BUILTIN_PUBLIC_PROFILE_OWNER_TYPE,
});

const CROSS_BORDER_LOGISTICS_BINDING = Object.freeze({
  accountId: CROSS_BORDER_LOGISTICS_PROFILE_ACCOUNT_ID,
  accountIncarnation: 'cross-border-logistics-browser-v1',
  platformName: '跨境巴士',
  ownerType: BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE,
});

export function getPurchaseBrowserBuiltinBinding(accountId, ownerType) {
  if (
    String(ownerType || '').trim() === BUILTIN_PUBLIC_PROFILE_OWNER_TYPE
    && String(accountId || '').trim() === OZON_PUBLIC_PROFILE_ACCOUNT_ID
  ) {
    return OZON_PUBLIC_BINDING;
  }
  if (
    String(ownerType || '').trim() === BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE
    && String(accountId || '').trim() === CROSS_BORDER_LOGISTICS_PROFILE_ACCOUNT_ID
  ) {
    return CROSS_BORDER_LOGISTICS_BINDING;
  }
  return null;
}

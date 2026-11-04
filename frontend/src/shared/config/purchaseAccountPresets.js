export const PURCHASE_ACCOUNT_PRESETS = Object.freeze([
  Object.freeze({
    platformCode: 'pdd',
    platformName: '拼多多',
    accountAlias: '拼多多采购号',
    platformUrl: 'https://mobile.yangkeduo.com/',
  }),
  Object.freeze({
    platformCode: 'tmall',
    platformName: '天猫',
    accountAlias: '天猫采购号',
    platformUrl: 'https://www.tmall.com/',
  }),
  Object.freeze({
    platformCode: 'taobao',
    platformName: '淘宝',
    accountAlias: '淘宝采购号',
    platformUrl: 'https://www.taobao.com/',
  }),
  Object.freeze({
    platformCode: '1688',
    platformName: '1688',
    accountAlias: '1688采购号',
    platformUrl: 'https://www.1688.com/',
  }),
  Object.freeze({
    platformCode: 'ozon-buyer',
    platformName: 'Ozon买家',
    accountAlias: 'Ozon买家采购号',
    platformUrl: 'https://www.ozon.ru/',
  }),
  Object.freeze({
    platformCode: 'jd',
    platformName: '京东',
    accountAlias: '京东采购号',
    platformUrl: 'https://www.jd.com/',
  }),
  Object.freeze({
    platformCode: 'wildberries',
    platformName: 'Wildberries',
    accountAlias: 'Wildberries采购号',
    platformUrl: 'https://www.wildberries.ru/',
  }),
  Object.freeze({
    platformCode: 'amazon',
    platformName: 'Amazon',
    accountAlias: 'Amazon采购号',
    platformUrl: 'https://www.amazon.com/',
  }),
  Object.freeze({
    platformCode: 'temu',
    platformName: 'Temu',
    accountAlias: 'Temu采购号',
    platformUrl: 'https://www.temu.com/',
  }),
  Object.freeze({
    platformCode: 'aliexpress',
    platformName: 'AliExpress',
    accountAlias: 'AliExpress采购号',
    platformUrl: 'https://www.aliexpress.com/',
  }),
]);

export const PURCHASE_ACCOUNT_PLATFORM_OPTIONS = Object.freeze(
  PURCHASE_ACCOUNT_PRESETS.map((preset) => Object.freeze({
    label: preset.platformName,
    value: preset.platformName,
  }))
);

export const PURCHASE_ACCOUNT_ALIAS_OPTIONS = Object.freeze(
  PURCHASE_ACCOUNT_PRESETS.map((preset) => Object.freeze({
    label: preset.accountAlias,
    value: preset.accountAlias,
  }))
);

export function getPurchaseAccountPresetByPlatform(platformName) {
  const normalized = String(platformName ?? '').trim();
  return PURCHASE_ACCOUNT_PRESETS.find((preset) => preset.platformName === normalized) ?? null;
}

export function getPurchaseAccountPresetByAlias(accountAlias) {
  const normalized = String(accountAlias ?? '').replace(/\s+/gu, '').trim();
  if (!normalized) return null;
  return PURCHASE_ACCOUNT_PRESETS.find(
    (preset) => preset.accountAlias.replace(/\s+/gu, '') === normalized
  ) ?? null;
}

export function resolvePurchaseAccountPreset(values = {}) {
  return getPurchaseAccountPresetByPlatform(values.platformName)
    ?? getPurchaseAccountPresetByAlias(values.accountAlias)
    ?? null;
}

import { sanitizePurchaseOrderWorkbench } from './purchaseOrderWorkbench.js';
import {
  BUILTIN_PUBLIC_PROFILE_OWNER_TYPE,
  OZON_PUBLIC_PROFILE_ACCOUNT_ID,
} from './purchaseBrowserBuiltinProfile.js';

const SAFE_WEB_PROTOCOLS = new Set(['http:', 'https:']);
const OZON_BROWSER_SESSION_TYPE = 'ozon-browser-session';

const PLATFORM_HOSTS = Object.freeze([
  ['ozon-seller', Object.freeze(['seller.ozon.ru'])],
  ['1688', Object.freeze(['1688.com', 'alibaba.com'])],
  ['taobao', Object.freeze(['taobao.com', 'tb.cn'])],
  ['tmall', Object.freeze(['tmall.com'])],
  ['pinduoduo', Object.freeze(['yangkeduo.com', 'pinduoduo.com'])],
  ['ozon-buyer', Object.freeze(['ozon.ru'])],
  ['jd', Object.freeze(['jd.com'])],
  ['wildberries', Object.freeze(['wildberries.ru'])],
  ['amazon', Object.freeze(['amazon.com', 'amazon.de', 'amazon.co.uk'])],
  ['temu', Object.freeze(['temu.com'])],
  ['aliexpress', Object.freeze(['aliexpress.com', 'aliexpress.ru'])],
]);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hostMatches(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function normalizeInternalExternalUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (!SAFE_WEB_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
  if (!url.hostname || url.hostname.length > 253) return null;
  return url.toString();
}

export function platformKeyForExternalUrl(value) {
  const normalized = normalizeInternalExternalUrl(value);
  if (!normalized) return '';
  const hostname = new URL(normalized).hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return PLATFORM_HOSTS.find(([, suffixes]) =>
    suffixes.some((suffix) => hostMatches(hostname, suffix)),
  )?.[0] || '';
}

function accountPlatformKey(account = {}) {
  const name = clean(account.platformName || account.platform || account.name || account.accountAlias).toLowerCase();
  if (name === '1688' || name.includes('1688') || name.includes('阿里巴巴')) return '1688';
  if (name.includes('淘宝') || name === 'taobao') return 'taobao';
  if (name.includes('天猫') || name === 'tmall') return 'tmall';
  if (name.includes('拼多多') || name === 'pdd' || name === 'pinduoduo') return 'pinduoduo';
  if (name.includes('ozon买家') || name.includes('ozon 买家') || name === 'ozon-buyer' || name === 'ozon buyer') return 'ozon-buyer';
  if (name.includes('京东') || name === 'jd') return 'jd';
  if (name.includes('wildberries')) return 'wildberries';
  if (name.includes('amazon')) return 'amazon';
  if (name.includes('temu')) return 'temu';
  if (name.includes('aliexpress') || name.includes('ali express')) return 'aliexpress';
  return platformKeyForExternalUrl(account.platformUrl);
}

function accountRows(payload = {}) {
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function integrationProfileRows(payload = {}) {
  if (Array.isArray(payload?.profiles)) return payload.profiles;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function productLinkParserOptions(options = {}) {
  if (clean(options.browserRole) !== 'product-link-parser' || options.background !== true) return {};
  return {
    browserRole: 'product-link-parser',
    background: true,
    restoreVisible: false,
    waitUntil: clean(options.waitUntil) || 'commit',
  };
}

export function chooseOzonSellerIntegrationProfile({
  payload = {},
  activeAccountId = '',
  shopId = '',
} = {}) {
  const connected = integrationProfileRows(payload).filter((row) => (
    clean(row?.id)
    && clean(row?.integrationType) === OZON_BROWSER_SESSION_TYPE
    && clean(row?.configStatus) === '连接成功'
    && clean(row?.tokenStatus) === 'Cookie 已保存'
  ));
  if (!connected.length) return null;
  const requestedShopId = clean(shopId);
  if (requestedShopId) {
    const scoped = connected.filter((row) => clean(row?.shopId || row?.shop_id) === requestedShopId);
    if (scoped.length !== 1) return null;
    const requestedAccountId = clean(activeAccountId);
    if (requestedAccountId && clean(scoped[0].id) !== requestedAccountId) return null;
    return scoped[0];
  }
  return connected.find((row) => clean(row.id) === clean(activeAccountId)) || connected[0];
}

export function chooseInternalBrowserAccount({
  payload = {},
  url = '',
  activeAccountId = '',
} = {}) {
  const rows = accountRows(payload).filter((row) => clean(row?.id));
  if (!rows.length) return null;
  const targetPlatform = platformKeyForExternalUrl(url);
  const compatiblePlatforms = targetPlatform === 'tmall'
    ? new Set(['tmall', 'taobao'])
    : targetPlatform === 'taobao'
      ? new Set(['taobao', 'tmall'])
      : new Set([targetPlatform]);
  const matching = targetPlatform
    ? rows.filter((row) => compatiblePlatforms.has(accountPlatformKey(row)))
    : rows;
  // Never open one purchase platform with another platform's Cookie/profile.
  if (!matching.length) return null;
  const exact = matching.filter((row) => accountPlatformKey(row) === targetPlatform);
  const active = matching.find((row) => clean(row.id) === clean(activeAccountId));
  const exactActive = exact.find((row) => clean(row.id) === clean(activeAccountId));
  const selected = exactActive
    || exact.find((row) => row.isDefault === true)
    || exact[0]
    || active
    || matching.find((row) => row.isDefault === true)
    || matching[0];
  return selected ? clean(selected.id) : null;
}

export function createPurchaseBrowserExternalLinkRouter({
  listAccounts,
  listIntegrationProfiles = async () => ({ profiles: [] }),
  getActiveAccountId = () => '',
  openInternalUrl,
  appendLog = () => undefined,
  accountCacheTtlMs = 15_000,
  now = () => Date.now(),
} = {}) {
  if (typeof listAccounts !== 'function' || typeof openInternalUrl !== 'function') {
    throw codedError('PURCHASE_BROWSER_EXTERNAL_ROUTER_DEPENDENCY_REQUIRED');
  }
  let cached = null;
  let cachedAt = 0;
  let pending = null;
  let pendingIntegrationProfiles = null;

  async function accounts() {
    const current = Number(now());
    if (cached && current - cachedAt < accountCacheTtlMs) return cached;
    if (pending) return pending;
    pending = Promise.resolve(listAccounts())
      .then((payload) => {
        cached = payload || {};
        cachedAt = Number(now());
        return cached;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  async function integrationProfiles() {
    if (pendingIntegrationProfiles) return pendingIntegrationProfiles;
    pendingIntegrationProfiles = Promise.resolve(listIntegrationProfiles())
      .then((payload) => payload || {})
      .finally(() => {
        pendingIntegrationProfiles = null;
      });
    return pendingIntegrationProfiles;
  }

  async function open(value, options = {}) {
    const url = normalizeInternalExternalUrl(value);
    if (!url) throw codedError('PURCHASE_BROWSER_EXTERNAL_URL_INVALID');
    const targetPlatform = platformKeyForExternalUrl(url);
    const requestedAccountId = clean(options.accountId);
    if (targetPlatform === 'ozon-seller') {
      const requestedShopId = clean(options.shopId);
      if (options.requireShopBinding === true && !requestedShopId) {
        throw codedError('PURCHASE_BROWSER_OZON_SELLER_SHOP_PROFILE_REQUIRED');
      }
      const profile = chooseOzonSellerIntegrationProfile({
        payload: await integrationProfiles(),
        activeAccountId: requestedAccountId || (requestedShopId ? '' : getActiveAccountId()),
        shopId: requestedShopId,
      });
      if (requestedAccountId && clean(profile?.id) !== requestedAccountId) {
        throw codedError('PURCHASE_BROWSER_EXTERNAL_ACCOUNT_PLATFORM_MISMATCH');
      }
      if (!profile) throw codedError(requestedShopId
        ? 'PURCHASE_BROWSER_OZON_SELLER_SHOP_PROFILE_REQUIRED'
        : 'PURCHASE_BROWSER_OZON_SELLER_PROFILE_REQUIRED');
      appendLog('desktop-main', '[purchase-browser] Ozon Seller link routed to shop-bound integration profile\n');
      return openInternalUrl(url, {
        accountId: clean(profile.id),
        ownerType: 'integration_profile',
        platformName: clean(options.platformName) || clean(profile.platformName) || 'Ozon',
        accountLabel: clean(options.accountLabel) || clean(profile.platformName) || 'Ozon Seller',
        ...productLinkParserOptions(options),
        workbench: sanitizePurchaseOrderWorkbench(options.workbench),
        ...(options.purchaseTarget && typeof options.purchaseTarget === 'object'
          && !Array.isArray(options.purchaseTarget)
          ? { purchaseTarget: options.purchaseTarget }
          : {}),
        ...(options.embeddedBounds && typeof options.embeddedBounds === 'object'
          ? { embeddedBounds: options.embeddedBounds }
          : {}),
        ...(options.standaloneSize && typeof options.standaloneSize === 'object'
          ? { standaloneSize: options.standaloneSize }
          : {}),
      });
    }
    const accountId = chooseInternalBrowserAccount({
      payload: await accounts(),
      url,
      activeAccountId: requestedAccountId || getActiveAccountId(),
    });
    if (requestedAccountId && accountId !== requestedAccountId) {
      throw codedError('PURCHASE_BROWSER_EXTERNAL_ACCOUNT_PLATFORM_MISMATCH');
    }
    const useOzonPublicProfile = !accountId && !requestedAccountId && targetPlatform === 'ozon-buyer';
    if (!accountId && !useOzonPublicProfile) {
      throw codedError(targetPlatform === 'ozon-buyer'
        ? 'PURCHASE_BROWSER_OZON_BUYER_ACCOUNT_REQUIRED'
        : 'PURCHASE_BROWSER_EXTERNAL_ACCOUNT_REQUIRED');
    }
    appendLog('desktop-main', '[purchase-browser] external-link routed to native CEF\n');
    return openInternalUrl(url, {
      accountId: useOzonPublicProfile ? OZON_PUBLIC_PROFILE_ACCOUNT_ID : accountId,
      ...(useOzonPublicProfile
        ? {
            ownerType: BUILTIN_PUBLIC_PROFILE_OWNER_TYPE,
            platformName: 'Ozon\u4e70\u5bb6',
            accountLabel: 'Ozon \u516c\u5171\u5546\u54c1\u6d4f\u89c8',
          }
        : {}),
      ...productLinkParserOptions(options),
      workbench: sanitizePurchaseOrderWorkbench(options.workbench),
      ...(options.purchaseTarget && typeof options.purchaseTarget === 'object'
        && !Array.isArray(options.purchaseTarget)
        ? { purchaseTarget: options.purchaseTarget }
        : {}),
      ...(options.embeddedBounds && typeof options.embeddedBounds === 'object'
        ? { embeddedBounds: options.embeddedBounds }
        : {}),
      ...(options.standaloneSize && typeof options.standaloneSize === 'object'
        ? { standaloneSize: options.standaloneSize }
        : {}),
    });
  }

  return Object.freeze({
    clearCache() {
      cached = null;
      cachedAt = 0;
    },
    open,
  });
}

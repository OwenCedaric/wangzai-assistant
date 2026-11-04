const PURCHASE_PLATFORM_ORDER = Object.freeze(['pinduoduo', '1688', 'taobao', 'tmall', 'ozon-buyer']);
const MAX_PURCHASE_PREWARM_ACCOUNTS = 1;
const MAX_OZON_PREWARM_PROFILES = 1;
const OZON_BROWSER_SESSION_TYPE = 'ozon-browser-session';
const OZON_BROWSER_DEFAULT_URL = 'https://seller.ozon.ru/app/dashboard/main';
const OZON_LOGIN_READY_ATTEMPTS = 12;
const OZON_LOGIN_READY_DELAY_MS = 1000;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function platformKeyFor(account = {}) {
  const platformName = cleanText(account.platformName).toLowerCase();
  if (platformName === '1688' || platformName.includes('阿里巴巴')) return '1688';
  if (platformName === '淘宝' || platformName === 'taobao') return 'taobao';
  if (platformName === '天猫' || platformName === 'tmall') return 'tmall';
  if (platformName === '拼多多' || platformName === 'pdd' || platformName === 'pinduoduo') return 'pinduoduo';
  if (platformName === 'ozon买家' || platformName === 'ozon 买家' || platformName === 'ozon buyer' || platformName === 'ozon-buyer') return 'ozon-buyer';
  try {
    const hostname = new URL(cleanText(account.platformUrl)).hostname.toLowerCase();
    if (hostname === '1688.com' || hostname.endsWith('.1688.com')) return '1688';
    if (hostname === 'taobao.com' || hostname.endsWith('.taobao.com')) return 'taobao';
    if (hostname === 'tmall.com' || hostname.endsWith('.tmall.com')) return 'tmall';
    if (
      hostname === 'yangkeduo.com'
      || hostname.endsWith('.yangkeduo.com')
      || hostname === 'pinduoduo.com'
      || hostname.endsWith('.pinduoduo.com')
    ) return 'pinduoduo';
    if (
      (hostname === 'ozon.ru' || hostname.endsWith('.ozon.ru'))
      && hostname !== 'seller.ozon.ru'
    ) return 'ozon-buyer';
  } catch {
    return '';
  }
  return '';
}

function accountRows(payload = {}) {
  return Array.isArray(payload?.accounts)
    ? payload.accounts
    : Array.isArray(payload?.rows)
      ? payload.rows
      : [];
}

function integrationProfileRows(payload = {}) {
  return Array.isArray(payload?.profiles)
    ? payload.profiles
    : Array.isArray(payload?.rows)
      ? payload.rows
      : [];
}

function isOzonSellerUrl(value) {
  try {
    const hostname = new URL(cleanText(value)).hostname.toLowerCase();
    return hostname === 'seller.ozon.ru' || hostname.endsWith('.seller.ozon.ru');
  } catch {
    return false;
  }
}

export function selectOzonBrowserPrewarmProfiles(payload = {}) {
  const selected = [];
  const seen = new Set();
  for (const profile of integrationProfileRows(payload)) {
    const id = cleanText(profile?.id);
    if (!id || seen.has(id) || cleanText(profile?.integrationType) !== OZON_BROWSER_SESSION_TYPE) continue;
    if (cleanText(profile?.configStatus) !== '连接成功' || cleanText(profile?.tokenStatus) !== 'Cookie 已保存') continue;
    seen.add(id);
    // The shared browser may persist a public ozon.ru product/category URL.
    // Market hot-cache refreshes need a seller tab, so override buyer-site
    // history with the seller landing page instead of reopening the wrong
    // surface and reporting PURCHASE_BROWSER_TAB_NOT_FOUND.
    const lastUrl = isOzonSellerUrl(profile?.lastUrl)
      ? cleanText(profile?.lastUrl)
      : OZON_BROWSER_DEFAULT_URL;
    selected.push(Object.freeze({
      accountId: id,
      ownerType: 'integration_profile',
      browserRole: 'market-collector',
      background: true,
      platformKey: 'ozon',
      platformName: cleanText(profile?.platformName) || 'Ozon 网页登录',
      url: lastUrl,
    }));
  }
  return Object.freeze(selected.slice(0, MAX_OZON_PREWARM_PROFILES));
}

export function selectPurchaseBrowserPrewarmAccounts(payload = {}) {
  const grouped = new Map(PURCHASE_PLATFORM_ORDER.map((platformKey) => [platformKey, []]));
  for (const account of accountRows(payload)) {
    const accountId = cleanText(account?.id);
    const url = cleanText(account?.platformUrl);
    const platformKey = platformKeyFor(account);
    if (!accountId || !url || !platformKey) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    grouped.get(platformKey).push(account);
  }

  const selectedAccountIds = new Set();
  const selected = [];
  for (const platformKey of PURCHASE_PLATFORM_ORDER) {
    const rows = grouped.get(platformKey);
    const account = rows.find((candidate) => candidate.isDefault === true) || rows[0];
    const accountId = cleanText(account?.id);
    if (!accountId || selectedAccountIds.has(accountId)) continue;
    selectedAccountIds.add(accountId);
    selected.push(Object.freeze({
      accountId,
      platformKey,
      platformName: cleanText(account.platformName) || platformKey,
      url: cleanText(account.platformUrl),
    }));
  }
  return Object.freeze(selected.slice(0, MAX_PURCHASE_PREWARM_ACCOUNTS));
}

// Kept as a compatibility helper for callers that only need the first platform.
export function selectPurchaseBrowserPrewarmAccount(payload = {}) {
  return selectPurchaseBrowserPrewarmAccounts(payload)[0] || null;
}

export function createPurchaseBrowserAccountPrewarmer({
  localApiClient,
  getController,
  appendLog = () => undefined,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof localApiClient?.listAccounts !== 'function' || typeof getController !== 'function') {
    throw new Error('PURCHASE_BROWSER_PREWARM_DEPENDENCY_REQUIRED');
  }

  let disposed = false;
  let startPromise = null;

  function start() {
    if (disposed) return Promise.resolve(null);
    if (startPromise) return startPromise;
    startPromise = Promise.resolve()
      .then(async () => {
        const [purchasePayload, integrationPayload] = await Promise.all([
          localApiClient.listAccounts(),
          typeof localApiClient.listIntegrationProfiles === 'function'
            ? localApiClient.listIntegrationProfiles().catch(() => ({ profiles: [] }))
            : { profiles: [] },
        ]);
        return { purchasePayload, integrationPayload };
      })
      .then(async ({ purchasePayload, integrationPayload }) => {
        if (disposed) return null;
        const selected = [
          ...selectPurchaseBrowserPrewarmAccounts(purchasePayload),
          ...selectOzonBrowserPrewarmProfiles(integrationPayload),
        ];
        const controller = getController();
        if (!controller || typeof controller.dispatch !== 'function') return null;
        const startedAt = now();
        const results = [];
        for (const account of selected) {
          const platformStartedAt = now();
          try {
            const prewarmedState = await controller.dispatch({
              command: 'prewarm',
              accountId: account.accountId,
              ...(account.ownerType ? { ownerType: account.ownerType } : {}),
              ...(account.browserRole ? { browserRole: account.browserRole } : {}),
              ...(account.background === true ? { background: true } : {}),
              ...(account.url ? { url: account.url } : {}),
            });
            if (account.ownerType === 'integration_profile') {
              const collectorTab = (Array.isArray(prewarmedState?.tabs) ? prewarmedState.tabs : [])
                .find((tab) => (
                  cleanText(tab?.accountId) === account.accountId
                  && cleanText(tab?.browserRole) === 'market-collector'
                ));
              if (!collectorTab?.tabId) throw new Error('PURCHASE_BROWSER_TAB_NOT_FOUND');
              let verified = null;
              for (let attempt = 0; attempt < OZON_LOGIN_READY_ATTEMPTS; attempt += 1) {
                verified = await controller.dispatch({
                  command: 'ozon-login-status',
                  tabId: collectorTab.tabId,
                  persistStatus: true,
                });
                const pending = verified?.result?.verificationPending === true
                  || cleanText(verified?.result?.verificationOutcome).toLowerCase() === 'pending';
                if (!pending || attempt === OZON_LOGIN_READY_ATTEMPTS - 1) break;
                await sleep(OZON_LOGIN_READY_DELAY_MS);
              }
              if (verified?.result?.loggedIn !== true || verified?.result?.cookieSaved !== true) {
                const pending = verified?.result?.verificationPending === true
                  || cleanText(verified?.result?.verificationOutcome).toLowerCase() === 'pending';
                if (pending) throw new Error('OZON_LOGIN_VERIFICATION_PENDING');
                await controller.dispatch({ command: 'force-close', tabId: collectorTab.tabId }).catch(() => undefined);
                throw new Error('OZON_LOGIN_REQUIRED');
              }
            }
            const durationMs = Math.max(0, now() - platformStartedAt);
            if (!disposed) {
              appendLog(
                'desktop-main',
                `[purchase-browser] background prewarm ready platform=${account.platformKey} durationMs=${durationMs}\n`,
              );
            }
            results.push({ ok: true, platformKey: account.platformKey, durationMs });
          } catch (error) {
            const code = String(error?.code || error?.message || 'PURCHASE_BROWSER_PREWARM_FAILED')
              .replace(/[^A-Z0-9_]/gu, '')
              .slice(0, 100) || 'PURCHASE_BROWSER_PREWARM_FAILED';
            if (!disposed) {
              appendLog(
                'desktop-main',
                `[purchase-browser] background prewarm failed platform=${account.platformKey} code=${code}\n`,
              );
            }
            results.push({ ok: false, platformKey: account.platformKey, code });
          }
        }
        return Object.freeze({
          ok: true,
          prewarmed: results.filter((result) => result.ok).length,
          skipped: Math.max(0, PURCHASE_PLATFORM_ORDER.length - selected.filter((item) => !item.ownerType).length),
          durationMs: Math.max(0, now() - startedAt),
          results: Object.freeze(results),
        });
      })
      .catch((error) => {
        if (!disposed) {
          const code = String(error?.code || error?.message || 'PURCHASE_BROWSER_PREWARM_FAILED')
            .replace(/[^A-Z0-9_]/gu, '')
            .slice(0, 100) || 'PURCHASE_BROWSER_PREWARM_FAILED';
          appendLog(
            'desktop-main',
            `[purchase-browser] background prewarm account-list failed code=${code}\n`,
          );
        }
        return null;
      });
    return startPromise;
  }

  function dispose() {
    disposed = true;
  }

  return Object.freeze({ dispose, start });
}

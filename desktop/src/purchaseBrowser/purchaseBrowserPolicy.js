export const PURCHASE_HOST_SUFFIXES = Object.freeze([
  '1688.com',
  'alibaba.com',
  'alipay.com',
  'taobao.com',
  'tmall.com',
  'yangkeduo.com',
  'pinduoduo.com',
  'kuajing84.com',
  'ozon.ru',
  'jd.com',
  'wildberries.ru',
  'amazon.com',
  'amazon.de',
  'amazon.co.uk',
  'temu.com',
  'aliexpress.com',
  'aliexpress.ru',
]);

function isHostOrSubdomain(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function normalizedFixtureOrigins(values = []) {
  const result = new Set();
  for (const value of values) {
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
      if (
        url.protocol === 'http:'
        && ['127.0.0.1', 'localhost', '::1'].includes(host)
        && !url.username
        && !url.password
      ) {
        result.add(url.origin);
      }
    } catch {
      // Invalid fixture origins never become an allowlist entry.
    }
  }
  return result;
}

export function createPurchaseBrowserPolicy({ fixtureOrigins = [], allowHttpNavigation = false } = {}) {
  const fixtures = normalizedFixtureOrigins(fixtureOrigins);

  function classifyUrl(value, { allowBlank = false } = {}) {
    if (allowBlank && value === 'about:blank') return { allowed: true, kind: 'blank', url: 'about:blank' };
    let url;
    try {
      url = new URL(String(value || ''));
    } catch {
      return { allowed: false, reason: 'invalid-url' };
    }
    if (url.username || url.password) return { allowed: false, reason: 'embedded-credentials' };
    if (fixtures.has(url.origin) && url.protocol === 'http:') {
      return { allowed: true, kind: 'fixture', url: url.toString(), origin: url.origin };
    }
    const hostname = url.hostname.toLowerCase();
    if (url.protocol === 'http:' && allowHttpNavigation === true && hostname) {
      // Production routes all ordinary HTTP links into CEF as untrusted
      // external pages. They never receive purchase-site permissions.
      return { allowed: true, kind: 'external-site', url: url.toString(), origin: url.origin };
    }
    // The native CEF window is the app-wide external-link target.  HTTPS
    // pages are therefore allowed regardless of vendor, while credentials and
    // non-web protocols remain blocked.  Keep the platform classification for
    // account selection, permissions, and audit labels.
    if (url.protocol === 'https:') {
      const isPurchaseSite = PURCHASE_HOST_SUFFIXES.some((suffix) => isHostOrSubdomain(hostname, suffix));
      // Do not let a look-alike such as 1688.com.evil.example inherit the
      // purchase-site trust label.  Legitimate unrelated HTTPS sites remain
      // available to the global internal-browser link route.
      const isKnownLookalike = PURCHASE_HOST_SUFFIXES.some((suffix) =>
        hostname.includes(`.${suffix}.`)
        || hostname.startsWith(`${suffix}.`),
      );
      if (isKnownLookalike && !isPurchaseSite) {
        return { allowed: false, reason: 'origin-lookalike' };
      }
      return {
        allowed: true,
        kind: isPurchaseSite ? 'purchase-site' : 'external-site',
        url: url.toString(),
        origin: url.origin,
      };
    }
    return { allowed: false, reason: 'insecure-http-not-allowlisted' };
  }

  function canRequestPermission(permission, requestingOrigin, profile = {}) {
    const target = classifyUrl(requestingOrigin);
    if (!target.allowed || target.kind !== 'purchase-site') return false;
    if (permission === 'fullscreen') return true;
    if (permission === 'storage-access' || permission === 'top-level-storage-access') return true;
    if (permission === 'geolocation') return profile.geolocation?.mode === 'fixed';
    return false;
  }

  function canDownload({ url, userApproved = false } = {}) {
    const target = classifyUrl(url);
    return userApproved === true && target.allowed && target.kind === 'purchase-site';
  }

  return Object.freeze({
    allowHttpNavigation: allowHttpNavigation === true,
    allowedHostSuffixes: PURCHASE_HOST_SUFFIXES,
    canDownload,
    canRequestPermission,
    classifyUrl,
    fixtureOrigins: fixtures,
  });
}




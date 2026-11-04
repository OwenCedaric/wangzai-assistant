import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const OWNER_REF_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:@/+\-=]{0,180}$/u;
const ALLOWED_TIMEZONES = new Set([
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Europe/Moscow',
  'UTC',
]);
const ALLOWED_WEBRTC_POLICIES = new Set([
  'default',
  'default_public_interface_only',
  'disable_non_proxied_udp',
]);
const PLATFORM_ENVIRONMENT_PRESETS = Object.freeze([
  Object.freeze({
    key: 'cross-border',
    names: Object.freeze(['跨境巴士', 'Cross Border Bus', 'kuajing84']),
    platformName: '跨境巴士',
    locale: 'zh-CN',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.6',
    timezone: 'Asia/Shanghai',
  }),
  Object.freeze({
    key: 'pinduoduo',
    names: Object.freeze(['拼多多', 'Pinduoduo', 'PDD']),
    platformName: '拼多多',
    locale: 'zh-CN',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.5',
    timezone: 'Asia/Shanghai',
  }),
  Object.freeze({
    key: 'tmall',
    names: Object.freeze(['天猫', 'Tmall']),
    platformName: '天猫',
    locale: 'zh-CN',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.7',
    timezone: 'Asia/Shanghai',
  }),
  Object.freeze({
    key: 'taobao',
    names: Object.freeze(['淘宝', 'Taobao']),
    platformName: '淘宝',
    locale: 'zh-CN',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.6',
    timezone: 'Asia/Shanghai',
  }),
  Object.freeze({
    key: '1688',
    names: Object.freeze(['1688']),
    platformName: '1688',
    locale: 'zh-CN',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    timezone: 'Asia/Shanghai',
  }),
  Object.freeze({
    key: 'ozon-buyer',
    names: Object.freeze(['Ozon买家', 'Ozon 买家', 'Ozon Buyer', 'ozon-buyer']),
    platformName: 'Ozon买家',
    locale: 'ru-RU',
    acceptLanguage: 'ru-RU,ru;q=0.9,zh-CN;q=0.7,en;q=0.6',
    timezone: 'Europe/Moscow',
  }),
  Object.freeze({
    key: 'ozon',
    names: Object.freeze(['Ozon', 'Ozon Seller', 'Ozon 卖家']),
    platformName: 'Ozon',
    locale: 'zh-CN',
    acceptLanguage: 'zh-CN,zh;q=0.9,ru;q=0.8,en;q=0.6',
    timezone: 'Europe/Moscow',
  }),
  Object.freeze({
    key: 'jd',
    names: Object.freeze(['京东', 'JD', 'jd.com']),
    platformName: '京东',
    locale: 'zh-CN',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.6',
    timezone: 'Asia/Shanghai',
  }),
  Object.freeze({
    key: 'wildberries',
    names: Object.freeze(['Wildberries', 'WB', 'wildberries.ru']),
    platformName: 'Wildberries',
    locale: 'ru-RU',
    acceptLanguage: 'ru-RU,ru;q=0.9,en;q=0.7',
    timezone: 'Europe/Moscow',
  }),
  Object.freeze({
    key: 'amazon',
    names: Object.freeze(['Amazon', 'amazon.com']),
    platformName: 'Amazon',
    locale: 'en-US',
    acceptLanguage: 'en-US,en;q=0.9,zh-CN;q=0.5',
    timezone: 'UTC',
  }),
  Object.freeze({
    key: 'temu',
    names: Object.freeze(['Temu', 'temu.com']),
    platformName: 'Temu',
    locale: 'en-US',
    acceptLanguage: 'en-US,en;q=0.9,zh-CN;q=0.6',
    timezone: 'UTC',
  }),
  Object.freeze({
    key: 'aliexpress',
    names: Object.freeze(['AliExpress', 'Ali Express', 'aliexpress.com']),
    platformName: 'AliExpress',
    locale: 'en-US',
    acceptLanguage: 'en-US,en;q=0.9,zh-CN;q=0.6',
    timezone: 'UTC',
  }),
]);
const UNKNOWN_PLATFORM_ENVIRONMENT = Object.freeze({
  key: 'unknown',
  platformName: '',
  locale: 'zh-CN',
  acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.6',
  timezone: 'Asia/Shanghai',
});

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requiredText(value, code, maximum = 260) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maximum) fail(code);
  if (/[\u0000-\u001F\u007F]/u.test(value)) fail(code);
  return value;
}

function optionalReference(value, code) {
  const text = value == null ? '' : String(value).trim();
  if (!SAFE_REFERENCE_PATTERN.test(text)) fail(code);
  return text;
}

function boundedInteger(value, fallback, minimum, maximum, code) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) fail(code);
  return number;
}

function boundedScale(value, fallback = 1) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0.75 || number > 2) {
    fail('PURCHASE_BROWSER_DEVICE_SCALE_INVALID');
  }
  return Number(number.toFixed(2));
}

function normalizeUserAgent(value, fallback) {
  const text = requiredText(value || fallback, 'PURCHASE_BROWSER_USER_AGENT_INVALID', 500);
  if (!/^Mozilla\/5\.0 /u.test(text) || /[\r\n]/u.test(text)) fail('PURCHASE_BROWSER_USER_AGENT_INVALID');
  return text;
}

function normalizeCefUserAgent(value, fallback) {
  const candidate = String(value || '').trim();
	const nativeFallback = normalizeUserAgent(fallback, fallback);
  // Old Camoufox/Firefox and Electron shell UAs are incompatible with the
  // native Chromium engine and would expose the migration immediately.
  if (/\b(?:Electron|Firefox|Camoufox)\//iu.test(candidate)) {
	return nativeFallback;
  }
	const normalized = normalizeUserAgent(candidate || nativeFallback, nativeFallback);
	// The app owns this exact standard UA shape. Keep its Chromium major aligned
	// with the bundled CEF engine after upgrades; retaining Chrome/149 on CEF 151
	// creates a TLS/header/Client-Hints identity mismatch on Ozon WebSocket flows.
	if (/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/u.test(normalized)) {
		return nativeFallback;
	}
	return normalized;
}

function normalizeAcceptLanguage(value, fallback = 'zh-CN,zh;q=0.9,en;q=0.6') {
  const text = requiredText(value || fallback, 'PURCHASE_BROWSER_ACCEPT_LANGUAGE_INVALID', 180);
  if (!/^[A-Za-z0-9,;=._*\-\s]+$/u.test(text)) fail('PURCHASE_BROWSER_ACCEPT_LANGUAGE_INVALID');
  return text;
}

function normalizeLocale(value, fallback = 'zh-CN') {
  const text = requiredText(value || fallback, 'PURCHASE_BROWSER_LOCALE_INVALID', 32);
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(text)) fail('PURCHASE_BROWSER_LOCALE_INVALID');
  return text;
}

function normalizeTimezone(value, fallback = 'Asia/Shanghai') {
  const text = requiredText(value || fallback, 'PURCHASE_BROWSER_TIMEZONE_INVALID', 64);
  if (!ALLOWED_TIMEZONES.has(text)) fail('PURCHASE_BROWSER_TIMEZONE_INVALID');
  return text;
}

function resolvePlatformEnvironment(value) {
  const name = String(value || '').trim();
  if (!name) return UNKNOWN_PLATFORM_ENVIRONMENT;
  return PLATFORM_ENVIRONMENT_PRESETS.find((preset) => preset.names.includes(name))
    || UNKNOWN_PLATFORM_ENVIRONMENT;
}

function createStableFingerprintSeed(ownerRef, platformKey) {
  return createHash('sha256')
    .update(`cef-platform-account-v2\0${platformKey}\0${ownerRef}`, 'utf8')
    .digest('hex');
}

function normalizeProxy(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const mode = source.mode || (source.rules ? 'fixed_servers' : 'direct');
  if (!['direct', 'system', 'fixed_servers'].includes(mode)) fail('PURCHASE_BROWSER_PROXY_MODE_INVALID');
  const rules = mode === 'fixed_servers'
    ? requiredText(source.rules, 'PURCHASE_BROWSER_PROXY_RULES_INVALID', 300)
    : '';
  if (/[\r\n]|(?:^|[/:])[^\s/:]+:[^\s/@]+@/u.test(rules)) {
    fail('PURCHASE_BROWSER_PROXY_RULES_INVALID');
  }
  const bypassRules = String(source.bypassRules || '<-loopback>').trim();
  if (!bypassRules || bypassRules.length > 300 || /[\r\n]/u.test(bypassRules)) {
    fail('PURCHASE_BROWSER_PROXY_BYPASS_INVALID');
  }
  return {
    mode,
    rules,
    bypassRules,
    credentialRef: optionalReference(source.credentialRef, 'PURCHASE_BROWSER_PROXY_CREDENTIAL_REFERENCE_INVALID'),
  };
}

function normalizeLastUrl(value) {
  if (!value) return '';
  const text = requiredText(String(value), 'PURCHASE_BROWSER_LAST_URL_INVALID', 1800);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('PURCHASE_BROWSER_LAST_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('PURCHASE_BROWSER_LAST_URL_INVALID');
  }
  return url.toString();
}

function defaultViewport(ownerRef) {
  const seed = Number.parseInt(ownerRef.slice(0, 4), 16);
  const sizes = [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
  ];
  return sizes[seed % sizes.length];
}

function normalizeProfile(ownerRef, input = {}, { baseUserAgent, existing } = {}) {
  const platformEnvironment = resolvePlatformEnvironment(input.platformName || existing?.platformName);
  const suppliedProxy = input.proxy && typeof input.proxy === 'object' && !Array.isArray(input.proxy)
    ? input.proxy
    : null;
  // Browser upgrade v2 mistakenly collapsed every legacy direct profile into
  // system mode. No user-selectable stored system mode existed before that
  // migration, so only that exact v2 marker is restored to direct. A system
  // mode explicitly selected after this fix is written as v3 and preserved.
  const restoreMistakenSystemProfile = !suppliedProxy
    && existing?.proxy?.mode === 'system'
    && Number(existing?.networkEnvironment?.version) === 2
    && existing?.networkEnvironment?.alignment === 'native-system';
  const proxyInput = restoreMistakenSystemProfile
    ? { ...existing.proxy, mode: 'direct' }
    : suppliedProxy || existing?.proxy;
  const normalizedProxy = normalizeProxy(proxyInput);
  const viewportFallback = existing?.viewport || defaultViewport(ownerRef);
  const viewportInput = input.viewport && typeof input.viewport === 'object' ? input.viewport : {};
  const pinduoduoProfile = platformEnvironment.key === 'pinduoduo';
  const inheritedWebRtcPolicy = existing?.webrtcPolicy === 'disable_non_proxied_udp'
    && !pinduoduoProfile
    && existing?.proxy?.mode !== 'fixed_servers'
    ? 'default'
    : existing?.webrtcPolicy;
  const requestedWebRtcPolicy = String(
    input.webrtcPolicy
    || inheritedWebRtcPolicy
    || (normalizedProxy.mode === 'fixed_servers' ? 'disable_non_proxied_udp' : 'default'),
  );
  const webrtcPolicy = pinduoduoProfile ? 'disable_non_proxied_udp' : requestedWebRtcPolicy;
  if (!ALLOWED_WEBRTC_POLICIES.has(webrtcPolicy)) fail('PURCHASE_BROWSER_WEBRTC_POLICY_INVALID');
  const geolocationMode = String(input.geolocation?.mode || existing?.geolocation?.mode || 'deny');
  if (!['deny', 'fixed'].includes(geolocationMode)) fail('PURCHASE_BROWSER_GEOLOCATION_POLICY_INVALID');
  const geolocation = geolocationMode === 'fixed'
    ? {
        mode: 'fixed',
        latitude: Number(input.geolocation?.latitude ?? existing?.geolocation?.latitude),
        longitude: Number(input.geolocation?.longitude ?? existing?.geolocation?.longitude),
        accuracy: boundedInteger(
          input.geolocation?.accuracy,
          existing?.geolocation?.accuracy || 100,
          1,
          5000,
          'PURCHASE_BROWSER_GEOLOCATION_ACCURACY_INVALID',
        ),
      }
    : { mode: 'deny' };
  if (
    geolocation.mode === 'fixed'
    && (
      !Number.isFinite(geolocation.latitude)
      || geolocation.latitude < -90
      || geolocation.latitude > 90
      || !Number.isFinite(geolocation.longitude)
      || geolocation.longitude < -180
      || geolocation.longitude > 180
    )
  ) {
    fail('PURCHASE_BROWSER_GEOLOCATION_COORDINATES_INVALID');
  }
  return {
    version: 1,
    engine: 'cef',
    ownerRef,
    platformName: platformEnvironment.platformName,
    platformKey: platformEnvironment.key,
    // partition 仅保留给旧版资料迁移和删除审计；新运行时不再打开 Electron 分区。
    partition: `persist:purchase-${ownerRef}`,
    userAgent: normalizeCefUserAgent(input.userAgent || existing?.userAgent, baseUserAgent),
    acceptLanguage: normalizeAcceptLanguage(
      input.acceptLanguage || existing?.acceptLanguage,
      platformEnvironment.acceptLanguage,
    ),
    locale: normalizeLocale(input.locale || existing?.locale, platformEnvironment.locale),
    timezone: normalizeTimezone(input.timezone || existing?.timezone, platformEnvironment.timezone),
    viewport: {
      width: boundedInteger(
        viewportInput.width,
        viewportFallback.width,
        960,
        2560,
        'PURCHASE_BROWSER_VIEWPORT_INVALID',
      ),
      height: boundedInteger(
        viewportInput.height,
        viewportFallback.height,
        600,
        1600,
        'PURCHASE_BROWSER_VIEWPORT_INVALID',
      ),
    },
    deviceScaleFactor: boundedScale(input.deviceScaleFactor, existing?.deviceScaleFactor || 1),
    proxy: normalizedProxy,
    webrtcPolicy,
    geolocation,
    networkEnvironment: {
      version: 3,
      alignment: normalizedProxy.mode === 'fixed_servers'
        ? 'account-fixed'
        : normalizedProxy.mode === 'system'
          ? 'native-system'
          : 'native-direct',
      proxyRole: normalizedProxy.mode === 'fixed_servers' ? 'network-only' : normalizedProxy.mode,
      locale: normalizeLocale(input.locale || existing?.locale, platformEnvironment.locale),
      timezone: normalizeTimezone(input.timezone || existing?.timezone, platformEnvironment.timezone),
      timezoneSource: 'account-profile',
      webrtc: webrtcPolicy,
    },
    fingerprint: {
      version: 4,
      family: 'cef-stable-chromium-windows-platform-account',
      seed: existing?.fingerprint?.seed || createStableFingerprintSeed(ownerRef, platformEnvironment.key),
      scope: 'platform-account-incarnation',
      platformKey: platformEnvironment.key,
      rotation: 'account-incarnation',
    },
    canvasPolicy: 'cef-stable',
    lastUrl: normalizeLastUrl(input.lastUrl ?? existing?.lastUrl),
    lastTaskId: optionalReference(input.lastTaskId ?? existing?.lastTaskId, 'PURCHASE_BROWSER_LAST_TASK_INVALID'),
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
}

function createEmptyStore() {
  return {
    version: STORE_VERSION,
    hmacKey: randomBytes(32).toString('base64url'),
    profiles: {},
  };
}

function validateStore(value) {
  if (!value || value.version !== STORE_VERSION || typeof value.hmacKey !== 'string') {
    fail('PURCHASE_BROWSER_PROFILE_STORE_INVALID');
  }
  const key = Buffer.from(value.hmacKey, 'base64url');
  if (key.length !== 32 || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) {
    fail('PURCHASE_BROWSER_PROFILE_STORE_INVALID');
  }
  for (const [ownerRef, profile] of Object.entries(value.profiles)) {
    if (!OWNER_REF_PATTERN.test(ownerRef) || profile?.ownerRef !== ownerRef || profile?.partition !== `persist:purchase-${ownerRef}`) {
      fail('PURCHASE_BROWSER_PROFILE_STORE_INVALID');
    }
  }
  return value;
}

export function createSafeStorageProtector(safeStorage) {
  return Object.freeze({
    protect(plainText) {
      if (!safeStorage?.isEncryptionAvailable?.()) fail('PURCHASE_BROWSER_OS_ENCRYPTION_UNAVAILABLE');
      return safeStorage.encryptString(String(plainText));
    },
    unprotect(ciphertext) {
      if (!safeStorage?.isEncryptionAvailable?.()) fail('PURCHASE_BROWSER_OS_ENCRYPTION_UNAVAILABLE');
      return safeStorage.decryptString(Buffer.from(ciphertext));
    },
  });
}

export function createPurchaseBrowserProfileStore({
  filePath,
  protector,
  baseUserAgent,
} = {}) {
  const resolvedFilePath = path.resolve(requiredText(filePath, 'PURCHASE_BROWSER_PROFILE_STORE_PATH_REQUIRED', 1200));
  if (!protector || typeof protector.protect !== 'function' || typeof protector.unprotect !== 'function') {
    fail('PURCHASE_BROWSER_PROFILE_PROTECTOR_REQUIRED');
  }
  const stableBaseUserAgent = normalizeUserAgent(
    baseUserAgent,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  );
  const backupFilePath = `${resolvedFilePath}.bak`;
  let document = null;

  function parseDocumentFile(candidate) {
    const envelope = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (envelope?.version !== STORE_VERSION || typeof envelope.ciphertext !== 'string') {
      fail('PURCHASE_BROWSER_PROFILE_STORE_INVALID');
    }
    const plainText = protector.unprotect(Buffer.from(envelope.ciphertext, 'base64'));
    return validateStore(JSON.parse(plainText));
  }

  function cleanupOrphanedTemps() {
    const directory = path.dirname(resolvedFilePath);
    if (!fs.existsSync(directory)) return;
    const prefix = `${path.basename(resolvedFilePath)}.`;
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue;
      try { fs.rmSync(path.join(directory, entry), { force: true }); } catch { /* next startup retries */ }
    }
  }

  function readDocument() {
    if (document) return document;
    if (!fs.existsSync(resolvedFilePath)) {
      if (fs.existsSync(backupFilePath)) {
        document = parseDocumentFile(backupFilePath);
        persist();
        cleanupOrphanedTemps();
        return document;
      }
      document = createEmptyStore();
      persist();
      return document;
    }
    try {
      document = parseDocumentFile(resolvedFilePath);
      cleanupOrphanedTemps();
      return document;
    } catch (error) {
      if (fs.existsSync(backupFilePath)) {
        try {
          document = parseDocumentFile(backupFilePath);
          fs.rmSync(resolvedFilePath, { force: true });
          persist();
          cleanupOrphanedTemps();
          return document;
        } catch {
          // Preserve the primary failure below when neither copy is valid.
        }
      }
      if (error?.code?.startsWith?.('PURCHASE_BROWSER_')) throw error;
      fail('PURCHASE_BROWSER_PROFILE_STORE_INVALID');
    }
  }

  function persist({ mirrorBackup = false } = {}) {
    const current = validateStore(document || createEmptyStore());
    document = current;
    fs.mkdirSync(path.dirname(resolvedFilePath), { recursive: true });
    const ciphertext = Buffer.from(protector.protect(JSON.stringify(current)));
    const temporaryPath = `${resolvedFilePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    const backupTemporaryPath = `${backupFilePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify({ version: STORE_VERSION, ciphertext: ciphertext.toString('base64') })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      const descriptor = fs.openSync(temporaryPath, 'r+');
      try {
        try { fs.fsyncSync(descriptor); }
        catch (error) {
          if (!['EINVAL', 'EPERM', 'ENOTSUP'].includes(String(error?.code || ''))) throw error;
        }
      } finally { fs.closeSync(descriptor); }
      if (fs.existsSync(resolvedFilePath)) {
        fs.copyFileSync(resolvedFilePath, backupFilePath);
      }
      fs.rmSync(resolvedFilePath, { force: true });
      fs.renameSync(temporaryPath, resolvedFilePath);
      if (mirrorBackup) {
        // A verified owner removal cannot leave a previous profile in the
        // recovery copy, where a damaged primary would resurrect it. Stage
        // and atomically replace only the backup; preserve all other owners.
        fs.copyFileSync(resolvedFilePath, backupTemporaryPath);
        const backupDescriptor = fs.openSync(backupTemporaryPath, 'r+');
        try { fs.fsyncSync(backupDescriptor); } finally { fs.closeSync(backupDescriptor); }
        fs.renameSync(backupTemporaryPath, backupFilePath);
        if (JSON.stringify(parseDocumentFile(backupFilePath)) !== JSON.stringify(current)
          || JSON.stringify(parseDocumentFile(resolvedFilePath)) !== JSON.stringify(current)) {
          fail('PURCHASE_BROWSER_PROFILE_REMOVE_READBACK_FAILED');
        }
      }
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      fs.rmSync(backupTemporaryPath, { force: true });
      if (!fs.existsSync(resolvedFilePath) && fs.existsSync(backupFilePath)) {
        try { fs.copyFileSync(backupFilePath, resolvedFilePath); } catch { /* preserve primary error */ }
      }
      throw error;
    }
  }

  function ownerRefFor(binding = {}) {
    const accountId = requiredText(binding.accountId, 'PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED', 128);
    const accountIncarnation = requiredText(
      binding.accountIncarnation,
      'PURCHASE_BROWSER_ACCOUNT_INCARNATION_REQUIRED',
      80,
    );
    const key = Buffer.from(readDocument().hmacKey, 'base64url');
    return createHmac('sha256', key)
      .update(`purchase-browser-owner-v1\0${accountId}\0${accountIncarnation}`, 'utf8')
      .digest('hex')
      .slice(0, 40);
  }

  function get(binding) {
    const ownerRef = ownerRefFor(binding);
    const profile = readDocument().profiles[ownerRef];
    return profile ? structuredClone(profile) : null;
  }

  function getOrCreate(binding, overrides = {}) {
    const ownerRef = ownerRefFor(binding);
    const current = readDocument().profiles[ownerRef] || null;
    const profile = normalizeProfile(ownerRef, {
      ...overrides,
      platformName: binding.platformName || overrides.platformName || current?.platformName || '',
    }, {
      baseUserAgent: stableBaseUserAgent,
      existing: current,
    });
    readDocument().profiles[ownerRef] = profile;
    persist();
    return structuredClone(profile);
  }

  function updateSession(binding, { lastUrl, lastTaskId } = {}) {
    const ownerRef = ownerRefFor(binding);
    const current = readDocument().profiles[ownerRef];
    if (!current) fail('PURCHASE_BROWSER_PROFILE_NOT_FOUND');
    const normalizedLastUrl = lastUrl === undefined ? current.lastUrl : normalizeLastUrl(lastUrl);
    const normalizedLastTaskId = lastTaskId === undefined
      ? current.lastTaskId
      : optionalReference(lastTaskId, 'PURCHASE_BROWSER_LAST_TASK_INVALID');
    if (normalizedLastUrl === current.lastUrl && normalizedLastTaskId === current.lastTaskId) {
      return structuredClone(current);
    }
    const profile = normalizeProfile(ownerRef, {
      lastUrl: normalizedLastUrl,
      lastTaskId: normalizedLastTaskId,
      platformName: binding.platformName || current.platformName || '',
    }, {
      baseUserAgent: stableBaseUserAgent,
      existing: current,
    });
    readDocument().profiles[ownerRef] = profile;
    persist();
    return structuredClone(profile);
  }

  function remove(binding) {
    const ownerRef = ownerRefFor(binding);
    const existed = Boolean(readDocument().profiles[ownerRef]);
    delete readDocument().profiles[ownerRef];
    persist({ mirrorBackup: true });
    return { ownerRef, existed };
  }

  function hasOwnerRef(ownerRef) {
    if (!OWNER_REF_PATTERN.test(String(ownerRef || ''))) return false;
    return Boolean(readDocument().profiles[ownerRef]);
  }

  return Object.freeze({
    filePath: resolvedFilePath,
    get,
    getOrCreate,
    hasOwnerRef,
    ownerRefFor,
    remove,
    updateSession,
  });
}


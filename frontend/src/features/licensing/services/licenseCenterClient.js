const browserTokens = {
  userAccessToken: '',
  refreshToken: '',
  licenseAccessToken: '',
  licenseKey: '',
  user: null,
  entitlement: null,
};

const browserDeviceCode = `WEB-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
const BROWSER_ONLINE_FRESHNESS_MS = 12 * 60 * 1000;
let browserEntitlementFreshUntilMs = 0;

function entitlementIsCurrent(entitlement) {
  if (!entitlement?.valid || Date.now() >= browserEntitlementFreshUntilMs) return false;
  const deadlines = [entitlement.expire, entitlement.expire_time]
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return deadlines.length === 0 || Math.min(...deadlines) > Date.now();
}

function clearBrowserEntitlement() {
  browserTokens.licenseAccessToken = '';
  browserTokens.licenseKey = '';
  browserTokens.entitlement = null;
  browserEntitlementFreshUntilMs = 0;
}

function desktopLicenseBridge() {
  return globalThis.window?.wangzaiDesktop?.license || null;
}

function browserRuntime() {
  return {
    mode: String(import.meta.env.VITE_LICENSE_MODE || 'observe'),
    serverUrl: String(import.meta.env.VITE_LICENSE_CENTER_URL || 'http://127.0.0.1:8000').replace(/\/$/, ''),
    projectCode: String(import.meta.env.VITE_LICENSE_PROJECT_CODE || 'wangzai_desktop'),
    projectName: '旺崽助手',
    version: String(import.meta.env.VITE_LICENSE_PROJECT_VERSION || '1.0.0'),
    versionHash: String(import.meta.env.VITE_LICENSE_VERSION_HASH || ''),
    channelCode: String(import.meta.env.VITE_LICENSE_CHANNEL_CODE || 'DIRECT'),
    campaignCode: 'direct',
    distributionToken: String(import.meta.env.VITE_LICENSE_DISTRIBUTION_TOKEN || ''),
    deviceCode: browserDeviceCode,
  };
}

function tokenForPath(path) {
  if (path.startsWith('/api/core-v2/cross-border/')) {
    return browserTokens.licenseAccessToken;
  }
  if (
    path.startsWith('/api/license/check') ||
    path.startsWith('/api/license/heartbeat') ||
    path.startsWith('/api/smart-reply/')
  ) {
    return browserTokens.licenseAccessToken || browserTokens.userAccessToken;
  }
  return browserTokens.userAccessToken;
}

function adoptBrowserResponse(path, payload) {
  const accessToken = String(payload?.access_token || payload?.license_token || '');
  if (accessToken) {
    if (path.startsWith('/api/license/')) browserTokens.licenseAccessToken = accessToken;
    else browserTokens.userAccessToken = accessToken;
  }
  if (payload?.refresh_token) browserTokens.refreshToken = String(payload.refresh_token);
  if (payload?.user) browserTokens.user = payload.user;
  const entitlement = path.startsWith('/api/license/')
    ? payload
    : path === '/api/auth/register' && payload?.entitlement && typeof payload.entitlement === 'object'
      ? payload.entitlement
      : null;
  if (entitlement && typeof entitlement.valid === 'boolean') {
    const licenseAccessToken = String(entitlement.access_token || entitlement.license_token || '');
    if (licenseAccessToken) browserTokens.licenseAccessToken = licenseAccessToken;
    if (entitlement.license_key) browserTokens.licenseKey = String(entitlement.license_key);
    browserTokens.entitlement = { ...stripTokens(entitlement), online_session_only: true };
    browserEntitlementFreshUntilMs = entitlement.valid ? Date.now() + BROWSER_ONLINE_FRESHNESS_MS : 0;
    if (!entitlement.valid) {
      browserTokens.licenseAccessToken = '';
      browserTokens.licenseKey = '';
    }
  }
}

function stripTokens(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const clean = { ...payload };
  delete clean.access_token;
  delete clean.refresh_token;
  delete clean.license_token;
  delete clean.offline_token;
  delete clean.license_key;
  if (clean.entitlement && typeof clean.entitlement === 'object' && !Array.isArray(clean.entitlement)) {
    clean.entitlement = stripTokens(clean.entitlement);
  }
  return clean;
}

async function browserRequest(input, allowLicenseRefresh = true) {
  const runtime = browserRuntime();
  const path = String(input.path || '');
  const isCrossBorderCoreRequest = path.startsWith('/api/core-v2/cross-border/');
  if (isCrossBorderCoreRequest && !browserTokens.licenseAccessToken && allowLicenseRefresh) {
    const checked = await browserRequest({
      method: 'POST',
      path: '/api/license/check',
      body: {
        project_code: runtime.projectCode,
        device_code: runtime.deviceCode,
        device_name: '旺崽助手桌面端',
        version: runtime.version,
        ...(runtime.versionHash ? { version_hash: runtime.versionHash } : {}),
      },
    }, false);
    if (!checked.ok) return checked;
    return browserRequest(input, false);
  }
  const { response, payload } = await requestLicenseCenterJson(`${runtime.serverUrl}${path}`, {
    method: input.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(input.body ? { 'Content-Type': 'application/json' } : {}),
      ...(tokenForPath(path) ? { Authorization: `Bearer ${tokenForPath(path)}` } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  if (!response) {
    return { ok: false, status: 0, error: '无法连接授权服务' };
  }
  if (!response.ok) {
    if (response.status === 401 && isCrossBorderCoreRequest && allowLicenseRefresh) {
      browserTokens.licenseAccessToken = '';
      return browserRequest(input, true);
    }
    if (path === '/api/license/check' || path === '/api/license/heartbeat') {
      clearBrowserEntitlement();
    }
    if (response.status === 401) {
      browserTokens.userAccessToken = '';
      browserTokens.refreshToken = '';
      browserTokens.user = null;
    }
    return {
      ok: false,
      status: response.status,
      error:
        typeof payload.detail === 'string'
          ? payload.detail
          : payload.detail?.message || payload.message || '请求失败',
    };
  }
  adoptBrowserResponse(path, payload);
  return { ok: true, status: response.status, data: stripTokens(payload) };
}

async function request(input) {
  const bridge = desktopLicenseBridge();
  let result;
  try {
    result = bridge ? await bridge.request(input) : await browserRequest(input);
  } catch (cause) {
    const rawMessage = cause instanceof Error ? cause.message : String(cause || '');
    const cleanMessage = rawMessage
      .replace(/^Error invoking remote method 'license:request':\s*/u, '')
      .replace(/^Error:\s*/u, '')
      .trim();
    const message = cleanMessage.includes('请求地址不在 License Center 允许列表中')
      ? '当前桌面端尚未启用管理端授权通道，请关闭并重新打开旺崽助手。'
      : cleanMessage || '管理端授权请求失败';
    const error = new Error(message);
    error.status = 0;
    throw error;
  }
  if (!result?.ok) {
    const error = new Error(result?.error || 'License Center 请求失败');
    error.status = Number(result?.status || 0);
    throw error;
  }
  return result.data;
}

export async function getLicenseRuntime() {
  return desktopLicenseBridge()?.getRuntime?.() || browserRuntime();
}

export async function getLicenseSession() {
  const bridge = desktopLicenseBridge();
  if (bridge) return bridge.getSession();
  const authorized = entitlementIsCurrent(browserTokens.entitlement);
  const entitlement = authorized ? { ...browserTokens.entitlement, valid: true } : null;
  if (!authorized && browserTokens.entitlement) clearBrowserEntitlement();
  return {
    authenticated: Boolean(browserTokens.userAccessToken),
    authorized,
    persistent: false,
    user: browserTokens.user,
    entitlement,
  };
}

export async function authorizeCrossBorderWithServer(input = {}) {
  return request({
    method: 'POST',
    path: '/api/core-v2/cross-border/authorize',
    body: {
      account_ref: String(input.accountRef || input.account_ref || '').trim(),
      user_name: String(input.userName || input.user_name || '').trim(),
      password: String(input.password || ''),
      previous_authorization_ref: String(
        input.previousAuthorizationRef || input.previous_authorization_ref || '',
      ).trim(),
    },
  });
}

export async function revokeCrossBorderWithServer(input = {}) {
  return request({
    method: 'POST',
    path: '/api/core-v2/cross-border/revoke',
    body: {
      account_ref: String(input.accountRef || input.account_ref || '').trim(),
      authorization_ref: String(input.authorizationRef || input.authorization_ref || '').trim(),
    },
  });
}

export async function listCrossBorderServerEndpoints() {
  return request({ method: 'GET', path: '/api/core-v2/cross-border/endpoints' });
}

export async function readCrossBorderWithServer(input = {}) {
  return request({
    method: 'POST',
    path: '/api/core-v2/cross-border/read',
    body: {
      authorization_ref: String(input.authorizationRef || input.authorization_ref || '').trim(),
      endpoint_key: String(input.endpointKey || input.endpoint_key || '').trim(),
      body: input.body && typeof input.body === 'object' ? input.body : {},
    },
  });
}

export async function previewCrossBorderWriteWithServer(input = {}) {
  return request({
    method: 'POST',
    path: '/api/core-v2/cross-border/write/preview',
    body: {
      authorization_ref: String(input.authorizationRef || input.authorization_ref || '').trim(),
      endpoint_key: String(input.endpointKey || input.endpoint_key || '').trim(),
      body: input.body && typeof input.body === 'object' ? input.body : {},
      request_id: String(
        input.requestId || input.request_id || globalThis.crypto?.randomUUID?.() || Date.now(),
      ).trim(),
    },
  });
}

export async function confirmCrossBorderWriteWithServer(input = {}) {
  return request({
    method: 'POST',
    path: '/api/core-v2/cross-border/write/confirm',
    body: {
      authorization_ref: String(input.authorizationRef || input.authorization_ref || '').trim(),
      preview_token: String(input.previewToken || input.preview_token || '').trim(),
    },
  });
}

export async function beginFreshLicenseLogin() {
  const bridge = desktopLicenseBridge();
  if (bridge?.beginLogin) return bridge.beginLogin();
  Object.assign(browserTokens, {
    userAccessToken: '',
    refreshToken: '',
    licenseAccessToken: '',
    licenseKey: '',
    user: null,
    entitlement: null,
  });
  browserEntitlementFreshUntilMs = 0;
  return { ok: true };
}

export async function getRememberedLicenseLogin() {
  const bridge = desktopLicenseBridge();
  if (bridge?.getRememberedLogin) return bridge.getRememberedLogin();
  return { remembered: false, email: '', persistent: false };
}

export async function saveRememberedLicenseLogin(email, password) {
  const bridge = desktopLicenseBridge();
  if (!bridge?.saveRememberedLogin) {
    return { remembered: false, email: '', persistent: false };
  }
  return bridge.saveRememberedLogin({
    email: String(email || '')
      .trim()
      .toLowerCase(),
    password: String(password || ''),
  });
}

export async function clearRememberedLicenseLogin() {
  const bridge = desktopLicenseBridge();
  if (!bridge?.clearRememberedLogin) {
    return { remembered: false, email: '', persistent: false };
  }
  return bridge.clearRememberedLogin();
}

export async function loginWithRememberedLicenseAccount() {
  const bridge = desktopLicenseBridge();
  const result = bridge?.loginWithRememberedCredentials
    ? await bridge.loginWithRememberedCredentials()
    : { ok: false, status: 400, error: '当前设备没有已保存的账号和密码' };
  if (!result?.ok) {
    const error = new Error(result?.error || '保存的账号或密码已失效');
    error.status = Number(result?.status || 0);
    throw error;
  }
  return result.data;
}

export function buildSmsPayload(runtime, phone, code = '') {
  return {
    phone: String(phone || '').trim(),
    ...(code ? { code: String(code).trim() } : {}),
    project_code: runtime.projectCode,
    device_code: runtime.deviceCode,
    device_name: '旺崽助手桌面端',
    version: runtime.version,
    ...(runtime.versionHash ? { version_hash: runtime.versionHash } : {}),
    ...(runtime.distributionToken
      ? { channel_code: runtime.channelCode, distribution_token: runtime.distributionToken }
      : {}),
  };
}

export function buildPasswordAuthPayload(runtime, fields = {}) {
  const username = String(fields.username || '').trim();
  const email = String(fields.email || '')
    .trim()
    .toLowerCase();
  return {
    ...(username ? { username } : {}),
    ...(email ? { email } : {}),
    password: String(fields.password || ''),
    project_code: runtime.projectCode,
    device_code: runtime.deviceCode,
    device_name: '旺崽助手桌面端',
    version: runtime.version,
    ...(runtime.versionHash ? { version_hash: runtime.versionHash } : {}),
    ...(runtime.distributionToken
      ? { channel_code: runtime.channelCode, distribution_token: runtime.distributionToken }
      : {}),
  };
}

export async function loginLicenseAccount(runtime, email, password) {
  return request({
    method: 'POST',
    path: '/api/auth/login',
    body: buildPasswordAuthPayload(runtime, { email, password }),
  });
}

export async function registerLicenseAccount(runtime, { password, email, cardKey }) {
  return request({
    method: 'POST',
    path: '/api/auth/register',
    body: {
      ...buildPasswordAuthPayload(runtime, { password, email }),
      card_key: String(cardKey || '')
        .trim()
        .toUpperCase(),
    },
  });
}

export async function getCurrentLicenseAccount() {
  return request({ method: 'GET', path: '/api/auth/me' });
}

export async function sendSmsCode(runtime, phone) {
  return request({
    method: 'POST',
    path: '/api/auth/sms/send',
    body: { ...buildSmsPayload(runtime, phone), scene: 'login_or_register' },
  });
}

export async function verifySmsCode(runtime, phone, code, cardKey = '') {
  return request({
    method: 'POST',
    path: '/api/auth/sms/verify',
    body: {
      ...buildSmsPayload(runtime, phone, code),
      ...(cardKey ? { card_key: String(cardKey).trim().toUpperCase() } : {}),
    },
  });
}

export async function listStorePlans(runtime) {
  const payload = await request({
    method: 'GET',
    path: `/api/store/plans?project_code=${encodeURIComponent(runtime.projectCode)}`,
  });
  return Array.isArray(payload) ? payload : payload?.items || payload?.plans || [];
}

export async function createStoreOrder(runtime, planId, idempotencyKey = '') {
  return request({
    method: 'POST',
    path: '/api/orders',
    body: {
      project_code: runtime.projectCode,
      plan_id: planId,
      ...(idempotencyKey ? { idempotency_key: String(idempotencyKey) } : {}),
    },
  });
}

export async function listPointPackages(runtime) {
  const payload = await request({
    method: 'GET',
    path: `/api/points/packages?project_code=${encodeURIComponent(runtime.projectCode)}`,
  });
  return Array.isArray(payload) ? payload : payload?.items || [];
}

export async function getPointWallet(runtime, options = {}) {
  const bridge = desktopLicenseBridge();
  if (typeof bridge?.getPointsWalletSnapshot === 'function') {
    const result = await bridge.getPointsWalletSnapshot({ force: options.force === true });
    if (result?.wallet) return result.wallet;
    const error = new Error(result?.error || '积分钱包读取失败');
    error.status = Number(result?.status || 0);
    throw error;
  }
  return request({
    method: 'GET',
    path: `/api/points/wallet?project_code=${encodeURIComponent(runtime.projectCode)}`,
  });
}

export async function getUserModelPresets(runtime) {
  return request({
    method: 'GET',
    path: `/api/model-presets?project_code=${encodeURIComponent(runtime.projectCode)}`,
  });
}

export async function updateUserModelPresets(runtime, groups) {
  return request({
    method: 'PUT',
    path: '/api/model-presets',
    body: {
      project_code: runtime.projectCode,
      groups,
    },
  });
}

export async function listPointLedger(runtime, { page = 1, pageSize = 20 } = {}) {
  return request({
    method: 'GET',
    path: `/api/points/ledger?project_code=${encodeURIComponent(runtime.projectCode)}&page=${encodeURIComponent(
      String(page)
    )}&page_size=${encodeURIComponent(String(pageSize))}`,
    page,
    pageSize,
  });
}

export async function spendPointBalance(runtime, payload) {
  return request({
    method: 'POST',
    path: '/api/points/spend',
    body: {
      ...payload,
      project_code: runtime.projectCode,
    },
  });
}

export async function startOrderPayment(orderId, provider) {
  return request({
    method: 'POST',
    path: `/api/orders/${encodeURIComponent(String(orderId))}/pay`,
    body: { provider },
  });
}

export async function getStoreOrder(orderId) {
  return request({ method: 'GET', path: `/api/orders/${encodeURIComponent(String(orderId))}` });
}

export async function queryStoreOrderPayment(orderId) {
  return request({
    method: 'POST',
    path: `/api/orders/${encodeURIComponent(String(orderId))}/query`,
    body: {},
  });
}

export async function completeDevelopmentPayment(orderNo) {
  return request({
    method: 'POST',
    path: `/api/payments/development/${encodeURIComponent(String(orderNo))}/complete`,
    body: {},
  });
}

export function findActivationCode(payload) {
  return String(
    payload?.activation_code ||
      payload?.card_key ||
      payload?.fulfillment?.activation_code ||
      payload?.fulfillment?.card_key ||
      ''
  );
}

export async function activatePurchasedLicense(runtime, cardKey) {
  return request({
    method: 'POST',
    path: '/api/license/activate',
    body: {
      card_key: cardKey,
      project_code: runtime.projectCode,
      device_code: runtime.deviceCode,
      device_name: '旺崽助手桌面端',
      version: runtime.version,
      ...(runtime.versionHash ? { version_hash: runtime.versionHash } : {}),
    },
  });
}

export async function listShopLicenseEntitlements(runtime) {
  const payload = await request({
    method: 'GET',
    path: `/api/license/entitlements?project_code=${encodeURIComponent(runtime.projectCode)}`,
  });
  return Array.isArray(payload) ? payload : [];
}

export async function bindCurrentLicenseToOzonShop(runtime, { shopId, shopName }) {
  return request({
    method: 'POST',
    path: '/api/shops/bind',
    body: {
      license_key: browserTokens.licenseKey,
      project_code: runtime.projectCode,
      platform: 'ozon',
      shop_id: String(shopId || '').trim(),
      shop_name: String(shopName || shopId || '').trim(),
    },
  });
}

export async function bindOwnedLicenseToOzonShop(runtime, { licenseId, shopId, shopName }) {
  return request({
    method: 'POST',
    path: '/api/license/bind-shop',
    body: {
      license_id: Number(licenseId),
      project_code: runtime.projectCode,
      shop_id: String(shopId || '').trim(),
      shop_name: String(shopName || shopId || '').trim(),
    },
  });
}

export async function activateAndBindOzonShop(runtime, { cardKey, shopId, shopName }) {
  return request({
    method: 'POST',
    path: '/api/license/activate-shop',
    body: {
      card_key: String(cardKey || '')
        .trim()
        .toUpperCase(),
      project_code: runtime.projectCode,
      device_code: runtime.deviceCode,
      device_name: '旺崽助手桌面端',
      version: runtime.version,
      ...(runtime.versionHash ? { version_hash: runtime.versionHash } : {}),
      shop_id: String(shopId || '').trim(),
      shop_name: String(shopName || shopId || '').trim(),
    },
  });
}

export async function renewPurchasedLicense(runtime, licenseId, cardKey) {
  return request({
    method: 'POST',
    path: '/api/license/renew',
    body: {
      license_id: Number(licenseId),
      card_key: String(cardKey || '')
        .trim()
        .toUpperCase(),
      project_code: runtime.projectCode,
      device_code: runtime.deviceCode,
      device_name: '旺崽助手桌面端',
      version: runtime.version,
      ...(runtime.versionHash ? { version_hash: runtime.versionHash } : {}),
    },
  });
}

export async function checkDesktopLicense(runtime) {
  return request({
    method: 'POST',
    path: '/api/license/check',
    body: {
      project_code: runtime.projectCode,
      device_code: runtime.deviceCode,
      device_name: '旺崽助手桌面端',
      version: runtime.version,
      ...(runtime.versionHash ? { version_hash: runtime.versionHash } : {}),
    },
  });
}

export async function heartbeatDesktopLicense(runtime) {
  return request({
    method: 'POST',
    path: '/api/license/heartbeat',
    body: {
      project_code: runtime.projectCode,
      device_code: runtime.deviceCode,
      version: runtime.version,
      ...(runtime.versionHash ? { version_hash: runtime.versionHash } : {}),
    },
  });
}

export async function logoutLicenseAccount() {
  const bridge = desktopLicenseBridge();
  if (bridge) return bridge.logout();
  Object.assign(browserTokens, {
    userAccessToken: '',
    refreshToken: '',
    licenseAccessToken: '',
    licenseKey: '',
    user: null,
    entitlement: null,
  });
  browserEntitlementFreshUntilMs = 0;
  return { ok: true };
}

export async function getSmartReplyRuntimeStatus() {
  return request({ method: 'GET', path: '/api/smart-reply/status' });
}

export async function listSmartReplyCredentials() {
  const payload = await request({ method: 'GET', path: '/api/smart-reply/credentials' });
  return Array.isArray(payload) ? payload : [];
}

export async function syncBoundSmartReplyShopCredential({ shopId, clientId }) {
  const bridge = desktopLicenseBridge();
  if (!bridge?.syncSmartReplyShop) {
    const error = new Error('请在旺崽桌面端内使用已绑定店铺授权同步。');
    error.status = 409;
    throw error;
  }
  const result = await bridge.syncSmartReplyShop({
    shopId: String(shopId || '').trim(),
    clientId: String(clientId || '').trim(),
  });
  if (!result?.ok) {
    const error = new Error(result?.error || '已绑定店铺授权同步失败。');
    error.status = Number(result?.status || 0);
    throw error;
  }
  return result.data;
}

export async function listSmartReplyRules() {
  const payload = await request({ method: 'GET', path: '/api/smart-reply/rules' });
  return Array.isArray(payload) ? payload : [];
}

export async function saveSmartReplyRule(payload) {
  return request({
    method: 'POST',
    path: '/api/smart-reply/rules',
    body: payload,
  });
}

export async function setSmartReplyRuleEnabled(ruleId, enabled) {
  return request({
    method: 'POST',
    path: `/api/smart-reply/rules/${encodeURIComponent(String(ruleId || ''))}/enabled`,
    body: { enabled: enabled === true },
  });
}

export async function listSmartReplyTasks(limit = 100) {
  return request({
    method: 'GET',
    path: `/api/smart-reply/tasks?limit=${encodeURIComponent(String(limit))}`,
  });
}

export async function retrySmartReplyTask(taskId) {
  return request({
    method: 'POST',
    path: `/api/smart-reply/tasks/${encodeURIComponent(String(taskId || ''))}/retry`,
    body: {},
  });
}
import { requestLicenseCenterJson } from '../../../services/licenseCenterTransport.js';

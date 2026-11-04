import { listIntegrationProfiles, requestLocalApi, saveIntegrationProfile } from '../../../api/localApiClient.js';
import {
  getOzonBrowserCaptureErrorMessage,
  getOzonBrowserCommand,
  isOzonBrowserSessionStaleError,
} from '../../../services/ozonBrowserCaptureClient.js';

const API_PREFIX = '/api/follow-seller-defense';
export const FOLLOW_SELLER_SCHEME1_FREEZE_VERSION = 'follow-seller-scheme1-v27-cef150-visible-session-20260828';
const CAPTURE_BATCH_SIZE = 100;
const CAPTURE_RECOVERY_BATCH_SIZE = 20;
const CAPTURE_RATE_LIMIT_BATCH_SIZE = 12;
const CAPTURE_COOLDOWN_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000]);
const CAPTURE_INTER_BATCH_DELAY_MS = 150;
const CAPTURE_PERIODIC_COOLDOWN_EVERY = 500;
const CAPTURE_PERIODIC_COOLDOWN_MS = 2_000;
const DEFAULT_CAPTURE_CONCURRENCY = 6;
const MANUAL_VERIFICATION_POLL_MS = 1_000;
const MANUAL_VERIFICATION_TIMEOUT_MS = 10 * 60_000;
const OVERVIEW_PAGE_SIZE = 500;
const FOLLOW_SELLER_BROWSER_ROLE = 'follow-seller-collector';
const FOLLOW_SELLER_LOGIN_BROWSER_ROLE = 'interactive';
const FOLLOW_SELLER_LOGIN_PROFILE_TYPE = 'ozon-follow-seller-session';
const OZON_SELLER_PROFILE_TYPE = 'ozon-browser-session';
const OZON_FRONT_HOME_URL = 'https://www.ozon.ru/';
const OZON_SELLER_HOME_URL = 'https://seller.ozon.ru/app/dashboard/main';
const SCHEME1_PRE_SUBMISSION_RETRY_DELAY_MS = 1_200;
const SCHEME1_PRE_SUBMISSION_RETRY_CODES = Object.freeze([
  'PURCHASE_BROWSER_CEF_FAILED',
  'PURCHASE_BROWSER_CEF_HOST_FAILED',
  'PURCHASE_BROWSER_CEF_PROTOCOL',
  'PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED',
  'PURCHASE_BROWSER_INTEGRATION_LOGIN_STATUS_PERSIST_FAILED',
	'OZON_LOGIN_VERIFICATION_PENDING',
  'FOLLOW_SELLER_SCHEME1_BROWSER_TRANSIENT_FAILED',
]);
let followSellerCaptureSequence = 0;
let followSellerScheme1ProgressSequence = 0;
let activeFollowSellerQuickBrowser = null;
let activeFollowSellerVerificationBrowser = null;

function text(value) {
  return String(value ?? '').trim();
}

function nextFollowSellerCaptureToken() {
  followSellerCaptureSequence += 1;
  return `follow-seller-${Date.now().toString(36)}-${followSellerCaptureSequence.toString(36)}`;
}

function nextFollowSellerScheme1ProgressToken() {
  followSellerScheme1ProgressSequence += 1;
  return `scheme1-progress-${Date.now().toString(36)}-${followSellerScheme1ProgressSequence.toString(36)}`;
}

function responseResult(response = {}) {
  return response?.result ?? response?.data?.result ?? response?.data ?? response;
}

function quickComplaintFailureResult(failure = {}) {
  const code = text(failure?.code || failure?.message) || 'FOLLOW_SELLER_SCHEME1_SUBMIT_FAILED';
  return {
    ok: false,
    submissionStarted: failure?.submissionStarted === true,
    stage: text(failure?.stage),
    phase: text(failure?.phase),
    error: {
      code,
      message: text(failure?.message) || 'Ozon 卖家后台提交失败。',
    },
  };
}

function shouldRetryQuickComplaint(result = {}) {
  if (result?.ok === true || result?.submissionStarted === true) return false;
  const search = [
    result?.error?.code,
    result?.error?.message,
    result?.code,
    result?.message,
    result?.stage,
  ].map(text).join('\n').toUpperCase();
  return SCHEME1_PRE_SUBMISSION_RETRY_CODES.some((code) => search.includes(code));
}

function trustedQuickComplaintContinuation(result = {}, fallback = {}) {
  const ticketId = text(result?.ticketId || fallback?.ticketId);
  const pageUrl = text(result?.pageUrl || fallback?.pageUrl);
  if (!ticketId || !pageUrl) return fallback;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'https:'
      || parsed.hostname.toLowerCase() !== 'seller.ozon.ru'
      || !parsed.pathname.startsWith('/app/messenger')) return fallback;
  } catch {
    return fallback;
  }
  return {
    requested: true,
    ticketId,
    pageUrl,
    phase: text(result?.phase || fallback?.phase),
    previousSubmissionStarted: result?.submissionStarted === true
      || fallback?.previousSubmissionStarted === true,
  };
}

function preserveQuickComplaintFirstFailure(firstFailure = {}, retryFailure = {}) {
  if (retryFailure?.ok === true) return retryFailure;
	const retryCode = text(retryFailure?.error?.code || retryFailure?.code);
	if (retryCode === 'FOLLOW_SELLER_COMPLAINT_DAILY_LIMIT') {
	  return {
		...retryFailure,
		recoveryAttempted: true,
		initialFailure: firstFailure,
	  };
	}
  return {
    ...firstFailure,
	submissionStarted: firstFailure?.submissionStarted === true || retryFailure?.submissionStarted === true,
    ticketId: text(firstFailure?.ticketId || retryFailure?.ticketId),
    pageUrl: text(firstFailure?.pageUrl || retryFailure?.pageUrl),
    phase: text(firstFailure?.phase || retryFailure?.phase),
    recoveryAttempted: true,
    retryFailure: {
      submissionStarted: retryFailure?.submissionStarted === true,
      stage: text(retryFailure?.stage),
      phase: text(retryFailure?.phase),
      ticketId: text(retryFailure?.ticketId),
      pageUrl: text(retryFailure?.pageUrl),
      error: {
        code: text(retryFailure?.error?.code || retryFailure?.code),
        message: text(retryFailure?.error?.message || retryFailure?.message),
      },
    },
  };
}

function waitForScheme1Recovery(signal) {
  return waitForCaptureCooldown(SCHEME1_PRE_SUBMISSION_RETRY_DELAY_MS, signal);
}

function waitForCancelableBrowserCommand(operation, signal, message) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new DOMException(message, 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException(message, 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (failure) => {
        signal.removeEventListener('abort', onAbort);
        reject(failure);
      },
    );
  });
}

function normalizeCaptureResult(result = {}) {
  const sku = text(result.sku || result.skuId || result.id);
  const rawCount = result.followSellerCount
    ?? result.follow_seller_count
    ?? result.followCount
    ?? result.follow_info?.count;
  const count = Number(rawCount);
  const confirmed = rawCount !== undefined
    && rawCount !== null
    && rawCount !== ''
    && Number.isFinite(count)
    && count >= 0;
  return {
    ...result,
    sku,
    confirmed,
    followSellerConfirmed: confirmed,
    followSellerCount: confirmed ? Math.max(0, Number.isFinite(count) ? Math.floor(count) : 0) : null,
    followMinPrice: Number.isFinite(Number(result.followMinPrice)) ? Number(result.followMinPrice) : null,
    followMaxPrice: Number.isFinite(Number(result.followMaxPrice)) ? Number(result.followMaxPrice) : null,
    followSellers: Array.isArray(result.followSellers)
      ? result.followSellers
      : Array.isArray(result.follow_info?.sellers)
        ? result.follow_info.sellers
        : [],
    capturedAt: text(result.capturedAt || result.observedAt),
    sourceProductUrl: text(result.sourceProductUrl || result.productUrl),
    offersRoute: text(result.offersRoute),
    captureSource: text(result.source || 'ozon-public-product-page'),
  };
}

function isNetworkCaptureResult(result = {}) {
  if (result?.confirmed === true || result?.followSellerConfirmed === true) return false;
  const status = Number(result?.status || result?.followSellerStatus) || 0;
  const code = text(result?.errorCode || result?.code || result?.detail).toUpperCase();
  return status === 403
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
    || code.includes('HTTP_403')
    || code.includes('TIMEOUT')
    || code.includes('NETWORK')
    || code.includes('FAILED_TO_FETCH')
    || code.includes('BROWSER_REQUEST_FAILED')
    || code.includes('OZON_RR_CHALLENGE')
    || code.includes('OZON_RISK_CONTROL')
    || code.includes('CAPTCHA_REQUIRED');
}

function isRiskControlResult(result = {}) {
  if (result?.confirmed === true || result?.followSellerConfirmed === true) return false;
  const status = Number(result?.status || result?.followSellerStatus) || 0;
  const code = text(result?.errorCode || result?.code || result?.detail).toUpperCase();
  return status === 403
    || code.includes('OZON_RR_CHALLENGE')
    || code.includes('OZON_RISK_CONTROL')
    || code.includes('CAPTCHA_REQUIRED');
}

function isNetworkCaptureError(error) {
  const code = text(error?.code || error?.message).toUpperCase();
  return code.includes('TIMEOUT')
    || code.includes('NETWORK')
    || code.includes('FAILED_TO_FETCH')
    || code.includes('BROWSER_REQUEST_FAILED')
    || code.includes('OZON_RR_CHALLENGE')
    || code.includes('OZON_RISK_CONTROL')
    || code.includes('CAPTCHA_REQUIRED')
    || /HTTP_(?:403|408|425|429|5\d\d)/u.test(code);
}

function isRiskControlError(error) {
  const code = text(error?.code || error?.message).toUpperCase();
  return code.includes('HTTP_403')
    || code.includes('OZON_RR_CHALLENGE')
    || code.includes('OZON_RISK_CONTROL')
    || code.includes('CAPTCHA_REQUIRED');
}

function isWholeBatchNetworkFailure(response = {}, results = [], expectedCount = 0) {
  if (!expectedCount || !results.length) {
    return expectedCount > 0 && Number(response?.failed) >= expectedCount;
  }
  return results.length === expectedCount && results.every(isNetworkCaptureResult);
}

function networkRouteError(results = [], sourceError = null) {
  const errorCode = text(sourceError?.code || sourceError?.message).toUpperCase();
  const status = results.map((item) => Number(item?.status) || 0).find(Boolean)
    || Number(errorCode.match(/HTTP_(\d{3})/u)?.[1])
    || 0;
  const failure = new Error(
    status === 403 || results.some(isRiskControlResult) || isRiskControlError(sourceError)
      ? 'Ozon 已对巡查浏览器触发临时访问验证。系统完成了分级冷却和低速复查，巡查进度已保留，可稍后点“一键重试巡查失败”。'
      : status === 429
        ? 'Ozon 当前处于临时限流。系统完成了分级冷却和低速复查，巡查进度已保留，可稍后点“一键重试巡查失败”。'
        : '当前网络线路没有返回 Ozon 跟卖数据。系统已自动复查可用线路，巡查进度已保留。',
  );
  failure.code = status === 403 || results.some(isRiskControlResult) || isRiskControlError(sourceError)
    ? 'FOLLOW_SELLER_OZON_RISK_CONTROL'
    : status === 429
    ? `FOLLOW_SELLER_NETWORK_HTTP_${status}`
    : 'FOLLOW_SELLER_NETWORK_ROUTE_UNAVAILABLE';
  return failure;
}

function waitForCaptureCooldown(delayMs, signal) {
  const waitMs = Math.max(0, Number(delayMs) || 0);
  if (!waitMs) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException('巡查已停止', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, waitMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('巡查已停止', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isReadyOzonVerificationPage(tab = {}, challengeObserved = false) {
  if (tab?.followSellerVerificationVisible !== true) return false;
  if (tab?.loading === true || tab?.crashed === true || Number(tab?.loadErrorCode) !== 0) return false;
  const verification = tab?.followSellerVerificationStatus;
  if (!verification || verification.challengeDetected === true) return false;
  if (!challengeObserved || verification.pageReady !== true || verification.verificationReady !== true) return false;
  try {
    const target = new URL(text(tab?.url));
    const hostname = target.hostname.toLowerCase();
    return (hostname === 'ozon.ru' || hostname.endsWith('.ozon.ru'))
      && !target.searchParams.has('__rr');
  } catch {
    return false;
  }
}

async function waitForManualFollowSellerVerification({
  command,
  tabId,
  verificationUrl,
  attempt,
  onRecovery,
  onBrowserState,
  signal,
  pollMs = MANUAL_VERIFICATION_POLL_MS,
  timeoutMs = MANUAL_VERIFICATION_TIMEOUT_MS,
} = {}) {
  const shownState = commandState(await command({
    command: 'show-follow-seller-verification',
    tabId,
    url: verificationUrl,
    signal,
  }));
  const shownTab = (Array.isArray(shownState?.tabs) ? shownState.tabs : [])
    .find((tab) => text(tab?.tabId) === text(tabId));
  if (!shownTab || shownTab.followSellerVerificationVisible !== true) {
    if (shownTab) {
      await command({ command: 'hide-follow-seller-verification', tabId }).catch(() => undefined);
    }
    const error = new Error('Ozon 人工验证窗口没有真正显示，请重试巡查。');
    error.code = shownTab
      ? 'FOLLOW_SELLER_VERIFICATION_WINDOW_NOT_VISIBLE'
      : 'FOLLOW_SELLER_VERIFICATION_TAB_NOT_FOUND';
    throw error;
  }
  activeFollowSellerVerificationBrowser = {
    command,
    tabId: text(tabId),
    url: text(verificationUrl),
    visible: true,
  };
  onBrowserState?.({ available: true, visible: true, tabId: text(tabId) });
  let challengeObserved = shownTab.followSellerVerificationStatus?.challengeDetected === true;
  onRecovery?.({
    attempt,
    delayMs: 0,
    networkMode: text(shownTab.proxyMode) === 'direct' ? 'direct' : 'auto',
    status: 403,
    reason: 'manual_verification',
  });
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || MANUAL_VERIFICATION_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await waitForCaptureCooldown(Math.max(0, Number(pollMs) || 0), signal);
    const state = commandState(await command({
      command: 'read-follow-seller-verification',
      tabId,
      signal,
    }));
    const tab = (Array.isArray(state?.tabs) ? state.tabs : [])
      .find((item) => text(item?.tabId) === text(tabId));
    if (!tab) {
      activeFollowSellerVerificationBrowser = null;
      onBrowserState?.({ available: false, visible: false, tabId: text(tabId) });
      const error = new Error('Ozon 验证页面已关闭，请重试巡查。');
      error.code = 'FOLLOW_SELLER_VERIFICATION_TAB_CLOSED';
      throw error;
    }
    activeFollowSellerVerificationBrowser = {
      ...activeFollowSellerVerificationBrowser,
      command,
      tabId: text(tabId),
      url: text(verificationUrl),
      visible: tab.followSellerVerificationVisible === true,
    };
    onBrowserState?.({
      available: true,
      visible: tab.followSellerVerificationVisible === true,
      tabId: text(tabId),
    });
    if (tab.followSellerVerificationStatus?.challengeDetected === true) challengeObserved = true;
    if (isReadyOzonVerificationPage(tab, challengeObserved)) {
      onRecovery?.({
        attempt,
        delayMs: 0,
        networkMode: text(tab.proxyMode) === 'direct' ? 'direct' : 'auto',
        status: 200,
        reason: 'manual_verification_complete',
      });
      return;
    }
  }
  const error = new Error('Ozon 滑块验证等待超时，巡查进度已保留。');
  error.code = 'FOLLOW_SELLER_MANUAL_VERIFICATION_TIMEOUT';
  throw error;
}

async function post(path, body, options = {}) {
  return requestLocalApi(`${API_PREFIX}${path}`, {
    method: 'POST',
    body,
    signal: options.signal,
    timeoutMs: options.timeoutMs || 120_000,
  });
}

export async function getFollowSellerOverview(options = {}) {
  const pageSize = Math.max(1, Math.min(
    Number(options.pageSize || options.limit) || OVERVIEW_PAGE_SIZE,
    OVERVIEW_PAGE_SIZE,
  ));
  const casesById = new Map();
  let offset = 0;
  let firstPage = null;
  let counts = { total: 0 };
  while (true) {
    const query = new URLSearchParams();
    if (options.shopId) query.set('shopId', options.shopId);
    if (options.status) query.set('status', options.status);
    query.set('limit', String(pageSize));
    query.set('offset', String(offset));
    const page = await requestLocalApi(`${API_PREFIX}/overview?${query.toString()}`, {
      method: 'GET',
      signal: options.signal,
      timeoutMs: options.timeoutMs || 30_000,
    });
    firstPage ||= page;
    counts = page?.counts || counts;
    const pageCases = Array.isArray(page?.cases) ? page.cases : [];
    const sizeBefore = casesById.size;
    for (const item of pageCases) {
      const id = text(item?.id || item?.caseId);
      if (id) casesById.set(id, item);
    }
    offset += pageCases.length;
    const reportedTotal = Math.max(0, Number(page?.pagination?.total ?? counts.total) || 0);
    if (!pageCases.length || pageCases.length < pageSize || (reportedTotal > 0 && offset >= reportedTotal)) break;
    if (casesById.size === sizeBefore) {
      const failure = new Error('巡查记录分页没有前进，已停止读取，避免界面卡死。');
      failure.code = 'FOLLOW_SELLER_OVERVIEW_PAGINATION_STALLED';
      throw failure;
    }
  }
  return {
    ...(firstPage || { ok: true }),
    cases: [...casesById.values()],
    counts,
    pagination: { offset: 0, limit: pageSize, total: Math.max(0, Number(counts.total) || casesById.size) },
  };
}

export function getFollowSellerLogins(options = {}) {
  return requestLocalApi(`${API_PREFIX}/logins`, {
    method: 'GET',
    signal: options.signal,
    timeoutMs: options.timeoutMs || 30_000,
  });
}

export function selectFollowSellerLogin({ profileId = '' } = {}, options = {}) {
  return post('/logins/select', { profileId: text(profileId) }, options);
}

export async function createFollowSellerLoginProfile({
  sequence = 1,
} = {}, options = {}) {
  const number = Math.max(1, Math.floor(Number(sequence) || 1));
  const result = await saveIntegrationProfile({
    integrationType: FOLLOW_SELLER_LOGIN_PROFILE_TYPE,
    platformName: `Ozon 前台巡查 ${number}`,
    apiType: 'Ozon 前台跟卖巡查登录',
    authMode: '验证码登录',
    configStatus: '待登录',
    tokenStatus: 'Cookie 未保存',
    readScope: '全部店铺商品的 Ozon 前台跟卖巡查',
    writeScope: '无',
    note: '剔除跟卖专用 Ozon 前台独立登录，全部店铺共享',
  }, {
    signal: options.signal,
    timeoutMs: options.timeoutMs || 30_000,
  });
  const profile = result?.profile || result?.data?.profile || null;
  if (!profile?.id) {
    const error = new Error('Ozon 前台巡查账号创建失败，请重试。');
    error.code = 'FOLLOW_SELLER_LOGIN_PROFILE_CREATE_FAILED';
    throw error;
  }
  await selectFollowSellerLogin({ profileId: profile.id }, options);
  return profile;
}

function selectAccountTab(state = {}, profileId = '') {
  return (Array.isArray(state?.tabs) ? state.tabs : []).find((tab) => (
    text(tab?.accountId) === text(profileId)
    && text(tab?.browserRole || FOLLOW_SELLER_LOGIN_BROWSER_ROLE) === FOLLOW_SELLER_LOGIN_BROWSER_ROLE
  )) || null;
}

/**
 * Opens the patrol-only interactive login. Its integration profile has its
 * own native RequestContext/Profile, so it never reuses the market collector,
 * shop-management login or purchase-account cookie directory.
 */
export async function openFollowSellerLoginBrowser({ profileId = '', profileName = '' } = {}) {
  const normalizedProfileId = text(profileId);
  if (!normalizedProfileId) {
    const error = new Error('请选择 Ozon 前台巡查账号。');
    error.code = 'FOLLOW_SELLER_LOGIN_PROFILE_REQUIRED';
    throw error;
  }
  const command = getOzonBrowserCommand();
  const response = await command({
    command: 'open',
    ownerType: 'integration_profile',
    accountId: normalizedProfileId,
    accountLabel: text(profileName) || 'Ozon 前台巡查账号',
    platformName: 'Ozon买家',
    url: OZON_FRONT_HOME_URL,
    waitUntil: 'commit',
    restoreVisible: true,
    browserRole: FOLLOW_SELLER_LOGIN_BROWSER_ROLE,
    background: false,
  });
  const state = commandState(response);
  const tab = selectAccountTab(state, normalizedProfileId);
  if (!tab?.tabId) {
    const error = new Error('Ozon 前台巡查登录窗口打开失败，请重试。');
    error.code = 'PURCHASE_BROWSER_TAB_NOT_FOUND';
    throw error;
  }
  return { ok: true, state, tab };
}

export const resolveFollowSellerProduct = (body, options) => post('/resolve', body, options);
export const startFollowSellerPatrol = (body, options) => post('/patrols', body, options);
export const recordFollowSellerCapture = (body, options) => post('/capture', body, options);
export const retryFollowSellerCapture = (body, options) => post('/capture/retry', body, options);
export const prepareFollowSellerCases = (body, options) => post('/prepare', body, options);
export const prepareFollowSellerQuickCases = (body, options) => post('/prepare-quick', body, options);
export const finalizeFollowSellerEvidence = (body, options) => post('/evidence/finalize', body, options);
export const confirmFollowSellerCase = (body, options) => post('/confirm', body, options);
export const recordFollowSellerSubmissionResult = (body, options) => post('/submission-result', body, options);
export const prepareFollowSellerVerification = (body, options) => post('/verify/prepare', body, options);
export const verifyFollowSellerCase = (body, options) => post('/verify', body, options);

async function resolveBrowserProfileId({ profileId = '' } = {}) {
  // Patrol has one explicit global front-site profile pool. Store selection
  // only scopes the products/results and never selects a browser cookie jar.
  const requestedProfileId = text(profileId);
  if (!requestedProfileId) return '';
  const loginState = await getFollowSellerLogins();
  const exact = (Array.isArray(loginState?.profiles) ? loginState.profiles : []).find((profile) => (
    text(profile?.id) === requestedProfileId
    && profile?.connected === true
  ));
  return text(exact?.id);
}

async function resolveExactSellerProfileId({ shopId = '' } = {}) {
  const normalizedShopId = text(shopId);
  if (!normalizedShopId) return '';
  const result = await listIntegrationProfiles({ timeoutMs: 30_000 });
  const profiles = Array.isArray(result?.profiles) ? result.profiles : Array.isArray(result?.rows) ? result.rows : [];
  const exact = profiles.find((profile) => (
    text(profile?.integrationType) === OZON_SELLER_PROFILE_TYPE
    && text(profile?.shopId) === normalizedShopId
    && text(profile?.tokenStatus) === 'Cookie 已保存'
    && (
      text(profile?.configStatus) === '连接成功'
      || (
        text(profile?.configStatus) === '等待 API 核对'
        && text(profile?.identityStatus) === 'browser-matched'
        && Boolean(text(profile?.identityVerifiedAt))
        && Boolean(text(profile?.browserCompanyId))
        && text(profile?.browserCompanyId).toLowerCase() === text(profile?.apiIdentityId).toLowerCase()
      )
    )
  ));
  return text(exact?.id);
}

function commandState(response = {}) {
  return response?.state?.tabs ? response.state : response?.tabs ? response : {};
}

function selectFollowSellerTabs(state = {}, profileId = '') {
  return (Array.isArray(state?.tabs) ? state.tabs : []).filter((tab) => (
    text(tab?.browserRole) === FOLLOW_SELLER_BROWSER_ROLE
    && (!profileId || text(tab?.accountId) === text(profileId))
  ));
}

export async function toggleActiveFollowSellerVerificationBrowser() {
  const active = activeFollowSellerVerificationBrowser;
  if (!active?.tabId || typeof active.command !== 'function') {
    const error = new Error('当前没有等待人工验证的内置浏览器。');
    error.code = 'FOLLOW_SELLER_VERIFICATION_BROWSER_NOT_RUNNING';
    throw error;
  }
  const currentState = commandState(await active.command({ command: 'state' }));
  const currentTab = (Array.isArray(currentState?.tabs) ? currentState.tabs : [])
    .find((tab) => text(tab?.tabId) === text(active.tabId));
  if (!currentTab) {
    activeFollowSellerVerificationBrowser = null;
    const error = new Error('当前人工验证浏览器已经结束。');
    error.code = 'FOLLOW_SELLER_VERIFICATION_TAB_CLOSED';
    throw error;
  }
  const shouldHide = currentTab.followSellerVerificationVisible === true;
  const response = await active.command(shouldHide
    ? { command: 'hide-follow-seller-verification', tabId: active.tabId }
    : {
        command: 'show-follow-seller-verification',
        tabId: active.tabId,
        url: active.url,
      });
  const nextState = commandState(response);
  const nextTab = (Array.isArray(nextState?.tabs) ? nextState.tabs : [])
    .find((tab) => text(tab?.tabId) === text(active.tabId));
  const visible = nextTab?.followSellerVerificationVisible === true;
  activeFollowSellerVerificationBrowser = { ...active, visible };
  return { ok: true, available: true, visible, tabId: active.tabId };
}

function selectFollowSellerLoginTabs(state = {}, profileId = '') {
  return (Array.isArray(state?.tabs) ? state.tabs : []).filter((tab) => (
    text(tab?.browserRole) === FOLLOW_SELLER_LOGIN_BROWSER_ROLE
    && text(tab?.accountId) === text(profileId)
    && text(tab?.integrationType) === FOLLOW_SELLER_LOGIN_PROFILE_TYPE
  ));
}

async function closeFollowSellerLoginTabs({ command, profileId }) {
  try {
    const state = commandState(await command({ command: 'state' }));
    await Promise.allSettled(selectFollowSellerLoginTabs(state, profileId).map((tab) => command({
      command: 'force-close',
      tabId: text(tab.tabId),
    })));
  } catch {
    // The patrol can still open a fresh hidden context when no login tab exists.
  }
}

async function openFollowSellerTab({ command, profileId, networkMode = 'auto' }) {
  let state = commandState(await command({ command: 'state', browserRole: FOLLOW_SELLER_BROWSER_ROLE }));
  let tab = selectFollowSellerTabs(state, profileId)[0] || null;
  if (!tab?.tabId) {
    const opened = await command({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: text(profileId),
      accountLabel: 'Ozon 前台跟卖巡查',
      platformName: 'Ozon买家',
      url: OZON_FRONT_HOME_URL,
      waitUntil: 'commit',
      restoreVisible: false,
      browserRole: FOLLOW_SELLER_BROWSER_ROLE,
      background: true,
      networkMode,
    });
    state = commandState(opened);
    tab = selectFollowSellerTabs(state, profileId)[0] || null;
  }
  if (!tab?.tabId) {
    const error = new Error('当前没有可用的 Ozon 前台巡查浏览器。');
    error.code = 'PURCHASE_BROWSER_TAB_NOT_FOUND';
    throw error;
  }
  // 跟卖巡查由原生 CEF 另开同 RequestContext 的临时商品页读取公开数据，
  // 不依赖 Seller 后台的数据观察器。这里若等待 observer，会把已经登录且
  // 可正常访问 Ozon 前台的账号误判成“注入失败”。
  return text(tab.tabId);
}

async function openSellerBackendComplaintTab({ command, profileId }) {
  let state = commandState(await command({ command: 'state', browserRole: FOLLOW_SELLER_BROWSER_ROLE }));
  let tab = selectFollowSellerTabs(state, profileId)[0] || null;
  if (!tab?.tabId) {
    const opened = await command({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: text(profileId),
      accountLabel: 'Ozon 卖家后台投诉',
      platformName: 'Ozon',
      url: OZON_SELLER_HOME_URL,
      waitUntil: 'commit',
      restoreVisible: false,
      browserRole: FOLLOW_SELLER_BROWSER_ROLE,
      background: true,
      networkMode: 'direct',
    });
    state = commandState(opened);
    tab = selectFollowSellerTabs(state, profileId)[0] || null;
  }
  if (!tab?.tabId) {
    const error = new Error('当前店铺的 Ozon 卖家后台浏览器启动失败。');
    error.code = 'PURCHASE_BROWSER_TAB_NOT_FOUND';
    throw error;
  }
  return text(tab.tabId);
}

function normalizeQuickComplaintSubmission(submission = {}) {
  const attachments = (Array.isArray(submission?.files) ? submission.files : []).map((item) => ({
    kind: 'current_image',
    name: text(item?.name),
    path: text(item?.path),
    sha256: text(item?.sha256).toLowerCase(),
  }));
  const followerSkus = [...new Set((Array.isArray(submission?.followerSkus) ? submission.followerSkus : [])
    .map(text)
    .filter(Boolean))];
  const followerSource = Array.isArray(submission?.followers) && submission.followers.length
    ? submission.followers
    : Array.isArray(submission?.sellers) && submission.sellers.length
      ? submission.sellers
      : submission?.evidenceFollowers;
  const followersBySku = new Map((Array.isArray(followerSource) ? followerSource : [])
    .map((item) => ({
      sku: text(item?.sku || item?.productSku || item?.product_id || item?.productId),
      productLink: text(item?.productLink || item?.product_link),
    }))
    .filter((item) => item.sku && item.productLink)
    .map((item) => [item.sku, item]));
  const followers = followerSkus.map((sku) => followersBySku.get(sku)).filter(Boolean);
  const validFollowerLinks = followers.every((item) => {
    try {
      const url = new URL(item.productLink);
      const host = url.hostname.toLowerCase();
      return /^\d{5,20}$/u.test(item.sku)
        && url.protocol === 'https:'
        && (host === 'ozon.ru' || host.endsWith('.ozon.ru'))
        && url.toString().includes(item.sku);
    } catch {
      return false;
    }
  });
  const normalized = {
    scheme: text(submission?.scheme),
    caseId: text(submission?.caseId),
    shopId: text(submission?.shopId),
    previewId: text(submission?.previewId),
    evidenceId: text(submission?.evidenceId),
    manifestPath: text(submission?.manifestPath),
    materialDirectory: text(submission?.materialDirectory),
    sourceProductUrl: text(submission?.sourceProductUrl),
    speech: {
      ru: text(submission?.speech?.ru),
      initialEvidenceRu: text(submission?.speech?.initialEvidenceRu),
      supplementRu: text(submission?.speech?.supplementRu),
      followerBatchRu: text(submission?.speech?.followerBatchRu),
      zh: text(submission?.speech?.zh),
    },
    attachments,
    originalSku: text(submission?.originalSku),
    offerId: text(submission?.offerId),
    followerSkus,
    followers,
    evidenceFollowers: (Array.isArray(submission?.evidenceFollowers) ? submission.evidenceFollowers : [])
      .map((item) => ({ sku: text(item?.sku), productLink: text(item?.productLink) }))
      .filter((item) => item.sku && item.productLink),
	continuation: {
	  requested: submission?.continuation?.requested === true,
	  ticketId: text(submission?.continuation?.ticketId),
	  pageUrl: text(submission?.continuation?.pageUrl),
	  phase: text(submission?.continuation?.phase),
	  previousSubmissionStarted: submission?.continuation?.previousSubmissionStarted === true,
	},
	reusePreparedEvidence: submission?.reusePreparedEvidence === true,
  };
	let continuationUrlValid = true;
	if (normalized.continuation.requested) {
	  try {
	    const parsed = new URL(normalized.continuation.pageUrl);
	    continuationUrlValid = parsed.protocol === 'https:'
	      && parsed.hostname.toLowerCase() === 'seller.ozon.ru'
	      && parsed.pathname.startsWith('/app/messenger');
	  } catch {
	    continuationUrlValid = false;
	  }
	}
  if (normalized.scheme !== 'scheme1-seller-backend'
    || !normalized.caseId || !normalized.shopId || !normalized.previewId || !normalized.evidenceId
    || !normalized.manifestPath || !normalized.materialDirectory || !normalized.sourceProductUrl
    || !normalized.speech.initialEvidenceRu || !normalized.speech.supplementRu
    || !normalized.speech.followerBatchRu || !normalized.originalSku || !normalized.offerId || !normalized.followerSkus.length
    || !normalized.evidenceFollowers.length || normalized.followers.length !== normalized.followerSkus.length
    || !validFollowerLinks
	|| (normalized.continuation.requested && (!normalized.continuation.ticketId || !continuationUrlValid))
    || !attachments.length || attachments.length > 6
    || attachments.some((item) => !item.path || !/^[a-f0-9]{64}$/u.test(item.sha256))) {
    const error = new Error('方案1缺少准确的 SKU、商品图、商品链接或俄语话术，已停止后台提交。');
    error.code = 'FOLLOW_SELLER_SCHEME1_SUBMISSION_INVALID';
    throw error;
  }
  return normalized;
}

function normalizeScheme2CaptureRequest(captureRequest = {}) {
  const normalized = {
    caseId: text(captureRequest.caseId),
    shopId: text(captureRequest.shopId),
    previewId: text(captureRequest.previewId),
    evidenceId: text(captureRequest.evidenceId),
    materialDirectory: text(captureRequest.materialDirectory),
    sourceProductUrl: text(captureRequest.sourceProductUrl),
    originalSku: text(captureRequest.originalSku),
    offerId: text(captureRequest.offerId),
    followerSkus: (Array.isArray(captureRequest.followerSkus) ? captureRequest.followerSkus : [])
      .map(text).filter(Boolean),
    evidenceFollowers: (Array.isArray(captureRequest.evidenceFollowers) ? captureRequest.evidenceFollowers : [])
      .map((item) => ({ sku: text(item?.sku), productLink: text(item?.productLink) }))
      .filter((item) => item.sku && item.productLink),
  };
  if (!normalized.caseId || !normalized.shopId || !normalized.previewId || !normalized.evidenceId
    || !normalized.materialDirectory || !normalized.sourceProductUrl || !normalized.originalSku
    || !normalized.offerId || !normalized.followerSkus.length || !normalized.evidenceFollowers.length) {
    const error = new Error('方案2缺少商品页、跟卖页、货号或证据目录，已停止页面证据采集。');
    error.code = 'FOLLOW_SELLER_SCHEME2_CAPTURE_REQUEST_INVALID';
    throw error;
  }
  return normalized;
}

export async function collectFollowSellerScheme2EvidenceInBrowser({ captureRequest = {}, signal } = {}) {
  const normalized = normalizeScheme2CaptureRequest(captureRequest);
  const profileId = await resolveExactSellerProfileId({ shopId: normalized.shopId });
  if (!profileId) {
    const error = new Error('当前店铺没有已保存的 Ozon 卖家网页登录，无法读取真实上架日期。');
    error.code = 'OZON_SELLER_BROWSER_PROFILE_REQUIRED';
    throw error;
  }
  const browserCommand = getOzonBrowserCommand();
  let tabId = '';
  try {
    tabId = await openSellerBackendComplaintTab({ command: browserCommand, profileId });
    if (signal?.aborted) throw new DOMException('方案2页面证据采集已停止', 'AbortError');
    const response = await browserCommand({
      command: 'ozon-prepare-follow-seller-scheme2-evidence',
      tabId,
      ...normalized,
      signal,
    });
    const result = responseResult(response);
    if (result?.ok !== true
      || !text(result?.listingDate)
      || !text(result?.ownProductPage?.path)
      || !text(result?.ownSellerList?.path)
      || !Array.isArray(result?.followerProductPages)
      || result.followerProductPages.length !== normalized.evidenceFollowers.length) {
      const error = new Error('方案2没有取得完整的我方页面、后台列表、上架日期和跟卖页面截图。');
      error.code = 'FOLLOW_SELLER_SCHEME2_CAPTURE_INCOMPLETE';
      throw error;
    }
    return result;
  } finally {
    await closeFollowSellerTabs({ command: browserCommand, profileId, knownTabId: tabId });
  }
}

export async function submitFollowSellerQuickBatchInBrowser({
  submissions = [],
  shopId = '',
  signal,
  onProgress,
} = {}) {
  const normalized = (Array.isArray(submissions) ? submissions : []).map((item) => normalizeQuickComplaintSubmission(item));
  if (!normalized.length) return { ok: true, results: [] };
  if (normalized.some((item) => item.shopId !== text(shopId))) {
    const error = new Error('方案1批次中出现了其他店铺的数据，已停止提交。');
    error.code = 'FOLLOW_SELLER_SCHEME1_SHOP_MISMATCH';
    throw error;
  }
  const notify = (entry = {}) => onProgress?.({
    ...entry,
    at: text(entry.at) || new Date().toISOString(),
  });
  notify({ stage: 'resolve-login', message: '正在读取当前店铺保存的 Ozon 卖家网页登录' });
  const profileId = await resolveExactSellerProfileId({ shopId });
  if (!profileId) {
    const error = new Error('当前店铺没有已保存的 Ozon 卖家网页登录，请先在店铺管理中登录。');
    error.code = 'OZON_SELLER_BROWSER_PROFILE_REQUIRED';
    throw error;
  }
  const browserCommand = getOzonBrowserCommand();
  let tabId = '';
  const results = [];
  let canceled = false;
  const progressItems = normalized.map((item) => ({
    ...item,
    progressToken: nextFollowSellerScheme1ProgressToken(),
  }));
  const progressByToken = new Map(progressItems.map((item) => [item.progressToken, item]));
  const browserOnEvent = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.onEvent;
  const unsubscribeProgress = typeof browserOnEvent === 'function'
    ? browserOnEvent((payload = {}) => {
        if (payload.event !== 'follow-seller-scheme1-progress') return;
        const item = progressByToken.get(text(payload.progressToken));
        if (!item || (tabId && text(payload.tabId) !== text(tabId))) return;
        notify({
          stage: text(payload.stage) || 'browser-working',
          status: text(payload.status) || 'running',
          message: text(payload.message),
          code: text(payload.code),
          caseId: item.caseId,
          offerId: item.offerId,
          originalSku: item.originalSku,
          at: text(payload.at),
        });
      })
    : null;
  const closeOnAbort = () => {
    if (!tabId) return;
    void browserCommand({ command: 'force-close', tabId }).catch(() => undefined);
  };
  try {
    notify({ stage: 'open-browser', message: '正在打开方案1专用的 Ozon 客服浏览器' });
    tabId = await openSellerBackendComplaintTab({ command: browserCommand, profileId });
	signal?.addEventListener('abort', closeOnAbort, { once: true });
	if (signal?.aborted) {
	  closeOnAbort();
	  canceled = true;
	}
	const browserPresentation = { command: browserCommand, tabId };
	activeFollowSellerQuickBrowser = browserPresentation;
    notify({ stage: 'browser-ready', message: 'Ozon 客服浏览器已经打开，开始逐个商品提交' });
    submissionLoop: for (const item of progressItems) {
      if (signal?.aborted) {
        canceled = true;
        break;
      }
      notify({
        stage: 'case-start',
        message: `开始处理货号 ${item.offerId}`,
        caseId: item.caseId,
        offerId: item.offerId,
        originalSku: item.originalSku,
      });
      let result = null;
	  let firstFailure = null;
	  let retryContinuation = item.continuation;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (signal?.aborted) {
          canceled = true;
          break submissionLoop;
        }
        try {
          const response = await waitForCancelableBrowserCommand(browserCommand({
            command: 'ozon-submit-follow-seller-quick-complaint',
            tabId,
            progressToken: item.progressToken,
            attachments: item.attachments,
            evidenceId: item.evidenceId,
            evidencePath: item.manifestPath,
            materialDirectory: item.materialDirectory,
            sourceProductUrl: item.sourceProductUrl,
            originalSku: item.originalSku,
            offerId: item.offerId,
            followerSkus: item.followerSkus,
            followers: item.followers,
            evidenceFollowers: item.evidenceFollowers,
            speech: item.speech,
		    reusePreparedEvidence: item.reusePreparedEvidence || attempt > 0 || retryContinuation.requested,
		    resumeExisting: retryContinuation.requested,
		    resumeTicketId: retryContinuation.ticketId,
		    resumePageUrl: retryContinuation.pageUrl,
		    resumePhase: retryContinuation.phase,
          }), signal, '方案1后台提交已停止');
          result = responseResult(response);
        } catch (failure) {
          if (signal?.aborted || failure?.name === 'AbortError') {
            canceled = true;
            break submissionLoop;
          }
          result = quickComplaintFailureResult(failure);
        }
        if (attempt === 0 && shouldRetryQuickComplaint(result)) {
		  firstFailure = result;
		  retryContinuation = trustedQuickComplaintContinuation(result, retryContinuation);
          notify({
            stage: 'case-recovering',
            status: 'warning',
            message: `货号 ${item.offerId} 尚未开始发送，检测到本地通信、Ozon 登录跳转或页面临时加载失败，正在自动恢复后重试`,
            code: text(result?.error?.code || result?.code),
            caseId: item.caseId,
            offerId: item.offerId,
            originalSku: item.originalSku,
          });
          try {
            await waitForScheme1Recovery(signal);
          } catch (failure) {
            if (signal?.aborted || failure?.name === 'AbortError') {
              canceled = true;
              break submissionLoop;
            }
            throw failure;
          }
          if (signal?.aborted) {
            canceled = true;
            break submissionLoop;
          }
          continue;
        }
        break;
      }
	  if (firstFailure && result?.ok !== true) {
		result = preserveQuickComplaintFirstFailure(firstFailure, result);
	  }
      const finalResult = result || quickComplaintFailureResult();
      results.push({ caseId: item.caseId, previewId: item.previewId, result: finalResult });
      notify({
        stage: finalResult?.ok === true ? 'case-submitted' : 'case-failed',
        status: finalResult?.ok === true ? 'completed' : 'failed',
        message: finalResult?.ok === true
          ? `货号 ${item.offerId} 已取得 Ozon 工单回执`
          : `货号 ${item.offerId} 没有提交完成，材料已保留`,
        code: text(finalResult?.error?.code || finalResult?.code),
        caseId: item.caseId,
        offerId: item.offerId,
        originalSku: item.originalSku,
      });
    }
    return {
      ok: canceled !== true && results.length === normalized.length && results.every((item) => item.result?.ok === true),
      canceled,
      profileId,
      results,
    };
  } finally {
	signal?.removeEventListener('abort', closeOnAbort);
	if (activeFollowSellerQuickBrowser?.command === browserCommand
	  && activeFollowSellerQuickBrowser?.tabId === tabId) {
	  activeFollowSellerQuickBrowser = null;
	}
    await closeFollowSellerTabs({ command: browserCommand, profileId, knownTabId: tabId });
    notify({ stage: 'browser-closed', message: '方案1专用浏览器已经关闭' });
    unsubscribeProgress?.();
  }
}

export async function showActiveFollowSellerQuickBrowser() {
	const active = activeFollowSellerQuickBrowser;
	if (!active?.tabId || typeof active.command !== 'function') {
		const error = new Error('当前没有正在运行的方案1内置浏览器，请在方案1执行期间点击。');
		error.code = 'FOLLOW_SELLER_SCHEME1_BROWSER_NOT_RUNNING';
		throw error;
	}
	await active.command({
		command: 'show-follow-seller-quick-browser',
		tabId: active.tabId,
	});
	return { ok: true, tabId: active.tabId };
}

async function closeFollowSellerTabs({ command, profileId, knownTabId = '' }) {
  const tabIds = new Set();
  if (knownTabId) tabIds.add(text(knownTabId));
  try {
    const state = commandState(await command({ command: 'state', browserRole: FOLLOW_SELLER_BROWSER_ROLE }));
    for (const tab of selectFollowSellerTabs(state, profileId)) {
      if (tab?.tabId) tabIds.add(text(tab.tabId));
    }
  } catch {
    // A failed state read must not skip closing a tab whose id is already known.
  }
  await Promise.allSettled([...tabIds].filter(Boolean).map((tabId) => command({
    command: 'force-close',
    tabId,
  })));
}

function normalizeComplaintSubmission(submission = {}) {
  const files = Array.isArray(submission?.files) ? submission.files : [];
  const attachments = files.map((item) => ({
    kind: text(item?.kind).toLowerCase(),
    name: text(item?.name),
    path: text(item?.path),
    sha256: text(item?.sha256).toLowerCase(),
  }));
  const supplementFiles = (Array.isArray(submission?.supplementFiles) ? submission.supplementFiles : [])
    .map((item) => ({
      kind: 'supplement_image',
      name: text(item?.name),
      path: text(item?.path),
      sha256: text(item?.sha256).toLowerCase(),
    }));
  const workflowSpeech = submission?.speech && typeof submission.speech === 'object'
    ? {
      ru: text(submission.speech.ru || submission.speech.initialEvidenceRu),
      initialEvidenceRu: text(submission.speech.initialEvidenceRu || submission.speech.ru),
      supplementRu: text(submission.speech.supplementRu),
      followerBatchRu: text(submission.speech.followerBatchRu),
    }
    : { ru: text(submission.speech), initialEvidenceRu: text(submission.speech), supplementRu: '', followerBatchRu: '' };
  const followerSkus = (Array.isArray(submission?.followerSkus) ? submission.followerSkus : []).map(text).filter(Boolean);
  const listingDate = text(submission?.listingDate);
  if (!text(submission.caseId)
    || !text(submission.previewId)
    || !text(submission.evidenceId)
    || !text(submission.manifestPath)
    || !text(submission.materialDirectory)
    || !text(submission.originalSku)
    || !text(submission.offerId)
    || !listingDate
    || !workflowSpeech.initialEvidenceRu
    || !workflowSpeech.supplementRu
    || !workflowSpeech.followerBatchRu
    || !followerSkus.length
    || attachments.length !== 2
    || attachments.some((item) => !['psd', 'pdf'].includes(item.kind)
      || !item.path
      || !/^[a-f0-9]{64}$/u.test(item.sha256))
    || new Set(attachments.map((item) => item.kind)).size !== 2
    || supplementFiles.length !== 1
    || supplementFiles.some((item) => !item.path || !/^[a-f0-9]{64}$/u.test(item.sha256))) {
    const error = new Error('方案2缺少完整的PSD、PDF、补证截图、分阶段话术或SKU。');
    error.code = 'FOLLOW_SELLER_COMPLAINT_SUBMISSION_INVALID';
    throw error;
  }
  return {
    caseId: text(submission.caseId),
    previewId: text(submission.previewId),
    evidenceId: text(submission.evidenceId),
    manifestPath: text(submission.manifestPath),
    materialDirectory: text(submission.materialDirectory),
    originalSku: text(submission.originalSku),
    offerId: text(submission.offerId),
    listingDate,
    followerSkus,
    speech: workflowSpeech,
    attachments,
    supplementFiles,
  };
}

/**
 * Uses the same dedicated hidden front-site browser role as patrol, but starts
 * it only for this complaint and always force-closes it afterwards.  The
 * native host re-hashes both files, uploads PSD+PDF, takes before/after
 * screenshots and only reports success after reading an explicit receipt id.
 */
export async function submitFollowSellerComplaintInBrowser({
  submission = {},
  profileId = '',
  signal,
} = {}) {
  const normalized = normalizeComplaintSubmission(submission);
  const browserCommand = getOzonBrowserCommand();
  const resolvedProfileId = await resolveBrowserProfileId({ profileId });
  if (!resolvedProfileId) {
    const error = new Error('没有可用的 Ozon 前台巡查账号，自动投诉已暂停。');
    error.code = 'OZON_BROWSER_PROFILE_REQUIRED';
    throw error;
  }
  let tabId = '';
  try {
    tabId = await openFollowSellerTab({ command: browserCommand, profileId: resolvedProfileId });
    if (signal?.aborted) throw new DOMException('自动投诉已停止', 'AbortError');
    const response = await browserCommand({
      command: 'ozon-submit-follow-seller-complaint',
      tabId,
      attachments: normalized.attachments,
      supplementAttachments: normalized.supplementFiles,
      evidenceId: normalized.evidenceId,
      evidencePath: normalized.manifestPath,
      materialDirectory: normalized.materialDirectory,
      originalSku: normalized.originalSku,
      offerId: normalized.offerId,
      listingDate: normalized.listingDate,
      followerSkus: normalized.followerSkus,
      speech: normalized.speech,
      signal,
    });
    const result = responseResult(response);
    if (result?.ok !== true || !text(result?.ticketId || result?.messageId || result?.chatId)) {
      const error = new Error('Ozon 没有返回明确的投诉回执编号，已按失败保留证据包。');
      error.code = 'FOLLOW_SELLER_COMPLAINT_RECEIPT_REQUIRED';
      throw error;
    }
    return result;
  } finally {
    await closeFollowSellerTabs({
      command: browserCommand,
      profileId: resolvedProfileId,
      knownTabId: tabId,
    });
  }
}

/**
 * Opens a dedicated hidden CEF session on demand. Before route selection it
 * closes only this patrol profile's interactive login tab, which flushes the
 * persisted Cookie store and lets the hidden context really switch between
 * system and direct networking. Other browser roles are never touched.
 */
export async function captureFollowSellersForTargets({
  targets = [],
  profileId = '',
  concurrency = DEFAULT_CAPTURE_CONCURRENCY,
  cooldownDelaysMs = CAPTURE_COOLDOWN_DELAYS_MS,
  interBatchDelayMs = CAPTURE_INTER_BATCH_DELAY_MS,
  periodicCooldownEvery = CAPTURE_PERIODIC_COOLDOWN_EVERY,
  periodicCooldownMs = CAPTURE_PERIODIC_COOLDOWN_MS,
  manualVerificationPollMs = MANUAL_VERIFICATION_POLL_MS,
  manualVerificationTimeoutMs = MANUAL_VERIFICATION_TIMEOUT_MS,
  onProgress,
  onResult,
  onBatch,
  onRecovery,
  onBrowserState,
  signal,
} = {}) {
  const normalizedTargets = [...new Map((Array.isArray(targets) ? targets : [])
    .map((item) => ({
      ...item,
      sku: text(item?.sku),
    }))
    .filter((item) => /^\d{5,20}$/u.test(item.sku))
    .map((item) => [item.sku, item])).values()];
  if (!normalizedTargets.length) return { ok: true, results: [], failed: 0 };

  const browserCommand = getOzonBrowserCommand();
  const resolvedProfileId = await resolveBrowserProfileId({ profileId });
  if (!resolvedProfileId) {
    const error = new Error('没有可用的 Ozon 前台巡查账号，请先新增并保存登录。该账号可供全部店铺共享。');
    error.code = 'OZON_BROWSER_PROFILE_REQUIRED';
    throw error;
  }
  let tabId = '';
  let recovered = false;
  let networkFallbackUsed = false;
  let cooldownAttempt = 0;
  let activeNetworkMode = 'auto';
  let activeBatchSize = CAPTURE_BATCH_SIZE;
  let activeConcurrency = Math.max(1, Math.min(8, Number(concurrency) || DEFAULT_CAPTURE_CONCURRENCY));
  let stableRecoveryBatches = 0;
  let manualVerificationPresented = false;
  let captureCompleted = false;
  const cooldowns = (Array.isArray(cooldownDelaysMs) ? cooldownDelaysMs : CAPTURE_COOLDOWN_DELAYS_MS)
    .map((item) => Math.max(0, Number(item) || 0));
  const manualVerificationAttemptLimit = Math.max(1, cooldowns.length);
  const batchDelay = Math.max(0, Number(interBatchDelayMs) || 0);
  const periodicEvery = Math.max(1, Number(periodicCooldownEvery) || CAPTURE_PERIODIC_COOLDOWN_EVERY);
  const periodicDelay = Math.max(0, Number(periodicCooldownMs) || 0);
  let abortClosePromise = null;
  const closeOnAbort = () => {
    abortClosePromise ||= closeFollowSellerTabs({
      command: browserCommand,
      profileId: resolvedProfileId,
      knownTabId: tabId,
    });
  };
  try {
    await closeFollowSellerLoginTabs({ command: browserCommand, profileId: resolvedProfileId });
    const reopen = async (networkMode = activeNetworkMode) => {
      await closeFollowSellerTabs({ command: browserCommand, profileId: resolvedProfileId, knownTabId: tabId });
      activeNetworkMode = networkMode;
      tabId = await openFollowSellerTab({
        command: browserCommand,
        profileId: resolvedProfileId,
        networkMode,
      });
      return tabId;
    };
    const recoverNetwork = async ({
      results: failureResults = [],
      error: sourceError = null,
      verificationUrl = OZON_FRONT_HOME_URL,
    } = {}) => {
      const riskControl = failureResults.some(isRiskControlResult) || isRiskControlError(sourceError);
      stableRecoveryBatches = 0;
      activeBatchSize = riskControl || networkFallbackUsed
        ? CAPTURE_RATE_LIMIT_BATCH_SIZE
        : CAPTURE_RECOVERY_BATCH_SIZE;
      activeConcurrency = riskControl || networkFallbackUsed ? 2 : Math.min(4, activeConcurrency);
      const toggledNetworkMode = activeNetworkMode === 'direct' ? 'auto' : 'direct';
      if (riskControl) {
        if (cooldownAttempt >= manualVerificationAttemptLimit) {
          throw networkRouteError(failureResults, sourceError);
        }
        cooldownAttempt += 1;
        networkFallbackUsed = true;
        await waitForManualFollowSellerVerification({
          command: browserCommand,
          tabId,
          verificationUrl,
          attempt: cooldownAttempt,
          onRecovery,
          onBrowserState: (state = {}) => {
            if (state.available === true) manualVerificationPresented = true;
            onBrowserState?.(state);
          },
          signal,
          pollMs: manualVerificationPollMs,
          timeoutMs: manualVerificationTimeoutMs,
        });
        return;
      }
      const nextNetworkMode = toggledNetworkMode;
      if (!networkFallbackUsed) {
        networkFallbackUsed = true;
        await reopen(nextNetworkMode);
        return;
      }
      if (cooldownAttempt >= cooldowns.length) {
        throw networkRouteError(failureResults, sourceError);
      }
      const delayMs = cooldowns[cooldownAttempt];
      cooldownAttempt += 1;
      onRecovery?.({
        attempt: cooldownAttempt,
        delayMs,
        networkMode: nextNetworkMode,
        status: failureResults.map((item) => Number(item?.status) || 0).find(Boolean) || 0,
        reason: 'network',
      });
      await waitForCaptureCooldown(delayMs, signal);
      await reopen(nextNetworkMode);
    };
    try {
      tabId = await openFollowSellerTab({
        command: browserCommand,
        profileId: resolvedProfileId,
        networkMode: activeNetworkMode,
      });
    } catch (error) {
      if (!isOzonBrowserSessionStaleError(error)) throw error;
      recovered = true;
      await reopen();
    }
    if (signal?.aborted) throw new DOMException('巡查已停止', 'AbortError');
    signal?.addEventListener('abort', closeOnAbort, { once: true });
    const results = [];
    let failed = 0;
    let offset = 0;
    let preflightPending = true;
    let activeStream = null;
    const browserOnEvent = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.onEvent;
    const unsubscribeProgress = typeof browserOnEvent === 'function'
      ? browserOnEvent((payload = {}) => {
          if (payload.event !== 'follow-seller-result'
            || text(payload.tabId) !== text(tabId)
            || text(payload.captureToken) !== text(activeStream?.captureToken)) return;
          const result = normalizeCaptureResult(payload.result || {});
          if (!result.sku || isNetworkCaptureResult(result) || activeStream.seen.has(result.sku)) return;
          activeStream.seen.add(result.sku);
          if (!result.confirmed) activeStream.failed += 1;
          const target = activeStream.targetsBySku.get(result.sku) || { sku: result.sku };
          onResult?.({
            result,
            target,
            done: Math.min(normalizedTargets.length, activeStream.offset + activeStream.seen.size),
            total: normalizedTargets.length,
            failed: failed + activeStream.failed,
          });
          onProgress?.({
            done: Math.min(normalizedTargets.length, activeStream.offset + activeStream.seen.size),
            total: normalizedTargets.length,
            failed: failed + activeStream.failed,
          });
        })
      : null;
    try {
      while (offset < normalizedTargets.length) {
      if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      const batchSize = preflightPending ? 1 : activeBatchSize;
      const batch = normalizedTargets.slice(offset, offset + batchSize);
      const verificationUrl = `https://www.ozon.ru/product/product-${batch[0].sku}/`;
      const requestBatch = () => {
        const captureToken = nextFollowSellerCaptureToken();
        activeStream = {
          captureToken,
          offset,
          seen: new Set(),
          failed: 0,
          targetsBySku: new Map(batch.map((item) => [item.sku, item])),
        };
        return browserCommand({
          command: 'ozon-data-follow-sellers',
          tabId,
          skus: batch.map((item) => item.sku),
          concurrency: preflightPending ? 1 : activeConcurrency,
          includeProductFacts: false,
          captureToken,
        });
      };
      let response;
      let batchResults;
      while (true) {
        try {
          response = responseResult(await requestBatch());
        } catch (error) {
          if (!recovered && isOzonBrowserSessionStaleError(error)) {
            recovered = true;
            await reopen();
            continue;
          }
          if (isNetworkCaptureError(error)) {
            await recoverNetwork({ error, verificationUrl });
            continue;
          }
          throw error;
        }
        batchResults = (Array.isArray(response?.results) ? response.results : [])
          .map(normalizeCaptureResult);
        if (!batchResults.some(isNetworkCaptureResult)
          && !isWholeBatchNetworkFailure(response, batchResults, batch.length)) break;
        activeStream = null;
        await recoverNetwork({ results: batchResults, verificationUrl });
      }
      networkFallbackUsed = false;
      cooldownAttempt = 0;
      preflightPending = false;
      if (activeBatchSize < CAPTURE_BATCH_SIZE) {
        stableRecoveryBatches += 1;
        if (stableRecoveryBatches >= 2) {
          activeBatchSize = activeBatchSize < CAPTURE_RECOVERY_BATCH_SIZE
            ? CAPTURE_RECOVERY_BATCH_SIZE
            : activeBatchSize < 40
              ? 40
              : CAPTURE_BATCH_SIZE;
          activeConcurrency = activeBatchSize >= 40
            ? DEFAULT_CAPTURE_CONCURRENCY
            : Math.min(4, DEFAULT_CAPTURE_CONCURRENCY);
          stableRecoveryBatches = 0;
        }
      }
      for (const result of batchResults) {
        if (activeStream?.seen.has(result.sku)) continue;
        activeStream?.seen.add(result.sku);
        if (!result.confirmed && activeStream) activeStream.failed += 1;
        await onResult?.({
          result,
          target: activeStream?.targetsBySku.get(result.sku) || { sku: result.sku },
          done: Math.min(normalizedTargets.length, offset + (activeStream?.seen.size || 0)),
          total: normalizedTargets.length,
          failed: failed + (activeStream?.failed || 0),
        });
      }
      results.push(...batchResults);
      failed += Math.max(0, Number(response?.failed) || batch.length - batchResults.length);
      offset += batch.length;
      const batchProgress = {
        done: Math.min(normalizedTargets.length, offset),
        total: normalizedTargets.length,
        failed,
      };
      await onBatch?.({
        ...batchProgress,
        results: batchResults,
        batchTargets: batch,
      });
      onProgress?.(batchProgress);
      if (offset < normalizedTargets.length) {
        const crossedPeriodicBoundary = Math.floor(offset / periodicEvery)
          > Math.floor((offset - batch.length) / periodicEvery);
        await waitForCaptureCooldown(
          crossedPeriodicBoundary ? periodicDelay : batchDelay,
          signal,
        );
      }
      }
    } finally {
      unsubscribeProgress?.();
      activeStream = null;
    }
    captureCompleted = true;
    return { ok: true, results, failed };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      const canceled = new Error('巡查已停止');
      canceled.name = 'AbortError';
      canceled.code = 'FOLLOW_SELLER_CAPTURE_CANCELLED';
      throw canceled;
    }
    const wrapped = new Error(getOzonBrowserCaptureErrorMessage(error));
    wrapped.code = text(error?.code || error?.message) || 'FOLLOW_SELLER_CAPTURE_FAILED';
    throw wrapped;
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    await abortClosePromise?.catch(() => undefined);
    const shouldCloseBrowser = captureCompleted || signal?.aborted || !manualVerificationPresented;
    if (shouldCloseBrowser) {
      await closeFollowSellerTabs({
        command: browserCommand,
        profileId: resolvedProfileId,
        knownTabId: tabId,
      });
      if (activeFollowSellerVerificationBrowser?.tabId === text(tabId)) {
        activeFollowSellerVerificationBrowser = null;
      }
      onBrowserState?.({ available: false, visible: false, tabId: text(tabId) });
    }
  }
}

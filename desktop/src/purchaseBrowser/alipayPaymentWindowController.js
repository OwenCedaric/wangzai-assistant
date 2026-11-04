import { createHash } from 'node:crypto';

const ALIPAY_PAGE_STATE_CHANNEL = 'wangzai:alipay-page-state';
const ALIPAY_PAYMENT_CREDENTIAL_CHANNEL = 'wangzai:alipay-payment-credential';
const PAYMENT_WINDOW_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const PAYMENT_WINDOW_WIDTH_DIP = 520;
const PAYMENT_WINDOW_HEIGHT_DIP = 800;
// The operator's 1998x1265 reference screenshot was captured on this
// machine at 150% Windows scaling. Electron BrowserWindow bounds use DIP,
// so the matching size is 1332x843 rather than the raw physical pixels.
const LARGE_MARKETPLACE_PAYMENT_WINDOW_WIDTH_DIP = 1332;
const LARGE_MARKETPLACE_PAYMENT_WINDOW_HEIGHT_DIP = 843;
const LARGE_MARKETPLACE_PAYMENT_PLATFORMS = new Set(['淘宝', '1688']);
const SHARED_ALIPAY_LOGIN_WINDOW_WIDTH_DIP = 1000;
const SHARED_ALIPAY_LOGIN_WINDOW_HEIGHT_DIP = 800;
const SHARED_ALIPAY_LOGIN_OWNER_REF = 'shared:alipay-login';
const SHARED_ALIPAY_LOGIN_SOURCE_TAB_ID = 'shared-alipay-login';
const ALIPAY_PAYMENT_EVENTS = new Set([
  'alipay-payment-opened',
  'alipay-payment-stage',
  'alipay-payment-verifying',
  'alipay-payment-pending',
  'alipay-payment-paused',
  'alipay-payment-verified',
  'alipay-payment-closed',
  'alipay-payment-error',
]);

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function requiredText(value, code, maxLength = 500) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return text;
}

function sanitizedErrorCode(error) {
  const code = String(error?.code || error?.message || 'ALIPAY_PAYMENT_WINDOW_FAILED');
  return /^ALIPAY_[A-Z0-9_]+$/u.test(code) ? code : 'ALIPAY_PAYMENT_WINDOW_FAILED';
}

export function isTrustedAlipayNavigation(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:'
      && (hostname === 'alipay.com' || hostname.endsWith('.alipay.com'));
  } catch {
    return false;
  }
}

export function isAlipayH5PaymentUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'mclient.alipay.com'
      && /^\/h5pay(?:\/|$)/iu.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isAlipayPaymentUrl(value = '') {
  if (!isTrustedAlipayNavigation(value)) return false;
  try {
    const parsed = new URL(String(value || '').trim());
    return /^\/(?:h5pay|business|trade|preprocess)(?:\/|$)/iu.test(parsed.pathname)
      || /(?:cashier|pay|trade)/iu.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isAlipayLoginUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:'
      && (hostname === 'auth.alipay.com' || hostname === 'login.alipay.com');
  } catch {
    return false;
  }
}

export function isPinduoduoPaymentBootstrapUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'mobile.yangkeduo.com'
      && parsed.pathname === '/orders.html'
      && parsed.searchParams.get('type') === '1';
  } catch {
    return false;
  }
}

export function paymentPlatformFromBootstrapUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (isPinduoduoPaymentBootstrapUrl(parsed.toString())) return '拼多多';
    if (
      (hostname === 'buyertrade.taobao.com' || hostname === 'trade.taobao.com')
      && /\/(?:trade\/)?(?:itemlist\/)?list_bought_items\.htm|trade_order_detail\.htm/iu.test(pathname)
    ) return '淘宝';
    if (
      (hostname === 'air.1688.com' || hostname === 'trade.1688.com')
      && /(?:buyer-order-list|buyer_order_list)\.htm/iu.test(pathname)
    ) return '1688';
  } catch { /* invalid URL */ }
  return '';
}

export function isMarketplacePaymentBootstrapUrl(value = '') {
  return Boolean(paymentPlatformFromBootstrapUrl(value));
}

function marketplaceLoginCookieUrls(platform = '') {
  if (platform === '拼多多') return ['https://mobile.yangkeduo.com/'];
  if (platform === '淘宝' || platform === '天猫') {
    return ['https://buyertrade.taobao.com/', 'https://trade.taobao.com/', 'https://www.taobao.com/', 'https://www.tmall.com/'];
  }
  if (platform === '1688') return ['https://air.1688.com/', 'https://trade.1688.com/', 'https://www.1688.com/'];
  return [];
}

const ALIPAY_LOGIN_COOKIE_URLS = Object.freeze([
  'https://mclient.alipay.com/',
  'https://auth.alipay.com/',
  'https://tscenter.alipay.com/',
]);

export function hasMarketplaceAuthenticationCookies(platform = '', cookies = []) {
  const names = new Set((Array.isArray(cookies) ? cookies : [])
    .map((cookie) => String(cookie?.name || '').trim().toLowerCase())
    .filter(Boolean));
  const has = (...expected) => expected.some((name) => names.has(name));
  if (platform === '拼多多') return has('pddaccesstoken', 'pdd_access_token', 'pdd_user_id', 'pdd_user_uin', 'pdduid');
  if (platform === '1688') return has('unb', 'tracknick') && has('cookie2', '_tb_token_', '_m_h5_tk', 'sgcookie');
  if (platform === '淘宝' || platform === '天猫') {
    return has('unb', 'tracknick', 'lgc', '_nk_') && has('cookie2', '_tb_token_', '_m_h5_tk', 'sgcookie');
  }
  return false;
}

export function hasAlipayAuthenticationCookies(cookies = []) {
  const names = new Set((Array.isArray(cookies) ? cookies : [])
    .map((cookie) => String(cookie?.name || '').trim().toLowerCase())
    .filter(Boolean));
  return names.has('alipay_wap_cashier_cookie') || names.has('cookietoken');
}

function isExplicitMarketplaceLoginUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return host.startsWith('login.') || host.startsWith('passport.') || host.startsWith('auth.')
      || pathname.includes('/login') || pathname.includes('/signin');
  } catch {
    return false;
  }
}

function isTrustedMarketplaceNavigation(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') return false;
    return hostname === 'yangkeduo.com' || hostname.endsWith('.yangkeduo.com')
      || hostname === 'pinduoduo.com' || hostname.endsWith('.pinduoduo.com')
      || hostname === 'taobao.com' || hostname.endsWith('.taobao.com')
      || hostname === 'tmall.com' || hostname.endsWith('.tmall.com')
      || hostname === 'tb.cn' || hostname.endsWith('.tb.cn')
      || hostname === '1688.com' || hostname.endsWith('.1688.com')
      || hostname === 'alibaba.com' || hostname.endsWith('.alibaba.com');
  } catch {
    return false;
  }
}

function isTrustedPaymentWindowNavigation(value = '') {
  return isTrustedAlipayNavigation(value) || isTrustedMarketplaceNavigation(value);
}

export function alipayPaymentPartition({ userScope, ownerRef } = {}) {
  const scope = requiredText(userScope, 'ALIPAY_USER_SCOPE_REQUIRED', 260);
  const owner = requiredText(ownerRef, 'ALIPAY_OWNER_REF_REQUIRED', 160);
  return `persist:wangzai-alipay-${sha256(`${scope}\u0000${owner}`).slice(0, 40)}`;
}

function normalizePageState(value = {}) {
  const pathname = String(value?.pathname || '').trim().slice(0, 240);
  const stage = String(value?.stage || 'unknown').trim().slice(0, 60) || 'unknown';
  const message = String(value?.message || '').trim().replace(/\s+/gu, ' ').slice(0, 120);
  return Object.freeze({
    pathname,
    stage,
    message,
    candidateSuccess: value?.candidateSuccess === true,
    candidateFailure: value?.candidateFailure === true,
    requiresManualVerification: value?.requiresManualVerification === true,
    transactionNo: String(value?.transactionNo || '').trim().slice(0, 260),
    paymentAccount: String(value?.paymentAccount || '').trim().slice(0, 160),
    paymentAmount: Number.isFinite(Number(value?.paymentAmount)) ? Number(value.paymentAmount) : null,
  });
}

function paymentWindowBounds(screenApi, { platform = '' } = {}) {
  const display = screenApi?.getDisplayNearestPoint?.(screenApi.getCursorScreenPoint?.() || { x: 0, y: 0 })
    || screenApi?.getPrimaryDisplay?.()
    || null;
  const area = display?.workArea || { x: 0, y: 0, width: 1280, height: 800 };
  const useLargeMarketplaceSize = LARGE_MARKETPLACE_PAYMENT_PLATFORMS.has(String(platform || '').trim());
  const sharedAlipayLogin = String(platform || '').trim() === '支付宝';
  const targetWidth = sharedAlipayLogin
    ? SHARED_ALIPAY_LOGIN_WINDOW_WIDTH_DIP
    : useLargeMarketplaceSize ? LARGE_MARKETPLACE_PAYMENT_WINDOW_WIDTH_DIP : PAYMENT_WINDOW_WIDTH_DIP;
  const targetHeight = sharedAlipayLogin
    ? SHARED_ALIPAY_LOGIN_WINDOW_HEIGHT_DIP
    : useLargeMarketplaceSize ? LARGE_MARKETPLACE_PAYMENT_WINDOW_HEIGHT_DIP : PAYMENT_WINDOW_HEIGHT_DIP;
  const width = Math.min(targetWidth, Math.max(480, area.width - (useLargeMarketplaceSize ? 0 : 40)));
  const height = Math.min(targetHeight, Math.max(700, area.height - (useLargeMarketplaceSize ? 0 : 40)));
  return {
    width,
    height,
    x: Math.round(area.x + area.width - width - 32),
    y: Math.round(area.y + Math.max(24, (area.height - height) / 2)),
  };
}

export function createAlipayPaymentWindowController({
  BrowserWindow,
  ipcMain,
  session,
  screen,
  preloadPath,
  getParentWindow = () => null,
  getUserScope = () => 'local-user',
  appendLog = () => undefined,
  onEvent = () => undefined,
  onPaymentCandidate = async () => ({ paymentVerified: false }),
  verificationDelaysMs = [0, 1_200, 2_500, 4_500],
  pendingRetryMs = 3_000,
} = {}) {
  if (
    typeof BrowserWindow !== 'function'
    || typeof ipcMain?.on !== 'function'
    || typeof ipcMain?.removeListener !== 'function'
    || typeof session?.fromPartition !== 'function'
  ) {
    const error = new Error('ALIPAY_PAYMENT_WINDOW_DEPENDENCY_REQUIRED');
    error.code = 'ALIPAY_PAYMENT_WINDOW_DEPENDENCY_REQUIRED';
    throw error;
  }
  const safePreloadPath = requiredText(preloadPath, 'ALIPAY_PRELOAD_PATH_REQUIRED', 1200);
  const records = new Map();
  let disposed = false;

  const onWindowActionMessage = (event, value = {}) => {
    const record = [...records.values()].find((item) => item.window?.webContents === event.sender);
    if (!record) return;
    const action = String(value?.action || '').trim();
    if (action === 'clear-cache-and-close') void purgeOwner(record.ownerRef).catch(() => undefined);
  };

  const onPageStateMessage = (event, value) => {
    const record = [...records.values()].find((item) => item.window?.webContents === event.sender);
    if (record) handlePageState(record, value);
  };
  ipcMain.on(ALIPAY_PAGE_STATE_CHANNEL, onPageStateMessage);
  ipcMain.on('wangzai:alipay-window-action', onWindowActionMessage);

  function publish(event, details = {}) {
    if (!ALIPAY_PAYMENT_EVENTS.has(event)) return;
    try { onEvent({ event, ...details }); } catch { /* UI notification cannot break payment. */ }
  }

  function publicRecord(record) {
    return {
      sourceTabId: record.sourceTabId,
      ownerRef: record.ownerRef,
      platform: record.platform,
      partition: record.partition,
      paymentFingerprint: record.paymentFingerprint,
      stage: record.stage,
      openedAt: record.openedAt,
      verifying: record.verificationInFlight === true,
      verified: record.verified === true,
      closed: record.window?.isDestroyed?.() !== false,
    };
  }

  function snapshot() {
    return {
      ok: true,
      windows: [...records.values()].map(publicRecord),
    };
  }

  function configurePartition(partition) {
    const persistentSession = session.fromPartition(partition);
    persistentSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
    persistentSession.setPermissionCheckHandler?.(() => false);
    return persistentSession;
  }

  async function flushSession(record) {
    await Promise.resolve(record.persistentSession?.flushStorageData?.());
  }

  function clearReverifyTimer(record) {
    if (!record?.reverifyTimer) return;
    clearTimeout(record.reverifyTimer);
    record.reverifyTimer = null;
  }

  function scheduleReverify(record) {
    clearReverifyTimer(record);
    if (
      disposed
      || record.verified
      || record.lastCandidateSuccess !== true
      || record.window?.isDestroyed?.() !== false
    ) return;
    const retryMs = Math.max(500, Number(pendingRetryMs) || 3_000);
    record.nextVerificationAt = Date.now() + retryMs;
    record.reverifyTimer = setTimeout(() => {
      record.reverifyTimer = null;
      if (
        !disposed
        && !record.verified
        && record.lastCandidateSuccess === true
        && record.window?.isDestroyed?.() === false
      ) void verifyCandidate(record);
    }, retryMs);
    record.reverifyTimer.unref?.();
  }

  async function verifyCandidate(record) {
    if (record.verificationInFlight || record.verified || disposed) return;
    clearReverifyTimer(record);
    record.verificationInFlight = true;
    let shouldReverify = false;
    publish('alipay-payment-verifying', {
      sourceTabId: record.sourceTabId,
      stage: record.stage,
    });
    try {
      for (const rawDelay of verificationDelaysMs) {
        const delayMs = Math.max(0, Number(rawDelay) || 0);
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (disposed || record.window?.isDestroyed?.() !== false) return;
        const result = await onPaymentCandidate({
          sourceTabId: record.sourceTabId,
          ownerRef: record.ownerRef,
          accountId: record.accountId,
          targetHash: record.targetHash,
          paymentFingerprint: record.paymentFingerprint,
        });
        if (result?.paymentVerified === true && result?.readbackVerified === true) {
          record.verified = true;
          record.closeReason = 'verified';
          clearReverifyTimer(record);
          await flushSession(record);
          publish('alipay-payment-verified', {
            sourceTabId: record.sourceTabId,
            stage: record.stage,
            readbackVerified: true,
            transactionNo: record.transactionNo || '',
            paymentAccount: record.paymentAccount || '',
            paymentAmount: record.paymentAmount,
          });
          record.window.close();
          return;
        }
      }
      shouldReverify = true;
      publish('alipay-payment-pending', {
        sourceTabId: record.sourceTabId,
        stage: record.stage,
        readbackVerified: false,
      });
    } catch (error) {
      shouldReverify = true;
      appendLog('desktop-main', `[alipay-payment] verification pending tab=${record.sourceTabId} code=${sanitizedErrorCode(error)}\n`);
      publish('alipay-payment-pending', {
        sourceTabId: record.sourceTabId,
        stage: record.stage,
        readbackVerified: false,
      });
    } finally {
      record.verificationInFlight = false;
      if (shouldReverify) scheduleReverify(record);
    }
  }

  function handlePageState(record, value) {
    if (record.window?.isDestroyed?.() !== false) return;
    const pageState = normalizePageState(value);
    record.stage = pageState.stage;
    if (pageState.transactionNo) record.transactionNo = pageState.transactionNo;
    if (pageState.paymentAccount) record.paymentAccount = pageState.paymentAccount;
    if (pageState.paymentAmount !== null) record.paymentAmount = pageState.paymentAmount;
    record.lastCandidateSuccess = pageState.candidateSuccess;
    if (!pageState.candidateSuccess) clearReverifyTimer(record);
    publish('alipay-payment-stage', {
      sourceTabId: record.sourceTabId,
      stage: pageState.stage,
      candidateFailure: pageState.candidateFailure,
      transactionNo: record.transactionNo || '',
    });
    if (pageState.requiresManualVerification || pageState.candidateFailure) {
      record.stage = 'paused';
      record.lastCandidateSuccess = false;
      clearReverifyTimer(record);
      publish('alipay-payment-paused', {
        sourceTabId: record.sourceTabId,
        stage: pageState.stage,
        message: pageState.message || (pageState.requiresManualVerification ? '需要人工验证' : '支付未完成'),
      });
      return;
    }
    if (
      pageState.candidateSuccess
      && Date.now() >= (record.nextVerificationAt || 0)
    ) void verifyCandidate(record);
  }

  function bindWindow(record) {
    const { window } = record;
    const resizeForUrl = () => {
      if (window.isDestroyed?.() !== false) return;
      window.setBounds?.(paymentWindowBounds(screen, { platform: record.platform }));
    };
    window.webContents.on('did-finish-load', () => {
      resizeForUrl(window.webContents.getURL?.() || '');
      if (!record.paymentCredential) return;
      window.webContents.send?.(ALIPAY_PAYMENT_CREDENTIAL_CHANNEL, {
        loginAccount: record.paymentCredential.loginAccount || '',
        paymentPassword: record.paymentCredential.paymentPassword || '',
        autoSubmit: record.paymentCredential.autoSubmit === true,
        platform: record.platform,
      });
    });
    const guardNavigation = (event, url) => {
      if (!isTrustedPaymentWindowNavigation(url)) event.preventDefault();
      else resizeForUrl(url);
    };
    window.webContents.on('will-navigate', guardNavigation);
    window.webContents.on('will-redirect', guardNavigation);
    window.webContents.setWindowOpenHandler?.(({ url }) => {
      if (isTrustedPaymentWindowNavigation(url)) {
        setTimeout(() => {
          if (window.isDestroyed?.() === false) {
            resizeForUrl(url);
            void navigatePaymentWindow(record, url, { showImmediately: true }).catch(() => undefined);
          }
        }, 0);
      }
      return { action: 'deny' };
    });
    window.on('close', (event) => {
      if (record.closeReason || disposed) return;
      event.preventDefault?.();
      window.hide();
      record.stage = 'hidden';
      if (!record.silent) {
        publish('alipay-payment-closed', {
          sourceTabId: record.sourceTabId,
          stage: record.stage,
          hidden: true,
          readbackVerified: false,
        });
      }
    });
    window.on('closed', () => {
      clearReverifyTimer(record);
      records.delete(record.sourceTabId);
      if (record.closeReason !== 'verified' && !record.silent) {
        publish('alipay-payment-closed', {
          sourceTabId: record.sourceTabId,
          stage: record.stage,
          readbackVerified: false,
        });
      }
    });
  }

  async function navigatePaymentWindow(record, url, { showImmediately = false } = {}) {
    if (record.window?.isDestroyed?.() !== false) return;
    const sequence = (Number(record.navigationSequence) || 0) + 1;
    record.navigationSequence = sequence;
    const navigationPromise = Promise.resolve(record.window.loadURL(url));
    record.navigationPromise = navigationPromise;
    if (showImmediately && record.showWhenReady && !record.window.isVisible?.()) {
      record.window.show();
      record.window.focus();
    }
    try {
      await navigationPromise;
    } finally {
      if (record.navigationSequence === sequence && record.navigationPromise === navigationPromise) {
        record.navigationPromise = null;
      }
    }
  }

  async function open({
    paymentUrl,
    sourceTabId,
    ownerRef,
    accountId = '',
    targetHash = '',
    bootstrapCookies = [],
    allowPinduoduoBootstrap = false,
    allowMarketplaceBootstrap = false,
    platform = '',
    showWindow = true,
    silent = false,
    paymentCredential = null,
  } = {}) {
    if (disposed) {
      const error = new Error('ALIPAY_PAYMENT_WINDOW_DISPOSED');
      error.code = 'ALIPAY_PAYMENT_WINDOW_DISPOSED';
      throw error;
    }
    const url = requiredText(paymentUrl, 'ALIPAY_PAYMENT_URL_REQUIRED', 4000);
    if (
      !isAlipayPaymentUrl(url)
      && !isAlipayLoginUrl(url)
      && !((allowMarketplaceBootstrap === true || allowPinduoduoBootstrap === true)
        && isMarketplacePaymentBootstrapUrl(url))
    ) {
      const error = new Error('ALIPAY_PAYMENT_URL_UNTRUSTED');
      error.code = 'ALIPAY_PAYMENT_URL_UNTRUSTED';
      throw error;
    }
    const tabId = requiredText(sourceTabId, 'ALIPAY_SOURCE_TAB_REQUIRED', 180);
    const safeOwnerRef = requiredText(ownerRef, 'ALIPAY_OWNER_REF_REQUIRED', 160);
    const detectedPlatform = paymentPlatformFromBootstrapUrl(url);
    const safePlatform = String(platform || detectedPlatform || '').trim().slice(0, 40);
    const paymentFingerprint = sha256(url);
    let existing = records.get(tabId);
    if (!existing) {
      existing = [...records.values()].find((record) => (
        record.ownerRef === safeOwnerRef && record.window?.isDestroyed?.() === false
      ));
      if (existing && existing.sourceTabId !== tabId) {
        records.delete(existing.sourceTabId);
        existing.sourceTabId = tabId;
        existing.accountId = String(accountId || existing.accountId || '').trim().slice(0, 160);
        existing.targetHash = String(targetHash || '').trim().slice(0, 64);
        existing.platform = safePlatform || existing.platform;
        records.set(tabId, existing);
      }
    }
    if (existing?.window?.isDestroyed?.() === false) {
      await importCookies(existing.persistentSession, bootstrapCookies);
      existing.showWhenReady = showWindow !== false;
      existing.silent = silent === true;
      existing.platform = safePlatform || existing.platform;
      existing.paymentCredential = normalizePaymentCredential(paymentCredential) || existing.paymentCredential;
      if (existing.paymentCredential) {
        existing.window.webContents.send?.(ALIPAY_PAYMENT_CREDENTIAL_CHANNEL, {
          ...existing.paymentCredential,
          platform: existing.platform,
        });
      }
      if (showWindow !== false) {
        existing.window.setBounds?.(paymentWindowBounds(screen, { platform: existing.platform }));
        existing.window.show();
        existing.window.focus();
      }
      if (existing.paymentFingerprint !== paymentFingerprint) {
        existing.paymentFingerprint = paymentFingerprint;
        existing.stage = 'opening';
        existing.nextVerificationAt = 0;
        existing.lastCandidateSuccess = false;
        clearReverifyTimer(existing);
        await navigatePaymentWindow(existing, url, { showImmediately: showWindow !== false });
      }
      return { ok: true, reused: true, ...publicRecord(existing) };
    }

    const userScope = requiredText(getUserScope(), 'ALIPAY_USER_SCOPE_REQUIRED', 260);
    const partition = alipayPaymentPartition({ userScope, ownerRef: safeOwnerRef });
    const persistentSession = configurePartition(partition);
    await importCookies(persistentSession, bootstrapCookies);
    const parent = getParentWindow?.();
    const bounds = paymentWindowBounds(screen, { platform: safePlatform });
    const window = new BrowserWindow({
      ...bounds,
      ...(parent && !parent.isDestroyed?.() ? { parent } : {}),
      title: safePlatform ? `${safePlatform}支付` : '支付宝付款',
      show: false,
      modal: false,
      resizable: true,
      minimizable: true,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: '#f5f7fb',
      webPreferences: {
        partition,
        preload: safePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    window.webContents.setUserAgent?.(PAYMENT_WINDOW_USER_AGENT);
    window.setMenuBarVisibility?.(false);
    const record = {
      window,
      persistentSession,
      partition,
      sourceTabId: tabId,
      ownerRef: safeOwnerRef,
      platform: safePlatform,
      accountId: String(accountId || '').trim().slice(0, 160),
      targetHash: String(targetHash || '').trim().slice(0, 64),
      paymentFingerprint,
      stage: 'opening',
      openedAt: new Date().toISOString(),
      verificationInFlight: false,
      nextVerificationAt: 0,
      lastCandidateSuccess: false,
      reverifyTimer: null,
      verified: false,
      closeReason: '',
      showWhenReady: showWindow !== false,
      silent: silent === true,
      paymentCredential: normalizePaymentCredential(paymentCredential),
      transactionNo: '',
      paymentAccount: '',
      paymentAmount: null,
      navigationSequence: 0,
      navigationPromise: null,
    };
    records.set(tabId, record);
    bindWindow(record);
    window.once?.('ready-to-show', () => {
      if (record.showWhenReady && window.isDestroyed?.() === false) window.show();
    });
    try {
      // Show the native shell immediately. Remote marketplace pages may take
      // seconds to finish, but that network wait must not look like a dead
      // button to the user.
      await navigatePaymentWindow(record, url, { showImmediately: true });
      if (record.showWhenReady && window.isDestroyed?.() === false && !window.isVisible?.()) window.show();
      if (!record.silent) {
        publish('alipay-payment-opened', { sourceTabId: tabId, stage: 'opening' });
        appendLog('desktop-main', `[alipay-payment] opened tab=${tabId} payment=${paymentFingerprint.slice(0, 12)} partition=${partition.slice(-12)}\n`);
      }
      return { ok: true, reused: false, ...publicRecord(record) };
    } catch (error) {
      record.closeReason = 'load-error';
      records.delete(tabId);
      if (window.isDestroyed?.() === false) window.close();
      publish('alipay-payment-error', {
        sourceTabId: tabId,
        code: sanitizedErrorCode(error),
      });
      throw error;
    }
  }

  async function importCookies(persistentSession, values = []) {
    const rows = Array.isArray(values) ? values : [];
    if (!rows.length) return;
    for (const value of rows) {
      const name = String(value?.name || '').trim();
      const cookieValue = String(value?.value || '');
      if (!name || name.length > 256 || cookieValue.length > 8192) continue;
      const domain = String(value?.domain || 'mobile.yangkeduo.com').trim();
      const normalizedHost = domain.replace(/^\./u, '').toLowerCase();
      if (!normalizedHost || !/^[a-z0-9.-]+$/u.test(normalizedHost)) continue;
      const cookieUrl = `https://${normalizedHost}/`;
      if (!isTrustedPaymentWindowNavigation(cookieUrl)) continue;
      const details = {
        url: cookieUrl,
        name,
        value: cookieValue,
        domain,
        path: String(value?.path || '/').trim() || '/',
        secure: value?.secure !== false,
        httpOnly: value?.httpOnly === true,
      };
      const expirationDate = Number(value?.expirationDate);
      if (Number.isFinite(expirationDate) && expirationDate > Date.now() / 1000) {
        details.expirationDate = expirationDate;
      }
      await persistentSession.cookies?.set?.(details);
    }
    await Promise.resolve(persistentSession.flushStorageData?.());
  }

  async function syncLoginCookies({ sourceTabId = '', ownerRef, cookies = [] } = {}) {
    const safeOwnerRef = requiredText(ownerRef, 'ALIPAY_OWNER_REF_REQUIRED', 160);
    const key = String(sourceTabId || '').trim();
    const record = (key ? records.get(key) : null)
      || [...records.values()].find((item) => (
        item.ownerRef === safeOwnerRef && item.window?.isDestroyed?.() === false
      ))
      || null;
    const userScope = requiredText(getUserScope(), 'ALIPAY_USER_SCOPE_REQUIRED', 260);
    const partition = record?.partition || alipayPaymentPartition({ userScope, ownerRef: safeOwnerRef });
    const persistentSession = record?.persistentSession || configurePartition(partition);
    const rows = Array.isArray(cookies) ? cookies : [];
    await importCookies(persistentSession, rows);
    if (rows.length && record?.window?.isDestroyed?.() === false) {
      // Importing CEF cookies while the first marketplace load is active is
      // safe, but reloading at that exact moment aborts BrowserWindow.loadURL
      // and can tear down the main process. Wait for the tracked navigation,
      // then refresh once only if the same live record still owns the window.
      const navigation = record.navigationPromise;
      if (navigation) await navigation.catch(() => undefined);
      if (
        records.get(record.sourceTabId) === record
        && record.window?.isDestroyed?.() === false
        && !record.navigationPromise
      ) {
        try { record.window.webContents.reload?.(); } catch { /* closing window */ }
      }
    }
    return { ok: true, ownerRef: safeOwnerRef, partition, importedCookieCount: rows.length };
  }

  async function exportLoginCookies({ sourceTabId = '', ownerRef, platform = '' } = {}) {
    const safeOwnerRef = requiredText(ownerRef, 'ALIPAY_OWNER_REF_REQUIRED', 160);
    const safePlatform = String(platform || '').trim().slice(0, 40);
    const marketplaceUrls = marketplaceLoginCookieUrls(safePlatform);
    if (!marketplaceUrls.length) {
      const error = new Error('ALIPAY_PAYMENT_PLATFORM_UNSUPPORTED');
      error.code = 'ALIPAY_PAYMENT_PLATFORM_UNSUPPORTED';
      throw error;
    }
    const urls = [...marketplaceUrls, ...ALIPAY_LOGIN_COOKIE_URLS];
    const userScope = requiredText(getUserScope(), 'ALIPAY_USER_SCOPE_REQUIRED', 260);
    const partition = alipayPaymentPartition({ userScope, ownerRef: safeOwnerRef });
    const persistentSession = configurePartition(partition);
    const values = [];
    for (const url of urls) {
      const rows = await persistentSession.cookies?.get?.({ url });
      if (Array.isArray(rows)) values.push(...rows);
    }
    const unique = [...new Map(values.map((cookie) => [
      `${String(cookie?.domain || '')}\0${String(cookie?.path || '/')}\0${String(cookie?.name || '')}`,
      cookie,
    ])).values()];
    const key = String(sourceTabId || '').trim();
    const record = (key ? records.get(key) : null)
      || [...records.values()].find((item) => item.ownerRef === safeOwnerRef && item.window?.isDestroyed?.() === false)
      || null;
    const currentUrl = String(record?.window?.webContents?.getURL?.() || '').trim();
    return {
      ok: true,
      ownerRef: safeOwnerRef,
      platform: safePlatform,
      partition,
      cookies: unique,
      cookieCount: unique.length,
      windowOpen: Boolean(record),
      currentUrl,
    };
  }

  async function getLoginStatus(input = {}) {
    const exported = await exportLoginCookies(input);
    const marketplaceAuthCookiePresent = hasMarketplaceAuthenticationCookies(exported.platform, exported.cookies);
    const alipayAuthCookiePresent = hasAlipayAuthenticationCookies(exported.cookies);
    const explicitLoginPage = isExplicitMarketplaceLoginUrl(exported.currentUrl);
    const marketplaceLoggedIn = marketplaceAuthCookiePresent
      && !(explicitLoginPage && !String(exported.currentUrl || '').includes('alipay.com'));
    const alipayLoggedIn = alipayAuthCookiePresent
      && !(explicitLoginPage && String(exported.currentUrl || '').includes('alipay.com'));
    const loggedIn = marketplaceLoggedIn && alipayLoggedIn;
    return {
      ok: true,
      ownerRef: exported.ownerRef,
      platform: exported.platform,
      partition: exported.partition,
      loggedIn,
      paymentReady: loggedIn,
      marketplaceLoggedIn,
      alipayLoggedIn,
      cookieSaved: marketplaceAuthCookiePresent && alipayAuthCookiePresent,
      authCookiePresent: marketplaceAuthCookiePresent && alipayAuthCookiePresent,
      marketplaceAuthCookiePresent,
      alipayAuthCookiePresent,
      explicitLoginPage,
      cookieCount: exported.cookieCount,
      windowOpen: exported.windowOpen,
      currentUrl: exported.currentUrl,
      verificationSource: loggedIn
        ? 'electron-marketplace-and-alipay-cookie'
        : explicitLoginPage ? 'electron-login-page'
          : marketplaceLoggedIn ? 'electron-alipay-cookie-missing' : 'electron-marketplace-cookie-missing',
      verifiedAt: new Date().toISOString(),
    };
  }

  function normalizePaymentCredential(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const loginAccount = String(value.loginAccount || '').trim().slice(0, 260);
    const loginPassword = String(value.loginPassword || '').trim().slice(0, 128);
    const paymentPassword = String(value.paymentPassword || '').trim().slice(0, 128);
    if (!loginAccount && !loginPassword && !paymentPassword) return null;
    return { loginAccount, loginPassword, paymentPassword, autoSubmit: value.autoSubmit === true };
  }

  async function exportAlipayCookies(ownerRef) {
    const safeOwnerRef = requiredText(ownerRef, 'ALIPAY_OWNER_REF_REQUIRED', 160);
    const userScope = requiredText(getUserScope(), 'ALIPAY_USER_SCOPE_REQUIRED', 260);
    const partition = alipayPaymentPartition({ userScope, ownerRef: safeOwnerRef });
    const persistentSession = configurePartition(partition);
    const values = [];
    for (const url of ALIPAY_LOGIN_COOKIE_URLS) {
      const rows = await persistentSession.cookies?.get?.({ url });
      if (Array.isArray(rows)) values.push(...rows);
    }
    return [...new Map(values.map((cookie) => [
      `${String(cookie?.domain || '')}\0${String(cookie?.path || '/')}\0${String(cookie?.name || '')}`,
      cookie,
    ])).values()];
  }

  async function openSharedLogin({
    loginAccount = '',
    loginPassword = '',
    purchaseUrl = 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75',
    cookies = [],
  } = {}) {
    return open({
      paymentUrl: purchaseUrl,
      sourceTabId: SHARED_ALIPAY_LOGIN_SOURCE_TAB_ID,
      ownerRef: SHARED_ALIPAY_LOGIN_OWNER_REF,
      accountId: SHARED_ALIPAY_LOGIN_OWNER_REF,
      platform: '支付宝',
      bootstrapCookies: cookies,
      allowMarketplaceBootstrap: true,
      showWindow: true,
      silent: false,
      paymentCredential: { loginAccount, loginPassword, autoSubmit: false },
    });
  }

  async function getSharedLoginStatus() {
    const cookies = await exportAlipayCookies(SHARED_ALIPAY_LOGIN_OWNER_REF);
    const record = records.get(SHARED_ALIPAY_LOGIN_SOURCE_TAB_ID) || null;
    const currentUrl = String(record?.window?.webContents?.getURL?.() || '').trim();
    const explicitLoginPage = isExplicitMarketplaceLoginUrl(currentUrl) && currentUrl.includes('alipay.com');
    const loggedIn = hasAlipayAuthenticationCookies(cookies) && !explicitLoginPage;
    return {
      ok: true,
      loggedIn,
      cookieSaved: hasAlipayAuthenticationCookies(cookies),
      cookieCount: cookies.length,
      windowOpen: Boolean(record && record.window?.isDestroyed?.() === false),
      currentUrl,
      verificationSource: loggedIn ? 'shared-alipay-strong-auth-cookie' : explicitLoginPage ? 'shared-alipay-login-page' : 'shared-alipay-cookie-missing',
      verifiedAt: new Date().toISOString(),
    };
  }

  async function syncSharedLoginToOwners(ownerRefs = []) {
    const cookies = await exportAlipayCookies(SHARED_ALIPAY_LOGIN_OWNER_REF);
    if (!hasAlipayAuthenticationCookies(cookies)) {
      return { ok: true, syncedOwnerCount: 0, cookieCount: cookies.length, loggedIn: false };
    }
    const owners = [...new Set((Array.isArray(ownerRefs) ? ownerRefs : [])
      .map((value) => String(value || '').trim()).filter(Boolean))];
    for (const ownerRef of owners) await syncLoginCookies({ ownerRef, cookies });
    return { ok: true, syncedOwnerCount: owners.length, cookieCount: cookies.length, loggedIn: true };
  }

  async function openLogin({ sourceTabId, ownerRef, accountId = '', platform = '', purchaseUrl, cookies = [], paymentCredential = null } = {}) {
    return open({
      paymentUrl: purchaseUrl || 'https://auth.alipay.com/login',
      sourceTabId,
      ownerRef,
      accountId,
      platform,
      bootstrapCookies: cookies,
      allowMarketplaceBootstrap: Boolean(purchaseUrl),
      showWindow: true,
      silent: false,
      paymentCredential,
    });
  }

  async function prewarmLogin({ sourceTabId, ownerRef, accountId = '', platform = '', purchaseUrl, cookies = [], paymentCredential = null } = {}) {
    return open({
      paymentUrl: purchaseUrl,
      sourceTabId,
      ownerRef,
      accountId,
      platform,
      bootstrapCookies: cookies,
      allowMarketplaceBootstrap: true,
      showWindow: false,
      silent: true,
      paymentCredential,
    });
  }

  function show(sourceTabId = '') {
    const key = String(sourceTabId || '').trim();
    const candidates = key ? [records.get(key)].filter(Boolean) : [...records.values()];
    const record = candidates.find((item) => item.window?.isDestroyed?.() === false);
    if (!record) return { ok: false, shown: false };
    record.window.show();
    record.window.focus();
    return { ok: true, shown: true, ...publicRecord(record) };
  }

  async function purgeOwner(ownerRef) {
    const safeOwnerRef = requiredText(ownerRef, 'ALIPAY_OWNER_REF_REQUIRED', 160);
    const userScope = requiredText(getUserScope(), 'ALIPAY_USER_SCOPE_REQUIRED', 260);
    const partition = alipayPaymentPartition({ userScope, ownerRef: safeOwnerRef });
    for (const record of [...records.values()]) {
      if (record.ownerRef !== safeOwnerRef) continue;
      record.closeReason = 'purged';
      clearReverifyTimer(record);
      if (record.window?.isDestroyed?.() === false) record.window.close();
      records.delete(record.sourceTabId);
    }
    const persistentSession = session.fromPartition(partition);
    await persistentSession.clearStorageData?.();
    await persistentSession.clearCache?.();
    await Promise.resolve(persistentSession.flushStorageData?.());
    return { ok: true, ownerRef: safeOwnerRef, partition, verified: true };
  }

  function dispose() {
    disposed = true;
    ipcMain.removeListener(ALIPAY_PAGE_STATE_CHANNEL, onPageStateMessage);
    ipcMain.removeListener('wangzai:alipay-window-action', onWindowActionMessage);
    for (const record of [...records.values()]) {
      record.closeReason = 'disposed';
      clearReverifyTimer(record);
      if (record.window?.isDestroyed?.() === false) record.window.close();
    }
    records.clear();
  }

  return Object.freeze({
    dispose,
    open,
    openLogin,
    prewarmLogin,
    syncLoginCookies,
    exportLoginCookies,
    getLoginStatus,
    openSharedLogin,
    getSharedLoginStatus,
    syncSharedLoginToOwners,
    purgeOwner,
    show,
    snapshot,
  });
}

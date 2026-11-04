import {
  getPurchaseBrowserAccountTab,
  normalizePurchaseBrowserState,
} from './purchaseBrowserLoginClient.js';

export const OZON_LOGIN_URL = 'https://seller.ozon.ru/app/registration/signin?registration=1&locale=zh-hans';

function createError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getCommand(commandOverride) {
  const command = commandOverride || globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command;
  if (typeof command !== 'function') {
    throw createError('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE', '当前桌面端没有提供内置浏览器。');
  }
  return command;
}

function requireText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw createError(code);
  return text;
}

function abortError() {
  const error = new Error('Ozon login check was cancelled.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export async function openOzonBrowserLogin({ profileId, command: commandOverride } = {}) {
  const accountId = requireText(profileId, 'PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED');
  const command = getCommand(commandOverride);
  const response = await command({
    command: 'open',
    ownerType: 'integration_profile',
    accountId,
    accountLabel: 'Ozon 卖家登录',
    platformName: 'Ozon',
    url: OZON_LOGIN_URL,
  });
  const state = normalizePurchaseBrowserState(response);
  const tab = getPurchaseBrowserAccountTab(state, accountId);
  if (!tab?.tabId) throw createError('PURCHASE_BROWSER_TAB_NOT_FOUND');
  return { state, tab };
}

export async function readOzonBrowserLoginStatus({ tabId, command: commandOverride } = {}) {
  const command = getCommand(commandOverride);
  const response = await command({
    command: 'ozon-login-status',
    tabId: requireText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
  });
  return {
    result: response?.result && typeof response.result === 'object' ? response.result : {},
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

export async function waitForOzonBrowserLogin({
  tabId,
  command,
  signal,
  requireCompanyIdentity = false,
  intervalMs = 1200,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    const status = await readOzonBrowserLoginStatus({ tabId, command });
    if (signal?.aborted) throw abortError();
    const companyId = String(status.result.companyId || status.result.company_id || '').trim();
    if (
      status.result.loggedIn === true
      && status.result.cookieSaved === true
      && (!requireCompanyIdentity || companyId)
    ) return status;
    await wait(Math.max(250, Number(intervalMs) || 1200), signal);
  }
  throw createError('OZON_BROWSER_LOGIN_TIMEOUT', '等待 Ozon 登录超时，请重新打开登录页面。');
}

export async function hideOzonBrowserLogin({ command: commandOverride } = {}) {
  const command = getCommand(commandOverride);
  return command({ command: 'hide' });
}

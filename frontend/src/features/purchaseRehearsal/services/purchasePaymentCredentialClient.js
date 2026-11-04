function desktopPurchaseBrowser() {
  return globalThis.window?.wangzaiDesktop?.purchaseBrowser
    || globalThis.wangzaiDesktop?.purchaseBrowser
    || null;
}

function requireCommand() {
  const command = desktopPurchaseBrowser()?.command;
  if (typeof command !== 'function') {
    const error = new Error('桌面端采购浏览器未连接。');
    error.code = 'PURCHASE_AUTO_ORDER_DESKTOP_REQUIRED';
    throw error;
  }
  return command;
}

export async function savePurchasePaymentCredential({ accountRef, platform, loginAccount, paymentPassword } = {}) {
  return requireCommand()({
    command: 'save-purchase-payment-credential',
    accountRef,
    platform,
    loginAccount,
    paymentPassword,
  });
}

export async function clearPurchasePaymentCredential(accountRef) {
  return requireCommand()({ command: 'clear-purchase-payment-credential', accountRef });
}

export async function clearPurchasePaymentSession(accountRef) {
  return requireCommand()({ command: 'clear-purchase-payment-session', accountRef });
}

export async function getPurchasePaymentCredentialStatus(accountRef) {
  return requireCommand()({ command: 'purchase-payment-credential-status', accountRef });
}

export async function getPurchasePaymentLoginStatus({ accountRef, platform } = {}) {
  return requireCommand()({ command: 'purchase-payment-login-status', accountRef, accountId: accountRef, platform });
}

export async function waitForPurchasePaymentLogin({
  accountRef,
  platform,
  attempts = 40,
  intervalMs = 3000,
  readStatus = getPurchasePaymentLoginStatus,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const maximumAttempts = Math.max(1, Math.min(120, Number(attempts) || 40));
  let last = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    last = await readStatus({ accountRef, platform });
    if (last?.loggedIn === true) return { ...last, attempts: attempt, timedOut: false };
    if (attempt < maximumAttempts) await wait(Math.max(100, Number(intervalMs) || 3000));
  }
  return { ...(last || {}), attempts: maximumAttempts, timedOut: true };
}

export async function openSharedAlipayLogin({ loginAccount, loginPassword = '', purchaseAccountId = '' } = {}) {
  return requireCommand()({ command: 'open-shared-alipay-login', loginAccount, loginPassword, purchaseAccountId });
}

export async function getSharedAlipayLoginStatus() {
  return requireCommand()({ command: 'shared-alipay-login-status' });
}

export async function clearSharedAlipayLogin() {
  return requireCommand()({ command: 'clear-shared-alipay-login' });
}

export async function waitForSharedAlipayLogin({
  attempts = 60,
  intervalMs = 3000,
  readStatus = getSharedAlipayLoginStatus,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const maximumAttempts = Math.max(1, Math.min(120, Number(attempts) || 60));
  let last = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    last = await readStatus();
    if (last?.loggedIn === true) return { ...last, attempts: attempt, timedOut: false };
    if (attempt < maximumAttempts) await wait(Math.max(100, Number(intervalMs) || 3000));
  }
  return { ...(last || {}), attempts: maximumAttempts, timedOut: true };
}

export async function resumePurchaseAutoOrder(tabId) {
  return requireCommand()({ command: 'resume-purchase-auto-order', tabId });
}

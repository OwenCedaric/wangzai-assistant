const { ipcRenderer } = require('electron');

const CHANNEL = 'wangzai:alipay-page-state';
const ACTION_CHANNEL = 'wangzai:alipay-window-action';
const CREDENTIAL_CHANNEL = 'wangzai:alipay-payment-credential';
const STAGES = Object.freeze([
  ['/h5pay/unifiedLogin/', 'login'],
  ['/h5pay/accountLogin/', 'account-login'],
  ['/h5pay/loginSmsVerify/', 'sms-login'],
  ['/h5pay/cashierPreConfirm/', 'pre-confirm'],
  ['/h5pay/pwdValidate/', 'password'],
  ['/h5pay/cashierSafeProtectSms/', 'security-sms'],
  ['/h5pay/cashierSafeProtect/', 'security-check'],
  ['/h5pay/cashierActivity/', 'result'],
  ['/h5pay/needPayQuery/', 'querying'],
  ['/h5pay/landing/', 'landing'],
  ['/h5pay/cashierAccount/', 'account'],
  ['/h5pay/h5RouteAppSenior/', 'route'],
]);

let lastPayload = '';
let paymentCredential = null;
let lastAutomationKey = '';
let typingPassword = false;

ipcRenderer.on(CREDENTIAL_CHANNEL, (_event, value = {}) => {
  paymentCredential = {
    loginAccount: String(value?.loginAccount || '').trim().slice(0, 260),
    loginPassword: String(value?.loginPassword || '').trim().slice(0, 128),
    paymentPassword: String(value?.paymentPassword || '').trim().slice(0, 128),
    autoSubmit: value?.autoSubmit === true,
    platform: String(value?.platform || '').trim().slice(0, 40),
  };
  lastAutomationKey = '';
  updatePlatformShortcut();
  setTimeout(attemptPaymentAutomation, 50);
});

function compactText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, 120);
}

function frameDocuments() {
  const result = [];
  const pending = [document];
  const seen = new Set();
  while (pending.length && result.length < 16) {
    const current = pending.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    result.push(current);
    let frames = [];
    try { frames = [...current.querySelectorAll('iframe,frame')]; } catch { /* inaccessible frame tree */ }
    for (const frame of frames) {
      try {
        const child = frame.contentDocument || frame.contentWindow?.document;
        if (child && !seen.has(child)) pending.push(child);
      } catch { /* cross-origin frames remain unavailable to the page itself */ }
    }
  }
  return result;
}

function queryFirst(selector) {
  for (const root of frameDocuments()) {
    try {
      const node = root.querySelector(selector);
      if (node) return node;
    } catch { /* keep searching accessible documents */ }
  }
  return null;
}

function queryAll(selector) {
  const result = [];
  for (const root of frameDocuments()) {
    try { result.push(...root.querySelectorAll(selector)); } catch { /* keep searching */ }
  }
  return result;
}

function pageText(maximum = 1600) {
  return frameDocuments()
    .map((root) => String(root.body?.innerText || ''))
    .join('\n')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function isVisible(node) {
  if (!node) return false;
  const view = node.ownerDocument?.defaultView || globalThis;
  const style = view.getComputedStyle?.(node);
  const rect = node.getBoundingClientRect?.();
  return style?.display !== 'none' && style?.visibility !== 'hidden'
    && (!rect || (rect.width > 0 && rect.height > 0));
}

function visibleText(selector) {
  const node = queryAll(selector).find(isVisible);
  if (!node) return '';
  return compactText(node.textContent);
}

function inspectPage() {
  const pathname = String(globalThis.location?.pathname || '').slice(0, 240);
  const stage = STAGES.find(([prefix]) => pathname.startsWith(prefix))?.[1] || 'unknown';
  const resultText = visibleText('.cashierActivity__msg')
    || visibleText('[class*="cashierActivity__msg"]')
    || visibleText('.J-success');
  const bodyText = pageText(1600);
  const candidateSuccess = (stage === 'result' && /支付成功/u.test(resultText))
    || /支付成功|付款成功|已付款成功/u.test(bodyText)
    || /pay[_-]?success/iu.test(pathname);
  const candidateFailure = /支付失败|支付已取消|订单已关闭|密码错误|密码不正确|还可输入\s*\d+\s*次|余额不足|支付密码已被锁定|登录失败|存在风险|安全保护问题|已达该卡设定上限/u.test(`${resultText} ${bodyText}`);
  const requiresManualVerification = Boolean(queryFirst('#omeoCheckcode'))
    || ['sms-login', 'security-sms', 'security-check'].includes(stage)
    || /短信验证码|手机验证码|图形验证|滑块验证|存在风险|人机验证/u.test(bodyText);
  let transactionNo = '';
  try {
    const pageUrl = new URL(location.href);
    transactionNo = String(pageUrl.searchParams.get('trade_no') || pageUrl.searchParams.get('tradeNo') || '').slice(0, 260);
  } catch { /* ignore */ }
  const paymentAccount = compactText(
    visibleText('.c-pay-account__account')
    || visibleText('[class*="pay-account" i]')
    || visibleText('[class*="account" i]'),
  );
  const amountMatch = bodyText.replace(/,/gu, '').match(/(?:支付金额|订单金额|应付款|实付款|合计)[^¥￥\d]{0,20}(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)/u);
  const payload = {
    pathname,
    stage,
    message: candidateSuccess
      ? '支付成功'
      : requiresManualVerification ? '需要人工验证' : candidateFailure ? '支付未完成' : '',
    candidateSuccess,
    candidateFailure,
    requiresManualVerification,
    transactionNo,
    paymentAccount,
    paymentAmount: amountMatch ? Number(amountMatch[1]) : null,
  };
  const serialized = JSON.stringify(payload);
  if (serialized === lastPayload) return;
  lastPayload = serialized;
  ipcRenderer.send(CHANNEL, payload);
}

function setInputValue(input, value) {
  if (!input) return false;
  const previous = input.value;
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
  if (descriptor?.set) descriptor.set.call(input, String(value ?? ''));
  else input.value = String(value ?? '');
  if (input._valueTracker) input._valueTracker.setValue(previous);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}

function clickText(selectors, patterns) {
  const nodes = queryAll(selectors).filter(isVisible);
  const node = nodes.find((candidate) => patterns.some((pattern) => String(candidate.textContent || '').includes(pattern)));
  if (!node) return false;
  node.click();
  return true;
}

function submitPaymentForm(preferredInput = null) {
  const exactButton = queryAll('#validateButton, .ant-btn, button[type="submit"]').find(isVisible);
  if (clickText('button,[role="button"]', ['确认付款', '确认交易', '确定', '下一步'])) return true;
  if (exactButton) { exactButton.click(); return true; }
  const form = preferredInput?.form || queryFirst('form#cashier, form[action*="cashier" i]');
  form?.requestSubmit?.();
  if (form && !form.requestSubmit) form.submit();
  return Boolean(form);
}

function submitLoginForm(preferredInput = null) {
  if (clickText('button,[role="button"]', ['下一步', '登录'])) return true;
  const form = preferredInput?.form || queryFirst('form#cashier, form[action*="cashier" i], form[action*="login" i]');
  form?.requestSubmit?.();
  if (form && !form.requestSubmit) form.submit();
  return Boolean(form);
}

function typeSixDigitPassword(input, password) {
  if (typingPassword) return;
  typingPassword = true;
  let step = 1;
  const tick = () => {
    if (!input.isConnected) { typingPassword = false; return; }
    setInputValue(input, password.slice(0, step));
    if (step < password.length) {
      step += 1;
      setTimeout(tick, 180);
      return;
    }
    input.focus();
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    setTimeout(() => {
      submitPaymentForm(input);
      typingPassword = false;
    }, 650);
  };
  tick();
}

function attemptPaymentAutomation() {
  if (!paymentCredential || !location.hostname.endsWith('alipay.com')) return;
  if (queryFirst('#omeoCheckcode')) return;
  const { loginAccount, loginPassword, paymentPassword, autoSubmit } = paymentCredential;
  const bodyText = pageText(6000);
  if (/smsValidatePhoneLogin/iu.test(location.pathname)) {
    const fallback = queryFirst('#cashier .am-list a');
    if (fallback && isVisible(fallback)) { fallback.click(); return; }
  }
  const pageKey = `${location.pathname}|${bodyText.slice(0, 120)}|${autoSubmit ? 'submit' : 'login'}`;
  const accountInput = queryFirst('#logon_id, #logon_phone, input[name="logon_id"], input[type="tel"]');
  if (loginAccount && accountInput && accountInput.value !== loginAccount) setInputValue(accountInput, loginAccount);
  const sharedLoginMode = paymentCredential.platform === '支付宝' && autoSubmit !== true;
  if (sharedLoginMode && loginPassword && bodyText.includes('支付密码登录') && !bodyText.includes('请输入支付密码')) {
    const key = `${pageKey}|shared-password-login`;
    if (lastAutomationKey !== key) {
      lastAutomationKey = key;
      clickText('a,button,span,[role="button"]', ['支付密码登录']);
    }
    return;
  }
  const sharedPasswordInput = queryAll('.J-pwd-short, .J-pwd-long, .J-pwd').find(isVisible);
  if (sharedLoginMode && loginPassword && sharedPasswordInput) {
    const key = `${pageKey}|shared-password-input|${sharedPasswordInput.className || sharedPasswordInput.id}`;
    if (lastAutomationKey !== key) {
      lastAutomationKey = key;
      setInputValue(sharedPasswordInput, loginPassword);
      setTimeout(() => submitLoginForm(sharedPasswordInput), 650);
    }
    return;
  }
  const loginPasswordInput = queryFirst('#J-loginPassword, #loginPassword, input[name="loginPassword"], input[name="password"], input[type="password"]');
  if (
    loginPassword
    && loginPasswordInput
    && !autoSubmit
    && !/短信验证码|手机验证码|图形验证|滑块验证|安全验证|人机验证/u.test(bodyText)
  ) {
    const loginKey = `${pageKey}|login-password|${loginAccount}`;
    if (lastAutomationKey !== loginKey) {
      lastAutomationKey = loginKey;
      setInputValue(loginPasswordInput, loginPassword);
      setTimeout(() => {
        const exact = queryAll('#J-login-btn, button[type="submit"], input[type="submit"]').find(isVisible);
        if (exact) exact.click();
        else clickText('button,[role="button"],a', ['登录', '下一步']);
      }, 350);
    }
    return;
  }
  if (!autoSubmit || !paymentPassword) return;

  if (bodyText.includes('支付密码登录') && !bodyText.includes('请输入支付密码')) {
    if (lastAutomationKey !== `${pageKey}|password-login`) {
      lastAutomationKey = `${pageKey}|password-login`;
      clickText('a,button,span,[role="button"]', ['支付密码登录']);
    }
    return;
  }

  let passwordInput = queryAll(
    '#payPassword_rsainput, .six-number-password-input____bcvZ, .ant-input, .J-pwd-short, .J-pwd-long, .J-pwd, .my-passcode-input-native-input, .adm-input-element, input[type="password"]'
  ).find(isVisible);
  if (!passwordInput && bodyText.includes('使用长密码')) {
    clickText('a,button,span,[role="button"]', ['使用长密码']);
    return;
  }
  if (!passwordInput) {
    if (lastAutomationKey !== `${pageKey}|confirm`) {
      lastAutomationKey = `${pageKey}|confirm`;
      clickText('button,[role="button"]', ['确认付款', '确认交易']);
    }
    return;
  }
  const inputKey = `${location.pathname}|${passwordInput.className || passwordInput.id || passwordInput.type}|${paymentPassword.length}`;
  if (lastAutomationKey === inputKey || typingPassword) return;
  lastAutomationKey = inputKey;
  if (/^\d{6}$/u.test(paymentPassword)) typeSixDigitPassword(passwordInput, paymentPassword);
  else {
    setInputValue(passwordInput, paymentPassword);
    setTimeout(() => submitPaymentForm(passwordInput), 650);
  }
}

function paymentWindowTip() {
  const url = String(globalThis.location?.href || '');
  const text = pageText(2000);
  if (url.includes('mobile.yangkeduo.com/orders.html')) return '选择一笔待付款订单，点击“去支付”进入支付宝。';
  if (url.includes('buyertrade.taobao.com') || url.includes('trade.taobao.com')) return '选择淘宝/天猫待付款订单，点击付款进入支付宝。';
  if (url.includes('1688.com')) return '选择一笔1688待付款订单，点击付款进入支付宝。';
  if (url.includes('mobile.yangkeduo.com')) return '请返回拼多多待付款页面。';
  if (url.includes('mclient.alipay.com')) {
    if (queryFirst('#omeoCheckcode')) return '检测到图形验证：请点击“清缓存并关闭”，再重新打开。';
    if (/确认交易|确认付款/u.test(text)) return '支付宝登录成功，可以关闭窗口；自动付款会复用该会话。';
    return '请在支付宝页面完成手机号或支付密码验证。';
  }
  if (url.includes('auth.alipay.com') || url.includes('login.alipay.com')) {
    return '请选择密码或短信验证码登录；验证码只需在本窗口手动输入一次。';
  }
  return '自动支付独立窗口。';
}

function platformShortcut() {
  const platform = String(paymentCredential?.platform || '').trim();
  if (platform === '支付宝') return { label: 'PDD待付款', url: 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75' };
  if (platform === '1688') return { label: '1688待付款', url: 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?tradeStatus=waitbuyerpay&page=1&pageSize=10' };
  if (platform === '淘宝' || platform === '天猫') return { label: '淘宝待付款', url: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?action=itemlist/BoughtQueryAction&event_submit_do_query=1&tabCode=waitPay' };
  return { label: 'PDD个人中心', url: 'https://mobile.yangkeduo.com/personal.html' };
}

function updatePlatformShortcut() {
  const button = document.getElementById('wangzai-payment-platform-shortcut');
  if (!button) return;
  button.textContent = platformShortcut().label;
}

function addButton(container, label, onClick, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = `wangzai-payment-toolbar-button${danger ? ' danger' : ''}`;
  button.addEventListener('click', onClick);
  container.appendChild(button);
  return button;
}

function injectPaymentToolbar() {
  if (!document.body || document.getElementById('wangzai-payment-toolbar')) return;
  const toolbar = document.createElement('div');
  toolbar.id = 'wangzai-payment-toolbar';
  toolbar.innerHTML = '<div id="wangzai-payment-toolbar-row"></div><div id="wangzai-payment-toolbar-tip"></div>';
  const row = toolbar.querySelector('#wangzai-payment-toolbar-row');
  addButton(row, '后退', () => history.back());
  addButton(row, '前进', () => history.forward());
  const address = document.createElement('input');
  address.id = 'wangzai-payment-toolbar-address';
  address.value = String(location.href || '');
  address.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') row.querySelector('[data-action="go"]')?.click();
  });
  row.appendChild(address);
  const shortcut = addButton(row, platformShortcut().label, () => { location.href = platformShortcut().url; });
  shortcut.id = 'wangzai-payment-platform-shortcut';
  addButton(row, '清缓存并关闭', () => ipcRenderer.send(ACTION_CHANNEL, { action: 'clear-cache-and-close' }), true);
  addButton(row, '刷新', () => location.reload());
  const go = addButton(row, '前往', () => {
    try {
      const target = new URL(address.value);
      const host = target.hostname.toLowerCase();
      const trustedHost = host === 'mobile.yangkeduo.com'
        || host === 'alipay.com' || host.endsWith('.alipay.com')
        || host === 'taobao.com' || host.endsWith('.taobao.com')
        || host === 'tmall.com' || host.endsWith('.tmall.com')
        || host === '1688.com' || host.endsWith('.1688.com')
        || host === 'alibaba.com' || host.endsWith('.alibaba.com');
      if (target.protocol !== 'https:' || !trustedHost) {
        throw new Error('untrusted');
      }
      location.href = target.toString();
    } catch {
      toolbar.querySelector('#wangzai-payment-toolbar-tip').textContent = '只允许打开拼多多或支付宝官方页面。';
    }
  });
  go.dataset.action = 'go';
  const style = document.createElement('style');
  style.textContent = `
    #wangzai-payment-toolbar{position:fixed;inset:0 0 auto 0;z-index:2147483647;background:#fff;border-bottom:1px solid #9bb7e7;padding:5px 6px;box-shadow:0 2px 8px rgba(20,52,100,.16);font:12px/1.4 Arial,"Microsoft YaHei",sans-serif}
    #wangzai-payment-toolbar-row{display:flex;align-items:center;gap:3px;min-width:0;flex-wrap:nowrap;overflow:hidden}
    .wangzai-payment-toolbar-button{height:30px;flex:0 0 auto;border:0;border-radius:5px;background:#409eff;color:#fff;padding:0 4px;cursor:pointer;white-space:nowrap;font-size:11px;line-height:30px}
    .wangzai-payment-toolbar-button.danger{background:#f04444}
    #wangzai-payment-toolbar-address{height:28px;min-width:60px;flex:1 1 120px;border:1px solid #aab7ca;padding:0 4px;font-size:11px}
    #wangzai-payment-toolbar-tip{min-height:20px;padding-top:3px;color:#e53935;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    body{padding-top:72px!important;box-sizing:border-box!important}
  `;
  document.documentElement.appendChild(style);
  document.body.appendChild(toolbar);
  toolbar.querySelector('#wangzai-payment-toolbar-tip').textContent = paymentWindowTip();
}

function startObserver() {
  injectPaymentToolbar();
  inspectPage();
  const observer = new MutationObserver(() => {
    injectPaymentToolbar();
    inspectPage();
    const tip = document.getElementById('wangzai-payment-toolbar-tip');
    const nextTip = paymentWindowTip();
    if (tip && tip.textContent !== nextTip) tip.textContent = nextTip;
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setInterval(inspectPage, 750);
  setInterval(attemptPaymentAutomation, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserver, { once: true });
} else {
  startObserver();
}

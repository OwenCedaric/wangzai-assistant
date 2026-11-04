using System.Text.Json.Nodes;

namespace Wangzai.CefBrowserHost;

internal static class PurchaseAutoOrderScript
{
	public static string Build(JsonObject payload)
	{
		string json = payload.ToJsonString();
		return """
(async () => {
  const input = PAYLOAD_JSON;
  const clean = (value, maximum = 600) => String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const platform = clean(input.sourcePlatform || '', 40);
  const first = Array.isArray(input.products) ? input.products[0] || {} : {};
  const taskKey = clean(input.idempotencyKey || input.posting || 'auto-order', 260);
  globalThis.__wangzaiAutoOrderState ||= {};
  const taskState = globalThis.__wangzaiAutoOrderState[taskKey]
    ||= { clickedBuy: false, clickedSubmit: false, paymentFilled: false };

  const documents = () => {
    const result = [];
    const pending = [document];
    const seen = new Set();
    while (pending.length && result.length < 20) {
      const current = pending.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      result.push(current);
      let frames = [];
      try { frames = [...current.querySelectorAll('iframe,frame')]; } catch {}
      for (const frame of frames) {
        try {
          const child = frame.contentDocument || frame.contentWindow?.document;
          if (child && !seen.has(child)) pending.push(child);
        } catch {}
      }
    }
    return result;
  };
  const body = () => clean(documents().map(root => root.body?.innerText || '').join('\n'), 200000);
  const visible = (node) => {
    if (!node) return false;
    const view = node.ownerDocument?.defaultView || globalThis;
    const style = view.getComputedStyle?.(node);
    const rect = node.getBoundingClientRect?.();
    return style?.display !== 'none' && style?.visibility !== 'hidden'
      && (!rect || (rect.width > 0 && rect.height > 0));
  };
  const queryAll = (selector) => {
    const result = [];
    for (const root of documents()) {
      try { result.push(...root.querySelectorAll(selector)); } catch {}
    }
    return result;
  };
  const queryFirst = (selector) => queryAll(selector).find(visible) || null;
  const textNodes = () => {
    const result = [];
    const pending = [...documents()];
    const seen = new Set();
    while (pending.length && result.length < 4500) {
      const root = pending.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let nodes = [];
      try { nodes = [...root.querySelectorAll('button,a,[role="button"],input[type="button"],div,span,li')]; } catch {}
      for (const node of nodes) {
        result.push(node);
        if (node.shadowRoot) pending.push(node.shadowRoot);
      }
    }
    return result.filter(visible).slice(0, 3500);
  };
  const clickText = (patterns) => {
    const wanted = patterns.map(pattern => String(pattern));
    const node = textNodes().find(item => wanted.some(pattern => clean(item.textContent, 180).includes(pattern)));
    if (!node) return false;
    node.click();
    return true;
  };
  const setValue = (node, value) => {
    if (!node) return false;
    const previous = node.value;
    const prototype = Object.getPrototypeOf(node);
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(node, String(value ?? ''));
    else node.value = String(value ?? '');
    const EventCtor = node.ownerDocument?.defaultView?.Event || Event;
    node.dispatchEvent(new EventCtor('input', { bubbles: true }));
    node.dispatchEvent(new EventCtor('change', { bubbles: true }));
    node.dispatchEvent(new EventCtor('blur', { bubbles: true }));
    return previous !== node.value;
  };
  const challenge = () => Boolean(queryFirst('#omeoCheckcode'))
    || /验证码|滑块|安全验证|图形验证|短信验证码|手机验证码|人机验证|访问受限|存在风险|captcha|verify you are human/iu.test(body());
  const paymentSuccess = () => /支付成功|付款成功|已付款成功|交易成功|待发货|等待商家发货|等待卖家发货/iu.test(body())
    || /pay[_-]?success|cashierActivity/iu.test(location.href);
  const paymentFailure = () => /密码错误|密码不正确|还可输入\s*\d+\s*次|支付密码已被锁定|余额不足|订单已关闭|支付失败|支付已取消|登录失效/iu.test(body());
  const readOrderNumber = () => {
    try {
      const pageUrl = new URL(location.href);
      const fromUrl = ['biz_order_id', 'orderId', 'order_id', 'order_sn', 'tradeId', 'trade_id']
        .map(key => pageUrl.searchParams.get(key))
        .find(value => /^[A-Za-z0-9_-]{6,80}$/u.test(String(value || '')));
      if (fromUrl) return String(fromUrl);
    } catch {}
    const roots = [globalThis.rawData, globalThis.store, globalThis.__INITIAL_STATE__];
    const keys = new Set(['orderSn', 'order_sn', 'orderId', 'order_id', 'tradeNo', 'trade_no']);
    const queue = roots.map(value => ({ value, depth: 0 }));
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current?.value || typeof current.value !== 'object' || current.depth > 5 || seen.has(current.value)) continue;
      seen.add(current.value);
      for (const [key, value] of Object.entries(current.value)) {
        if (keys.has(key) && /^[A-Za-z0-9_-]{6,80}$/u.test(String(value || ''))) return String(value);
        if (value && typeof value === 'object') queue.push({ value, depth: current.depth + 1 });
      }
    }
    const match = body().match(/(?:订单号|订单编号|交易号)\s*[:：]?\s*([A-Za-z0-9_-]{6,80})/u);
    return match?.[1] || '';
  };
  const readPaymentAmount = () => {
    const directSelectors = [
      '._6utWlUAs', '.HApVUXCl', '.realpay--price',
      '.trade-price-container', '[class*="totalPrice_num"]',
      '[data-testid*="total" i]', '[class*="actualFee" i]', '[class*="totalPrice" i]'
    ];
    for (const selector of directSelectors) {
      const node = queryFirst(selector);
      const match = clean(node?.textContent || '', 200).replace(/,/gu, '').match(/(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)/u);
      if (match && Number(match[1]) > 0) return Number(match[1]);
    }
    for (const node of textNodes()) {
      const text = clean(node.textContent || '', 260).replace(/,/gu, '');
      if (!/实付款|应付款|应付金额|合计|订单金额|支付金额/u.test(text)) continue;
      const matches = [...text.matchAll(/(?:¥|￥)\s*(\d+(?:\.\d{1,2})?)/gu)];
      const value = Number(matches.at(-1)?.[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  };
  const validatePaymentAmount = () => {
    const actualAmount = readPaymentAmount();
    if (!Number.isFinite(actualAmount) || actualAmount <= 0) {
      return { ok: false, actualAmount: null, reason: 'PURCHASE_AUTO_ORDER_AMOUNT_UNREADABLE' };
    }
    const maximum = Number(input.maxPayPrice);
    if (Number.isFinite(maximum) && maximum >= 0 && actualAmount > maximum) {
      return { ok: false, actualAmount, reason: 'PURCHASE_AUTO_ORDER_MAX_PAYMENT_EXCEEDED' };
    }
    const shippingFee = readShippingFee();
    const maximumShipping = Number(input.maxShippingFee);
    if (Number.isFinite(maximumShipping) && shippingFee > maximumShipping) {
      return { ok: false, actualAmount, shippingFee, reason: 'PURCHASE_AUTO_ORDER_SHIPPING_FEE_EXCEEDED' };
    }
    const expected = Number(input.expectedTotal);
    if (Number.isFinite(expected) && expected > 0 && actualAmount > expected + shippingFee + 0.01) {
      return { ok: false, actualAmount, shippingFee, reason: 'PURCHASE_AUTO_ORDER_SOURCE_PRICE_CHANGED' };
    }
    return { ok: true, actualAmount, shippingFee };
  };
  const readShippingFee = () => {
    for (const node of textNodes()) {
      const value = clean(node.textContent || '', 220).replace(/,/gu, '');
      if (!/运费|配送费|快递费|物流费/u.test(value)) continue;
      if (/包邮|免运费|运费\s*[：:]?\s*0(?:\.00)?/u.test(value)) return 0;
      const match = value.match(/(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)/u);
      if (match && Number.isFinite(Number(match[1]))) return Number(match[1]);
    }
    return 0;
  };
  const presaleBeyondSevenDays = () => {
    if (input.skipPresale !== true) return false;
    const text = body();
    const days = [...text.matchAll(/(\d+)\s*天内发货/gu)].map(match => Number(match[1])).filter(Number.isFinite);
    if (days.some(value => value >= 7)) return true;
    const dateMatch = text.match(/(?:承诺)?(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{1,2}))?/u);
    if (!dateMatch) return /预售/u.test(text);
    const now = new Date();
    const promised = new Date(now.getFullYear(), Number(dateMatch[1]) - 1, Number(dateMatch[2]), Number(dateMatch[3] || 0), Number(dateMatch[4] || 0));
    if (promised.getTime() < now.getTime() - 86400000) promised.setFullYear(promised.getFullYear() + 1);
    return (promised.getTime() - now.getTime()) / 86400000 >= 7;
  };
  const normalized = (value) => clean(value, 1000).replace(/[\s,，。._-]/gu, '').toLowerCase();
  const verifyPurchaseAccount = () => {
    const expected = normalized(input.sourceAccountLogin);
    if (!expected) return true;
    const nick = queryFirst('.j_Username, .site-nav-login-info-nick, [class*="myAccountName"]');
    const actual = normalized(nick?.textContent || '');
    return !actual || actual === expected;
  };
  const selectReceiverAddress = () => {
    const receiver = input.receiver || {};
    const expectedName = normalized(receiver.name);
    const expectedPhone = normalized(receiver.phone);
    const expectedDetail = normalized(receiver.detail || receiver.fullAddress);
    if (!expectedName && !expectedPhone && !expectedDetail) return { ok: true, skipped: true };
    const candidates = queryAll('[class*="listItem"], [class*="address"], .addr-item-wrapper, [data-address-id]')
      .filter(visible);
    const exact = candidates.find((node) => {
      const value = normalized(node.textContent || '');
      return (!expectedName || value.includes(expectedName))
        && (!expectedPhone || value.includes(expectedPhone.slice(-8)))
        && (!expectedDetail || value.includes(expectedDetail.slice(-12)));
    });
    if (exact) { exact.click(); return { ok: true }; }
    clickText(['使用新地址', '新增地址', '添加新地址']);
    return { ok: false, reason: 'PURCHASE_AUTO_ORDER_ADDRESS_REQUIRED' };
  };
  const writeBuyerMemo = () => {
    const memo = clean(input.buyerMemo, 500)
      .replaceAll('麻烦送货上门', '').replaceAll('送货上门', '').replaceAll('送货', '').replaceAll('上门', '').trim();
    if (!memo) return;
    const field = queryFirst('textarea, textarea[id^="textarea_memoPC"], input[placeholder*="留言"]');
    if (field) setValue(field, memo);
  };
  const clickWithin = (root, patterns) => {
    if (!root) return false;
    let nodes = [];
    try { nodes = [root, ...root.querySelectorAll('button,a,[role="button"],div,span')]; } catch { nodes = [root]; }
    const target = nodes.filter(visible).find((node) => patterns.some((pattern) => clean(node.textContent, 180).includes(pattern)));
    if (!target) return false;
    target.click();
    return true;
  };
  const openExistingPayment = async () => {
    const orderNumber = clean(input.existingOrderNumber, 260);
    if (!orderNumber) return null;
    purchaseOrderNumber = orderNumber;
    if (presaleBeyondSevenDays()) return { ok: false, reason: 'PURCHASE_AUTO_ORDER_PRESALE_SKIPPED' };
    if (platform === '拼多多') {
      clickText(['支付宝']);
      await wait(300);
      return { ok: clickText(['去支付', '继续支付', '继续付款', '立即支付']) };
    }
    const orderNode = queryAll(`[id="shopOrderContainer_${orderNumber}"], [data-order-id="${orderNumber}"], li.order-item, order-item`)
      .find((node) => normalized(node.textContent || '').includes(normalized(orderNumber)));
    if (!orderNode) return { ok: false, reason: 'PURCHASE_AUTO_ORDER_EXISTING_ORDER_NOT_FOUND' };
    const clicked = clickWithin(orderNode, ['立即付款', '付款', '去支付', '继续支付']);
    await wait(800);
    return { ok: clicked, reason: clicked ? '' : 'PURCHASE_AUTO_ORDER_PAYMENT_ENTRY_NOT_FOUND' };
  };
  let purchaseOrderNumber = readOrderNumber();

  const selectSku = async () => {
    const names = clean(first.sourceSkuName, 800)
      .split(/[;/／|｜]/u)
      .flatMap(value => value.split(/\s+\/\s+/u))
      .map(value => clean(value.replace(/^.{1,80}?[：:]/u, ''), 180))
      .filter(Boolean);
    const skuNodes = queryAll('[class*="valueItem"], [data-sku-id], [data-sku], [data-value-id], [data-spec-id], [title]')
      .filter(visible);
    const exactIds = new Set([first.sourceSkuId, first.sourceProductId].map(value => clean(value, 260)).filter(Boolean));
    for (const node of skuNodes) {
      const ids = ['data-sku-id', 'data-sku', 'data-value-id', 'data-spec-id', 'data-id']
        .map(attribute => clean(node.getAttribute?.(attribute), 260)).filter(Boolean);
      if (ids.some(value => exactIds.has(value))) { node.click(); await wait(200); }
    }
    const longestCommonLength = (left, right) => {
      let best = 0;
      const dp = Array(right.length + 1).fill(0);
      for (let i = 1; i <= left.length; i += 1) {
        for (let j = right.length; j >= 1; j -= 1) {
          dp[j] = left[i - 1] === right[j - 1] ? dp[j - 1] + 1 : 0;
          best = Math.max(best, dp[j]);
        }
      }
      return best;
    };
    for (const name of names) {
      let node = skuNodes.find(item => clean(item.getAttribute?.('title') || item.textContent, 180) === name);
      if (!node && input.allowSimilarSku === true) {
        node = skuNodes
          .map(item => ({ item, score: longestCommonLength(normalized(item.textContent || item.getAttribute?.('title')), normalized(name)) }))
          .sort((left, right) => right.score - left.score)[0]?.item || null;
      }
      if (node) { node.click(); await wait(250); }
    }
    const quantity = queryFirst('input[type="number"], input[aria-label*="数量" i], [class*="countValue"] input, .order-quantity input');
    if (quantity) setValue(quantity, first.quantity || 1);
  };

  const fillPayment = async () => {
    const credential = input.paymentCredential || {};
    const account = clean(credential.loginAccount, 260);
    const password = clean(credential.paymentPassword, 128);
    if (!password) return { filled: false, reason: 'PAYMENT_CREDENTIAL_MISSING' };
    if (taskState.paymentFilled) return { filled: true, alreadySubmitted: true };
    const accountInput = queryFirst('#logon_id, #logon_phone, input[name="logon_id"], input[type="tel"]');
    if (account && accountInput) setValue(accountInput, account);
    clickText(['支付密码登录', '使用密码', '密码登录']);
    await wait(700);
    const passwordInput = queryAll(
      '.J-pwd-short, .J-pwd-long, .J-pwd, .my-passcode-input-native-input, .adm-input-element, input[type="password"]'
    ).find(visible);
    if (!passwordInput) return { filled: false, reason: 'PAYMENT_PASSWORD_INPUT_MISSING' };
    if (/^\d{6}$/u.test(password)) {
      for (let index = 1; index <= password.length; index += 1) {
        setValue(passwordInput, password.slice(0, index));
        await wait(180);
      }
    } else setValue(passwordInput, password);
    await wait(500);
    if (!clickText(['确认付款', '确认交易', '确定', '下一步'])) {
      passwordInput.form?.requestSubmit?.();
      if (passwordInput.form && !passwordInput.form.requestSubmit) passwordInput.form.submit?.();
    }
    taskState.paymentFilled = true;
    return { filled: true };
  };

  if (challenge()) return JSON.stringify({ ok: true, paused: true, challengeRequired: true, pauseReason: '页面需要人工验证', stage: 'paused', pageUrl: location.href });
  if (paymentSuccess()) return JSON.stringify({ ok: true, stage: 'completed', paymentConfirmed: true, purchaseOrderNumber, purchaseAmount: readPaymentAmount(), pageUrl: location.href });
  if (paymentFailure()) return JSON.stringify({ ok: false, paused: true, pauseReason: '支付页面返回失败状态', stage: 'payment-failed', pageUrl: location.href });
  const isAlipayHost = /(?:^|\.)alipay\.com$/iu.test(location.hostname) || location.hostname.endsWith('.alipay.com');
  if (!isAlipayHost && /login\.taobao\.com/iu.test(location.hostname)) {
    return JSON.stringify({ ok: true, paused: true, pauseReason: 'PURCHASE_AUTO_ORDER_LOGIN_REQUIRED', stage: 'paused', pageUrl: location.href });
  }
  if (!isAlipayHost && /ershou\.taobao\.com|auction\/noitem|TmallConfirmOrderError/iu.test(location.href)) {
    return JSON.stringify({ ok: true, paused: true, pauseReason: 'PURCHASE_AUTO_ORDER_PRODUCT_UNAVAILABLE', stage: 'paused', pageUrl: location.href });
  }
  if (!isAlipayHost && (platform === '淘宝' || platform === '天猫') && !verifyPurchaseAccount()) {
    return JSON.stringify({ ok: true, paused: true, pauseReason: 'PURCHASE_AUTO_ORDER_ACCOUNT_MISMATCH', stage: 'paused', pageUrl: location.href });
  }
  const isExistingListPage = platform === '拼多多'
    ? /\/order\.html/iu.test(location.pathname)
    : platform === '淘宝' || platform === '天猫'
      ? location.hostname === 'buyertrade.taobao.com' && /list_bought_items\.htm/iu.test(location.pathname)
      : platform === '1688' && /buyer[-_]order[-_]list\.html?/iu.test(location.pathname);
  if (!isAlipayHost && input.existingOrderNumber && isExistingListPage) {
    const existing = await openExistingPayment();
    if (existing && !existing.ok) return JSON.stringify({ ok: true, paused: true, pauseReason: existing.reason, stage: 'paused', purchaseOrderNumber, pageUrl: location.href });
    if (existing?.ok) return JSON.stringify({ ok: true, stage: 'checkout-progress', progressed: true, purchaseOrderNumber, pageUrl: location.href });
  }
  if (!isAlipayHost && presaleBeyondSevenDays()) {
    return JSON.stringify({ ok: true, paused: true, pauseReason: 'PURCHASE_AUTO_ORDER_PRESALE_SKIPPED', stage: 'paused', pageUrl: location.href });
  }

  if (location.hostname.includes('yangkeduo.com') || location.hostname.includes('pinduoduo.com')) {
    if (/\/goods(?:_detail)?\.html/iu.test(location.pathname)) {
      if (!taskState.clickedBuy) {
        taskState.clickedBuy = clickText(['立即购买', '直接抢到', '发起拼单', '参与拼单']);
        await wait(500);
      }
      await selectSku();
      clickText(['确定', '参与拼单']);
      await wait(800);
      return JSON.stringify({ ok: true, stage: 'checkout-progress', progressed: taskState.clickedBuy, pageUrl: location.href });
    }
    if (/order_checkout\.html/iu.test(location.pathname)) {
      await selectSku();
      clickText(['支付宝']);
      await wait(300);
      const amount = validatePaymentAmount();
      if (!amount.ok) return JSON.stringify({ ok: true, paused: true, pauseReason: amount.reason, purchaseAmount: amount.actualAmount, stage: 'paused', pageUrl: location.href });
      if (input.autoSubmitOrder !== true) return JSON.stringify({ ok: true, stage: 'checkout-pending', purchaseAmount: amount.actualAmount, purchaseOrderNumber, pageUrl: location.href });
      if (!taskState.clickedSubmit) taskState.clickedSubmit = clickText(['提交订单', '立即支付', '去支付', '继续支付']);
      await wait(1200);
      purchaseOrderNumber = purchaseOrderNumber || readOrderNumber();
      return JSON.stringify({ ok: true, stage: 'checkout-progress', progressed: taskState.clickedSubmit, purchaseAmount: amount.actualAmount, purchaseOrderNumber, pageUrl: location.href });
    }
  } else if (platform === '淘宝' || platform === '天猫') {
    if (/^(?:item\.taobao\.com|detail\.tmall\.com)$/iu.test(location.hostname)) {
      await selectSku();
      if (!taskState.clickedBuy) taskState.clickedBuy = clickText(['立即购买']);
      await wait(800);
      return JSON.stringify({ ok: true, stage: 'checkout-progress', progressed: taskState.clickedBuy, pageUrl: location.href });
    }
    const checkoutPage = /buy\.(?:taobao|tmall)\.com/iu.test(location.hostname) || /提交订单|免密支付|立即支付/u.test(body());
    if (checkoutPage) {
      const address = selectReceiverAddress();
      if (!address.ok) return JSON.stringify({ ok: true, paused: true, pauseReason: address.reason, stage: 'paused', pageUrl: location.href });
      await selectSku();
      writeBuyerMemo();
    }
    const amount = validatePaymentAmount();
    if (!amount.ok) return JSON.stringify({ ok: true, paused: true, pauseReason: amount.reason, purchaseAmount: amount.actualAmount, stage: 'paused', pageUrl: location.href });
    if (input.autoSubmitOrder !== true) return JSON.stringify({ ok: true, stage: 'checkout-pending', purchaseAmount: amount.actualAmount, purchaseOrderNumber, pageUrl: location.href });
    if (!taskState.clickedSubmit) taskState.clickedSubmit = clickText(['提交订单', '付款', '立即付款', '去支付']);
    await wait(1200);
    purchaseOrderNumber = purchaseOrderNumber || readOrderNumber();
    return JSON.stringify({ ok: true, stage: 'checkout-progress', progressed: taskState.clickedSubmit, purchaseAmount: amount.actualAmount, purchaseOrderNumber, pageUrl: location.href });
  } else if (platform === '1688') {
    if (/detail\.1688\.com/iu.test(location.hostname) || /\/offer\/\d+/iu.test(location.pathname)) {
      await selectSku();
      if (!taskState.clickedBuy) taskState.clickedBuy = clickText(['立即订购', '立即购买', '马上订购']);
      await wait(800);
      return JSON.stringify({ ok: true, stage: 'checkout-progress', progressed: taskState.clickedBuy, pageUrl: location.href });
    }
    writeBuyerMemo();
    const amount = validatePaymentAmount();
    if (!amount.ok) return JSON.stringify({ ok: true, paused: true, pauseReason: amount.reason, purchaseAmount: amount.actualAmount, stage: 'paused', pageUrl: location.href });
    if (input.autoSubmitOrder !== true) return JSON.stringify({ ok: true, stage: 'checkout-pending', purchaseAmount: amount.actualAmount, purchaseOrderNumber, pageUrl: location.href });
    if (!taskState.clickedSubmit) taskState.clickedSubmit = clickText(['付款', '去付款', '立即付款', '支付宝']);
    await wait(1200);
    purchaseOrderNumber = purchaseOrderNumber || readOrderNumber();
    return JSON.stringify({ ok: true, stage: 'checkout-progress', progressed: taskState.clickedSubmit, purchaseAmount: amount.actualAmount, purchaseOrderNumber, pageUrl: location.href });
  }

  if (challenge()) return JSON.stringify({ ok: true, paused: true, challengeRequired: true, pauseReason: '页面需要人工验证', stage: 'paused', pageUrl: location.href });
  if (isAlipayHost) {
    if (input.delegatePaymentToElectron === true) {
      return JSON.stringify({ ok: true, stage: 'payment-pending', paymentSubmitted: false, purchaseOrderNumber, paymentUrl: location.href, pageUrl: location.href });
    }
    const payment = await fillPayment();
    if (!payment.filled) return JSON.stringify({ ok: true, paused: true, pauseReason: payment.reason, stage: 'payment-pending', paymentUrl: location.href, pageUrl: location.href });
    await wait(1200);
    if (challenge()) return JSON.stringify({ ok: true, paused: true, challengeRequired: true, pauseReason: '支付页面需要人工验证', stage: 'paused', paymentUrl: location.href, pageUrl: location.href });
    if (paymentFailure()) return JSON.stringify({ ok: false, paused: true, pauseReason: '支付页面返回失败状态', stage: 'payment-failed', paymentUrl: location.href, pageUrl: location.href });
    if (paymentSuccess()) return JSON.stringify({ ok: true, stage: 'completed', paymentConfirmed: true, purchaseOrderNumber, paymentUrl: location.href, pageUrl: location.href });
    return JSON.stringify({ ok: true, stage: 'payment-pending', paymentSubmitted: true, purchaseOrderNumber, paymentUrl: location.href, pageUrl: location.href });
  }
  return JSON.stringify({ ok: true, stage: 'checkout-pending', paymentConfirmed: false, purchaseOrderNumber, pageUrl: location.href });
})()
""".Replace("PAYLOAD_JSON", json);
	}
}

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import {
  alipayPaymentPartition,
  createAlipayPaymentWindowController,
  isAlipayH5PaymentUrl,
  isAlipayPaymentUrl,
  isAlipayLoginUrl,
  isMarketplacePaymentBootstrapUrl,
  isPinduoduoPaymentBootstrapUrl,
  isTrustedAlipayNavigation,
  hasMarketplaceAuthenticationCookies,
  hasAlipayAuthenticationCookies,
} from './alipayPaymentWindowController.js';
import { normalizeAutoOrderRequest } from './cefPurchaseBrowserController.js';

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.openHandler = null;
  }

  setWindowOpenHandler(handler) { this.openHandler = handler; }
  getURL() { return this.currentUrl || ''; }
  reload() { this.reloadCount = (this.reloadCount || 0) + 1; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  static loadGate = null;

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.visible = false;
    this.loadedUrls = [];
    FakeBrowserWindow.instances.push(this);
  }

  async loadURL(url) {
    this.loadedUrls.push(url);
    this.webContents.currentUrl = url;
    if (FakeBrowserWindow.loadGate) await FakeBrowserWindow.loadGate;
    this.emit('ready-to-show');
  }

  setMenuBarVisibility() {}
  setBounds(bounds) { this.bounds = bounds; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() { this.focused = true; }
  close() {
    if (this.destroyed) return;
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    if (prevented) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

function createFixture({
  verificationResult = { paymentVerified: true, readbackVerified: true },
  pendingRetryMs = 3_000,
  workArea = { x: 0, y: 0, width: 1920, height: 1080 },
  loadGate = null,
} = {}) {
  FakeBrowserWindow.instances = [];
  FakeBrowserWindow.loadGate = loadGate;
  const ipcMain = new EventEmitter();
  const partitions = new Map();
  const session = {
    fromPartition(partition) {
      if (!partitions.has(partition)) {
        partitions.set(partition, {
          permissionRequestHandler: null,
          permissionCheckHandler: null,
          clearStorageCalls: 0,
          clearCacheCalls: 0,
          flushCalls: 0,
          cookieWrites: [],
          cookies: {
            set: async (details) => { partitions.get(partition).cookieWrites.push(details); },
            get: async () => partitions.get(partition).cookieWrites,
          },
          setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; },
          setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; },
          async clearStorageData() { this.clearStorageCalls += 1; },
          async clearCache() { this.clearCacheCalls += 1; },
          flushStorageData() { this.flushCalls += 1; },
        });
      }
      return partitions.get(partition);
    },
  };
  const events = [];
  const verifications = [];
  const controller = createAlipayPaymentWindowController({
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    session,
    screen: {
      getCursorScreenPoint: () => ({ x: 1, y: 1 }),
      getDisplayNearestPoint: () => ({ workArea }),
    },
    preloadPath: 'C:\\app\\alipayPaymentPreload.cjs',
    getUserScope: () => 'user-a',
    onEvent: (event) => events.push(event),
    onPaymentCandidate: async (payload) => {
      verifications.push(payload);
      return typeof verificationResult === 'function'
        ? verificationResult(verifications.length, payload)
        : verificationResult;
    },
    verificationDelaysMs: [0],
    pendingRetryMs,
  });
  return { controller, events, ipcMain, partitions, verifications };
}

test('Alipay payment URL boundary accepts only the official HTTPS H5 cashier', () => {
  assert.equal(isAlipayH5PaymentUrl('https://mclient.alipay.com/h5pay/cashierPreConfirm/index.html?token=x'), true);
  assert.equal(isAlipayH5PaymentUrl('http://mclient.alipay.com/h5pay/cashierPreConfirm/index.html'), false);
  assert.equal(isAlipayH5PaymentUrl('https://mclient.alipay.com.evil.test/h5pay/cashierPreConfirm/index.html'), false);
  assert.equal(isAlipayH5PaymentUrl('https://mclient.alipay.com/login'), false);
  assert.equal(isTrustedAlipayNavigation('https://auth.alipay.com/login'), true);
  assert.equal(isAlipayLoginUrl('https://auth.alipay.com/login'), true);
  assert.equal(isAlipayLoginUrl('https://auth.alipay.com.evil.test/login'), false);
  assert.equal(isAlipayPaymentUrl('https://cashier.alipay.com/business/cashiermain.htm?trade_no=x'), true);
  assert.equal(isMarketplacePaymentBootstrapUrl('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?tabCode=waitPay'), true);
  assert.equal(isMarketplacePaymentBootstrapUrl('https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?tradeStatus=waitbuyerpay'), true);
  assert.equal(isPinduoduoPaymentBootstrapUrl('https://mobile.yangkeduo.com/orders.html?type=1'), true);
  assert.equal(isPinduoduoPaymentBootstrapUrl('https://evil.test/orders.html?type=1'), false);
  assert.equal(isTrustedAlipayNavigation('https://alipay.com.evil.test/login'), false);
});

test('marketplace authentication cookies require both identity and session evidence', () => {
  assert.equal(hasMarketplaceAuthenticationCookies('拼多多', [{ name: 'PDDAccessToken' }]), true);
  assert.equal(hasMarketplaceAuthenticationCookies('淘宝', [{ name: 'unb' }, { name: '_tb_token_' }]), true);
  assert.equal(hasMarketplaceAuthenticationCookies('淘宝', [{ name: '_tb_token_' }]), false);
  assert.equal(hasMarketplaceAuthenticationCookies('1688', [{ name: 'tracknick' }, { name: 'cookie2' }]), true);
  assert.equal(hasMarketplaceAuthenticationCookies('1688', [{ name: 'cookie2' }]), false);
  assert.equal(hasAlipayAuthenticationCookies([{ name: 'ALIPAY_WAP_CASHIER_COOKIE' }]), true);
  assert.equal(hasAlipayAuthenticationCookies([{ name: 'cookieToken' }]), true);
  assert.equal(hasAlipayAuthenticationCookies([{ name: 'alipay_appid_token' }]), false);
});

test('payment preload retains the recovered QueShou login and password-control variants', () => {
  const source = fs.readFileSync(new URL('./alipayPaymentPreload.cjs', import.meta.url), 'utf8');
  for (const marker of [
    '支付密码登录',
    '.J-pwd-short',
    '.J-pwd-long',
    '.J-pwd',
    '.my-passcode-input-native-input',
    '.adm-input-element',
    'omeoCheckcode',
    '确认付款',
    '确认交易',
    'loginPassword',
    '短信验证码',
    '验证码只需在本窗口手动输入一次',
  ]) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(source, /typeSixDigitPassword[\s\S]*password\.slice\(0, step\)/u);
  assert.match(source, /font:12px/u);
  assert.match(source, /min-width:60px/u);
  assert.match(source, /flex:0 0 auto/u);
  assert.match(source, /flex-wrap:nowrap/u);
  assert.match(source, /font-size:11px/u);
  assert.match(source, /padding-top:72px/u);
  assert.doesNotMatch(source, /123456|186754212154/u);
});

test('Alipay session partition is stable per software user and purchase account', () => {
  const first = alipayPaymentPartition({ userScope: 'user-a', ownerRef: 'owner-a' });
  assert.equal(first, alipayPaymentPartition({ userScope: 'user-a', ownerRef: 'owner-a' }));
  assert.notEqual(first, alipayPaymentPartition({ userScope: 'user-b', ownerRef: 'owner-a' }));
  assert.notEqual(first, alipayPaymentPartition({ userScope: 'user-a', ownerRef: 'owner-b' }));
  assert.match(first, /^persist:wangzai-alipay-[a-f0-9]{40}$/u);
});

test('automatic-order normalization preserves submit and payment guards instead of dropping renderer settings', () => {
  const request = normalizeAutoOrderRequest({
    posting: 'POSTING-1',
    shopId: 'shop-1',
    sourceAccountId: 'purchase-account-a',
    expectedTotal: 47.6,
    maxPayPrice: 100,
    minProfit: 3,
    minProfitPercent: 8,
    verifiedProfit: 12,
    verifiedProfitPercent: 10,
    autoSubmitOrder: true,
    allowTogetherPay: true,
    paymentMode1688: 'protocol',
    skipPresale: true,
    existingOrderNumber: 'TB20260827001',
    sourceAccountLogin: 'buyer-a',
    receiver: { name: '张三', phone: '13800000000', detail: '测试路1号' },
    maxShippingFee: 20,
    allowSimilarSku: true,
    products: [
      {
        sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=10001',
        sourcePlatform: '拼多多',
        sourceSkuId: 'sku-a',
        sourceSkuName: '黑色 / 标准款',
        quantity: 1,
        expectedUnitPrice: 23.8,
      },
      {
        sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=10001',
        sourcePlatform: '拼多多',
        sourceSkuId: 'sku-a',
        sourceSkuName: '黑色 / 标准款',
        quantity: 1,
        expectedUnitPrice: 23.8,
      },
    ],
  });
  assert.equal(request.autoSubmitOrder, true);
  assert.equal(request.allowTogetherPay, true);
  assert.equal(request.paymentMode1688, 'protocol');
  assert.equal(request.skipPresale, true);
  assert.equal(request.verifiedProfit, 12);
  assert.equal(request.verifiedProfitPercent, 10);
  assert.equal(request.existingOrderNumber, 'TB20260827001');
  assert.equal(request.receiver.phone, '13800000000');
  assert.equal(request.maxShippingFee, 20);
  assert.equal(request.allowSimilarSku, true);
  assert.equal(request.products.length, 1);
  assert.equal(request.products[0].quantity, 2);
  assert.equal(request.expectedTotal, 47.6);
});

test('automatic-order normalization rejects several unrelated source SKUs instead of silently ordering only the first', () => {
  assert.throws(() => normalizeAutoOrderRequest({
    posting: 'POSTING-2',
    shopId: 'shop-1',
    sourceAccountId: 'purchase-account-a',
    products: [
      {
        sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=10001',
        sourcePlatform: '拼多多',
        sourceSkuId: 'sku-a',
        sourceSkuName: '黑色',
        quantity: 1,
        expectedUnitPrice: 20,
      },
      {
        sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=10002',
        sourcePlatform: '拼多多',
        sourceSkuId: 'sku-b',
        sourceSkuName: '白色',
        quantity: 1,
        expectedUnitPrice: 30,
      },
    ],
  }), /PURCHASE_AUTO_ORDER_MULTI_PRODUCT_UNSUPPORTED/u);
});

test('manual Alipay login imports the PDD account cookies and opens its pending-order page', async () => {
  const fixture = createFixture();
  const opened = await fixture.controller.openLogin({
    sourceTabId: 'manual-login-account-a',
    ownerRef: 'purchase-account-a',
    accountId: 'purchase-account-a',
    purchaseUrl: 'https://mobile.yangkeduo.com/orders.html?type=1',
    cookies: [{ name: 'PDDAccessToken', value: 'fixture-token', domain: '.yangkeduo.com', path: '/', secure: true }],
  });
  assert.equal(opened.reused, false);
  assert.equal(FakeBrowserWindow.instances[0].loadedUrls[0], 'https://mobile.yangkeduo.com/orders.html?type=1');
  assert.equal(fixture.partitions.get(opened.partition).cookieWrites[0].name, 'PDDAccessToken');
  assert.match(opened.partition, /^persist:wangzai-alipay-/u);
  fixture.controller.dispose();
});

test('prewarmed PDD payment window stays hidden and manual login reuses it immediately', async () => {
  const fixture = createFixture();
  const input = {
    sourceTabId: 'payment-login-account-a',
    ownerRef: 'purchase-account-a',
    accountId: 'purchase-account-a',
    purchaseUrl: 'https://mobile.yangkeduo.com/orders.html?type=1',
    cookies: [{ name: 'PDDAccessToken', value: 'fixture-token', domain: '.yangkeduo.com', path: '/', secure: true }],
  };
  const prewarmed = await fixture.controller.prewarmLogin(input);
  const paymentWindow = FakeBrowserWindow.instances[0];
  assert.equal(prewarmed.reused, false);
  assert.equal(paymentWindow.visible, false);
  const opened = await fixture.controller.openLogin({ ...input, cookies: [] });
  assert.equal(opened.reused, true);
  assert.equal(paymentWindow.visible, true);
  assert.equal(FakeBrowserWindow.instances.length, 1);
  fixture.controller.dispose();
});

test('PDD bootstrap and Alipay route use the same H5-sized window', async () => {
  const fixture = createFixture();
  await fixture.controller.openLogin({
    sourceTabId: 'payment-login-account-a',
    ownerRef: 'purchase-account-a',
    accountId: 'purchase-account-a',
    purchaseUrl: 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75',
  });
  const paymentWindow = FakeBrowserWindow.instances[0];
  assert.equal(paymentWindow.options.width, 520);
  assert.equal(paymentWindow.options.height, 800);
  paymentWindow.webContents.emit(
    'will-navigate',
    { preventDefault: () => undefined },
    'https://mclient.alipay.com/h5pay/cashierPreConfirm/index.html?token=fixture',
  );
  assert.equal(paymentWindow.bounds.width, 520);
  assert.equal(paymentWindow.bounds.height, 800);
  fixture.controller.dispose();
});

test('Taobao and 1688 payment windows use the enlarged marketplace size through Alipay navigation', async () => {
  const cases = [
    {
      platform: '淘宝',
      purchaseUrl: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?tabCode=waitPay',
    },
    {
      platform: '1688',
      purchaseUrl: 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?tradeStatus=waitbuyerpay&page=1&pageSize=10',
    },
  ];
  for (const [index, input] of cases.entries()) {
    const fixture = createFixture({ workArea: { x: 0, y: 0, width: 1920, height: 1160 } });
    await fixture.controller.openLogin({
      sourceTabId: `payment-login-marketplace-${index}`,
      ownerRef: `purchase-account-marketplace-${index}`,
      accountId: `purchase-account-marketplace-${index}`,
      platform: input.platform,
      purchaseUrl: input.purchaseUrl,
    });
    const paymentWindow = FakeBrowserWindow.instances[0];
    assert.equal(paymentWindow.options.width, 1332);
    assert.equal(paymentWindow.options.height, 843);
    paymentWindow.webContents.emit(
      'will-navigate',
      { preventDefault: () => undefined },
      'https://mclient.alipay.com/h5pay/cashierPreConfirm/index.html?token=fixture',
    );
    assert.equal(paymentWindow.bounds.width, 1332);
    assert.equal(paymentWindow.bounds.height, 843);
    fixture.controller.dispose();
  }
});

test('marketplace Electron shell becomes visible before a slow remote page finishes loading', async () => {
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  const fixture = createFixture({ loadGate });
  const opening = fixture.controller.openLogin({
    sourceTabId: 'payment-login-fast-taobao',
    ownerRef: 'purchase-account-fast-taobao',
    accountId: 'purchase-account-fast-taobao',
    platform: '淘宝',
    purchaseUrl: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?tabCode=waitPay',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const paymentWindow = FakeBrowserWindow.instances[0];
  assert.equal(paymentWindow.visible, true);
  assert.equal(paymentWindow.loadedUrls.length, 1);
  releaseLoad();
  await opening;
  fixture.controller.dispose();
});

test('late CEF cookies enter the existing account partition and refresh the visible marketplace page once', async () => {
  const fixture = createFixture();
  const opened = await fixture.controller.openLogin({
    sourceTabId: 'payment-login-cookie-sync',
    ownerRef: 'purchase-account-cookie-sync',
    accountId: 'purchase-account-cookie-sync',
    platform: '1688',
    purchaseUrl: 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?tradeStatus=waitbuyerpay&page=1&pageSize=10',
  });
  const paymentWindow = FakeBrowserWindow.instances[0];
  const result = await fixture.controller.syncLoginCookies({
    sourceTabId: 'payment-login-cookie-sync',
    ownerRef: 'purchase-account-cookie-sync',
    cookies: [{ name: '_m_h5_tk', value: 'fixture-token', domain: '.1688.com', path: '/', secure: true }],
  });
  assert.equal(result.importedCookieCount, 1);
  assert.equal(fixture.partitions.get(opened.partition).cookieWrites[0].name, '_m_h5_tk');
  assert.equal(paymentWindow.webContents.reloadCount, 1);
  fixture.controller.dispose();
});

test('payment login status reads the real Electron partition instead of credential configuration', async () => {
  const fixture = createFixture();
  const input = {
    sourceTabId: 'payment-login-real-status',
    ownerRef: 'purchase-account-real-status',
    accountId: 'purchase-account-real-status',
    platform: '淘宝',
    purchaseUrl: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?tabCode=waitPay',
  };
  await fixture.controller.openLogin(input);
  const before = await fixture.controller.getLoginStatus(input);
  assert.equal(before.loggedIn, false);
  await fixture.controller.syncLoginCookies({
    sourceTabId: input.sourceTabId,
    ownerRef: input.ownerRef,
    cookies: [
      { name: 'unb', value: 'fixture-user', domain: '.taobao.com', path: '/', secure: true },
      { name: '_tb_token_', value: 'fixture-session', domain: '.taobao.com', path: '/', secure: true },
      { name: 'ALIPAY_WAP_CASHIER_COOKIE', value: 'fixture-alipay', domain: '.alipay.com', path: '/', secure: true },
    ],
  });
  const after = await fixture.controller.getLoginStatus(input);
  assert.equal(after.loggedIn, true);
  assert.equal(after.marketplaceLoggedIn, true);
  assert.equal(after.alipayLoggedIn, true);
  assert.equal(after.verificationSource, 'electron-marketplace-and-alipay-cookie');
  fixture.controller.dispose();
});

test('shared Alipay login accepts SMS completion and synchronizes the persistent session to every purchase owner', async () => {
  const fixture = createFixture();
  const opened = await fixture.controller.openSharedLogin({ loginAccount: '13800000000', loginPassword: '' });
  assert.equal(opened.platform, '支付宝');
  const sharedWindow = FakeBrowserWindow.instances[0];
  assert.equal(sharedWindow.loadedUrls[0], 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75');
  assert.equal(sharedWindow.options.width, 1000);
  assert.equal(sharedWindow.options.height, 800);
  let status = await fixture.controller.getSharedLoginStatus();
  assert.equal(status.loggedIn, false);

  await fixture.controller.syncLoginCookies({
    ownerRef: 'shared:alipay-login',
    cookies: [{ name: 'ALIPAY_WAP_CASHIER_COOKIE', value: 'sms-login-session', domain: '.alipay.com', path: '/', secure: true }],
  });
  sharedWindow.webContents.currentUrl = 'https://www.alipay.com/';
  status = await fixture.controller.getSharedLoginStatus();
  assert.equal(status.loggedIn, true);
  const synced = await fixture.controller.syncSharedLoginToOwners(['pdd-owner', 'taobao-owner', '1688-owner']);
  assert.equal(synced.syncedOwnerCount, 3);
  assert.equal(synced.loggedIn, true);
  fixture.controller.dispose();
});

test('cookie sync never reloads while the first marketplace loadURL is still pending', async () => {
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  const fixture = createFixture({ loadGate });
  const opening = fixture.controller.openLogin({
    sourceTabId: 'payment-login-cookie-race',
    ownerRef: 'purchase-account-cookie-race',
    accountId: 'purchase-account-cookie-race',
    platform: '淘宝',
    purchaseUrl: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?tabCode=waitPay',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const paymentWindow = FakeBrowserWindow.instances[0];
  const syncing = fixture.controller.syncLoginCookies({
    sourceTabId: 'payment-login-cookie-race',
    ownerRef: 'purchase-account-cookie-race',
    cookies: [{ name: '_tb_token_', value: 'fixture-token', domain: '.taobao.com', path: '/', secure: true }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(paymentWindow.webContents.reloadCount || 0, 0);
  releaseLoad();
  await Promise.all([opening, syncing]);
  assert.equal(paymentWindow.webContents.reloadCount, 1);
  fixture.controller.dispose();
});

test('user close hides the persistent payment window and show restores the same instance', async () => {
  const fixture = createFixture();
  await fixture.controller.openLogin({
    sourceTabId: 'payment-login-account-a',
    ownerRef: 'purchase-account-a',
    accountId: 'purchase-account-a',
    purchaseUrl: 'https://mobile.yangkeduo.com/orders.html?type=1',
    cookies: [{ name: 'PDDAccessToken', value: 'fixture-token', domain: '.yangkeduo.com', path: '/', secure: true }],
  });
  const paymentWindow = FakeBrowserWindow.instances[0];
  paymentWindow.close();
  assert.equal(paymentWindow.destroyed, false);
  assert.equal(paymentWindow.visible, false);
  assert.equal(fixture.controller.snapshot().windows.length, 1);
  const restored = fixture.controller.show();
  assert.equal(restored.shown, true);
  assert.equal(paymentWindow.visible, true);
  assert.equal(FakeBrowserWindow.instances.length, 1);
  fixture.controller.dispose();
});

test('official success is only a candidate and closes after PDD readback verifies payment', async () => {
  const fixture = createFixture();
  const paymentUrl = 'https://mclient.alipay.com/h5pay/cashierPreConfirm/index.html?token=secret';
  const opened = await fixture.controller.open({
    paymentUrl,
    sourceTabId: 'tab-pdd',
    ownerRef: 'owner-pdd',
    accountId: 'account-pdd',
    targetHash: 'a'.repeat(64),
  });
  assert.equal(opened.reused, false);
  const paymentWindow = FakeBrowserWindow.instances[0];
  fixture.ipcMain.emit('wangzai:alipay-page-state', { sender: paymentWindow.webContents }, {
    pathname: '/h5pay/cashierActivity/index.html',
    stage: 'result',
    candidateSuccess: true,
    message: '支付成功',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.verifications.length, 1);
  assert.equal(paymentWindow.destroyed, true);
  assert.ok(fixture.events.some((event) => event.event === 'alipay-payment-verified'));
  assert.equal(fixture.controller.snapshot().windows.length, 0);
  fixture.controller.dispose();
});

test('unverified PDD payment keeps the Alipay window and account removal clears its session', async () => {
  const fixture = createFixture({ verificationResult: { paymentVerified: false, readbackVerified: false } });
  const paymentUrl = 'https://mclient.alipay.com/h5pay/pwdValidate/index.html?token=secret';
  const opened = await fixture.controller.open({
    paymentUrl,
    sourceTabId: 'tab-pdd',
    ownerRef: 'owner-pdd',
  });
  const paymentWindow = FakeBrowserWindow.instances[0];
  fixture.ipcMain.emit('wangzai:alipay-page-state', { sender: paymentWindow.webContents }, {
    pathname: '/h5pay/cashierActivity/index.html',
    stage: 'result',
    candidateSuccess: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(paymentWindow.destroyed, false);
  assert.ok(fixture.events.some((event) => event.event === 'alipay-payment-pending'));

  await fixture.controller.purgeOwner('owner-pdd');
  const persistentSession = fixture.partitions.get(opened.partition);
  assert.equal(paymentWindow.destroyed, true);
  assert.equal(persistentSession.clearStorageCalls, 1);
  assert.equal(persistentSession.clearCacheCalls, 1);
  assert.equal(persistentSession.flushCalls, 1);
  fixture.controller.dispose();
});

test('captcha or password failure pauses automation instead of continuing to submit', async () => {
  const fixture = createFixture();
  await fixture.controller.open({
    paymentUrl: 'https://mclient.alipay.com/h5pay/pwdValidate/index.html?token=manual',
    sourceTabId: 'tab-manual',
    ownerRef: 'owner-pdd',
  });
  const paymentWindow = FakeBrowserWindow.instances[0];
  fixture.ipcMain.emit('wangzai:alipay-page-state', { sender: paymentWindow.webContents }, {
    pathname: '/h5pay/cashierSafeProtectSms/index.html',
    stage: 'security-sms',
    requiresManualVerification: true,
    message: '需要人工验证',
  });
  assert.equal(fixture.verifications.length, 0);
  assert.equal(paymentWindow.destroyed, false);
  assert.ok(fixture.events.some((event) => event.event === 'alipay-payment-paused'));
  fixture.controller.dispose();
});

test('a stable Alipay success page keeps rechecking PDD until paid readback is available', async () => {
  const fixture = createFixture({
    pendingRetryMs: 10,
    verificationResult: (attempt) => attempt >= 2
      ? { paymentVerified: true, readbackVerified: true }
      : { paymentVerified: false, readbackVerified: false },
  });
  await fixture.controller.open({
    paymentUrl: 'https://mclient.alipay.com/h5pay/cashierPreConfirm/index.html?token=eventual',
    sourceTabId: 'tab-eventual',
    ownerRef: 'owner-pdd',
  });
  const paymentWindow = FakeBrowserWindow.instances[0];
  fixture.ipcMain.emit('wangzai:alipay-page-state', { sender: paymentWindow.webContents }, {
    pathname: '/h5pay/cashierActivity/index.html',
    stage: 'result',
    candidateSuccess: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 560));
  assert.equal(fixture.verifications.length, 2);
  assert.equal(paymentWindow.destroyed, true);
  assert.ok(fixture.events.some((event) => event.event === 'alipay-payment-pending'));
  assert.ok(fixture.events.some((event) => event.event === 'alipay-payment-verified'));
  fixture.controller.dispose();
});

test('one PDD tab reuses one payment window and blocks non-Alipay navigation', async () => {
  const fixture = createFixture();
  const base = {
    sourceTabId: 'tab-pdd',
    ownerRef: 'owner-pdd',
  };
  await fixture.controller.open({
    ...base,
    paymentUrl: 'https://mclient.alipay.com/h5pay/cashierPreConfirm/index.html?token=one',
  });
  const reused = await fixture.controller.open({
    ...base,
    paymentUrl: 'https://mclient.alipay.com/h5pay/pwdValidate/index.html?token=two',
  });
  assert.equal(reused.reused, true);
  assert.equal(FakeBrowserWindow.instances.length, 1);
  const paymentWindow = FakeBrowserWindow.instances[0];
  let prevented = false;
  paymentWindow.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://evil.test/pay');
  assert.equal(prevented, true);
  assert.deepEqual(paymentWindow.webContents.openHandler({ url: 'https://evil.test/pay' }), { action: 'deny' });
  fixture.controller.dispose();
});

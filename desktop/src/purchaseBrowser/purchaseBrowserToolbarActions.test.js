import assert from 'node:assert/strict';
import test from 'node:test';
import { createPurchaseBrowserToolbarActionHandler } from './purchaseBrowserToolbarActions.js';

test('charge toolbar preserves network failure instead of asking the user to log in', async () => {
  const f = createFixture({ withCharges: true, activeUrl: 'https://www.kuajing84.com/index/finance/record_consume.html' });
  const dispatch = f.controller.dispatch.bind(f.controller);
  f.controller.dispatch = input => input.command === 'cross-border-charges'
    ? Promise.resolve({ ok: true, result: { ok: false, loggedIn: false, code: 'CROSS_BORDER_NETWORK_FAILED' } }) : dispatch(input);
  await assert.rejects(f.handler.handle({ action: 'cross-border-charges-save', tabId: 'tab-a' }), { code: 'CROSS_BORDER_NETWORK_FAILED' });
});

test('requested detail completeness remains visible through preview and save', async () => {
  const f = createFixture({ withCharges: true, activeUrl: 'https://www.kuajing84.com/index/finance/record_consume.html' });
  const dispatch = f.controller.dispatch.bind(f.controller);
  const coverage = { requested: true, total: 205, completed: 204, failed: 1, complete: false };
  f.controller.dispatch = async input => {
    const result = await dispatch(input);
    if (input.command === 'cross-border-charges') result.result.detailCoverage = coverage;
    return result;
  };
  const preview = await f.handler.handle({ action: 'cross-border-charges-save', tabId: 'tab-a', payload: { includeDetails: true } });
  assert.deepEqual(preview.preview.detailCoverage, coverage);
  const saved = await f.handler.handle({ action: 'cross-border-charges-confirm', tabId: 'tab-a', payload: { confirmationToken: preview.toolbar.dialog.confirmationToken } });
  assert.deepEqual(saved.toolbar.dialog.result.detailCoverage, coverage);
});

function createFixture({
  activeUrl = 'https://www.1688.com/',
  loggedIn = true,
  packageCount = 1,
  withCharges = false,
  onCollectionPricingCapture,
  onCrossBorderChargesCommitted,
} = {}) {
  const calls = [];
  const states = new Map([
    ['tab-a', {
      tabId: 'tab-a',
      accountId: 'account-a',
      storageRef: 'a'.repeat(40),
      url: activeUrl,
      extension: { installState: 'active', extensionVersion: '4.0.1' },
      target: { targetId: 'target-a', shopId: 'shop-a', orderKey: 'order-a' },
    }],
    ['tab-b', {
      tabId: 'tab-b',
      accountId: 'account-b',
      url: 'https://www.taobao.com/',
      extension: { installState: 'active', extensionVersion: '4.0.1' },
      target: { targetId: 'target-b', shopId: 'shop-b', orderKey: 'order-b' },
    }],
  ]);
  let activeTabId = 'tab-a';
  let lastSync = null;
  const controller = {
    snapshot: () => ({ ok: true, activeTabId, tabs: [...states.values()] }),
    async dispatch(input) {
      calls.push(input);
      if (input.command === 'open') {
        activeTabId = input.accountId === 'account-b' ? 'tab-b' : 'tab-a';
        states.get(activeTabId).url = input.url;
        return this.snapshot();
      }
      if (input.command === 'navigate') {
        states.get(input.tabId).url = input.url;
        return this.snapshot();
      }
      if (input.command === 'cross-border-login-status') {
        return { ok: true, result: { loggedIn }, state: this.snapshot() };
      }
      if (input.command === 'cross-border-charges') {
        return {
          ok: true,
          result: {
            loggedIn,
            browserAccountRef: 'a'.repeat(40),
            userCode: 'bus-user-a',
            selectedPageUrl: input.payload.pageUrl,
            pagination: {
              complete: true,
              chargePagesRead: 110,
              chargeRawRowCount: 1096,
              chargeUniqueRowCount: 1096,
              chargeExpectedTotal: 1096,
            },
            charges: [{ oid: '774986', type: 'expense', money: '1.50', time: '2026-07-28 10:00:00' }],
            orders: [{ id: 'bus-order-774986', order_id: '774986', order_number: '0123640791-0163-1' }],
          },
          state: this.snapshot(),
        };
      }
      if (input.command === 'purchase-context') {
        return {
          ok: true,
          target: states.get(input.tabId).target,
          context: { purchaseOrderNumber: `${input.tabId}-purchase-order` },
          state: this.snapshot(),
        };
      }
      if (input.command === 'cross-border-orders') {
        const targetOrderKey = states.get(input.tabId).target?.orderKey || '';
        return {
          ok: true,
          result: {
            orders: Array.from({ length: packageCount }, (_, index) => ({
              orderId: `${input.tabId}-order`,
              packId: packageCount > 1 ? `${input.tabId}-pack-${index + 1}` : '',
              orderKey: targetOrderKey,
            })),
          },
          state: this.snapshot(),
        };
      }
      if (input.command === 'cross-border-sync') {
        const results = Array.from({ length: packageCount }, (_, index) => ({
          orderId: `${input.tabId}-order`,
          packId: packageCount > 1 ? `${input.tabId}-pack-${index + 1}` : '',
          ok: true,
          status: input.payload.commit ? '已同步' : '待同步',
          logistics: {
            trackingNumber: `${input.tabId}-tracking-${index + 1}`,
            carrierName: '中通',
          },
        }));
        lastSync = {
          ok: true,
          loggedIn,
          commit: input.payload.commit,
          total: packageCount,
          synced: input.payload.commit ? packageCount : 0,
          finishedAt: input.payload.commit ? '2026-07-18T01:00:00Z' : '2026-07-18T00:59:00Z',
          results,
        };
        return { ok: true, result: lastSync, state: this.snapshot() };
      }
      if (input.command === 'cross-border-status') {
        return { ok: true, result: { login: { loggedIn }, lastSync }, state: this.snapshot() };
      }
      if (input.command === 'inspect') {
        return {
          ok: true,
          inspection: {
            extensionVersion: '4.0.1',
            runtimeKind: 'builtin',
            platform: '1688',
            pageUrl: states.get(input.tabId).url,
            pageTitle: '1688 商品详情',
            productTitle: '测试商品',
            viewport: { innerWidth: 1200, innerHeight: 800 },
          },
          state: this.snapshot(),
        };
      }
      if (input.command === 'clear-target') {
        states.get(input.tabId).target = null;
        return { ok: true, target: null, state: this.snapshot() };
      }
      if (input.command === 'capture-preview') {
        return {
          ok: true,
          capture: { platform: '1688', purchaseOrderNumber: 'purchase-a', purchasePrice: 12.3 },
          preview: {
            previewId: 'preview-a',
            confirmationToken: 'capture-token-a',
            missingFields: [],
            conflicts: [],
          },
          state: this.snapshot(),
        };
      }
      if (input.command === 'capture-purchase') {
        return {
          ok: true,
          capture: {
            platform: '1688',
            sourceUrl: states.get(input.tabId).url,
            sourceProductId: '1688-product-a',
            productTitle: '采集到操作台商品',
            purchasePrice: 12.3,
            currency: 'CNY',
          },
          state: this.snapshot(),
        };
      }
      if (input.command === 'capture-confirm') {
        assert.equal(input.confirmationToken, 'capture-token-a');
        return { ok: true, result: { readbackVerified: true }, state: this.snapshot() };
      }
      return this.snapshot();
    },
  };
  const handler = createPurchaseBrowserToolbarActionHandler({
    getController: () => controller,
    getLocalApiClient: () => withCharges ? {
      async previewCrossBorderCharges(body) {
        assert.equal(body.browserAccountRef, 'a'.repeat(40));
        assert.equal(body.shopId, undefined, 'one cross-border account must match every bound shop');
        return {
          ok: true,
          previewId: 'charge-preview-a',
          confirmationToken: 'charge-token-a',
          expiresAt: '2099-01-01T00:00:00.000Z',
          summary: { statementCount: 1, orderCount: 1, exactCount: 1, unmatchedCount: 0, ambiguousCount: 0, exactActualFeeCny: 1.5 },
          rows: [{ collectionNumber: '774986', postingNumber: '0123640791-0163-1', actualFeeCny: 1.5 }],
        };
      },
      async confirmCrossBorderCharges(body) {
        assert.deepEqual(body, { previewId: 'charge-preview-a', confirmationToken: 'charge-token-a' });
        return { ok: true, readbackVerified: true, committed: true, savedOrderCount: 1, exactCount: 1 };
      },
    } : null,
    onCollectionPricingCapture: onCollectionPricingCapture || (async () => ({ delivered: true })),
    onCrossBorderChargesCommitted: onCrossBorderChargesCommitted || (async () => ({ delivered: true })),
    now: () => 1000,
    createConfirmationToken: () => 'confirmation-a',
  });
  return { calls, controller, handler };
}

test('workbench title toolbar targets the exact tab and keeps Pinduoduo shortcuts platform-bound', async () => {
  const fixture = createFixture({ activeUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=1' });
  await fixture.handler.handle({ action: 'pinduoduo-orders', tabId: 'tab-a' });
  assert.deepEqual(fixture.calls.at(-1), {
    command: 'navigate',
    tabId: 'tab-a',
    url: 'https://mobile.yangkeduo.com/orders.html',
  });

  await fixture.handler.handle({ action: 'browser-extensions', tabId: 'tab-a' });
  assert.deepEqual(fixture.calls.at(-1), { command: 'open-extension-manager', tabId: 'tab-a' });

  await assert.rejects(
    fixture.handler.handle({ action: 'pinduoduo-home', tabId: 'tab-b' }),
    { code: 'PURCHASE_BROWSER_PINDUODUO_PAGE_REQUIRED' },
  );
});

test('toolbar exposes the built-in Wangzai plugin separately from cross-border tools', async () => {
  const fixture = createFixture();
  const status = await fixture.handler.handle({ action: 'wangzai-status' });
  assert.equal(status.toolbar.dialog.kind, 'wangzai-status');
  assert.deepEqual(status.toolbar.dialog.result, {
    enabled: true,
    version: '4.0.1',
    runtimeKind: 'builtin',
    connectionMode: '内置在当前浏览器窗口，无需单独安装图标',
    capabilities: '插件状态、识别当前页面',
    safety: '只读；不自动保存货源、不下单、不写 Ozon',
    pageUrl: 'https://www.1688.com/',
  });
  assert.equal(fixture.calls.length, 0, 'plugin status reads the existing isolated tab state');

  const inspection = await fixture.handler.handle({ action: 'wangzai-inspect' });
  assert.equal(inspection.toolbar.dialog.kind, 'wangzai-inspect');
  assert.equal(inspection.toolbar.dialog.result.productTitle, '测试商品');
  assert.equal('viewport' in inspection.toolbar.dialog.result, false);
  assert.deepEqual(fixture.calls, [{ command: 'inspect', tabId: 'tab-a' }]);
});

test('toolbar can reopen a failed launch after the controller removed the half-created tab', async () => {
  const calls = [];
  const controller = {
    snapshot: () => ({ ok: true, activeTabId: '', tabs: [] }),
    async dispatch(input) {
      calls.push(input);
      return {
        ok: true,
        activeTabId: 'tab-reopened',
        tabs: [],
      };
    },
  };
  const handler = createPurchaseBrowserToolbarActionHandler({
    getController: () => controller,
  });
  const result = await handler.handle({
    action: 'retry-open',
    payload: { accountId: 'account-a', url: 'https://www.1688.com/' },
  });
  assert.equal(result.activeTabId, 'tab-reopened');
  assert.deepEqual(calls, [{
    command: 'open',
    accountId: 'account-a',
    url: 'https://www.1688.com/',
  }]);
  await assert.rejects(
    handler.handle({ action: 'reopen-browser' }),
    { code: 'PURCHASE_BROWSER_WINDOW_INVALID' },
  );
});

test('toolbar verifies, persists and publishes purchase login before asking native CEF to auto-close', async () => {
  const calls = [];
  const published = [];
  const controller = {
    snapshot: () => ({
      ok: true,
      activeTabId: 'tab-login-a',
      tabs: [{ tabId: 'tab-login-a', accountId: 'account-a', url: 'https://www.1688.com/' }],
    }),
    async dispatch(input) {
      calls.push(input);
      return {
        ok: true,
        result: {
          loggedIn: true,
          cookieSaved: true,
          cookieCount: 6,
          platformKey: '1688',
          verificationSource: 'strong-auth-cookie',
          verifiedAt: '2026-08-11T08:30:00.000Z',
        },
        state: this.snapshot(),
      };
    },
  };
  const handler = createPurchaseBrowserToolbarActionHandler({
    getController: () => controller,
    getLocalApiClient: () => ({
      async savePurchaseAccountLoginStatus(accountId, body) {
        assert.equal(accountId, 'account-a');
        assert.equal(body.loggedIn, true);
        assert.equal(body.cookieSaved, true);
        return {
          ok: true,
          account: {
            id: accountId,
            cookieStatus: 'Cookie 已保存',
            lastLoginVerifiedAt: body.verifiedAt,
          },
        };
      },
    }),
    onPurchaseLoginSaved: async (payload) => published.push(payload),
  });

  const result = await handler.handle({ action: 'purchase-login-save' });

  assert.deepEqual(calls, [{ command: 'purchase-login-status', tabId: 'tab-login-a' }]);
  assert.equal(result.toolbar.dialog.kind, 'purchase-login-saved');
  assert.equal(result.toolbar.dialog.autoClose, true);
  assert.equal(published.length, 1);
  assert.equal(published[0].account.cookieStatus, 'Cookie 已保存');
});

test('toolbar keeps the login window open when no strong authenticated session is present', async () => {
  let persisted = false;
  const controller = {
    snapshot: () => ({
      ok: true,
      activeTabId: 'tab-login-a',
      tabs: [{ tabId: 'tab-login-a', accountId: 'account-a', url: 'https://login.taobao.com/' }],
    }),
    async dispatch() {
      return {
        ok: true,
        result: { loggedIn: false, cookieSaved: false, verificationSource: 'login-page' },
        state: this.snapshot(),
      };
    },
  };
  const handler = createPurchaseBrowserToolbarActionHandler({
    getController: () => controller,
    getLocalApiClient: () => ({
      async savePurchaseAccountLoginStatus() { persisted = true; },
    }),
  });

  const result = await handler.handle({ action: 'purchase-login-save' });

  assert.equal(result.toolbar.dialog.kind, 'purchase-login-save-failed');
  assert.equal(result.toolbar.dialog.autoClose, undefined);
  assert.equal(persisted, false);
});

test('built-in cross-border login is verified without writing a fake purchase account owner', async () => {
  const calls = [];
  let purchaseAccountWriteAttempted = false;
  const controller = {
    snapshot: () => ({
      ok: true,
      activeTabId: 'tab-cross-border-login',
      tabs: [{
        tabId: 'tab-cross-border-login',
        accountId: 'builtin-cross-border-logistics',
        ownerType: 'builtin_cross_border_profile',
        url: 'https://www.kuajing84.com/',
      }],
    }),
    async dispatch(input) {
      calls.push(input);
      return {
        ok: true,
        result: { loggedIn: true, userCode: '557816' },
        state: this.snapshot(),
      };
    },
  };
  const handler = createPurchaseBrowserToolbarActionHandler({
    getController: () => controller,
    getLocalApiClient: () => ({
      async savePurchaseAccountLoginStatus() {
        purchaseAccountWriteAttempted = true;
      },
    }),
  });

  const result = await handler.handle({ action: 'purchase-login-save' });

  assert.deepEqual(calls, [{ command: 'cross-border-login-status', tabId: 'tab-cross-border-login' }]);
  assert.equal(purchaseAccountWriteAttempted, false);
  assert.equal(result.toolbar.dialog.kind, 'purchase-login-saved');
  assert.equal(result.toolbar.dialog.title, '跨境巴士登录已确认');
  assert.equal(result.toolbar.dialog.autoClose, true);
});

test('built-in cross-border toolbar opens keep the dedicated owner type', async () => {
  const calls = [];
  const state = {
    ok: true,
    activeTabId: 'tab-cross-border-login',
    tabs: [{
      tabId: 'tab-cross-border-login',
      accountId: 'builtin-cross-border-logistics',
      ownerType: 'builtin_cross_border_profile',
      url: 'https://www.kuajing84.com/',
    }],
  };
  const controller = {
    snapshot: () => state,
    async dispatch(input) {
      calls.push(input);
      return state;
    },
  };
  const handler = createPurchaseBrowserToolbarActionHandler({ getController: () => controller });

  await handler.handle({ action: 'cross-border-charges-open' });

  assert.deepEqual(calls, [{
    command: 'open',
    accountId: 'builtin-cross-border-logistics',
    ownerType: 'builtin_cross_border_profile',
    url: 'https://www.kuajing84.com/',
  }]);
});

test('toolbar saves an Ozon seller login through the integration profile and closes only after readback', async () => {
  const calls = [];
  const controller = {
    snapshot: () => ({
      ok: true,
      activeTabId: 'tab-ozon-login',
      tabs: [{
        tabId: 'tab-ozon-login',
        accountId: 'integration-ozon-a',
        ownerType: 'integration_profile',
        url: 'https://seller.ozon.ru/app/dashboard/main',
      }],
    }),
    async dispatch(input) {
      calls.push(input);
      return {
        ok: true,
        result: {
          loggedIn: true,
          cookieSaved: true,
          verifiedAt: '2026-08-12T03:20:00.000Z',
          profile: {
            id: 'integration-ozon-a',
            configStatus: '连接成功',
            tokenStatus: 'Cookie 已保存',
          },
        },
        state: this.snapshot(),
      };
    },
  };
  let purchaseAccountWriteAttempted = false;
  const handler = createPurchaseBrowserToolbarActionHandler({
    getController: () => controller,
    getLocalApiClient: () => ({
      async savePurchaseAccountLoginStatus() {
        purchaseAccountWriteAttempted = true;
      },
    }),
  });

  const result = await handler.handle({ action: 'purchase-login-save' });

  assert.deepEqual(calls, [{
    command: 'ozon-login-status',
    tabId: 'tab-ozon-login',
    persistStatus: true,
  }]);
  assert.equal(purchaseAccountWriteAttempted, false);
  assert.equal(result.toolbar.dialog.kind, 'purchase-login-saved');
  assert.equal(result.toolbar.dialog.title, 'Ozon 账号已保存');
  assert.equal(result.toolbar.dialog.autoClose, true);
  assert.equal(result.profile.tokenStatus, 'Cookie 已保存');
});

test('toolbar keeps the Ozon seller login window open until live verification succeeds', async () => {
  const controller = {
    snapshot: () => ({
      ok: true,
      activeTabId: 'tab-ozon-login',
      tabs: [{
        tabId: 'tab-ozon-login',
        accountId: 'integration-ozon-a',
        ownerType: 'integration_profile',
        url: 'https://seller.ozon.ru/app/registration/signin',
      }],
    }),
    async dispatch() {
      return {
        ok: true,
        result: {
          loggedIn: false,
          cookieSaved: false,
          verificationSource: 'login-page',
        },
        state: this.snapshot(),
      };
    },
  };
  const handler = createPurchaseBrowserToolbarActionHandler({ getController: () => controller });

  const result = await handler.handle({ action: 'purchase-login-save' });

  assert.equal(result.toolbar.dialog.kind, 'purchase-login-save-failed');
  assert.equal(result.toolbar.dialog.autoClose, undefined);
});

test('toolbar saves a verified Ozon Cookie while exact shop identity is still pending', async () => {
  const controller = {
    snapshot: () => ({
      ok: true,
      activeTabId: 'tab-ozon-login',
      tabs: [{
        tabId: 'tab-ozon-login',
        accountId: 'integration-ozon-a',
        ownerType: 'integration_profile',
        url: 'https://seller.ozon.ru/app/dashboard/main',
      }],
    }),
    async dispatch() {
      return {
        ok: true,
        result: {
          loggedIn: true,
          cookieSaved: true,
          verifiedAt: '2026-08-16T01:20:00.000Z',
          profile: {
            id: 'integration-ozon-a',
            configStatus: '等待账号识别',
            tokenStatus: 'Cookie 已保存',
            identityStatus: 'unverified',
          },
        },
        state: this.snapshot(),
      };
    },
  };
  const handler = createPurchaseBrowserToolbarActionHandler({ getController: () => controller });

  const result = await handler.handle({ action: 'purchase-login-save' });

  assert.equal(result.toolbar.dialog.kind, 'purchase-login-identity-pending');
  assert.equal(result.toolbar.dialog.title, 'Ozon 登录已保存');
  assert.equal(result.toolbar.dialog.autoClose, true);
  assert.equal(result.toolbar.dialog.result.cookieStatus, 'Cookie 已保存');
  assert.equal(result.toolbar.dialog.result.identityStatus, 'unverified');
});

test('toolbar reports an exact Ozon shop mismatch without closing the login window', async () => {
  const controller = {
    snapshot: () => ({
      ok: true,
      activeTabId: 'tab-ozon-login',
      tabs: [{
        tabId: 'tab-ozon-login',
        accountId: 'integration-ozon-a',
        ownerType: 'integration_profile',
        url: 'https://seller.ozon.ru/app/dashboard/main',
      }],
    }),
    async dispatch() {
      return {
        ok: true,
        result: {
          loggedIn: true,
          cookieSaved: true,
          verifiedAt: '2026-08-16T01:21:00.000Z',
          profile: {
            id: 'integration-ozon-a',
            configStatus: '账号不匹配',
            tokenStatus: 'Cookie 已保存',
            identityStatus: 'mismatch',
            browserCompanyId: '111111',
            apiIdentityId: '222222',
          },
        },
        state: this.snapshot(),
      };
    },
  };
  const handler = createPurchaseBrowserToolbarActionHandler({ getController: () => controller });

  const result = await handler.handle({ action: 'purchase-login-save' });

  assert.equal(result.toolbar.dialog.kind, 'purchase-login-shop-mismatch');
  assert.equal(result.toolbar.dialog.autoClose, undefined);
  assert.equal(result.toolbar.dialog.result.browserCompanyId, '111111');
  assert.equal(result.toolbar.dialog.result.apiIdentityId, '222222');
});

test('toolbar reads orders and logistics through the existing commands for the active account only', async () => {
  const fixture = createFixture();
  const orders = await fixture.handler.handle({ action: 'cross-border-orders' });
  assert.equal(orders.result.orders[0].orderId, 'tab-a-order');
  const logistics = await fixture.handler.handle({ action: 'cross-border-logistics' });
  assert.equal(logistics.result.commit, false);
  assert.deepEqual(fixture.calls.map((call) => call.command), ['cross-border-orders', 'cross-border-sync']);
  assert.ok(fixture.calls.every((call) => call.tabId === 'tab-a'));
});

test('toolbar opens Kuajing84 in the same account and refreshes login/status commands', async () => {
  const fixture = createFixture();
  const opened = await fixture.handler.handle({ action: 'cross-border-open' });
  assert.equal(opened.tabs.find((tab) => tab.tabId === 'tab-a').url, 'https://www.kuajing84.com/');
  const login = await fixture.handler.handle({ action: 'cross-border-login-status' });
  assert.equal(login.toolbar.loggedIn, true);
  const status = await fixture.handler.handle({ action: 'cross-border-status' });
  assert.equal(status.toolbar.loggedIn, true);
  assert.deepEqual(fixture.calls.map((call) => call.command), [
    'open',
    'cross-border-login-status',
    'cross-border-status',
  ]);
  assert.equal(fixture.calls[0].accountId, 'account-a');
});

test('actual-charge entry opens Kuajing84 first and does not read or save anything early', async () => {
  const fixture = createFixture({ withCharges: true });

  const opened = await fixture.handler.handle({ action: 'cross-border-charges-open' });

  assert.equal(opened.toolbar.dialog.kind, 'cross-border-charges-opened');
  assert.equal(opened.tabs.find((tab) => tab.tabId === 'tab-a').url, 'https://www.kuajing84.com/');
  assert.deepEqual(fixture.calls, [{
    command: 'open',
    accountId: 'account-a',
    url: 'https://www.kuajing84.com/',
  }]);
});

test('save-effective reads the selected Kuajing84 page and confirms local readback for all shops', async () => {
  const committedEvents = [];
  const fixture = createFixture({
    withCharges: true,
    onCrossBorderChargesCommitted: async (payload) => committedEvents.push(payload),
  });
  await fixture.handler.handle({ action: 'cross-border-charges-open' });
  await fixture.handler.handle({
    action: 'navigate',
    payload: {
      url: 'https://www.kuajing84.com/index/finance/record_consume.html?time=2026-08&reason=%E8%BF%90%E8%B4%B9',
    },
  });
  const preview = await fixture.handler.handle({ action: 'cross-border-charges-save' });
  assert.equal(preview.toolbar.dialog.kind, 'cross-border-charges-preview');
  assert.equal(preview.toolbar.dialog.confirmationAction, 'cross-border-charges-confirm');
  assert.equal(preview.toolbar.dialog.confirmationToken, 'charge-token-a');
  const readCall = fixture.calls.find((call) => call.command === 'cross-border-charges');
  assert.equal(
    readCall.payload.pageUrl,
    'https://www.kuajing84.com/index/finance/record_consume.html?time=2026-08&reason=%E8%BF%90%E8%B4%B9',
  );
  assert.equal(readCall.payload.time, '2026-08');
  assert.equal(readCall.payload.reason, '运费');
  assert.equal(readCall.payload.includeDetails, false);
  assert.equal(preview.preview.pagination.chargePagesRead, 110);
  assert.equal(preview.preview.pagination.chargeRawRowCount, 1096);
  await assert.rejects(
    fixture.handler.handle({ action: 'cross-border-charges-confirm', payload: { confirmationToken: 'wrong' } }),
    { code: 'CROSS_BORDER_CHARGE_CONFIRMATION_REQUIRED' },
  );
  const complete = await fixture.handler.handle({
    action: 'cross-border-charges-confirm',
    payload: { confirmationToken: 'charge-token-a' },
  });
  assert.equal(complete.toolbar.dialog.kind, 'cross-border-charges-complete');
  assert.equal(complete.readbackVerified, true);
  assert.equal(committedEvents.length, 1);
  assert.equal(committedEvents[0].accountId, 'account-a');
  assert.equal(committedEvents[0].committed.readbackVerified, true);
  assert.deepEqual(fixture.calls.map((call) => call.command), [
    'open',
    'navigate',
    'cross-border-charges',
  ]);
});

test('save-effective refuses unrelated pages and never starts a charge read', async () => {
  const fixture = createFixture({ withCharges: true });

  await assert.rejects(
    fixture.handler.handle({ action: 'cross-border-charges-save' }),
    { code: 'CROSS_BORDER_CHARGE_PAGE_REQUIRED' },
  );

  assert.equal(fixture.calls.length, 0);
});

test('save-effective keeps the Kuajing84 page open when login has not completed', async () => {
  const fixture = createFixture({ withCharges: true, loggedIn: false });
  await fixture.handler.handle({ action: 'cross-border-charges-open' });
  await fixture.handler.handle({
    action: 'navigate',
    payload: { url: 'https://www.kuajing84.com/index/finance/record_consume.html' },
  });

  await assert.rejects(
    fixture.handler.handle({ action: 'cross-border-charges-save' }),
    { code: 'CROSS_BORDER_LOGIN_REQUIRED' },
  );

  assert.equal(
    fixture.controller.snapshot().tabs.find((tab) => tab.tabId === 'tab-a').url,
    'https://www.kuajing84.com/index/finance/record_consume.html',
  );
});

test('toolbar refuses sync while logged out', async () => {
  const fixture = createFixture({ loggedIn: false });
  await assert.rejects(
    fixture.handler.handle({ action: 'cross-border-sync-preview' }),
    { code: 'CROSS_BORDER_LOGIN_REQUIRED' },
  );
  assert.deepEqual(fixture.calls.map((call) => call.command), ['purchase-context', 'cross-border-login-status']);
});

test('toolbar requires preview confirmation and verifies post-sync readback', async () => {
  const fixture = createFixture();
  const preview = await fixture.handler.handle({ action: 'cross-border-sync-preview' });
  assert.equal(preview.toolbar.dialog.kind, 'sync-preview');
  assert.equal(preview.toolbar.dialog.confirmationToken, 'confirmation-a');
  await assert.rejects(
    fixture.handler.handle({ action: 'cross-border-sync-confirm', payload: { confirmationToken: 'wrong' } }),
    { code: 'CROSS_BORDER_CONFIRMATION_REQUIRED' },
  );

  const secondPreview = await fixture.handler.handle({ action: 'cross-border-sync-preview' });
  const complete = await fixture.handler.handle({
    action: 'cross-border-sync-confirm',
    payload: { confirmationToken: secondPreview.toolbar.dialog.confirmationToken },
  });
  assert.equal(complete.toolbar.dialog.kind, 'sync-complete');
  assert.equal(complete.toolbar.dialog.result.readbackVerified, true);
  assert.deepEqual(fixture.calls.slice(-5).map((call) => call.command), [
    'cross-border-login-status',
    'purchase-context',
    'cross-border-orders',
    'cross-border-sync',
    'cross-border-status',
  ]);
});

test('toolbar previews and verifies every package when one purchase order has multiple packages', async () => {
  const fixture = createFixture({ packageCount: 2 });
  const preview = await fixture.handler.handle({ action: 'cross-border-sync-preview' });
  assert.equal(preview.toolbar.dialog.kind, 'sync-preview');
  assert.equal(preview.after.results.length, 2);
  assert.deepEqual(
    preview.after.results.map((row) => row.packId),
    ['tab-a-pack-1', 'tab-a-pack-2'],
  );
  const complete = await fixture.handler.handle({
    action: 'cross-border-sync-confirm',
    payload: { confirmationToken: preview.toolbar.dialog.confirmationToken },
  });
  assert.equal(complete.toolbar.dialog.kind, 'sync-complete');
  assert.equal(complete.toolbar.dialog.result.results.length, 2);
  assert.equal(complete.toolbar.dialog.result.readbackVerified, true);
});

test('toolbar keeps two accounts separated by the active tab', async () => {
  const fixture = createFixture();
  await fixture.controller.dispatch({ command: 'open', accountId: 'account-b', url: 'https://www.taobao.com/' });
  await fixture.handler.handle({ action: 'cross-border-orders' });
  assert.equal(fixture.calls.at(-1).tabId, 'tab-b');
});

test('toolbar exposes target mode and confirms captured purchase data only after preview', async () => {
  const fixture = createFixture();
  fixture.controller.snapshot().tabs[0].target = null;
  const targetRequired = await fixture.handler.handle({ action: 'target-mode' });
  assert.equal(targetRequired.toolbar.dialog.kind, 'target-required');
  const preview = await fixture.handler.handle({ action: 'capture-purchase' });
  assert.equal(preview.toolbar.dialog.kind, 'capture-preview');
  assert.equal(preview.toolbar.dialog.confirmationToken, 'capture-token-a');
  const complete = await fixture.handler.handle({
    action: 'capture-confirm',
    payload: { confirmationToken: 'capture-token-a' },
  });
  assert.equal(complete.toolbar.dialog.kind, 'capture-complete');
  assert.equal(complete.toolbar.dialog.result.readbackVerified, true);

  fixture.controller.snapshot().tabs[0].target = { targetId: 'target-a', shopId: 'shop-a', orderKey: 'order-a' };
  const cleared = await fixture.handler.handle({ action: 'target-mode' });
  assert.equal(cleared.toolbar.dialog.kind, 'target-cleared');
});

test('toolbar sends the current product directly to the collection-pricing workbench', async () => {
  const delivered = [];
  const fixture = createFixture({
    onCollectionPricingCapture: async (payload) => {
      delivered.push(payload);
      return { delivered: true };
    },
  });

  const result = await fixture.handler.handle({ action: 'collection-pricing-capture' });

  assert.equal(result.toolbar.dialog.kind, 'collection-pricing-captured');
  assert.equal(result.toolbar.dialog.result.productTitle, '采集到操作台商品');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].tabId, 'tab-a');
  assert.equal(delivered[0].capture.sourceProductId, '1688-product-a');
  assert.deepEqual(fixture.calls.at(-1), { command: 'capture-purchase', tabId: 'tab-a' });
});

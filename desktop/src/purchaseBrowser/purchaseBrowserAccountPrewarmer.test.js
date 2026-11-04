import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPurchaseBrowserAccountPrewarmer,
  selectOzonBrowserPrewarmProfiles,
  selectPurchaseBrowserPrewarmAccount,
  selectPurchaseBrowserPrewarmAccounts,
} from './purchaseBrowserAccountPrewarmer.js';

const accounts = [
  { id: '1688-first', platformName: '1688', platformUrl: 'https://www.1688.com/', isDefault: false },
  { id: '1688-default', platformName: '1688', platformUrl: 'https://detail.1688.com/', isDefault: true },
  { id: 'taobao-first', platformName: '淘宝', platformUrl: 'https://www.taobao.com/', isDefault: false },
  { id: 'tmall-first', platformName: '天猫', platformUrl: 'https://www.tmall.com/', isDefault: false },
  { id: 'pdd-first', platformName: '拼多多', platformUrl: 'https://mobile.yangkeduo.com/', isDefault: false },
  { id: 'ozon-buyer-first', platformName: 'Ozon买家', platformUrl: 'https://www.ozon.ru/', isDefault: false },
];

test('prewarm selection caps startup to the highest-value default account', () => {
  assert.deepEqual(selectPurchaseBrowserPrewarmAccounts({ accounts }), [
    { accountId: 'pdd-first', platformKey: 'pinduoduo', platformName: '拼多多', url: 'https://mobile.yangkeduo.com/' },
  ]);
  assert.deepEqual(selectPurchaseBrowserPrewarmAccount({ accounts }), {
    accountId: 'pdd-first',
    platformKey: 'pinduoduo',
    platformName: '拼多多',
    url: 'https://mobile.yangkeduo.com/',
  });
});

test('prewarm selection skips missing platforms, invalid URLs, and duplicate account ids', () => {
  assert.deepEqual(selectPurchaseBrowserPrewarmAccounts({
    rows: [
      { id: 'shared', platformName: '1688', platformUrl: 'https://www.1688.com/', isDefault: true },
      { id: 'shared', platformName: '淘宝', platformUrl: 'https://www.taobao.com/', isDefault: true },
      { id: 'bad', platformName: '天猫', platformUrl: 'http://www.tmall.com/', isDefault: true },
    ],
  }), [
    { accountId: 'shared', platformKey: '1688', platformName: '1688', url: 'https://www.1688.com/' },
  ]);
});

test('Ozon prewarm selection only includes connected browser-cookie profiles', () => {
  assert.deepEqual(selectOzonBrowserPrewarmProfiles({ profiles: [
    { id: 'ozon-pending', integrationType: 'ozon-browser-session', configStatus: '待登录', tokenStatus: 'Cookie 未保存' },
    { id: 'ozon-ready', integrationType: 'ozon-browser-session', configStatus: '连接成功', tokenStatus: 'Cookie 已保存' },
    { id: 'ozon-ready', integrationType: 'ozon-browser-session', configStatus: '连接成功', tokenStatus: 'Cookie 已保存' },
    { id: 'other', integrationType: 'seerfar-open-api', configStatus: '连接成功', tokenStatus: '有效' },
  ] }), [{
    accountId: 'ozon-ready',
    ownerType: 'integration_profile',
    browserRole: 'market-collector',
    background: true,
    platformKey: 'ozon',
    platformName: 'Ozon 网页登录',
    url: 'https://seller.ozon.ru/app/dashboard/main',
  }]);
});

test('Ozon prewarm replaces a persisted buyer-site URL with the seller landing page', () => {
  assert.deepEqual(selectOzonBrowserPrewarmProfiles({ profiles: [{
    id: 'ozon-buyer-url',
    integrationType: 'ozon-browser-session',
    configStatus: '连接成功',
    tokenStatus: 'Cookie 已保存',
    lastUrl: 'https://www.ozon.ru/category/mashinki-radioupravlyaemye-7151/',
  }] }), [{
    accountId: 'ozon-buyer-url',
    ownerType: 'integration_profile',
    browserRole: 'market-collector',
    background: true,
    platformKey: 'ozon',
    platformName: 'Ozon 网页登录',
    url: 'https://seller.ozon.ru/app/dashboard/main',
  }]);
});

test('background prewarmer also warms connected Ozon integration profiles', async () => {
  const calls = [];
  const prewarmer = createPurchaseBrowserAccountPrewarmer({
    localApiClient: {
      async listAccounts() { return { accounts: [] }; },
      async listIntegrationProfiles() {
        return { profiles: [{ id: 'ozon-ready', integrationType: 'ozon-browser-session', configStatus: '连接成功', tokenStatus: 'Cookie 已保存' }] };
      },
    },
    getController: () => ({
      async dispatch(input) {
        calls.push(input);
        if (input.command === 'prewarm') {
          return {
            ok: true,
            tabs: [{ tabId: 'ozon-tab-a', accountId: 'ozon-ready', browserRole: 'market-collector' }],
          };
        }
        if (input.command === 'ozon-login-status') {
          return { ok: true, result: { loggedIn: true, cookieSaved: true } };
        }
        return { ok: true };
      },
    }),
  });
  const result = await prewarmer.start();
  assert.equal(result.prewarmed, 1);
  assert.deepEqual(calls, [{
    command: 'prewarm',
    accountId: 'ozon-ready',
    ownerType: 'integration_profile',
    browserRole: 'market-collector',
    background: true,
    url: 'https://seller.ozon.ru/app/dashboard/main',
  }, {
    command: 'ozon-login-status',
    tabId: 'ozon-tab-a',
    persistStatus: true,
  }]);
});

test('background prewarmer rejects a stale Ozon Cookie and closes the unauthenticated collector', async () => {
  const calls = [];
  const prewarmer = createPurchaseBrowserAccountPrewarmer({
    localApiClient: {
      async listAccounts() { return { accounts: [] }; },
      async listIntegrationProfiles() {
        return { profiles: [{ id: 'ozon-stale', integrationType: 'ozon-browser-session', configStatus: '连接成功', tokenStatus: 'Cookie 已保存' }] };
      },
    },
    getController: () => ({
      async dispatch(input) {
        calls.push(input);
        if (input.command === 'prewarm') {
          return { tabs: [{ tabId: 'ozon-stale-tab', accountId: 'ozon-stale', browserRole: 'market-collector' }] };
        }
        if (input.command === 'ozon-login-status') {
          return { result: { loggedIn: false, cookieSaved: false, verificationSource: 'login-page' } };
        }
        return { ok: true };
      },
    }),
  });

  const result = await prewarmer.start();

  assert.equal(result.prewarmed, 0);
  assert.equal(result.results[0].code, 'OZON_LOGIN_REQUIRED');
  assert.deepEqual(calls.at(-1), { command: 'force-close', tabId: 'ozon-stale-tab' });
});

test('background prewarmer retries an indeterminate Ozon startup without invalidating or closing it', async () => {
  const calls = [];
  let verificationAttempt = 0;
  const prewarmer = createPurchaseBrowserAccountPrewarmer({
    localApiClient: {
      async listAccounts() { return { accounts: [] }; },
      async listIntegrationProfiles() {
        return { profiles: [{ id: 'ozon-booting', integrationType: 'ozon-browser-session', configStatus: '连接成功', tokenStatus: 'Cookie 已保存' }] };
      },
    },
    getController: () => ({
      async dispatch(input) {
        calls.push(input);
        if (input.command === 'prewarm') {
          return { tabs: [{ tabId: 'ozon-booting-tab', accountId: 'ozon-booting', browserRole: 'market-collector' }] };
        }
        if (input.command === 'ozon-login-status') {
          verificationAttempt += 1;
          if (verificationAttempt < 3) {
            return { result: { loggedIn: false, cookieSaved: false, verificationOutcome: 'pending', verificationPending: true } };
          }
          return { result: { loggedIn: true, cookieSaved: true, verificationOutcome: 'connected', verificationPending: false } };
        }
        return { ok: true };
      },
    }),
    sleep: async () => undefined,
  });

  const result = await prewarmer.start();

  assert.equal(result.prewarmed, 1);
  assert.equal(verificationAttempt, 3);
  assert.equal(calls.some((call) => call.command === 'force-close'), false);
});

test('a purchase prewarm failure does not stop the independent Ozon collector prewarm', async () => {
  const calls = [];
  const logs = [];
  const controller = {
    async dispatch(input) {
      calls.push(input);
      if (input.accountId === 'pdd-first') throw Object.assign(new Error('PURCHASE_BROWSER_CEF_TIMEOUT'), {
        code: 'PURCHASE_BROWSER_CEF_TIMEOUT',
      });
      if (input.command === 'prewarm' && input.accountId === 'ozon-ready') {
        return { tabs: [{ tabId: 'ozon-tab', accountId: 'ozon-ready', browserRole: 'market-collector' }] };
      }
      if (input.command === 'ozon-login-status') {
        return { result: { loggedIn: true, cookieSaved: true } };
      }
      return { ok: true };
    },
  };
  let tick = 0;
  const prewarmer = createPurchaseBrowserAccountPrewarmer({
    localApiClient: {
      async listAccounts() {
        calls.push({ command: 'list-accounts' });
        return { accounts };
      },
      async listIntegrationProfiles() {
        return { profiles: [{
          id: 'ozon-ready',
          integrationType: 'ozon-browser-session',
          configStatus: '连接成功',
          tokenStatus: 'Cookie 已保存',
        }] };
      },
    },
    getController: () => controller,
    appendLog: (_scope, message) => logs.push(message),
    now: () => ++tick * 10,
  });

  const [first, second] = await Promise.all([prewarmer.start(), prewarmer.start()]);
  assert.equal(second, first);
  assert.equal(first.prewarmed, 1);
  assert.equal(first.results.find((result) => result.platformKey === 'pinduoduo').ok, false);
  assert.deepEqual(calls, [
    { command: 'list-accounts' },
    { command: 'prewarm', accountId: 'pdd-first', url: 'https://mobile.yangkeduo.com/' },
    {
      command: 'prewarm',
      accountId: 'ozon-ready',
      ownerType: 'integration_profile',
      browserRole: 'market-collector',
      background: true,
      url: 'https://seller.ozon.ru/app/dashboard/main',
    },
    { command: 'ozon-login-status', tabId: 'ozon-tab', persistStatus: true },
  ]);
  assert.equal(logs.some((line) => accounts.some((account) => line.includes(account.id))), false);
  assert.match(logs.join(''), /platform=ozon/u);
  assert.match(logs.join(''), /platform=pinduoduo/u);
});

test('start returns immediately without waiting at construction time', async () => {
  let listed = false;
  const prewarmer = createPurchaseBrowserAccountPrewarmer({
    localApiClient: { async listAccounts() { listed = true; return { accounts: [] }; } },
    getController: () => ({ dispatch: async () => ({ ok: true }) }),
  });
  assert.equal(listed, false);
  await prewarmer.start();
  assert.equal(listed, true);
});

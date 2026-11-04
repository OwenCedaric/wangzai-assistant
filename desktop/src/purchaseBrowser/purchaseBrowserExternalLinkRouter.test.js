import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseInternalBrowserAccount,
  chooseOzonSellerIntegrationProfile,
  createPurchaseBrowserExternalLinkRouter,
  normalizeInternalExternalUrl,
  platformKeyForExternalUrl,
} from './purchaseBrowserExternalLinkRouter.js';

const accounts = {
  accounts: [
    { id: 'pdd-default', platformName: '拼多多', isDefault: true },
    { id: 'taobao-first', platformName: '淘宝', isDefault: false },
    { id: 'taobao-default', platformName: '淘宝', isDefault: true },
    { id: 'tmall-default', platformName: '天猫', isDefault: true },
    { id: '1688-default', platformName: '1688', isDefault: true },
    { id: 'ozon-buyer-default', platformName: 'Ozon买家', platformUrl: 'https://www.ozon.ru/', isDefault: true },
  ],
};

const integrationProfiles = {
  profiles: [
    {
      id: 'ozon-seller-connected',
      integrationType: 'ozon-browser-session',
      platformName: 'Ozon 网页登录',
      shopId: 'shop-a',
      configStatus: '连接成功',
      tokenStatus: 'Cookie 已保存',
    },
    {
      id: 'ozon-seller-pending',
      integrationType: 'ozon-browser-session',
      platformName: 'Ozon 待登录',
      configStatus: '待登录',
      tokenStatus: '未保存',
    },
  ],
};

test('external link router accepts HTTP and HTTPS only and identifies exact purchase platforms', () => {
  assert.equal(normalizeInternalExternalUrl('https://www.ozon.ru/product/123'), 'https://www.ozon.ru/product/123');
  assert.equal(normalizeInternalExternalUrl('http://example.com/'), 'http://example.com/');
  assert.equal(normalizeInternalExternalUrl('file:///C:/secret.txt'), null);
  assert.equal(normalizeInternalExternalUrl('javascript:alert(1)'), null);
  assert.equal(normalizeInternalExternalUrl('https://user:secret@example.com/'), null);
  assert.equal(platformKeyForExternalUrl('https://detail.1688.com/offer/1.html'), '1688');
  assert.equal(platformKeyForExternalUrl('https://1688.com.evil.invalid/'), '');
  assert.equal(platformKeyForExternalUrl('https://item.taobao.com/item.htm?id=1'), 'taobao');
  assert.equal(platformKeyForExternalUrl('https://detail.tmall.com/item.htm?id=1'), 'tmall');
  assert.equal(platformKeyForExternalUrl('https://mobile.yangkeduo.com/goods.html'), 'pinduoduo');
  assert.equal(platformKeyForExternalUrl('https://www.ozon.ru/product/123'), 'ozon-buyer');
  assert.equal(platformKeyForExternalUrl('https://seller.ozon.ru/app/dashboard/main'), 'ozon-seller');
  assert.equal(platformKeyForExternalUrl('https://item.jd.com/123456.html'), 'jd');
  assert.equal(platformKeyForExternalUrl('https://www.wildberries.ru/catalog/123/detail.aspx'), 'wildberries');
  assert.equal(platformKeyForExternalUrl('https://www.amazon.com/dp/B0ABC12345'), 'amazon');
  assert.equal(platformKeyForExternalUrl('https://www.temu.com/test-g-123.html'), 'temu');
  assert.equal(platformKeyForExternalUrl('https://www.aliexpress.com/item/123.html'), 'aliexpress');
});

test('Seller profile selection is deterministic for any number of shop-bound profiles', () => {
  const many = {
    profiles: Array.from({ length: 12 }, (_, index) => ({
      id: `ozon-profile-${index + 1}`,
      integrationType: 'ozon-browser-session',
      platformName: `Ozon ${index + 1}店`,
      shopId: `shop-${index + 1}`,
      configStatus: '连接成功',
      tokenStatus: 'Cookie 已保存',
    })),
  };
  assert.equal(chooseOzonSellerIntegrationProfile({
    payload: many,
    shopId: 'shop-9',
  })?.id, 'ozon-profile-9');
  assert.equal(chooseOzonSellerIntegrationProfile({
    payload: many,
    shopId: 'shop-13',
  }), null);
  assert.equal(chooseOzonSellerIntegrationProfile({
    payload: many,
    shopId: 'shop-9',
    activeAccountId: 'ozon-profile-1',
  }), null);
});

test('router opens each Seller order only with that shop profile and never uses another shop fallback', async () => {
  const opens = [];
  let profileReads = 0;
  const router = createPurchaseBrowserExternalLinkRouter({
    listAccounts: async () => accounts,
    listIntegrationProfiles: async () => {
      profileReads += 1;
      return {
        profiles: [
          ...integrationProfiles.profiles,
          {
            id: 'ozon-seller-b', integrationType: 'ozon-browser-session', platformName: 'Ozon 2店',
            shopId: 'shop-b', configStatus: '连接成功', tokenStatus: 'Cookie 已保存',
          },
        ],
      };
    },
    getActiveAccountId: () => 'ozon-seller-connected',
    openInternalUrl: async (url, options) => { opens.push({ url, options }); return { ok: true }; },
  });

  await router.open('https://seller.ozon.ru/app/postings/fbs', {
    shopId: 'shop-b',
    requireShopBinding: true,
  });
  assert.equal(opens[0].options.accountId, 'ozon-seller-b');
  assert.equal(profileReads, 1);

  await assert.rejects(
    router.open('https://seller.ozon.ru/app/postings/fbs', {
      shopId: 'shop-missing',
      requireShopBinding: true,
    }),
    { code: 'PURCHASE_BROWSER_OZON_SELLER_SHOP_PROFILE_REQUIRED' },
  );
  await assert.rejects(
    router.open('https://seller.ozon.ru/app/postings/fbs', { requireShopBinding: true }),
    { code: 'PURCHASE_BROWSER_OZON_SELLER_SHOP_PROFILE_REQUIRED' },
  );
  assert.equal(opens.length, 1);
  // Seller bindings are read fresh so saving a new binding takes effect on
  // the very next click instead of waiting for an account cache TTL.
  assert.equal(profileReads, 2);
});

test('account selection keeps purchase platforms isolated and uses active account for generic links', () => {
  assert.equal(chooseInternalBrowserAccount({ payload: accounts, url: 'https://item.taobao.com/', activeAccountId: 'taobao-first' }), 'taobao-first');
  assert.equal(chooseInternalBrowserAccount({ payload: accounts, url: 'https://detail.tmall.com/' }), 'tmall-default');
  assert.equal(chooseInternalBrowserAccount({ payload: { accounts: [{ id: 'only-taobao', platformName: '淘宝' }] }, url: 'https://www.1688.com/' }), null);
  assert.equal(chooseInternalBrowserAccount({ payload: accounts, url: 'https://www.ozon.ru/', activeAccountId: '1688-default' }), 'ozon-buyer-default');
  assert.equal(chooseInternalBrowserAccount({ payload: accounts, url: 'https://seller.ozon.ru/' }), null);
  assert.equal(chooseInternalBrowserAccount({ payload: { accounts: accounts.accounts.filter((row) => row.id !== 'ozon-buyer-default') }, url: 'https://www.ozon.ru/' }), null);
});

test('Taobao and Tmall reuse the shared Alibaba login session but prefer an exact account', () => {
  assert.equal(chooseInternalBrowserAccount({
    payload: { accounts: [{ id: 'taobao-shared', platformName: '淘宝', isDefault: true }] },
    url: 'https://detail.tmall.com/item.htm?id=1',
  }), 'taobao-shared');
  assert.equal(chooseInternalBrowserAccount({
    payload: accounts,
    url: 'https://detail.tmall.com/item.htm?id=1',
    activeAccountId: 'taobao-first',
  }), 'tmall-default');
});

test('collection-only marketplace accounts remain isolated for all additional platforms', () => {
  const payload = { accounts: [
    { id: 'jd-account', platformName: '京东' },
    { id: 'wb-account', platformName: 'Wildberries' },
    { id: 'amazon-account', platformName: 'Amazon' },
    { id: 'temu-account', platformName: 'Temu' },
    { id: 'aliexpress-account', platformName: 'AliExpress' },
  ] };
  assert.equal(chooseInternalBrowserAccount({ payload, url: 'https://item.jd.com/123456.html' }), 'jd-account');
  assert.equal(chooseInternalBrowserAccount({ payload, url: 'https://www.wildberries.ru/catalog/123/detail.aspx' }), 'wb-account');
  assert.equal(chooseInternalBrowserAccount({ payload, url: 'https://www.amazon.com/dp/B0ABC12345' }), 'amazon-account');
  assert.equal(chooseInternalBrowserAccount({ payload, url: 'https://www.temu.com/test-g-123.html' }), 'temu-account');
  assert.equal(chooseInternalBrowserAccount({ payload, url: 'https://www.aliexpress.com/item/123.html' }), 'aliexpress-account');
  assert.equal(chooseInternalBrowserAccount({ payload, url: 'https://www.1688.com/' }), null);
});

test('Seller profile selection accepts only a connected Ozon browser session', () => {
  assert.equal(
    chooseOzonSellerIntegrationProfile({ payload: integrationProfiles })?.id,
    'ozon-seller-connected',
  );
  assert.equal(chooseOzonSellerIntegrationProfile({
    payload: integrationProfiles,
    activeAccountId: 'ozon-seller-pending',
  })?.id, 'ozon-seller-connected');
  assert.equal(chooseOzonSellerIntegrationProfile({
    payload: { profiles: integrationProfiles.profiles.slice(1) },
  }), null);
});

test('router opens Seller after-sales details with the isolated integration profile', async () => {
  let purchaseAccountReads = 0;
  let integrationProfileReads = 0;
  const opens = [];
  const router = createPurchaseBrowserExternalLinkRouter({
    listAccounts: async () => { purchaseAccountReads += 1; return accounts; },
    listIntegrationProfiles: async () => {
      integrationProfileReads += 1;
      return integrationProfiles;
    },
    openInternalUrl: async (url, options) => { opens.push({ url, options }); return { ok: true }; },
  });

  await router.open('https://seller.ozon.ru/app/returns/details/rfbs/88964914', {
    workbench: {
      kind: 'purchase-order',
      displayMode: 'embedded',
      sidebarKind: 'after-sales',
      title: '售后订单操作台',
      afterSales: { afterSalesId: '88964914', originalOrderNo: '07389289-0111-1' },
    },
  });

  assert.equal(purchaseAccountReads, 0);
  assert.equal(integrationProfileReads, 1);
  assert.deepEqual(opens, [{
    url: 'https://seller.ozon.ru/app/returns/details/rfbs/88964914',
    options: {
      accountId: 'ozon-seller-connected',
      ownerType: 'integration_profile',
      platformName: 'Ozon 网页登录',
      accountLabel: 'Ozon 网页登录',
      workbench: {
        version: 1,
        kind: 'purchase-order',
        displayMode: 'embedded',
        sidebarKind: 'after-sales',
        title: '售后订单操作台',
        order: {
          orderNo: '', goodsNo: '', ozonOrderId: '', shop: '', status: '', salesAmount: '',
          purchasePlatform: '', purchaseOrderNo: '', ozonStatus: '', paymentTime: '',
        },
        product: { title: '', sku: '', quantity: '', imageUrl: '' },
        source: { platform: '', amount: '', url: '' },
        logistics: { orderId: '', weight: '', size: '', route: '', readStatus: '' },
        profitItems: [],
        afterSales: {
          originalOrderNo: '07389289-0111-1',
          afterSalesId: '88964914',
          type: '', status: '', shop: '', logistics: '', refundAmount: '', refundStatus: '',
          refundTime: '', responsibilityParty: '', sourceLabel: '', updatedAt: '', reason: '',
          purchasePlatform: '', purchaseOrderNo: '',
        },
        notice: '',
      },
    },
  }]);
});

test('router never opens Seller pages with a purchase account or an unconnected profile', async () => {
  const router = createPurchaseBrowserExternalLinkRouter({
    listAccounts: async () => accounts,
    listIntegrationProfiles: async () => ({ profiles: integrationProfiles.profiles.slice(1) }),
    openInternalUrl: async () => ({ ok: true }),
  });
  await assert.rejects(
    router.open('https://seller.ozon.ru/app/returns/details/rfbs/88964914'),
    { code: 'PURCHASE_BROWSER_OZON_SELLER_PROFILE_REQUIRED' },
  );
  await assert.rejects(
    router.open('https://seller.ozon.ru/app/returns/details/rfbs/88964914', { accountId: '1688-default' }),
    { code: 'PURCHASE_BROWSER_EXTERNAL_ACCOUNT_PLATFORM_MISMATCH' },
  );
});

test('router caches account reads and never needs a system-browser fallback', async () => {
  let reads = 0;
  const opens = [];
  const router = createPurchaseBrowserExternalLinkRouter({
    listAccounts: async () => { reads += 1; return accounts; },
    getActiveAccountId: () => 'taobao-first',
    openInternalUrl: async (url, options) => { opens.push({ url, options }); return { ok: true }; },
    now: () => 100,
  });
  await router.open('https://item.taobao.com/item.htm?id=1');
  await router.open('https://www.ozon.ru/product/1', {
    embeddedBounds: { x: 500, y: 100, width: 900, height: 700, visible: true },
    workbench: {
      kind: 'purchase-order',
      displayMode: 'embedded',
      order: { orderNo: 'WORKBENCH-TEST-1' },
      unknown: 'drop-me',
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(opens, [
    { url: 'https://item.taobao.com/item.htm?id=1', options: { accountId: 'taobao-first', workbench: null } },
    {
      url: 'https://www.ozon.ru/product/1',
      options: {
        accountId: 'ozon-buyer-default',
        embeddedBounds: { x: 500, y: 100, width: 900, height: 700, visible: true },
        workbench: {
          version: 1,
          kind: 'purchase-order',
          displayMode: 'embedded',
          title: '订单操作台',
          order: {
            orderNo: 'WORKBENCH-TEST-1',
            goodsNo: '',
            ozonOrderId: '',
            shop: '',
            status: '',
            salesAmount: '',
            purchasePlatform: '',
            purchaseOrderNo: '',
            ozonStatus: '',
            paymentTime: '',
          },
          product: { title: '', sku: '', quantity: '', imageUrl: '' },
          source: { platform: '', amount: '', url: '' },
          logistics: { orderId: '', weight: '', size: '', route: '', readStatus: '' },
          profitItems: [],
          notice: '',
        },
      },
    },
  ]);
  await assert.rejects(router.open('https://user:secret@example.com/'), { code: 'PURCHASE_BROWSER_EXTERNAL_URL_INVALID' });
});

test('router carries the exact order target into the same embedded CEF open', async () => {
  const opens = [];
  const router = createPurchaseBrowserExternalLinkRouter({
    listAccounts: async () => accounts,
    openInternalUrl: async (url, options) => { opens.push({ url, options }); return { ok: true }; },
  });
  const purchaseTarget = {
    targetId: 'shop-3:0215352801-0034-2:mz-26032810-471686',
    shopId: 'shop-3',
    orderKey: '0215352801-0034-2',
  };
  await router.open('https://mobile.yangkeduo.com/', {
    purchaseTarget,
    workbench: { kind: 'purchase-order', displayMode: 'embedded' },
    embeddedBounds: { x: 460, y: 120, width: 900, height: 680, visible: true },
  });
  assert.deepEqual(opens[0].options.purchaseTarget, purchaseTarget);
  assert.equal(opens[0].options.workbench.displayMode, 'embedded');
});

test('router opens public Ozon product pages with the isolated built-in profile when no buyer account exists', async () => {
  const opens = [];
  const router = createPurchaseBrowserExternalLinkRouter({
    listAccounts: async () => ({ accounts: accounts.accounts.filter((row) => row.id !== 'ozon-buyer-default') }),
    openInternalUrl: async (url, options) => { opens.push({ url, options }); return { ok: true }; },
  });
  await router.open('https://www.ozon.ru/product/123');
  assert.deepEqual(opens, [{
    url: 'https://www.ozon.ru/product/123',
    options: {
      accountId: 'builtin-ozon-public',
      ownerType: 'builtin_public_profile',
      platformName: 'Ozon买家',
      accountLabel: 'Ozon 公共商品浏览',
      workbench: null,
    },
  }]);
});

test('router does not replace an explicitly requested account with the public Ozon profile', async () => {
  const router = createPurchaseBrowserExternalLinkRouter({
    listAccounts: async () => ({ accounts: accounts.accounts.filter((row) => row.id !== 'ozon-buyer-default') }),
    openInternalUrl: async () => ({ ok: true }),
  });
  await assert.rejects(router.open('https://www.ozon.ru/product/123', { accountId: '1688-default' }), {
    code: 'PURCHASE_BROWSER_EXTERNAL_ACCOUNT_PLATFORM_MISMATCH',
  });
});

test('router rejects an explicitly supplied account from a different purchase platform', async () => {
  const router = createPurchaseBrowserExternalLinkRouter({
    listAccounts: async () => accounts,
    openInternalUrl: async () => ({ ok: true }),
  });
  await assert.rejects(router.open('https://www.ozon.ru/product/123', { accountId: '1688-default' }), {
    code: 'PURCHASE_BROWSER_EXTERNAL_ACCOUNT_PLATFORM_MISMATCH',
  });
});

test('router forwards the isolated product-link parser role without changing platform account selection', async () => {
  const opens = [];
  const router = createPurchaseBrowserExternalLinkRouter({
    listAccounts: async () => accounts,
    openInternalUrl: async (url, options) => { opens.push({ url, options }); return { ok: true }; },
  });
  await router.open('https://detail.1688.com/offer/1.html', {
    browserRole: 'product-link-parser',
    background: true,
    restoreVisible: false,
    waitUntil: 'load',
  });
  assert.deepEqual(opens, [{
    url: 'https://detail.1688.com/offer/1.html',
    options: {
      accountId: '1688-default',
      browserRole: 'product-link-parser',
      background: true,
      restoreVisible: false,
      waitUntil: 'load',
      workbench: null,
    },
  }]);
});

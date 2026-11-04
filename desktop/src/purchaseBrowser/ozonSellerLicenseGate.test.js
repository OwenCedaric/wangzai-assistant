import assert from 'node:assert/strict';
import test from 'node:test';

import { assertOzonSellerBrowserEntitled } from './ozonSellerLicenseGate.js';

test('Ozon Seller browser resolves the exact profile Client ID in Main before opening', async () => {
  const calls = [];
  const result = await assertOzonSellerBrowserEntitled({
    input: { accountId: 'profile-a', ownerType: 'integration_profile' },
    localApiClient: {
      async getOwnerBinding(accountId, ownerType) {
        calls.push(['binding', accountId, ownerType]);
        return { binding: { integrationType: 'ozon-browser-session', clientId: 'client-a' } };
      },
    },
    licenseRuntime: {
      async assertOzonShopEntitled(clientId) {
        calls.push(['license', clientId]);
      },
    },
  });

  assert.equal(result.applicable, true);
  assert.deepEqual(calls, [
    ['binding', 'profile-a', 'integration_profile'],
    ['license', 'client-a'],
  ]);
});

test('Ozon Seller browser data commands resolve their owner from the exact tab', async () => {
  const checked = [];
  await assertOzonSellerBrowserEntitled({
    input: { command: 'ozon-data-read', tabId: 'tab-a' },
    snapshot: {
      activeTabId: 'tab-b',
      tabs: [
        { tabId: 'tab-a', accountId: 'profile-a', ownerType: 'integration_profile' },
        { tabId: 'tab-b', accountId: 'purchase-b', ownerType: 'purchase_account' },
      ],
    },
    localApiClient: {
      async getOwnerBinding() {
        return { binding: { integrationType: 'ozon-browser-session', clientId: 'client-a' } };
      },
    },
    licenseRuntime: {
      async assertOzonShopEntitled(clientId) {
        checked.push(clientId);
      },
    },
  });
  assert.deepEqual(checked, ['client-a']);
});

test('Ozon Seller browser fails closed before dispatch when the exact shop grant is missing', async () => {
  await assert.rejects(
    assertOzonSellerBrowserEntitled({
      input: { accountId: 'profile-unlicensed', ownerType: 'integration_profile' },
      localApiClient: {
        async getOwnerBinding() {
          return { binding: { integrationType: 'ozon-browser-session', clientId: 'client-unlicensed' } };
        },
      },
      licenseRuntime: {
        async assertOzonShopEntitled() {
          const error = new Error('当前 Ozon 店铺未绑定有效卡密或授权已到期。');
          error.code = 'SHOP_LICENSE_REQUIRED';
          throw error;
        },
      },
    }),
    (error) => error?.code === 'SHOP_LICENSE_REQUIRED',
  );
});

test('purchase accounts and Ozon public/follow-seller profiles are outside the Seller card gate', async () => {
  let entitlementChecks = 0;
  const licenseRuntime = {
    async assertOzonShopEntitled() {
      entitlementChecks += 1;
    },
  };
  const purchaseResult = await assertOzonSellerBrowserEntitled({
    input: { accountId: 'purchase-a', ownerType: 'purchase_account' },
    licenseRuntime,
  });
  const followSellerResult = await assertOzonSellerBrowserEntitled({
    input: { accountId: 'follow-a', ownerType: 'integration_profile' },
    localApiClient: {
      async getOwnerBinding() {
        return { binding: { integrationType: 'ozon-follow-seller-session' } };
      },
    },
    licenseRuntime,
  });
  assert.equal(purchaseResult.applicable, false);
  assert.equal(followSellerResult.applicable, false);
  assert.equal(entitlementChecks, 0);
});

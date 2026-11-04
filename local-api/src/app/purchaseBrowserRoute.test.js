import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPurchaseAccountRepository } from '../db/repositories/purchaseAccountRepository.js';
import { createAccountRemovalOperationRepository } from '../db/repositories/accountRemovalOperationRepository.js';
import { createIntegrationProfileRepository } from '../db/repositories/integrationProfileRepository.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { getAccountRemovalClientResourceIds } from '../domain/accountRemoval/accountRemovalClientResources.js';
import { createShopLicenseGrantRegistry } from '../domain/licensing/shopLicenseGrantRegistry.js';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createApp } from './createApp.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

async function post(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('purchase browser HTTP flow keeps claim and receipt on the main-process-only capability', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.prepare(`INSERT INTO shops (id, name, status) VALUES ('shop-a', 'Shop A', 'active')`).run();
    createPurchaseAccountRepository(db).saveAccount({ id: 'purchase-a', name: 'Fixture account' });
    server = createApp({
      db,
      config: {
        security: { purchaseBrowserToken: 'main-process-browser-token' },
        sync: {},
        ozon: {},
      },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const targetUrl = 'http://127.0.0.1:49152/purchase-fixture';
    const draft = {
      ownerId: 'purchase-a',
      shopId: 'shop-a',
      orderKey: 'order:1001',
      productKey: 'sku:2002',
      productTitle: 'Fixture product',
      variant: 'Blue / XL',
      quantity: 2,
      address: 'Fixture address A',
      expectedAmount: '88.60',
      targetUrl,
      idempotencyKey: 'route-idempotency-key-0001',
    };
    const preview = await post(`${baseUrl}/api/purchase/browser/tasks/preview`, draft);
    assert.equal(preview.response.status, 200);
    assert.equal(preview.payload.task.status, 'previewed');

    const confirmation = {
      confirm: true,
      previewFingerprint: preview.payload.task.previewFingerprint,
      confirmation: {
        productTitle: draft.productTitle,
        variant: draft.variant,
        quantity: draft.quantity,
        address: draft.address,
        expectedAmount: draft.expectedAmount,
      },
    };
    const confirmed = await post(
      `${baseUrl}/api/purchase/browser/tasks/${preview.payload.task.id}/confirm`,
      confirmation,
    );
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.payload.task.status, 'confirmed');
    assert.ok(confirmed.payload.executionCapability);

    const claimUrl = `${baseUrl}/api/internal/purchase-browser/tasks/${preview.payload.task.id}/claim`;
    const untrustedClaim = await post(claimUrl, {
      executionCapability: confirmed.payload.executionCapability,
    });
    assert.equal(untrustedClaim.response.status, 403);
    assert.equal(untrustedClaim.payload.error.code, 'PURCHASE_BROWSER_INTERNAL_CAPABILITY_INVALID');

    const trustedHeaders = { 'X-Wangzai-Purchase-Browser-Token': 'main-process-browser-token' };
    const claimed = await post(claimUrl, {
      executionCapability: confirmed.payload.executionCapability,
    }, trustedHeaders);
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.payload.task.status, 'executing');

    const receipt = {
      orderNumber: 'FIXTURE-ORDER-1001',
      amount: '88.60',
      status: 'submitted',
      pageUrl: targetUrl,
    };
    const receiptHash = sha256(JSON.stringify(receipt));
    const receiptUrl = `${baseUrl}/api/internal/purchase-browser/tasks/${preview.payload.task.id}/receipt`;
    const withoutReadback = await post(receiptUrl, {
      attemptId: claimed.payload.attemptId,
      receipt,
      receiptHash,
      websiteReadbackVerified: false,
      websiteReadbackHash: sha256('fixture-readback'),
    }, trustedHeaders);
    assert.equal(withoutReadback.response.status, 400);
    assert.equal(withoutReadback.payload.error.code, 'PURCHASE_BROWSER_WEBSITE_READBACK_REQUIRED');

    const completed = await post(receiptUrl, {
      attemptId: claimed.payload.attemptId,
      receipt,
      receiptHash,
      websiteReadbackVerified: true,
      websiteReadbackHash: sha256('fixture-readback'),
    }, trustedHeaders);
    assert.equal(completed.response.status, 200);
    assert.equal(completed.payload.task.status, 'completed');
    assert.equal(completed.payload.task.receipt.orderNumber, receipt.orderNumber);

    const duplicate = await post(receiptUrl, { receiptHash }, trustedHeaders);
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.payload.alreadyCompleted, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_browser_receipts').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_completion_history').get().count, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('Ozon Seller browser identity is connected only after exact shop API readback', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shop = createShopRepository(db).saveShop({
      id: 'shop-browser-api-match',
      name: 'Browser API match fixture',
      alias: 'Ozon 身份核对店铺',
      clientId: '4616153',
      apiKey: 'fixture-api-key',
      status: 'active',
    }).shop;
    const repository = createIntegrationProfileRepository(db);
    const profile = repository.saveProfile({
      id: 'integration-browser-api-match',
      integrationType: 'ozon-browser-session',
      platformName: 'Ozon 卖家后台',
      shopId: shop.id,
      configStatus: '待登录',
      tokenStatus: 'Cookie 未保存',
    }).profile;
    const browserReadback = repository.saveBrowserLoginState(profile.id, {
      loggedIn: true,
      cookieSaved: true,
      companyId: '4616153',
      companyName: 'SuperBaiss',
      verifiedAt: new Date(Date.parse(profile.updatedAt) + 1_000).toISOString(),
    });
    assert.equal(browserReadback.connected, false);
    assert.equal(browserReadback.identityStatus, 'browser-matched');

    const schedulerCalls = [];
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
      ozonScheduler: {
        async executeReadOnly(request) {
          schedulerCalls.push(request.endpointKey);
          if (request.endpointKey === 'shop.roles') {
            return { ok: true, status: 'completed', data: { result: [{ role: 'ADMIN' }] } };
          }
          return {
            ok: true,
            status: 'completed',
            data: { result: { company: { id: '4616153', name: 'SuperBaiss' } } },
          };
        },
      },
    });
    const port = await listen(server);
    const verified = await post(
      `http://127.0.0.1:${port}/api/integrations/profiles/${encodeURIComponent(profile.id)}/verify-ozon-shop-identity`,
      { shopId: shop.id },
    );
    assert.equal(verified.response.status, 200);
    assert.equal(verified.payload.connected, true);
    assert.equal(verified.payload.identityMatched, true);
    assert.equal(verified.payload.profile.identityStatus, 'verified');
    assert.equal(verified.payload.profile.browserCompanyId, '4616153');
    assert.equal(verified.payload.profile.apiIdentityId, '4616153');
    assert.deepEqual(schedulerCalls, ['shop.roles', 'shop.sellerInfo']);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('purchase browser account binding and deletion receipts are main-process-only and operation-bound', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const account = createPurchaseAccountRepository(db).saveAccount({ id: 'purchase-removal-a', name: 'Removal fixture', platformName: '淘宝' }).account;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO shops (id, name, alias, client_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run('shop-ozon-login-a', 'Ozon login fixture', 'Ozon 登录店铺', 'client-ozon-login-a', now, now);
    const ozonProfile = createIntegrationProfileRepository(db).saveProfile({
      id: 'integration-ozon-login-a',
      integrationType: 'ozon-browser-session',
      platformName: 'Ozon 网页登录',
      shopId: 'shop-ozon-login-a',
      authMode: '验证码登录 + Cookie',
    }).profile;
    const followSellerProfile = createIntegrationProfileRepository(db).saveProfile({
      id: 'integration-follow-seller-login-a',
      integrationType: 'ozon-follow-seller-session',
      platformName: 'Ozon 前台巡查 1',
      authMode: '验证码登录',
    }).profile;
    const repository = createAccountRemovalOperationRepository(db, {
      createOperationId: () => 'account_removal_purchase_browser_1',
    });
    const browserResourceIds = getAccountRemovalClientResourceIds('purchase_account')
      .filter((resourceId) => resourceId.startsWith('browser:purchase-'))
      .sort();
    const preview = {
      plannedResources: getAccountRemovalClientResourceIds('purchase_account').map((id) => ({ id })),
    };
    const confirm = {
      owner: { ownerType: 'purchase_account', ownerId: account.id },
      idempotencyKey: 'purchase-browser-removal-route-key',
      requestDigest: 'request-digest',
      previewFingerprint: 'a'.repeat(64),
      catalogFingerprint: 'b'.repeat(64),
      snapshotFingerprint: 'c'.repeat(64),
    };
    const started = repository.beginOrReuse({
      preview,
      confirm,
      account,
      ownerIncarnation: account.createdAt,
      barrierProof: {},
    }).operation;
    repository.markPhase(started.operationId, 'external-delete-pending');

    const shopLicenseGrantRegistry = createShopLicenseGrantRegistry();

    server = createApp({
      db,
      config: {
        security: { purchaseBrowserToken: 'main-process-browser-token' },
        sync: {},
        ozon: {},
      },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
      shopLicenseGrantRegistry,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const trustedHeaders = { 'X-Wangzai-Purchase-Browser-Token': 'main-process-browser-token' };

    const untrustedBinding = await post(`${baseUrl}/api/internal/purchase-browser/account-binding`, { accountId: account.id });
    assert.equal(untrustedBinding.response.status, 403);
    const binding = await post(
      `${baseUrl}/api/internal/purchase-browser/account-binding`,
      { accountId: account.id },
      trustedHeaders,
    );
    assert.equal(binding.response.status, 200);
    assert.deepEqual(binding.payload.binding, {
      accountId: account.id,
      accountIncarnation: account.createdAt,
      platformName: '淘宝',
    });

    const loginStatusUrl = `${baseUrl}/api/internal/purchase-browser/accounts/${encodeURIComponent(account.id)}/login-status`;
    const untrustedLoginStatus = await post(loginStatusUrl, {
      loggedIn: true,
      cookieSaved: true,
      verifiedAt: '2026-08-11T08:30:00.000Z',
    });
    assert.equal(untrustedLoginStatus.response.status, 403);
    const savedLoginStatus = await post(loginStatusUrl, {
      loggedIn: true,
      cookieSaved: true,
      verifiedAt: '2026-08-11T08:30:00.000Z',
    }, trustedHeaders);
    assert.equal(savedLoginStatus.response.status, 200);
    assert.equal(savedLoginStatus.payload.account.cookieStatus, 'Cookie 已保存');
    assert.equal(savedLoginStatus.payload.account.lastLoginVerifiedAt, '2026-08-11T08:30:00.000Z');

    const ozonLoginStatusUrl = `${baseUrl}/api/internal/purchase-browser/integration-profiles/${encodeURIComponent(ozonProfile.id)}/login-status`;
    const ozonProfileUpdatedAt = Date.parse(ozonProfile.updatedAt);
    const ozonInvalidatedAt = new Date(ozonProfileUpdatedAt + 1_000).toISOString();
    const ozonConnectedAt = new Date(ozonProfileUpdatedAt + 5_000).toISOString();
    const untrustedOzonLoginStatus = await post(ozonLoginStatusUrl, {
      loggedIn: false,
      cookieSaved: false,
      verifiedAt: ozonInvalidatedAt,
    });
    assert.equal(untrustedOzonLoginStatus.response.status, 403);
    const invalidatedOzonLoginStatus = await post(ozonLoginStatusUrl, {
      loggedIn: false,
      cookieSaved: false,
      verifiedAt: ozonInvalidatedAt,
    }, trustedHeaders);
    assert.equal(invalidatedOzonLoginStatus.response.status, 200);
    assert.equal(invalidatedOzonLoginStatus.payload.connected, false);
    assert.equal(invalidatedOzonLoginStatus.payload.profile.configStatus, '需要重新登录');
    assert.equal(invalidatedOzonLoginStatus.payload.profile.tokenStatus, 'Cookie 已失效');
    const savedOzonLoginStatus = await post(ozonLoginStatusUrl, {
      loggedIn: true,
      cookieSaved: true,
      verifiedAt: ozonConnectedAt,
      companyId: 'client-ozon-login-a',
      companyName: 'Ozon login fixture',
    }, trustedHeaders);
    assert.equal(savedOzonLoginStatus.response.status, 200);
    assert.equal(savedOzonLoginStatus.payload.connected, false);
    assert.equal(savedOzonLoginStatus.payload.identityStatus, 'browser-matched');
    assert.equal(savedOzonLoginStatus.payload.profile.configStatus, '等待 API 核对');
    assert.equal(savedOzonLoginStatus.payload.profile.tokenStatus, 'Cookie 已保存');

    const unlicensedOzonBinding = await post(
      `${baseUrl}/api/internal/purchase-browser/account-binding`,
      { accountId: ozonProfile.id, ownerType: 'integration_profile' },
      trustedHeaders,
    );
    assert.equal(unlicensedOzonBinding.response.status, 403);
    assert.equal(unlicensedOzonBinding.payload.error.code, 'SHOP_LICENSE_REQUIRED');

    shopLicenseGrantRegistry.replace([{
      clientId: 'client-ozon-login-a',
      expireAt: new Date(Date.now() + 60_000).toISOString(),
    }]);
    const ozonBinding = await post(
      `${baseUrl}/api/internal/purchase-browser/account-binding`,
      { accountId: ozonProfile.id, ownerType: 'integration_profile' },
      trustedHeaders,
    );
    assert.equal(ozonBinding.response.status, 200);
    assert.deepEqual(ozonBinding.payload.binding, {
      accountId: ozonProfile.id,
      accountIncarnation: ozonProfile.createdAt,
      platformName: 'Ozon',
      ownerType: 'integration_profile',
      integrationType: 'ozon-browser-session',
      shopId: 'shop-ozon-login-a',
      clientId: 'client-ozon-login-a',
    });

    const followSellerLoginStatus = await post(
      `${baseUrl}/api/internal/purchase-browser/integration-profiles/${encodeURIComponent(followSellerProfile.id)}/login-status`,
      {
        loggedIn: true,
        cookieSaved: true,
        verifiedAt: new Date(Date.parse(followSellerProfile.updatedAt) + 5_000).toISOString(),
      },
      trustedHeaders,
    );
    assert.equal(followSellerLoginStatus.response.status, 200);
    assert.equal(followSellerLoginStatus.payload.profile.integrationType, 'ozon-follow-seller-session');
    assert.equal(followSellerLoginStatus.payload.profile.tokenStatus, 'Cookie 已保存');
    const followSellerBinding = await post(
      `${baseUrl}/api/internal/purchase-browser/account-binding`,
      { accountId: followSellerProfile.id, ownerType: 'integration_profile' },
      trustedHeaders,
    );
    assert.equal(followSellerBinding.response.status, 200);
    assert.deepEqual(followSellerBinding.payload.binding, {
      accountId: followSellerProfile.id,
      accountIncarnation: followSellerProfile.createdAt,
      platformName: 'Ozon买家',
      ownerType: 'integration_profile',
      integrationType: 'ozon-follow-seller-session',
    });

    const prepared = await post(
      `${baseUrl}/api/internal/purchase-browser/account-removal/prepare`,
      { operationId: started.operationId },
      trustedHeaders,
    );
    assert.equal(prepared.response.status, 200);
    assert.deepEqual(prepared.payload.resourceIds, browserResourceIds);
    assert.equal(prepared.payload.binding.accountId, account.id);

    const invalidReceipt = await post(
      `${baseUrl}/api/internal/purchase-browser/account-removal/receipt`,
      { operationId: started.operationId, proof: { verified: true } },
      trustedHeaders,
    );
    assert.equal(invalidReceipt.response.status, 409);

    const proof = {
      verified: true,
      receiptBinding: prepared.payload.receiptBinding,
      ownerRef: 'd'.repeat(40),
      resourceIds: browserResourceIds,
      profileAbsent: true,
      partitionUnavailable: true,
      artifactsAbsent: true,
    };
    const receipt = await post(
      `${baseUrl}/api/internal/purchase-browser/account-removal/receipt`,
      { operationId: started.operationId, proof },
      trustedHeaders,
    );
    assert.equal(receipt.response.status, 200);
    assert.equal(receipt.payload.verified, true);
    const operation = repository.getOperation(started.operationId);
    for (const resourceId of browserResourceIds) {
      assert.equal(operation.payload.trustedClientResourceReceipts[resourceId].verified, true);
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopRepository } from './shopRepository.js';
import { createCrossBorderAccountRepository } from './crossBorderAccountRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';

test('cross-border account encrypts username/password, exposes the username, and masks the password in public records', () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'cross-border-account-repository-test-secret';
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderAccountRepository(db);
    const saved = repository.saveAccount({
      id: 'cross-border-main',
      name: '跨境巴士主授权',
      userName: 'legacy-user',
      password: 'legacy-password',
      status: 'active',
    });

    assert.equal(saved.account.hasUserName, true);
    assert.equal(saved.account.hasPassword, true);
    assert.equal(saved.account.userName, 'legacy-user');
    assert.equal(saved.account.passwordHint, '••••••••••');
    assert.equal(JSON.stringify(saved.account).includes('legacy-password'), false);

    const row = db.prepare(`
      SELECT user_name_encrypted, password_encrypted
      FROM cross_border_accounts WHERE id = ?
    `).get('cross-border-main');
    assert.match(row.user_name_encrypted, /^secretbox:v1:/);
    assert.match(row.password_encrypted, /^secretbox:v1:/);
    assert.equal(row.user_name_encrypted.includes('legacy-user'), false);
    assert.equal(row.password_encrypted.includes('legacy-password'), false);

    assert.deepEqual(repository.getCredentialsForInternalUse('cross-border-main'), {
      accountId: 'cross-border-main',
      userName: 'legacy-user',
      password: 'legacy-password',
      companySecret: null,
      accessToken: null,
      expiresToken: null,
      appUid: null,
      hasCompanySecret: false,
      hasAccessToken: false,
      hasExpiresToken: false,
      hasAppUid: false,
      hasUserName: true,
      hasPassword: true,
      defaultStorehouse: '',
      defaultSection: '',
      defaultService: '',
      shopIds: [],
    });
  } finally {
    db.close();
    if (previousSecret == null) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});

test('cross-border account owns a tenant/user-scoped one-to-many Ozon shop binding', () => {
  const db = createMigratedTestDb();
  try {
    const shopsA = createShopRepository(db, { tenantId: 'tenant-a', userId: 'user-a', profileId: 'profile-a' });
    const shopsB = createShopRepository(db, { tenantId: 'tenant-a', userId: 'user-b', profileId: 'profile-a' });
    const shopA1 = saveUnitShop(shopsA, 'shop-a-1');
    const shopA2 = saveUnitShop(shopsA, 'shop-a-2');
    const shopB1 = saveUnitShop(shopsB, 'shop-b-1');
    const accountA = createCrossBorderAccountRepository(db, {
      tenantId: 'tenant-a', userId: 'user-a', profileId: 'profile-a',
    });
    const accountB = createCrossBorderAccountRepository(db, {
      tenantId: 'tenant-a', userId: 'user-b', profileId: 'profile-a',
    });

    const savedA = accountA.saveAccount({
      id: 'bus-account-a',
      name: '账号 A',
      status: 'active',
      shopIds: [shopA2, shopA1, shopA2],
    });
    accountB.saveAccount({ id: 'bus-account-b', name: '账号 B', shopIds: [shopB1] });

    assert.deepEqual(savedA.account.shopIds, [shopA1, shopA2]);
    assert.equal(savedA.account.shopCount, 2);
    assert.deepEqual(accountA.resolveAccountShopScope(), {
      ok: true,
      configured: true,
      ambiguous: false,
      accountId: 'bus-account-a',
      shopIds: [shopA1, shopA2],
    });
    assert.equal(accountA.resolveAccountShopScope({ accountId: 'browser-storage-ref' }).accountId, 'bus-account-a');
    assert.deepEqual(accountB.listAccounts().map((row) => row.id), ['bus-account-b']);
    assert.throws(
      () => accountA.saveAccount({ id: 'bus-account-a', name: '账号 A', shopIds: [shopB1] }),
      /CROSS_BORDER_ACCOUNT_SHOP_FORBIDDEN/u,
    );
  } finally {
    db.close();
  }
});

test('cross-border account encrypts the opaque management authorization reference and never needs enterprise credentials', () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'cross-border-server-grant-repository-test-secret';
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderAccountRepository(db);
    const saved = repository.saveAccount({
      id: 'cross-border-server-managed',
      name: '跨境巴士服务器授权',
      status: 'active',
      authorizationRef: 'opaque-management-authorization-reference',
      authorizationExpiresAt: '2026-09-30T00:00:00Z',
    });

    assert.equal(saved.account.authorizationRef, 'opaque-management-authorization-reference');
    assert.equal(saved.account.authorizationExpiresAt, '2026-09-30T00:00:00Z');
    assert.equal(saved.account.hasServerAuthorization, true);
    assert.equal(saved.account.hasCompanySecret, false);
    assert.equal(saved.account.hasAccessToken, false);
    assert.equal(saved.account.hasAppUid, false);

    const row = db.prepare(`
      SELECT authorization_ref_encrypted, authorization_expires_at,
        company_secret_encrypted, access_token_encrypted, app_uid_encrypted
      FROM cross_border_accounts WHERE id = ?
    `).get('cross-border-server-managed');
    assert.match(row.authorization_ref_encrypted, /^secretbox:v1:/);
    assert.equal(row.authorization_ref_encrypted.includes('opaque-management-authorization-reference'), false);
    assert.equal(row.authorization_expires_at, '2026-09-30T00:00:00Z');
    assert.equal(row.company_secret_encrypted, null);
    assert.equal(row.access_token_encrypted, null);
    assert.equal(row.app_uid_encrypted, null);
  } finally {
    db.close();
    if (previousSecret == null) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});

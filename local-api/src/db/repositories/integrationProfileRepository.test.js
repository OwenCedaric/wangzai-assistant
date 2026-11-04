import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntegrationProfileRepository } from './integrationProfileRepository.js';
import { createMigratedTestDb } from '../../../test/testDb.js';

test('integration profile repository persists only non-secret SQLite configuration', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createIntegrationProfileRepository(db);
    const saved = repository.saveProfile({
      id: 'integration-a', integrationType: 'custom', platformName: '自定义工具',
      shopId: '',
      apiType: '工具服务', authMode: '本机配置', configStatus: '已保存',
      readScope: '配置读取', writeScope: '需确认', note: 'local profile note',
    });
    assert.deepEqual(saved.profile, {
      id: 'integration-a', integrationType: 'custom', platformName: '自定义工具',
      shopId: '',
      apiType: '工具服务', authMode: '本机配置', configStatus: '已保存', tokenStatus: '',
      readScope: '配置读取', writeScope: '需确认', note: 'local profile note',
      browserCompanyId: '', browserCompanyName: '', apiIdentityId: '', identityStatus: '',
      identitySource: '', identityVerifiedAt: null,
      createdAt: saved.profile.createdAt, updatedAt: saved.profile.updatedAt,
    });
    assert.throws(
      () => repository.saveProfile({ integrationType: 'custom', platformName: 'bad', clientSecret: 'must-not-store' }),
      /secret field is forbidden/,
    );
    assert.deepEqual(repository.listProfiles().map((profile) => profile.id), ['integration-a']);
    assert.throws(
      () => repository.deleteProfile('integration-a'),
      /ACCOUNT_REMOVAL_LEGACY_PRIMITIVE_DISABLED/u,
    );
    assert.deepEqual(repository.listProfiles().map((profile) => profile.id), ['integration-a']);
  } finally {
    db.close();
  }
});

test('Ozon browser profiles bind one independent Cookie profile to one active shop', () => {
  const db = createMigratedTestDb();
  try {
    const now = '2026-08-02T00:00:00.000Z';
    db.prepare(`
      INSERT INTO shops (id, name, alias, client_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?), (?, ?, ?, ?, 'active', ?, ?)
    `).run(
      'shop-a', 'Seller A', 'Ozon 1店', 'client-a', now, now,
      'shop-b', 'Seller B', 'Ozon 2店', 'client-b', now, now,
    );
    const repository = createIntegrationProfileRepository(db);
    assert.throws(
      () => repository.saveProfile({
        id: 'ozon-unbound', integrationType: 'ozon-browser-session', platformName: '未绑定登录',
      }),
      /OZON_BROWSER_SHOP_REQUIRED/u,
    );
    const first = repository.saveProfile({
      id: 'ozon-a', integrationType: 'ozon-browser-session', platformName: 'Ozon 1店网页登录',
      shopId: 'shop-a', configStatus: '连接成功', tokenStatus: 'Cookie 已保存',
    });
    assert.equal(first.profile.shopId, 'shop-a');
    assert.equal(first.profile.configStatus, '待核对');
    assert.equal(first.profile.identityStatus, 'unverified');
    const firstUpdatedAt = Date.parse(first.profile.updatedAt);
    const invalidatedAt = new Date(firstUpdatedAt + 1_000).toISOString();
    const reconnectedAt = new Date(firstUpdatedAt + 5_000).toISOString();
    const staleInvalidationAt = new Date(firstUpdatedAt + 2_000).toISOString();
    const invalidated = repository.saveBrowserLoginState('ozon-a', {
      loggedIn: false,
      cookieSaved: false,
      verifiedAt: invalidatedAt,
    });
    assert.equal(invalidated.connected, false);
    assert.equal(invalidated.profile.configStatus, '需要重新登录');
    assert.equal(invalidated.profile.tokenStatus, 'Cookie 已失效');
    assert.equal(invalidated.profile.updatedAt, invalidatedAt);
    const reconnected = repository.saveBrowserLoginState('ozon-a', {
      loggedIn: true,
      cookieSaved: true,
      verifiedAt: reconnectedAt,
      companyId: 'client-a',
      companyName: 'Seller A',
    });
    assert.equal(reconnected.connected, false);
    assert.equal(reconnected.identityStatus, 'browser-matched');
    assert.equal(reconnected.profile.configStatus, '等待 API 核对');
    assert.equal(reconnected.profile.tokenStatus, 'Cookie 已保存');
    assert.equal(reconnected.profile.browserCompanyId, 'client-a');
    const confirmed = repository.confirmBrowserApiIdentity('ozon-a', {
      shopId: 'shop-a',
      acceptedIdentityIds: ['client-a'],
      source: 'roles+seller-info',
    });
    assert.equal(confirmed.connected, true);
    assert.equal(confirmed.profile.configStatus, '连接成功');
    assert.equal(confirmed.profile.identityStatus, 'verified');
    assert.equal(confirmed.profile.apiIdentityId, 'client-a');
    db.prepare(`
      UPDATE integration_profiles
      SET config_status = '等待 API 核对', identity_status = 'browser-matched',
          identity_source = 'seller-browser-company'
      WHERE id = 'ozon-a'
    `).run();
    const delayedMatchingRefreshAt = new Date(Date.parse(reconnectedAt) + 10_000).toISOString();
    const delayedMatchingRefresh = repository.saveBrowserLoginState('ozon-a', {
      loggedIn: true,
      cookieSaved: true,
      verifiedAt: delayedMatchingRefreshAt,
      companyId: 'client-a',
      companyName: 'Seller A',
    });
    assert.equal(delayedMatchingRefresh.connected, true);
    assert.equal(delayedMatchingRefresh.identityStatus, 'verified');
    assert.equal(delayedMatchingRefresh.profile.configStatus, '连接成功');
    assert.equal(delayedMatchingRefresh.profile.identityVerifiedAt, confirmed.profile.identityVerifiedAt);
    const staleInvalidation = repository.saveBrowserLoginState('ozon-a', {
      loggedIn: false,
      cookieSaved: false,
      verifiedAt: staleInvalidationAt,
    });
    assert.equal(staleInvalidation.stale, true);
    assert.equal(staleInvalidation.connected, true);
    assert.equal(staleInvalidation.profile.tokenStatus, 'Cookie 已保存');
    const mismatch = repository.saveBrowserLoginState('ozon-a', {
      loggedIn: true,
      cookieSaved: true,
      verifiedAt: new Date(Date.parse(reconnectedAt) + 20_000).toISOString(),
      companyId: 'client-b',
    });
    assert.equal(mismatch.connected, false);
    assert.equal(mismatch.identityStatus, 'mismatch');
    assert.equal(mismatch.profile.configStatus, '账号不匹配');
    const rejected = repository.confirmBrowserApiIdentity('ozon-a', {
      shopId: 'shop-a',
      acceptedIdentityIds: ['client-a'],
    });
    assert.equal(rejected.connected, false);
    assert.equal(rejected.profile.identityStatus, 'mismatch');
    assert.equal(rejected.profile.apiIdentityId, 'client-a');
    assert.throws(
      () => repository.saveBrowserLoginState('missing-profile', { loggedIn: true, cookieSaved: true }),
      /PURCHASE_BROWSER_INTEGRATION_PROFILE_NOT_FOUND/u,
    );
    assert.throws(
      () => repository.saveProfile({
        id: 'ozon-a-duplicate', integrationType: 'ozon-browser-session', platformName: '重复绑定',
        shopId: 'shop-a',
      }),
      /OZON_BROWSER_SHOP_ALREADY_BOUND/u,
    );
    assert.throws(
      () => repository.saveProfile({
        id: 'ozon-missing', integrationType: 'ozon-browser-session', platformName: '不存在店铺',
        shopId: 'shop-missing',
      }),
      /OZON_BROWSER_SHOP_NOT_FOUND/u,
    );
    const second = repository.saveProfile({
      id: 'ozon-b', integrationType: 'ozon-browser-session', platformName: 'Ozon 2店网页登录',
      shopId: 'shop-b', configStatus: '待登录', tokenStatus: 'Cookie 未保存',
    });
    assert.equal(second.profile.shopId, 'shop-b');
    assert.deepEqual(
      repository.listProfiles().filter((profile) => profile.integrationType === 'ozon-browser-session')
        .map((profile) => [profile.id, profile.shopId]).sort(),
      [['ozon-a', 'shop-a'], ['ozon-b', 'shop-b']],
    );
    db.prepare('DELETE FROM shops WHERE id = ?').run('shop-a');
    assert.equal(repository.getProfile('ozon-a').shopId, '');
    assert.equal(repository.getProfile('ozon-b').shopId, 'shop-b');
  } finally {
    db.close();
  }
});

test('follow-seller front browser profiles allow multiple global saved logins without a shop binding', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createIntegrationProfileRepository(db);
    const first = repository.saveProfile({
      id: 'patrol-a-1',
      integrationType: 'ozon-follow-seller-session',
      platformName: 'Ozon 前台巡查 1',
      configStatus: '待登录',
      tokenStatus: 'Cookie 未保存',
    });
    const second = repository.saveProfile({
      id: 'patrol-a-2',
      integrationType: 'ozon-follow-seller-session',
      platformName: 'Ozon 前台巡查 2',
      configStatus: '待登录',
      tokenStatus: 'Cookie 未保存',
    });
    assert.equal(first.profile.shopId, '');
    assert.equal(second.profile.shopId, '');
    assert.equal(repository.saveBrowserLoginState('patrol-a-2', {
      loggedIn: true,
      cookieSaved: true,
    }).connected, true);
    assert.equal(repository.getProfile('patrol-a-2').tokenStatus, 'Cookie 已保存');
  } finally {
    db.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPurchaseAccountRepository } from './purchaseAccountRepository.js';
import { createMigratedTestDb } from '../../../test/testDb.js';

test('purchase account repository encrypts login passwords, keeps one default, and returns public records only', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseAccountRepository(db);
    const first = repository.saveAccount({
      id: 'purchase-a', name: '1688 主账号', platformName: '1688', loginAccount: 'seller-a',
      loginPassword: 'password-a', recipientNickname: '七号仓', recipientPhone: '13800000000',
      recipientAddress: '凤凰北路15号', isDefault: true,
    });
    const second = repository.saveAccount({
      id: 'purchase-b', name: '淘宝备用账号', platformName: '淘宝', loginPassword: 'password-b',
      recipientNickname: '七号仓', recipientPhone: '13800000000', recipientAddress: '凤凰北路15号',
      isDefault: true,
    });
    assert.equal(first.account.hasLoginPassword, true);
    assert.equal(second.account.hasLoginPassword, true);
    assert.equal(JSON.stringify(repository.listAccounts()).includes('password-'), false);
    assert.equal(repository.listAccounts().find((account) => account.id === 'purchase-a').isDefault, false);
    assert.equal(repository.listAccounts().find((account) => account.id === 'purchase-b').isDefault, true);
    assert.deepEqual(
      repository.listAccounts().find((account) => account.id === 'purchase-b'),
      {
        id: 'purchase-b',
        name: '淘宝采购号',
        platformName: '淘宝',
        platformUrl: 'https://www.taobao.com/',
        loginAccount: '',
        hasLoginPassword: true,
        loginPasswordHint: '••••••••••',
        recipientNickname: '七号仓',
        recipientPhone: '13800000000',
        recipientAddress: '凤凰北路15号',
        browserLoginStatus: '未验证',
        cookieStatus: 'Cookie 未保存',
        lastLoginVerifiedAt: '',
        isDefault: true,
        createdAt: second.account.createdAt,
        updatedAt: second.account.updatedAt,
      },
    );
    assert.equal(repository.getCredentialsForInternalUse('purchase-a').loginPassword, 'password-a');
    assert.equal(db.prepare('SELECT login_password_encrypted FROM purchase_accounts WHERE id = ?').get('purchase-b').login_password_encrypted.includes('password-b'), false);
  } finally {
    db.close();
  }
});

test('purchase account repository persists verified browser login state and preserves it on profile edits', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseAccountRepository(db);
    repository.saveAccount({
      id: 'purchase-login-a',
      name: '1688采购号',
      platformName: '1688',
      recipientNickname: '一号仓',
    });
    const verifiedAt = '2026-08-11T08:30:00.000Z';
    const saved = repository.saveLoginState('purchase-login-a', {
      loggedIn: true,
      cookieSaved: true,
      verifiedAt,
    });
    assert.equal(saved.account.browserLoginStatus, '已登录');
    assert.equal(saved.account.cookieStatus, 'Cookie 已保存');
    assert.equal(saved.account.lastLoginVerifiedAt, verifiedAt);
    assert.equal(JSON.stringify(saved).includes('cookieValue'), false);

    const edited = repository.saveAccount({
      id: 'purchase-login-a',
      name: '1688采购号',
      platformName: '1688',
      recipientNickname: '二号仓',
    });
    assert.equal(edited.account.recipientNickname, '二号仓');
    assert.equal(edited.account.cookieStatus, 'Cookie 已保存');
    assert.equal(edited.account.lastLoginVerifiedAt, verifiedAt);
    assert.throws(
      () => repository.saveLoginState('purchase-login-a', {
        loggedIn: false,
        cookieSaved: true,
        verifiedAt,
      }),
      /PURCHASE_BROWSER_LOGIN_NOT_VERIFIED/u,
    );
  } finally {
    db.close();
  }
});

test('purchase account repository rejects a platform URL that does not match the selected platform', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseAccountRepository(db);
    assert.throws(
      () => repository.saveAccount({
        id: 'purchase-invalid-url',
        name: '拼多多采购号',
        platformName: '拼多多',
        platformUrl: 'https://www.taobao.com/',
      }),
      /platform URL does not match/u,
    );
  } finally {
    db.close();
  }
});

test('purchase account repository keeps the Ozon buyer account separate from seller integration profiles', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseAccountRepository(db);
    const saved = repository.saveAccount({
      id: 'purchase-ozon-buyer',
      platformName: 'Ozon买家',
      name: 'Ozon买家采购号',
      platformUrl: 'https://www.ozon.ru/',
    });
    assert.equal(saved.account.platformName, 'Ozon买家');
    assert.equal(saved.account.platformUrl, 'https://www.ozon.ru/');
    assert.equal(saved.account.name, 'Ozon买家采购号');
  } finally {
    db.close();
  }
});

test('purchase account repository accepts every collection marketplace preset without frontend/backend drift', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseAccountRepository(db);
    const rows = [
      ['拼多多', '拼多多采购号', 'https://mobile.yangkeduo.com/'],
      ['天猫', '天猫采购号', 'https://www.tmall.com/'],
      ['淘宝', '淘宝采购号', 'https://www.taobao.com/'],
      ['1688', '1688采购号', 'https://www.1688.com/'],
      ['Ozon买家', 'Ozon买家采购号', 'https://www.ozon.ru/'],
      ['京东', '京东采购号', 'https://www.jd.com/'],
      ['Wildberries', 'Wildberries采购号', 'https://www.wildberries.ru/'],
      ['Amazon', 'Amazon采购号', 'https://www.amazon.com/'],
      ['Temu', 'Temu采购号', 'https://www.temu.com/'],
      ['AliExpress', 'AliExpress采购号', 'https://www.aliexpress.com/'],
    ];
    rows.forEach(([platformName, accountAlias, platformUrl], index) => {
      const saved = repository.saveAccount({
        id: `purchase-platform-${index + 1}`,
        platformName,
        name: accountAlias,
        platformUrl,
      }).account;
      assert.equal(saved.platformName, platformName);
      assert.equal(saved.name, accountAlias);
      assert.equal(saved.platformUrl, platformUrl);
    });
    assert.equal(repository.listAccounts().length, rows.length);
  } finally {
    db.close();
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createPerformanceAccountRepository } from '../src/db/repositories/performanceAccountRepository.js';
import { isEncryptedSecret } from '../src/security/secretCrypto.js';
import { createMigratedTestDb } from './testDb.js';

test('performance account repository encrypts SQLite credentials and returns only public flags', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPerformanceAccountRepository(db);
    db.prepare("INSERT INTO shops (id, name, status, created_at, updated_at) VALUES ('shop-performance-unit', 'Performance unit', 'active', datetime('now'), datetime('now'))").run();
    const result = repository.saveAccount({
      id: 'performance-unit',
      name: 'Ozon Performance API',
      clientId: 'unit@advertising.performance.ozon.ru',
      clientSecret: 'dummy-secret-placeholder',
      status: 'active',
      shopId: 'shop-performance-unit',
    });

    assert.equal(result.ok, true);
    assert.equal(result.account.hasClientId, true);
    assert.equal(result.account.hasClientSecret, true);
    assert.equal(result.account.shopId, 'shop-performance-unit');
    assert.equal('clientSecret' in result.account, false);

    const row = db
      .prepare('SELECT client_secret_encrypted FROM performance_accounts WHERE id = ?')
      .get('performance-unit');
    assert.equal(isEncryptedSecret(row.client_secret_encrypted), true);
    assert.equal(row.client_secret_encrypted.includes('dummy-secret-placeholder'), false);

    const credentials = repository.getCredentialsForInternalUse('performance-unit');
    assert.equal(credentials.clientId, 'unit@advertising.performance.ozon.ru');
    assert.equal(credentials.clientSecret, 'dummy-secret-placeholder');
    assert.equal(credentials.shopId, 'shop-performance-unit');

    const accountsText = JSON.stringify(repository.listAccounts());
    assert.equal(accountsText.includes('dummy-secret-placeholder'), false);
  } finally {
    db.close();
  }
});

test('performance credentials survive repository restart and empty masked-secret saves', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-performance-account-'));
  const databasePath = path.join(root, 'profile.sqlite');
  try {
    let db = createMigratedTestDb(databasePath);
    let repository = createPerformanceAccountRepository(db);
    db.prepare("INSERT INTO shops (id, name, status, created_at, updated_at) VALUES ('shop-performance-restart', 'Performance restart', 'active', datetime('now'), datetime('now'))").run();
    repository.saveAccount({
      id: 'performance-restart',
      name: 'Ozon Performance API',
      clientId: 'restart@advertising.performance.ozon.ru',
      clientSecret: 'restart-secret-placeholder',
      status: 'active',
      shopId: 'shop-performance-restart',
    });
    db.close();

    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA foreign_keys = ON;');
    repository = createPerformanceAccountRepository(db);
    const saved = repository.saveAccount({
      id: 'performance-restart',
      name: 'Ozon Performance API renamed',
      clientSecret: '',
      note: 'remark-only save after restart',
    });

    assert.equal(saved.account.status, 'active');
    assert.equal(saved.account.hasClientSecret, true);
    assert.equal(saved.account.shopId, 'shop-performance-restart');
    assert.equal(
      repository.getCredentialsForInternalUse('performance-restart').clientSecret,
      'restart-secret-placeholder',
    );

    const cleared = repository.saveAccount({
      id: 'performance-restart',
      name: 'Ozon Performance API renamed',
      clearClientSecret: true,
    });
    assert.equal(cleared.account.hasClientSecret, false);
    assert.equal(repository.getCredentialsForInternalUse('performance-restart').clientSecret, null);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('performance account shop binding rejects unknown/disabled shops and remains stable on masked saves', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPerformanceAccountRepository(db);
    db.prepare("INSERT INTO shops (id, name, status, created_at, updated_at) VALUES ('shop-bound', 'Bound', 'active', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO shops (id, name, status, created_at, updated_at) VALUES ('shop-disabled', 'Disabled', 'disabled', datetime('now'), datetime('now'))").run();

    assert.throws(
      () => repository.saveAccount({ name: 'Unknown', shopId: 'shop-unknown' }),
      /PERFORMANCE_ACCOUNT_SHOP_NOT_FOUND/u,
    );
    assert.throws(
      () => repository.saveAccount({ name: 'Disabled', shopId: 'shop-disabled' }),
      /PERFORMANCE_ACCOUNT_SHOP_DISABLED/u,
    );

    const saved = repository.saveAccount({
      id: 'performance-bound',
      name: 'Bound account',
      shopId: 'shop-bound',
      clientId: 'bound-client',
      clientSecret: 'bound-secret',
    });
    const renamed = repository.saveAccount({ id: saved.account.id, name: 'Renamed' });
    assert.equal(renamed.account.shopId, 'shop-bound');
    assert.equal(repository.getCredentialsForInternalUse(saved.account.id).shopId, 'shop-bound');
  } finally {
    db.close();
  }
});

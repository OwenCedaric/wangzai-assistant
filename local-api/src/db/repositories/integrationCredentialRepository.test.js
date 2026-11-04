import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createIntegrationProfileRepository } from './integrationProfileRepository.js';
import { createIntegrationCredentialRepository } from './integrationCredentialRepository.js';
import { createAccountRemovalSqliteExecutor } from '../../domain/accountRemoval/accountRemovalSqliteExecutor.js';

test('integration credential repository encrypts secrets and only exposes fixed masks', () => {
  const db = createMigratedTestDb();
  try {
    createIntegrationProfileRepository(db).saveProfile({
      id: 'seerfar-a',
      integrationType: 'seerfar-open-api',
      platformName: 'Seerfar A',
    });
    const repository = createIntegrationCredentialRepository(db);
    const saved = repository.saveCredential('seerfar-a', {
      baseUrl: 'https://api.seerfar.cn',
      loginAccount: 'owner@example.com',
      loginPassword: 'login-secret',
      apiKey: 'api-secret',
    });

    assert.equal(saved.credential.hasLoginPassword, true);
    assert.equal(saved.credential.hasApiKey, true);
    assert.equal(saved.credential.loginPasswordHint, '••••••••••');
    assert.equal(saved.credential.apiKeyHint, '••••••••••');
    assert.equal(JSON.stringify(saved), JSON.stringify(saved).replace(/login-secret|api-secret/gu, ''));

    const stored = db.prepare(`
      SELECT login_password_encrypted, api_key_encrypted
      FROM integration_credentials WHERE profile_id = ?
    `).get('seerfar-a');
    assert.match(stored.login_password_encrypted, /^secretbox:v1:/u);
    assert.match(stored.api_key_encrypted, /^secretbox:v1:/u);

    const internal = repository.getCredentialsForInternalUse('seerfar-a');
    assert.equal(internal.loginPassword, 'login-secret');
    assert.equal(internal.apiKey, 'api-secret');

    repository.saveCredential('seerfar-a', { baseUrl: 'https://api.seerfar.cn' });
    assert.equal(repository.getCredentialsForInternalUse('seerfar-a').apiKey, 'api-secret');
  } finally {
    db.close();
  }
});

test('integration credentials are removed with their profile', () => {
  const db = createMigratedTestDb();
  try {
    const profiles = createIntegrationProfileRepository(db);
    profiles.saveProfile({ id: 'linkfox-a', integrationType: 'linkfox-agent', platformName: 'LinkFox A' });
    createIntegrationCredentialRepository(db).saveCredential('linkfox-a', {
      baseUrl: 'https://tool-gateway.linkfox.com',
      apiKey: 'secret',
    });
    createAccountRemovalSqliteExecutor({ db }).execute({
      ownerType: 'integration_profile',
      ownerId: 'linkfox-a',
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM integration_credentials').get().total, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM integration_profiles').get().total, 0);
  } finally {
    db.close();
  }
});

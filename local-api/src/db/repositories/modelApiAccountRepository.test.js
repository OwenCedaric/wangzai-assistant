import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelApiAccountRepository } from './modelApiAccountRepository.js';
import { createMigratedTestDb } from '../../../test/testDb.js';

test('model API account repository encrypts both secrets and exposes only public flags', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createModelApiAccountRepository(db);
    const first = repository.saveAccount({
      id: 'model-a', apiAlias: 'image2 主接口', provider: 'codesonline', loginAccount: 'user-a',
      loginPassword: 'login-secret-a', apiKey: 'api-key-a', defaultModel: 'gpt-image-2', isDefault: true,
      availableModels: [{
        id: 'gpt-image-2',
        capabilities: ['image-edit'],
        options: { quality: [{ id: 'high', label: '高清' }] },
      }],
      capabilities: ['image-edit'], discoveryVerified: true,
    });
    const second = repository.saveAccount({
      id: 'model-b', apiAlias: '备用接口', apiKey: 'api-key-b', isDefault: true,
    });
    assert.equal(first.account.hasLoginPassword, true);
    assert.equal(first.account.hasApiKey, true);
    assert.equal(JSON.stringify(repository.listAccounts()).includes('secret-a'), false);
    assert.equal(repository.listAccounts().find((account) => account.id === 'model-a').isDefault, false);
    assert.equal(repository.getCredentialsForInternalUse('model-a').loginPassword, 'login-secret-a');
    assert.equal(repository.getCredentialsForInternalUse('model-a').apiKey, 'api-key-a');
    assert.deepEqual(repository.listAccounts().find((account) => account.id === 'model-a').availableModels, [
      {
        id: 'gpt-image-2',
        label: 'gpt-image-2',
        capabilities: ['image-edit'],
        modalities: [],
        options: { quality: [{ id: 'high', label: '高清' }] },
      },
    ]);
    assert.equal(repository.listAccounts().find((account) => account.id === 'model-a').discoveryVerified, true);
    const row = db.prepare('SELECT login_password_encrypted, api_key_encrypted FROM model_api_accounts WHERE id = ?').get('model-b');
    assert.equal(row.login_password_encrypted, null);
    assert.equal(row.api_key_encrypted.includes('api-key-b'), false);
    assert.equal(second.account.isDefault, true);
  } finally {
    db.close();
  }
});

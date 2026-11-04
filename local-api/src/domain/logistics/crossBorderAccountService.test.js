import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createCrossBorderAccountRepository } from '../../db/repositories/crossBorderAccountRepository.js';
import { createCrossBorderAccountService } from './crossBorderAccountService.js';

test('explicit cross-border authorization persists access, expires token and app uid together', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'cross-border-account-service-test-secret';
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderAccountRepository(db);
    repository.saveAccount({
      id: 'cross-border-main',
      name: '跨境巴士主授权',
      userName: 'user-name',
      password: 'password',
      companySecret: 'company-secret',
      status: 'active',
    });
    const service = createCrossBorderAccountService({
      db,
      crossBorderClient: {
        authorizeUser: async () => ({
          accessToken: 'fresh-access',
          expiresToken: 'fresh-expires',
          appUid: 'fresh-app-uid',
        }),
        requestReadOnly: async () => ({ data: { code: 1, message: 'authorized' } }),
      },
    });

    const result = await service.authorizeAccount('cross-border-main');
    const credentials = repository.getCredentialsForInternalUse('cross-border-main');

    assert.equal(result.ok, true);
    assert.equal(result.account.hasExpiresToken, true);
    assert.equal(credentials.accessToken, 'fresh-access');
    assert.equal(credentials.expiresToken, 'fresh-expires');
    assert.equal(credentials.appUid, 'fresh-app-uid');
  } finally {
    db.close();
    if (previousSecret == null) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});

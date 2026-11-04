import { createCrossBorderAccountRepository } from '../../db/repositories/crossBorderAccountRepository.js';

function hasCrossBorderAccountsTable(db) {
  try {
    return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cross_border_accounts'").get());
  } catch {
    return false;
  }
}

export function createCrossBorderAccountService({
  db,
  crossBorderClient,
  profileId = 'default',
  tenantId = 'tenant_local_default',
  userId = '',
} = {}) {
  const repository = db && hasCrossBorderAccountsTable(db)
    ? createCrossBorderAccountRepository(db, { profileId, tenantId, userId })
    : null;

  function ensureRepository() {
    if (!repository) {
      const error = new Error('cross-border account SQLite table is not connected.');
      error.code = 'CROSS_BORDER_ACCOUNTS_NOT_CONNECTED';
      throw error;
    }
    return repository;
  }

  function listAccounts() {
    return { ok: true, rows: ensureRepository().listAccounts() };
  }

  function saveAccount(payload = {}) {
    return ensureRepository().saveAccount(payload);
  }

  function deleteAccount(accountId) {
    return ensureRepository().deleteAccount(accountId);
  }

  function resolveAccountShopScope(input = {}) {
    return ensureRepository().resolveAccountShopScope(input);
  }

  async function testAccount(accountId) {
    const repository = ensureRepository();
    const account = repository.getPublicAccountById(accountId);
    if (!account) {
      return {
        ok: false,
        error: { code: 'CROSS_BORDER_ACCOUNT_NOT_FOUND', message: '跨境巴士授权账号不存在。' },
      };
    }
    const credentials = repository.getCredentialsForInternalUse(accountId);
    if (!credentials?.hasCompanySecret || !credentials?.hasAccessToken || !credentials?.hasAppUid) {
      return {
        ok: false,
        account,
        error: {
          code: 'CROSS_BORDER_CREDENTIALS_REQUIRED',
          message: '跨境巴士账号缺少企业 API、Token 或授权用户 ID。',
        },
      };
    }
    if (!crossBorderClient?.requestReadOnly) {
      return {
        ok: false,
        account,
        error: {
          code: 'CROSS_BORDER_CONNECTION_TEST_NOT_CONNECTED',
          message: '跨境巴士真实连接测试尚未接入。',
        },
      };
    }
    try {
      const result = await crossBorderClient.requestReadOnly({
        endpointKey: 'auth.queryAuthorization',
        credentials,
        body: { app_user_id: credentials.appUid },
      });
      return {
        ok: true,
        account,
        endpointKey: 'auth.queryAuthorization',
        data: result.data,
        message: result.data?.message || '跨境巴士授权读取成功。',
      };
    } catch (error) {
      return {
        ok: false,
        account,
        endpointKey: 'auth.queryAuthorization',
        error: {
          code: error.code || 'CROSS_BORDER_CONNECTION_TEST_FAILED',
          message: error instanceof Error ? error.message : String(error),
          response: error.response,
        },
      };
    }
  }

  async function authorizeAccount(accountId) {
    const repository = ensureRepository();
    const account = repository.getPublicAccountById(accountId);
    if (!account) {
      return {
        ok: false,
        error: { code: 'CROSS_BORDER_ACCOUNT_NOT_FOUND', message: '跨境巴士授权账号不存在。' },
      };
    }
    const credentials = repository.getCredentialsForInternalUse(accountId);
    if (
      !credentials?.hasUserName
      || !credentials?.hasPassword
      || !credentials?.hasCompanySecret
    ) {
      return {
        ok: false,
        account,
        error: {
          code: 'CROSS_BORDER_AUTHORIZATION_CREDENTIALS_REQUIRED',
          message: '请先保存跨境巴士用户名、密码和企业 API。',
        },
      };
    }
    if (!crossBorderClient?.authorizeUser || !crossBorderClient?.requestReadOnly) {
      return {
        ok: false,
        account,
        error: {
          code: 'CROSS_BORDER_AUTHORIZATION_NOT_CONNECTED',
          message: '跨境巴士自动授权服务尚未接通。',
        },
      };
    }
    try {
      const authorization = await crossBorderClient.authorizeUser({ credentials });
      const verification = await crossBorderClient.requestReadOnly({
        endpointKey: 'auth.queryAuthorization',
        credentials: {
          ...credentials,
          accessToken: authorization.accessToken,
          appUid: authorization.appUid,
        },
        body: { app_user_id: authorization.appUid },
      });
      const saved = repository.saveAccount({
        id: account.id,
        name: account.name,
        status: 'active',
        accessToken: authorization.accessToken,
        expiresToken: authorization.expiresToken,
        appUid: authorization.appUid,
      });
      return {
        ok: true,
        verified: true,
        account: saved.account,
        message: verification.data?.message || '跨境巴士授权成功。',
      };
    } catch (error) {
      return {
        ok: false,
        account,
        error: {
          code: error.code || 'CROSS_BORDER_AUTHORIZATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
          response: error.response,
        },
      };
    }
  }

  return {
    domain: 'cross-border-accounts',
    listAccounts,
    saveAccount,
    deleteAccount,
    resolveAccountShopScope,
    testAccount,
    authorizeAccount,
  };
}

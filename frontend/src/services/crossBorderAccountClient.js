import {
  authorizeCrossBorderAccount,
  getCrossBorderAccounts,
  requestLocalApi,
  saveCrossBorderAccount,
  testCrossBorderAccount,
} from '../api/localApiClient.js';
import {
  authorizeCrossBorderWithServer,
  readCrossBorderWithServer,
  revokeCrossBorderWithServer,
} from '../features/licensing/services/licenseCenterClient.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function hasAnyOwn(input = {}, keys = []) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(input, key));
}

function firstCredentialValue(input = {}, keys = []) {
  for (const key of keys) {
    const value = normalizeText(input[key]);
    if (value) return value;
  }
  return '';
}

export function toCrossBorderAccountPayload(input = {}) {
  const payload = {
    id: normalizeText(input.id),
    name: normalizeText(input.name || input.accountName || '跨境巴士主授权'),
    status: normalizeText(input.status || 'active'),
    defaultStorehouse: normalizeText(input.defaultStorehouse || input.default_storehouse),
    defaultSection: normalizeText(input.defaultSection || input.default_section),
    defaultService: normalizeText(input.defaultService || input.default_service),
    note: normalizeText(input.note),
  };
  if (hasAnyOwn(input, ['shopIds', 'shop_ids'])) {
    payload.shopIds = [...new Set((Array.isArray(input.shopIds ?? input.shop_ids) ? input.shopIds ?? input.shop_ids : [])
      .map((shopId) => normalizeText(shopId))
      .filter(Boolean))];
  }
  if (input.accountRemovalRebind === true) payload.accountRemovalRebind = true;
  if (hasAnyOwn(input, ['userName', 'user_name'])) {
    const userName = firstCredentialValue(input, ['userName', 'user_name']);
    if (userName) payload.userName = userName;
  }
  if (hasAnyOwn(input, ['password'])) {
    const password = firstCredentialValue(input, ['password']);
    if (password) payload.password = password;
  }
  if (hasAnyOwn(input, ['companySecret', 'company_secret'])) {
    const companySecret = firstCredentialValue(input, ['companySecret', 'company_secret']);
    if (companySecret) payload.companySecret = companySecret;
  }
  if (hasAnyOwn(input, ['accessToken', 'access_token'])) {
    const accessToken = firstCredentialValue(input, ['accessToken', 'access_token']);
    if (accessToken) payload.accessToken = accessToken;
  }
  if (hasAnyOwn(input, ['appUid', 'app_uid'])) {
    const appUid = firstCredentialValue(input, ['appUid', 'app_uid']);
    if (appUid) payload.appUid = appUid;
  }
  return payload;
}

export function toCrossBorderServerAccountPayload(input = {}) {
  const payload = {
    id: normalizeText(input.id || input.crossBorderAccountId),
    name: normalizeText(input.name || input.accountName || input.accountAlias || '跨境巴士服务器授权'),
    status: normalizeText(input.status || 'active'),
    authorizationRef: normalizeText(input.authorizationRef || input.authorization_ref),
    authorizationExpiresAt: normalizeText(
      input.authorizationExpiresAt || input.authorization_expires_at,
    ),
    defaultStorehouse: normalizeText(input.defaultStorehouse || input.cooperationWarehouse),
    defaultSection: normalizeText(input.defaultSection || input.sectionId),
    defaultService: normalizeText(input.defaultService || input.packageService),
    note: normalizeText(input.note),
  };
  if (hasAnyOwn(input, ['shopIds', 'shop_ids'])) {
    payload.shopIds = [...new Set(
      (Array.isArray(input.shopIds ?? input.shop_ids) ? input.shopIds ?? input.shop_ids : [])
        .map((shopId) => normalizeText(shopId))
        .filter(Boolean),
    )];
  }
  if (input.accountRemovalRebind === true) payload.accountRemovalRebind = true;
  return payload;
}

export function selectCrossBorderAccount(rows = [], preferredId = '') {
  const accounts = Array.isArray(rows) ? rows : [];
  const preferred = normalizeText(preferredId);
  return (
    accounts.find((account) => normalizeText(account?.id) === preferred) ||
    accounts.find((account) => account?.status === 'active') ||
    accounts[0] ||
    null
  );
}

export function toCrossBorderPublicSettings(account = {}) {
  if (!account || typeof account !== 'object') return {};
  const shopIds = Array.isArray(account.shopIds)
    ? [...new Set(account.shopIds.map((shopId) => normalizeText(shopId)).filter(Boolean))]
    : [];
  return {
    crossBorderAccountId: normalizeText(account.id),
    accountSaved: Boolean(normalizeText(account.id)),
    accountAlias: normalizeText(account.name),
    status: normalizeText(account.status || 'inactive'),
    shopIds,
    shopCount: Number(account.shopCount) || shopIds.length,
    userName: '',
    hasUserName: false,
    hasPassword: false,
    hasCompanySecret: false,
    hasAccessToken: false,
    hasExpiresToken: false,
    hasAppUid: false,
    authorizationRef: normalizeText(account.authorizationRef || account.authorization_ref),
    authorizationExpiresAt: normalizeText(
      account.authorizationExpiresAt || account.authorization_expires_at,
    ),
    hasServerAuthorization: Boolean(
      account.hasServerAuthorization
      || account.authorizationRef
      || account.authorization_ref,
    ),
    cooperationWarehouse: normalizeText(account.defaultStorehouse),
    sectionId: normalizeText(account.defaultSection),
    packageService: normalizeText(account.defaultService),
    connectionStatus:
      account.hasServerAuthorization || account.authorizationRef || account.authorization_ref
        ? '服务器授权已保存'
        : '等待服务器授权',
    connectionMessage:
      account.hasServerAuthorization || account.authorizationRef || account.authorization_ref
        ? '企业 API 由管理端统一保管，客户端只保存不透明授权。'
        : '请填写账号和密码完成一次性服务器授权。',
  };
}

export function readCrossBorderAccounts(options = {}) {
  return getCrossBorderAccounts(options);
}

export function saveCrossBorderAccountSettings(input = {}, options = {}) {
  return saveCrossBorderAccount(toCrossBorderAccountPayload(input), options);
}

export function saveCrossBorderServerAccountSettings(input = {}, options = {}) {
  return saveCrossBorderAccount(toCrossBorderServerAccountPayload(input), options);
}

export function deleteCrossBorderAccountSettings(accountId, options = {}) {
  void accountId;
  void options;
  const error = new Error('账号删除必须使用统一预览、确认和回读流程。');
  error.code = 'ACCOUNT_REMOVAL_UNIFIED_FLOW_REQUIRED';
  return Promise.reject(error);
}

export async function revokeAndDeleteCrossBorderAccountThroughServer(settings = {}, options = {}) {
  const accountId = normalizeText(settings.id || settings.crossBorderAccountId);
  const authorizationRef = normalizeText(
    settings.authorizationRef || settings.authorization_ref,
  );
  if (!accountId) throw new Error('缺少跨境巴士本地账号标识');
  if (authorizationRef) {
    await revokeCrossBorderWithServer({
      accountRef: accountId,
      authorizationRef,
    }, options);
  }
  await requestLocalApi(
    `/api/logistics/cross-border/server-accounts/${encodeURIComponent(accountId)}`,
    {
      method: 'DELETE',
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    },
  );
  return { ok: true, deleted: true, accountId, revoked: Boolean(authorizationRef) };
}

export function testCrossBorderAccountConnection(accountId, options = {}) {
  return testCrossBorderAccount(accountId, options);
}

export function authorizeCrossBorderAccountConnection(accountId, options = {}) {
  return authorizeCrossBorderAccount(normalizeText(accountId), options);
}

export async function authorizeCrossBorderAccountThroughServer(input = {}, options = {}) {
  const accountId = normalizeText(input.id || input.crossBorderAccountId);
  if (!accountId) throw new Error('缺少跨境巴士本地账号标识');
  const userName = normalizeText(input.userName);
  const requestedAlias = normalizeText(input.accountAlias || input.name);
  const accountAlias = requestedAlias && !/^跨境巴士授权(?:\s+\d+)?$/u.test(requestedAlias)
    ? requestedAlias
    : `跨境巴士 ${userName.slice(-4) || '账号'}`;
  const authorization = await authorizeCrossBorderWithServer({
    accountRef: accountId,
    userName,
    password: input.password,
    previousAuthorizationRef: input.authorizationRef || input.authorization_ref,
  }, options);
  const saved = await saveCrossBorderAccount(
    toCrossBorderServerAccountPayload({
      ...input,
      id: accountId,
      accountAlias,
      authorizationRef: authorization.authorization_ref,
      authorizationExpiresAt: authorization.expires_at,
      status: 'active',
    }),
    options,
  );
  return { ...authorization, account: saved?.account || saved };
}

export function readCrossBorderAccountThroughServer(settings = {}, endpointKey, body = {}) {
  const authorizationRef = normalizeText(
    settings.authorizationRef || settings.authorization_ref,
  );
  if (!authorizationRef) throw new Error('跨境巴士服务器授权不存在，请重新授权');
  return readCrossBorderWithServer({ authorizationRef, endpointKey, body });
}

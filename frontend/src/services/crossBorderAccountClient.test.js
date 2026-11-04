import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeCrossBorderAccountConnection,
  authorizeCrossBorderAccountThroughServer,
  deleteCrossBorderAccountSettings,
  readCrossBorderAccounts,
  revokeAndDeleteCrossBorderAccountThroughServer,
  saveCrossBorderAccountSettings,
  selectCrossBorderAccount,
  testCrossBorderAccountConnection,
  toCrossBorderPublicSettings,
  toCrossBorderAccountPayload,
  toCrossBorderServerAccountPayload,
} from './crossBorderAccountClient';

describe('crossBorderAccountClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
    delete globalThis.window?.wangzaiDesktop;
  });

  it('builds account payload without changing UI field names', () => {
    expect(
      toCrossBorderAccountPayload({
        id: 'cb-1',
        accountName: '主授权',
        user_name: 'legacy-user',
        password: 'legacy-password',
        company_secret: 'secret',
        access_token: 'token',
        app_uid: 'uid',
        shopIds: ['shop-a', 'shop-b', 'shop-a'],
      })
    ).toMatchObject({
      id: 'cb-1',
      name: '主授权',
      userName: 'legacy-user',
      password: 'legacy-password',
      companySecret: 'secret',
      accessToken: 'token',
      appUid: 'uid',
      shopIds: ['shop-a', 'shop-b'],
    });
  });

  it('omits blank credential fields so SQLite can preserve encrypted credentials', () => {
    const payload = toCrossBorderAccountPayload({
      id: 'cb-1',
      accountName: '主授权',
      companySecret: '',
      accessToken: '',
      appUid: '',
      userName: '',
      password: '',
      defaultStorehouse: 'WH-1',
    });

    expect(payload).toMatchObject({
      id: 'cb-1',
      name: '主授权',
      defaultStorehouse: 'WH-1',
    });
    expect(payload).not.toHaveProperty('companySecret');
    expect(payload).not.toHaveProperty('accessToken');
    expect(payload).not.toHaveProperty('appUid');
    expect(payload).not.toHaveProperty('userName');
    expect(payload).not.toHaveProperty('password');
  });

  it('forwards only an explicit account-removal rebind assertion', () => {
    expect(toCrossBorderAccountPayload({ id: 'cb-1', accountRemovalRebind: true }))
      .toHaveProperty('accountRemovalRebind', true);
    expect(toCrossBorderAccountPayload({ id: 'cb-1', accountRemovalRebind: false }))
      .not.toHaveProperty('accountRemovalRebind');
  });

  it('builds the V2 local account without enterprise credentials', () => {
    const payload = toCrossBorderServerAccountPayload({
      id: 'cb-v2',
      accountAlias: '服务器授权',
      authorizationRef: 'opaque-grant',
      authorizationExpiresAt: '2026-09-30T00:00:00Z',
      companySecret: 'must-not-copy',
      accessToken: 'must-not-copy',
      appUid: 'must-not-copy',
      password: 'must-not-copy',
      shopIds: ['shop-a'],
      accountRemovalRebind: true,
    });
    expect(payload).toMatchObject({
      id: 'cb-v2',
      authorizationRef: 'opaque-grant',
      shopIds: ['shop-a'],
      accountRemovalRebind: true,
    });
    expect(JSON.stringify(payload)).not.toContain('must-not-copy');
  });

  it('sends username and password once to Core V2 and saves only the opaque grant locally', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3792';
    const licenseRequest = vi.fn(async (_input) => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        authorized: true,
        authorization_ref: 'opaque-server-grant',
        expires_at: '2026-09-30T00:00:00Z',
        message: '授权成功',
      },
    }));
    globalThis.window.wangzaiDesktop = {
      license: { request: licenseRequest },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        account: {
          id: 'cb-v2',
          authorizationRef: 'opaque-server-grant',
          hasServerAuthorization: true,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const result = await authorizeCrossBorderAccountThroughServer({
      id: 'cb-v2',
      accountAlias: '服务器授权',
      userName: 'one-time-user',
      password: 'one-time-password',
      shopIds: ['shop-a'],
      companySecret: 'must-never-send',
    });
    expect(result.account.hasServerAuthorization).toBe(true);
    const serverBody = licenseRequest.mock.calls[0][0].body;
    expect(serverBody).toMatchObject({
      account_ref: 'cb-v2',
      user_name: 'one-time-user',
      password: 'one-time-password',
    });
    expect(JSON.stringify(serverBody)).not.toContain('must-never-send');
    const localBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(localBody.authorizationRef).toBe('opaque-server-grant');
    expect(JSON.stringify(localBody)).not.toContain('one-time-password');
    expect(JSON.stringify(localBody)).not.toContain('must-never-send');
  });

  it('revokes the exact server grant before deleting only that local account', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3792';
    const licenseRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, revoked: true, account_ref: 'cb-v2' },
    }));
    globalThis.window.wangzaiDesktop = { license: { request: licenseRequest } };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, deleted: true, accountId: 'cb-v2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await revokeAndDeleteCrossBorderAccountThroughServer({
      crossBorderAccountId: 'cb-v2',
      authorizationRef: 'opaque-server-grant',
    });

    expect(result).toMatchObject({ ok: true, deleted: true, revoked: true, accountId: 'cb-v2' });
    expect(licenseRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      path: '/api/core-v2/cross-border/revoke',
      body: {
        account_ref: 'cb-v2',
        authorization_ref: 'opaque-server-grant',
      },
    }));
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/logistics/cross-border/server-accounts/cb-v2',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('converts local account data into server-managed settings and ignores legacy credential flags', () => {
    const account = selectCrossBorderAccount(
      [
        { id: 'old', status: 'inactive' },
        {
          id: 'cross-border-main',
          name: '主授权',
          status: 'active',
          userName: 'cross-border-user',
          hasUserName: true,
          hasPassword: true,
          hasCompanySecret: true,
          hasAccessToken: true,
          hasExpiresToken: true,
          hasAppUid: true,
          authorizationRef: 'opaque-management-authorization',
          authorizationExpiresAt: '2026-09-30T00:00:00Z',
          defaultStorehouse: 'WH-1',
          defaultService: 'PKG-1',
          shopIds: ['shop-a', 'shop-b'],
          shopCount: 2,
        },
      ],
      'cross-border-main'
    );
    const settings = toCrossBorderPublicSettings(account);

    expect(settings).toMatchObject({
      crossBorderAccountId: 'cross-border-main',
      accountSaved: true,
      accountAlias: '主授权',
      userName: '',
      hasUserName: false,
      hasPassword: false,
      hasCompanySecret: false,
      hasAccessToken: false,
      hasExpiresToken: false,
      hasAppUid: false,
      authorizationRef: 'opaque-management-authorization',
      authorizationExpiresAt: '2026-09-30T00:00:00Z',
      hasServerAuthorization: true,
      cooperationWarehouse: 'WH-1',
      packageService: 'PKG-1',
      shopIds: ['shop-a', 'shop-b'],
      shopCount: 2,
    });
    expect(JSON.stringify(settings)).not.toContain('accessToken');
    expect(JSON.stringify(settings)).not.toContain('companySecret');
    expect(JSON.stringify(settings)).not.toContain('appUid');
  });

  it('uses local-api account routes only', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options = {}) => {
      if (String(url).endsWith('/test')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: { code: 'CROSS_BORDER_CONNECTION_TEST_NOT_CONNECTED' } }), {
            status: 501,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (options.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, account: { id: 'cb-1', hasAccessToken: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (options.method === 'DELETE') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, deleted: true, accountId: 'cb-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, rows: [{ id: 'cb-1', hasAccessToken: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    });

    await saveCrossBorderAccountSettings({ id: 'cb-1', name: '主授权', accessToken: 'token' });
    await readCrossBorderAccounts();
    await expect(authorizeCrossBorderAccountConnection('cb-1')).resolves.toMatchObject({
      ok: true,
      account: { id: 'cb-1' },
    });
    await expect(deleteCrossBorderAccountSettings('cb-1')).rejects.toMatchObject({
      code: 'ACCOUNT_REMOVAL_UNIFIED_FLOW_REQUIRED',
    });
    await expect(testCrossBorderAccountConnection('cb-1')).rejects.toMatchObject({ status: 501 });

    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes('/api/logistics/cross-border/accounts'))).toBe(
      true
    );
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api.service.kuajing84.com'))).toBe(true);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api-seller.ozon.ru'))).toBe(true);
    expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'DELETE')).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/cb-1/authorize'))).toBe(true);
  });
});

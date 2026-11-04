import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeCrossBorderWithServer,
  buildPasswordAuthPayload,
  buildSmsPayload,
  checkDesktopLicense,
  findActivationCode,
  getLicenseSession,
  heartbeatDesktopLicense,
  loginLicenseAccount,
  registerLicenseAccount,
  logoutLicenseAccount,
} from './licenseCenterClient.js';

describe('license center desktop contract', () => {
  const runtime = {
    projectCode: 'wangzai_desktop',
    deviceCode: 'WZ-device',
    version: '1.0.0',
    versionHash: 'sha256:build',
    channelCode: 'AGENT-8',
    distributionToken: 'distribution-token',
  };

  afterEach(async () => {
    await logoutLicenseAccount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('binds verified registration to project, device and distribution channel', () => {
    expect(buildSmsPayload(runtime, '13800138000', '516996')).toEqual({
      phone: '13800138000',
      code: '516996',
      project_code: 'wangzai_desktop',
      device_code: 'WZ-device',
      device_name: '旺崽助手桌面端',
      version: '1.0.0',
      version_hash: 'sha256:build',
      channel_code: 'AGENT-8',
      distribution_token: 'distribution-token',
    });
  });

  it('builds password authentication with the same sealed desktop identity', () => {
    expect(buildPasswordAuthPayload(runtime, {
      password: 'DesktopPass123!',
      email: ' DEMO@EXAMPLE.COM ',
    })).toEqual({
      password: 'DesktopPass123!',
      email: 'demo@example.com',
      project_code: 'wangzai_desktop',
      device_code: 'WZ-device',
      device_name: '旺崽助手桌面端',
      version: '1.0.0',
      version_hash: 'sha256:build',
      channel_code: 'AGENT-8',
      distribution_token: 'distribution-token',
    });
  });

  it('registers with a normalized management card and adopts the returned entitlement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'user-secret',
          refresh_token: 'refresh-secret',
          user: { id: 8, email: 'new@example.com' },
          entitlement: {
            valid: true,
            access_token: 'license-secret',
            permissions: ['orders.view'],
            expire: '2027-01-01T00:00:00Z',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await registerLicenseAccount(runtime, {
      email: 'new@example.com',
      password: 'DesktopPass123!',
      cardKey: ' aaaa-bbbb-cccc-dddd ',
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.card_key).toBe('AAAA-BBBB-CCCC-DDDD');
    expect(requestBody.project_code).toBe('wangzai_desktop');
    expect(result).not.toHaveProperty('access_token');
    expect(result.entitlement).not.toHaveProperty('access_token');
    await expect(getLicenseSession()).resolves.toMatchObject({
      authenticated: true,
      authorized: true,
      user: { id: 8 },
      entitlement: { valid: true, permissions: ['orders.view'] },
    });
  });

  it('reads only server-issued activation codes from supported fulfillment shapes', () => {
    expect(findActivationCode({ fulfillment: { activation_code: 'AAAA-BBBB-CCCC-DDDD' } })).toBe('AAAA-BBBB-CCCC-DDDD');
    expect(findActivationCode({ status: 'paid' })).toBe('');
  });

  it('keeps a fresh tokenless online grant during a temporary browser transport failure', async () => {
    const onlineResponse = new Response(
      JSON.stringify({
        valid: true,
        permissions: ['orders.view'],
        expire: '2027-01-01T00:00:00Z',
        offline_until: null,
        offline_token: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(onlineResponse).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const checked = await checkDesktopLicense(runtime);
    expect(checked.valid).toBe(true);
    expect(checked).not.toHaveProperty('offline_token');
    await expect(getLicenseSession()).resolves.toMatchObject({
      authorized: true,
      entitlement: { permissions: ['orders.view'] },
    });

    await expect(heartbeatDesktopLicense(runtime)).rejects.toMatchObject({ status: 0 });
    await expect(getLicenseSession()).resolves.toMatchObject({
      authorized: true,
      entitlement: { permissions: ['orders.view'] },
    });
  });

  it('expires browser-only authorization by volatile freshness, not by the plan expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ valid: true, permissions: ['orders.view'], expire: '2027-01-01T00:00:00Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    await checkDesktopLicense(runtime);
    expect((await getLicenseSession()).authorized).toBe(true);
    vi.advanceTimersByTime(12 * 60 * 1000 + 1);
    expect(await getLicenseSession()).toMatchObject({ authorized: false, entitlement: null });
  });

  it('turns an old desktop bridge allowlist failure into a restart instruction', async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(window, 'wangzaiDesktop');
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: {
        license: {
          request: vi.fn().mockRejectedValue(
            new Error(
              "Error invoking remote method 'license:request': Error: 请求地址不在 License Center 允许列表中",
            ),
          ),
        },
      },
    });
    try {
      await expect(authorizeCrossBorderWithServer({
        accountRef: 'account-1',
        userName: 'user-1',
        password: 'password-1',
      })).rejects.toThrow('当前桌面端尚未启用管理端授权通道，请关闭并重新打开旺崽助手。');
    } finally {
      if (previousDescriptor) Object.defineProperty(window, 'wangzaiDesktop', previousDescriptor);
      else delete window.wangzaiDesktop;
    }
  });

  it('refreshes and uses the device license token for browser cross-border requests', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/api/auth/login') {
        return new Response(JSON.stringify({
          access_token: 'browser-user-token',
          refresh_token: 'browser-refresh-token',
          user: { id: 8 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path === '/api/license/check') {
        return new Response(JSON.stringify({
          valid: true,
          access_token: 'browser-license-token',
          permissions: ['logistics.read'],
          expire: '2027-01-01T00:00:00Z',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      expect(options.headers.Authorization).toBe('Bearer browser-license-token');
      return new Response(JSON.stringify({
        ok: true,
        authorized: true,
        authorization_ref: 'opaque-grant',
        expires_at: '2026-09-30T00:00:00Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await loginLicenseAccount(runtime, 'user@example.com', 'DesktopPass123!');
    await authorizeCrossBorderWithServer({
      accountRef: 'account-1',
      userName: 'user-1',
      password: 'password-1',
    });

    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/auth/login',
      '/api/license/check',
      '/api/core-v2/cross-border/authorize',
    ]);
  });
});

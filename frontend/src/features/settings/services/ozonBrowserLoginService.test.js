import { describe, expect, it, vi } from 'vitest';
import {
  OZON_LOGIN_URL,
  hideOzonBrowserLogin,
  openOzonBrowserLogin,
  readOzonBrowserLoginStatus,
  waitForOzonBrowserLogin,
} from './ozonBrowserLoginService.js';

const browserState = {
  ok: true,
  engine: 'cef',
  activeTabId: 'tab-ozon-a',
  visible: true,
  tabs: [{
    tabId: 'tab-ozon-a',
    accountId: 'integration-ozon-a',
    title: 'Ozon Seller',
    url: 'https://seller.ozon.ru/',
  }],
};

describe('ozonBrowserLoginService', () => {
  it('uses the official Chinese Ozon Seller sign-in entry', () => {
    expect(OZON_LOGIN_URL).toBe(
      'https://seller.ozon.ru/app/registration/signin?registration=1&locale=zh-hans',
    );
  });

  it('opens Ozon SSO in an isolated integration profile and never requests cookie values', async () => {
    const command = vi.fn(async () => browserState);

    const opened = await openOzonBrowserLogin({ profileId: 'integration-ozon-a', command });

    expect(opened.tab.tabId).toBe('tab-ozon-a');
    expect(command).toHaveBeenCalledWith({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'integration-ozon-a',
      accountLabel: 'Ozon 卖家登录',
      platformName: 'Ozon',
      url: OZON_LOGIN_URL,
    });
  });

  it('polls until native verification confirms login and persistent cookie flush', async () => {
    let attempts = 0;
    const command = vi.fn(async (input) => {
      if (input.command === 'hide') return browserState;
      attempts += 1;
      return {
        ok: true,
        result: {
          loggedIn: attempts >= 2,
          cookieSaved: attempts >= 2,
          cookieCount: attempts >= 2 ? 8 : 0,
          verifiedAt: '2026-07-21T08:00:00.000Z',
        },
        state: browserState,
      };
    });

    const first = await readOzonBrowserLoginStatus({ tabId: 'tab-ozon-a', command });
    expect(first.result.loggedIn).toBe(false);
    const verified = await waitForOzonBrowserLogin({
      tabId: 'tab-ozon-a',
      command,
      intervalMs: 1,
      timeoutMs: 1000,
    });
    expect(verified.result).toMatchObject({ loggedIn: true, cookieSaved: true, cookieCount: 8 });
    await hideOzonBrowserLogin({ command });
    expect(command.mock.calls.at(-1)[0]).toEqual({ command: 'hide' });
  });

  it('keeps polling shop login until the current Seller company identity is readable', async () => {
    let attempts = 0;
    const command = vi.fn(async () => {
      attempts += 1;
      return {
        ok: true,
        result: {
          loggedIn: true,
          cookieSaved: true,
          companyId: attempts >= 2 ? '4616153' : '',
        },
        state: browserState,
      };
    });

    const verified = await waitForOzonBrowserLogin({
      tabId: 'tab-ozon-a',
      command,
      requireCompanyIdentity: true,
      intervalMs: 1,
      timeoutMs: 1000,
    });

    expect(attempts).toBe(2);
    expect(verified.result.companyId).toBe('4616153');
  });

  it('rejects a late successful native status response after cancellation', async () => {
    const controller = new AbortController();
    let resolveStatus;
    const command = vi.fn(() => new Promise((resolve) => { resolveStatus = resolve; }));
    const pending = waitForOzonBrowserLogin({ tabId: 'tab-ozon-a', command, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    controller.abort();
    resolveStatus({ ok: true, result: { loggedIn: true, cookieSaved: true }, state: browserState });

    await rejection;
    expect(command).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  getOzonBrowserCaptureErrorMessage,
  isOzonBrowserSessionStaleError,
  readOzonBrowserCaptureSnapshot,
  recoverOzonBrowserCollectorTab,
  selectOzonBrowserProfiles,
  selectOzonTab,
} from './ozonBrowserCaptureClient.js';

describe('ozonBrowserCaptureClient', () => {
  it('recovers both stale sessions and an unhealthy native CEF host', () => {
    expect(isOzonBrowserSessionStaleError({ code: 'PURCHASE_BROWSER_SESSION_STALE' })).toBe(true);
    expect(isOzonBrowserSessionStaleError({ code: 'PURCHASE_BROWSER_CEF_HOST_UNHEALTHY' })).toBe(true);
    expect(isOzonBrowserSessionStaleError({ code: 'PURCHASE_BROWSER_COMMAND_TIMEOUT' })).toBe(false);
  });

  it('reports observer, navigation and login failures with their real cause', () => {
    expect(getOzonBrowserCaptureErrorMessage({ code: 'OZON_DATA_OBSERVER_NOT_READY' }))
      .toContain('注入目标页面');
    expect(getOzonBrowserCaptureErrorMessage({ code: 'OZON_MARKET_ROUTE_NAVIGATION_TIMEOUT' }))
      .toContain('网络加载超时');
    expect(getOzonBrowserCaptureErrorMessage({ code: 'access-denied' }))
      .toContain('登录会话已失效');
    expect(getOzonBrowserCaptureErrorMessage({ code: 'OZON_DATA_OBSERVER_PROBE_FAILED' }))
      .toContain('商品查询网络请求失败');
  });

  it('selects only the hidden market collector and never reuses the user Ozon tab', () => {
    const state = {
      activeTabId: 'buyer-tab',
      tabs: [
        { tabId: 'other-tab', url: 'https://example.com/' },
        { tabId: 'buyer-tab', accountId: 'ozon-profile-a', browserRole: 'interactive', url: 'https://www.ozon.ru/category/7151/' },
        { tabId: 'parser-tab', accountId: 'ozon-profile-a', browserRole: 'product-link-parser', background: true, url: 'https://www.ozon.ru/product/123/' },
        { tabId: 'collector-tab', accountId: 'ozon-profile-a', browserRole: 'market-collector', background: true, url: 'https://seller.ozon.ru/app/analytics' },
      ],
    };
    expect(selectOzonTab(state)).toMatchObject({ tabId: 'collector-tab' });
    expect(selectOzonTab({ ...state, tabs: state.tabs.filter((tab) => tab.tabId !== 'collector-tab') })).toBeNull();
  });

  it('reads every normalized observer batch without replaying an Ozon request', async () => {
    const command = vi.fn(async (input) => {
      if (input.command === 'state') {
        return {
          state: {
            activeTabId: 'ozon-tab',
            tabs: [{ tabId: 'ozon-tab', accountId: 'ozon-profile-a', browserRole: 'market-collector', background: true, url: 'https://seller.ozon.ru/app/analytics', title: 'Ozon' }],
          },
        };
      }
      if (input.command === 'ozon-data-status') {
        return {
          result: {
            installed: true,
            enabled: true,
            ready: true,
            extensionVersion: '2.4.0',
            runtime: { version: '2.4.0' },
          },
        };
      }
      if (input.command === 'ozon-data-catalog') {
        return { result: { version: '2.4.0', endpointCount: 12 } };
      }
      if (input.command === 'ozon-data-normalize' && input.afterSequence === 0) {
        return {
          result: {
            datasets: [
              { sequence: 1, dataset: 'market-products', capturedAt: '2026-07-22T01:00:00.000Z' },
              { sequence: 2, dataset: 'keywords', capturedAt: '2026-07-22T02:00:00.000Z' },
            ],
          },
        };
      }
      if (input.command === 'ozon-data-normalize' && input.afterSequence === 2) {
        return {
          result: {
            datasets: [
              { sequence: 3, dataset: 'missing-items', capturedAt: '2026-07-22T03:00:00.000Z' },
            ],
          },
        };
      }
      throw new Error(`unexpected command: ${input.command}`);
    });

    const result = await readOzonBrowserCaptureSnapshot({ command, batchSize: 2 });

    expect(result).toMatchObject({
      tabId: 'ozon-tab',
      observerVersion: '2.4.0',
      capturedAt: '2026-07-22T03:00:00.000Z',
      catalog: { endpointCount: 12 },
      tab: { accountId: 'ozon-profile-a' },
    });
    expect(result.datasets).toHaveLength(3);
    expect(command.mock.calls.map(([input]) => input.command)).toEqual([
      'state',
      'ozon-data-status',
      'ozon-data-catalog',
      'ozon-data-normalize',
      'ozon-data-normalize',
    ]);
    expect(command.mock.calls.some(([input]) => [
      'ozon-data-probe',
      'ozon-data-search',
      'ozon-data-paginate',
    ].includes(input.command))).toBe(false);
  });

  it('opens the saved Ozon integration profile invisibly when no Ozon tab is open', async () => {
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return { tabs: [] };
      if (input.command === 'open') {
        return {
          state: {
            activeTabId: 'ozon-background-tab',
            tabs: [{
              tabId: 'ozon-background-tab',
              accountId: 'ozon-profile-a',
              browserRole: 'market-collector',
              background: true,
              url: 'https://seller.ozon.ru/app/dashboard/main',
              title: 'Ozon Seller',
            }],
          },
        };
      }
      if (input.command === 'ozon-data-status') return { result: { installed: true, enabled: true, ready: true, extensionVersion: '2.4.0' } };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 1 } };
      if (input.command === 'ozon-data-normalize') return { result: { datasets: [{ sequence: 1, dataset: 'keywords', records: [] }] } };
      throw new Error(`unexpected command: ${input.command}`);
    });
    const profileLoader = vi.fn().mockResolvedValue({
      profiles: [{
        id: 'ozon-profile-a',
        integrationType: 'ozon-browser-session',
        platformName: 'Ozon 网页登录',
        configStatus: '连接成功',
        tokenStatus: 'Cookie 已保存',
      }],
    });

    const result = await readOzonBrowserCaptureSnapshot({ command, profileLoader });

    expect(result.tabId).toBe('ozon-background-tab');
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'open',
      ownerType: 'integration_profile',
      accountId: 'ozon-profile-a',
      restoreVisible: false,
      browserRole: 'market-collector',
      background: true,
    }));
    expect(profileLoader).toHaveBeenCalledWith({ timeoutMs: 5000 });
  });

  it('retries the observer status while the hidden renderer is still creating its V8 context', async () => {
    let statusAttempts = 0;
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return {
        tabs: [{
          tabId: 'collector-tab',
          accountId: 'ozon-a',
          browserRole: 'market-collector',
          background: true,
          url: 'https://seller.ozon.ru/app/dashboard/main',
        }],
      };
      if (input.command === 'ozon-data-status') {
        statusAttempts += 1;
        if (statusAttempts === 1) throw new Error('PURCHASE_BROWSER_CEF_FAILED');
        return { result: { installed: true, enabled: true, ready: true, extensionVersion: '2.4.1' } };
      }
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 0 } };
      if (input.command === 'ozon-data-normalize') return { result: { datasets: [] } };
      throw new Error(`unexpected command: ${input.command}`);
    });
    const result = await readOzonBrowserCaptureSnapshot({ command, autoOpen: false });
    expect(result.tabId).toBe('collector-tab');
    expect(statusAttempts).toBe(2);
  });

  it('selects a requested connected profile and its own collector session', () => {
    const payload = { profiles: [
      { id: 'ozon-a', integrationType: 'ozon-browser-session', configStatus: '连接成功', tokenStatus: 'Cookie 已保存' },
      { id: 'ozon-b', integrationType: 'ozon-browser-session', configStatus: '连接成功', tokenStatus: 'Cookie 已保存' },
      { id: 'ozon-pending', integrationType: 'ozon-browser-session', configStatus: '待登录', tokenStatus: 'Cookie 未保存' },
    ] };
    expect(selectOzonBrowserProfiles(payload).map((profile) => profile.id)).toEqual(['ozon-a', 'ozon-b']);
    expect(selectOzonTab({ tabs: [
      { tabId: 'collector-a', accountId: 'ozon-a', browserRole: 'market-collector', url: 'https://seller.ozon.ru/app/analytics' },
      { tabId: 'collector-b', accountId: 'ozon-b', browserRole: 'market-collector', url: 'https://seller.ozon.ru/app/analytics' },
    ] }, { profileId: 'ozon-b' })).toMatchObject({ tabId: 'collector-b' });
  });

  it('force-closes a stale collector and opens a fresh hidden session', async () => {
    let staleClosed = false;
    const command = vi.fn(async (input) => {
      if (input.command === 'state') return {
        tabs: staleClosed ? [] : [{
          tabId: 'stale-tab',
          accountId: 'ozon-a',
          browserRole: 'market-collector',
          background: true,
          url: 'https://seller.ozon.ru/app/dashboard/main',
        }],
      };
      if (input.command === 'force-close') {
        staleClosed = true;
        return { tabs: [] };
      }
      if (input.command === 'open') return {
        state: {
          tabs: [{
            tabId: 'fresh-tab',
            accountId: 'ozon-a',
            browserRole: 'market-collector',
            background: true,
            url: 'https://seller.ozon.ru/app/dashboard/main',
          }],
        },
      };
      throw new Error(`unexpected command: ${input.command}`);
    });
    const profileLoader = vi.fn().mockResolvedValue({
      profiles: [{
        id: 'ozon-a',
        integrationType: 'ozon-browser-session',
        platformName: 'Ozon 网页登录',
        configStatus: '连接成功',
        tokenStatus: 'Cookie 已保存',
      }],
    });

    const recovered = await recoverOzonBrowserCollectorTab({
      command,
      profileLoader,
      profileId: 'ozon-a',
    });

    expect(recovered.tab).toMatchObject({ tabId: 'fresh-tab', accountId: 'ozon-a' });
    expect(command).toHaveBeenCalledWith({ command: 'force-close', tabId: 'stale-tab' });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'open',
      accountId: 'ozon-a',
      browserRole: 'market-collector',
      background: true,
    }));
  });
});

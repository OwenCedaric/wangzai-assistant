import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getOzonBrowserCaptureErrorMessage,
  readOzonBrowserCaptureSnapshot,
  waitForOzonBrowserObserverStatus,
} from './ozonBrowserCaptureClient.js';

const profileLoader = async () => ({ profiles: [{ id: 'fixture-profile', integrationType: 'ozon-browser-session',
  configStatus: '连接成功', tokenStatus: 'Cookie 已保存' }] });
afterEach(() => vi.useRealTimers());

describe('Ozon collector errors keep their real cause without slow permanent-error polling', () => {
  it.each(['SHOP_LICENSE_CLIENT_ID_REQUIRED', 'SHOP_LICENSE_REQUIRED', 'PURCHASE_BROWSER_COMMAND_CANCELLED', 'PURCHASE_BROWSER_CEF_READY_TIMEOUT'])(
    'background open preserves %s and never starts reading or opening again', async code => {
      const error = Object.assign(new Error(code), { code, retryable: false });
      const command = vi.fn(async input => {
        if (input.command === 'state') return { tabs: [] };
        if (input.command === 'open') throw error;
        throw new Error('fixture must not execute data operations');
      });
      await expect(readOzonBrowserCaptureSnapshot({ command, profileLoader })).rejects.toBe(error);
      expect(command.mock.calls.map(([input]) => input.command)).toEqual(['state', 'open']);
    });

  it('a profile-list failure is not converted to a nonexistent-browser error', async () => {
    const error = Object.assign(new Error('synthetic service unavailable'), { code: 'FIXTURE_PROFILE_UNAVAILABLE' });
    const command = vi.fn(async () => ({ tabs: [] }));
    await expect(readOzonBrowserCaptureSnapshot({ command, profileLoader: async () => { throw error; } })).rejects.toBe(error);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it.each(['SHOP_LICENSE_CLIENT_ID_REQUIRED', 'SHOP_LICENSE_REQUIRED', 'PURCHASE_BROWSER_COMMAND_CANCELLED'])(
    'status polling surfaces permanent %s immediately without a retry timer', async code => {
      vi.useFakeTimers();
      const error = Object.assign(new Error(code), { code });
      const command = vi.fn().mockRejectedValue(error);
      const checking = waitForOzonBrowserObserverStatus(command, 'fixture-tab', 15000);
      const rejection = expect(checking).rejects.toBe(error);
      await vi.runAllTimersAsync();
      await rejection;
      expect(command).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

  it('an empty successful profile list still reports no available browser without fabricating an open', async () => {
    const command = vi.fn(async () => ({ tabs: [] }));
    await expect(readOzonBrowserCaptureSnapshot({ command, profileLoader: async () => ({ profiles: [] }) }))
      .rejects.toMatchObject({ code: 'PURCHASE_BROWSER_TAB_NOT_FOUND' });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('explains Client ID binding and entitlement failures without blaming a missing page', () => {
    expect(getOzonBrowserCaptureErrorMessage({ code: 'SHOP_LICENSE_CLIENT_ID_REQUIRED' })).toContain('Client ID');
    expect(getOzonBrowserCaptureErrorMessage({ code: 'SHOP_LICENSE_REQUIRED' })).toContain('授权');
    expect(getOzonBrowserCaptureErrorMessage({ code: 'SHOP_LICENSE_BROWSER_GATE_UNAVAILABLE' })).toContain('校验服务');
  });

  it('rejects an old running version before reading instead of treating installed files as active', async () => {
    const command = vi.fn(async input => {
      if (input.command === 'state') return { tabs: [{ tabId: 'fixture-tab', accountId: 'fixture-profile',
        browserRole: 'market-collector', url: 'https://seller.ozon.ru/app/analytics' }] };
      if (input.command === 'ozon-data-status') return { result: { installed: true, enabled: true, ready: true,
        extensionVersion: '2.6.15', runtime: { version: '2.6.14' } } };
      if (input.command === 'ozon-data-catalog') return { result: { endpointCount: 0 } };
      if (input.command === 'ozon-data-normalize') return { result: { datasets: [] } };
      throw new Error('unexpected command');
    });
    await expect(readOzonBrowserCaptureSnapshot({ command })).rejects.toMatchObject({
      code: 'OZON_DATA_OBSERVER_RESTART_REQUIRED', runtimeVersion: '2.6.14', expectedVersion: '2.6.15', retryable: false,
    });
    expect(command.mock.calls.map(([input]) => input.command)).toEqual(['state', 'ozon-data-status']);
    expect(getOzonBrowserCaptureErrorMessage({ code: 'OZON_DATA_OBSERVER_RESTART_REQUIRED' })).toContain('完全退出');
  });

  it('native restartRequired is terminal even when ready is false', async () => {
    const command = vi.fn(async () => ({ installed: true, enabled: true, ready: false, restartRequired: true }));
    await expect(waitForOzonBrowserObserverStatus(command, 'fixture-tab', 15000)).rejects.toMatchObject({ code: 'OZON_DATA_OBSERVER_RESTART_REQUIRED' });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('does not turn rejected child-company evidence into a successful empty capture', async () => {
    const command = vi.fn(async () => ({ installed: true, enabled: true, ready: true, runtime: { frameCapture: { scopeFailures: 1 } } }));
    await expect(waitForOzonBrowserObserverStatus(command, 'fixture-tab')).rejects.toMatchObject({ code: 'OZON_DATA_FRAME_SCOPE_UNVERIFIED' });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit compatibility failure instead of advising an ineffective restart', async () => {
    const code = 'PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED';
    const command = vi.fn(async () => ({ installed: true, enabled: true, ready: false, compatibilityCode: code }));
    await expect(waitForOzonBrowserObserverStatus(command, 'fixture-tab')).rejects.toMatchObject({ code, retryable: false });
    expect(command).toHaveBeenCalledTimes(1);
  });
});

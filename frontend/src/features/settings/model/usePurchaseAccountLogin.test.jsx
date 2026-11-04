import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePurchaseAccountLogin } from './usePurchaseAccountLogin.js';

const windowObject = globalThis.window;
let previousBridge;
let eventListener;

const baseState = {
  ok: true,
  engine: 'cef',
  activeTabId: 'tab-a',
  visible: true,
  tabs: [{
    tabId: 'tab-a',
    accountId: 'purchase-a',
    engine: 'cef',
    title: '1688 登录',
    url: 'https://www.1688.com/',
    loading: false,
    crashed: false,
    extension: { installState: 'active', extensionVersion: '1.0.0' },
  }],
};

beforeEach(() => {
  previousBridge = windowObject.wangzaiDesktop;
  eventListener = null;
});

afterEach(() => {
  if (previousBridge === undefined) delete windowObject.wangzaiDesktop;
  else windowObject.wangzaiDesktop = previousBridge;
  vi.clearAllMocks();
});

function installBridge() {
  const command = vi.fn(async (input) => {
    if (input.command === 'inspect') {
      return {
        ok: true,
        inspection: { pageTitle: '1688 登录页', platform: '1688', extensionVersion: '1.0.0' },
        state: baseState,
      };
    }
    if (input.command === 'hide') return { ...baseState, visible: false };
    return baseState;
  });
  const onEvent = vi.fn((listener) => {
    eventListener = listener;
    return () => {
      if (eventListener === listener) eventListener = null;
    };
  });
  windowObject.wangzaiDesktop = { purchaseBrowser: { command, onEvent } };
  return { command, onEvent };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('usePurchaseAccountLogin standalone lifecycle', () => {
  it('does not open a browser merely because saved accounts are selected', async () => {
    const bridge = installBridge();
    const { rerender } = renderHook(({ accountId, platformName }) => usePurchaseAccountLogin({
      enabled: true,
      accountId,
      platformName,
    }), { initialProps: { accountId: 'purchase-a', platformName: '1688' } });

    await act(async () => {
      for (let index = 0; index < 100; index += 1) {
        rerender(index % 2
          ? { accountId: 'purchase-a', platformName: '1688' }
          : { accountId: 'purchase-b', platformName: '淘宝' });
      }
    });

    expect(bridge.command).not.toHaveBeenCalled();
  });

  it('opens one standalone native window without publishing embedded bounds', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => usePurchaseAccountLogin({
      enabled: true,
      accountId: 'purchase-a',
      accountLabel: '1688采购号',
      platformName: '1688',
    }));

    await act(async () => {
      await Promise.all([result.current.openLogin(), result.current.openLogin(), result.current.openLogin()]);
      await result.current.openLogin();
    });

    expect(bridge.command.mock.calls.filter(([input]) => input.command === 'open')).toEqual([[
      {
        command: 'open',
        accountId: 'purchase-a',
        accountLabel: '1688采购号',
        platformName: '1688',
        url: 'https://www.1688.com/',
      },
    ]]);
    expect(bridge.command.mock.calls.some(([input]) => input.command === 'embed-bounds')).toBe(false);
    expect(result.current.panelOpen).toBe(true);
    expect(result.current.status).toBe('ready');
  });

  it('keeps the independent login window alive when the settings component unmounts', async () => {
    const bridge = installBridge();
    const hook = renderHook(() => usePurchaseAccountLogin({
      enabled: true,
      accountId: 'purchase-a',
      platformName: '1688',
    }));
    await act(async () => { await hook.result.current.openLogin(); });

    hook.unmount();

    expect(bridge.command.mock.calls.some(([input]) => ['hide', 'embed-hide', 'close'].includes(input.command))).toBe(false);
  });

  it('follows standalone events, supports inspect/reload/hide and can reopen after native X', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => usePurchaseAccountLogin({
      enabled: true,
      accountId: 'purchase-a',
      platformName: '1688',
    }));
    await act(async () => { await result.current.openLogin(); });

    act(() => {
      eventListener?.({
        event: 'navigation',
        state: { ...baseState, tabs: [{ ...baseState.tabs[0], loading: true }] },
      });
    });
    expect(result.current.status).toBe('loading');
    await act(async () => {
      await result.current.reload();
      await result.current.inspect();
    });
    expect(result.current.inspection).toMatchObject({ pageTitle: '1688 登录页' });

    act(() => {
      eventListener?.({ event: 'window-hidden', state: { ...baseState, visible: false } });
    });
    expect(result.current.panelOpen).toBe(false);
    expect(result.current.status).toBe('hidden');
    await act(async () => { await result.current.openLogin(); });
    expect(bridge.command.mock.calls.filter(([input]) => input.command === 'open')).toHaveLength(2);

    await act(async () => { await result.current.hideLogin(); });
    expect(bridge.command).toHaveBeenCalledWith({ command: 'hide' });
  });

  it('accepts the exact main-process save event and reports the persisted Cookie status', () => {
    installBridge();
    const onLoginSaved = vi.fn();
    const { result } = renderHook(() => usePurchaseAccountLogin({
      enabled: true,
      accountId: 'purchase-a',
      platformName: '1688',
      onLoginSaved,
    }));

    act(() => {
      eventListener?.({
        event: 'purchase-login-saved',
        accountId: 'purchase-other',
        account: { id: 'purchase-other', cookieStatus: 'Cookie 已保存' },
      });
      eventListener?.({
        event: 'purchase-login-saved',
        accountId: 'purchase-a',
        account: {
          id: 'purchase-a',
          cookieStatus: 'Cookie 已保存',
          lastLoginVerifiedAt: '2026-08-11T08:30:00.000Z',
        },
        verification: { loggedIn: true, cookieSaved: true },
        state: { ...baseState, visible: false },
      });
    });

    expect(onLoginSaved).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('saved');
    expect(result.current.statusLabel).toBe('Cookie 已保存');
    expect(result.current.panelOpen).toBe(false);
  });

  it('does not open a browser for a draft account or unsupported platform', async () => {
    const bridge = installBridge();
    const draft = renderHook(() => usePurchaseAccountLogin({
      enabled: false,
      accountId: 'draft-account',
      platformName: '1688',
    }));
    await act(async () => { await draft.result.current.openLogin(); });
    expect(draft.result.current.errorMessage).toBe('请先保存当前拍单账号。');

    const unsupported = renderHook(() => usePurchaseAccountLogin({
      enabled: true,
      accountId: 'saved-account',
      platformName: '未知平台',
    }));
    await act(async () => { await unsupported.result.current.openLogin(); });
    expect(unsupported.result.current.errorMessage).toBe('当前采购平台暂不支持内置登录。');
    expect(bridge.command).not.toHaveBeenCalled();
  });

  it('fences a crashed tab and reopens the saved account instead of restoring it', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => usePurchaseAccountLogin({
      enabled: true,
      accountId: 'purchase-a',
      platformName: '1688',
    }));
    await act(async () => {
      await result.current.openLogin();
      await result.current.recoverBrowser();
    });
    const commands = bridge.command.mock.calls.map(([input]) => input.command);
    expect(commands).toContain('force-close');
    expect(commands.filter((command) => command === 'open')).toHaveLength(2);
    expect(commands).not.toContain('restore-window');
  });

  it.each([
    ['inspect', 'inspect'],
    ['reload', 'reload'],
    ['restoreLogin', 'restore-window'],
    ['hideLogin', 'hide'],
    ['closeLogin', 'close'],
    ['syncCrossBorder', 'cross-border-sync'],
  ])('ignores an old account %s response after another account opens', async (action, nativeCommand) => {
    const bridge = installBridge();
    const pending = deferred();
    const nextState = {
      ...baseState,
      activeTabId: 'tab-b',
      tabs: [{ ...baseState.tabs[0], accountId: 'purchase-b', tabId: 'tab-b' }],
    };
    bridge.command.mockImplementation(async (input) => {
      if (input.command === nativeCommand) return pending.promise;
      return input.accountId === 'purchase-b' ? nextState : baseState;
    });
    const hook = renderHook(({ accountId }) => usePurchaseAccountLogin({
      enabled: true,
      accountId,
      platformName: '1688',
    }), { initialProps: { accountId: 'purchase-a' } });
    await act(async () => { await hook.result.current.openLogin(); });
    let oldRequest;
    act(() => { oldRequest = hook.result.current[action](); });
    hook.rerender({ accountId: 'purchase-b' });
    await act(async () => { await hook.result.current.openLogin(); });

    await act(async () => {
      pending.resolve(nativeCommand === 'inspect'
        ? { ok: true, state: baseState, inspection: { pageTitle: 'Old account page' } }
        : nativeCommand === 'cross-border-sync'
          ? { ok: true, state: baseState, result: { oldAccount: true } }
          : baseState);
      await oldRequest;
    });

    expect(hook.result.current.snapshot.activeTabId).toBe('tab-b');
    expect(hook.result.current.tab?.accountId).toBe('purchase-b');
    expect(hook.result.current.status).toBe('ready');
    expect(hook.result.current.inspection).toBeNull();
    expect(hook.result.current.crossBorderResult).toBeNull();
  });

  it.each([
    ['inspect', 'inspect'],
    ['reload', 'reload'],
    ['restoreLogin', 'restore-window'],
    ['closeLogin', 'close'],
    ['syncCrossBorder', 'cross-border-sync'],
  ])('ignores an old account %s failure after another account opens', async (action, nativeCommand) => {
    const bridge = installBridge();
    const pending = deferred();
    const nextState = {
      ...baseState,
      activeTabId: 'tab-b',
      tabs: [{ ...baseState.tabs[0], accountId: 'purchase-b', tabId: 'tab-b' }],
    };
    bridge.command.mockImplementation(async (input) => {
      if (input.command === nativeCommand) return pending.promise;
      return input.accountId === 'purchase-b' ? nextState : baseState;
    });
    const hook = renderHook(({ accountId }) => usePurchaseAccountLogin({
      enabled: true,
      accountId,
      platformName: '1688',
    }), { initialProps: { accountId: 'purchase-a' } });
    await act(async () => { await hook.result.current.openLogin(); });
    let oldRequest;
    act(() => { oldRequest = hook.result.current[action](); });
    hook.rerender({ accountId: 'purchase-b' });
    await act(async () => { await hook.result.current.openLogin(); });
    await act(async () => {
      pending.reject(Object.assign(new Error('old tab exited'), { code: 'PURCHASE_BROWSER_CEF_PROCESS_EXITED' }));
      await oldRequest;
    });

    expect(hook.result.current.status).toBe('ready');
    expect(hook.result.current.errorMessage).toBe('');
    expect(hook.result.current.snapshot.activeTabId).toBe('tab-b');
  });

  it('does not resurrect a native-hidden window when an inspection resolves late', async () => {
    const bridge = installBridge();
    const pending = deferred();
    bridge.command.mockImplementation(async (input) => input.command === 'inspect' ? pending.promise : baseState);
    const hook = renderHook(() => usePurchaseAccountLogin({ enabled: true, accountId: 'purchase-a', platformName: '1688' }));
    await act(async () => { await hook.result.current.openLogin(); });
    let oldInspection;
    act(() => { oldInspection = hook.result.current.inspect(); });
    act(() => { eventListener({ event: 'window-hidden', state: { ...baseState, visible: false } }); });
    await act(async () => {
      pending.resolve({ ok: true, inspection: { pageTitle: 'Old visible tab' }, state: baseState });
      await oldInspection;
    });

    expect(hook.result.current.status).toBe('hidden');
    expect(hook.result.current.snapshot.visible).toBe(false);
    expect(hook.result.current.inspection).toBeNull();
  });

  it('does not reopen an old account after its delayed recovery fence completes', async () => {
    const bridge = installBridge();
    const pending = deferred();
    bridge.command.mockImplementation(async (input) => input.command === 'force-close' ? pending.promise : baseState);
    const hook = renderHook(({ accountId }) => usePurchaseAccountLogin({ enabled: true, accountId, platformName: '1688' }), {
      initialProps: { accountId: 'purchase-a' },
    });
    await act(async () => { await hook.result.current.openLogin(); });
    let recovery;
    act(() => { recovery = hook.result.current.recoverBrowser(); });
    hook.rerender({ accountId: 'purchase-b' });
    await act(async () => { pending.resolve(baseState); await recovery; });

    expect(bridge.command.mock.calls.filter(([input]) => input.command === 'open')).toHaveLength(1);
    expect(hook.result.current.status).toBe('idle');
    expect(hook.result.current.snapshot.tabs).toHaveLength(0);
  });

  it('keeps StrictMode subscription cleanup balanced and ignores a queued callback after unmount', async () => {
    const bridge = installBridge();
    const onLoginSaved = vi.fn();
    const hook = renderHook(({ accountId }) => usePurchaseAccountLogin({
      enabled: true,
      accountId,
      platformName: '1688',
      onLoginSaved,
    }), {
      initialProps: { accountId: 'purchase-a' },
      wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    await act(async () => { await hook.result.current.openLogin(); });
    const retiredListener = bridge.onEvent.mock.calls[0][0];
    hook.rerender({ accountId: 'purchase-b' });
    hook.rerender({ accountId: 'purchase-a' });
    act(() => { retiredListener({ event: 'purchase-login-saved', accountId: 'purchase-a', account: { id: 'purchase-a' } }); });
    expect(onLoginSaved).not.toHaveBeenCalled();
    const queuedListener = eventListener;
    hook.unmount();
    queuedListener({ event: 'purchase-login-saved', accountId: 'purchase-a', account: { id: 'purchase-a' } });

    expect(eventListener).toBeNull();
    expect(onLoginSaved).not.toHaveBeenCalled();
    expect(bridge.command.mock.calls.filter(([input]) => input.command === 'open')).toHaveLength(1);
  });
});

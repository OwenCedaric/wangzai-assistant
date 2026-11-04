import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPurchaseBrowserAccountTab,
  getPurchaseBrowserErrorMessage,
  closePurchaseBrowser,
  capturePurchaseBrowserPreview,
  confirmPurchaseBrowserCaptureOnTab,
  hidePurchaseBrowser,
  hidePurchaseBrowserViewport,
  inspectPurchaseBrowser,
  normalizePurchaseBrowserState,
  openCrossBorderBrowserLogin,
  openPurchaseBrowserLogin,
  prewarmPurchaseBrowserLogin,
  recoverPurchaseBrowser,
  recoverPurchaseBrowserTarget,
  readPurchaseBrowserState,
  reloadPurchaseBrowser,
  restorePurchaseBrowser,
  resolvePurchaseBrowserLoginTarget,
  showPurchaseBrowserBounds,
  subscribePurchaseBrowserEvents,
  syncCrossBorderBrowser,
  getPurchaseBrowserErrorMessage,
} from './purchaseBrowserLoginClient.js';

const browserStorage = globalThis.window;
const previousBridge = browserStorage.wangzaiDesktop;

afterEach(() => {
  if (previousBridge === undefined) delete browserStorage.wangzaiDesktop;
  else browserStorage.wangzaiDesktop = previousBridge;
  vi.clearAllMocks();
});

function installBridge(command = vi.fn()) {
  const onEvent = vi.fn(() => vi.fn());
  browserStorage.wangzaiDesktop = { purchaseBrowser: { command, onEvent } };
  return { command, onEvent };
}

const state = {
  ok: true,
  engine: 'cef',
  activeTabId: 'tab-purchase-a',
  visible: true,
  tabs: [
    {
      tabId: 'tab-purchase-a',
      accountId: 'purchase-a',
      engine: 'cef',
      title: '1688 登录',
      url: 'https://www.1688.com/',
      loading: false,
      crashed: false,
      canGoBack: false,
      canGoForward: false,
      extension: { installState: 'active', extensionVersion: '1.0.0' },
    },
  ],
};

describe('purchaseBrowserLoginClient', () => {
  it('distinguishes connection failure, body overflow and cancellation from login expiry', () => {
    expect(getPurchaseBrowserErrorMessage({ code: 'CROSS_BORDER_NETWORK_FAILED' })).toContain('网络连接失败');
    expect(getPurchaseBrowserErrorMessage({ code: 'CROSS_BORDER_RESPONSE_TOO_LARGE' })).toContain('8MiB');
    expect(getPurchaseBrowserErrorMessage({ code: 'CROSS_BORDER_OPERATION_CANCELLED' })).toContain('不会自动重复提交');
    expect(getPurchaseBrowserErrorMessage({ code: 'CROSS_BORDER_API_FAILED' })).toContain('不表示账号已退出');
  });
  it('explains invalid charge money without claiming that zero fees were saved', async () => {
    const error = Object.assign(new Error('CROSS_BORDER_CHARGE_AMOUNT_INVALID'), { code: 'CROSS_BORDER_CHARGE_AMOUNT_INVALID' });
    installBridge(vi.fn().mockRejectedValue(error));
    await expect(syncCrossBorderBrowser({ tabId: 'tab-purchase-a' })).rejects.toBe(error);
    expect(getPurchaseBrowserErrorMessage(error)).toBe('消费流水有金额缺失或格式错误，本次未保存，不会把未知金额当成零费用。');
  });
  it('resolves login URLs only from the controlled purchase account presets', () => {
    expect(resolvePurchaseBrowserLoginTarget('1688')).toEqual({
      platformCode: '1688',
      platformName: '1688',
      accountAlias: '1688采购号',
      url: 'https://www.1688.com/',
    });
    expect(resolvePurchaseBrowserLoginTarget('https://attacker.example/')).toBeNull();
    expect(resolvePurchaseBrowserLoginTarget('Ozon买家')).toEqual({
      platformCode: 'ozon-buyer',
      platformName: 'Ozon买家',
      accountAlias: 'Ozon买家采购号',
      url: 'https://www.ozon.ru/',
    });
    expect(
      normalizePurchaseBrowserState({
        tabs: [{ url: 'https://www.1688.com/login?token=secret#callback' }],
      }).tabs[0].url
    ).toBe('https://www.1688.com/login');
  });

  it('dispatches standalone login open separately from explicit embedded workbench bounds', async () => {
    const command = vi.fn(async (input) => {
      if (input.command === 'inspect') {
        return {
          ok: true,
          inspection: { pageTitle: '1688 登录页', platform: '1688', extensionVersion: '1.0.0' },
          state,
        };
      }
      return state;
    });
    installBridge(command);

    expect(await prewarmPurchaseBrowserLogin({ accountId: 'purchase-a', platformName: '1688' })).toEqual(
      normalizePurchaseBrowserState(state)
    );
    expect(await openPurchaseBrowserLogin({
      accountId: 'purchase-a',
      accountLabel: '主账号',
      platformName: '1688',
      bounds: { x: 12, y: 24, width: 800, height: 500 },
    })).toEqual(
      normalizePurchaseBrowserState(state)
    );
    expect(await showPurchaseBrowserBounds({ x: 12, y: 24, width: 800, height: 500 })).toEqual(
      normalizePurchaseBrowserState(state)
    );
    expect(await reloadPurchaseBrowser('tab-purchase-a')).toEqual(normalizePurchaseBrowserState(state));
    expect(await inspectPurchaseBrowser('tab-purchase-a')).toMatchObject({
      ok: true,
      inspection: { pageTitle: '1688 登录页', platform: '1688' },
    });
    expect(await hidePurchaseBrowser()).toEqual(normalizePurchaseBrowserState(state));
    expect(await hidePurchaseBrowserViewport()).toEqual(normalizePurchaseBrowserState(state));
    expect(await readPurchaseBrowserState()).toEqual(normalizePurchaseBrowserState(state));
    expect(command.mock.calls.map(([input]) => input)).toEqual([
      { command: 'prewarm', accountId: 'purchase-a', url: 'https://www.1688.com/' },
      {
        command: 'open',
        accountId: 'purchase-a',
        accountLabel: '主账号',
        platformName: '1688',
        url: 'https://www.1688.com/',
      },
      { command: 'embed-bounds', bounds: { x: 12, y: 24, width: 800, height: 500, visible: true } },
      { command: 'reload', tabId: 'tab-purchase-a' },
      { command: 'inspect', tabId: 'tab-purchase-a' },
      { command: 'hide' },
      { command: 'embed-hide' },
      { command: 'state' },
    ]);
    expect(getPurchaseBrowserAccountTab(state, 'purchase-a')?.tabId).toBe('tab-purchase-a');
  });

  it('opens the bus login in the same account profile and dispatches a platform-scoped sync', async () => {
    const command = vi.fn(async (input) => {
      if (input.command === 'cross-border-sync') {
        return { ok: true, result: { total: 2, synced: 2, commit: true }, state };
      }
      return state;
    });
    installBridge(command);

    expect(await openCrossBorderBrowserLogin({
      accountId: 'purchase-a',
      platformName: '1688',
      bounds: { x: 12, y: 24, width: 800, height: 500 },
    })).toEqual(
      normalizePurchaseBrowserState(state)
    );
    expect(await syncCrossBorderBrowser({
      tabId: 'tab-purchase-a',
      orderIds: ['order-a', 'order-b'],
      commit: true,
    })).toMatchObject({ result: { total: 2, synced: 2, commit: true } });
    expect(command.mock.calls.map(([input]) => input)).toEqual([
      {
        command: 'open',
        accountId: 'purchase-a',
        url: 'https://www.1688.com/',
      },
      {
        command: 'open',
        accountId: 'purchase-a',
        url: 'https://www.kuajing84.com/',
      },
      {
        command: 'cross-border-sync',
        tabId: 'tab-purchase-a',
        payload: { orderIds: ['order-a', 'order-b'], commit: true },
      },
    ]);
  });

  it('fails closed before calling the desktop bridge for an unsaved or unsupported account', async () => {
    const bridge = installBridge();
    await expect(openPurchaseBrowserLogin({ accountId: '', platformName: '1688' })).rejects.toMatchObject({
      code: 'PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED',
    });
    await expect(openPurchaseBrowserLogin({ accountId: 'purchase-a', platformName: '未知平台' })).rejects.toMatchObject(
      {
        code: 'PURCHASE_BROWSER_PLATFORM_UNSUPPORTED',
      }
    );
    expect(bridge.command).not.toHaveBeenCalled();
  });

  it('restores the existing native purchase window without reopening or relogging the account', async () => {
    const bridge = installBridge(vi.fn(async () => state));
    expect(await restorePurchaseBrowser()).toEqual(normalizePurchaseBrowserState(state));
    expect(bridge.command).toHaveBeenCalledWith({ command: 'restore-window' });
  });

  it('fences a dead tab without asking the host to restore the removed tab', async () => {
    const bridge = installBridge(vi.fn(async () => ({ ...state, tabs: [] })));
    expect(await recoverPurchaseBrowser('tab-purchase-a')).toEqual(
      normalizePurchaseBrowserState({ ...state, tabs: [] }),
    );
    expect(bridge.command).toHaveBeenCalledWith({ command: 'force-close', tabId: 'tab-purchase-a' });
  });

  it('normalizes target phases and fences target recovery to the new session generation', async () => {
    const target = { targetId: 'target-a', shopId: 'shop-a', orderKey: 'order-a' };
    const recoveredState = {
      ...state,
      tabs: [{ ...state.tabs[0], target, targetPhase: 'target-locked', sessionId: 'session-new', generation: 2 }],
      sessionId: 'session-new',
      generation: 2,
    };
    const command = vi.fn(async (input) => {
      if (input.command === 'target-recovery') return {
        ok: true,
        target,
        targetPhase: 'target-locked',
        state: recoveredState,
      };
      if (input.command === 'capture-preview') return {
        ok: true,
        capture: { platform: '1688', purchaseOrderNumber: 'po-a', purchasePrice: 12.5 },
        target,
        preview: { previewId: 'preview-a', confirmationToken: 'token-a', missingFields: [] },
        targetPhase: 'capture-preview',
        state: { ...recoveredState, tabs: [{ ...recoveredState.tabs[0], targetPhase: 'capture-preview', captureReady: true }] },
      };
      if (input.command === 'capture-confirm') return {
        ok: true,
        result: { readbackVerified: true },
        targetPhase: 'completed',
        state: recoveredState,
      };
      return state;
    });
    installBridge(command);

    await expect(recoverPurchaseBrowserTarget({
      tabId: 'tab-purchase-a',
      target,
      sessionId: 'session-new',
      generation: 2,
    })).resolves.toMatchObject({ target, targetPhase: 'target-locked' });
    await expect(capturePurchaseBrowserPreview('tab-purchase-a')).resolves.toMatchObject({
      preview: { previewId: 'preview-a' },
      targetPhase: 'capture-preview',
    });
    await expect(confirmPurchaseBrowserCaptureOnTab({
      tabId: 'tab-purchase-a',
      confirmationToken: 'token-a',
    })).resolves.toMatchObject({ readbackVerified: true, targetPhase: 'completed' });
    expect(command.mock.calls.map(([input]) => input.command)).toEqual([
      'target-recovery',
      'capture-preview',
      'capture-confirm',
    ]);
  });

  it('stops waiting for a late native capture response when the caller aborts', async () => {
    const controller = new AbortController();
    let resolveNative;
    const command = vi.fn((input) => {
      if (input.command === 'capture-preview') {
        return new Promise((resolve) => {
          resolveNative = resolve;
        });
      }
      return state;
    });
    installBridge(command);

    const request = capturePurchaseBrowserPreview('tab-purchase-a', { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });

    // A native response may still arrive after the renderer has unmounted;
    // it must be consumed without changing the already-aborted request.
    resolveNative?.({ ok: true, preview: { previewId: 'late-preview' }, state });
    await Promise.resolve();
  });

  it('sends window close through the desktop bridge without discarding the live tab', async () => {
    const bridge = installBridge(vi.fn(async () => ({ ...state, visible: false })));
    const closed = await closePurchaseBrowser('tab-purchase-a');
    expect(closed.windowVisible).toBe(false);
    expect(closed.tabs).toHaveLength(1);
    expect(closed.tabs[0].tabId).toBe('tab-purchase-a');
    expect(bridge.command).toHaveBeenCalledWith({ command: 'close', tabId: 'tab-purchase-a' });
  });

  it('subscribes and translates bridge errors without exposing raw technical text', () => {
    const listener = vi.fn();
    const bridge = installBridge();
    const unsubscribe = vi.fn();
    bridge.onEvent.mockReturnValue(unsubscribe);
    expect(subscribePurchaseBrowserEvents(listener)).toBe(unsubscribe);
    expect(bridge.onEvent).toHaveBeenCalledWith(listener);
    expect(getPurchaseBrowserErrorMessage({ code: 'PURCHASE_BROWSER_CEF_LAUNCH_FAILED' })).toBe(
      '内置浏览器没有成功启动，请重试。'
    );
    expect(getPurchaseBrowserErrorMessage({ code: 'PURCHASE_BROWSER_CEF_TIMEOUT' })).toBe(
      '内置浏览器启动超时，请确认网络后重试。'
    );
    expect(getPurchaseBrowserErrorMessage(new Error('unexpected'))).toContain('内置浏览器操作失败');
  });
});


import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePurchaseBrowserTargetMode } from './usePurchaseBrowserTargetMode.js';

const previousBridge = globalThis.window.wangzaiDesktop;

afterEach(() => {
  if (previousBridge === undefined) delete globalThis.window.wangzaiDesktop;
  else globalThis.window.wangzaiDesktop = previousBridge;
  vi.clearAllMocks();
});

function installBridge() {
  const target = { targetId: 'target-a', shopId: 'shop-a', orderKey: 'order-a' };
  const state = {
    ok: true,
    engine: 'cef',
    activeTabId: 'tab-a',
    tabs: [
      {
        tabId: 'tab-a',
        accountId: 'account-a',
        target,
        targetPhase: 'target-locked',
        sessionId: 'session-a',
        generation: 1,
      },
    ],
  };
  const command = vi.fn(async (input) => {
    if (input.command === 'set-target') return { ok: true, target, targetPhase: 'target-locked', state };
    if (input.command === 'capture-preview')
      return {
        ok: true,
        capture: {
          platform: '1688',
          purchaseOrderNumber: 'PO-A',
          purchasePrice: 19.9,
          sourceUrl: 'https://detail.1688.com/offer/1.html',
        },
        target,
        preview: {
          previewId: 'preview-a',
          confirmationToken: 'token-a',
          missingFields: [],
          conflicts: [],
          target,
        },
        targetPhase: 'capture-preview',
        state: { ...state, tabs: [{ ...state.tabs[0], targetPhase: 'capture-preview', captureReady: true }] },
      };
    if (input.command === 'capture-confirm') {
      const error = new Error('PURCHASE_BROWSER_READBACK_FAILED');
      error.code = 'PURCHASE_BROWSER_READBACK_FAILED';
      throw error;
    }
    return state;
  });
  globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
  return { command, target };
}

describe('usePurchaseBrowserTargetMode', () => {
  it('keeps the reviewed capture preview when confirmation/readback fails', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() =>
      usePurchaseBrowserTargetMode({
        tabId: 'tab-a',
        target: bridge.target,
        targetPhase: 'target-locked',
      })
    );

    await act(async () => {
      await result.current.capture();
    });
    expect(bridge.command.mock.calls.map(([input]) => input.command)).not.toContain('set-target');
    expect(result.current.targetPhase).toBe('capture-preview');
    expect(result.current.capturePreview?.previewId).toBe('preview-a');

    await act(async () => {
      await result.current.confirmCapture();
    });
    expect(result.current.targetPhase).toBe('error');
    expect(result.current.capturePreview?.previewId).toBe('preview-a');
    expect(result.current.captureResult?.purchaseOrderNumber).toBe('PO-A');
    expect(result.current.captureError).toBe('采购信息保存后的回读校验失败，当前未标记为完成。');
  });

  it('invalidates a reviewed preview when any target fingerprint field changes', async () => {
    const bridge = installBridge();
    const { result, rerender } = renderHook(
      ({ target }) => usePurchaseBrowserTargetMode({
        tabId: 'tab-a',
        target,
        targetPhase: 'target-locked',
      }),
      { initialProps: { target: bridge.target } },
    );

    await act(async () => {
      await result.current.capture();
    });
    expect(result.current.capturePreview?.previewId).toBe('preview-a');

    rerender({ target: { ...bridge.target, quantity: 2 } });
    expect(result.current.capturePreview).toBeNull();
    expect(result.current.captureResult).toBeNull();
    expect(result.current.targetPhase).toBe('target-locked');
  });
});


import { describe, expect, it, vi } from 'vitest';
import {
  hidePurchaseOrderWorkbenchViewport,
  normalizePurchaseOrderWorkbenchBounds,
  runPurchaseOrderWorkbenchNavigation,
  runPurchaseOrderWorkbenchOrderOperation,
  runPurchaseOrderWorkbenchSellerOrderLookup,
  runPurchaseOrderWorkbenchToolbarAction,
  syncPurchaseOrderWorkbenchViewport,
} from './purchaseOrderWorkbenchViewportBridge.js';

describe('purchase order workbench viewport bridge', () => {
  it('normalizes renderer coordinates and publishes one embedded CEF viewport', async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await syncPurchaseOrderWorkbenchViewport({
      x: 421.9,
      y: 114.2,
      width: 811.8,
      height: 612.4,
      visible: true,
    }, {
      requestKey: 'workbench-1',
      tabId: 'tab-1',
      sessionId: 'session-1',
      generation: 3,
      bridge,
    });
    expect(bridge).toHaveBeenCalledWith({
      command: 'embed-bounds',
      bounds: { x: 421, y: 114, width: 811, height: 612, visible: true },
      requestKey: 'workbench-1',
      tabId: 'tab-1',
      sessionId: 'session-1',
      generation: 3,
    });
  });

  it('forwards only the exact read, refresh and save operations with the active tab id', async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await runPurchaseOrderWorkbenchOrderOperation('read-payment-info', {
      tabId: 'purchase-tab-1688', bridge,
    });
    expect(bridge).toHaveBeenCalledWith({
      command: 'read-payment-info', tabId: 'purchase-tab-1688',
    });
    await runPurchaseOrderWorkbenchOrderOperation('save-payment-info', {
      tabId: 'purchase-tab-1688', bridge,
    });
    expect(bridge).toHaveBeenLastCalledWith({
      command: 'save-payment-info', tabId: 'purchase-tab-1688',
    });
    await expect(runPurchaseOrderWorkbenchOrderOperation('capture-purchase', {
      tabId: 'purchase-tab-1688', bridge,
    })).rejects.toMatchObject({ code: 'PURCHASE_BROWSER_COMMAND_INVALID' });
  });

  it('hides the native viewport without closing the account session', async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await hidePurchaseOrderWorkbenchViewport({
      requestKey: 'workbench-1', tabId: 'tab-1', sessionId: 'session-1', generation: 3, bridge,
    });
    expect(bridge).toHaveBeenCalledWith({
      command: 'embed-hide',
      requestKey: 'workbench-1',
      tabId: 'tab-1',
      sessionId: 'session-1',
      generation: 3,
    });
  });

  it('forwards a bounded exact Ozon Seller order lookup', async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await runPurchaseOrderWorkbenchSellerOrderLookup({
      tabId: 'seller-tab-1',
      postingNumber: '0149891397-1014-1',
      routeKind: 'fbs',
    }, { bridge });
    expect(bridge).toHaveBeenCalledWith({
      command: 'ozon-open-order',
      tabId: 'seller-tab-1',
      postingNumber: '0149891397-1014-1',
      routeKind: 'fbs',
    });
  });

  it('only forwards the three browser navigation actions', async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await runPurchaseOrderWorkbenchNavigation('reload', { bridge });
    expect(bridge).toHaveBeenCalledWith({ command: 'reload' });
    await expect(runPurchaseOrderWorkbenchNavigation('execute-script', { bridge }))
      .rejects.toMatchObject({ code: 'PURCHASE_BROWSER_COMMAND_INVALID' });
    expect(normalizePurchaseOrderWorkbenchBounds({ x: 0, y: 0, width: 'bad', height: 500 })).toBeNull();
  });

  it('forwards only approved title toolbar actions to the exact embedded tab', async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await runPurchaseOrderWorkbenchToolbarAction('pinduoduo-orders', {}, {
      tabId: 'purchase-tab-pdd', bridge,
    });
    expect(bridge).toHaveBeenCalledWith({
      command: 'toolbar-action',
      action: 'pinduoduo-orders',
      tabId: 'purchase-tab-pdd',
      payload: {},
    });
    await expect(runPurchaseOrderWorkbenchToolbarAction('execute-script', {}, {
      tabId: 'purchase-tab-pdd', bridge,
    })).rejects.toMatchObject({ code: 'PURCHASE_BROWSER_COMMAND_INVALID' });
  });
});

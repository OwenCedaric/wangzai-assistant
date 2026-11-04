import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPurchaseBrowserTarget,
  clearActivePurchaseBrowserTarget,
  publishPurchaseBrowserTarget,
} from './purchaseBrowserTargetBridge.js';

const previous = globalThis.window.wangzaiDesktop;

afterEach(() => {
  if (previous === undefined) delete globalThis.window.wangzaiDesktop;
  else globalThis.window.wangzaiDesktop = previous;
});

describe('purchase browser target bridge', () => {
  it('builds a shop and order scoped target', () => {
    expect(buildPurchaseBrowserTarget({
      shopId: 'shop-a',
      orderKey: 'order-a',
      productKey: 'sku-a',
      productName: '商品 A',
    })).toMatchObject({
      targetId: 'shop-a:order-a:sku-a',
      shopId: 'shop-a',
      orderKey: 'order-a',
      productTitle: '商品 A',
    });
  });

  it('publishes and clears the target only on the active native browser tab', async () => {
    const command = vi.fn(async (input) => input.command === 'state'
      ? { activeTabId: 'tab-a', tabs: [{ tabId: 'tab-a' }, { tabId: 'tab-b' }] }
      : { ok: true });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    await publishPurchaseBrowserTarget({ shopId: 'shop-a', orderKey: 'order-a', productKey: 'sku-a' });
    await clearActivePurchaseBrowserTarget();
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'set-target',
      tabId: 'tab-a',
    }));
    expect(command).toHaveBeenCalledWith({ command: 'clear-target', tabId: 'tab-a' });
  });

  it('uses the exact tab returned by the workbench open instead of rereading another active tab', async () => {
    const command = vi.fn(async (input) => input.command === 'state'
      ? { activeTabId: 'tab-other', tabs: [{ tabId: 'tab-other' }] }
      : { ok: true });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    await publishPurchaseBrowserTarget(
      { shopId: 'shop-a', orderKey: 'order-a', productKey: 'sku-a' },
      { tabId: 'tab-workbench' }
    );

    expect(command).not.toHaveBeenCalledWith({ command: 'state' });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'set-target',
      tabId: 'tab-workbench',
    }));
  });
});

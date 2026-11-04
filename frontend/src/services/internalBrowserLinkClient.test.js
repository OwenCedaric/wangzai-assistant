import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getInternalBrowserLinkErrorMessage,
  normalizeInternalBrowserUrl,
  openInternalBrowserLink,
  openInternalBrowserLinkFromEvent,
  openInternalProductLinkParser,
} from './internalBrowserLinkClient.js';

const previousBridge = globalThis.window.wangzaiDesktop;

afterEach(() => {
  if (previousBridge === undefined) delete globalThis.window.wangzaiDesktop;
  else globalThis.window.wangzaiDesktop = previousBridge;
  vi.restoreAllMocks();
});

describe('internal browser link client', () => {
  it('translates the cross-platform order capture errors', () => {
    expect(getInternalBrowserLinkErrorMessage({ code: 'PURCHASE_BROWSER_ORDER_PAGE_REQUIRED' }))
      .toBe('请先在右侧打开当前采购平台的准确订单详情页。');
    expect(getInternalBrowserLinkErrorMessage({ code: 'PURCHASE_BROWSER_ORDER_NOT_BOUND' }))
      .toContain('先打开已付款订单');
    expect(getInternalBrowserLinkErrorMessage({ code: 'PURCHASE_BROWSER_ORDER_INCOMPLETE' }))
      .toContain('订单号、实付金额和订单状态');
    expect(getInternalBrowserLinkErrorMessage({
      message: "Error invoking remote method 'desktop:purchase-browser-command': Error: PURCHASE_BROWSER_TARGET_REQUIRED",
    })).toBe('当前操作台没有绑定订单目标，请关闭后从拍单订单重新打开。');
  });

  it('shows a dedicated setup message for an unconfigured Ozon buyer account', () => {
    expect(getInternalBrowserLinkErrorMessage({ code: 'PURCHASE_BROWSER_OZON_BUYER_ACCOUNT_REQUIRED' }))
      .toBe('请先在设置中保存 Ozon 买家采购号。');
  });
  it('shows a dedicated login message when no connected Seller profile exists', () => {
    expect(getInternalBrowserLinkErrorMessage({ code: 'PURCHASE_BROWSER_OZON_SELLER_PROFILE_REQUIRED' }))
      .toBe('请先在设置中完成 Ozon 网页登录并保存 Cookie。');
  });
  it('shows a shop-specific setup message instead of suggesting another Seller account', () => {
    expect(getInternalBrowserLinkErrorMessage({ code: 'PURCHASE_BROWSER_OZON_SELLER_SHOP_PROFILE_REQUIRED' }))
      .toContain('当前店铺还没有绑定已登录的 Ozon 网页账号');
  });
  it('routes HTTP and HTTPS URLs through the desktop CEF command only', async () => {
    const command = vi.fn(async () => ({ ok: true }));
    const systemWindowOpen = vi.spyOn(globalThis.window, 'open');
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    await expect(openInternalBrowserLink('https://www.ozon.ru/product/123?from=chat')).resolves.toEqual({ ok: true });
    expect(command).toHaveBeenCalledWith({
      command: 'open-external',
      url: 'https://www.ozon.ru/product/123?from=chat',
    });
    expect(systemWindowOpen).not.toHaveBeenCalled();
  });

  it('can preserve an explicitly selected purchase account binding', async () => {
    const command = vi.fn(async () => ({ ok: true }));
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    await openInternalBrowserLink('https://www.1688.com/', { accountId: 'purchase-1688' });
    expect(command).toHaveBeenCalledWith({
      command: 'open-external',
      accountId: 'purchase-1688',
      url: 'https://www.1688.com/',
    });
  });

  it('forwards the canonical Ozon shop binding to the desktop router', async () => {
    const command = vi.fn(async () => ({ ok: true }));
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    await openInternalBrowserLink('https://seller.ozon.ru/app/postings/fbs', {
      shopId: 'shop-2',
      requireShopBinding: true,
    });
    expect(command).toHaveBeenCalledWith({
      command: 'open-external',
      url: 'https://seller.ozon.ru/app/postings/fbs',
      shopId: 'shop-2',
      requireShopBinding: true,
    });
  });

  it('opens product inspection in the isolated hidden parser role', async () => {
    const command = vi.fn(async () => ({ ok: true }));
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    await openInternalProductLinkParser('https://detail.1688.com/offer/1.html');
    expect(command).toHaveBeenCalledWith({
      command: 'open-external',
      url: 'https://detail.1688.com/offer/1.html',
      browserRole: 'product-link-parser',
      background: true,
      restoreVisible: false,
      waitUntil: 'load',
    });
  });

  it('starts Pinduoduo inspection at document commit instead of waiting for every lazy asset', async () => {
    const command = vi.fn(async () => ({ ok: true }));
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    await openInternalProductLinkParser('https://mobile.yangkeduo.com/goods.html?goods_id=123456');
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://mobile.yangkeduo.com/goods.html?goods_id=123456',
      browserRole: 'product-link-parser',
      waitUntil: 'commit',
    }));
  });

  it('carries the fixed order workbench presentation into the native browser command', async () => {
    const command = vi.fn(async () => ({ ok: true }));
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    const workbench = {
      kind: 'purchase-order',
      order: { orderNo: 'WORKBENCH-TEST-1' },
    };
    const browserTarget = {
      targetId: 'shop-3:0215352801-0034-2:mz-26032810-471686',
      shopId: 'shop-3',
      orderKey: '0215352801-0034-2',
    };
    await openInternalBrowserLink('https://mobile.yangkeduo.com/', {
      workbench,
      browserTarget,
      embeddedBounds: { x: 420.8, y: 70.2, width: 800.9, height: 600.7, visible: true },
    });
    expect(command).toHaveBeenCalledWith({
      command: 'open-external',
      url: 'https://mobile.yangkeduo.com/',
      workbench,
      purchaseTarget: browserTarget,
      embeddedBounds: { x: 420, y: 70, width: 800, height: 600, visible: true },
    });
  });

  it('fails closed for unsafe protocols, credential URLs and a missing bridge', async () => {
    expect(normalizeInternalBrowserUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeInternalBrowserUrl('file:///C:/secret.txt')).toBeNull();
    expect(normalizeInternalBrowserUrl('https://name:secret@example.com/')).toBeNull();
    delete globalThis.window.wangzaiDesktop;
    await expect(openInternalBrowserLink('https://example.com/')).rejects.toMatchObject({
      code: 'PURCHASE_BROWSER_BRIDGE_UNAVAILABLE',
    });
  });

  it('prevents the renderer default navigation before dispatching an external link', async () => {
    const command = vi.fn(async () => ({ ok: true }));
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };
    await openInternalBrowserLinkFromEvent(event, 'http://example.com/path');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith({ command: 'open-external', url: 'http://example.com/path' });
  });
});


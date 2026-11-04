import { describe, expect, it, vi } from 'vitest';

import { waitForPurchasePaymentLogin, waitForSharedAlipayLogin } from './purchasePaymentCredentialClient.js';

describe('purchase payment login polling', () => {
  it('keeps polling the exact account until both marketplace and Alipay are logged in', async () => {
    const readStatus = vi.fn()
      .mockResolvedValueOnce({ accountId: 'tb-a', marketplaceLoggedIn: true, alipayLoggedIn: false, loggedIn: false })
      .mockResolvedValueOnce({ accountId: 'tb-a', marketplaceLoggedIn: true, alipayLoggedIn: true, loggedIn: true });
    const wait = vi.fn().mockResolvedValue(undefined);
    const result = await waitForPurchasePaymentLogin({
      accountRef: 'tb-a',
      platform: '淘宝',
      attempts: 5,
      intervalMs: 100,
      readStatus,
      wait,
    });
    expect(result).toMatchObject({ loggedIn: true, attempts: 2, timedOut: false });
    expect(readStatus).toHaveBeenNthCalledWith(1, { accountRef: 'tb-a', platform: '淘宝' });
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('returns the last real status without manufacturing login after the bounded wait', async () => {
    const readStatus = vi.fn().mockResolvedValue({ marketplaceLoggedIn: true, alipayLoggedIn: false, loggedIn: false });
    const result = await waitForPurchasePaymentLogin({
      accountRef: 'tb-a',
      platform: '淘宝',
      attempts: 3,
      intervalMs: 100,
      readStatus,
      wait: async () => undefined,
    });
    expect(result).toMatchObject({ loggedIn: false, marketplaceLoggedIn: true, attempts: 3, timedOut: true });
    expect(readStatus).toHaveBeenCalledTimes(3);
  });

  it('accepts password or SMS completion from the shared Alipay session and returns its owner sync count', async () => {
    const readStatus = vi.fn()
      .mockResolvedValueOnce({ loggedIn: false, windowOpen: true })
      .mockResolvedValueOnce({ loggedIn: true, cookieSaved: true, syncedOwnerCount: 3 });
    const result = await waitForSharedAlipayLogin({
      attempts: 5,
      intervalMs: 100,
      readStatus,
      wait: async () => undefined,
    });
    expect(result).toMatchObject({ loggedIn: true, syncedOwnerCount: 3, attempts: 2, timedOut: false });
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const localApi = vi.hoisted(() => ({
  listPurchaseAccounts: vi.fn(),
  savePurchaseAccount: vi.fn(),
}));

const browserLogin = vi.hoisted(() => ({
  forceResetPurchaseBrowserLogin: vi.fn(),
  openPurchaseBrowserLogin: vi.fn(),
  readPurchaseBrowserState: vi.fn(),
}));

vi.mock('../../api/localApiClient.js', () => localApi);
vi.mock('../../features/settings/services/purchaseBrowserLoginClient.js', () => browserLogin);

import {
  PurchaseBrowserQuickActions,
  QUICK_PURCHASE_ACCOUNT_PRESETS,
} from './PurchaseBrowserQuickActions.jsx';

describe('PurchaseBrowserQuickActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localApi.listPurchaseAccounts.mockResolvedValue({ accounts: [] });
    browserLogin.openPurchaseBrowserLogin.mockResolvedValue({ ok: true });
  });

  it('only displays the five platforms with completed login persistence', async () => {
    render(<PurchaseBrowserQuickActions />);
    fireEvent.click(screen.getByRole('button', { name: '打开内置浏览器' }));

    expect(await screen.findByRole('menu', { name: '选择采购平台' })).toBeInTheDocument();
    expect(QUICK_PURCHASE_ACCOUNT_PRESETS.map((preset) => preset.platformName)).toEqual([
      '拼多多',
      '天猫',
      '淘宝',
      '1688',
      'Ozon买家',
    ]);
    expect(screen.getAllByRole('menuitem')).toHaveLength(5);
    expect(screen.queryByRole('menuitem', { name: '打开京东' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '打开Wildberries' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '打开Amazon' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '打开Temu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '打开AliExpress' })).not.toBeInTheDocument();
  });

  it('creates a missing platform profile, opens it immediately, and leaves login saving to the native window', async () => {
    localApi.savePurchaseAccount.mockResolvedValue({
      account: {
        id: 'purchase-1688-auto',
        name: '1688采购号',
        platformName: '1688',
        platformUrl: 'https://www.1688.com/',
      },
    });
    render(<PurchaseBrowserQuickActions />);
    fireEvent.click(screen.getByRole('button', { name: '打开内置浏览器' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '打开1688' }));

    await waitFor(() => {
      expect(localApi.savePurchaseAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          accountAlias: '1688采购号',
          platformName: '1688',
          platformUrl: 'https://www.1688.com/',
        }),
        { timeoutMs: 30000 },
      );
      expect(browserLogin.openPurchaseBrowserLogin).toHaveBeenCalledWith({
        accountId: 'purchase-1688-auto',
        accountLabel: '1688采购号',
        platformName: '1688',
        platformUrl: 'https://www.1688.com/',
      });
    });
  });
});

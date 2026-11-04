import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SAVED_CREDENTIAL_MASK } from './lib/credentialMask.js';
import ShopSettingsDialog from './ShopSettingsDialog.jsx';
import React from 'react';

const savedShop = {
  id: 'shop-a',
  shopAlias: '主店',
  sellerName: '主店卖家',
  clientId: 'seller-123',
  apiKey: '',
  hasClientId: true,
  hasApiKey: true,
  apiKeyHint: '••••••••••',
  connectionStatus: '本地已保存',
  connectionMessage: '可刷新读取',
  connectionDetail: '',
  lastTestAt: '',
  savedAt: '',
  purchaseManagementStartedAt: '',
  remark: '',
};

describe('ShopSettingsDialog saved credential masks', () => {
  it('shows the current shop card expiration instead of the API connection test detail', async () => {
    const onGetLicenseExpiration = vi.fn().mockResolvedValue({
      licenseId: 31,
      expireAt: '2099-01-01T12:34:56',
      status: 'active',
    });
    render(
      <ShopSettingsDialog
        open
        initialModule="ozon"
        shops={[{ ...savedShop, connectionDetail: 'roles 和 seller/info 均返回成功' }]}
        activeShopId="shop-a"
        onClose={() => {}}
        onSelect={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onChange={() => {}}
        onSave={() => {}}
        onTest={() => {}}
        onGetLicenseExpiration={onGetLicenseExpiration}
        onConfirmPurchaseBinding={() => {}}
        onResetPurchaseBinding={() => {}}
      />
    );

    expect(await screen.findByText(/2099.*12:34:56/u)).toBeInTheDocument();
    expect(screen.getByText('卡密到期时间')).toBeInTheDocument();
    expect(screen.queryByText('非必填项')).not.toBeInTheDocument();
    expect(screen.queryByText('测试结果')).not.toBeInTheDocument();
    expect(screen.queryByText(/roles 和 seller\/info/u)).not.toBeInTheDocument();
    expect(onGetLicenseExpiration).toHaveBeenCalledWith({
      id: 'shop-a',
      clientId: 'seller-123',
      client_id: '',
    });
  });

  it('moves renewal into the shop card action and refreshes the exact shop expiration', async () => {
    const onGetLicenseExpiration = vi.fn()
      .mockResolvedValueOnce({ expireAt: '2026-08-10T10:00:00', status: 'active' })
      .mockResolvedValueOnce({ expireAt: '2027-08-10T10:00:00', status: 'active' });
    const onRenewLicense = vi.fn().mockResolvedValue({
      action: 'renewed',
      licenseId: 31,
      expireAt: '2027-08-10T10:00:00',
    });
    render(
      <ShopSettingsDialog
        open
        initialModule="ozon"
        shops={[savedShop]}
        activeShopId="shop-a"
        onClose={() => {}}
        onSelect={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onChange={() => {}}
        onSave={() => {}}
        onRenewLicense={onRenewLicense}
        onTest={() => {}}
        onGetLicenseExpiration={onGetLicenseExpiration}
        onConfirmPurchaseBinding={() => {}}
        onResetPurchaseBinding={() => {}}
      />
    );

    expect(await screen.findByText(/2026.*10:00:00/u)).toBeInTheDocument();
    expect(screen.queryByLabelText('当前店铺续费卡密（仅到期时填写）')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '续费卡密' }));

    expect(screen.getByRole('heading', { name: '续费当前店铺卡密' })).toBeInTheDocument();
    expect(screen.getAllByText('主店').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: '验证并续费' }));
    expect(await screen.findByText('请输入管理系统发放的 16 位月卡或年卡卡密。')).toBeInTheDocument();
    expect(onRenewLicense).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('续费卡密'), {
      target: { value: 'aaaa-bbbb-cccc-dddd' },
    });
    fireEvent.click(screen.getByRole('button', { name: '验证并续费' }));

    await waitFor(() => expect(onRenewLicense).toHaveBeenCalledWith({
      cardKey: 'AAAA-BBBB-CCCC-DDDD',
      shopId: 'shop-a',
    }));
    expect(await screen.findByText(/2027.*10:00:00/u)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '续费当前店铺卡密' })).not.toBeInTheDocument();
    expect(onGetLicenseExpiration).toHaveBeenCalledTimes(2);
  });

  it('keeps the renewal dialog open and shows the validation failure without saving shop settings', async () => {
    const onSave = vi.fn();
    const onRenewLicense = vi.fn().mockRejectedValue(new Error('Activation code is unavailable'));
    render(
      <ShopSettingsDialog
        open
        initialModule="ozon"
        shops={[savedShop]}
        activeShopId="shop-a"
        onClose={() => {}}
        onSelect={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onChange={() => {}}
        onSave={onSave}
        onRenewLicense={onRenewLicense}
        onTest={() => {}}
        onGetLicenseExpiration={() => Promise.resolve({ expireAt: '2026-08-10T10:00:00' })}
        onConfirmPurchaseBinding={() => {}}
        onResetPurchaseBinding={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '续费卡密' }));
    fireEvent.change(screen.getByLabelText('续费卡密'), {
      target: { value: 'AAAA-BBBB-CCCC-DDDD' },
    });
    // Submission waits until the shop license status is known (renewal vs. new binding).
    await waitFor(() => expect(screen.getByRole('button', { name: '验证并续费' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '验证并续费' }));

    expect(await screen.findByText('卡密已使用、已禁用或当前不可用。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '续费当前店铺卡密' })).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the saved Client ID directly and keeps the API Key as a password mask without an extra reveal action', () => {
    render(
      <ShopSettingsDialog
        open
        initialModule="ozon"
        shops={[savedShop]}
        activeShopId="shop-a"
        onClose={() => {}}
        onSelect={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onChange={() => {}}
        onSave={() => {}}
        onTest={() => {}}
        onConfirmPurchaseBinding={() => {}}
        onResetPurchaseBinding={() => {}}
      />
    );

    expect(screen.getByDisplayValue('seller-123')).toBeTruthy();
    expect(screen.getByLabelText('Ozon API Key')).toHaveValue(SAVED_CREDENTIAL_MASK);
    expect(screen.getAllByText(SAVED_CREDENTIAL_MASK).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /显示已保存凭证/ })).not.toBeInTheDocument();
  });

  it('replaces the just-saved API Key with the fixed mask in both the password input and profile card', async () => {
    function Harness() {
      const [shop, setShop] = React.useState({ ...savedShop, apiKey: '', hasApiKey: false, apiKeyHint: '' });
      return (
        <ShopSettingsDialog
          open
          initialModule="ozon"
          shops={[shop]}
          activeShopId="shop-a"
          onClose={() => {}}
          onSelect={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          onChange={(field, value) => setShop((current) => ({ ...current, [field]: value }))}
          onSave={() => setShop((current) => ({ ...current, savedAt: '12:00:00' }))}
          onTest={() => {}}
          onConfirmPurchaseBinding={() => {}}
          onResetPurchaseBinding={() => {}}
        />
      );
    }

    render(<Harness />);
    const apiKeyInput = screen.getByLabelText('Ozon API Key');
    fireEvent.change(apiKeyInput, { target: { value: 'fixture-api-key-plain-value' } });
    expect(apiKeyInput).toHaveAttribute('type', 'password');
    expect(screen.queryByText('fixture-api-key-plain-value')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(apiKeyInput).toHaveValue(SAVED_CREDENTIAL_MASK));
    expect(screen.getAllByText(SAVED_CREDENTIAL_MASK).length).toBeGreaterThan(0);
    expect(document.body.innerHTML).not.toContain('fixture-api-key-plain-value');
    expect(screen.queryByRole('button', { name: /显示已保存凭证|显示已保存密钥|reveal/i })).not.toBeInTheDocument();
  });
});

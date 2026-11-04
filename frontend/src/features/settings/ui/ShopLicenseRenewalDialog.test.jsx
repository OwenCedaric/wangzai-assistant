import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import ShopLicenseRenewalDialog from './ShopLicenseRenewalDialog.jsx';

function renderDialog(props = {}) {
  const onSubmit = vi.fn();
  render(
    <ShopLicenseRenewalDialog
      open
      shopName="Ozon 1店"
      clientId="4067587"
      expirationText="暂未获取"
      cardKey="AAAA-BBBB-CCCC-DDDD"
      onCardKeyChange={vi.fn()}
      onCancel={vi.fn()}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { onSubmit };
}

describe('ShopLicenseRenewalDialog', () => {
  it('keeps the renewal wording when the shop already has a license in this account', () => {
    renderDialog({ licenseStatus: 'ready', expirationText: '2027-01-01' });
    expect(screen.getByText('续费当前店铺卡密')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '验证并续费' })).toBeEnabled();
  });

  it('presents an unbound shop as binding a new card, not as a renewal', () => {
    const { onSubmit } = renderDialog({ licenseStatus: 'missing' });
    expect(screen.getByText('为当前店铺绑定卡密')).toBeInTheDocument();
    expect(screen.queryByText('续费当前店铺卡密')).not.toBeInTheDocument();
    expect(screen.getByText(/会消耗一张新的月卡或年卡/u)).toBeInTheDocument();
    expect(screen.getByText(/请先在原账号解除绑定或联系管理员换绑/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '验证并绑定' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit a card while the license status is loading or unreadable', () => {
    const { onSubmit } = renderDialog({ licenseStatus: 'error' });
    expect(screen.getByText(/暂时无法读取当前店铺的授权状态/u)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: '验证并续费' });
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

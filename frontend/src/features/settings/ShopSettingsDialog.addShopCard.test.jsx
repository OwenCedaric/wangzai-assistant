import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ShopSettingsDialog from './ShopSettingsDialog.jsx';

const savedShop = {
  id: 'shop-existing',
  shopAlias: '已有店铺',
  sellerName: '已有店铺',
  clientId: 'client-existing',
  hasClientId: true,
  hasApiKey: true,
  connectionStatus: '本地已保存',
  connectionMessage: '已保存',
};

function renderDialog(onAdd) {
  return render(
    <ShopSettingsDialog
      open
      initialModule="ozon"
      shops={[savedShop]}
      activeShopId={savedShop.id}
      onClose={() => {}}
      onSelect={() => {}}
      onAdd={onAdd}
      onRemove={() => {}}
      onChange={() => {}}
      onSave={() => {}}
      onTest={() => {}}
      onConfirmPurchaseBinding={() => {}}
      onResetPurchaseBinding={() => {}}
    />,
  );
}

describe('ShopSettingsDialog additional-shop card gate', () => {
  it('does not create or expose a new shop until a valid card succeeds', async () => {
    const cardRequired = Object.assign(new Error('card required'), {
      code: 'ADDITIONAL_SHOP_CARD_REQUIRED',
    });
    const onAdd = vi.fn()
      .mockRejectedValueOnce(cardRequired)
      .mockResolvedValueOnce({ action: 'activated', licenseId: 20 });
    renderDialog(onAdd);

    fireEvent.click(screen.getByRole('button', { name: '新增' }));

    expect(await screen.findByRole('heading', { name: '先激活新增店铺卡密' })).toBeInTheDocument();
    expect(screen.queryByText(/首个店铺使用注册卡自带的授权/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/每新增一个 Ozon 店铺都必须先使用一张新的标准月卡或年卡/u)).not.toBeInTheDocument();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenLastCalledWith({ cardKey: '' });
    expect(screen.getAllByText('已有店铺').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '验证卡密并新增' }));
    expect(await screen.findByText('请输入管理系统发放的 16 位月卡或年卡卡密。')).toBeInTheDocument();
    expect(onAdd).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('新增店铺卡密'), {
      target: { value: 'aaaa-bbbb-cccc-dddd' },
    });
    fireEvent.click(screen.getByRole('button', { name: '验证卡密并新增' }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    expect(onAdd).toHaveBeenLastCalledWith({ cardKey: 'AAAA-BBBB-CCCC-DDDD' });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: '先激活新增店铺卡密' })).not.toBeInTheDocument();
    });
  });

  it('resumes an already activated unbound entitlement without asking for another card', async () => {
    const onAdd = vi.fn().mockResolvedValue({ action: 'resume-pending', licenseId: 21 });
    renderDialog(onAdd);

    fireEvent.click(screen.getByRole('button', { name: '新增' }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ cardKey: '' }));
    expect(screen.queryByRole('heading', { name: '先激活新增店铺卡密' })).not.toBeInTheDocument();
  });

  it('shows an incomplete-shop refusal without opening the card dialog', async () => {
    const incomplete = Object.assign(new Error('当前已有一个未完成的店铺，请先填写并保存 Client ID 和 API Key，再新增下一个店铺。'), {
      code: 'INCOMPLETE_OZON_SHOP_EXISTS',
    });
    const onAdd = vi.fn().mockRejectedValue(incomplete);
    renderDialog(onAdd);

    fireEvent.click(screen.getByRole('button', { name: '新增' }));

    expect(await screen.findByText(incomplete.message)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '先激活新增店铺卡密' })).not.toBeInTheDocument();
  });
});

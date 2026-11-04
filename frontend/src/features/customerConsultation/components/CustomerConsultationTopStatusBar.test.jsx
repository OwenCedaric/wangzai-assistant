import { CustomerConsultationTopStatusBar } from './CustomerConsultationTopStatusBar.jsx';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

describe('customer consultation shop/account selector', () => {
  it('shows the active shop account and switches through the app callback', () => {
    const onActiveShopChange = vi.fn();
    render(
      <CustomerConsultationTopStatusBar
        shops={[
          { id: 'shop-a', shopAlias: '一店', clientId: '1001' },
          { id: 'shop-b', sellerName: '二店', clientId: '1002' },
        ]}
        activeShopId="shop-a"
        onActiveShopChange={onActiveShopChange}
        syncLabel="读取完成"
        stats={[{ label: '未读消息', value: 3 }]}
      />
    );
    expect(screen.getByText('一店')).toBeInTheDocument();
    expect(screen.getByText('Client ID 1001')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Ozon 店铺 / 账号' }));
    fireEvent.click(screen.getByRole('option', { name: /二店/ }));
    expect(onActiveShopChange).toHaveBeenCalledWith('shop-b');
  });

  it('renders a real Ozon logo and falls back to the shop initial when the image fails', () => {
    const { rerender } = render(
      <CustomerConsultationTopStatusBar
        shops={[{ id: 'shop-a', shopAlias: '一店', clientId: '1001' }]}
        activeShopId="shop-a"
        shopProfile={{ logoUrl: 'https://cdn.ozon.ru/shop-a.png', sellerName: '一店' }}
      />
    );
    const image = screen.getByRole('img', { name: '一店 Ozon 店铺 Logo' });
    expect(image).toHaveAttribute('src', expect.stringContaining('cdn.ozon.ru/shop-a.png'));
    fireEvent.error(image);
    expect(screen.getByText('一')).toBeInTheDocument();

    rerender(
      <CustomerConsultationTopStatusBar
        shops={[{ id: 'shop-a', shopAlias: '一店', clientId: '1001' }]}
        activeShopId="shop-a"
        shopProfile={{ logoUrl: '' }}
      />
    );
    expect(screen.queryByRole('img', { name: '一店 Ozon 店铺 Logo' })).not.toBeInTheDocument();
  });
});

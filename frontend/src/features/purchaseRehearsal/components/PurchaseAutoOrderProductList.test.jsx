import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/purchaseSkuBindingService.js', () => ({
  purchaseSkuBindingErrorMessage: (error) => String(error?.message || error),
}));

vi.mock('./PurchaseSkuBindingPanel.jsx', () => ({
  PurchaseSkuBindingPanel: ({ initialOzonUrl, initialSourceUrl, onSaved }) => (
    <div>
      <span>{initialOzonUrl}</span>
      <span>{initialSourceUrl}</span>
      <button type="button" onClick={() => onSaved({ binding: { shopId: 'shop-1', pairs: [{ ozonSkuId: '200000' }] } })}>保存测试商品</button>
    </div>
  ),
}));

import { PurchaseAutoOrderProductList } from './PurchaseAutoOrderProductList.jsx';

describe('PurchaseAutoOrderProductList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows every saved source product and opens incomplete SKU binding with existing links', async () => {
    const bindingSaved = vi.fn();
    globalThis.addEventListener('wangzai:auto-order-binding-saved', bindingSaved);
    const loadProducts = vi.fn().mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'shop-1:product-100', ozonUrl: 'https://www.ozon.ru/product/demo-100000/', ozonTitle: '已绑定Ozon商品',
          shopName: 'Ozon测试店', salePrice: 88.5, saleCurrency: 'CNY', ozonImageUrl: 'https://ir.ozone.ru/ozon-product-100.jpg',
          bindingPriceMetrics: {
            sourcePrice: { min: 20, max: 20, count: 1 },
            difference: { min: 68.5, max: 68.5, count: 1 },
            grossMargin: { min: 77.40112994350282, max: 77.40112994350282, count: 1 },
          },
          sourceUrl: 'https://detail.1688.com/offer/200.html', sourceTitle: '已绑定货源商品', sourcePlatform: '1688',
          pairs: [{ ozonSkuId: '100000', ozonSkuName: '黑色', sourceSkuId: '1688-black', sourceSkuName: '雅黑' }], bindingStatus: 'bound', updatedAt: '2026-08-25T00:00:00.000Z',
        },
        {
          id: 'shop-1:product-200', ozonUrl: 'https://www.ozon.ru/product/200000/', ozonTitle: '待完善Ozon商品',
          sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=300000', sourceTitle: '已有拼多多货源', sourcePlatform: 'PDD',
          pairs: [], bindingStatus: 'sku-pending', updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
      total: 2,
      boundCount: 1,
      pendingSkuCount: 1,
    });
    render(<PurchaseAutoOrderProductList loadProducts={loadProducts} />);
    expect(await screen.findByText('已绑定Ozon商品')).toBeInTheDocument();
    expect(screen.getByText('已绑定货源商品')).toBeInTheDocument();
    expect(screen.getByText('Ozon测试店')).toBeInTheDocument();
    expect(screen.getByText('¥88.50')).toBeInTheDocument();
    expect(screen.getByText('¥20.00')).toBeInTheDocument();
    expect(screen.getByText('¥68.50')).toBeInTheDocument();
    expect(screen.getByText('77.40%')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '已绑定' })).toBeInTheDocument();
    const ozonImage = screen.getByRole('img', { name: '已绑定Ozon商品' });
    expect(ozonImage).toHaveAttribute('src', 'https://ir.ozone.ru/ozon-product-100.jpg');
    expect(ozonImage.closest('.auto-order-ozon-image-hover')).not.toBeNull();
    expect(ozonImage.parentElement).toHaveClass('auto-order-ozon-image-thumb');
    expect(screen.getByText('待完善Ozon商品')).toBeInTheDocument();
    expect(screen.getByText('已有拼多多货源')).toBeInTheDocument();
    expect(screen.getByText('待完善SKU')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '完善绑定' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByText('https://www.ozon.ru/product/200000/').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('https://mobile.yangkeduo.com/goods.html?goods_id=300000').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: '保存测试商品' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(loadProducts).toHaveBeenCalledTimes(2);
    expect(bindingSaved).toHaveBeenCalledTimes(1);
    expect(bindingSaved.mock.calls[0][0].detail).toEqual({ shopId: 'shop-1', ozonSkuIds: ['200000'] });

    fireEvent.click(screen.getByRole('button', { name: '添加商品' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/读取订单商品下的全部Ozon SKU/)).toBeInTheDocument();
    globalThis.removeEventListener('wangzai:auto-order-binding-saved', bindingSaved);
  });
});

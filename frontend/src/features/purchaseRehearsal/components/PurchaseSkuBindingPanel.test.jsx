import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectSourceSku = vi.fn();
const saveBinding = vi.fn();
const readCatalog = vi.fn();

vi.mock('../model/usePurchaseSkuBinding.js', () => ({
  usePurchaseSkuBinding: () => ({
    ozonUrl: 'https://www.ozon.ru/product/demo-100/',
    sourceUrl: 'https://detail.1688.com/offer/200.html',
    ozonCatalog: {
      title: 'Ozon商品', platform: 'Ozon买家', currency: 'RUB', url: 'https://www.ozon.ru/product/demo-100/',
      skus: [{ id: 'ozon-black-xl', name: '颜色：黑色 / 尺码：XL', price: '100', priceValue: 100, currency: 'RUB', imageUrl: '', enabled: true }],
    },
    sourceCatalog: {
      title: '货源商品', platform: '1688', currency: 'CNY', url: 'https://detail.1688.com/offer/200.html',
      skus: [
        { id: '1688-black-xl', name: '颜色：雅黑 / 尺寸：特大', price: '20', priceValue: 20, currency: 'CNY', imageUrl: '', enabled: true },
        { id: '1688-gray-xl', name: '颜色：灰色 / 尺寸：特大', price: '18', priceValue: 18, currency: 'CNY', imageUrl: '', enabled: true },
      ],
    },
    selections: { 'ozon-black-xl': '1688-black-xl' }, bindings: [], loadingRole: '', saving: false, message: 'Ozon商品：已读取 1 个具名 SKU。', errorMessage: '', rubToCnyRate: 0.1,
    setOzonUrl: vi.fn(), setSourceUrl: vi.fn(), readCatalog, selectSourceSku, saveBinding,
  }),
}));

import { PurchaseSkuBindingPanel } from './PurchaseSkuBindingPanel.jsx';

describe('PurchaseSkuBindingPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows exact SKU IDs, price difference and lets the user bind source SKU IDs', () => {
    render(<PurchaseSkuBindingPanel />);
    expect(screen.getAllByText('颜色：黑色 / 尺码：XL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('颜色：雅黑 / 尺寸：特大').length).toBeGreaterThan(0);
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: /颜色：灰色/ }));
    expect(selectSourceSku).toHaveBeenCalledWith('ozon-black-xl', '1688-gray-xl');
    fireEvent.click(screen.getByRole('button', { name: '保存SKU精确绑定' }));
    expect(saveBinding).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('只按ID命中');
    expect(document.body.textContent).toContain('¥-10.00');
    expect(document.body.textContent).not.toContain('读取Ozon订单商品的真实SKU ID、规格与售价');
    expect(document.body.textContent).not.toContain('Ozon商品：已读取 1 个具名 SKU。');
  });

});

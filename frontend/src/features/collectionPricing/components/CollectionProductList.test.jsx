import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollectionProductList } from './CollectionProductList.jsx';

vi.mock('./CollectionProductEditDialog.jsx', () => ({
  CollectionProductEditDialog: () => null,
}));

function item(overrides = {}) {
  return {
    id: 'item-1',
    title: '测试商品',
    platform: '1688',
    platformCode: '1688',
    purchasePrice: '10',
    currency: 'CNY',
    sourceProductId: '10001',
    capturedAt: '2026-08-10T15:00:00.000Z',
    skus: [{ id: 'sku-1' }],
    completeness: { status: 'complete', label: '完整', missing: [] },
    ...overrides,
  };
}

describe('CollectionProductList', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the verified Ozon shop and deletes directly from the outer list', () => {
    const onDelete = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CollectionProductList
      items={[item({
        ozonPublication: {
          status: 'completed',
          shops: [{ shopId: 'shop-a', shopLabel: '旧店铺名', completed: true }],
        },
      })]}
      shops={[{ id: 'shop-a', name: 'Ozon 一店' }]}
      onDelete={onDelete}
    />);

    expect(screen.getByText('已上传')).toBeInTheDocument();
    expect(screen.getByText('Ozon 一店')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除：测试商品' }));
    expect(window.confirm).toHaveBeenCalledWith('确定删除“测试商品”吗？');
    expect(onDelete).toHaveBeenCalledWith('item-1');
  });

  it('shows a truthful not-uploaded state before any successful readback', () => {
    render(<CollectionProductList items={[item()]} />);
    expect(screen.getByText('未上传')).toBeInTheDocument();
  });
});

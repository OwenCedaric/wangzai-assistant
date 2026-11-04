import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/productListSyncClient', () => ({
  readProductListCache: vi.fn(),
}));

import { readProductListCache } from '../../services/productListSyncClient';
import { readLocalApiProductPage } from './productLocalMirror.jsx';

describe('product canonical SQLite page query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses one cross-shop SQL page and forwards all advanced filters', async () => {
    readProductListCache.mockResolvedValue({
      rows: [
        { shopId: 'shop-a', productId: '101', offerId: 'A-101', statusLabel: '出售中' },
        { shopId: 'shop-b', productId: '202', offerId: 'B-202', statusLabel: '已下架' },
      ],
      total: 5001,
      counts: { ALL: 5001, IN_SALE: 3000, ARCHIVED: 2001 },
      sort: 'price_desc',
      source: 'sqlite',
    });
    const shops = [
      { id: 'shop-a', clientId: 'client-a', shopAlias: 'A店' },
      { id: 'shop-b', clientId: 'client-b', shopAlias: 'B店' },
    ];

    const result = await readLocalApiProductPage(
      shops,
      { label: '全部商品', visibility: 'ALL' },
      {
        page: 3,
        pageSize: 100,
        keyword: 'mzr',
        sort: 'price_desc',
        filters: {
          materialSources: ['supplier-confirmed'],
          warehouseFilters: ['default', 'multi'],
          defaultWarehouseId: '77',
          stockFilters: ['zero'],
          productStatuses: ['已下架'],
          sourceStatuses: ['1688'],
        },
      }
    );

    expect(readProductListCache).toHaveBeenCalledTimes(1);
    expect(readProductListCache).toHaveBeenCalledWith(
      expect.objectContaining({
        shopIds: ['shop-a', 'shop-b'],
        visibility: 'ALL',
        page: 3,
        pageSize: 100,
        keyword: 'mzr',
        sort: 'price_desc',
        materialSources: ['supplier'],
        warehouseFilters: ['default', 'multi'],
        defaultWarehouseId: '77',
        stockFilters: ['zero'],
        productStatuses: ['已下架'],
        sourceStatuses: ['1688'],
      }),
      expect.any(Object)
    );
    expect(readProductListCache.mock.calls[0][0]).not.toHaveProperty('shopId');
    expect(result.total).toBe(5001);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.shopId)).toEqual(['shop-a', 'shop-b']);
  });
});

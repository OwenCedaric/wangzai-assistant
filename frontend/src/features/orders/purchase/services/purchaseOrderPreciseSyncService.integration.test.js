import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enrich: vi.fn(),
  read: vi.fn(),
}));

vi.mock('../../../../entities/profit/profitOrderSnapshot.jsx', () => ({
  enrichPurchaseRowsWithOzonImagesForShops: mocks.enrich,
  getOzonOrderScopedRecordKey: (row = {}) => `${row.shopId}:${row.id}`,
  mergeOzonSalesOrderRows: (previous, current) => ({
    ...previous,
    ...current,
    products: current.products || previous.products,
  }),
  requestOzonSalesOrdersSnapshotForShops: mocks.read,
}));

import { requestPurchaseOrdersPreciseSnapshotForShops } from './purchaseOrderPreciseSyncService.js';

describe('拍单精准同步完整链路', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('先同步小范围变化并补图，再读取完整本地列表展示', async () => {
    const deltaRow = { shopId: 'shop-a', id: 'ORDER-NEW', products: [{ offerId: 'SKU-NEW', image: '' }] };
    const fullOld = { shopId: 'shop-a', id: 'ORDER-OLD', products: [{ offerId: 'SKU-OLD', image: 'https://old.jpg' }] };
    mocks.read
      .mockResolvedValueOnce({ rows: [deltaRow], errors: [] })
      .mockResolvedValueOnce({ rows: [deltaRow, fullOld], errors: [], total: 2 });
    mocks.enrich.mockResolvedValue({
      rows: [{ ...deltaRow, products: [{ offerId: 'SKU-NEW', image: 'https://new.jpg' }] }],
      errors: [],
    });

    const result = await requestPurchaseOrdersPreciseSnapshotForShops([{ id: 'shop-a' }], {
      forceRefresh: true,
      preciseSync: true,
      previousFetchedAt: '2026-08-28T12:00:00.000Z',
      dateRange: { since: '2026-05-30T13:00:00.000Z', to: '2026-08-28T13:00:00.000Z' },
    });

    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.read.mock.calls[0][1]).toMatchObject({
      forceRefresh: true,
      concurrentEndpoints: true,
      primaryOrderVariantOnly: true,
      maxPages: 10,
      requestedBy: 'frontend-purchase-orders-precise-refresh',
    });
    expect(mocks.read.mock.calls[1][1]).toMatchObject({
      forceRefresh: false,
      autoSync: false,
      concurrentEndpoints: false,
    });
    expect(mocks.enrich).toHaveBeenCalledWith(
      [{ id: 'shop-a' }],
      [deltaRow],
      expect.objectContaining({ includeSkuFallback: true }),
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].products[0].image).toBe('https://new.jpg');
    expect(result.rows[1].products[0].image).toBe('https://old.jpg');
    expect(result.preciseSync).toMatchObject({ deltaRows: 1, imageCandidates: 1, imageRows: 1, maxPages: 10 });
  });
});

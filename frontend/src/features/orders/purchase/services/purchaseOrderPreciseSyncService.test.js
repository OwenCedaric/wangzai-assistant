import { beforeEach, describe, expect, it, vi } from 'vitest';
const readers = vi.hoisted(() => ({ local: vi.fn(), sync: vi.fn() }));
vi.mock('../../../../services/salesOrderPagedCacheClient.js', () => ({ readAllSalesOrderPagedCache: readers.local }));
vi.mock('../../../../entities/profit/profitOrderSnapshot.jsx', async original => ({
  ...(await original()), requestOzonSalesOrdersSnapshotForShops: readers.sync,
}));
import {
  createPurchaseOrderPreciseSyncRange,
  hasPurchaseOrderProductImage,
  mergePurchasePreciseImageRows,
  requestPurchaseOrdersPreciseSnapshotForShops,
} from './purchaseOrderPreciseSyncService.js';

describe('拍单管理精准增量同步', () => {
  beforeEach(() => { readers.local.mockReset(); readers.sync.mockReset(); });
  it('普通进入页面只读取同一日期范围的SQLite订单，不触发外部同步', async () => {
    const shops = [{ id: 'shop-1', clientId: 'client-1' }];
    const timeScope = { since: '2026-09-01T00:00:00.000Z', to: '2026-09-05T00:00:00.000Z' };
    const rows = [{ id: 'local-order', shopId: 'shop-1' }];
    readers.local.mockResolvedValue({ rows, source: 'sqlite', total: 1 });
    const result = await requestPurchaseOrdersPreciseSnapshotForShops(shops, { timeScope, forceRefresh: false });
    expect(result.rows).toEqual(rows);
    expect(readers.local).toHaveBeenCalledWith(expect.objectContaining({ shops, timeScope }), expect.objectContaining({ bypassMemory: false }));
    expect(readers.sync).not.toHaveBeenCalled();
  });
  it('推送后的仅缓存重读不被force标志升级成外部业务同步', async () => {
    readers.local.mockResolvedValue({ rows: [], source: 'sqlite' });
    await requestPurchaseOrdersPreciseSnapshotForShops([{ id: 'shop-1' }], { forceRefresh: true, preciseSync: false });
    expect(readers.local).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ bypassMemory: true }));
    expect(readers.sync).not.toHaveBeenCalled();
  });
  it('首次精准同步只回查完整范围末尾七天', () => {
    expect(createPurchaseOrderPreciseSyncRange({
      fullRange: {
        since: '2026-05-30T13:00:00.000Z',
        to: '2026-08-28T13:00:00.000Z',
      },
      now: '2026-08-28T13:00:00.000Z',
    })).toEqual({
      since: '2026-08-21T13:00:00.000Z',
      to: '2026-08-28T13:00:00.000Z',
    });
  });

  it('后续精准同步从上次成功时间向前重叠六小时', () => {
    expect(createPurchaseOrderPreciseSyncRange({
      fullRange: {
        since: '2026-05-30T13:00:00.000Z',
        to: '2026-08-28T13:00:00.000Z',
      },
      previousFetchedAt: '2026-08-28T12:00:00.000Z',
    })).toEqual({
      since: '2026-08-28T06:00:00.000Z',
      to: '2026-08-28T13:00:00.000Z',
    });
  });

  it('只给精确订单补图并保留完整历史列表顺序', () => {
    const fullRows = [
      { shopId: 'shop-a', id: 'ORDER-1', products: [{ offerId: 'SKU-1', image: '' }] },
      { shopId: 'shop-a', id: 'ORDER-2', products: [{ offerId: 'SKU-2', image: 'https://old/2.jpg' }] },
    ];
    const imageRows = [
      { shopId: 'shop-a', id: 'ORDER-1', products: [{ offerId: 'SKU-1', image: 'https://new/1.jpg' }] },
    ];
    const merged = mergePurchasePreciseImageRows(fullRows, imageRows);
    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.id)).toEqual(['ORDER-1', 'ORDER-2']);
    expect(hasPurchaseOrderProductImage(merged[0])).toBe(true);
    expect(merged[0].products[0].image).toBe('https://new/1.jpg');
    expect(merged[1].products[0].image).toBe('https://old/2.jpg');
  });
});

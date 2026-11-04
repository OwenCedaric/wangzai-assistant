import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  readAllSalesOrderPagedCache: vi.fn(),
}));

vi.mock('../../../services/salesOrderPagedCacheClient.js', () => ({
  readAllSalesOrderPagedCache: cacheMocks.readAllSalesOrderPagedCache,
}));

import { readProfitOrdersFromSharedCache } from './profitSharedOrderCacheService.js';

describe('profit shared order cache reader', () => {
  beforeEach(() => {
    cacheMocks.readAllSalesOrderPagedCache.mockReset();
  });

  it('reads all profit input orders from the canonical order-management cache without starting a refresh', async () => {
    const shops = [{ id: 'shop-a' }, { id: 'shop-b' }];
    const timeScope = { since: '2026-05-26T00:00:00.000Z', to: '2026-08-25T00:00:00.000Z' };
    cacheMocks.readAllSalesOrderPagedCache.mockResolvedValue({
      rows: [{ orderKey: 'shop-a:order-1' }],
      total: 1,
      source: 'sqlite',
      fetchedAt: '2026-08-24T06:00:00.000Z',
    });

    const result = await readProfitOrdersFromSharedCache(shops, timeScope);

    expect(cacheMocks.readAllSalesOrderPagedCache).toHaveBeenCalledWith(
      {
        shops,
        timeScope,
        shop: 'all',
        status: 'all',
        fulfillment: 'all',
        keyword: '',
        page: 1,
        includeSummary: false,
        allHistory: false,
        includeProductImages: true,
        projection: 'profit',
      },
      { timeoutMs: 30_000 }
    );
    expect(result).toEqual({
      rows: [{ orderKey: 'shop-a:order-1' }],
      total: 1,
      source: 'sqlite',
      fetchedAt: '2026-08-24T06:00:00.000Z',
    });
  });

  it('returns cached orders before optional exchange-rate hydration', async () => {
    cacheMocks.readAllSalesOrderPagedCache.mockResolvedValue({
      rows: [{ orderKey: 'shop-a:order-fast', products: [{ image: 'https://img.example/fast.jpg' }] }],
      total: 1,
      source: 'sqlite',
    });
    const readExchangeRateContext = vi.fn();

    const result = await readProfitOrdersFromSharedCache(
      [{ id: 'shop-a' }],
      null,
      { deferExchangeRates: true, readExchangeRateContext },
    );

    expect(result.rows[0].products[0].image).toBe('https://img.example/fast.jpg');
    expect(readExchangeRateContext).not.toHaveBeenCalled();
  });

  it('automatically fills the missing current-day exchange rate for pushed orders', async () => {
    const row = {
      orderKey: 'shop-a:order-today',
      paymentDate: '2026-08-25T01:23:32.000Z',
      amountValue: 101,
    };
    cacheMocks.readAllSalesOrderPagedCache.mockResolvedValue({
      rows: [row],
      total: 1,
      source: 'sqlite',
      fetchedAt: '2026-08-25T03:00:00.000Z',
    });
    const readExchangeRateContext = vi.fn().mockResolvedValue({
      todayKey: '2026-08-25',
      realtime: { requestedDate: '2026-08-25', rubToCnyRate: 0.0810747 },
      dailyRates: new Map(),
      errors: [],
    });
    const buildExchangeRateBundle = vi.fn().mockReturnValue({
      estimated: { requestedDate: '2026-08-25', rubToCnyRate: 0.0810747 },
      actual: null,
    });
    const persistExchangeRateContext = vi.fn().mockResolvedValue({ ok: true });

    const result = await readProfitOrdersFromSharedCache(
      [{ id: 'shop-a' }],
      { since: '2026-05-27T00:00:00.000Z', to: '2026-08-26T00:00:00.000Z' },
      { readExchangeRateContext, buildExchangeRateBundle, persistExchangeRateContext },
    );

    expect(readExchangeRateContext).toHaveBeenCalledWith(
      [row],
      expect.objectContaining({
        dateKeys: ['2026-08-25'],
        exchangeRateMaxLookbackDays: 14,
      }),
    );
    expect(result.rows[0]).toMatchObject({
      rubToCnyRate: 0.0810747,
      estimatedExchangeRate: { requestedDate: '2026-08-25', rubToCnyRate: 0.0810747 },
    });
    expect(persistExchangeRateContext).toHaveBeenCalledTimes(1);
  });

  it('uses the latest cached daily rate when the current-day provider has not published yet', async () => {
    const row = {
      orderKey: 'shop-a:order-today-fallback',
      paymentDate: '2026-08-25T01:23:32.000Z',
      amountValue: 101,
    };
    cacheMocks.readAllSalesOrderPagedCache.mockResolvedValue({ rows: [row], total: 1, source: 'sqlite' });
    const readExchangeRateContext = vi.fn().mockResolvedValue({
      todayKey: '2026-08-25',
      realtime: null,
      dailyRates: new Map([['2026-08-24', {
        date: '2026-08-22',
        requestedDate: '2026-08-24',
        rubToCnyRate: 0.0810747,
        source: 'cbr-official-dynamic',
      }]]),
      errors: [],
    });
    const buildExchangeRateBundle = vi.fn((order, context) => ({
      estimated: context.realtime,
      actual: null,
    }));
    const persistExchangeRateContext = vi.fn().mockResolvedValue({ ok: true });

    const result = await readProfitOrdersFromSharedCache(
      [{ id: 'shop-a' }],
      null,
      { readExchangeRateContext, buildExchangeRateBundle, persistExchangeRateContext },
    );

    expect(buildExchangeRateBundle.mock.calls[0][1].realtime).toMatchObject({
      mode: 'daily-nearest',
      requestedDate: '2026-08-25',
      rubToCnyRate: 0.0810747,
      lookbackDaysUsed: 1,
    });
    expect(result.rows[0].rubToCnyRate).toBe(0.0810747);
    expect(persistExchangeRateContext).toHaveBeenCalledWith(
      expect.objectContaining({ realtime: expect.objectContaining({ requestedDate: '2026-08-25' }) }),
      expect.objectContaining({ todayKey: '2026-08-25' }),
    );
  });
});

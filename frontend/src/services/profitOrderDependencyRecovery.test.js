import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeOzonProfitOrder } from '../entities/profit/profitDisplayRules.jsx';
import {
  mergeProfitOrderCanonicalDependency,
  readProfitOrderCanonicalDependencyRows,
} from './profitOrderDependencyRecovery.js';
import { clearSalesOrderPagedMemoryCache } from './salesOrderPagedCacheClient.js';

const shops = [
  { id: 'shop-1', clientId: 'client-1', apiKey: 'key-1', shopAlias: '一店' },
  { id: 'shop-2', clientId: 'client-2', apiKey: 'key-2', shopAlias: '二店' },
];

afterEach(() => {
  clearSalesOrderPagedMemoryCache();
  vi.restoreAllMocks();
  delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
});

describe('profit order canonical dependency recovery', () => {
  it('restores exact mixed-rate line prices and calculates the real commission', () => {
    const cached = {
      shopId: 'shop-1',
      posting: '12992798-1056-1',
      amountValue: 361,
      currencyCode: 'CNY',
      products: [
        { offerId: 'A', commissionPercent: 12, qty: 1 },
        { offerId: 'B', commissionPercent: 12, qty: 1 },
        { offerId: 'C', commissionPercent: 17, qty: 1 },
      ],
    };
    const canonical = {
      shopId: 'shop-1',
      posting: '12992798-1056-1',
      products: [
        { offerId: 'A', price: 97, qty: 1, currencyCode: 'CNY' },
        { offerId: 'B', price: 113, qty: 1, currencyCode: 'CNY' },
        { offerId: 'C', price: 151, qty: 1, currencyCode: 'CNY' },
      ],
    };

    const merged = mergeProfitOrderCanonicalDependency(cached, canonical);
    expect(merged.products.map((product) => product.salesAmountValue)).toEqual([97, 113, 151]);
    const normalized = normalizeOzonProfitOrder(merged, { fetchedAt: 'test' });
    expect(normalized.profitLedger.amounts.estimatedCommissionFeeCny.status).toBe('ready');
    expect(normalized.profitLedger.amounts.estimatedCommissionFeeCny.value).toBeCloseTo(50.87, 8);
  });

  it('reads only exact shop and posting scopes from SQLite and never crosses stores', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input);
      const shopId = url.searchParams.get('shopId');
      const postingNumbers = url.searchParams.get('postingNumbers');
      const requested = postingNumbers?.split(',') || [];
      return new Response(JSON.stringify({
        ok: true,
        source: 'sqlite',
        rows: requested.map((posting) => ({
          shopId,
          posting_number: posting,
          amount: 100,
          currencyCode: 'CNY',
          status: 'awaiting_packaging',
          products: [{ offer_id: `${shopId}-SKU`, price: 100, quantity: 1 }],
        })),
        total: requested.length,
        page: 1,
        pageSize: requested.length,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await readProfitOrderCanonicalDependencyRows([
      { shopId: 'shop-1', posting: 'POST-1', products: [{ offerId: 'shop-1-SKU', commissionPercent: 12 }] },
      { shopId: 'shop-2', posting: 'POST-1', products: [{ offerId: 'shop-2-SKU', commissionPercent: 17 }] },
    ], shops);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([input]) => new URL(input));
    expect(urls.map((url) => [url.searchParams.get('shopId'), url.searchParams.get('postingNumbers')]).sort()).toEqual([
      ['shop-1', 'POST-1'],
      ['shop-2', 'POST-1'],
    ]);
    expect(result.rows[0].products[0]).toMatchObject({ salesAmountValue: 100, commissionPercent: 12 });
    expect(result.rows[1].products[0]).toMatchObject({ salesAmountValue: 100, commissionPercent: 17 });
    expect(result.matchedKeys.size).toBe(2);
  });

  it('keeps the original row unchanged when SQLite has no exact match', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      source: 'sqlite',
      rows: [],
      total: 0,
      page: 1,
      pageSize: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const source = { shopId: 'shop-1', posting: 'MISSING', products: [{ offerId: 'A', commissionPercent: 12 }] };
    const result = await readProfitOrderCanonicalDependencyRows([source], shops);
    expect(result.rows[0]).toBe(source);
    expect(result.matchedKeys.size).toBe(0);
  });
});

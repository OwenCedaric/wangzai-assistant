import { afterEach, expect, it, vi } from 'vitest';
import { shopOrderRepositoryRouterInternals } from '../../../local-api/src/db/shopOrderRepositoryRouter.js';
import { clearOrderDomainCache } from './orderCanonicalCacheRuntime.js';
import { clearSalesOrderPagedMemoryCache, createCanonicalOrderComparator, readAllSalesOrderPagedCache } from './salesOrderPagedCacheClient.js';

const locale = new Intl.Collator(undefined, { numeric: true }).resolvedOptions().locale;
const shops = [1, 2].map(n => ({ id: `shop-${n}`, clientId: `client-${n}`, apiKey: 'synthetic', shopAlias: `店铺${n}` }));
const rows = Array.from({ length: 2402 }, (_, i) => ({
  id: `posting-${i}`, posting_number: `posting-${i}`, shopId: shops[i % 2].id, order_id: String(i),
  in_process_at: new Date(Date.UTC(2026, 8, 7) - i * 1000).toISOString(), status: 'awaiting_packaging', products: [],
}));
const expected = rows.slice().sort(shopOrderRepositoryRouterInternals.compareOrders);
afterEach(() => { clearSalesOrderPagedMemoryCache(); clearOrderDomainCache(); vi.restoreAllMocks(); });

function server({ failOwner = '', changeTotal = false } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const query = new URL(String(url)).searchParams;
    const owner = query.get('shopId');
    if (owner === failOwner) return new Response(JSON.stringify({ error: { message: 'owner-read-failed' } }),
      { status: 500, headers: { 'content-type': 'application/json' } });
    const selected = owner ? expected.filter(row => row.shopId === owner) : expected;
    const size = Number(query.get('pageSize')) || 20, page = Number(query.get('page')) || 1;
    const total = selected.length + (changeTotal && owner === 'shop-1' ? 1 : 0);
    return new Response(JSON.stringify({ ok: true, rows: selected.slice((page - 1) * size, page * size),
      total, page, pageSize: size, ...(owner ? {} : { orderSortLocale: locale, source: 'shop-federated' }) }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

it('complete multi-shop scans use exact owners after first paint and preserve every row and original global order', async () => {
  const fetch = server(), firstPaint = vi.fn();
  const result = await readAllSalesOrderPagedCache({ shops }, { observe: false, onInitialSnapshot: firstPaint });
  expect(result.rows.map(row => row.raw)).toEqual(expected);
  expect(result.total).toBe(2402);
  expect(result.complete).toBe(true);
  expect(result.readStrategy).toBe('exact-owner-full-range');
  expect(firstPaint).toHaveBeenCalledTimes(1);
  expect(firstPaint.mock.calls[0][0]).toMatchObject({ complete: false, partial: true, loadedRows: 1000 });
  const queries = fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams);
  expect(queries.filter(query => !query.get('shopId'))).toHaveLength(1);
  expect(queries.filter(query => query.get('shopId'))).toHaveLength(4);
  expect(queries.filter(query => query.get('shopId')).every(query => query.get('_readOnlyScan') === '1')).toBe(true);
});

it('one failed owner or changed total cannot become a complete successful range', async () => {
  server({ failOwner: 'shop-2' });
  await expect(readAllSalesOrderPagedCache({ shops }, { observe: false })).rejects.toThrow('owner-read-failed');
  vi.restoreAllMocks(); clearSalesOrderPagedMemoryCache(); clearOrderDomainCache();
  server({ changeTotal: true });
  await expect(readAllSalesOrderPagedCache({ shops }, { observe: false })).rejects.toThrow(/SALES_ORDER_RANGE_INCOMPLETE|SALES_ORDER_TOTAL_CHANGED/);
});

it('renderer ordering exactly follows the existing server comparator including legacy aliases and numeric identities', () => {
  const originals = [
    { paymentAt: '2026-09-07', postingNumber: '10', id: '10', shopId: '2' },
    { payment_at: '2026-09-07', posting_number: '2', id: '2', shop_id: '10' },
    { paymentAt: '', inProcessAt: '2028', orderId: '10', id: 'a' },
    { in_process_at: '2025', order_id: '2', id: 'b' },
    { updated_at: '2024', id: 'c' }, { updatedAt: '2024', id: 'c', shopId: '2' },
  ];
  const compare = createCanonicalOrderComparator(locale);
  for (const a of originals) for (const b of originals) {
    expect(Math.sign(compare({ raw: a }, { raw: b }))).toBe(Math.sign(shopOrderRepositoryRouterInternals.compareOrders(a, b)));
  }
});

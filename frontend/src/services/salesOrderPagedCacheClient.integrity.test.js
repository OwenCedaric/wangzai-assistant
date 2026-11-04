import { afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../api/localApiClient.js', async original => ({ ...(await original()), getDomainCache: api.read }));
import { clearSalesOrderPagedMemoryCache, invalidateSalesOrderPagedMemoryCache, readAllSalesOrderPagedCache, readSalesOrderPagedCache } from './salesOrderPagedCacheClient.js';
const shop = { id: 'fixture-shop', clientId: 'fixture-client', apiKey: 'synthetic-key', shopIncarnation: 'generation-1', credentialRevision: 1 };
const rows = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ shopId: shop.id, posting_number: `p-${start + i}`, products: [] }));
afterEach(() => { clearSalesOrderPagedMemoryCache(); api.read.mockReset(); });

it('does not issue an extra empty-page request after a known exact full page', async () => {
  api.read.mockResolvedValue({ rows: rows(1000), total: 1000 });
  const initial = vi.fn();
  const result = await readAllSalesOrderPagedCache({ shops: [shop] }, { onInitialSnapshot: initial });
  expect(result.complete).toBe(true);
  expect(api.read).toHaveBeenCalledTimes(1);
  expect(initial).not.toHaveBeenCalled();
});

it('does not report a repeated nonempty page as complete', async () => {
  api.read.mockResolvedValue({ rows: rows(1000), total: 2000 });
  await expect(readAllSalesOrderPagedCache({ shops: [shop] })).rejects.toThrow('SALES_ORDER_PAGE_REPEATED');
});

it('refuses an early empty page while the reported range is still incomplete', async () => {
  api.read.mockResolvedValueOnce({ rows: rows(1000), total: 2000 }).mockResolvedValueOnce({ rows: [], total: 2000 });
  await expect(readAllSalesOrderPagedCache({ shops: [shop] })).rejects.toThrow('SALES_ORDER_RANGE_INCOMPLETE');
});

it('does not cache a partial multi-shop response as a complete page', async () => {
  api.read.mockResolvedValue({ rows: rows(1), total: 1, partial: true });
  await expect(readSalesOrderPagedCache({ shops: [shop] })).rejects.toThrow('SALES_ORDER_PAGE_INCOMPLETE');
});

it('cannot repopulate a cache with a late read after owner invalidation', async () => {
  let resolve;
  api.read.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const read = readSalesOrderPagedCache({ shops: [shop] });
  const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
  invalidateSalesOrderPagedMemoryCache({ shopId: shop.id });
  resolve({ rows: rows(1), total: 1 });
  await rejected;
  api.read.mockResolvedValueOnce({ rows: rows(1, 5), total: 1 });
  expect((await readSalesOrderPagedCache({ shops: [shop] })).rows[0].posting).toBe('p-5');
  expect(api.read).toHaveBeenCalledTimes(2);
});

it('never reuses a page for a rebound shop generation', async () => {
  api.read.mockResolvedValueOnce({ rows: rows(1), total: 1 }).mockResolvedValueOnce({ rows: rows(1, 8), total: 1 });
  await readSalesOrderPagedCache({ shops: [shop] });
  const next = await readSalesOrderPagedCache({ shops: [{ ...shop, shopIncarnation: 'generation-2', credentialRevision: 2 }] });
  expect(next.rows[0].posting).toBe('p-8');
  expect(api.read).toHaveBeenCalledTimes(2);
});

it('rejects a growing range instead of using the first total as proof of completion', async () => {
  api.read.mockResolvedValueOnce({ rows: rows(1000), total: 1001 })
    .mockResolvedValueOnce({ rows: rows(1000, 1000), total: 2001 });
  await expect(readAllSalesOrderPagedCache({ shops: [shop] })).rejects.toThrow('SALES_ORDER_TOTAL_CHANGED');
  api.read.mockResolvedValueOnce({ rows: rows(1, 9999), total: 1 });
  expect((await readAllSalesOrderPagedCache({ shops: [shop] })).rows[0].posting).toBe('p-9999');
  expect(api.read).toHaveBeenCalledTimes(3);
});

it('rejects a shrinking range and leaves the next retry uncached', async () => {
  api.read.mockResolvedValueOnce({ rows: rows(1000), total: 2000 })
    .mockResolvedValueOnce({ rows: [], total: 1000 });
  await expect(readAllSalesOrderPagedCache({ shops: [shop] })).rejects.toThrow('SALES_ORDER_TOTAL_CHANGED');
  api.read.mockResolvedValueOnce({ rows: rows(1000), total: 1000 });
  expect((await readAllSalesOrderPagedCache({ shops: [shop] })).complete).toBe(true);
  expect(api.read).toHaveBeenCalledTimes(3);
});

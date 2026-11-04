import { afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../api/localApiClient.js', async original => ({ ...(await original()), getDomainCache: api.read }));
import { clearSalesOrderPagedMemoryCache, readAllSalesOrderPagedCache } from './salesOrderPagedCacheClient.js';
const shops = [{ id: 'fixture-shop', clientId: 'fixture-client', apiKey: 'fixture-key' }];
const rows = (start, length) => Array.from({ length }, (_, i) => ({ shopId: 'fixture-shop', posting_number: `fixture-${start+i}`, products: [] }));
afterEach(() => { api.read.mockReset(); clearSalesOrderPagedMemoryCache(); });

it('publishes an explicitly incomplete first batch without waiting for the remaining pages', async () => {
  let finish;
  const later = new Promise(resolve => { finish = resolve; });
  api.read.mockResolvedValueOnce({ rows: rows(0,1000), total: 1001, source: 'sqlite' }).mockReturnValueOnce(later);
  const initial = vi.fn(); let completed = false;
  const loading = readAllSalesOrderPagedCache({ shops }, { onInitialSnapshot: initial }).then(result => { completed = true; return result; });
  await vi.waitFor(() => expect(initial).toHaveBeenCalledOnce());
  expect(completed).toBe(false);
  expect(initial.mock.calls[0][0]).toMatchObject({ complete: false, partial: true, loadedRows: 1000 });
  finish({ rows: rows(1000,1), total: 1001, source: 'sqlite' });
  const result = await loading;
  expect(result.rows).toHaveLength(1001);
  expect(result).toMatchObject({ complete: true, partial: false });
  expect(api.read).toHaveBeenCalledTimes(2);
});

it('does not publish a partial count for an already complete small result', async () => {
  api.read.mockResolvedValueOnce({ rows: rows(0,2), total: 2, source: 'sqlite' });
  const initial = vi.fn();
  const result = await readAllSalesOrderPagedCache({ shops }, { onInitialSnapshot: initial });
  expect(initial).not.toHaveBeenCalled(); expect(result.rows).toHaveLength(2); expect(result.complete).toBe(true);
});

it('a later failed page never converts the first batch into a complete result', async () => {
  const failure = new Error('isolated page-two failure');
  api.read.mockResolvedValueOnce({ rows: rows(0,1000), total: 2000 }).mockRejectedValueOnce(failure);
  const initial = vi.fn();
  await expect(readAllSalesOrderPagedCache({ shops }, { onInitialSnapshot: initial })).rejects.toBe(failure);
  expect(initial).toHaveBeenCalledOnce(); expect(initial.mock.calls[0][0].complete).toBe(false);
});

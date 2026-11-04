import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ getDomainCache: vi.fn() }));
vi.mock('../api/localApiClient', async (original) => ({ ...(await original()), getDomainCache: api.getDomainCache }));
import { readLocalProfitFinanceCacheForShop, buildLocalProfitFinanceHydrationContext } from '../entities/profit/profitAfterSalesRules.jsx';

const shop = { id: 'future-shop', clientId: 'future-client', apiKey: 'unit-test' };
const orders = ['98765432-0001-1', '98765432-0002-1'].map((posting) => ({ id: posting, posting, shopId: shop.id, shopClientId: shop.clientId }));
const operation = (id, posting = orders[0].posting) => ({ operation_id: id, posting_number: posting, amount: -2 });
const options = { maxFinanceLookupKeys: 1, localFinancePostingChunkSize: 1, localFinancePageSize: 2 };

describe('finance batch completion and failed-only readback', () => {
  beforeEach(() => api.getDomainCache.mockReset());
  it('reads every result page when a larger default posting batch exceeds 1000 transactions', async () => {
    const manyOrders = Array.from({ length: 300 }, (_, i) => {
      const posting = `98765432-${String(i).padStart(4, '0')}-1`;
      return { id: posting, posting, shopId: shop.id, shopClientId: shop.clientId };
    });
    api.getDomainCache.mockImplementation(async (_domain, query = {}) => {
      if (!query.postingNumbers) return { rows: [], total: 0 };
      const all = query.postingNumbers.split(',').flatMap(posting => Array.from({ length: 6 }, (_, i) => operation(`${posting}:${i}`, posting)));
      return { rows: all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: all.length };
    });
    const result = await readLocalProfitFinanceCacheForShop(shop, manyOrders, { maxFinanceLookupKeys: 1 });
    expect(result.complete).toBe(true);
    expect(result.operations).toHaveLength(1800);
    expect(new Set(result.operations.map(row => row.operation_id)).size).toBe(1800);
    expect(result.checkedPostingNumbers).toHaveLength(300);
    expect(result.stats).toMatchObject({ batchCount: 2, requestCount: 3 });
  });
  it('never publishes a half-read batch or marks a failed posting checked; retries only the failed batch', async () => {
    api.getDomainCache.mockImplementation(async (_domain, query = {}) => {
      if (!query.postingNumbers) return { rows: [], total: 0 };
      if (query.postingNumbers === orders[1].posting) return { rows: [operation('shop-two', orders[1].posting)], total: 1 };
      if (query.page === 1) return { rows: [operation('one'), operation('two')], total: 3 };
      throw new Error('temporary read failure');
    });
    const partial = await readLocalProfitFinanceCacheForShop(shop, orders, options);
    expect(partial.checkedPostingNumbers).toEqual([orders[1].posting]);
    expect(partial.failedPostingNumbers).toEqual([orders[0].posting]);
    expect(partial.operations.map((row) => row.operation_id)).toEqual(['shop-two']);
    expect(partial.complete).toBe(false);
    api.getDomainCache.mockClear();
    api.getDomainCache.mockImplementation(async (_domain, query = {}) => !query.postingNumbers ? { rows: [], total: 0 } : query.page === 1
      ? { rows: [operation('one'), operation('two')], total: 3 }
      : { rows: [operation('three')], total: 3 });
    const complete = await readLocalProfitFinanceCacheForShop(shop, orders, { ...options, previousReadback: partial });
    expect(complete.complete).toBe(true);
    expect(complete.operations).toHaveLength(4);
    expect(api.getDomainCache.mock.calls.every(([, query]) => query.postingNumbers === orders[0].posting)).toBe(true);
    expect(complete.checkedPostingNumbers.sort()).toEqual(orders.map((row) => row.posting).sort());
  });
  it.each([
    { rows: [operation('short')], total: 3 },
    { rows: [operation('one'), operation('one')], total: 2 },
    { rows: [], total: 2 },
    { rows: [], total: 'unknown' },
  ])('rejects truncated, duplicated and malformed readback: %j', async (payload) => {
    api.getDomainCache.mockResolvedValue(payload);
    const result = await readLocalProfitFinanceCacheForShop(shop, orders.slice(0, 1), options);
    expect(result.complete).toBe(false);
    expect(result.checkedPostingNumbers).toEqual([]);
    expect(result.operations).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
  it('accepts a truly empty completed read without retrying it forever', async () => {
    api.getDomainCache.mockResolvedValue({ rows: [], total: 0 });
    const result = await readLocalProfitFinanceCacheForShop(shop, orders.slice(0, 1), options);
    expect(result.complete).toBe(true);
    expect(result.checkedPostingNumbers).toEqual([orders[0].posting]);
  });
  it('does not publish pages from two different totals when data changes during pagination', async () => {
    api.getDomainCache.mockResolvedValueOnce({ rows: [operation('one'), operation('two')], total: 3 })
      .mockResolvedValueOnce({ rows: [operation('three')], total: 4 });
    const result = await readLocalProfitFinanceCacheForShop(shop, orders.slice(0, 1), options);
    expect(result.operations).toEqual([]);
    expect(result.checkedPostingNumbers).toEqual([]);
    expect(result.errors[0].error.code).toBe('PROFIT_FINANCE_READ_INCOMPLETE');
  });
  it('never borrows completed batches from a different shop', async () => {
    api.getDomainCache.mockResolvedValue({ rows: [operation('current')], total: 1 });
    const result = await readLocalProfitFinanceCacheForShop(shop, orders.slice(0, 1), {
      ...options, previousReadback: { shopId: 'different-shop', checkedPostingNumbers: [orders[0].posting], operations: [operation('wrong-shop')] },
    });
    expect(result.operations.map((row) => row.operation_id)).toEqual(['current']);
    expect(api.getDomainCache).toHaveBeenCalledTimes(1);
  });
  it('does not mistake a partial parent/child lookup for complete order finance', () => {
    const context = buildLocalProfitFinanceHydrationContext(orders.slice(0, 1), [operation('parent', '98765432-0001')], {
      failedPostingNumbers: [orders[0].posting],
    });
    expect(context.matchedRowCount).toBe(0);
  });
  it('cancels the read without marking remaining batches empty or checked', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readLocalProfitFinanceCacheForShop(shop, orders, { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.getDomainCache).not.toHaveBeenCalled();
  });
});

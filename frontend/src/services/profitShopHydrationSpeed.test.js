import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getDomainCache: vi.fn(), readLiveProfitFinancePostings: vi.fn(), rates: vi.fn() }));
vi.mock('../api/localApiClient', async original => ({ ...(await original()), getDomainCache: mocks.getDomainCache,
  readLiveProfitFinancePostings: mocks.readLiveProfitFinancePostings }));
vi.mock('../entities/profit/profitExchangeRateCache.js', () => ({ readProfitMissingOnlyExchangeRateContext: mocks.rates }));
import { readLocalProfitFinanceContextsForShops } from '../entities/profit/profitAfterSalesRules.jsx';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const shops = [1, 2].map(n => ({ id: `shop-${n}`, clientId: `client-${n}`, apiKey: 'test', status: 'active' }));
const rows = shops.map((shop, i) => ({ id: `98765432-000${i + 1}-1`, posting: `98765432-000${i + 1}-1`,
  shopId: shop.id, shopClientId: shop.clientId, status: 'cancelled', paymentDate: '2026-05-01T00:00:00Z' }));
const rateContext = () => ({ dailyRates: new Map(), errors: [] });

describe('per-shop profit dependency latency', () => {
  it('overlaps exchange-rate/finance reads and publishes shop 1 while shop 2 is still pending', async () => {
    mocks.getDomainCache.mockResolvedValue({ rows: [], total: 0 });
    const gates = new Map(shops.map(shop => [shop.id, { rate: deferred(), remote: deferred(), keys: [] }]));
    mocks.rates.mockImplementation(input => gates.get(input[0].shopId).rate.promise);
    mocks.readLiveProfitFinancePostings.mockImplementation((owner, keys) => { gates.get(owner).keys = keys; return gates.get(owner).remote.promise; });
    const onShopContext = vi.fn(); let completed = false;
    const work = readLocalProfitFinanceContextsForShops(shops, rows, { verifyEmptyFinance: true, onShopContext }).then(result => { completed = true; return result; });
    await vi.waitFor(() => { expect(mocks.rates).toHaveBeenCalledTimes(2); expect(mocks.readLiveProfitFinancePostings).toHaveBeenCalledTimes(2); });
    const release = owner => { const gate = gates.get(owner); gate.rate.resolve(rateContext());
      gate.remote.resolve(new Map(gate.keys.map(key => [key, { ok: true, data: { result: { operations: [], row_count: 0, page_count: 0 } } }]))); };
    release('shop-1');
    await vi.waitFor(() => expect(onShopContext).toHaveBeenCalledTimes(1));
    expect(onShopContext.mock.calls[0][0].shop.id).toBe('shop-1');
    expect(completed).toBe(false);
    release('shop-2');
    expect((await work).byShopId.size).toBe(2);
  });
  it('reads newly discovered finance dates before publishing instead of skipping rate configuration', async () => {
    mocks.rates.mockReset(); mocks.readLiveProfitFinancePostings.mockReset();
    mocks.getDomainCache.mockResolvedValue({ rows: [], total: 0 });
    const extraRate = deferred();
    mocks.rates.mockResolvedValueOnce(rateContext()).mockImplementationOnce(() => extraRate.promise);
    mocks.readLiveProfitFinancePostings.mockImplementation(async (_owner, keys) => new Map(keys.map((key, i) => [key,
      { ok: true, data: { result: { operations: i ? [] : [{ operation_id: 'new-finance', posting_number: key,
        operation_type: 'OperationAgentDeliveredToCustomer', operation_date: '2026-08-15 00:00:00', amount: 10 }], row_count: i ? 0 : 1, page_count: i ? 0 : 1 } } }])));
    const onShopContext = vi.fn();
    const work = readLocalProfitFinanceContextsForShops(shops.slice(0, 1), rows.slice(0, 1), { verifyEmptyFinance: true, onShopContext });
    await vi.waitFor(() => expect(mocks.rates).toHaveBeenCalledTimes(2));
    expect(onShopContext).not.toHaveBeenCalled();
    extraRate.resolve(rateContext()); await work;
    expect(onShopContext).toHaveBeenCalledTimes(1);
  });
});

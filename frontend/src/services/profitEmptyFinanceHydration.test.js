import { describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ getDomainCache: vi.fn(), readLiveProfitFinancePosting: vi.fn(), readLiveProfitFinancePostings: vi.fn() }));
vi.mock('../api/localApiClient', async original => ({ ...(await original()), ...api }));
vi.mock('../entities/profit/profitExchangeRateCache.js', () => ({ readProfitMissingOnlyExchangeRateContext: async () => ({ dailyRates: new Map(), errors: [] }) }));
import { readLocalProfitFinanceContextsForShops } from '../entities/profit/profitAfterSalesRules.jsx';
const shop = { id: 'future-shop', clientId: 'future-client', apiKey: 'unit-test', status: 'active' };
const rows = ['98765432-0001-1','98765432-0002-1'].map(posting => ({ id: posting, posting, shopId: shop.id, shopClientId: shop.clientId, status: 'cancelled' }));
const empty = { result: { operations: [], row_count: 0, page_count: 0 } };

describe('empty-finance hydration and retry', () => {
  it('retries only the unverified order and keeps successful empty receipts independent', async () => {
    api.readLiveProfitFinancePostings.mockImplementation(async (owner, keys) => new Map(await Promise.all(keys.map(async key => {
      try { return [key, { ok: true, data: await api.readLiveProfitFinancePosting(owner, key) }]; }
      catch { return [key, { ok: false }]; }
    }))));
    api.getDomainCache.mockResolvedValue({ rows: [], total: 0 });
    api.readLiveProfitFinancePosting.mockImplementation(async (_shop, posting) => {
      if (posting === '98765432-0002') throw new Error('temporary timeout');
      return empty;
    });
    const partial = await readLocalProfitFinanceContextsForShops([shop], rows, { verifyEmptyFinance: true });
    expect(partial.errors).toHaveLength(1);
    expect(partial.matchedRowCount).toBe(1);
    expect(partial.byShopId.get(shop.id).emptyFinanceReceipts.size).toBe(1);
    api.readLiveProfitFinancePosting.mockClear();
    api.readLiveProfitFinancePosting.mockResolvedValue(empty);
    const complete = await readLocalProfitFinanceContextsForShops([shop], rows, { verifyEmptyFinance: true, previousContexts: partial });
    expect(complete.errors).toHaveLength(0);
    expect(complete.matchedRowCount).toBe(2);
    expect(api.readLiveProfitFinancePosting.mock.calls.map(call => call[1]).sort()).toEqual(['98765432-0002','98765432-0002-1']);
    const oldReceipt = complete.byShopId.get(shop.id).emptyFinanceReceipts.get(`${shop.id}:${rows[0].posting}`);
    oldReceipt.checkedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    api.readLiveProfitFinancePosting.mockClear();
    const renewed = await readLocalProfitFinanceContextsForShops([shop], rows, { verifyEmptyFinance: true, previousContexts: complete });
    expect(renewed.errors).toHaveLength(0);
    expect(api.readLiveProfitFinancePosting.mock.calls.map(call => call[1]).sort()).toEqual(['98765432-0001','98765432-0001-1']);
    const persisted = Object.fromEntries([...renewed.byShopId.get(shop.id).emptyFinanceReceipts]
      .map(([key, financeEmptyReceipt]) => [key, { financeEmptyReceipt }]));
    api.readLiveProfitFinancePosting.mockClear();
    api.readLiveProfitFinancePostings.mockClear();
    const reopened = await readLocalProfitFinanceContextsForShops([shop], rows, {
      verifyEmptyFinance: true, getCachedLedgerRows: () => persisted,
    });
    expect(reopened.matchedRowCount).toBe(2);
    expect(api.readLiveProfitFinancePostings).not.toHaveBeenCalled();
    expect(api.readLiveProfitFinancePosting).not.toHaveBeenCalled();
  });
});

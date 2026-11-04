import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEmptyFinancePostingKeys, isVerifiedEmptyFinanceReceipt, verifyEmptyFinanceAtOzon, EMPTY_FINANCE_RECEIPT_TTL_MS } from './profitEmptyFinanceEvidence.js';
import { buildLocalProfitFinanceHydrationContext } from '../entities/profit/profitAfterSalesRules.jsx';
import { normalizeOzonProfitOrder } from '../entities/profit/profitDisplayRules.jsx';
import { protectProfitLedgerFinanceInputs } from './profitFinanceReadbackGuard.js';
import { mergeProfitLedgerRows } from './profitLedgerService.js';
import { compactProfitLedgerSnapshotForPersistence } from './profitLedgerPersistenceCompaction.js';
import { readLiveProfitFinancePosting, readLiveProfitFinancePostings } from '../api/localApiClient.js';

const shop = { id: 'future-shop', clientId: 'future-client' };
const row = { id: '98765432-0001-1', posting: '98765432-0001-1', status: 'cancelled',
  shopId: shop.id, shopClientId: shop.clientId, currencyCode: 'CNY', amountValue: 20,
  raw: { cancellation: { cancelled_after_ship: false } }, products: [] };
const empty = () => ({ result: { operations: [], row_count: 0, page_count: 0 } });
async function receipt() { return (await verifyEmptyFinanceAtOzon(shop, row, { fetchPage: async () => empty() })).receipt; }

describe('official empty finance evidence', () => {
  afterEach(() => { delete window.wangzaiDesktop; });
  it('uses one licensed batch request and rejects a missing posting result', async () => {
    const keys = [row.posting, row.posting.replace(/-\d+$/, '')];
    const bridge = vi.fn(async () => ({ ok: true, data: { ok: true,
      data: { postingResults: keys.map(postingNumber => ({ postingNumber, ok: true, data: empty() })) } } }));
    window.wangzaiDesktop = { localApiRequest: bridge };
    expect((await readLiveProfitFinancePostings(shop.id, keys)).size).toBe(2);
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge.mock.calls[0][0].body).toMatchObject({ shopId: shop.id, postingNumbers: keys, access: 'read', forceRefresh: true, allowStale: false });
    bridge.mockResolvedValueOnce({ ok: true, data: { ok: true, data: { postingResults: [] } } });
    await expect(readLiveProfitFinancePostings(shop.id, keys)).rejects.toMatchObject({ code: 'FINANCE_VERIFY_NOT_COMPLETE' });
  });
  it('requires both exact and parent posting success and records a bounded owner-scoped receipt', async () => {
    const fetchPage = vi.fn(async () => empty());
    const verified = await verifyEmptyFinanceAtOzon(shop, row, { fetchPage });
    expect(fetchPage.mock.calls.map(call => call[1])).toEqual(['98765432-0001-1', '98765432-0001']);
    expect(isVerifiedEmptyFinanceReceipt(verified.receipt, row, { shop })).toBe(true);
    expect(isVerifiedEmptyFinanceReceipt(verified.receipt, row, { shop: { ...shop, id: 'other-shop' } })).toBe(false);
    expect(isVerifiedEmptyFinanceReceipt(verified.receipt, { ...row, posting: '98765432-0002-1' })).toBe(false);
    expect(isVerifiedEmptyFinanceReceipt(verified.receipt, row, { now: Date.now() + EMPTY_FINANCE_RECEIPT_TTL_MS + 100 })).toBe(false);
  });
  it.each([
    { result: { operations: [], row_count: 1, page_count: 1 } },
    { result: { operations: [], row_count: null, page_count: 0 } },
    { localApiCache: { source: 'sqlite' }, ...empty() },
    { ok: false, ...empty() },
  ])('never certifies missing/malformed/local-only data: %j', async response => {
    await expect(verifyEmptyFinanceAtOzon(shop, row, { fetchPage: async () => response })).rejects.toThrow();
  });
  it('does not certify zero if the parent request fails or new transactions appear', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(empty()).mockRejectedValueOnce(new Error('timeout'));
    await expect(verifyEmptyFinanceAtOzon(shop, row, { fetchPage })).rejects.toThrow('timeout');
    const nonempty = await verifyEmptyFinanceAtOzon(shop, row, { fetchPage: async (_s, posting) => posting === row.posting ? empty() : {
      result: { operations: [{ operation_id: 1, posting: { posting_number: posting }, amount: -2 }], row_count: 1, page_count: 1 },
    } });
    expect(nonempty.receipt).toBeNull();
    expect(nonempty.operations).toHaveLength(1);
    expect(isVerifiedEmptyFinanceReceipt(await receipt(), { ...row, profitLedger: { financeOperationCount: 1 } })).toBe(false);
  });
  it('does not mark empty local reads checked, but accepts a valid official empty receipt for closed orders', async () => {
    const key = `${shop.id}:${row.posting}`;
    expect(buildLocalProfitFinanceHydrationContext([row], []).matchedRowCount).toBe(0);
    const proof = await receipt();
    const context = buildLocalProfitFinanceHydrationContext([row], [], { shop, emptyFinanceReceipts: new Map([[key, proof]]) });
    expect(context.matchedRowCount).toBe(1);
    expect(context.financeLookupCheckedIndex.get(row.posting)).toBe(true);
    expect(buildLocalProfitFinanceHydrationContext([{ ...row, status: 'awaiting_packaging' }], [],
      { shop, emptyFinanceReceipts: new Map([[key, proof]]) }).matchedRowCount).toBe(0);
  });
  it('uses the unchanged formula: no trade/cost is zero, while real cost and bus charge remain losses', async () => {
    const proof = await receipt();
    const context = buildLocalProfitFinanceHydrationContext([row], [], {
      shop, emptyFinanceReceipts: new Map([[`${shop.id}:${row.posting}`, proof]]) });
    const zero = normalizeOzonProfitOrder(row, context).profitLedger;
    const checked = protectProfitLedgerFinanceInputs(null, zero, { financeReadbackComplete: true, verifiedEmptyReceipt: proof });
    expect(checked.financeReadbackState).toBe('empty-confirmed');
    expect(checked.results.actualProfitCny.value).toBe(0);
    const charged = { ...zero, amounts: { ...zero.amounts,
      sourcePurchaseCostCny: { value: 5, status: 'ready', source: 'purchase-override' },
      actualCrossBorderBusFeeCny: { value: 1.13, status: 'ready', source: 'cross-border-bus-ledger-cash-converted' },
    } };
    const merged = mergeProfitLedgerRows([charged], [checked])[0];
    expect(merged.results.actualProfitCny.value).toBeCloseTo(-6.13);
    expect(compactProfitLedgerSnapshotForPersistence({ rows: [checked] }).rows[0].financeEmptyReceipt).toEqual(proof);
  });
  it('uses the authenticated explicit remote route with refresh and no stale/local cache shortcut', async () => {
    const bridge = vi.fn(async () => ({ ok: true, data: { ok: true, schedulerResult: { status: 'success' }, data: empty() } }));
    window.wangzaiDesktop = { localApiRequest: bridge };
    expect(await readLiveProfitFinancePosting(shop.id, row.posting)).toEqual(empty());
    expect(bridge.mock.calls[0][0]).toMatchObject({ path: '/api/ozon/request', method: 'POST',
      body: { shopId: shop.id, forceRefresh: true, allowStale: false, access: 'read', endpointKey: 'finance.transactionList' } });
    const date = bridge.mock.calls[0][0].body.params.filter.date;
    expect(Date.parse(date.to) - Date.parse(date.from)).toBeLessThan(24 * 60 * 60 * 1000);
    bridge.mockResolvedValueOnce({ ok: true, data: { ok: true, schedulerResult: { status: 'cache_hit' }, data: empty() } });
    await expect(readLiveProfitFinancePosting(shop.id, row.posting)).rejects.toMatchObject({ code: 'FINANCE_VERIFY_NOT_COMPLETE' });
  });
  it('does not query without a usable posting or after cancellation', async () => {
    expect(getEmptyFinancePostingKeys({ posting: '' })).toEqual([]);
    const controller = new AbortController(); controller.abort();
    const fetchPage = vi.fn();
    await expect(verifyEmptyFinanceAtOzon(shop, row, { fetchPage, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

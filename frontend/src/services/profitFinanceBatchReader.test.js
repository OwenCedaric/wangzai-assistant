import { describe, expect, it, vi } from 'vitest';
import { createProfitFinanceBatchReader } from './profitFinanceBatchReader.js';
import { verifyEmptyFinanceAtOzon } from './profitEmptyFinanceEvidence.js';
const empty = { result: { operations: [], row_count: 0, page_count: 0 } };
const shop = { id: 'shop-one', clientId: '10001' };
const orders = Array.from({ length: 5 }, (_, index) => ({ posting: `98765432-${String(index + 1).padStart(4, '0')}-1` }));
const keys = orders.flatMap(order => [order.posting, order.posting.replace(/-\d+$/, '')]);

describe('same-owner finance first-page batching', () => {
  it('confirms all ten parent/child lookups through one round trip with identical evidence', async () => {
    const readBatch = vi.fn(async (_owner, list) => new Map(list.map(key => [key, { ok: true, data: empty }])));
    const reader = createProfitFinanceBatchReader(shop.id, keys, { readBatch, readPage: vi.fn() });
    const results = await Promise.all(orders.map(order => verifyEmptyFinanceAtOzon(shop, order, { fetchPage: reader })));
    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(readBatch.mock.calls[0][1]).toEqual(keys);
    expect(results.every(result => result.receipt.operationCount === 0)).toBe(true);
    expect(results.flatMap(result => result.receipt.postingNumbers).sort()).toEqual([...keys].sort());
  });
  it('fails only the affected receipt and never fabricates zero for a failed parent', async () => {
    const readBatch = vi.fn(async (_owner, list) => new Map(list.map(key => [key, { ok: key !== keys[1], data: empty }])));
    const reader = createProfitFinanceBatchReader(shop.id, keys, { readBatch });
    const results = await Promise.allSettled(orders.map(order => verifyEmptyFinanceAtOzon(shop, order, { fetchPage: reader })));
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(4);
    await expect(reader('other-shop', keys[0])).rejects.toThrow('FINANCE_BATCH_OWNER_MISMATCH');
  });
  it('does not truncate additional pages or combine different shop requests', async () => {
    const readPage = vi.fn(async () => ({ secondPage: true }));
    const reader = createProfitFinanceBatchReader(shop.id, keys, { readBatch: vi.fn(), readPage });
    expect(await reader(shop.id, keys[0], 2)).toEqual({ secondPage: true });
    expect(readPage.mock.calls[0].slice(0, 3)).toEqual([shop.id, keys[0], 2]);
  });
});

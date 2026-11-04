import { describe, expect, it } from 'vitest';
import { splitProfitFinanceReadBatches } from './profitFinanceReadBatches.js';
import { areProfitFinanceContextsEqual } from './profitFinanceHydrationRules.js';

describe('bounded local finance read batches', () => {
  it('retains all identifiers in order with fewer default batches', () => {
    const keys = Array.from({ length: 1244 }, (_, i) => `98765432-${String(i).padStart(4, '0')}-1`);
    const batches = splitProfitFinanceReadBatches(keys);
    expect(batches).toHaveLength(5);
    expect(batches.flat()).toEqual(keys);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(250);
      expect(new URLSearchParams({ postingNumbers: batch.join(',') }).toString().length).toBeLessThanOrEqual(6000);
    }
  });
  it('bounds encoded URLs even for long opaque/unicode identifiers without truncation', () => {
    const keys = Array.from({ length: 300 }, (_, i) => `店铺:${i}:${'x'.repeat(45)}`);
    const batches = splitProfitFinanceReadBatches(keys);
    expect(batches.flat()).toEqual(keys);
    expect(batches.every(batch => new URLSearchParams({ postingNumbers: batch.join(',') }).toString().length <= 6000)).toBe(true);
    expect(splitProfitFinanceReadBatches(['one', 'two'], { maxCount: 1 })).toEqual([['one'], ['two']]);
    expect(() => splitProfitFinanceReadBatches(['x'.repeat(7000)])).toThrow('PROFIT_FINANCE_POSTING_TOO_LONG');
  });
});

describe('identical shop-context publication', () => {
  const one = { shop: { id: 'one' }, amount: 1 }, two = { shop: { id: 'two' }, amount: 2 };
  const context = () => ({ byShopId: new Map([['one', one], ['two', two]]), byClientId: new Map([['1', one], ['2', two]]), matchedRowCount: 10, errors: [] });
  it('avoids recalculating the final aggregate when all per-shop data was already published', () => {
    expect(areProfitFinanceContextsEqual({ ...context(), partial: true }, context())).toBe(true);
  });
  it('still recalculates changed data, errors, keys and counts', () => {
    const original = context();
    const changed = context(); changed.byShopId.set('one', { ...one, amount: 3 });
    expect(areProfitFinanceContextsEqual(original, changed)).toBe(false);
    expect(areProfitFinanceContextsEqual(original, { ...context(), errors: [new Error('read failed')] })).toBe(false);
    expect(areProfitFinanceContextsEqual(original, { ...context(), matchedRowCount: 11 })).toBe(false);
    const renamed = context(); renamed.byClientId.delete('1'); renamed.byClientId.set('new', one);
    expect(areProfitFinanceContextsEqual(original, renamed)).toBe(false);
  });
});

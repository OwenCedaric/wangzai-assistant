import { describe, expect, it, vi } from 'vitest';
import { createProfitShopCalculationLanes, runProfitShopCalculationLanes, selectChangedProfitShopLanes } from './profitShopCalculationLanes.js';

const rows = ['1a', '2a', '3a', '1b', '2b', '3b'].map((id, index) => ({ id, shopId: `shop-${index % 3 + 1}` }));

describe('profit shop calculation lanes', () => {
  it('awaits bounded remote batches without publishing promises or crossing shop lanes', async () => {
    const calls = [];
    const result = await runProfitShopCalculationLanes(rows, null, {
      chunkSize: 2,
      calculateBatch: async (batch, meta) => {
        calls.push(meta);
        expect(batch.every(row => row.shopId === meta.shopId)).toBe(true);
        return batch.map(row => ({ ...row, amount: 123 }));
      },
    });
    expect(calls).toHaveLength(3);
    expect(result.settled.every(lane => lane.status === 'fulfilled')).toBe(true);
    expect(result.settled.flatMap(lane => lane.rows).sort((a, b) => a.index - b.index).map(item => item.row.id)).toEqual(rows.map(row => row.id));
  });
  it('rejects partial remote results and ignores responses arriving after cancellation', async () => {
    const complete = vi.fn();
    const bad = await runProfitShopCalculationLanes(rows, null, { calculateBatch: async () => [], onShopComplete: complete });
    expect(bad.settled.every(lane => lane.status === 'rejected')).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    const controller = new AbortController();
    const cancelled = await runProfitShopCalculationLanes(rows, null, {
      signal: controller.signal, onShopComplete: complete,
      calculateBatch: async batch => { controller.abort(); return batch; },
    });
    expect(cancelled.settled.every(lane => lane.status === 'cancelled')).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });
  it('shares an optional time budget across shop lanes without changing row results', async () => {
    let now = 0;
    const yieldThread = vi.fn(async () => {});
    const result = await runProfitShopCalculationLanes(rows, row => { now += 3; return { ...row, sameAmount: 100 }; }, {
      chunkSize: 40, timeBudgetMs: 5, clock: () => now, yieldThread,
    });
    expect(yieldThread).toHaveBeenCalled();
    expect(result.settled.flatMap(lane => lane.rows).sort((a, b) => a.index - b.index).map(item => item.row))
      .toEqual(rows.map(row => ({ ...row, sameAmount: 100 })));
  });

  it('preserves the original row-boundary yield while adding the elapsed-time guard', async () => {
    const yieldThread = vi.fn(async () => {});
    const result = await runProfitShopCalculationLanes(rows, row => row, {
      chunkSize: 1, timeBudgetMs: 8, clock: () => 0, yieldThread,
    });
    expect(yieldThread).toHaveBeenCalledTimes(3);
    expect(result.settled.every(lane => lane.status === 'fulfilled')).toBe(true);
  });
  it('keeps each shop in its own ordered lane without losing the original row position', () => {
    expect(createProfitShopCalculationLanes(rows, ['shop-1', 'shop-2', 'shop-3']))
      .toEqual([
        { shopId: 'shop-1', items: [{ index: 0, row: rows[0] }, { index: 3, row: rows[3] }] },
        { shopId: 'shop-2', items: [{ index: 1, row: rows[1] }, { index: 4, row: rows[4] }] },
        { shopId: 'shop-3', items: [{ index: 2, row: rows[2] }, { index: 5, row: rows[5] }] },
      ]);
  });

  it('runs all shop lanes independently and yields between batches', async () => {
    const completed = [], yields = [];
    const result = await runProfitShopCalculationLanes(rows, row => ({ ...row, calculated: true }), {
      chunkSize: 1,
      yieldThread: async shopId => { yields.push(shopId); },
      onShopComplete: lane => completed.push(lane.shopId),
    });
    expect(result.settled.every(lane => lane.status === 'fulfilled')).toBe(true);
    expect(completed.sort()).toEqual(['shop-1', 'shop-2', 'shop-3']);
    expect(yields.sort()).toEqual(['shop-1', 'shop-2', 'shop-3']);
    expect(result.settled.flatMap(lane => lane.rows).sort((a, b) => a.index - b.index).map(item => item.row.id))
      .toEqual(rows.map(row => row.id));
  });

  it('recalculates only the shop whose input signature changed', () => {
    const lanes = createProfitShopCalculationLanes(rows);
    const signatures = new Map([['shop-1', 'a'], ['shop-2', 'b2'], ['shop-3', 'c']]);
    const cache = new Map([['shop-1', { signature: 'a' }], ['shop-2', { signature: 'b1' }],
      ['shop-3', { signature: 'c' }]]);
    expect(selectChangedProfitShopLanes(lanes, signatures, cache).map(lane => lane.shopId)).toEqual(['shop-2']);
  });

  it('one failed shop does not block the other two shops', async () => {
    const complete = vi.fn(), failed = vi.fn();
    const result = await runProfitShopCalculationLanes(rows, row => {
      if (row.shopId === 'shop-2') throw new Error('shop 2 calculation failed');
      return row;
    }, { chunkSize: 1, yieldThread: async () => undefined, onShopComplete: complete, onShopError: failed });
    expect(result.settled.map(lane => [lane.shopId, lane.status])).toEqual([
      ['shop-1', 'fulfilled'], ['shop-2', 'rejected'], ['shop-3', 'fulfilled'],
    ]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('cancels stale generations without publishing another shop result', async () => {
    const controller = new AbortController();
    const completed = vi.fn();
    const result = await runProfitShopCalculationLanes(rows, row => row, {
      chunkSize: 1, signal: controller.signal,
      yieldThread: async () => controller.abort(), onShopComplete: completed,
    });
    expect(result.settled.every(lane => lane.status === 'cancelled')).toBe(true);
    expect(completed).not.toHaveBeenCalled();
  });
});

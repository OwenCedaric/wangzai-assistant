import { afterEach, describe, expect, it, vi } from 'vitest';
import { startProfitFinanceHydration } from './profitFinanceHydrationRules.js';

describe('profit finance failed-only automatic readback', () => {
  afterEach(() => vi.useRealTimers());
  it('publishes a completed shop before a slow shop and ignores late callbacks after cancellation', async () => {
    let options, finish;
    const onValue = vi.fn();
    const stop = startProfitFinanceHydration({ read: value => { options = value; return new Promise(resolve => { finish = resolve; }); }, onValue });
    const fast = { shop: { id: 'shop-1', clientId: '10001' }, matchedRowCount: 292, errors: [] };
    options.onShopContext(fast);
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue.mock.calls[0][0].partial).toBe(true);
    expect(onValue.mock.calls[0][0].byShopId.get('shop-1')).toBe(fast);
    stop();
    options.onShopContext({ shop: { id: 'late-shop' }, errors: [] });
    finish({ byShopId: new Map(), byClientId: new Map(), errors: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(onValue).toHaveBeenCalledTimes(1);
  });
  it('automatically resumes failed reads and partial batches, then stops after complete readback', async () => {
    vi.useFakeTimers();
    const partial = { errors: [new Error('one batch failed')], byShopId: new Map([['future-shop', { completed: 1 }]]) };
    const complete = { errors: [], byShopId: new Map([['future-shop', { completed: 2 }]]) };
    const read = vi.fn().mockRejectedValueOnce(new Error('local API starting'))
      .mockResolvedValueOnce(partial).mockResolvedValueOnce(complete);
    const onValue = vi.fn(), onError = vi.fn();
    const stop = startProfitFinanceHydration({ read, onValue, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onValue).toHaveBeenLastCalledWith(partial);
    await vi.advanceTimersByTimeAsync(3000);
    expect(read.mock.calls[2][0].previousContexts).toBe(partial);
    expect(onValue).toHaveBeenLastCalledWith(complete);
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(3);
    stop();
  });
  it('cancels outstanding reads on scope change and never lets an old response overwrite the new scope', async () => {
    vi.useFakeTimers();
    let resolveOld;
    let oldSignal;
    const onValue = vi.fn();
    const stopOld = startProfitFinanceHydration({
      read: ({ signal }) => { oldSignal = signal; return new Promise((resolve) => { resolveOld = resolve; }); }, onValue,
    });
    stopOld();
    expect(oldSignal.aborted).toBe(true);
    const current = { errors: [], byShopId: new Map([['new-shop', {}]]) };
    const stopNew = startProfitFinanceHydration({ read: async () => current, onValue });
    await vi.advanceTimersByTimeAsync(0);
    resolveOld({ errors: [], byShopId: new Map([['old-shop', {}]]) });
    await vi.advanceTimersByTimeAsync(60000);
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue).toHaveBeenCalledWith(current);
    stopNew();
  });
  it('keeps only one read in flight and cancels scheduled retries when leaving the page', async () => {
    vi.useFakeTimers();
    let reject;
    const read = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    const stop = startProfitFinanceHydration({ read, onValue: vi.fn() });
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(1);
    reject(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

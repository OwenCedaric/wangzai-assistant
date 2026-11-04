import { describe, expect, it, vi } from 'vitest';
import {
  buildProductHotCacheScopes,
  startProductListHotCacheRuntime,
  warmProductListHotCacheFromSqlite,
} from './productListHotCacheRuntime.js';

function shop(id) {
  return { id, shopAlias: id, generationId: `generation-${id}` };
}

describe('productListHotCacheRuntime', () => {
  it('warms every exact shop plus the combined multi-shop first page from SQLite', async () => {
    const shops = [shop('shop-a'), shop('shop-b'), shop('shop-a')];
    let activeReads = 0;
    let maxActiveReads = 0;
    const readPage = vi.fn(async (scope) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      activeReads -= 1;
      return {
        rows: [{ productId: `${scope[0].id}-product` }],
        total: 1,
        counts: { ALL: 1 },
      };
    });
    const writePage = vi.fn();

    const result = await warmProductListHotCacheFromSqlite(shops, { readPage, writePage });

    expect(buildProductHotCacheScopes(shops)).toHaveLength(3);
    expect(result).toMatchObject({ ok: true, warmed: 3, failed: 0 });
    expect(readPage).toHaveBeenCalledTimes(3);
    expect(maxActiveReads).toBe(1);
    expect(readPage.mock.calls.filter(([scope]) => scope.length === 1).every(([, , options]) => options.timeoutMs === 15_000)).toBe(true);
    expect(readPage.mock.calls.find(([scope]) => scope.length > 1)?.[2]?.timeoutMs).toBe(15_000);
    expect(writePage).toHaveBeenCalledTimes(3);
    expect(writePage.mock.calls.every(([, , meta]) => meta.source === 'sqlite-startup-hot-cache')).toBe(true);
  });

  it('runs immediately, repeats on the local hot-cache interval and never overlaps itself', async () => {
    let intervalCallback = null;
    let resolveWarm;
    const warm = vi.fn(() => new Promise((resolve) => {
      resolveWarm = resolve;
    }));
    const clearIntervalImpl = vi.fn();
    const stop = startProductListHotCacheRuntime({
      shops: [shop('shop-a')],
      warm,
      initialDelayMs: 0,
      setIntervalImpl(callback) {
        intervalCallback = callback;
        return 7;
      },
      clearIntervalImpl,
    });

    expect(warm).toHaveBeenCalledTimes(1);
    intervalCallback();
    expect(warm).toHaveBeenCalledTimes(1);
    resolveWarm({ ok: true, warmed: 1, failed: 0 });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    intervalCallback();
    expect(warm).toHaveBeenCalledTimes(2);

    stop();
    expect(clearIntervalImpl).toHaveBeenCalledWith(7);
  });

  it('waits for local-api startup before the first background warm', async () => {
    let startupCallback = null;
    const warm = vi.fn(async () => ({ ok: true, warmed: 1, failed: 0 }));
    const clearTimeoutImpl = vi.fn();
    const stop = startProductListHotCacheRuntime({
      shops: [shop('shop-a')],
      warm,
      setTimeoutImpl(callback, delayMs) {
        startupCallback = callback;
        expect(delayMs).toBe(12_000);
        return 9;
      },
      clearTimeoutImpl,
      setIntervalImpl: () => 7,
      clearIntervalImpl: vi.fn(),
    });

    expect(warm).not.toHaveBeenCalled();
    startupCallback();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(warm).toHaveBeenCalledTimes(1);
    stop();
    expect(clearTimeoutImpl).toHaveBeenCalledWith(9);
  });
});

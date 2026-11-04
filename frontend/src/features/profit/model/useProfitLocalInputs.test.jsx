import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProfitLocalInputs } from './useProfitLocalInputs.js';

afterEach(cleanup);
const shops = [{ id: 'shop-1' }];
const initial = { purchaseLocalOverrides: { cost: 10 }, productSourceLinks: {} };
const fresh = { purchaseLocalOverrides: { cost: 55 }, productSourceLinks: {} };
const flush = () => act(async () => { await Promise.resolve(); });

describe('profit local input revision acknowledgement', () => {
  it('retries an interrupted committed-fee read when returning to the tab', async () => {
    let release;
    const hydrate = vi.fn().mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue(fresh);
    const { result, rerender } = renderHook(props => useProfitLocalInputs({ ...props, readableShops: shops, sourceKey: 'shops', hydrate }),
      { initialProps: { isActive: true, refreshTick: 0 } });
    await flush();
    expect(result.current.inputs).toEqual(initial);
    rerender({ isActive: true, refreshTick: 1 });
    rerender({ isActive: false, refreshTick: 1 });
    await act(async () => { release(fresh); await Promise.resolve(); });
    expect(result.current.inputs).toEqual(initial);
    rerender({ isActive: true, refreshTick: 1 });
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(result.current.inputs).toEqual(fresh);
    rerender({ isActive: false, refreshTick: 1 });
    rerender({ isActive: true, refreshTick: 1 });
    expect(hydrate).toHaveBeenCalledTimes(3);
  });

  it('retains old data and exposes a working retry after a read fails', async () => {
    const hydrate = vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error('synthetic timeout')).mockResolvedValue(fresh);
    const { result, rerender } = renderHook(props => useProfitLocalInputs({ ...props, readableShops: shops, sourceKey: 'shops', hydrate }),
      { initialProps: { isActive: true, refreshTick: 0 } });
    await flush();
    rerender({ isActive: true, refreshTick: 1 });
    await flush();
    expect(result.current.inputs).toEqual(initial);
    expect(result.current.error).toContain('重试');
    act(() => result.current.retry());
    await flush();
    expect(result.current.inputs).toEqual(fresh);
    expect(result.current.error).toBe('');
  });
});

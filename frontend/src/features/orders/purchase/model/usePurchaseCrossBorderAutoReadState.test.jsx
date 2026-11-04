import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePurchaseCrossBorderAutoReadState } from './usePurchaseCrossBorderAutoReadState.jsx';

afterEach(() => vi.useRealTimers());

describe('purchase cross-border background singleflight', () => {
  it('ten interval ticks never overlap one still-running batch', async () => {
    vi.useFakeTimers();
    let release;
    const readCrossBorderForOrder = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    renderHook(() => usePurchaseCrossBorderAutoReadState({
      enabled: true,
      purchaseOrders: [{
        id: 'order-1',
        purchaseOrderNo: 'PDD-ORDER-1',
        purchaseOrderNumber: 'PDD-ORDER-1',
        purchasePlatform: '拼多多',
        status: '已拍单-待发货',
      }],
      readCrossBorderForOrder,
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(readCrossBorderForOrder).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 10; index += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60 * 1000); });
    }
    expect(readCrossBorderForOrder).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ orderId: 'bus-order-1' });
      await Promise.resolve();
    });
  });
});

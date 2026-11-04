import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readDashboardBusinessShareSnapshot: vi.fn() }));

vi.mock('../services/dashboardBusinessShareService.js', () => ({
  readDashboardBusinessShareSnapshot: mocks.readDashboardBusinessShareSnapshot,
}));

import { useDashboardBusinessShare } from './useDashboardBusinessShare.js';

const shopA = { id: 'shop-a', clientId: 'client-a', hasApiKey: true };
const shopB = { id: 'shop-b', clientId: 'client-b', hasApiKey: true };

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.clearAllMocks());

describe('useDashboardBusinessShare', () => {
  it('does not start or apply an aggregate read while the dashboard is inactive', async () => {
    mocks.readDashboardBusinessShareSnapshot.mockResolvedValue({ salesOrderCount: 3 });
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useDashboardBusinessShare({ shops: [shopA], enabled }),
      { initialProps: { enabled: false } }
    );

    expect(mocks.readDashboardBusinessShareSnapshot).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(mocks.readDashboardBusinessShareSnapshot).toHaveBeenCalledTimes(1));
    unmount();
  });

  it('does not read SQLite when no readable shop exists', () => {
    const emptyShops = [];
    const { result, unmount } = renderHook(() => useDashboardBusinessShare({ shops: emptyShops }));
    expect(result.current.status).toBe('empty');
    expect(result.current.counts).toEqual({
      salesOrderCount: 0,
      pendingPurchaseCount: 0,
      afterSalesTodoCount: 0,
      stockWarningCount: 0,
    });
    expect(mocks.readDashboardBusinessShareSnapshot).not.toHaveBeenCalled();
    unmount();
  });

  it('ignores a stale shop response and keeps the latest scoped aggregate', async () => {
    const first = createDeferred();
    const second = createDeferred();
    mocks.readDashboardBusinessShareSnapshot
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result, rerender, unmount } = renderHook(
      ({ shops }) => useDashboardBusinessShare({ shops }),
      { initialProps: { shops: [shopA] } }
    );
    await waitFor(() => expect(mocks.readDashboardBusinessShareSnapshot).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.readDashboardBusinessShareSnapshot.mock.calls[0][1].signal;

    rerender({ shops: [shopB] });
    await waitFor(() => expect(mocks.readDashboardBusinessShareSnapshot).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    expect(result.current).toMatchObject({ scopeKey: 'shop-b', status: 'loading' });

    await act(async () => {
      second.resolve({ salesOrderCount: 4, pendingPurchaseCount: 1, afterSalesTodoCount: 0, stockWarningCount: 2 });
      await second.promise;
    });
    await waitFor(() => expect(result.current.status).toBe('data'));
    expect(result.current.counts.salesOrderCount).toBe(4);

    await act(async () => {
      first.resolve({ salesOrderCount: 99, pendingPurchaseCount: 99, afterSalesTodoCount: 99, stockWarningCount: 99 });
      await first.promise;
    });
    expect(result.current).toMatchObject({ scopeKey: 'shop-b', status: 'data' });
    expect(result.current.counts.salesOrderCount).toBe(4);
    unmount();
  });

  it('surfaces a read failure and aborts the previous request on refresh', async () => {
    const first = createDeferred();
    mocks.readDashboardBusinessShareSnapshot
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('fixture read failed'));

    const shops = [shopA];
    const { result, rerender, unmount } = renderHook(
      ({ refreshToken }) => useDashboardBusinessShare({ shops, refreshToken }),
      { initialProps: { refreshToken: 0 } }
    );
    await waitFor(() => expect(mocks.readDashboardBusinessShareSnapshot).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.readDashboardBusinessShareSnapshot.mock.calls[0][1].signal;
    rerender({ refreshToken: 1 });
    await waitFor(() => expect(mocks.readDashboardBusinessShareSnapshot).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toHaveProperty('message', 'fixture read failed');

    await act(async () => {
      first.resolve({ salesOrderCount: 10 });
      await first.promise;
    });
    expect(result.current.status).toBe('error');
    unmount();
  });
});

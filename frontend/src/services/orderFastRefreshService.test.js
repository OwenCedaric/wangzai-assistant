import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncMocks = vi.hoisted(() => ({
  startDomainRefresh: vi.fn(),
  getJobStatus: vi.fn(),
}));

vi.mock('./ozonSyncClient.js', () => syncMocks);

import {
  createFastOrderRefreshRange,
  createFastOrderRefreshTasks,
  createFastReturnsRefreshTasks,
  refreshOrderCacheFast,
} from './orderFastRefreshService.js';
import { OZON_PUSH_REALTIME_BROWSER_EVENT } from './ozonPushRealtime.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fast order refresh service', () => {
  it('limits foreground order refresh to the recent delta and skips the redundant unfulfilled endpoint', () => {
    const range = createFastOrderRefreshRange(
      { since: '2026-01-01T00:00:00.000Z', to: '2026-08-28T12:00:00.000Z' },
      { overlapHours: 72 },
    );
    expect(range).toEqual({
      since: '2026-08-25T12:00:00.000Z',
      to: '2026-08-28T12:00:00.000Z',
    });
    const tasks = createFastOrderRefreshTasks([{ id: 'shop-1' }], range);
    expect(tasks.map((task) => task.endpointKey)).toEqual(['orders.fbsList', 'orders.fboList']);
    expect(tasks.some((task) => task.endpointKey === 'orders.fbsUnfulfilledList')).toBe(false);
  });

  it('submits all shops through the bounded fast profile and finishes as soon as jobs merge', async () => {
    syncMocks.startDomainRefresh
      .mockResolvedValueOnce({ accepted: true, jobId: 'job-1' })
      .mockResolvedValueOnce({ accepted: true, jobId: 'job-2' });
    syncMocks.getJobStatus.mockImplementation(async (jobId) => ({
      job: { jobId, status: 'success' },
    }));
    const progress = vi.fn();
    const refreshEvents = [];
    const handleRefresh = (event) => refreshEvents.push(event.detail);
    window.addEventListener(OZON_PUSH_REALTIME_BROWSER_EVENT, handleRefresh);
    const result = await refreshOrderCacheFast(
      [{ id: 'shop-1' }],
      { since: '2026-01-01T00:00:00.000Z', to: '2026-08-28T12:00:00.000Z' },
      { onProgress: progress, foregroundWaitMs: 1_000 },
    );

    expect(result).toMatchObject({ ok: true, completed: 2, total: 2, pending: 0 });
    expect(syncMocks.startDomainRefresh).toHaveBeenCalledTimes(2);
    expect(syncMocks.startDomainRefresh.mock.calls[0][1]).toMatchObject({
      pageSize: 100,
      maxPages: 5,
      priority: 'P1',
      profile: 'foreground',
      forceRefresh: true,
    });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ running: false, completed: 2 }));
    expect(refreshEvents).toHaveLength(2);
    expect(refreshEvents.every((event) => event.domain === 'orders' && event.shopId === 'shop-1')).toBe(true);
    window.removeEventListener(OZON_PUSH_REALTIME_BROWSER_EVENT, handleRefresh);
  });

  it('merges the three current after-sales sources while detail hydration stays in the background job', () => {
    const tasks = createFastReturnsRefreshTasks([{ id: 'shop-1' }], {
      since: '2026-01-01T00:00:00.000Z',
      to: '2026-08-28T12:00:00.000Z',
    });
    expect(tasks.map((task) => task.endpointKey)).toEqual([
      'returns.list',
      'returns.rfbsList',
      'returns.conditionalCancellationList',
    ]);
    expect(tasks.find((task) => task.endpointKey === 'returns.rfbsList')?.enrichRfbsDetails).toBe(true);
  });
});


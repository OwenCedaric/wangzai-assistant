import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({ getSyncState: vi.fn() }));
vi.mock('../../api/localApiClient.js', () => apiMocks);

import {
  isCanonicalOrderSyncState,
  OrderSyncRealtimeBridge,
  shouldPublishOrderSyncState,
} from './OrderSyncRealtimeBridge.jsx';
import { OZON_PUSH_REALTIME_BROWSER_EVENT } from '../../services/ozonPushRealtime.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrderSyncRealtimeBridge', () => {
  it('rejects per-return detail states and timestamp-only parent updates', () => {
    expect(isCanonicalOrderSyncState({
      domain: 'returns',
      scopeKey: 'returns:shop-1:returns.rfbsGet:return:103122467',
    }, 'returns')).toBe(false);
    expect(isCanonicalOrderSyncState({
      domain: 'returns',
      scopeKey: 'returns:returns.rfbsList',
    }, 'returns')).toBe(true);
    expect(shouldPublishOrderSyncState(
      { status: 'running', changedCount: 0 },
      { status: 'running', changedCount: 0, updatedAt: 'later' },
    )).toBe(false);
    expect(shouldPublishOrderSyncState(
      { status: 'running', changedCount: 0 },
      { status: 'running', changedCount: 1 },
    )).toBe(true);
  });

  it('wakes every order consumer when durable SQLite sync state advances', async () => {
    let orderRead = 0;
    apiMocks.getSyncState.mockImplementation(async (domain) => {
      if (domain !== 'orders') return { states: [] };
      orderRead += 1;
      return {
        states: [{
          id: 'state-orders-fbs',
          domain: 'orders',
          shopId: 'shop-1',
          scopeKey: 'orders:orders.fbsList',
          status: orderRead === 1 ? 'success' : 'running',
          changedCount: orderRead === 1 ? 0 : 1,
          unchangedCount: 0,
          lastAttemptAt: orderRead === 1 ? '2026-08-28T10:00:00.000Z' : '2026-08-28T10:01:00.000Z',
          updatedAt: orderRead === 1 ? '2026-08-28T10:00:00.000Z' : '2026-08-28T10:01:00.000Z',
        }],
      };
    });
    const onEvent = vi.fn();
    const browserEvent = vi.fn();
    window.addEventListener(OZON_PUSH_REALTIME_BROWSER_EVENT, browserEvent);
    render(<OrderSyncRealtimeBridge shops={[{ id: 'shop-1' }]} onEvent={onEvent} />);
    await act(async () => { await Promise.resolve(); });
    expect(onEvent).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await Promise.resolve(); });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      stage: 'refreshed',
      domain: 'orders',
      shopId: 'shop-1',
      status: 'running',
      changedCount: 1,
    });
    expect(browserEvent).toHaveBeenCalledTimes(1);
    window.removeEventListener(OZON_PUSH_REALTIME_BROWSER_EVENT, browserEvent);
  });

  it('does not wake the page for an rFBS detail completion storm', async () => {
    let readCount = 0;
    apiMocks.getSyncState.mockImplementation(async (domain) => {
      if (domain !== 'returns') return { states: [] };
      readCount += 1;
      return {
        states: [{
          id: `detail-${readCount}`,
          domain: 'returns',
          shopId: 'shop-1',
          scopeKey: `returns:shop-1:returns.rfbsGet:return:${1000 + readCount}`,
          status: 'success',
          changedCount: 1,
          updatedAt: `2026-08-29T06:09:${String(readCount).padStart(2, '0')}.000Z`,
        }],
      };
    });
    const onEvent = vi.fn();
    render(<OrderSyncRealtimeBridge shops={[{ id: 'shop-1' }]} onEvent={onEvent} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(onEvent).not.toHaveBeenCalled();
  });
});


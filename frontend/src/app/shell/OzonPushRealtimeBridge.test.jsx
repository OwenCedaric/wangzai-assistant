import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const waitForRealtime = vi.hoisted(() => vi.fn());
vi.mock('../../api/localApiClient.js', () => ({
  waitForOzonPushRealtimeEvent: waitForRealtime,
}));

import {
  OZON_PUSH_REALTIME_BROWSER_EVENT,
  OzonPushRealtimeBridge,
} from './OzonPushRealtimeBridge.jsx';

describe('OzonPushRealtimeBridge', () => {
  beforeEach(() => {
    waitForRealtime.mockReset();
  });

  it('publishes accepted and refreshed signals immediately for the exact shop', async () => {
    const event = {
      sequence: 2,
      shopId: 'shop-a',
      stage: 'refreshed',
      domain: 'orders',
      postingNumbers: ['ORDER-1'],
    };
    waitForRealtime
      .mockResolvedValueOnce({ ok: true, sequence: 1, event: null, initialized: true })
      .mockResolvedValueOnce({ ok: true, sequence: 2, event })
      .mockImplementation((_input, options = {}) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }));
    const onEvent = vi.fn();
    const browserEvents = [];
    const onBrowserEvent = (browserEvent) => browserEvents.push(browserEvent.detail);
    window.addEventListener(OZON_PUSH_REALTIME_BROWSER_EVENT, onBrowserEvent);
    const view = render(<OzonPushRealtimeBridge shops={[{ id: 'shop-a' }]} onEvent={onEvent} />);

    await waitFor(() => expect(onEvent).toHaveBeenCalledWith(event));
    expect(browserEvents).toEqual([event]);
    expect(waitForRealtime.mock.calls[0][0]).toMatchObject({ shopId: 'shop-a', afterSequence: null });
    expect(waitForRealtime.mock.calls[1][0]).toMatchObject({ shopId: 'shop-a', afterSequence: 1 });

    await act(async () => view.unmount());
    window.removeEventListener(OZON_PUSH_REALTIME_BROWSER_EVENT, onBrowserEvent);
  });
});


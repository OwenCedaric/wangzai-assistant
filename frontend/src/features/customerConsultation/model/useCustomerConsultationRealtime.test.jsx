import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  waitForCustomerServiceRealtimeEvent: vi.fn(),
}));

vi.mock('../services/customerConsultationClient.js', () => ({
  waitForCustomerServiceRealtimeEvent: mocks.waitForCustomerServiceRealtimeEvent,
}));

import {
  applyCustomerConsultationRealtimeEvent,
  useCustomerConsultationRealtime,
} from './useCustomerConsultationRealtime.js';

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('accepts the initial zero cursor and enters long polling instead of spinning on initialization', async () => {
  mocks.waitForCustomerServiceRealtimeEvent.mockResolvedValueOnce({ ok: true, sequence: 0, initialized: true, event: null })
    .mockReturnValueOnce(new Promise(() => {}));
  const { unmount } = renderHook(() => useCustomerConsultationRealtime({ shopId: 'zero-cursor-shop', onEvent: vi.fn() }));
  await waitFor(() => expect(mocks.waitForCustomerServiceRealtimeEvent).toHaveBeenCalledTimes(2));
  expect(mocks.waitForCustomerServiceRealtimeEvent.mock.calls[1][0].afterSequence).toBe(0);
  unmount();
});

it('backs off on an invalid cursor instead of issuing immediate repeated requests', async () => {
  vi.useFakeTimers();
  mocks.waitForCustomerServiceRealtimeEvent.mockResolvedValueOnce({ ok: true, sequence: -1, event: null })
    .mockReturnValueOnce(new Promise(() => {}));
  const { unmount } = renderHook(() => useCustomerConsultationRealtime({ shopId: 'invalid-cursor-shop' }));
  await act(async () => { await Promise.resolve(); });
  expect(mocks.waitForCustomerServiceRealtimeEvent).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(mocks.waitForCustomerServiceRealtimeEvent).toHaveBeenCalledTimes(2);
  unmount();
});

it('continues from the last sequence and aborts the exact shop wait on cleanup', async () => {
  let resolveFirst;
  mocks.waitForCustomerServiceRealtimeEvent
    .mockResolvedValueOnce({ ok: true, sequence: 3, event: null, initialized: true })
    .mockReturnValueOnce(new Promise((resolve) => {
      resolveFirst = resolve;
    }))
    .mockReturnValueOnce(new Promise(() => {}));
  const onEvent = vi.fn(async () => undefined);
  const { unmount } = renderHook(() =>
    useCustomerConsultationRealtime({ shopId: 'shop-a', enabled: true, onEvent })
  );

  await waitFor(() => expect(mocks.waitForCustomerServiceRealtimeEvent).toHaveBeenCalledTimes(2));
  expect(mocks.waitForCustomerServiceRealtimeEvent.mock.calls[0][0]).toMatchObject({
    shopId: 'shop-a',
    afterSequence: null,
  });
  expect(mocks.waitForCustomerServiceRealtimeEvent.mock.calls[1][0]).toMatchObject({
    shopId: 'shop-a',
    afterSequence: 3,
  });
  const firstSignal = mocks.waitForCustomerServiceRealtimeEvent.mock.calls[0][1].signal;
  resolveFirst({
    ok: true,
    sequence: 4,
    event: { sequence: 4, shopId: 'shop-a', chatIds: ['chat-1'], messageTypes: ['TYPE_NEW_MESSAGE'] },
  });

  await waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(mocks.waitForCustomerServiceRealtimeEvent).toHaveBeenCalledTimes(3));
  expect(mocks.waitForCustomerServiceRealtimeEvent.mock.calls[2][0]).toMatchObject({
    shopId: 'shop-a',
    afterSequence: 4,
  });
  const secondSignal = mocks.waitForCustomerServiceRealtimeEvent.mock.calls[2][1].signal;
  expect(firstSignal).toBe(secondSignal);
  unmount();
  expect(secondSignal.aborted).toBe(true);
});

it('does not subscribe while the customer page is inactive', () => {
  renderHook(() => useCustomerConsultationRealtime({ shopId: 'shop-a', enabled: false, onEvent: vi.fn() }));
  expect(mocks.waitForCustomerServiceRealtimeEvent).not.toHaveBeenCalled();
});

it('reloads the chat list and only the pushed visible conversation from local cache', async () => {
  const refreshList = vi.fn(async () => [
    { id: 'chat-1', chatId: 'chat-1' },
    { id: 'chat-2', chatId: 'chat-2' },
  ]);
  const refreshConversationFromCache = vi.fn(async () => undefined);
  const refreshNotifications = vi.fn(async () => undefined);

  await applyCustomerConsultationRealtimeEvent(
    { shopId: 'shop-a', chatIds: ['chat-1', 'chat-1', 'not-visible'] },
    { refreshList, refreshConversationFromCache, refreshNotifications }
  );

  expect(refreshList).toHaveBeenCalledWith({ forceRefresh: false });
  expect(refreshConversationFromCache).toHaveBeenCalledTimes(1);
  expect(refreshConversationFromCache).toHaveBeenCalledWith('chat-1');
  expect(refreshNotifications).toHaveBeenCalledWith({ silent: true });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCustomerChatHistory: vi.fn(),
  readCustomerChatList: vi.fn(),
  readCustomerPushViewMarkers: vi.fn(async () => ({ ok: true, rows: [] })),
  saveCustomerPushViewMarker: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../services/customerConsultationClient.js', () => ({
  readCustomerChatHistory: mocks.readCustomerChatHistory,
  readCustomerChatList: mocks.readCustomerChatList,
  readCustomerPushViewMarkers: mocks.readCustomerPushViewMarkers,
  saveCustomerPushViewMarker: mocks.saveCustomerPushViewMarker,
}));

import { useCustomerOzonConversations } from './useCustomerOzonConversations.js';

afterEach(() => {
  vi.resetAllMocks();
  mocks.readCustomerPushViewMarkers.mockResolvedValue({ ok: true, rows: [] });
  mocks.saveCustomerPushViewMarker.mockResolvedValue({ ok: true });
});

function listPayload(rows, extra = {}) {
  const cursor = extra.cursor ?? (extra.has_next ? `cursor:${rows.at(-1)?.chatId || 'next'}` : '');
  return {
    ok: true,
    data: {
      chats: rows.map((row) => ({
        unread_count: row.unread ?? 0,
        last_message_id: row.lastMessageId || row.chatId,
        chat: {
          chat_id: row.chatId,
          chat_type: row.chatType || 'BUYER_SELLER',
          chat_status: 'OPENED',
          created_at: row.createdAt || '2026-07-18T00:00:00.000Z',
        },
      })),
      ...(cursor ? { cursor } : {}),
      ...extra,
    },
  };
}

describe('useCustomerOzonConversations', () => {
  it('exposes initial loading and then an empty state', async () => {
    let resolveList;
    mocks.readCustomerChatList.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      })
    );
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.status).toBe('loading'));
    await act(async () => {
      resolveList(listPayload([]));
    });
    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(result.current.emptyReason).toBe('当前店铺暂无客服会话');
  });

  it('exposes a Chinese initial error state without fabricating rows', async () => {
    mocks.readCustomerChatList.mockRejectedValue(new Error('Forbidden'));
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.rows).toEqual([]);
    expect(result.current.error).toBe('当前账号没有访问客服数据的权限。');
  });

  it('does not start hidden-page chat loading and starts a cancellable local request only after activation', async () => {
    mocks.readCustomerChatList.mockResolvedValue({ rows: [], result: { has_next: false } });
    const { rerender, unmount } = renderHook(({ enabled }) => useCustomerOzonConversations('shop-a', { enabled }), {
      initialProps: { enabled: false },
    });

    expect(mocks.readCustomerChatList).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(mocks.readCustomerChatList).toHaveBeenCalledTimes(1));
    expect(mocks.readCustomerChatList.mock.calls[0][0]).toMatchObject({ shopId: 'shop-a', forceRefresh: false });
    expect(mocks.readCustomerChatList.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    unmount();
    expect(mocks.readCustomerChatList.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('automatically loads remaining pages and deduplicates a repeated conversation', async () => {
    mocks.readCustomerChatList
      .mockResolvedValueOnce(
        listPayload(
          Array.from({ length: 30 }, (_, index) => ({
            chatId: `chat-${index}`,
            createdAt: `2026-07-${String(18 - Math.floor(index / 10)).padStart(2, '0')}T00:00:00.000Z`,
          })),
          { has_next: true }
        )
      )
      .mockResolvedValueOnce(listPayload([{ chatId: 'chat-29' }, { chatId: 'chat-30' }], { has_next: false }));
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a', { accountScopeKey: 'account-a' }));

    await waitFor(() => expect(mocks.readCustomerChatList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.rows).toHaveLength(31));
    expect(mocks.readCustomerChatList.mock.calls.map(([input]) => input.cursor)).toEqual(['', 'cursor:chat-29']);
    expect(mocks.readCustomerChatList.mock.calls.map(([input]) => input.limit)).toEqual([100, 100]);
    expect(new Set(result.current.rows.map((row) => row.id)).size).toBe(31);
    expect(result.current.hasNext).toBe(false);
  });

  it('keeps the first page usable while older conversations continue in the background', async () => {
    let resolveOlderPage;
    mocks.readCustomerChatList
      .mockResolvedValueOnce(
        listPayload(
          Array.from({ length: 30 }, (_, index) => ({ chatId: `visible-chat-${index}` })),
          { has_next: true, total_chats_count: 31 }
        )
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlderPage = resolve;
        })
      );
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));

    await waitFor(() => expect(result.current.rows).toHaveLength(30));
    expect(result.current.status).toBe('success');
    expect(result.current.loadingMore).toBe(false);
    await waitFor(() => expect(result.current.backgroundSyncing).toBe(true));
    expect(result.current.rows).toHaveLength(30);

    await act(async () => {
      resolveOlderPage(listPayload([{ chatId: 'visible-chat-30' }], { has_next: false, total_chats_count: 31 }));
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(31));
    expect(result.current.backgroundSyncing).toBe(false);
  });

  it('keeps every unique conversation beyond the old 180-row limit', async () => {
    mocks.readCustomerChatList
      .mockResolvedValueOnce(
        listPayload(
          Array.from({ length: 100 }, (_, index) => ({ chatId: `bulk-chat-${index}` })),
          { has_next: true, total_chats_count: 205 }
        )
      )
      .mockResolvedValueOnce(
        listPayload(
          Array.from({ length: 100 }, (_, index) => ({ chatId: `bulk-chat-${index + 100}` })),
          { has_next: true, total_chats_count: 205 }
        )
      )
      .mockResolvedValueOnce(
        listPayload(
          Array.from({ length: 5 }, (_, index) => ({ chatId: `bulk-chat-${index + 200}` })),
          { has_next: false, total_chats_count: 205 }
        )
      );
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));

    await waitFor(() => expect(mocks.readCustomerChatList).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.rows).toHaveLength(205));
    expect(mocks.readCustomerChatList.mock.calls.map(([input]) => input.cursor)).toEqual([
      '',
      'cursor:bulk-chat-99',
      'cursor:bulk-chat-199',
    ]);
    expect(result.current.totalCount).toBe(205);
    expect(result.current.hasNext).toBe(false);
  });

  it('stops immediately when Ozon repeats the same cursor and the same page', async () => {
    const repeatedRows = Array.from({ length: 100 }, (_, index) => ({ chatId: `repeat-chat-${index}` }));
    mocks.readCustomerChatList
      .mockResolvedValueOnce(listPayload(repeatedRows, { has_next: true, cursor: 'same-cursor' }))
      .mockResolvedValueOnce(listPayload(repeatedRows, { has_next: true, cursor: 'same-cursor' }));

    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));

    await waitFor(() => expect(mocks.readCustomerChatList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.backgroundSyncing).toBe(false));
    expect(result.current.rows).toHaveLength(100);
    expect(result.current.hasNext).toBe(false);
    expect(mocks.readCustomerChatList.mock.calls.map(([input]) => input.cursor)).toEqual(['', 'same-cursor']);
  });

  it('loads older chat history with the oldest message cursor and keeps both pages', async () => {
    mocks.readCustomerChatList.mockResolvedValue(listPayload([{ chatId: 'history-chat' }]));
    mocks.readCustomerChatHistory
      .mockResolvedValueOnce({
        ok: true,
        data: {
          has_next: true,
          messages: [
            {
              message_id: 'message-2',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-07-18T02:00:00.000Z',
              data: ['最新消息'],
            },
            {
              message_id: 'message-1',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-07-18T01:00:00.000Z',
              data: ['当前页最早消息'],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          has_next: false,
          messages: [
            {
              message_id: 'message-0',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-07-18T00:00:00.000Z',
              data: ['更早消息'],
            },
          ],
        },
      });
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    await act(async () => {
      await result.current.ensureHistory(result.current.rows[0].id);
    });
    await act(async () => {
      await result.current.loadOlderHistory(result.current.rows[0].id);
    });

    expect(mocks.readCustomerChatHistory.mock.calls[1][0]).toMatchObject({
      chatId: 'history-chat',
      fromMessageId: 'message-1',
      forceRefresh: true,
    });
    expect(result.current.rows[0].messages.map((message) => message.id)).toEqual([
      'message-0',
      'message-1',
      'message-2',
    ]);
    expect(result.current.rows[0].historyHasNext).toBe(false);
  });

  it('indexes every older history page in the background until Ozon reports completion', async () => {
    mocks.readCustomerChatList.mockResolvedValue(listPayload([{ chatId: 'full-history-chat' }]));
    mocks.readCustomerChatHistory
      .mockResolvedValueOnce({
        ok: true,
        data: {
          has_next: true,
          messages: [
            {
              message_id: 'message-5',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-07-18T05:00:00.000Z',
              data: ['第五条'],
            },
            {
              message_id: 'message-4',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-07-18T04:00:00.000Z',
              data: ['第四条'],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          has_next: true,
          messages: [
            {
              message_id: 'message-3',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-07-18T03:00:00.000Z',
              data: ['第三条'],
            },
            {
              message_id: 'message-2',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-07-18T02:00:00.000Z',
              data: ['第二条'],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          has_next: false,
          messages: [
            {
              message_id: 'message-1',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-07-18T01:00:00.000Z',
              data: ['第一条'],
            },
          ],
        },
      });
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    await act(async () => {
      await result.current.preloadFullHistories(['full-history-chat'], {
        concurrency: 1,
        priority: 'P3',
        requestedBy: 'full-history-test',
      });
    });

    expect(mocks.readCustomerChatHistory.mock.calls.map(([input]) => input.fromMessageId)).toEqual([
      '',
      'message-4',
      'message-2',
    ]);
    expect(mocks.readCustomerChatHistory.mock.calls.every(([input]) => input.priority === 'P3')).toBe(true);
    expect(result.current.historyLoadingIds).toEqual([]);
    expect(result.current.rows[0]).toMatchObject({
      historyIndexComplete: true,
      historyIndexStatus: 'complete',
      historyIndexedCount: 5,
      historyIndexError: '',
    });
    expect(result.current.rows[0].messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
      'message-5',
    ]);
  });

  it('stops full history indexing when Ozon repeats an older-page cursor without new messages', async () => {
    mocks.readCustomerChatList.mockResolvedValue(listPayload([{ chatId: 'stalled-history-chat' }]));
    const repeatedMessage = {
      message_id: 'message-1',
      user: { id: 'buyer-a', type: 'Customer' },
      created_at: '2026-07-18T01:00:00.000Z',
      data: ['同一条消息'],
    };
    mocks.readCustomerChatHistory
      .mockResolvedValueOnce({ ok: true, data: { has_next: true, messages: [repeatedMessage] } })
      .mockResolvedValueOnce({ ok: true, data: { has_next: true, messages: [repeatedMessage] } });
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    await act(async () => {
      await result.current.preloadFullHistories(['stalled-history-chat']);
    });

    expect(mocks.readCustomerChatHistory).toHaveBeenCalledTimes(2);
    expect(result.current.rows[0]).toMatchObject({
      historyIndexComplete: false,
      historyIndexStatus: 'stalled',
      historyIndexedCount: 1,
    });
    expect(result.current.rows[0].historyIndexError).toContain('没有返回新的更早消息');
  });

  it('moves a conversation to the top after a confirmed send refresh reads back a newer message', async () => {
    mocks.readCustomerChatList.mockResolvedValue(
      listPayload([
        { chatId: 'newer-chat', createdAt: '2026-08-20T10:00:00.000Z' },
        { chatId: 'sent-chat', createdAt: '2026-08-19T10:00:00.000Z' },
      ])
    );
    mocks.readCustomerChatHistory.mockResolvedValue({
      ok: true,
      data: {
        messages: [
          {
            message_id: 'confirmed-outbound-image',
            user: { id: 'seller-a', type: 'Seller' },
            created_at: '2026-08-21T13:30:00.000Z',
            data: ['![](https://api-seller.ozon.ru/v2/chat/file/test-image.png)'],
            is_image: true,
          },
        ],
      },
    });
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows.map((row) => row.chatId)).toEqual(['newer-chat', 'sent-chat']));

    await act(async () => {
      await result.current.refreshConversation('sent-chat');
    });

    expect(result.current.rows[0]).toMatchObject({
      chatId: 'sent-chat',
      lastMessageId: 'confirmed-outbound-image',
      lastMessage: '[图片消息]',
    });
  });

  it('reloads an already open conversation from the push-refreshed local cache without another Ozon force read', async () => {
    mocks.readCustomerChatList.mockResolvedValue(listPayload([{ chatId: 'push-chat' }]));
    mocks.readCustomerChatHistory
      .mockResolvedValueOnce({
        ok: true,
        data: {
          messages: [{ message_id: 'message-1', user: { type: 'Customer' }, data: ['旧消息'] }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          messages: [{ message_id: 'message-2', user: { type: 'Customer' }, data: ['推送后的新消息'] }],
        },
      });
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    await act(async () => {
      await result.current.ensureHistory('push-chat');
      await result.current.refreshConversationFromCache('push-chat');
    });

    expect(mocks.readCustomerChatHistory).toHaveBeenCalledTimes(2);
    expect(mocks.readCustomerChatHistory.mock.calls[1][0]).toMatchObject({
      chatId: 'push-chat',
      forceRefresh: false,
      requestedBy: 'customer-consultation-push-cache',
    });
    expect(result.current.rows[0]).toMatchObject({
      chatId: 'push-chat',
      lastMessageId: 'message-2',
      lastMessage: '推送后的新消息',
    });
  });

  it('keeps rendered messages and reloads history when the list reports a newer inbound message', async () => {
    mocks.readCustomerChatList
      .mockResolvedValueOnce(listPayload([{ chatId: 'race-chat', unread: 1, lastMessageId: 'message-1' }]))
      .mockResolvedValueOnce(listPayload([{ chatId: 'race-chat', unread: 1, lastMessageId: 'message-2' }]));
    mocks.readCustomerChatHistory
      .mockResolvedValueOnce({
        ok: true,
        data: {
          messages: [
            {
              message_id: 'message-1',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-08-23T08:00:00.000Z',
              data: ['第一条消息'],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          messages: [
            {
              message_id: 'message-1',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-08-23T08:00:00.000Z',
              data: ['第一条消息'],
            },
            {
              message_id: 'message-2',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-08-23T08:01:00.000Z',
              data: ['刚到的新消息'],
            },
          ],
        },
      });
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows[0]?.lastMessageId).toBe('message-1'));

    await act(async () => {
      await result.current.ensureHistory(result.current.rows[0].id);
    });
    expect(result.current.rows[0].messages.map((message) => message.id)).toEqual(['message-1']);

    await act(async () => {
      await result.current.refreshList({ forceRefresh: true });
    });
    expect(result.current.rows[0]).toMatchObject({
      lastMessageId: 'message-2',
      historyLoaded: false,
      historyStatus: 'stale',
    });
    expect(result.current.rows[0].messages.map((message) => message.id)).toEqual(['message-1']);

    await act(async () => {
      await result.current.ensureHistory(result.current.rows[0].id);
    });
    expect(mocks.readCustomerChatHistory).toHaveBeenCalledTimes(2);
    expect(result.current.rows[0]).toMatchObject({
      lastMessageId: 'message-2',
      historyLoaded: true,
      historyStatus: 'success',
    });
    expect(result.current.rows[0].messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
  });

  it('does not abort the selected history request when the conversation list refreshes', async () => {
    let resolveHistory;
    mocks.readCustomerChatList.mockResolvedValue(listPayload([{ chatId: 'active-chat', lastMessageId: 'message-1' }]));
    mocks.readCustomerChatHistory.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveHistory = resolve;
        })
    );
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    let historyPromise;
    act(() => {
      historyPromise = result.current.ensureHistory(result.current.rows[0].id);
    });
    await waitFor(() => expect(mocks.readCustomerChatHistory).toHaveBeenCalledTimes(1));
    const historySignal = mocks.readCustomerChatHistory.mock.calls[0][1].signal;

    await act(async () => {
      await result.current.refreshList({ forceRefresh: true });
    });
    expect(historySignal.aborted).toBe(false);

    await act(async () => {
      resolveHistory({
        ok: true,
        data: {
          messages: [
            {
              message_id: 'message-1',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-08-23T08:00:00.000Z',
              data: ['读取完成'],
            },
          ],
        },
      });
      await historyPromise;
    });
    expect(result.current.rows[0].messages[0]?.content).toBe('读取完成');
  });

  it('restores an aborted history request to a retryable state', async () => {
    mocks.readCustomerChatList.mockResolvedValue(listPayload([{ chatId: 'abort-chat', lastMessageId: 'message-1' }]));
    mocks.readCustomerChatHistory.mockImplementation(
      (_input, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true }
          );
        })
    );
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const controller = new AbortController();

    let historyPromise;
    act(() => {
      historyPromise = result.current.ensureHistory(result.current.rows[0].id, { signal: controller.signal });
    });
    await waitFor(() => expect(result.current.rows[0]?.historyStatus).toBe('loading'));
    await act(async () => {
      controller.abort();
      await historyPromise;
    });

    expect(result.current.rows[0]).toMatchObject({ historyLoaded: false, historyStatus: 'idle' });
    expect(result.current.historyLoadingIds).not.toContain(result.current.rows[0].id);
  });

  it('does not let a stale background list refresh demote a conversation after a confirmed send', async () => {
    const staleList = listPayload([
      { chatId: 'newer-chat', createdAt: '2026-08-20T10:00:00.000Z' },
      { chatId: 'sent-chat', createdAt: '2026-08-19T10:00:00.000Z', lastMessageId: 'old-message' },
    ]);
    mocks.readCustomerChatList.mockResolvedValue(staleList);
    mocks.readCustomerChatHistory.mockResolvedValue({
      ok: true,
      data: {
        messages: [
          {
            message_id: 'confirmed-outbound-image',
            user: { id: 'seller-a', type: 'Seller' },
            created_at: '2026-08-21T13:30:00.000Z',
            data: ['![](https://api-seller.ozon.ru/v2/chat/file/test-image.png)'],
            is_image: true,
          },
        ],
      },
    });
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows.map((row) => row.chatId)).toEqual(['newer-chat', 'sent-chat']));

    await act(async () => {
      await result.current.refreshConversation('sent-chat');
    });
    expect(result.current.rows[0]?.chatId).toBe('sent-chat');

    await act(async () => {
      await result.current.refreshList({ forceRefresh: true });
    });

    expect(result.current.rows[0]).toMatchObject({
      chatId: 'sent-chat',
      lastMessageId: 'confirmed-outbound-image',
      lastMessage: '[图片消息]',
      historyLoaded: true,
    });
  });

  it('keeps already loaded rows when a refresh fails', async () => {
    mocks.readCustomerChatList
      .mockResolvedValueOnce(listPayload([{ chatId: 'chat-1' }]))
      .mockRejectedValueOnce(new Error('NetworkError: failed to fetch'));
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    await act(async () => {
      await result.current.refreshList({ forceRefresh: true });
    });
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.status).toBe('stale');
    expect(result.current.error).toBe('网络连接失败，请检查网络后重试。');
  });

  it('applies only verified Ozon readback targets to the visible row immediately', async () => {
    mocks.readCustomerChatList.mockResolvedValue(listPayload([{ chatId: 'chat-1', unread: 2 }]));
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows[0]?.unreadCount).toBe(2));

    act(() => {
      result.current.applyReadback([
        { chatId: 'chat-1', verified: true },
        { chatId: 'other-chat', verified: false },
      ]);
    });

    expect(result.current.rows[0]).toMatchObject({ unreadCount: 0, unread: 0, readState: 'read' });
  });

  it('does not let a stale list response restore a verified read badge until a newer message arrives', async () => {
    mocks.readCustomerChatList
      .mockResolvedValueOnce(
        listPayload([{ chatId: 'chat-1', unread: 3, lastMessageId: 'message-1' }], {
          total_unread_count: 3,
        })
      )
      .mockResolvedValueOnce(
        listPayload([{ chatId: 'chat-1', unread: 3, lastMessageId: 'message-1' }], {
          total_unread_count: 3,
        })
      )
      .mockResolvedValueOnce(
        listPayload([{ chatId: 'chat-1', unread: 1, lastMessageId: 'message-2' }], {
          total_unread_count: 1,
        })
      );
    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows[0]?.unreadCount).toBe(3));

    act(() => {
      result.current.applyReadback([{ chatId: 'chat-1', verified: true }]);
    });
    await act(async () => {
      await result.current.refreshList({ forceRefresh: true });
    });
    expect(result.current.rows[0]).toMatchObject({ unreadCount: 0, unread: 0, readState: 'read' });
    expect(result.current.totalUnreadCount).toBe(0);

    await act(async () => {
      await result.current.refreshList({ forceRefresh: true });
    });
    expect(result.current.rows[0]).toMatchObject({ unreadCount: 1, unread: 1, lastMessageId: 'message-2' });
    expect(result.current.totalUnreadCount).toBe(1);
  });

  it('marks a viewed push conversation read locally until Ozon returns a newer message', async () => {
    mocks.readCustomerChatList
      .mockResolvedValueOnce(
        listPayload([{ chatId: 'push-chat', chatType: 'UNSPECIFIED', unread: 1, lastMessageId: 'push-message-1' }])
      )
      .mockResolvedValueOnce(
        listPayload([{ chatId: 'push-chat', chatType: 'UNSPECIFIED', unread: 1, lastMessageId: 'push-message-1' }])
      )
      .mockResolvedValueOnce(
        listPayload([{ chatId: 'push-chat', chatType: 'UNSPECIFIED', unread: 1, lastMessageId: 'push-message-2' }])
      );
    mocks.readCustomerChatHistory.mockResolvedValue({
      ok: true,
      data: {
        messages: [
          {
            message_id: 'push-message-1',
            user: { id: 'notification-user', type: 'NotificationUser' },
            created_at: '2026-07-18T01:00:00.000Z',
            data: ['需要确认对账单'],
          },
        ],
      },
    });

    const { result } = renderHook(() => useCustomerOzonConversations('shop-a'));
    await waitFor(() => expect(result.current.rows[0]?.unreadCount).toBe(1));

    await act(async () => {
      await result.current.ensureHistory(result.current.rows[0].id);
    });
    expect(result.current.rows[0]).toMatchObject({ unreadCount: 0, unread: 0, readState: 'read' });

    await act(async () => {
      await result.current.refreshList({ forceRefresh: true });
    });
    expect(result.current.rows[0]).toMatchObject({ unreadCount: 0, unread: 0, readState: 'read' });

    await act(async () => {
      await result.current.refreshList({ forceRefresh: true });
    });
    expect(result.current.rows[0]).toMatchObject({ unreadCount: 1, unread: 1, lastMessageId: 'push-message-2' });
  });

  it('restores a viewed push marker after the hook is unmounted and mounted again', async () => {
    let storedMarkers = [];
    mocks.readCustomerPushViewMarkers.mockImplementation(async () => ({ ok: true, rows: storedMarkers }));
    mocks.saveCustomerPushViewMarker.mockImplementation(async (marker) => {
      storedMarkers = [
        {
          chatId: marker.chatId,
          lastMessageId: marker.lastMessageId,
          lastMessageAt: marker.lastMessageAt,
        },
      ];
      return { ok: true };
    });
    mocks.readCustomerChatList.mockResolvedValue(
      listPayload([{ chatId: 'push-chat', chatType: 'UNSPECIFIED', unread: 1, lastMessageId: 'push-message-1' }], {
        total_unread_count: 1,
      })
    );
    mocks.readCustomerChatHistory.mockResolvedValue({
      ok: true,
      data: {
        messages: [
          {
            message_id: 'push-message-1',
            user: { id: 'notification-user', type: 'NotificationUser' },
            created_at: '2026-07-19T01:00:00.000Z',
            data: ['需要确认对账单'],
          },
        ],
      },
    });

    const firstMount = renderHook(() => useCustomerOzonConversations('shop-a', { accountScopeKey: 'account-a' }));
    await waitFor(() => expect(firstMount.result.current.rows[0]?.unreadCount).toBe(1));
    await act(async () => {
      await firstMount.result.current.ensureHistory(firstMount.result.current.rows[0].id);
    });
    expect(mocks.saveCustomerPushViewMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-a',
        accountId: 'account-a',
        chatId: 'push-chat',
        lastMessageId: 'push-message-1',
      })
    );
    firstMount.unmount();

    const secondMount = renderHook(() => useCustomerOzonConversations('shop-a', { accountScopeKey: 'account-a' }));
    await waitFor(() => expect(secondMount.result.current.rows[0]?.unreadCount).toBe(0));
    expect(secondMount.result.current.rows[0]).toMatchObject({ unread: 0, readState: 'read' });
    expect(secondMount.result.current.totalUnreadCount).toBe(0);
    secondMount.unmount();
  });

  it('does not let a previous shop response overwrite the current shop', async () => {
    let resolveShopA;
    const shopA = new Promise((resolve) => {
      resolveShopA = resolve;
    });
    mocks.readCustomerChatList
      .mockReturnValueOnce(shopA)
      .mockResolvedValueOnce(listPayload([{ chatId: 'shop-b-chat' }]));
    const { result, rerender } = renderHook(
      ({ shopId }) => useCustomerOzonConversations(shopId, { accountScopeKey: shopId }),
      { initialProps: { shopId: 'shop-a' } }
    );
    await waitFor(() => expect(mocks.readCustomerChatList).toHaveBeenCalledTimes(1));
    rerender({ shopId: 'shop-b' });
    await waitFor(() => expect(result.current.rows[0]?.chatId).toBe('shop-b-chat'));
    await act(async () => {
      resolveShopA(listPayload([{ chatId: 'shop-a-chat' }]));
      await Promise.resolve();
    });
    expect(result.current.rows.map((row) => row.chatId)).toEqual(['shop-b-chat']);
  });

  it('isolates a replaced account generation even when the local shop id is reused', async () => {
    let resolveOldAccount;
    const oldAccount = new Promise((resolve) => {
      resolveOldAccount = resolve;
    });
    mocks.readCustomerChatList
      .mockReturnValueOnce(oldAccount)
      .mockResolvedValueOnce(listPayload([{ chatId: 'new-account-chat' }]));
    const { result, rerender } = renderHook(
      ({ accountScopeKey }) => useCustomerOzonConversations('shop-slot', { accountScopeKey }),
      { initialProps: { accountScopeKey: 'account-generation-a' } }
    );
    await waitFor(() => expect(mocks.readCustomerChatList).toHaveBeenCalledTimes(1));
    rerender({ accountScopeKey: 'account-generation-b' });
    await waitFor(() => expect(result.current.rows[0]?.chatId).toBe('new-account-chat'));
    await act(async () => {
      resolveOldAccount(listPayload([{ chatId: 'old-account-chat' }]));
      await Promise.resolve();
    });
    expect(result.current.rows[0].id).toContain('account-generation-b');
    expect(result.current.rows.some((row) => row.chatId === 'old-account-chat')).toBe(false);
  });

  it('does not merge an old shop history response into the new shop with the same chat id', async () => {
    let resolveOldHistory;
    const oldHistory = new Promise((resolve) => {
      resolveOldHistory = resolve;
    });
    mocks.readCustomerChatList.mockResolvedValue(listPayload([{ chatId: 'same-chat' }]));
    mocks.readCustomerChatHistory.mockReturnValue(oldHistory);
    const { result, rerender } = renderHook(
      ({ shopId }) => useCustomerOzonConversations(shopId, { accountScopeKey: shopId }),
      { initialProps: { shopId: 'shop-a' } }
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => {
      void result.current.ensureHistory(result.current.rows[0].id);
    });
    await waitFor(() => expect(mocks.readCustomerChatHistory).toHaveBeenCalledTimes(1));
    rerender({ shopId: 'shop-b' });
    await waitFor(() => expect(result.current.rows[0]?.shopId).toBe('shop-b'));
    await act(async () => {
      resolveOldHistory({
        ok: true,
        data: {
          messages: [
            {
              message_id: 'shop-a-message',
              user: { id: 'buyer-a', type: 'Customer' },
              created_at: '2026-07-18T00:00:00.000Z',
              data: ['shop-a only'],
            },
          ],
        },
      });
      await Promise.resolve();
    });
    expect(result.current.rows[0].messages).toEqual([]);
    expect(result.current.rows[0].historyLoaded).toBe(false);
  });

  it('does not request all shops when no shop is selected', async () => {
    const { result } = renderHook(() => useCustomerOzonConversations(''));
    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(mocks.readCustomerChatList).not.toHaveBeenCalled();
    expect(result.current.emptyReason).toBe('请先选择 Ozon 店铺');
  });
});

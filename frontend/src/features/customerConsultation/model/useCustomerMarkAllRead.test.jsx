import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildCustomerMarkReadTargets: vi.fn((rows = []) =>
    rows.map((row) => ({
      chat_id: row.chatId,
      from_message_id: row.readThroughMessageId || row.lastMessageId || row.firstUnreadMessageId,
      first_unread_message_id: row.firstUnreadMessageId || null,
      last_message_id: row.lastMessageId || null,
      unread_count: row.unreadCount,
    }))
  ),
  previewCustomerMarkAllRead: vi.fn(),
  confirmCustomerMarkAllRead: vi.fn(),
}));

vi.mock('../services/customerConsultationClient.js', () => mocks);

import { useCustomerMarkAllRead } from './useCustomerMarkAllRead.js';

const conversations = [
  {
    chatId: 'chat-1',
    unreadCount: 2,
    firstUnreadMessageId: '3001',
    lastMessageId: '3002',
  },
];

describe('useCustomerMarkAllRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.previewCustomerMarkAllRead.mockResolvedValue({ ok: true, previewId: 'preview-1' });
    mocks.confirmCustomerMarkAllRead.mockResolvedValue({
      ok: true,
      readBack: { status: 'success' },
      failures: [],
      schedulerResult: { writes: [{ chatId: 'chat-1', ok: true }] },
    });
  });

  it('requires preview and only refreshes after successful Ozon readback', async () => {
    const onReadbackConfirmed = vi.fn();
    const { result } = renderHook(() =>
      useCustomerMarkAllRead({
        activeShopId: 'shop-a',
        accountScopeKey: 'shop-a:g1',
        onReadbackConfirmed,
      })
    );

    await act(async () => {
      await result.current.requestMarkAllRead(conversations);
    });
    expect(result.current.markAllReadState.status).toBe('ready');
    expect(mocks.previewCustomerMarkAllRead).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-a',
        chats: expect.arrayContaining([expect.objectContaining({ chat_id: 'chat-1' })]),
      }),
      expect.any(Object)
    );

    await act(async () => {
      await result.current.confirmMarkAllRead();
    });
    await waitFor(() => expect(result.current.markAllReadState.status).toBe('success'));
    expect(onReadbackConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.confirmCustomerMarkAllRead).toHaveBeenCalledWith(
      expect.objectContaining({ previewId: 'preview-1', shopId: 'shop-a' }),
      expect.any(Object)
    );
  });

  it('keeps the result pending when Ozon has not confirmed unread_count zero', async () => {
    mocks.confirmCustomerMarkAllRead.mockResolvedValueOnce({
      ok: false,
      readBack: { status: 'mismatch' },
      failures: [{ chatId: 'chat-1', error: { message: '仍有未读消息' } }],
    });
    const onReadbackConfirmed = vi.fn();
    const { result } = renderHook(() =>
      useCustomerMarkAllRead({
        activeShopId: 'shop-a',
        onReadbackConfirmed,
      })
    );

    await act(async () => {
      await result.current.requestMarkAllRead(conversations);
    });
    await waitFor(() => expect(result.current.markAllReadState.status).toBe('ready'));
    await act(async () => {
      await result.current.confirmMarkAllRead();
    });
    expect(result.current.markAllReadState.status).toBe('partial');
    expect(onReadbackConfirmed).not.toHaveBeenCalled();
  });

  it('supports a single current-conversation preview without changing the bulk flow', async () => {
    const { result } = renderHook(() =>
      useCustomerMarkAllRead({
        activeShopId: 'shop-a',
        accountScopeKey: 'shop-a:g1',
      })
    );

    await act(async () => {
      await result.current.requestMarkConversationRead(conversations[0]);
    });

    expect(result.current.markAllReadState.scope).toBe('single');
    expect(result.current.markAllReadState.targetTitle).toBe('当前会话');
    expect(result.current.markAllReadState.status).toBe('ready');
  });

  it('marks a rendered unread conversation through the existing preview-confirm API without opening the dialog', async () => {
    const onReadbackConfirmed = vi.fn();
    const { result } = renderHook(() =>
      useCustomerMarkAllRead({
        activeShopId: 'shop-a',
        accountScopeKey: 'shop-a:g1',
        onReadbackConfirmed,
      })
    );

    await act(async () => {
      await result.current.markConversationReadAutomatically(conversations[0], {
        readThroughMessageId: '3002',
      });
    });

    expect(mocks.buildCustomerMarkReadTargets).toHaveBeenCalledWith([
      expect.objectContaining({ chatId: 'chat-1', readThroughMessageId: '3002' }),
    ]);
    expect(mocks.previewCustomerMarkAllRead).toHaveBeenCalledTimes(1);
    expect(mocks.confirmCustomerMarkAllRead).toHaveBeenCalledTimes(1);
    expect(onReadbackConfirmed).toHaveBeenCalledTimes(1);
    expect(result.current.markAllReadState.open).toBe(false);
    expect(result.current.autoMarking).toBe(false);
    expect(result.current.autoReadError).toBe('');
  });

  it('does not complete or repeat the same boundary when Ozon still reports unread, but allows the next boundary', async () => {
    mocks.confirmCustomerMarkAllRead
      .mockResolvedValueOnce({
        ok: false,
        readBack: {
          status: 'mismatch',
          targets: [{ chatId: 'chat-1', verified: false, unreadCount: 1 }],
        },
        failures: [{ chatId: 'chat-1', error: { message: '仍有 1 条未读消息' } }],
        schedulerResult: { writes: [{ chatId: 'chat-1', ok: true, unreadCount: 1 }] },
      })
      .mockResolvedValueOnce({
        ok: true,
        readBack: {
          status: 'success',
          targets: [{ chatId: 'chat-1', verified: true, unreadCount: 0 }],
        },
        failures: [],
        schedulerResult: { writes: [{ chatId: 'chat-1', ok: true, unreadCount: 0 }] },
      });
    const onReadbackConfirmed = vi.fn();
    const onReadbackIncomplete = vi.fn();
    const { result } = renderHook(() =>
      useCustomerMarkAllRead({
        activeShopId: 'shop-a',
        accountScopeKey: 'shop-a:g1',
        onReadbackConfirmed,
        onReadbackIncomplete,
      })
    );

    await act(async () => {
      await result.current.markConversationReadAutomatically(conversations[0], {
        readThroughMessageId: '3002',
      });
    });
    expect(onReadbackConfirmed).not.toHaveBeenCalled();
    expect(onReadbackIncomplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.markConversationReadAutomatically(conversations[0], {
        readThroughMessageId: '3002',
      });
    });
    expect(mocks.confirmCustomerMarkAllRead).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.markConversationReadAutomatically(
        { ...conversations[0], lastMessageId: '3003' },
        { readThroughMessageId: '3003' }
      );
    });
    expect(mocks.confirmCustomerMarkAllRead).toHaveBeenCalledTimes(2);
    expect(onReadbackConfirmed).toHaveBeenCalledTimes(1);
  });

  it('does not open a failed write flow for read-only Ozon push messages', async () => {
    mocks.buildCustomerMarkReadTargets.mockReturnValueOnce([]);
    const { result } = renderHook(() =>
      useCustomerMarkAllRead({
        activeShopId: 'shop-a',
        accountScopeKey: 'shop-a:g1',
      })
    );

    await act(async () => {
      await result.current.requestMarkAllRead([
        {
          title: 'Ozon 信息推送',
          category: 'notification',
          channel: 'push',
          markReadSupported: false,
          chatId: 'push-chat',
          unreadCount: 5,
        },
      ]);
    });

    expect(result.current.markAllReadState.status).toBe('readonly');
    expect(result.current.markAllReadState.error).toContain('只读推送');
    expect(mocks.previewCustomerMarkAllRead).not.toHaveBeenCalled();
  });

  it('keeps missing message identifiers on the actionable-data error path', async () => {
    mocks.buildCustomerMarkReadTargets.mockReturnValueOnce([]);
    const { result } = renderHook(() => useCustomerMarkAllRead({ activeShopId: 'shop-a' }));

    await act(async () => {
      await result.current.requestMarkAllRead([
        {
          title: '买家会话',
          category: 'buyer',
          channel: 'chat',
          chatId: 'buyer-chat',
          unreadCount: 1,
        },
      ]);
    });

    expect(result.current.markAllReadState.status).toBe('error');
    expect(result.current.markAllReadState.error).toContain('缺少可用的 chat_id 或消息 ID');
  });
});

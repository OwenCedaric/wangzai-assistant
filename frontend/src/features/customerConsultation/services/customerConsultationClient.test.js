import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestLocalApi: vi.fn(() => Promise.resolve({ ok: true })),
  getDomainCache: vi.fn(() => Promise.resolve({ rows: [] })),
  listOzonNotifications: vi.fn(() => Promise.resolve({ rows: [] })),
}));

vi.mock('../../../api/localApiClient.js', () => mocks);

import {
  buildCustomerMarkReadTargets,
  confirmCustomerMarkAllRead,
  confirmCustomerMessageSend,
  previewCustomerMarkAllRead,
  readCustomerShopProfile,
  previewCustomerMessageSend,
  readCustomerChatHistory,
  readCustomerChatList,
  readCustomerOrderContext,
  readCustomerPushViewMarkers,
  saveCustomerPushViewMarker,
  translateCustomerChatMessages,
  waitForCustomerServiceRealtimeEvent,
} from './customerConsultationClient.js';

afterEach(() => vi.clearAllMocks());

describe('customer consultation service boundary', () => {
  it('reads the complete order route through the customer-service permission boundary', async () => {
    await readCustomerOrderContext({ shopId: 'shop-a', postingNumber: '75577421-0029' });

    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/customer-service/order-route-context?shopId=shop-a&postingNumber=75577421-0029',
      expect.objectContaining({ method: 'GET' })
    );
    expect(mocks.getDomainCache).not.toHaveBeenCalled();
  });

  it('passes the active shop/account and cursor pagination through local-api', async () => {
    const signal = new AbortController().signal;
    await readCustomerChatList(
      { shopId: 'shop-a', accountId: 'account-a', limit: 100, cursor: 'cursor-2' },
      { signal }
    );
    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/customer-service/probe',
      expect.objectContaining({
        method: 'POST',
        signal,
        body: expect.objectContaining({
          shopId: 'shop-a',
          accountId: 'account-a',
          endpointKey: 'chat.list',
          params: { limit: 100, cursor: 'cursor-2' },
        }),
      })
    );
  });

  it('keeps history reads scoped and sends only through the guarded write routes', async () => {
    await readCustomerChatHistory({ shopId: 'shop-a', accountId: 'account-a', chatId: 'chat-1' });
    await previewCustomerMessageSend({ shopId: 'shop-a', chatId: 'chat-1', text: '您好' });
    await confirmCustomerMessageSend({
      previewId: 'preview-1',
      shopId: 'shop-a',
      chatId: 'chat-1',
      text: '您好',
    });

    const bodies = mocks.requestLocalApi.mock.calls.map(([, options]) => options.body);
    expect(bodies[0]).toMatchObject({
      shopId: 'shop-a',
      accountId: 'account-a',
      endpointKey: 'chat.history',
      params: { chat_id: 'chat-1', limit: 50, direction: 'Backward' },
    });
    expect(bodies[1]).toMatchObject({
      endpointKey: 'chat.sendMessage',
      action: 'customerService.chat.sendMessage',
      payload: { chat_id: 'chat-1', text: '您好' },
    });
    expect(bodies[2]).toMatchObject({
      previewId: 'preview-1',
      confirm: true,
      realWrite: true,
      dryRun: false,
      endpointKey: 'chat.sendMessage',
    });
  });

  it('passes the oldest stable message id when requesting an earlier history page', async () => {
    await readCustomerChatHistory({
      shopId: 'shop-a',
      accountId: 'account-a',
      chatId: 'chat-1',
      fromMessageId: '3000000000118021931',
    });

    expect(mocks.requestLocalApi.mock.calls[0][1].body.params).toEqual({
      chat_id: 'chat-1',
      limit: 50,
      direction: 'Backward',
      from_message_id: '3000000000118021931',
    });
  });

  it('waits for the exact shop realtime signal without transport retries', async () => {
    const signal = new AbortController().signal;
    await waitForCustomerServiceRealtimeEvent({ shopId: 'shop-a', afterSequence: 17, timeoutMs: 25000 }, { signal });

    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/customer-service/realtime/wait?shopId=shop-a&afterSequence=17&timeoutMs=25000',
      {
        method: 'GET',
        timeoutMs: 30000,
        signal,
        transportRetry: false,
        observe: false,
      }
    );
  });

  it('initializes the realtime cursor without replaying old page events', async () => {
    await waitForCustomerServiceRealtimeEvent({ shopId: 'shop-a', timeoutMs: 25000 });
    expect(mocks.requestLocalApi.mock.calls[0][0]).toBe(
      '/api/customer-service/realtime/wait?shopId=shop-a&timeoutMs=25000'
    );
  });

  it('builds string message ids and sends mark-all-read through preview and confirm routes', async () => {
    const chats = buildCustomerMarkReadTargets([
      {
        chatId: 'chat-1',
        unreadCount: 2,
        firstUnreadMessageId: '3000000000118021931',
        lastMessageId: '3000000000118021939',
      },
      { chatId: 'chat-2', unreadCount: 0, lastMessageId: '3002' },
    ]);
    expect(chats).toEqual([
      {
        chat_id: 'chat-1',
        from_message_id: '3000000000118021939',
        first_unread_message_id: '3000000000118021931',
        last_message_id: '3000000000118021939',
        unread_count: 2,
      },
    ]);

    await previewCustomerMarkAllRead({ shopId: 'shop-a', chats });
    await confirmCustomerMarkAllRead({ previewId: 'preview-read-1', shopId: 'shop-a', chats });
    const bodies = mocks.requestLocalApi.mock.calls.map(([, options]) => options.body);
    expect(bodies[0]).toMatchObject({
      endpointKey: 'chat.read',
      action: 'customerService.chat.markAllRead',
      payload: { chats },
    });
    expect(bodies[1]).toMatchObject({
      previewId: 'preview-read-1',
      endpointKey: 'chat.read',
      action: 'customerService.chat.markAllRead',
      realWrite: true,
      dryRun: false,
      payload: { chats },
    });
  });

  it('uses the latest rendered inbound message as the exact Ozon read boundary', () => {
    expect(
      buildCustomerMarkReadTargets([
        {
          chatId: 'chat-rendered',
          unreadCount: 3,
          firstUnreadMessageId: '3001',
          lastMessageId: '3005',
          readThroughMessageId: '3004',
        },
      ])
    ).toEqual([
      {
        chat_id: 'chat-rendered',
        from_message_id: '3004',
        first_unread_message_id: '3001',
        last_message_id: '3005',
        unread_count: 3,
      },
    ]);
  });

  it('does not submit synthetic display-only notification rows to chat.read', () => {
    expect(
      buildCustomerMarkReadTargets([
        {
          chatId: 'notification-center-row',
          unreadCount: 4,
          lastMessageId: 'fake-message-id',
          markReadSupported: false,
        },
        {
          chatId: 'real-chat',
          unreadCount: 1,
          lastMessageId: '3009',
        },
      ])
    ).toEqual([
      {
        chat_id: 'real-chat',
        from_message_id: '3009',
        first_unread_message_id: null,
        last_message_id: '3009',
        unread_count: 1,
      },
    ]);
  });

  it('does not submit push-only rows when an older payload omitted markReadSupported', () => {
    const targets = buildCustomerMarkReadTargets([
      {
        chatId: 'push-chat',
        category: 'notification',
        channel: 'push',
        unreadCount: 1,
        lastMessageId: 'push-message',
      },
    ]);

    expect(targets).toEqual([]);
  });

  it('reads seller profile through the customer-service local-api boundary', async () => {
    await readCustomerShopProfile({ shopId: 'shop-a', accountId: 'account-a' });
    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/customer-service/probe',
      expect.objectContaining({
        body: expect.objectContaining({
          shopId: 'shop-a',
          accountId: 'account-a',
          endpointKey: 'shop.sellerInfo',
          requestedBy: 'customer-consultation-shop-profile',
        }),
      })
    );
  });

  it('reads and saves push view markers through the scoped SQLite boundary', async () => {
    const signal = new AbortController().signal;
    await readCustomerPushViewMarkers({ shopId: 'shop-a', accountId: 'account-a' }, { signal });
    await saveCustomerPushViewMarker({
      shopId: 'shop-a',
      accountId: 'account-a',
      chatId: 'push-chat',
      lastMessageId: 'message-1',
    });

    expect(mocks.requestLocalApi).toHaveBeenNthCalledWith(
      1,
      '/api/customer-service/push-view-markers/list',
      expect.objectContaining({
        method: 'POST',
        signal,
        body: { shopId: 'shop-a', accountScope: 'account-a' },
      })
    );
    expect(mocks.requestLocalApi).toHaveBeenNthCalledWith(
      2,
      '/api/customer-service/push-view-markers',
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({
          shopId: 'shop-a',
          accountScope: 'account-a',
          chatId: 'push-chat',
          lastMessageId: 'message-1',
        }),
      })
    );
  });

  it('sends a cancellation command when an active translation is aborted', async () => {
    let resolveTranslation;
    mocks.requestLocalApi
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTranslation = resolve;
          })
      )
      .mockResolvedValueOnce({ ok: true, cancelled: true });
    const controller = new AbortController();
    const pending = translateCustomerChatMessages(
      { messages: [{ id: 'message-1', text: 'Привет' }] },
      { signal: controller.signal }
    );
    const requestId = mocks.requestLocalApi.mock.calls[0][1].body.requestId;

    controller.abort();
    await Promise.resolve();
    expect(mocks.requestLocalApi).toHaveBeenNthCalledWith(
      2,
      '/api/customer-service/translate/cancel',
      expect.objectContaining({
        method: 'POST',
        body: { requestId },
        observe: false,
      })
    );

    resolveTranslation({ ok: true, rows: [] });
    await pending;
  });
});

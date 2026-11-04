import {
  mergeCustomerChatHistory,
  mergeCustomerConversations,
  normalizeCustomerChatList,
} from './customerOzonChatFormatter.js';
import { describe, expect, it } from 'vitest';

const listPayload = {
  ok: true,
  data: {
    chats: [
      {
        unread_count: 0,
        last_message_id: '3002',
        chat: {
          chat_id: 'buyer-chat-1',
          chat_status: 'OPENED',
          chat_type: 'BUYER_SELLER',
          created_at: '2026-07-08T10:27:53.151592Z',
        },
      },
      {
        unread_count: 4,
        last_message_id: '3001',
        chat: {
          chat_id: 'notification-chat-1',
          chat_status: 'OPENED',
          chat_type: 'UNSPECIFIED',
          created_at: '2026-05-06T03:50:39.470916Z',
        },
      },
    ],
  },
};

describe('customer Ozon chat formatter', () => {
  it('maps Ozon chat.list rows into buyer conversations and read-only information pushes', () => {
    const rows = normalizeCustomerChatList(listPayload);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'buyer-chat-1',
      category: 'buyer',
      channel: 'chat',
      replyEnabled: true,
      chatType: 'BUYER_SELLER',
    });
    expect(rows[1]).toMatchObject({
      id: 'notification-chat-1',
      category: 'notification',
      channel: 'push',
      replyEnabled: false,
      markReadSupported: false,
      markReadUnavailableReason: 'Ozon 信息推送为只读，未提供 chat.read',
      unread: 4,
    });
  });

  it('keeps platform support and notification push chats out of chat.read writes', () => {
    const rows = normalizeCustomerChatList({
      data: {
        chats: [
          {
            unread_count: 1,
            last_message_id: 'support-1',
            chat: { chat_id: 'support-chat', chat_type: 'SELLER_SUPPORT' },
          },
          {
            unread_count: 1,
            last_message_id: 'content-1',
            chat: { chat_id: 'content-chat', chat_type: 'SELLER_NOTIFICATION_UPDATE_CONTENT' },
          },
        ],
      },
    });

    expect(rows.every((row) => row.markReadSupported === false)).toBe(true);
    expect(rows.every((row) => row.channel === 'push')).toBe(true);
  });

  it('removes Ozon chat shells that have no message id, unread state or preview content', () => {
    const rows = normalizeCustomerChatList({
      data: {
        chats: [
          {
            unread_count: 0,
            first_unread_message_id: 0,
            last_message_id: 0,
            chat: {
              chat_id: 'empty-chat-shell',
              chat_status: 'OPENED',
              chat_type: 'BUYER_SELLER',
              created_at: '2026-08-20T03:21:00.000Z',
            },
          },
          {
            unread_count: 0,
            last_message_id: 'real-message-1',
            chat: {
              chat_id: 'real-chat',
              chat_status: 'OPENED',
              chat_type: 'BUYER_SELLER',
            },
          },
        ],
      },
    });

    expect(rows.map((row) => row.conversationId)).toEqual(['real-chat']);
  });

  it('lets a fresh zero unread_count replace an older merged value', () => {
    const base = normalizeCustomerChatList(listPayload)[0];
    const merged = mergeCustomerConversations([
      { ...base, unreadCount: 4, unread: 4, lastMessageAt: '2026-07-08T10:30:00.000Z' },
      { ...base, unreadCount: 0, unread: 0, lastMessageAt: '2026-07-08T10:20:00.000Z' },
    ]);

    expect(merged[0]).toMatchObject({ unreadCount: 0, unread: 0, readState: 'read' });
  });

  it('maps chat.history in chronological thread order and extracts the full posting number', () => {
    const conversation = normalizeCustomerChatList(listPayload)[0];
    const merged = mergeCustomerChatHistory(conversation, {
      ok: true,
      data: {
        has_next: false,
        messages: [
          {
            message_id: '3002',
            user: { id: '56439103', type: 'Customer' },
            created_at: '2026-07-08T10:28:53.121661Z',
            is_read: true,
            data: ['Товар не понравился, хочу сделать возврат'],
            context: { sku: '', order_number: '' },
          },
          {
            message_id: '3001',
            user: { id: '56439103', type: 'Customer' },
            created_at: '2026-07-08T10:28:25.036183Z',
            is_read: true,
            data: ['56439103-0025-1', 'Хочу сделать возврат'],
            context: { sku: '', order_number: '56439103-0025' },
          },
        ],
      },
    });

    expect(merged.title).toBe('买家 56439103');
    expect(merged.orderNumber).toBe('56439103-0025-1');
    expect(merged.messages.map((message) => message.id)).toEqual(['3001', '3002']);
    expect(merged.messages.every((message) => message.role === 'buyer')).toBe(true);
    expect(merged.historyLoaded).toBe(true);
  });

  it('prepends an earlier history page without dropping or duplicating the current page', () => {
    const conversation = mergeCustomerChatHistory(normalizeCustomerChatList(listPayload)[0], {
      data: {
        has_next: true,
        messages: [
          {
            message_id: '3002',
            user: { id: '56439103', type: 'Customer' },
            created_at: '2026-07-08T10:28:53.121661Z',
            data: ['第二页最新消息'],
          },
          {
            message_id: '3001',
            user: { id: '56439103', type: 'Customer' },
            created_at: '2026-07-08T10:28:25.036183Z',
            data: ['第二页最早消息'],
          },
        ],
      },
    });

    const merged = mergeCustomerChatHistory(
      conversation,
      {
        data: {
          has_next: false,
          messages: [
            {
              message_id: '3001',
              user: { id: '56439103', type: 'Customer' },
              created_at: '2026-07-08T10:28:25.036183Z',
              data: ['边界重复消息'],
            },
            {
              message_id: '3000',
              user: { id: '56439103', type: 'Customer' },
              created_at: '2026-07-08T10:27:00.000Z',
              data: ['更早消息'],
            },
          ],
        },
      },
      { appendOlder: true }
    );

    expect(merged.messages.map((message) => message.id)).toEqual(['3000', '3001', '3002']);
    expect(merged.historyCursor).toBe('3000');
    expect(merged.historyHasNext).toBe(false);
    expect(merged.lastMessage).toBe('第二页最新消息');
  });

  it('keeps Ozon notification messages read-only and derives a clean notification title', () => {
    const conversation = normalizeCustomerChatList(listPayload)[1];
    const merged = mergeCustomerChatHistory(conversation, {
      data: {
        messages: [
          {
            message_id: '4001',
            user: { id: 'o3_notification_user_sc', type: 'NotificationUser' },
            created_at: '2026-07-09T23:35:52.803619Z',
            is_read: false,
            data: ['**realFBS 工作模式恢复销售**\n请继续监控服务指标。'],
            context: { sku: '', order_number: '' },
          },
        ],
      },
    });

    expect(merged.channel).toBe('push');
    expect(merged.replyEnabled).toBe(false);
    expect(merged.title).toBe('realFBS 工作模式恢复销售');
    expect(merged.messages[0]).toMatchObject({ role: 'system', source: 'Ozon 通知' });
    expect(merged.messages[0].text).not.toContain('**');
  });

  it('extracts Ozon Markdown image messages into real image attachments', () => {
    const conversation = normalizeCustomerChatList(listPayload, { shopId: 'shop-2' })[0];
    const imageUrl =
      'https://api-seller.ozon.ru/v2/chat/file/messenger-rotated-3/40ff6bb2-d55b-41d6-8dd2-5c69512acd54.jpg';
    const merged = mergeCustomerChatHistory(conversation, {
      data: {
        messages: [
          {
            message_id: 'image-1',
            user: { id: '266352337', type: 'Customer' },
            created_at: '2026-08-12T19:30:00.000Z',
            data: [`![](${imageUrl})`],
          },
        ],
      },
    });

    expect(merged.messages[0]).toMatchObject({
      text: '[图片消息]',
      content: '[图片消息]',
      contentType: 'image',
      attachments: [
        {
          type: 'image',
          url: imageUrl,
          name: '40ff6bb2-d55b-41d6-8dd2-5c69512acd54.jpg',
          source: 'ozon-markdown-image',
        },
      ],
    });
    expect(merged.lastMessage).toBe('[图片消息]');
  });

  it('extracts Ozon Markdown file messages into real file attachments', () => {
    const conversation = normalizeCustomerChatList(listPayload, { shopId: 'shop-2' })[0];
    const fileUrl =
      'https://api-seller.ozon.ru/v2/chat/file/messenger-rotated-3/813e481a-e554-477c-847e-2b63b3a88c50.txt';
    const merged = mergeCustomerChatHistory(conversation, {
      data: {
        messages: [
          {
            message_id: '3000000441969932523',
            user: { id: '4067587', type: 'Seller' },
            created_at: '2026-08-21T13:11:43.398645Z',
            data: [`[customer-consultation-ozon-send-test.txt (52B)](${fileUrl})`],
          },
        ],
      },
    });

    expect(merged.messages[0]).toMatchObject({
      text: '[附件消息]',
      content: '[附件消息]',
      attachments: [
        {
          type: 'file',
          url: fileUrl,
          name: 'customer-consultation-ozon-send-test.txt',
          source: 'ozon-markdown-file',
        },
      ],
    });
    expect(merged.lastMessage).toBe('[附件消息]');
  });
});

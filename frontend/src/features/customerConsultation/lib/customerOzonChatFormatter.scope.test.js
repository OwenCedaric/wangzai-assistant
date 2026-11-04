import {
  dedupeCustomerMessages,
  formatCustomerChatDateTime,
  mergeCustomerChatHistory,
  mergeCustomerConversations,
  normalizeCustomerChatList,
} from './customerOzonChatFormatter.js';
import { describe, expect, it } from 'vitest';

function chatPayload(shopId, rows) {
  return {
    data: {
      chats: rows.map((row) => ({
        unread_count: row.unread ?? 0,
        last_message_id: row.lastMessageId ?? row.chatId,
        chat: {
          chat_id: row.chatId,
          chat_type: 'BUYER_SELLER',
          chat_status: row.status || 'OPENED',
          created_at: row.createdAt || '2026-07-18T00:00:00.000Z',
        },
      })),
    },
    shopId,
  };
}

describe('customer consultation scope, dedupe and time model', () => {
  it('isolates same chat ids by shop/account scope and keeps missing ids separate', () => {
    const shopA = normalizeCustomerChatList(chatPayload('shop-a', [{ chatId: 'same-chat' }]), {
      shopId: 'shop-a',
      accountScopeKey: 'account-a',
    });
    const shopB = normalizeCustomerChatList(chatPayload('shop-b', [{ chatId: 'same-chat' }]), {
      shopId: 'shop-b',
      accountScopeKey: 'account-b',
    });
    expect(shopA[0].id).not.toBe(shopB[0].id);
    expect(shopA[0]).toMatchObject({ shopId: 'shop-a', conversationId: 'same-chat' });

    const missing = normalizeCustomerChatList(
      chatPayload('shop-a', [
        { chatId: '', lastMessageId: 'm-1' },
        { chatId: '', lastMessageId: 'm-2' },
      ]),
      { shopId: 'shop-a', accountScopeKey: 'account-a' }
    );
    expect(missing).toHaveLength(2);
  });

  it('deduplicates conversations across pages and sorts by newest message time', () => {
    const rows = normalizeCustomerChatList(
      chatPayload('shop-a', [
        { chatId: 'old', createdAt: '2026-07-17T00:00:00.000Z' },
        { chatId: 'new', createdAt: '2026-07-18T00:00:00.000Z' },
      ]),
      { shopId: 'shop-a', accountScopeKey: 'account-a' }
    );
    const duplicatePage = normalizeCustomerChatList(
      chatPayload('shop-a', [{ chatId: 'old', createdAt: '2026-07-17T00:00:00.000Z' }]),
      { shopId: 'shop-a', accountScopeKey: 'account-a' }
    );
    const merged = mergeCustomerConversations([...rows, ...duplicatePage]);
    expect(merged.map((row) => row.conversationId)).toEqual(['new', 'old']);
    expect(merged).toHaveLength(2);
  });

  it('deduplicates repeated message ids, keeps standard fields, and formats Beijing time', () => {
    const conversation = normalizeCustomerChatList(chatPayload('shop-a', [{ chatId: 'chat-1' }]), {
      shopId: 'shop-a',
      accountScopeKey: 'account-a',
    })[0];
    const merged = mergeCustomerChatHistory(conversation, {
      data: {
        messages: [
          {
            message_id: 'm-1',
            user: { id: 'buyer-1', type: 'Customer' },
            created_at: '2026-07-18T00:00:00.000Z',
            data: ['你好'],
            is_read: false,
          },
          {
            message_id: 'm-1',
            user: { id: 'buyer-1', type: 'Customer' },
            created_at: '2026-07-18T00:00:00.000Z',
            data: ['你好'],
            is_read: false,
          },
        ],
      },
    });
    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]).toMatchObject({
      messageId: 'm-1',
      conversationId: 'chat-1',
      senderType: 'buyer',
      content: '你好',
      contentType: 'text',
      rawStatus: 'unread',
    });
    expect(formatCustomerChatDateTime('2026-07-18T00:00:00.000Z')).toBe('2026/07/18 08:00');
  });

  it('does not collapse messages without source ids', () => {
    const rows = [
      { id: 'fallback-1', timestamp: 1, sourceIndex: 0 },
      { id: 'fallback-2', timestamp: 1, sourceIndex: 1 },
    ];
    expect(dedupeCustomerMessages(rows)).toHaveLength(2);
  });
});

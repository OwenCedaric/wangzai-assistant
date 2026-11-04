import {
  createCustomerNotificationConversation,
  getCustomerConversationUnreadBreakdown,
  getCustomerServiceNotifications,
  getFilteredCustomerConversations,
  isCustomerConversationMarkReadSupported,
} from './customerConsultationFormatter.js';
import { describe, expect, it } from 'vitest';

const notificationRows = [
  {
    id: 'product-1',
    domain: 'products',
    title: '商品状态变化',
    summary: '商品审核状态变化',
    createdAt: '2026-07-10T02:00:00.000Z',
  },
  {
    id: 'order-1',
    domain: 'orders',
    eventType: 'order_status_changed',
    title: '订单状态变化',
    summary: '订单已进入待发货',
    postingNumber: '59724481-0031-1',
    shopName: 'Ozon 1店',
    createdAt: '2026-07-10T03:00:00.000Z',
    readAt: null,
  },
  {
    id: 'return-1',
    domain: 'returns',
    eventType: 'return_status_changed',
    title: '售后状态变化',
    summary: '买家提交取消请求',
    createdAt: '2026-07-10T01:00:00.000Z',
    readAt: '2026-07-10T01:30:00.000Z',
  },
];

describe('customer consultation notification formatting', () => {
  it('keeps only customer-service-related Ozon notifications', () => {
    expect(getCustomerServiceNotifications(notificationRows).map((item) => item.id)).toEqual(['order-1', 'return-1']);
  });

  it('builds a read-only push conversation and keeps events in timeline order', () => {
    const conversation = createCustomerNotificationConversation(notificationRows, { status: 'success' });

    expect(conversation.channel).toBe('push');
    expect(conversation.replyEnabled).toBe(false);
    expect(conversation.unread).toBe(1);
    expect(conversation.notificationCount).toBe(2);
    expect(conversation.messages.map((message) => message.id)).toEqual(['push-return-1', 'push-order-1']);
    expect(conversation.messages[1]).toMatchObject({
      role: 'system',
      title: '订单状态变化',
      orderNumber: '59724481-0031-1',
    });
  });

  it('separates actionable chat unread counts from display-only notification rows', () => {
    const buyer = {
      chatId: 'buyer-chat',
      firstUnreadMessageId: '3001',
      unreadCount: 2,
    };
    const displayOnly = {
      chatId: 'notification-center-row',
      unreadCount: 3,
      markReadSupported: false,
    };

    expect(isCustomerConversationMarkReadSupported(buyer)).toBe(true);
    expect(isCustomerConversationMarkReadSupported(displayOnly)).toBe(false);
    expect(getCustomerConversationUnreadBreakdown([buyer, displayOnly])).toMatchObject({
      total: 5,
      actionable: 2,
      readOnly: 3,
      actionableConversations: 1,
      readOnlyConversations: 1,
    });
  });

  it('supports buyer, notification and support categories plus system-message search', () => {
    const pushConversation = createCustomerNotificationConversation(notificationRows, { status: 'success' });
    const buyerConversation = {
      id: 'chat-1',
      category: 'buyer',
      channel: 'chat',
      title: 'Maria',
      messages: [{ title: '物流状态更新', text: '订单已交由物流配送', source: 'Ozon 物流' }],
    };
    const supportConversation = {
      id: 'support-1',
      category: 'support',
      channel: 'push',
      title: 'Ozon 支持',
      messages: [],
    };

    expect(getFilteredCustomerConversations([buyerConversation, pushConversation], 'buyer', '')).toEqual([
      buyerConversation,
    ]);
    expect(getFilteredCustomerConversations([buyerConversation, pushConversation], 'notification', '')).toEqual([
      pushConversation,
    ]);
    expect(getFilteredCustomerConversations([buyerConversation, supportConversation], 'support', '')).toEqual([
      supportConversation,
    ]);
    expect(getFilteredCustomerConversations([buyerConversation, pushConversation], 'all', '物流配送')).toEqual([
      buyerConversation,
    ]);
  });

  it('applies an independent status filter and unread filter', () => {
    const waiting = {
      id: 'waiting',
      category: 'buyer',
      statusKey: 'waiting',
      unreadCount: 2,
      title: '买家 A',
    };
    const completed = {
      id: 'completed',
      category: 'buyer',
      statusKey: 'completed',
      unreadCount: 0,
      title: '买家 B',
    };
    expect(
      getFilteredCustomerConversations([waiting, completed], 'all', '', {
        statusId: 'waiting',
        unreadOnly: true,
      })
    ).toEqual([waiting]);
  });

  it('searches hydrated buyer ids, chat ids and Ozon sku fields', () => {
    const conversation = {
      id: 'chat-row',
      category: 'buyer',
      customerId: '266113191',
      chatId: 'chat-uuid-1',
      ozonSku: '5100877464',
    };
    expect(getFilteredCustomerConversations([conversation], 'all', '266113191')).toEqual([conversation]);
    expect(getFilteredCustomerConversations([conversation], 'all', 'chat-uuid-1')).toEqual([conversation]);
    expect(getFilteredCustomerConversations([conversation], 'all', '5100877464')).toEqual([conversation]);
  });
});

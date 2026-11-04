import {
  buildCustomerShopUnreadSnapshot,
  mergeCustomerShopUnreadSnapshots,
} from './CustomerGlobalUnreadBridge.jsx';
import { describe, expect, it } from 'vitest';

describe('global customer unread aggregation', () => {
  it('counts only unread buyer conversations and keeps the latest exact chat target', () => {
    const snapshot = buildCustomerShopUnreadSnapshot(
      { id: 'shop-2', shopAlias: 'Ozon 2店' },
      [
        {
          id: 'shop-2::buyer-1',
          chatId: 'buyer-1',
          category: 'buyer',
          unreadCount: 2,
          customerName: '买家甲',
          lastMessageAt: '2026-08-23T01:00:00.000Z',
        },
        {
          id: 'shop-2::buyer-2',
          chatId: 'buyer-2',
          category: 'buyer',
          unreadCount: 1,
          customerName: '买家乙',
          lastMessageAt: '2026-08-23T02:00:00.000Z',
        },
        {
          id: 'shop-2::support',
          chatId: 'support',
          category: 'support',
          unreadCount: 9,
          lastMessageAt: '2026-08-23T03:00:00.000Z',
        },
      ]
    );

    expect(snapshot.unreadCount).toBe(3);
    expect(snapshot.latest).toMatchObject({
      shopId: 'shop-2',
      shopName: 'Ozon 2店',
      conversationId: 'shop-2::buyer-2',
      chatId: 'buyer-2',
      customerName: '买家乙',
    });
  });

  it('turns a fully read store into an empty authoritative snapshot', () => {
    const snapshot = buildCustomerShopUnreadSnapshot(
      { id: 'shop-read', shopAlias: '已读店铺' },
      [
        { id: 'buyer-read', chatId: 'buyer-read', category: 'buyer', unreadCount: 0 },
        { id: 'push-readonly', chatId: 'push-readonly', category: 'support', unreadCount: 6 },
      ]
    );
    expect(snapshot).toMatchObject({ shopId: 'shop-read', unreadCount: 0, latest: null });
  });

  it('merges multiple stores without mixing their exact conversation targets', () => {
    const summary = mergeCustomerShopUnreadSnapshots([
      {
        shopId: 'shop-1',
        unreadCount: 4,
        latest: { shopId: 'shop-1', chatId: 'chat-1', timestamp: 100 },
      },
      {
        shopId: 'shop-2',
        unreadCount: 6,
        latest: { shopId: 'shop-2', chatId: 'chat-2', timestamp: 200 },
      },
    ]);

    expect(summary.unreadCount).toBe(10);
    expect(summary.shopCount).toBe(2);
    expect(summary.latest).toMatchObject({ shopId: 'shop-2', chatId: 'chat-2' });
  });
});

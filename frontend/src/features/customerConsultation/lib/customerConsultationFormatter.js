function normalizeSearchText(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase();
}

const CUSTOMER_NOTIFICATION_DOMAINS = new Set(['orders', 'returns', 'logistics', 'customerService']);

const CUSTOMER_NOTIFICATION_SOURCE_LABELS = Object.freeze({
  orders: 'Ozon 订单',
  returns: 'Ozon 售后',
  logistics: 'Ozon 物流',
  customerService: 'Ozon 消息',
});

function formatNotificationTime(value, includeDate = false) {
  const formatted = formatCustomerChatDateTime(value, { compact: !includeDate });
  if (!includeDate) return formatted === '时间未知' ? '时间未知' : formatted;
  const [, month, day, time] = formatted.match(/^\d{4}\/(\d{2})\/(\d{2})\s(.+)$/u) || [];
  return month && day && time ? `${month}/${day} ${time}` : formatted;
}

export function getCustomerServiceNotifications(rows = []) {
  const byKey = new Map();
  rows
    .filter((notification) => CUSTOMER_NOTIFICATION_DOMAINS.has(notification?.domain))
    .forEach((notification, index) => {
      const id = String(notification?.id ?? '').trim();
      const shopId = String(notification?.shopId ?? notification?.shop_id ?? '').trim();
      const key = id ? `${shopId}::${id}` : `missing-${index}`;
      if (!byKey.has(key)) byKey.set(key, notification);
    });
  return [...byKey.values()].sort((left, right) =>
    String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
  );
}

export function createCustomerNotificationConversation(rows = [], loadState = {}) {
  const notifications = getCustomerServiceNotifications(rows);
  const latest = notifications[0] || null;
  const status = loadState.status === 'loading' ? '读取中' : loadState.status === 'error' ? '读取失败' : '已同步';
  const lastMessage =
    latest?.summary || latest?.message || (loadState.error ? '信息推送读取失败' : '暂无新的订单、物流或售后推送');

  return {
    id: 'ozon-information-push',
    conversationId: 'ozon-information-push',
    shopId: String(latest?.shopId || latest?.shop_id || '').trim(),
    customerId: '',
    customerName: 'Ozon 信息推送',
    statusKey: notifications.some((notification) => !notification.readAt) ? 'waiting' : 'completed',
    unreadCount: notifications.filter((notification) => !notification.readAt).length,
    readState: notifications.some((notification) => !notification.readAt) ? 'unread' : 'read',
    markReadSupported: false,
    markReadUnavailableReason: '通知中心推送没有可用的 chat.read 会话标识',
    lastMessageText: lastMessage,
    lastMessageAt: latest?.createdAt || '',
    orderId: latest?.postingNumber || '',
    productId: latest?.offerId || '',
    productTitle: latest?.summary || '未关联商品',
    productImage: '',
    source: 'Ozon 通知中心',
    rawStatus: loadState.status || '',
    category: 'notification',
    channel: 'push',
    replyEnabled: false,
    chatId: 'Ozon Push Notification',
    title: 'Ozon 信息推送',
    subtitle: '订单、物流与售后变化',
    lastMessage,
    time: latest ? formatNotificationTime(latest.createdAt) : '',
    unread: notifications.filter((notification) => !notification.readAt).length,
    status,
    orderNumber: latest?.postingNumber || '—',
    orderStatus: latest?.title || '暂无推送',
    sku: latest?.offerId || '—',
    productName: latest?.summary || '仅展示与客服处理相关的 Ozon 推送',
    shopName: latest?.shopName || '当前店铺',
    updatedAt: latest ? formatNotificationTime(latest.createdAt, true) : '尚无记录',
    notificationError: loadState.error || '',
    notificationCount: notifications.length,
    messages: [...notifications].reverse().map((notification, index) => ({
      id: `push-${notification.id || index}`,
      messageId: String(notification.id || `notification-${index}`),
      conversationId: 'ozon-information-push',
      senderType: 'system',
      senderName: CUSTOMER_NOTIFICATION_SOURCE_LABELS[notification.domain] || 'Ozon',
      content: notification.summary || notification.message || '后台同步发现一条变化。',
      contentType: 'text',
      sentAt: notification.createdAt || '',
      readAt: notification.readAt || '',
      attachments: [],
      rawStatus: notification.readAt ? 'read' : 'unread',
      role: 'system',
      userType: 'crm',
      source: CUSTOMER_NOTIFICATION_SOURCE_LABELS[notification.domain] || 'Ozon',
      domain: notification.domain,
      eventType: notification.eventType,
      title: notification.title || 'Ozon 信息更新',
      text: notification.summary || notification.message || '后台同步发现一条变化。',
      time: formatNotificationTime(notification.createdAt, true),
      orderNumber: notification.postingNumber || '',
      shopName: notification.shopName || '',
      read: Boolean(notification.readAt),
    })),
  };
}

export function getFilteredCustomerConversations(
  conversations = [],
  filterId = 'all',
  searchText = '',
  { statusId = 'all', unreadOnly = false } = {}
) {
  const query = normalizeSearchText(searchText);

  return conversations.filter((conversation) => {
    if ((filterId === 'unread' || unreadOnly) && !conversation.unreadCount && !conversation.unread) {
      return false;
    }
    if (filterId === 'buyer' && conversation.category !== 'buyer') return false;
    if (filterId === 'notification' && conversation.category !== 'notification') return false;
    if (filterId === 'support' && conversation.category !== 'support') return false;
    if (statusId !== 'all' && conversation.statusKey !== statusId) return false;
    if (!query) return true;

    return [
      conversation.customerName,
      conversation.customerId,
      conversation.chatId,
      conversation.conversationId,
      conversation.title,
      conversation.subtitle,
      conversation.status,
      conversation.lastMessage,
      conversation.lastMessageText,
      conversation.orderNumber,
      conversation.orderId,
      conversation.sku,
      conversation.ozonSku,
      conversation.productId,
      conversation.productName,
      conversation.productTitle,
      ...(conversation.messages || []).flatMap((message) => [message.title, message.text, message.source]),
    ].some((value) => normalizeSearchText(value).includes(query));
  });
}

export function getSelectedCustomerConversation(conversations = [], selectedConversationId) {
  return conversations.find((conversation) => conversation.id === selectedConversationId) || conversations[0] || null;
}

function getConversationUnreadValue(conversation = {}) {
  const count = Number(conversation.unreadCount ?? conversation.unread);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function isCustomerConversationMarkReadSupported(conversation = {}) {
  if (
    conversation?.markReadSupported === false ||
    (conversation?.channel === 'push' && conversation?.category !== 'buyer')
  ) {
    return false;
  }
  const chatId = String(conversation?.chatId ?? conversation?.conversationId ?? '').trim();
  const messageId = String(conversation?.firstUnreadMessageId || conversation?.lastMessageId || '').trim();
  return Boolean(chatId && messageId);
}

export function getCustomerConversationUnreadBreakdown(conversations = []) {
  return conversations.reduce(
    (summary, conversation) => {
      const unread = getConversationUnreadValue(conversation);
      if (!unread) return summary;
      summary.total += unread;
      if (isCustomerConversationMarkReadSupported(conversation)) {
        summary.actionable += unread;
        summary.actionableConversations += 1;
      } else {
        summary.readOnly += unread;
        summary.readOnlyConversations += 1;
      }
      return summary;
    },
    {
      total: 0,
      actionable: 0,
      readOnly: 0,
      actionableConversations: 0,
      readOnlyConversations: 0,
    }
  );
}

export function getCustomerConversationUnreadCount(conversations = []) {
  return getCustomerConversationUnreadBreakdown(conversations).total;
}
import { formatCustomerChatDateTime } from './customerOzonChatFormatter.js';

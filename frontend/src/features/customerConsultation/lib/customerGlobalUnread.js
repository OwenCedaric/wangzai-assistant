function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeUnreadCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function getShopName(shop = {}) {
  return normalizeText(shop.sellerName || shop.shopAlias || shop.name || shop.alias) || 'Ozon 店铺';
}

function getConversationTime(conversation = {}) {
  const timestamp = Date.parse(conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function buildCustomerShopUnreadSnapshot(shop = {}, rows = []) {
  const shopId = normalizeText(shop.id);
  const unreadRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.category === 'buyer' && normalizeUnreadCount(row?.unreadCount ?? row?.unread) > 0)
    .sort((left, right) => getConversationTime(right) - getConversationTime(left));
  const latest = unreadRows[0] || null;
  return {
    shopId,
    shopName: getShopName(shop),
    unreadCount: unreadRows.reduce(
      (total, row) => total + normalizeUnreadCount(row?.unreadCount ?? row?.unread),
      0
    ),
    latest: latest
      ? {
          shopId,
          shopName: getShopName(shop),
          conversationId: normalizeText(latest.id),
          chatId: normalizeText(latest.chatId || latest.conversationId),
          customerName: normalizeText(latest.customerName || latest.title) || 'Ozon 买家',
          lastMessageText: normalizeText(latest.lastMessageText || latest.lastMessage) || '收到新的买家消息',
          lastMessageAt: normalizeText(latest.lastMessageAt || latest.updatedAt || latest.createdAt),
          timestamp: getConversationTime(latest),
        }
      : null,
  };
}

export function mergeCustomerShopUnreadSnapshots(snapshots = []) {
  const rows = (Array.isArray(snapshots) ? snapshots : []).filter((snapshot) => snapshot?.shopId);
  const latest = rows
    .map((snapshot) => snapshot.latest)
    .filter(Boolean)
    .sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0))[0] || null;
  return {
    unreadCount: rows.reduce((total, snapshot) => total + normalizeUnreadCount(snapshot.unreadCount), 0),
    shopCount: rows.filter((snapshot) => normalizeUnreadCount(snapshot.unreadCount) > 0).length,
    latest,
  };
}

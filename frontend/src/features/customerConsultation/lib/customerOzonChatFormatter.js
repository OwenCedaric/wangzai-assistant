import { translateCustomerConversationStatus } from './customerConsultationLocale.js';

const BEIJING_TIME_ZONE = 'Asia/Shanghai';
const BEIJING_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BEIJING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function normalizeText(value) {
  return String(value ?? '').trim();
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function getBeijingDateParts(value) {
  const date = parseDate(value);
  if (!date) return null;
  const parts = Object.fromEntries(
    BEIJING_DATE_TIME_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    key: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function getBeijingDayKeyOffset(value, dayOffset) {
  const date = parseDate(value);
  if (!date) return '';
  const shifted = new Date(date.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  return getBeijingDateParts(shifted)?.key || '';
}

export function formatCustomerChatDateTime(value, { compact = false, now = new Date() } = {}) {
  const parts = getBeijingDateParts(value);
  if (!parts) return '时间未知';
  const time = `${parts.hour}:${parts.minute}`;
  if (!compact) return `${parts.year}/${parts.month}/${parts.day} ${time}`;

  const current = getBeijingDateParts(now);
  if (parts.key === current?.key) return time;
  if (parts.key === getBeijingDayKeyOffset(now, -1)) return `昨天 ${time}`;
  return `${parts.month}/${parts.day} ${time}`;
}

function getChatTypeMeta(chatType = '') {
  const normalized = normalizeText(chatType).toUpperCase();
  if (normalized === 'BUYER_SELLER') {
    return {
      category: 'buyer',
      channel: 'chat',
      replyEnabled: true,
      markReadSupported: true,
      title: 'Ozon 买家',
      subtitle: 'Ozon 买家咨询',
    };
  }
  if (normalized === 'SELLER_SUPPORT') {
    return {
      category: 'support',
      channel: 'push',
      replyEnabled: false,
      markReadSupported: false,
      markReadUnavailableReason: 'Ozon 平台支持推送为只读，未提供 chat.read',
      title: 'Ozon 支持',
      subtitle: '平台支持会话',
    };
  }
  if (normalized === 'SELLER_NOTIFICATION_UPDATE_CONTENT') {
    return {
      category: 'notification',
      channel: 'push',
      replyEnabled: false,
      markReadSupported: false,
      markReadUnavailableReason: 'Ozon 内容通知为只读，未提供 chat.read',
      title: 'Ozon 内容通知',
      subtitle: '商品与内容更新',
    };
  }
  return {
    category: 'notification',
    channel: 'push',
    replyEnabled: false,
    markReadSupported: false,
    markReadUnavailableReason: 'Ozon 信息推送为只读，未提供 chat.read',
    title: 'Ozon 信息推送',
    subtitle: '平台运营与订单通知',
  };
}

function extractProbeData(payload = {}) {
  if (payload?.data && typeof payload.data === 'object') return payload.data;
  if (payload?.scheduler?.cache?.payload && typeof payload.scheduler.cache.payload === 'object') {
    return payload.scheduler.cache.payload;
  }
  for (const key of ['payload_json', 'data_json']) {
    const raw = payload?.scheduler?.cache?.[key] ?? payload?.cache?.[key];
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function createConversationRenderId({ accountScopeKey, shopId, chatId, index, createdAt, lastMessageId }) {
  const scope = normalizeText(accountScopeKey) || normalizeText(shopId);
  if (chatId && !scope) return chatId;
  if (chatId) return `${scope}::${chatId}`;
  return `${scope || 'unknown-shop'}::missing-chat-${index}-${createdAt || 'unknown-time'}-${lastMessageId || 'unknown-message'}`;
}

function getConversationTimestamp(conversation = {}) {
  return parseDate(conversation.lastMessageAt || conversation.createdAt)?.getTime() || 0;
}

function getConversationMergeKey(conversation = {}, index = 0) {
  if (!conversation.conversationId) return `missing:${conversation.id}:${index}`;
  return `${conversation.accountScopeKey || conversation.shopId || 'unknown-shop'}::${conversation.conversationId}`;
}

function mergeConversationPair(current, incoming) {
  const currentTime = getConversationTimestamp(current);
  const incomingTime = getConversationTimestamp(incoming);
  const latest = incomingTime >= currentTime ? incoming : current;
  const previous = latest === incoming ? current : incoming;
  const messages = dedupeCustomerMessages([...(previous.messages || []), ...(latest.messages || [])]);
  // A refreshed Ozon list is authoritative. Using Math.max here made an old
  // unread value survive a successful chat.read readback indefinitely.
  const incomingHasUnread =
    Object.prototype.hasOwnProperty.call(incoming, 'unreadCount') ||
    Object.prototype.hasOwnProperty.call(incoming, 'unread');
  const latestHasUnread =
    Object.prototype.hasOwnProperty.call(latest, 'unreadCount') ||
    Object.prototype.hasOwnProperty.call(latest, 'unread');
  const unreadCount = incomingHasUnread
    ? Math.max(Number(incoming.unreadCount ?? incoming.unread) || 0, 0)
    : latestHasUnread
      ? Math.max(Number(latest.unreadCount ?? latest.unread) || 0, 0)
      : Math.max(Number(previous.unreadCount ?? previous.unread) || 0, 0);
  return {
    ...previous,
    ...latest,
    unread: unreadCount,
    unreadCount,
    readState: unreadCount > 0 ? 'unread' : 'read',
    messages,
    notificationCount: messages.length || latest.notificationCount || previous.notificationCount || 0,
    historyLoaded: Boolean(current.historyLoaded || incoming.historyLoaded),
  };
}

export function mergeCustomerConversations(rows = [], { maxRows = Number.MAX_SAFE_INTEGER } = {}) {
  const byKey = new Map();
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const key = getConversationMergeKey(row, index);
    const current = byKey.get(key);
    byKey.set(key, current ? mergeConversationPair(current, row) : row);
  });

  return [...byKey.values()]
    .sort((left, right) => {
      const timeDelta = getConversationTimestamp(right) - getConversationTimestamp(left);
      if (timeDelta) return timeDelta;
      return String(left.id).localeCompare(String(right.id), 'zh-CN');
    })
    .slice(0, Math.max(1, Number(maxRows) || Number.MAX_SAFE_INTEGER));
}

export function normalizeCustomerChatList(
  payload = {},
  { shopId = '', accountScopeKey = '', shopName = '当前 Ozon 店铺' } = {}
) {
  const data = extractProbeData(payload);
  const rows = Array.isArray(data.chats) ? data.chats : [];
  const normalizedRows = rows.map((row, index) => {
    const chat = row?.chat && typeof row.chat === 'object' ? row.chat : {};
    const chatId = normalizeText(chat.chat_id || chat.chatId);
    const chatType = normalizeText(chat.chat_type || chat.chatType || 'UNSPECIFIED').toUpperCase();
    const meta = getChatTypeMeta(chatType);
    const unreadCount = Math.max(Number(row.unread_count ?? row.unreadCount ?? row.unread) || 0, 0);
    const rawStatus = normalizeText(chat.chat_status || chat.chatStatus);
    const statusMeta = translateCustomerConversationStatus(rawStatus, {
      unreadCount,
      buyerConversation: chatType === 'BUYER_SELLER',
    });
    const createdAt = normalizeText(chat.created_at || chat.createdAt);
    const lastMessageAt = normalizeText(
      row.last_message_created_at || row.lastMessageCreatedAt || chat.updated_at || chat.updatedAt || createdAt
    );
    const lastMessageId = normalizeText(row.last_message_id || row.lastMessageId);
    const firstUnreadMessageId = normalizeText(row.first_unread_message_id || row.firstUnreadMessageId);
    const listMessage = row.last_message || row.lastMessage;
    const providedLastMessageText =
      listMessage && typeof listMessage === 'object'
        ? cleanCustomerMessageText(getRawMessageText(listMessage))
        : normalizeText(row.last_message_text || row.lastMessageText);
    const isEmptyConversationShell = Boolean(
      chatId && !lastMessageId && !firstUnreadMessageId && unreadCount === 0 && !providedLastMessageText
    );
    if (isEmptyConversationShell) return null;
    const markReadSupported = Boolean(
      meta.markReadSupported !== false && chatId && (firstUnreadMessageId || lastMessageId)
    );
    const customer = row?.customer && typeof row.customer === 'object' ? row.customer : {};
    const customerId = normalizeText(
      customer.id || customer.customer_id || chat.customer_id || chat.customerId || row.customer_id
    );
    const customerName =
      normalizeText(customer.name || customer.display_name || chat.customer_name || row.customer_name) ||
      (meta.category === 'buyer' ? '买家信息待回读' : meta.title);
    const id = createConversationRenderId({
      accountScopeKey,
      shopId,
      chatId,
      index,
      createdAt,
      lastMessageId,
    });
    const lastMessageText = providedLastMessageText || '点击会话读取最新消息';

    return {
      id,
      conversationId: chatId,
      chatId,
      shopId: normalizeText(shopId),
      accountScopeKey: normalizeText(accountScopeKey) || normalizeText(shopId),
      customerId,
      customerName,
      status: statusMeta.label,
      statusKey: statusMeta.key,
      unreadCount,
      readState: unreadCount > 0 ? 'unread' : 'read',
      markReadSupported,
      markReadUnavailableReason: markReadSupported
        ? ''
        : !chatId
          ? 'Ozon 未返回 chat_id'
          : meta.markReadUnavailableReason || 'Ozon 自动消息为只读，未提供 chat.read',
      lastMessageText,
      lastMessageAt,
      orderId: '',
      productId: '',
      productTitle: '未关联商品',
      productImage: '',
      source: 'Ozon Seller API',
      rawStatus,
      chatType,
      category: meta.category,
      channel: meta.channel,
      replyEnabled: Boolean(meta.replyEnabled && chatId),
      title: customerName,
      subtitle: meta.subtitle,
      lastMessage: lastMessageText,
      time: formatCustomerChatDateTime(lastMessageAt || createdAt, { compact: true }),
      unread: unreadCount,
      orderNumber: '未关联订单',
      orderStatus: '未回读',
      sku: '',
      productName: '未关联商品',
      updatedAt: formatCustomerChatDateTime(lastMessageAt || createdAt),
      createdAt,
      lastMessageId,
      firstUnreadMessageId,
      notificationCount: 0,
      shopName: normalizeText(shopName) || '当前 Ozon 店铺',
      historyLoaded: false,
      historyStatus: 'idle',
      historyError: '',
      historyHasNext: false,
      messages: [],
    };
  });
  return mergeCustomerConversations(normalizedRows);
}

function cleanCustomerMessageText(value) {
  return normalizeText(value)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

const CUSTOMER_MARKDOWN_IMAGE_PATTERN = /!\[([^\]\n]*)\]\(((?:https?:\/\/)[^\s)]+)\)/giu;
const CUSTOMER_MARKDOWN_FILE_PATTERN = /(?<!!)\[([^\]\n]+)\]\(((?:https?:\/\/)[^\s)]+)\)/giu;

function getAttachmentNameFromUrl(url, fallback = '图片') {
  try {
    const fileName = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) || '');
    return fileName || fallback;
  } catch {
    return fallback;
  }
}

function extractMarkdownImageAttachments(value) {
  const source = String(value ?? '');
  return [...source.matchAll(CUSTOMER_MARKDOWN_IMAGE_PATTERN)].map((match) => {
    const url = normalizeText(match[2]);
    const label = normalizeText(match[1]);
    return {
      type: 'image',
      url,
      name: label || getAttachmentNameFromUrl(url),
      source: 'ozon-markdown-image',
    };
  });
}

function cleanMarkdownAttachmentLabel(value) {
  return normalizeText(value).replace(/\s+\(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB)\)$/iu, '');
}

function extractMarkdownFileAttachments(value) {
  const source = String(value ?? '');
  return [...source.matchAll(CUSTOMER_MARKDOWN_FILE_PATTERN)].map((match) => {
    const url = normalizeText(match[2]);
    return {
      type: 'file',
      url,
      name: cleanMarkdownAttachmentLabel(match[1]) || getAttachmentNameFromUrl(url, '附件'),
      source: 'ozon-markdown-file',
    };
  });
}

function stripMarkdownImageAttachments(value) {
  return String(value ?? '')
    .replace(CUSTOMER_MARKDOWN_IMAGE_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripMarkdownAttachments(value) {
  return stripMarkdownImageAttachments(value)
    .replace(CUSTOMER_MARKDOWN_FILE_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getMessageDataRows(message = {}) {
  if (Array.isArray(message.data)) return message.data;
  return message.data == null ? [] : [message.data];
}

function getRawMessageText(message = {}) {
  const text = getMessageDataRows(message)
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return normalizeText(item);
      if (!item || typeof item !== 'object') return '';
      return normalizeText(item.text || item.content || item.caption || item.title);
    })
    .filter(Boolean)
    .join('\n');
  if (text) return text;
  return message.is_image || message.isImage ? '[图片消息]' : '';
}

function getMessageAttachments(message = {}) {
  const attachments = [];
  for (const item of [...getMessageDataRows(message), ...(message.attachments || [])]) {
    if (typeof item === 'string' || typeof item === 'number') {
      attachments.push(...extractMarkdownImageAttachments(item));
      attachments.push(...extractMarkdownFileAttachments(item));
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    attachments.push(...extractMarkdownImageAttachments(item.text || item.content || item.caption || item.title));
    attachments.push(...extractMarkdownFileAttachments(item.text || item.content || item.caption || item.title));
    const url = normalizeText(item.url || item.src || item.image_url || item.file_url);
    if (!url) continue;
    attachments.push({
      type: normalizeText(item.type) || (message.is_image || message.isImage ? 'image' : 'file'),
      url,
      name:
        normalizeText(item.name || item.file_name) ||
        getAttachmentNameFromUrl(url, message.is_image || message.isImage ? '图片' : '附件'),
    });
  }
  return attachments.filter((item, index, rows) => rows.findIndex((candidate) => candidate.url === item.url) === index);
}

function getMessageRole(userType = '') {
  const normalized = normalizeText(userType).toLowerCase();
  if (normalized === 'customer' || normalized === 'buyer') return 'buyer';
  if (normalized === 'seller' || normalized === 'support') return 'seller';
  return 'system';
}

function detectMessageDomain(text = '', orderNumber = '') {
  const normalized = normalizeText(text).toLowerCase();
  if (/退货|退款|取消|return|refund|cancel|возврат|отмен/u.test(normalized)) return 'returns';
  if (/物流|配送|运输|快递|delivery|logistics|transport|достав|транспорт/u.test(normalized)) {
    return 'logistics';
  }
  if (orderNumber || /订单|order|заказ/u.test(normalized)) return 'orders';
  return 'customerService';
}

function getSystemMessageTitle(rawText = '', userType = '', domain = '') {
  const boldTitle = normalizeText(rawText).match(/^\*\*([^*]+)\*\*/)?.[1];
  if (boldTitle) return boldTitle.slice(0, 42);
  const firstLine = cleanCustomerMessageText(rawText).split('\n').find(Boolean) || '';
  if (normalizeText(userType).toLowerCase() === 'chatbot') return 'Ozon 自动消息';
  if (domain === 'returns') return 'Ozon 售后信息';
  if (domain === 'logistics') return 'Ozon 物流信息';
  if (domain === 'orders') return 'Ozon 订单信息';
  return firstLine.slice(0, 42) || 'Ozon 信息更新';
}

function findPostingNumber(messages = []) {
  const candidates = [];
  for (const message of messages) {
    const contextOrder = normalizeText(message?.context?.order_number || message?.context?.orderNumber);
    if (contextOrder) candidates.push(contextOrder);
    const text = getRawMessageText(message);
    for (const match of text.matchAll(/\b\d{6,}-\d{4,}(?:-\d+)?\b/g)) candidates.push(match[0]);
  }
  return (
    [...new Set(candidates)].sort((left, right) => {
      const segmentDelta = right.split('-').length - left.split('-').length;
      return segmentDelta || right.length - left.length;
    })[0] || ''
  );
}

function findOzonSku(messages = []) {
  for (const message of messages) {
    const sku = normalizeText(message?.context?.sku);
    if (/^\d{5,}$/.test(sku)) return sku;
  }
  return '';
}

function findProductContext(messages = []) {
  for (const message of [...messages].reverse()) {
    const context = message?.context && typeof message.context === 'object' ? message.context : {};
    const title = normalizeText(context.product_name || context.productName || context.title);
    const image = normalizeText(context.product_image || context.productImage || context.image);
    if (title || image) return { title, image };
  }
  return { title: '', image: '' };
}

function normalizeCustomerHistoryMessage(message = {}, { conversationId = '', index = 0 } = {}) {
  const userType = normalizeText(message?.user?.type);
  const userId = normalizeText(message?.user?.id);
  const senderType = getMessageRole(userType);
  const rawText = getRawMessageText(message);
  const attachments = getMessageAttachments(message);
  const content =
    cleanCustomerMessageText(stripMarkdownAttachments(rawText)) ||
    (attachments.some((attachment) => attachment.type === 'image') || message.is_image
      ? '[图片消息]'
      : attachments.length
        ? '[附件消息]'
        : '空消息');
  const orderNumber = normalizeText(message?.context?.order_number || message?.context?.orderNumber);
  const domain = detectMessageDomain(content, orderNumber);
  const sentAt = normalizeText(message.created_at || message.createdAt);
  const source =
    senderType === 'buyer'
      ? 'Ozon 买家'
      : senderType === 'seller'
        ? '店铺客服'
        : userType.toLowerCase() === 'notificationuser'
          ? 'Ozon 通知'
          : userType.toLowerCase() === 'chatbot'
            ? 'Ozon 助手'
            : 'Ozon 支持';
  const rawMessageId = normalizeText(message.message_id || message.messageId);
  const fallbackId = `${conversationId || 'unknown-chat'}:${sentAt || 'unknown-time'}:${userId || userType || 'unknown-sender'}:${index}`;
  const read = Boolean(message.is_read ?? message.isRead);
  const senderName = senderType === 'buyer' ? `买家 ${userId || '用户'}` : source;

  return {
    id: rawMessageId || fallbackId,
    messageId: rawMessageId,
    conversationId,
    senderType,
    senderName,
    content,
    contentType: attachments.length ? (content === '[图片消息]' ? 'image' : 'mixed') : 'text',
    sentAt,
    readAt: normalizeText(message.read_at || message.readAt),
    attachments,
    rawStatus: normalizeText(message.status || message.message_status) || (read ? 'read' : 'unread'),
    role: senderType,
    author: senderName,
    userType,
    source,
    domain,
    eventType: senderType === 'system' ? `${domain}_message` : 'chat_message',
    title: senderType === 'system' ? getSystemMessageTitle(rawText, userType, domain) : '',
    text: content,
    time: formatCustomerChatDateTime(sentAt, { compact: true }),
    occurredAt: sentAt,
    createdAt: sentAt,
    orderNumber,
    read,
    isImage: Boolean(message.is_image ?? message.isImage),
    timestamp: parseDate(sentAt)?.getTime() || 0,
    stableSourceId: Boolean(rawMessageId),
    sourceIndex: index,
  };
}

export function dedupeCustomerMessages(messages = []) {
  const seenStableIds = new Set();
  return messages
    .filter((message) => {
      if (!message?.stableSourceId && !message?.messageId) return true;
      const stableId = normalizeText(message.messageId || message.id);
      if (!stableId || seenStableIds.has(stableId)) return false;
      seenStableIds.add(stableId);
      return true;
    })
    .sort((left, right) => {
      const timeDelta = (Number(left.timestamp) || 0) - (Number(right.timestamp) || 0);
      if (timeDelta) return timeDelta;
      const indexDelta = (Number(left.sourceIndex) || 0) - (Number(right.sourceIndex) || 0);
      if (indexDelta) return indexDelta;
      return String(left.id).localeCompare(String(right.id));
    });
}

export function mergeCustomerChatHistory(conversation = {}, payload = {}, { appendOlder = false } = {}) {
  const data = extractProbeData(payload);
  const sourceMessages = Array.isArray(data.messages) ? data.messages : [];
  const postingNumber = findPostingNumber(sourceMessages);
  const ozonSku = findOzonSku(sourceMessages);
  const productContext = findProductContext(sourceMessages);
  const pageMessages = dedupeCustomerMessages(
    sourceMessages.map((message, index) =>
      normalizeCustomerHistoryMessage(message, {
        conversationId: conversation.conversationId || conversation.chatId,
        index,
      })
    )
  );
  const messages = dedupeCustomerMessages(
    appendOlder
      ? [...pageMessages, ...(Array.isArray(conversation.messages) ? conversation.messages : [])]
      : pageMessages
  );
  const latest = messages.at(-1) || null;
  const buyerMessage = [...messages].reverse().find((message) => message.senderType === 'buyer');
  const latestSystem = [...messages].reverse().find((message) => message.senderType === 'system');
  const isBuyerChat = conversation.chatType === 'BUYER_SELLER';
  const customerId = normalizeText(buyerMessage?.senderName).replace(/^买家\s*/u, '') || conversation.customerId;
  const customerName = isBuyerChat
    ? buyerMessage?.senderName || conversation.customerName || 'Ozon 买家'
    : conversation.customerName;
  const statusMeta = translateCustomerConversationStatus(conversation.rawStatus, {
    unreadCount: conversation.unreadCount ?? conversation.unread,
    lastSenderType: latest?.senderType,
    buyerConversation: isBuyerChat,
  });
  const lastMessageAt = latest?.sentAt || conversation.lastMessageAt || conversation.createdAt;
  const productTitle = productContext.title || (postingNumber || ozonSku ? '等待订单商品回读' : '未关联商品');

  return {
    ...conversation,
    customerId,
    customerName,
    status: statusMeta.label,
    statusKey: statusMeta.key,
    lastMessageText: latest?.content || '暂无消息内容',
    lastMessageId: latest?.messageId || latest?.id || conversation.lastMessageId || '',
    lastMessageAt,
    orderId: postingNumber || conversation.orderId || '',
    productId: ozonSku || conversation.productId || '',
    productTitle,
    productImage: productContext.image || conversation.productImage || '',
    title: isBuyerChat ? customerName : latestSystem?.title || conversation.title || 'Ozon 信息推送',
    subtitle: isBuyerChat ? (postingNumber ? `订单 ${postingNumber}` : 'Ozon 买家咨询') : conversation.subtitle,
    lastMessage: latest?.content || '暂无消息内容',
    time: formatCustomerChatDateTime(lastMessageAt, { compact: true }),
    orderNumber: postingNumber || conversation.orderNumber || '未关联订单',
    orderStatus: postingNumber ? '读取订单状态' : '未关联订单',
    sku: ozonSku || conversation.sku || '',
    ozonSku: ozonSku || conversation.ozonSku || '',
    productName: productTitle,
    updatedAt: formatCustomerChatDateTime(lastMessageAt),
    notificationCount: messages.length,
    historyLoaded: true,
    historyStatus: 'success',
    historyError: '',
    historyHasNext: Boolean(data.has_next ?? data.hasNext),
    historyCursor: normalizeText(messages[0]?.messageId || messages[0]?.id),
    messages,
  };
}

export function getCustomerChatListMeta(payload = {}, { offset = 0, limit = 30, rowCount } = {}) {
  const data = extractProbeData(payload);
  const rows = Array.isArray(data.chats) ? data.chats : [];
  const actualRowCount = Math.max(Number(rowCount) || rows.length, 0);
  const totalCount = Math.max(
    Number(data.total_count ?? data.totalCount ?? data.total_chats_count ?? data.totalChatsCount) || 0,
    0
  );
  const explicitHasNext = data.has_next ?? data.hasNext;
  const cursor = normalizeText(data.cursor);
  const hasNext =
    typeof explicitHasNext === 'boolean'
      ? explicitHasNext && Boolean(cursor)
      : totalCount > 0
        ? Number(offset) + actualRowCount < totalCount
        : actualRowCount >= Number(limit);
  return {
    totalUnreadCount: Math.max(Number(data.total_unread_count ?? data.totalUnreadCount) || 0, 0),
    totalCount,
    cursor,
    hasNext,
    nextOffset: Number(offset) + actualRowCount,
    rowCount: actualRowCount,
  };
}

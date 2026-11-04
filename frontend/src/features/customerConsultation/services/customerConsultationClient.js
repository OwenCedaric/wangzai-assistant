import { listOzonNotifications, requestLocalApi } from '../../../api/localApiClient.js';

const CUSTOMER_SERVICE_MARK_ALL_READ_ACTION = 'customerService.chat.markAllRead';
const CUSTOMER_SERVICE_MARK_READ_ENDPOINT = 'chat.read';
let customerTranslationRequestSequence = 0;

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeUnreadCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function createCustomerTranslationRequestId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `customer-translation-${uuid}`;
  } catch {
    // A deterministic process-local fallback is sufficient for cancellation routing.
  }
  customerTranslationRequestSequence += 1;
  return `customer-translation-${Date.now().toString(36)}-${customerTranslationRequestSequence.toString(36)}`;
}

/**
 * Freeze the Ozon list snapshot used by the preview-confirm write flow.
 * Message ids stay strings because Ozon ids can exceed JS safe integers.
 */
export function buildCustomerMarkReadTargets(conversations = []) {
  const byChatId = new Map();
  for (const conversation of conversations) {
    const unreadCount = normalizeUnreadCount(conversation?.unreadCount ?? conversation?.unread);
    const chatId = normalizeText(conversation?.chatId ?? conversation?.conversationId);
    // Notification-center rows and push-only chat.list rows are display-only.
    // Never send their ids to Ozon chat.read; only writable buyer rows opt in.
    const pushOnly = conversation?.channel === 'push' && conversation?.category !== 'buyer';
    if (conversation?.markReadSupported === false || pushOnly || !chatId || unreadCount <= 0) continue;
    const firstUnreadMessageId = normalizeText(
      conversation?.firstUnreadMessageId ?? conversation?.first_unread_message_id
    );
    const lastMessageId = normalizeText(conversation?.lastMessageId ?? conversation?.last_message_id);
    const renderedMessageId = normalizeText(
      conversation?.readThroughMessageId ?? conversation?.read_through_message_id
    );
    // Ozon marks the selected message and every message before it as read.
    // Therefore the boundary must be the newest message the user actually saw,
    // not first_unread_message_id (which would clear only the oldest unread row).
    const fromMessageId = renderedMessageId || lastMessageId || firstUnreadMessageId;
    if (!fromMessageId) continue;
    const target = {
      chat_id: chatId,
      from_message_id: fromMessageId,
      first_unread_message_id: firstUnreadMessageId || null,
      last_message_id: lastMessageId || null,
      unread_count: unreadCount,
    };
    const previous = byChatId.get(chatId);
    byChatId.set(
      chatId,
      previous
        ? {
            ...previous,
            from_message_id: target.from_message_id || previous.from_message_id,
            first_unread_message_id: previous.first_unread_message_id || target.first_unread_message_id,
            last_message_id: target.last_message_id || previous.last_message_id,
            unread_count: Math.max(previous.unread_count, target.unread_count),
          }
        : target
    );
  }
  return [...byChatId.values()];
}

export function probeCustomerServiceEndpoint(payload = {}, options = {}) {
  return requestLocalApi('/api/customer-service/probe', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs ?? 20000,
    signal: options.signal,
  });
}

export function readCustomerChatList(
  { shopId = '', accountId = '', limit = 100, cursor = '', forceRefresh = false } = {},
  options = {}
) {
  const normalizedCursor = normalizeText(cursor);
  return probeCustomerServiceEndpoint(
    {
      shopId,
      accountId: accountId || shopId,
      endpointKey: 'chat.list',
      limit,
      cursor: normalizedCursor,
      forceRefresh,
      params: {
        limit,
        ...(normalizedCursor ? { cursor: normalizedCursor } : { offset: 0 }),
      },
      requestedBy: 'customer-consultation-chat-list',
    },
    { timeoutMs: options.timeoutMs ?? 30000, signal: options.signal }
  );
}

export function readCustomerChatHistory(
  {
    shopId = '',
    accountId = '',
    chatId = '',
    limit = 50,
    fromMessageId = '',
    forceRefresh = false,
    priority = 'P1',
    requestedBy = 'customer-consultation-chat-history',
  } = {},
  options = {}
) {
  return probeCustomerServiceEndpoint(
    {
      shopId,
      accountId: accountId || shopId,
      endpointKey: 'chat.history',
      chatId,
      limit,
      forceRefresh,
      priority,
      params: {
        chat_id: chatId,
        limit,
        direction: 'Backward',
        ...(normalizeText(fromMessageId) ? { from_message_id: normalizeText(fromMessageId) } : {}),
      },
      requestedBy,
    },
    { timeoutMs: options.timeoutMs ?? 30000, signal: options.signal }
  );
}

export function waitForCustomerServiceRealtimeEvent(
  { shopId = '', afterSequence = null, timeoutMs = 25000 } = {},
  options = {}
) {
  const waitTimeoutMs = Math.max(1000, Math.min(Number(timeoutMs) || 25000, 30000));
  const query = new URLSearchParams({ shopId: normalizeText(shopId) });
  if (
    afterSequence !== null &&
    afterSequence !== '' &&
    Number.isSafeInteger(Number(afterSequence)) &&
    Number(afterSequence) >= 0
  ) {
    query.set('afterSequence', String(Number(afterSequence)));
  }
  query.set('timeoutMs', String(waitTimeoutMs));
  return requestLocalApi(`/api/customer-service/realtime/wait?${query.toString()}`, {
    method: 'GET',
    timeoutMs: waitTimeoutMs + 5000,
    signal: options.signal,
    transportRetry: false,
    observe: false,
  });
}

export async function translateCustomerChatMessages({ messages = [] } = {}, options = {}) {
  const requestId = createCustomerTranslationRequestId();
  const cancelRequest = () => {
    void requestLocalApi('/api/customer-service/translate/cancel', {
      method: 'POST',
      body: { requestId },
      timeoutMs: 3000,
      observe: false,
    }).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', cancelRequest, { once: true });
  try {
    return await requestLocalApi('/api/customer-service/translate', {
      method: 'POST',
      body: {
        requestId,
        messages: messages.map((message) => ({ id: message.id, text: message.text })),
      },
      timeoutMs: options.timeoutMs ?? 30000,
      signal: options.signal,
    });
  } finally {
    options.signal?.removeEventListener('abort', cancelRequest);
  }
}

export function readCustomerShopProfile({ shopId = '', accountId = '' } = {}, options = {}) {
  return probeCustomerServiceEndpoint(
    {
      shopId,
      accountId: accountId || shopId,
      endpointKey: 'shop.sellerInfo',
      params: {},
      priority: 'P0',
      forceRefresh: options.forceRefresh === true,
      requestedBy: 'customer-consultation-shop-profile',
    },
    { timeoutMs: options.timeoutMs ?? 15000, signal: options.signal }
  );
}

export function readCustomerServiceNotifications({ shopId = '', limit = 100 } = {}, options = {}) {
  return listOzonNotifications(
    {
      ...(shopId ? { shopId } : {}),
      limit,
    },
    {
      timeoutMs: options.timeoutMs ?? 12000,
      signal: options.signal,
    }
  );
}

export function readCustomerPushViewMarkers({ shopId = '', accountId = '' } = {}, options = {}) {
  return requestLocalApi('/api/customer-service/push-view-markers/list', {
    method: 'POST',
    body: {
      shopId,
      accountScope: accountId || shopId,
    },
    timeoutMs: options.timeoutMs ?? 5000,
    signal: options.signal,
  });
}

export function saveCustomerPushViewMarker(
  { shopId = '', accountId = '', chatId = '', lastMessageId = '', lastMessageAt = '' } = {},
  options = {}
) {
  return requestLocalApi('/api/customer-service/push-view-markers', {
    method: 'PUT',
    body: {
      shopId,
      accountScope: accountId || shopId,
      chatId,
      lastMessageId,
      lastMessageAt,
    },
    timeoutMs: options.timeoutMs ?? 5000,
    signal: options.signal,
  });
}

export function readCustomerOrderContext({ shopId = '', postingNumber = '' } = {}, options = {}) {
  if (!shopId || postingNumber === '—') {
    return Promise.resolve({
      rows: [],
      purchaseRows: [],
      purchaseLinks: [],
      logisticsRows: [],
      total: 0,
      source: 'sqlite',
    });
  }
  const query = new URLSearchParams({ shopId, ...(postingNumber ? { postingNumber } : {}) }).toString();
  return requestLocalApi(`/api/customer-service/order-route-context?${query}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs ?? 12000,
    signal: options.signal,
  });
}

export function previewCustomerMessageSend({ shopId, chatId, text } = {}, options = {}) {
  return requestLocalApi('/api/write/customerService/preview', {
    method: 'POST',
    body: {
      shopId,
      endpointKey: 'chat.sendMessage',
      action: 'customerService.chat.sendMessage',
      before: { chatId },
      after: { chat_id: chatId, text },
      payload: { chat_id: chatId, text },
      requestedBy: 'customer-consultation',
    },
    timeoutMs: options.timeoutMs ?? 12000,
    signal: options.signal,
  });
}

export function confirmCustomerMessageSend({ previewId, shopId, chatId, text } = {}, options = {}) {
  return requestLocalApi('/api/write/customerService/confirm', {
    method: 'POST',
    body: {
      previewId,
      confirm: true,
      shopId,
      endpointKey: 'chat.sendMessage',
      action: 'customerService.chat.sendMessage',
      payload: { chat_id: chatId, text },
      realWrite: true,
      dryRun: false,
      waitForResult: true,
      requestedBy: 'customer-consultation',
    },
    timeoutMs: options.timeoutMs ?? 30000,
    signal: options.signal,
  });
}

export function stageCustomerMessageFile({ shopId, chatId, name, mimeType = '', base64Content } = {}, options = {}) {
  return requestLocalApi('/api/customer-service/outbound-file/stage', {
    method: 'POST',
    body: { shopId, chatId, name, mimeType, base64Content },
    timeoutMs: options.timeoutMs ?? 30000,
    signal: options.signal,
  });
}

export function previewCustomerFileSend({ shopId, chatId, file } = {}, options = {}) {
  const payload = {
    chat_id: chatId,
    file_token: file?.token,
    name: file?.name,
    size: file?.size,
    sha256: file?.sha256,
  };
  return requestLocalApi('/api/write/customerService/preview', {
    method: 'POST',
    body: {
      shopId,
      endpointKey: 'chat.sendFile',
      action: 'customerService.chat.sendFile',
      before: { chatId },
      after: payload,
      payload,
      requestedBy: 'customer-consultation-file',
    },
    timeoutMs: options.timeoutMs ?? 12000,
    signal: options.signal,
  });
}

export function confirmCustomerFileSend({ previewId, shopId, chatId, file } = {}, options = {}) {
  return requestLocalApi('/api/write/customerService/confirm', {
    method: 'POST',
    body: {
      previewId,
      confirm: true,
      shopId,
      endpointKey: 'chat.sendFile',
      action: 'customerService.chat.sendFile',
      payload: {
        chat_id: chatId,
        file_token: file?.token,
        name: file?.name,
        size: file?.size,
        sha256: file?.sha256,
      },
      realWrite: true,
      dryRun: false,
      waitForResult: true,
      requestedBy: 'customer-consultation-file',
    },
    timeoutMs: options.timeoutMs ?? 60000,
    signal: options.signal,
  });
}

export function previewCustomerConversationStart({ shopId, postingNumber } = {}, options = {}) {
  const payload = { posting_number: normalizeText(postingNumber) };
  return requestLocalApi('/api/write/customerService/preview', {
    method: 'POST',
    body: {
      shopId,
      endpointKey: 'chat.start',
      action: 'customerService.chat.start',
      before: { postingNumber: payload.posting_number },
      after: payload,
      payload,
      requestedBy: 'customer-consultation-start',
    },
    timeoutMs: options.timeoutMs ?? 12000,
    signal: options.signal,
  });
}

export function confirmCustomerConversationStart({ previewId, shopId, postingNumber } = {}, options = {}) {
  return requestLocalApi('/api/write/customerService/confirm', {
    method: 'POST',
    body: {
      previewId,
      confirm: true,
      shopId,
      endpointKey: 'chat.start',
      action: 'customerService.chat.start',
      payload: { posting_number: normalizeText(postingNumber) },
      realWrite: true,
      dryRun: false,
      waitForResult: true,
      requestedBy: 'customer-consultation-start',
    },
    timeoutMs: options.timeoutMs ?? 60000,
    signal: options.signal,
  });
}

export function previewCustomerMarkAllRead({ shopId, accountId = '', chats = [] } = {}, options = {}) {
  const payload = { chats };
  return requestLocalApi('/api/write/customerService/preview', {
    method: 'POST',
    body: {
      shopId,
      accountId: accountId || shopId,
      endpointKey: CUSTOMER_SERVICE_MARK_READ_ENDPOINT,
      action: CUSTOMER_SERVICE_MARK_ALL_READ_ACTION,
      before: payload,
      after: {
        chats: chats.map((chat) => ({ ...chat, unread_count: 0 })),
      },
      payload,
      requestedBy: 'customer-consultation-mark-all-read',
    },
    timeoutMs: options.timeoutMs ?? 12000,
    signal: options.signal,
  });
}

export function confirmCustomerMarkAllRead({ previewId, shopId, accountId = '', chats = [] } = {}, options = {}) {
  const estimatedTimeoutMs = Math.max(60000, chats.length * 1600 + 30000);
  return requestLocalApi('/api/write/customerService/confirm', {
    method: 'POST',
    body: {
      previewId,
      confirm: true,
      shopId,
      accountId: accountId || shopId,
      endpointKey: CUSTOMER_SERVICE_MARK_READ_ENDPOINT,
      action: CUSTOMER_SERVICE_MARK_ALL_READ_ACTION,
      payload: { chats },
      realWrite: true,
      dryRun: false,
      waitForResult: true,
      requestedBy: 'customer-consultation-mark-all-read',
    },
    timeoutMs: options.timeoutMs ?? estimatedTimeoutMs,
    signal: options.signal,
  });
}

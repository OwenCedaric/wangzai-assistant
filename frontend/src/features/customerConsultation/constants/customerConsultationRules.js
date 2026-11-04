export const customerConsultationFilters = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'buyer', label: '买家咨询' },
  { id: 'notification', label: 'Ozon 通知' },
  { id: 'support', label: '平台支持' },
]);

export const customerConsultationStatusFilters = Object.freeze([
  { id: 'all', label: '全部状态' },
  { id: 'open', label: '处理中' },
  { id: 'waiting', label: '等待回复' },
  { id: 'completed', label: '已完成' },
  { id: 'closed', label: '已关闭' },
  { id: 'unknown', label: '状态待确认' },
]);

export const customerConsultationPagination = Object.freeze({
  // Ozon chat.list uses cursor pagination. Keep one canonical page size so
  // cached pages remain reusable and the next cursor always belongs to the
  // exact page that produced it.
  pageSize: 100,
  backgroundPageSize: 100,
  maxBackgroundPages: 100,
  backgroundStartDelayMs: 120,
  historyPageSize: 50,
  searchDebounceMs: 250,
  autoRefreshIntervalMs: 60000,
  focusRefreshStaleMs: 15000,
  visibleHistoryPrefetchConcurrency: 2,
  backgroundHistoryPrefetchConcurrency: 2,
  // Full-history indexing is deliberately serialized. Visible reads use P1
  // and can therefore overtake this P3 background work at any time.
  backgroundFullHistoryConcurrency: 1,
  backgroundFullHistoryRetryMs: 60000,
});

export const customerConsultationCapabilities = Object.freeze({
  sendMessage: Object.freeze({
    available: true,
    requiresPreview: true,
    requiresConfirmation: true,
    requiresReadback: true,
    reason: '',
  }),
  markRead: Object.freeze({
    available: true,
    requiresPreview: true,
    requiresConfirmation: true,
    requiresReadback: true,
  }),
  sendFile: Object.freeze({
    available: true,
    requiresPreview: true,
    requiresConfirmation: true,
    requiresReadback: true,
  }),
  startConversation: Object.freeze({
    available: true,
    requiresPreview: true,
    requiresConfirmation: true,
    requiresReadback: true,
  }),
});

export const customerQuickReplyPresets = Object.freeze([
  {
    id: 'shipping-progress',
    title: '发货进度',
    text: 'Здравствуйте! Заказ находится в обработке. Актуальный статус и сроки доставки отображаются на странице заказа Ozon.',
  },
  {
    id: 'logistics-update',
    title: '物流更新',
    text: 'Здравствуйте! Заказ уже передан в службу доставки. Пожалуйста, следите за обновлениями в разделе заказов Ozon.',
  },
  {
    id: 'product-compatibility',
    title: '商品适配',
    text: 'Здравствуйте! Напишите, пожалуйста, точную модель устройства, и мы проверим совместимость товара.',
  },
  {
    id: 'cancel-order',
    title: '取消订单',
    text: 'Здравствуйте! Возможность отмены зависит от текущего статуса заказа. Пожалуйста, оформите отмену на странице заказа Ozon.',
  },
  {
    id: 'after-sales',
    title: '售后处理',
    text: 'Здравствуйте! Пожалуйста, оформите заявку на возврат в Ozon и приложите фотографии товара. Мы проверим информацию после обновления заявки.',
  },
]);

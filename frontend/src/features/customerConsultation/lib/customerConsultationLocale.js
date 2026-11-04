const STATUS_LABELS = Object.freeze({
  OPENED: { key: 'open', label: '处理中' },
  OPEN: { key: 'open', label: '处理中' },
  ACTIVE: { key: 'open', label: '处理中' },
  NEW: { key: 'open', label: '待处理' },
  UNREAD: { key: 'waiting', label: '待回复' },
  WAITING: { key: 'waiting', label: '等待回复' },
  WAITING_FOR_SELLER: { key: 'waiting', label: '待商家回复' },
  WAITING_FOR_BUYER: { key: 'waiting', label: '等待买家回复' },
  ANSWERED: { key: 'completed', label: '已回复' },
  RESOLVED: { key: 'completed', label: '已完成' },
  COMPLETED: { key: 'completed', label: '已完成' },
  CLOSED: { key: 'closed', label: '已关闭' },
  ARCHIVED: { key: 'closed', label: '已关闭' },
  ОТКРЫТ: { key: 'open', label: '处理中' },
  ОТКРЫТО: { key: 'open', label: '处理中' },
  НОВЫЙ: { key: 'open', label: '待处理' },
  ОЖИДАЕТ_ОТВЕТА: { key: 'waiting', label: '等待回复' },
  ОЖИДАЕТ_ОТВЕТА_ПРОДАВЦА: { key: 'waiting', label: '待商家回复' },
  ОЖИДАЕТ_ОТВЕТА_ПОКУПАТЕЛЯ: { key: 'waiting', label: '等待买家回复' },
  ЗАВЕРШЕН: { key: 'completed', label: '已完成' },
  ЗАВЕРШЕНО: { key: 'completed', label: '已完成' },
  ЗАКРЫТ: { key: 'closed', label: '已关闭' },
  ЗАКРЫТО: { key: 'closed', label: '已关闭' },
});

const ERROR_CODE_LABELS = Object.freeze({
  CUSTOMER_SERVICE_SHOP_ID_REQUIRED: '请先选择 Ozon 店铺。',
  CHAT_ID_REQUIRED: '会话编号缺失，无法读取聊天记录。',
  CUSTOMER_SERVICE_ENDPOINT_NOT_ALLOWED: '当前客服读取能力未开放。',
  CUSTOMER_SERVICE_SCHEDULER_NOT_CONNECTED: 'Ozon 客服读取服务尚未连接。',
  CUSTOMER_SERVICE_CACHE_NOT_CONNECTED: '客服缓存读取服务尚未连接。',
  CUSTOMER_SERVICE_WRITE_EXECUTOR_NOT_CONNECTED: '客服回复后端暂未提供。',
  CUSTOMER_SERVICE_WRITE_ACTION_NOT_REGISTERED: '后端暂未提供此客服操作。',
  CUSTOMER_SERVICE_WRITE_ENDPOINT_MISMATCH: '客服回复接口配置不一致，未执行写入。',
  CUSTOMER_SERVICE_WRITE_PAYLOAD_REQUIRED: '客服回复缺少必要信息，未执行写入。',
  CUSTOMER_SERVICE_WRITE_FAILED: '客服回复提交失败，请稍后重试。',
  CUSTOMER_SERVICE_SYNC_NOT_READY: '客服后台常驻同步尚未提供。',
  CUSTOMER_TRANSLATION_NOT_CONNECTED: '翻译服务尚未连接。',
  CUSTOMER_TRANSLATION_RATE_LIMITED: '翻译服务请求过于频繁，已切换备用服务，请稍后重试。',
  CUSTOMER_TRANSLATION_TIMEOUT: '翻译服务响应超时，已自动切换备用服务，请点击重试。',
  CUSTOMER_TRANSLATION_INVALID_RESPONSE: '翻译服务返回格式异常，请点击重试。',
  CUSTOMER_TRANSLATION_EMPTY_RESULT: '翻译服务没有返回有效结果，请点击重试。',
  CUSTOMER_TRANSLATION_UNCHANGED_RESULT: '翻译服务没有完成转换，请点击重试。',
  CUSTOMER_TRANSLATION_HTTP_ERROR: '翻译服务暂时不可用，请稍后重试。',
  REQUEST_TIMEOUT: '请求超时，请检查网络后重试。',
  UNAUTHORIZED: '当前账号没有访问客服数据的权限。',
  FORBIDDEN: '当前账号没有访问客服数据的权限。',
  NOT_FOUND: '未找到对应的客服数据。',
});

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeStatusKey(value) {
  return normalizeText(value)
    .toLocaleUpperCase()
    .replace(/[\s-]+/gu, '_');
}

export function translateCustomerConversationStatus(
  rawStatus,
  { unreadCount = 0, lastSenderType = '', buyerConversation = false } = {}
) {
  const normalized = normalizeStatusKey(rawStatus);
  const mapped = STATUS_LABELS[normalized];
  if (mapped?.key === 'closed') return { ...mapped, rawStatus: normalizeText(rawStatus) };
  if (Number(unreadCount) > 0 && buyerConversation) {
    return { key: 'waiting', label: '待回复', rawStatus: normalizeText(rawStatus) };
  }
  if (normalizeText(lastSenderType).toLowerCase() === 'seller' && buyerConversation) {
    return { key: 'completed', label: '已回复', rawStatus: normalizeText(rawStatus) };
  }
  if (mapped) return { ...mapped, rawStatus: normalizeText(rawStatus) };
  return {
    key: normalized ? 'unknown' : 'open',
    label: normalized ? '状态待确认' : '处理中',
    rawStatus: normalizeText(rawStatus),
  };
}

export function translateCustomerReadStatus(value) {
  const normalized = normalizeText(value).toLocaleLowerCase();
  if (value === true || ['read', '已读', 'прочитано'].includes(normalized)) return '已读';
  if (value === false || ['unread', '未读', 'не прочитано'].includes(normalized)) return '未读';
  return '状态待确认';
}

function readErrorParts(error) {
  if (error && typeof error === 'object') {
    return {
      code: normalizeText(error.code || error.error?.code),
      message: normalizeText(error.message || error.error?.message),
    };
  }
  return { code: '', message: normalizeText(error) };
}

export function translateCustomerError(error, fallback = '客服数据读取失败，请稍后重试。') {
  const { code, message } = readErrorParts(error);
  if (ERROR_CODE_LABELS[code]) return ERROR_CODE_LABELS[code];

  const searchable = `${code} ${message}`.toLocaleLowerCase();
  if (/abort|cancelled|canceled|отмен/iu.test(searchable)) return '请求已取消。';
  if (/timeout|timed out|etimedout|превышено время/iu.test(searchable)) {
    return '请求超时，请检查网络后重试。';
  }
  if (/network|failed to fetch|fetch failed|econn|socket|сеть|сетев|подключ/iu.test(searchable)) {
    return '网络连接失败，请检查网络后重试。';
  }
  if (/unauthori[sz]ed|forbidden|permission|access denied|нет доступа|доступ запрещ/iu.test(searchable)) {
    return '当前账号没有访问客服数据的权限。';
  }
  if (/not found|does not exist|не найден|не существует/iu.test(searchable)) {
    return '未找到对应的客服数据。';
  }
  if (/scheduler.+not connected|service.+not connected|не подключ/iu.test(searchable)) {
    return 'Ozon 客服读取服务尚未连接。';
  }
  if (/rate limit|too many requests|429|слишком много запросов/iu.test(searchable)) {
    return '请求过于频繁，请稍后重试。';
  }
  if (/invalid|bad request|validation|некоррект|неверн/iu.test(searchable)) {
    return '客服请求参数无效，请刷新后重试。';
  }

  if (message && /[\u3400-\u9fff]/u.test(message) && !/[A-Z_]{4,}/u.test(message)) {
    return message;
  }
  return fallback;
}

export function getCustomerSyncStatusLabel(status) {
  return (
    {
      idle: '等待读取',
      loading: '正在读取',
      refreshing: '正在刷新',
      loadingMore: '正在加载更多',
      success: '读取完成',
      empty: '暂无数据',
      stale: '显示已读取数据',
      error: '读取失败',
    }[status] || '状态待确认'
  );
}

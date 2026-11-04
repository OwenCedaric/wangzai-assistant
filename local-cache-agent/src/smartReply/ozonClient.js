import { text, unwrapPosting } from './contract.js';

const OZON_BASE_URL = 'https://api-seller.ozon.ru';
const DEFAULT_TIMEOUT_MS = 20_000;

export class SmartReplyOzonError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SmartReplyOzonError';
    this.code = code;
    this.status = Number(options.status) || 502;
    this.retryable = options.retryable === true;
    this.ambiguousWrite = options.ambiguousWrite === true;
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sellerMessage(message = {}) {
  const userType = text(object(message.user).type).toLowerCase();
  return userType === 'seller' || userType === 'support';
}

function messageText(message = {}) {
  const values = Array.isArray(message.data) ? message.data : [message.data];
  const dataText = values
    .filter((value) => ['string', 'number'].includes(typeof value))
    .map((value) => text(value))
    .filter(Boolean)
    .join('\n');
  return text(dataText, message.text, message.message).replaceAll(/\s+/gu, ' ').trim();
}

export function historyConfirmsMessage(messages, { messageId = '', message = '' } = {}) {
  const expected = text(message).replaceAll(/\s+/gu, ' ').trim();
  for (const row of Array.isArray(messages) ? messages : []) {
    const currentId = text(row?.message_id, row?.id);
    if (messageId && currentId === messageId) return { confirmed: true, messageId: currentId };
    if (expected && sellerMessage(row) && messageText(row) === expected) {
      return { confirmed: true, messageId: currentId || messageId };
    }
  }
  return { confirmed: false, messageId: text(messageId) };
}

export class SmartReplyOzonClient {
  constructor({ clientId, apiKey, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('SMART_REPLY_FETCH_REQUIRED');
    this.clientId = text(clientId);
    this.apiKey = text(apiKey);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.signal = signal;
  }

  async post(pathname, body, { write = false } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (this.signal?.aborted) controller.abort();
    else this.signal?.addEventListener?.('abort', abort, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${OZON_BASE_URL}${pathname}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Client-Id': this.clientId,
          'Api-Key': this.apiKey,
          'User-Agent': 'Wangzai-Local-Smart-Reply/1',
        },
        body: JSON.stringify(body || {}),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      const abortedByShutdown = this.signal?.aborted === true;
      throw new SmartReplyOzonError(
        write ? 'SMART_REPLY_OZON_WRITE_RESULT_UNKNOWN' : 'SMART_REPLY_OZON_NETWORK_UNAVAILABLE',
        abortedByShutdown
          ? '本地自动发送服务已停止。'
          : write
            ? '发送请求已发出但没有收到 Ozon 回执，已停止自动重试。'
            : '暂时无法连接 Ozon，任务会稍后重试。',
        { retryable: !write && !abortedByShutdown, ambiguousWrite: write, status: 502 },
      );
    } finally {
      clearTimeout(timeoutId);
      this.signal?.removeEventListener?.('abort', abort);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SmartReplyOzonError(
        'SMART_REPLY_OZON_RESPONSE_INVALID',
        'Ozon 返回了无法识别的数据。',
        { ambiguousWrite: write, status: response.status },
      );
    }
    if ([401, 403].includes(response.status)) {
      throw new SmartReplyOzonError(
        'SMART_REPLY_OZON_AUTHENTICATION_FAILED',
        '当前店铺的 Ozon API 授权无效、已撤销或没有聊天权限。',
        { status: 401 },
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new SmartReplyOzonError(
        response.status === 429 ? 'SMART_REPLY_OZON_RATE_LIMITED' : 'SMART_REPLY_OZON_TEMPORARY_FAILURE',
        'Ozon 当前限流或暂时不可用。',
        { retryable: !write, ambiguousWrite: write, status: response.status },
      );
    }
    if (!response.ok) {
      const code = text(payload?.code, payload?.error).slice(0, 60);
      throw new SmartReplyOzonError(
        `SMART_REPLY_OZON_HTTP_${response.status}`,
        `Ozon 拒绝了请求（HTTP ${response.status}${code ? `，${code}` : ''}）。`,
        { status: response.status },
      );
    }
    return object(payload);
  }

  async verify() {
    await this.post('/v1/roles', {});
    await this.post('/v1/seller/info', {});
  }

  async readPosting(postingNumberValue) {
    let lastError = null;
    for (const [pathname, source] of [['/v3/posting/fbs/get', 'FBS'], ['/v2/posting/fbo/get', 'FBO']]) {
      try {
        const payload = await this.post(pathname, { posting_number: postingNumberValue });
        const posting = unwrapPosting(payload);
        if (Object.keys(posting).length) return { posting, source };
      } catch (error) {
        if (error instanceof SmartReplyOzonError && [400, 404].includes(error.status)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw new SmartReplyOzonError(
      'SMART_REPLY_POSTING_NOT_FOUND',
      'Ozon 没有返回这笔订单。',
      { status: 404, cause: lastError },
    );
  }

  async listRecentPostings({ since, to, limit = 300 } = {}) {
    const collected = [];
    const definitions = [
      { pathname: '/v3/posting/fbs/list', rows: (payload) => payload?.result?.postings },
      { pathname: '/v2/posting/fbo/list', rows: (payload) => payload?.result },
    ];
    for (const definition of definitions) {
      let offset = 0;
      while (offset < limit) {
        const pageLimit = Math.min(100, limit - offset);
        let payload;
        try {
          payload = await this.post(definition.pathname, {
            dir: 'ASC',
            filter: { since, to },
            limit: pageLimit,
            offset,
            with: { analytics_data: true, financial_data: false },
          });
        } catch (error) {
          if (error instanceof SmartReplyOzonError && [400, 404].includes(error.status)) break;
          throw error;
        }
        const rows = definition.rows(payload);
        const page = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
        collected.push(...page);
        if (page.length < pageLimit) break;
        offset += page.length;
      }
    }
    return collected;
  }

  async hasReturnOrRefund(postingNumberValue) {
    const payload = await this.post('/v1/returns/list', {
      filter: { posting_numbers: [postingNumberValue] },
      limit: 1,
      last_id: 0,
    });
    const rows = payload?.result && typeof payload.result === 'object'
      ? payload.result.returns
      : payload?.returns;
    return Array.isArray(rows) && rows.length > 0;
  }

  async startChat(postingNumberValue) {
    const payload = await this.post('/v1/chat/start', { posting_number: postingNumberValue }, { write: true });
    const chatId = text(payload?.result?.chat_id);
    if (!chatId) {
      throw new SmartReplyOzonError('SMART_REPLY_CHAT_ID_MISSING', 'Ozon 没有返回买家会话编号，未发送消息。');
    }
    return chatId;
  }

  async sendMessage(chatId, message) {
    const payload = await this.post('/v1/chat/send/message', { chat_id: chatId, text: message }, { write: true });
    return text(payload?.result?.message_id, payload?.result?.id, payload?.result).slice(0, 160);
  }

  async history(chatId) {
    const payload = await this.post('/v3/chat/history', {
      chat_id: chatId,
      limit: 30,
      direction: 'Backward',
    });
    const rows = payload?.messages ?? payload?.result?.messages;
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  }
}

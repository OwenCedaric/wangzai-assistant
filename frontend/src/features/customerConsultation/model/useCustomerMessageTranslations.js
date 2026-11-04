import { translateCustomerChatMessages } from '../services/customerConsultationClient.js';
import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import React from 'react';

const MAX_TRANSLATION_CACHE_ROWS = 240;
const CUSTOMER_TRANSLATION_BATCH_SIZE = 3;
const EMPTY_ROWS = Object.freeze([]);

function normalizeText(value) {
  return String(value ?? '').trim();
}

function containsCyrillic(value = '') {
  return /[\u0400-\u04FF]/u.test(String(value));
}

function getCacheKey(text) {
  return `ru:zh-CN:${normalizeText(text)}`;
}

function writeBoundedTranslationCache(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_TRANSLATION_CACHE_ROWS) {
    cache.delete(cache.keys().next().value);
  }
}

function createGroups(rows = [], { newestFirst = false } = {}) {
  const orderedRows = newestFirst ? [...rows].reverse() : rows;
  const groups = new Map();
  for (const row of orderedRows) {
    const id = normalizeText(row?.id);
    const text = normalizeText(row?.text);
    if (!id || !containsCyrillic(text)) continue;
    const key = getCacheKey(text);
    const group = groups.get(key) || { key, text, ids: [] };
    if (!group.ids.includes(id)) group.ids.push(id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function getCachedTranslations(groups, cache) {
  const translations = {};
  for (const group of groups) {
    const cached = cache.get(group.key);
    if (!cached) continue;
    for (const id of group.ids) translations[id] = cached;
  }
  return translations;
}

function mergeTranslationState(current, translations, failedKeys = []) {
  return {
    ...current,
    translations: { ...current.translations, ...translations },
    failedKeys: [...new Set(failedKeys)],
  };
}

function useBatchedTranslations({
  rows = [],
  scopeKey = '',
  enabled = true,
  newestFirst = false,
  batchSize = CUSTOMER_TRANSLATION_BATCH_SIZE,
}) {
  const [retryRevision, setRetryRevision] = React.useState(0);
  const translationCacheRef = React.useRef(null);
  if (!translationCacheRef.current) translationCacheRef.current = new Map();
  const [state, setState] = React.useState({
    status: 'idle',
    translations: {},
    error: '',
    failedKeys: [],
  });
  const requestIdRef = React.useRef(0);
  const stableRows = React.useMemo(
    () => rows.map((row) => ({ id: normalizeText(row?.id), text: normalizeText(row?.text) })),
    [rows]
  );
  const fingerprint = React.useMemo(() => stableRows.map((row) => `${row.id}:${row.text}`).join('|'), [stableRows]);

  React.useEffect(() => {
    const translationCache = translationCacheRef.current;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    const groups = createGroups(stableRows, { newestFirst });
    const cachedTranslations = getCachedTranslations(groups, translationCache);

    if (!enabled) {
      setState({ status: 'idle', translations: {}, error: '', failedKeys: [] });
      return () => controller.abort();
    }

    if (!groups.length) {
      setState({ status: 'success', translations: {}, error: '', failedKeys: [] });
      return () => controller.abort();
    }

    const missingGroups = groups.filter((group) => !translationCache.has(group.key));
    if (!missingGroups.length) {
      setState({ status: 'success', translations: cachedTranslations, error: '', failedKeys: [] });
      return () => controller.abort();
    }

    setState({ status: 'loading', translations: cachedTranslations, error: '', failedKeys: [] });

    const run = async () => {
      const translations = { ...cachedTranslations };
      const failedKeys = [];
      let errorMessage = '';

      for (let start = 0; start < missingGroups.length; start += batchSize) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        const batch = missingGroups.slice(start, start + batchSize);
        try {
          const payload = await translateCustomerChatMessages(
            { messages: batch.map((group) => ({ id: group.ids[0], text: group.text })) },
            { signal: controller.signal, timeoutMs: 30_000 }
          );
          if (payload?.ok === false) {
            throw new Error(payload?.error?.message || '消息翻译失败');
          }

          const rowsById = new Map((payload?.rows || []).map((row) => [normalizeText(row?.id), row]));
          for (const group of batch) {
            const row = rowsById.get(group.ids[0]);
            if (row?.translated && row?.translatedText) {
              writeBoundedTranslationCache(translationCache, group.key, row.translatedText);
              for (const id of group.ids) translations[id] = row.translatedText;
            } else {
              failedKeys.push(group.key);
              errorMessage = translateCustomerError(
                { code: row?.errorCode, message: row?.error },
                '部分消息翻译未完成，请点击重试。'
              );
            }
          }
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError') return;
          for (const group of batch) failedKeys.push(group.key);
          errorMessage = translateCustomerError(error, '消息翻译未完成，请点击重试。');
        }

        if (requestId !== requestIdRef.current) return;
        setState((current) => ({
          ...mergeTranslationState(current, translations, failedKeys),
          status: 'loading',
          error: errorMessage,
        }));
      }

      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      const hasFailures = failedKeys.length > 0;
      setState((current) => ({
        ...mergeTranslationState(current, translations, failedKeys),
        status: hasFailures ? (Object.keys(translations).length ? 'partial' : 'error') : 'success',
        error: hasFailures ? errorMessage || '翻译未完成，请点击重试。' : '',
      }));
    };

    void run();
    return () => controller.abort();
  }, [batchSize, enabled, fingerprint, newestFirst, retryRevision, scopeKey, stableRows]);

  const retry = React.useCallback(() => setRetryRevision((value) => value + 1), []);
  return { ...state, retry };
}

export function useCustomerMessageTranslations(conversation, extraRows = EMPTY_ROWS, { enabled = true } = {}) {
  const conversationId = conversation?.id || '';
  const conversationMessages = conversation?.messages || EMPTY_ROWS;
  const rows = React.useMemo(
    () =>
      conversationId
        ? [...extraRows, ...conversationMessages].map((message) => ({
            id: message.id,
            text: message.text,
          }))
        : [],
    [conversationId, conversationMessages, extraRows]
  );
  return useBatchedTranslations({
    rows,
    scopeKey: conversationId,
    enabled: Boolean(enabled && conversationId),
    newestFirst: true,
  });
}

export function useCustomerConversationPreviewTranslations(conversations = EMPTY_ROWS, { enabled = true } = {}) {
  const rows = React.useMemo(
    () =>
      conversations
        .filter(
          (conversation) =>
            conversation?.category === 'buyer' &&
            containsCyrillic(conversation.lastMessage) &&
            Boolean(conversation.lastMessage)
        )
        .slice(0, 12)
        .map((conversation) => ({ id: conversation.id, text: conversation.lastMessage })),
    [conversations]
  );
  return useBatchedTranslations({
    rows,
    scopeKey: 'conversation-preview',
    enabled,
    newestFirst: false,
    batchSize: CUSTOMER_TRANSLATION_BATCH_SIZE,
  });
}

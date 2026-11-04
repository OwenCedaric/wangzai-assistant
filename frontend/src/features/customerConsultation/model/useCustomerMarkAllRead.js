import {
  buildCustomerMarkReadTargets,
  confirmCustomerMarkAllRead,
  previewCustomerMarkAllRead,
} from '../services/customerConsultationClient.js';
import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import { isCustomerConversationMarkReadSupported } from '../lib/customerConsultationFormatter.js';
import React from 'react';

function createInitialState() {
  return {
    open: false,
    status: 'idle',
    scope: 'all',
    targetTitle: '',
    preview: null,
    result: null,
    error: '',
    chats: [],
    previewRows: [],
    unreadMessages: 0,
    readOnlyUnreadMessages: 0,
    readOnlyUnreadConversations: 0,
    shopId: '',
    accountScopeKey: '',
  };
}

const CATEGORY_LABELS = Object.freeze({
  buyer: '买家咨询',
  notification: 'Ozon 通知',
  support: '平台支持',
});

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getUnreadSummary(conversations = []) {
  return conversations.reduce(
    (summary, conversation) => {
      const unread = Math.max(Number(conversation?.unreadCount ?? conversation?.unread) || 0, 0);
      if (!unread) return summary;
      summary.total += unread;
      const readOnlyPush =
        conversation?.markReadSupported === false ||
        (conversation?.channel === 'push' && conversation?.category !== 'buyer');
      if (readOnlyPush) {
        summary.readOnly += unread;
        summary.readOnlyConversations += 1;
        return summary;
      }
      if (isCustomerConversationMarkReadSupported(conversation)) return summary;
      summary.missingTarget += unread;
      summary.missingTargetConversations += 1;
      return summary;
    },
    { total: 0, readOnly: 0, readOnlyConversations: 0, missingTarget: 0, missingTargetConversations: 0 }
  );
}

function buildPreviewRows(conversations = [], chats = []) {
  const conversationsByChatId = new Map();
  for (const conversation of conversations) {
    const chatId = normalizeText(conversation?.chatId ?? conversation?.conversationId);
    if (chatId && !conversationsByChatId.has(chatId)) {
      conversationsByChatId.set(chatId, conversation);
    }
  }

  return chats.map((chat) => {
    const chatId = normalizeText(chat?.chat_id);
    const conversation = conversationsByChatId.get(chatId) || {};
    return {
      chatId,
      title: normalizeText(conversation.title || conversation.customerName) || '未命名会话',
      categoryLabel: CATEGORY_LABELS[conversation.category] || '客服会话',
      unreadCount: Number(chat?.unread_count) || 0,
      subtitle: normalizeText(conversation.subtitle || conversation.orderNumber),
    };
  });
}

function getUnreadMessages(chats = []) {
  return chats.reduce((total, chat) => total + (Number(chat.unread_count) || 0), 0);
}

function getPreviewTitle(previewRows = [], chatId = '') {
  return previewRows.find((row) => row.chatId === normalizeText(chatId))?.title || '未命名会话';
}

function getFailureMessage(result, previewRows = []) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  if (!failures.length) {
    return translateCustomerError(result?.error, '标记已读未完成，请刷新后重试。');
  }
  const visible = failures
    .slice(0, 3)
    .map((failure) => {
      const title = getPreviewTitle(previewRows, failure.chatId);
      const message = translateCustomerError(failure.error, 'Ozon 回读未确认。');
      return `${title}：${message}`;
    })
    .join('；');
  const more = failures.length > 3 ? `；另有 ${failures.length - 3} 个会话` : '';
  return `部分会话未完成：${visible}${more}`;
}

export function useCustomerMarkAllRead({
  activeShopId = '',
  accountScopeKey = '',
  onReadbackConfirmed,
  onReadbackIncomplete,
} = {}) {
  const [state, setState] = React.useState(createInitialState);
  const [autoMarkingCount, setAutoMarkingCount] = React.useState(0);
  const [autoReadError, setAutoReadError] = React.useState('');
  const controllerRef = React.useRef(null);
  const autoControllersRef = React.useRef(new Map());
  const attemptedAutoReadKeysRef = React.useRef(new Set());
  const requestIdRef = React.useRef(0);

  const scopeKey = `${String(activeShopId || '').trim()}|${String(accountScopeKey || '').trim()}`;

  React.useEffect(() => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    for (const controller of autoControllersRef.current.values()) controller.abort();
    autoControllersRef.current = new Map();
    attemptedAutoReadKeysRef.current = new Set();
    setAutoMarkingCount(0);
    setAutoReadError('');
    setState(createInitialState());
    return () => {
      controllerRef.current?.abort();
      for (const controller of autoControllersRef.current.values()) controller.abort();
    };
  }, [scopeKey]);

  const markConversationReadAutomatically = React.useCallback(
    async (conversation, { readThroughMessageId = '' } = {}) => {
      if (!activeShopId || !conversation) return false;
      const chats = buildCustomerMarkReadTargets([
        {
          ...conversation,
          readThroughMessageId: normalizeText(readThroughMessageId),
        },
      ]);
      if (chats.length !== 1) return false;

      const target = chats[0];
      const readKey = `${scopeKey}|${target.chat_id}|${target.from_message_id}`;
      if (attemptedAutoReadKeysRef.current.has(readKey) || autoControllersRef.current.has(readKey)) {
        return false;
      }

      const controller = new AbortController();
      autoControllersRef.current.set(readKey, controller);
      setAutoMarkingCount((current) => current + 1);
      setAutoReadError('');

      try {
        const preview = await previewCustomerMarkAllRead(
          {
            shopId: activeShopId,
            accountId: accountScopeKey || activeShopId,
            chats,
          },
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return false;
        if (preview?.ok === false || !preview?.previewId) {
          throw Object.assign(new Error(preview?.error?.message || '自动已读预览创建失败'), {
            code: preview?.error?.code,
          });
        }

        const result = await confirmCustomerMarkAllRead(
          {
            previewId: preview.previewId,
            shopId: activeShopId,
            accountId: accountScopeKey || activeShopId,
            chats,
          },
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return false;

        const writeCompleted = (result?.schedulerResult?.writes || []).some(
          (write) => write?.ok === true && normalizeText(write?.chatId) === target.chat_id
        );
        const complete = result?.ok === true && result?.readBack?.status === 'success';
        if (writeCompleted) attemptedAutoReadKeysRef.current.add(readKey);
        if (complete && typeof onReadbackConfirmed === 'function') {
          await onReadbackConfirmed(result);
        } else if (writeCompleted && typeof onReadbackIncomplete === 'function') {
          await onReadbackIncomplete(result, { conversation, target });
        }
        if (!complete) {
          setAutoReadError(getFailureMessage(result, buildPreviewRows([conversation], chats)));
        }
        return complete;
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') return false;
        setAutoReadError(translateCustomerError(error, 'Ozon 自动标记已读失败，可点击“标记已读”重试。'));
        return false;
      } finally {
        autoControllersRef.current.delete(readKey);
        setAutoMarkingCount((current) => Math.max(0, current - 1));
      }
    },
    [accountScopeKey, activeShopId, onReadbackConfirmed, onReadbackIncomplete, scopeKey]
  );

  const requestMarkRead = React.useCallback(
    async (conversations = [], { scope = 'all', targetTitle = '' } = {}) => {
      const chats = buildCustomerMarkReadTargets(conversations);
      const previewRows = buildPreviewRows(conversations, chats);
      const unreadSummary = getUnreadSummary(conversations);
      if (!activeShopId) {
        setState({
          ...createInitialState(),
          open: true,
          status: 'error',
          error: '请先选择 Ozon 店铺。',
        });
        return false;
      }
      if (!chats.length) {
        const onlyReadOnlyUnread =
          unreadSummary.total > 0 &&
          unreadSummary.readOnly === unreadSummary.total &&
          unreadSummary.missingTarget === 0;
        setState({
          ...createInitialState(),
          open: true,
          status: onlyReadOnlyUnread ? 'readonly' : 'error',
          error: onlyReadOnlyUnread
            ? '当前有 ' +
              unreadSummary.readOnly +
              ' 条 Ozon 自动消息/信息推送。此类内容是只读推送，Ozon 未提供 chat.read，无法通过客服板块标记已读。'
            : unreadSummary.total
              ? '当前未读会话缺少可用的 chat_id 或消息 ID，无法安全标记已读。请先刷新会话列表。'
              : '当前没有可标记已读的会话。',
          scope,
          targetTitle,
          readOnlyUnreadMessages: unreadSummary.readOnly,
          readOnlyUnreadConversations: unreadSummary.readOnlyConversations,
        });
        return false;
      }

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setState({
        ...createInitialState(),
        open: true,
        status: 'previewing',
        scope,
        targetTitle,
        chats,
        previewRows,
        unreadMessages: getUnreadMessages(chats),
        readOnlyUnreadMessages: unreadSummary.readOnly,
        readOnlyUnreadConversations: unreadSummary.readOnlyConversations,
        shopId: activeShopId,
        accountScopeKey,
      });

      try {
        const preview = await previewCustomerMarkAllRead(
          {
            shopId: activeShopId,
            accountId: accountScopeKey || activeShopId,
            chats,
          },
          { signal: controller.signal }
        );
        if (controller.signal.aborted || requestId !== requestIdRef.current) return false;
        if (preview?.ok === false) {
          throw Object.assign(new Error(preview?.error?.message || '标记已读预览创建失败'), {
            code: preview?.error?.code,
          });
        }
        setState((current) => ({ ...current, status: 'ready', preview, error: '' }));
        return true;
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') return false;
        if (requestId !== requestIdRef.current) return false;
        setState((current) => ({
          ...current,
          status: 'error',
          error: translateCustomerError(error, '标记已读预览创建失败，请稍后重试。'),
        }));
        return false;
      }
    },
    [accountScopeKey, activeShopId]
  );

  const requestMarkAllRead = React.useCallback(
    (conversations = []) => requestMarkRead(conversations, { scope: 'all' }),
    [requestMarkRead]
  );

  const requestMarkConversationRead = React.useCallback(
    (conversation) =>
      requestMarkRead(conversation ? [conversation] : [], {
        scope: 'single',
        targetTitle: normalizeText(conversation?.title || conversation?.customerName) || '当前会话',
      }),
    [requestMarkRead]
  );

  const confirmMarkAllRead = React.useCallback(async () => {
    if (state.status !== 'ready' || !state.preview?.previewId || !state.chats.length) return false;
    if (!activeShopId || state.shopId !== activeShopId || state.accountScopeKey !== accountScopeKey) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: '店铺或账号已切换，请重新创建标记已读预览。',
      }));
      return false;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({ ...current, status: 'confirming', error: '' }));

    try {
      const result = await confirmCustomerMarkAllRead(
        {
          previewId: state.preview.previewId,
          shopId: activeShopId,
          accountId: accountScopeKey || activeShopId,
          chats: state.chats,
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted || requestId !== requestIdRef.current) return false;

      const readbackStatus = result?.readBack?.status;
      const complete = result?.ok === true && readbackStatus === 'success';
      const partial = Array.isArray(result?.failures) && result.failures.length > 0;
      const nextStatus = complete ? 'success' : partial ? 'partial' : result?.ok === false ? 'error' : 'pending';
      setState((current) => ({
        ...current,
        status: nextStatus,
        result,
        error: complete ? '' : getFailureMessage(result, current.previewRows) || '尚未从 Ozon 回读确认全部已读。',
      }));
      if (complete && typeof onReadbackConfirmed === 'function') {
        await onReadbackConfirmed(result);
      }
      return complete;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return false;
      if (requestId !== requestIdRef.current) return false;
      setState((current) => ({
        ...current,
        status: 'error',
        error: translateCustomerError(error, 'Ozon 标记已读失败，请稍后重试。'),
      }));
      return false;
    }
  }, [accountScopeKey, activeShopId, onReadbackConfirmed, state]);

  const closeMarkAllRead = React.useCallback(() => {
    if (state.status === 'previewing' || state.status === 'confirming') return;
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestIdRef.current += 1;
    setState(createInitialState());
  }, [state.status]);

  return {
    markAllReadState: state,
    autoMarking: autoMarkingCount > 0,
    autoReadError,
    requestMarkRead,
    requestMarkAllRead,
    requestMarkConversationRead,
    markConversationReadAutomatically,
    confirmMarkAllRead,
    closeMarkAllRead,
  };
}

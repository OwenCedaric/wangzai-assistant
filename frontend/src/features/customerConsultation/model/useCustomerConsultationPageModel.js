import {
  customerConsultationCapabilities,
  customerConsultationFilters,
  customerConsultationPagination,
  customerConsultationStatusFilters,
} from '../constants/customerConsultationRules.js';
import {
  getCustomerConversationUnreadBreakdown,
  getCustomerConversationUnreadCount,
  getFilteredCustomerConversations,
  getSelectedCustomerConversation,
  isCustomerConversationMarkReadSupported,
} from '../lib/customerConsultationFormatter.js';
import { getCustomerSyncStatusLabel } from '../lib/customerConsultationLocale.js';
import { formatCustomerChatDateTime } from '../lib/customerOzonChatFormatter.js';
import { buildCustomerShopUnreadSnapshot } from '../lib/customerGlobalUnread.js';
import { buildCustomerOrderTimeline, resolveCustomerProductContext } from '../lib/customerOrderTimeline.js';
import { getOzonGenerationAwareShopSourceKey } from '../../../shared/ozon/ozonShopGeneration.js';
import { useCustomerConsultationDraft } from './useCustomerConsultationDraft.js';
import { useCustomerConsultationNotifications } from './useCustomerConsultationNotifications.js';
import { useCustomerMessageSend } from './useCustomerMessageSend.js';
import { useCustomerFileSend } from './useCustomerFileSend.js';
import { getCustomerOrderPostingNumber, useCustomerConversationStart } from './useCustomerConversationStart.js';
import { useCustomerMarkAllRead } from './useCustomerMarkAllRead.js';
import {
  useCustomerConversationPreviewTranslations,
  useCustomerMessageTranslations,
} from './useCustomerMessageTranslations.js';
import { useCustomerOrderContext } from './useCustomerOrderContext.js';
import { useCustomerOzonConversations } from './useCustomerOzonConversations.js';
import {
  applyCustomerConsultationRealtimeEvent,
  useCustomerConsultationRealtime,
} from './useCustomerConsultationRealtime.js';
import { useCustomerQuickReplies } from './useCustomerQuickReplies.js';
import { useCustomerShopProfile } from './useCustomerShopProfile.js';
import React from 'react';

function getShopName(shop = {}) {
  return String(shop.sellerName || shop.shopAlias || shop.name || shop.alias || '当前 Ozon 店铺').trim();
}

function getSyncTone(status) {
  if (status === 'success') return 'success';
  if (status === 'loading' || status === 'refreshing') return 'info';
  if (status === 'stale') return 'warning';
  if (status === 'error') return 'error';
  return 'default';
}

export function getLatestRenderedMessageId(conversation = {}) {
  if (conversation?.historyStatus !== 'success') return '';
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  return String(
    [...messages].reverse().find((message) => message?.messageId)?.messageId || ''
  ).trim();
}

export function useCustomerConsultationPageModel({
  shops = [],
  activeShopId = '',
  isActive = true,
  openTarget = null,
} = {}) {
  const activeShop = React.useMemo(() => shops.find((shop) => shop.id === activeShopId) || null, [activeShopId, shops]);
  const accountScopeKey = React.useMemo(
    () => (activeShop ? getOzonGenerationAwareShopSourceKey(activeShop) : activeShopId),
    [activeShop, activeShopId]
  );
  const shopProfileState = useCustomerShopProfile(activeShopId, {
    enabled: isActive,
    accountId: accountScopeKey,
  });
  const notificationState = useCustomerConsultationNotifications(activeShopId, {
    enabled: isActive,
  });
  const conversationState = useCustomerOzonConversations(activeShopId, {
    enabled: isActive,
    accountScopeKey,
    shopName: getShopName(activeShop || {}),
  });
  const draftState = useCustomerConsultationDraft('', accountScopeKey);
  const quickReplies = useCustomerQuickReplies(accountScopeKey);
  const setQuickRepliesOpen = quickReplies.setOpen;
  const {
    rows: conversationRows,
    refreshConversation,
    refreshConversationFromCache,
    ensureHistory,
    preloadHistories,
    preloadFullHistories,
    loadOlderHistory,
    refreshList,
    applyReadback,
    loadAll,
    loadMore,
    status: conversationStatus,
    error: conversationError,
    emptyReason: conversationEmptyReason,
    hasNext: conversationHasNext,
    loadingMore: conversationLoadingMore,
    backgroundSyncing: conversationBackgroundSyncing,
    backgroundError: conversationBackgroundError,
    historyLoadingIds,
    refreshedAt,
    totalCount: conversationTotalCount,
  } = conversationState;
  const [preparingMarkRead, setPreparingMarkRead] = React.useState(false);
  const [newMessageAlert, setNewMessageAlert] = React.useState(null);
  const handledOpenTargetRef = React.useRef('');
  const conversationBaselineRef = React.useRef({ scopeKey: '', messages: new Map() });
  const autoRefreshBusyRef = React.useRef(false);
  const lastAutoRefreshAtRef = React.useRef(0);
  const historyIndexControllerRef = React.useRef(null);
  const historyIndexAttemptedRef = React.useRef({ scopeKey: '', ids: new Set() });
  const historyIndexRetryTimerRef = React.useRef(null);
  const [historyIndexRetryTick, setHistoryIndexRetryTick] = React.useState(0);
  const {
    clearDraft,
    selectedFilterId,
    selectedStatusId,
    debouncedSearchText,
    unreadOnly,
    updateDraft,
    selectFilter,
    selectStatus,
    setUnreadOnly,
    selectConversation,
    setSearchText,
    draftsByConversation,
    searchText,
    selectedConversationId,
  } = draftState;
  const { rows: notificationRows, refresh: refreshNotifications } = notificationState;
  const handleRealtimeEvent = React.useCallback(
    (event) =>
      applyCustomerConsultationRealtimeEvent(event, {
        refreshList,
        refreshConversationFromCache,
        refreshNotifications,
      }),
    [refreshConversationFromCache, refreshList, refreshNotifications]
  );
  useCustomerConsultationRealtime({
    shopId: activeShopId,
    enabled: isActive,
    onEvent: handleRealtimeEvent,
  });

  React.useEffect(() => {
    const requestId = String(openTarget?.requestId || '').trim();
    const targetShopId = String(openTarget?.shopId || '').trim();
    const targetConversationId = String(openTarget?.conversationId || '').trim();
    const targetChatId = String(openTarget?.chatId || '').trim();
    if (!isActive || !requestId || targetShopId !== activeShopId || handledOpenTargetRef.current === requestId) {
      return;
    }
    const matching = conversationRows.find(
      (row) =>
        (targetConversationId && row.id === targetConversationId) ||
        (targetChatId && (row.chatId === targetChatId || row.conversationId === targetChatId))
    );
    if (!matching?.id) return;
    selectFilter('all');
    selectStatus('all');
    setUnreadOnly(false);
    setSearchText('');
    selectConversation(matching.id);
    handledOpenTargetRef.current = requestId;
  }, [
    activeShopId,
    conversationRows,
    isActive,
    openTarget,
    selectConversation,
    selectFilter,
    selectStatus,
    setSearchText,
    setUnreadOnly,
  ]);
  const handleReadbackConfirmed = React.useCallback(
    async (conversationId) => {
      clearDraft(conversationId);
      await refreshConversation(conversationId);
    },
    [clearDraft, refreshConversation]
  );
  const { requestSend, sendState, closeSend, confirmSend, retrySendReadback } = useCustomerMessageSend({
    activeShopId,
    onReadbackConfirmed: handleReadbackConfirmed,
  });
  const { requestFileSend, fileSendState, closeFileSend, confirmFileSend, retryFileReadback } = useCustomerFileSend({
    activeShopId,
    onReadbackConfirmed: handleReadbackConfirmed,
  });

  const handleRefresh = React.useCallback(async () => {
    const [rows] = await Promise.all([refreshList({ forceRefresh: true }), refreshNotifications()]);
    return rows;
  }, [refreshList, refreshNotifications]);

  React.useEffect(() => {
    if (!isActive || !activeShopId) return undefined;
    const runRefresh = async () => {
      if (autoRefreshBusyRef.current) return;
      autoRefreshBusyRef.current = true;
      try {
        await handleRefresh();
        lastAutoRefreshAtRef.current = Date.now();
      } finally {
        autoRefreshBusyRef.current = false;
      }
    };
    const maybeRefresh = () => {
      if (Date.now() - lastAutoRefreshAtRef.current >= customerConsultationPagination.focusRefreshStaleMs) {
        void runRefresh();
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') maybeRefresh();
    };
    const interval = globalThis.setInterval(runRefresh, customerConsultationPagination.autoRefreshIntervalMs);
    globalThis.addEventListener?.('focus', maybeRefresh);
    document.addEventListener?.('visibilitychange', handleVisibility);
    return () => {
      globalThis.clearInterval(interval);
      globalThis.removeEventListener?.('focus', maybeRefresh);
      document.removeEventListener?.('visibilitychange', handleVisibility);
    };
  }, [activeShopId, handleRefresh, isActive]);

  React.useEffect(() => {
    const current = new Map(
      conversationRows.map((row) => [
        row.id,
        {
          lastMessageId: String(row.lastMessageId || ''),
          unreadCount: Number(row.unreadCount ?? row.unread) || 0,
          title: row.title || '新消息',
        },
      ])
    );
    const baseline = conversationBaselineRef.current;
    if (!accountScopeKey || baseline.scopeKey !== accountScopeKey || !baseline.messages.size) {
      conversationBaselineRef.current = { scopeKey: accountScopeKey, messages: current };
      return;
    }
    const changed = conversationRows.filter((row) => {
      const previous = baseline.messages.get(row.id);
      const unreadCount = Number(row.unreadCount ?? row.unread) || 0;
      if (!previous) return unreadCount > 0;
      return Boolean(
        unreadCount > previous.unreadCount ||
        (unreadCount > 0 && String(row.lastMessageId || '') !== previous.lastMessageId)
      );
    });
    conversationBaselineRef.current = { scopeKey: accountScopeKey, messages: current };
    if (!changed.length) return;
    const first = changed[0];
    const message = changed.length === 1 ? `${first.title} 收到新消息` : `收到 ${changed.length} 个会话的新消息`;
    setNewMessageAlert({ message, key: `${Date.now()}-${changed.length}` });
    if (document.visibilityState !== 'visible' && globalThis.Notification?.permission === 'granted') {
      new globalThis.Notification('旺崽助手在线客服', { body: message });
    }
  }, [accountScopeKey, conversationRows]);

  const handleVisibleConversationIdsChange = React.useCallback(
    (conversationIds) => {
      if (!isActive || !conversationIds?.length) return;
      void preloadHistories(conversationIds, {
        concurrency: customerConsultationPagination.visibleHistoryPrefetchConcurrency,
      });
    },
    [isActive, preloadHistories]
  );

  React.useEffect(() => {
    clearTimeout(historyIndexRetryTimerRef.current);
    historyIndexRetryTimerRef.current = null;
    historyIndexControllerRef.current?.abort();
    historyIndexControllerRef.current = null;
    historyIndexAttemptedRef.current = { scopeKey: accountScopeKey, ids: new Set() };
    return () => {
      clearTimeout(historyIndexRetryTimerRef.current);
      historyIndexRetryTimerRef.current = null;
      historyIndexControllerRef.current?.abort();
    };
  }, [accountScopeKey]);

  React.useEffect(() => {
    if (!isActive || !accountScopeKey || !conversationRows.length) return;
    const tracker = historyIndexAttemptedRef.current;
    if (tracker.scopeKey !== accountScopeKey) {
      tracker.scopeKey = accountScopeKey;
      tracker.ids = new Set();
    }
    const pending = conversationRows
      .filter((conversation) => conversation.channel === 'chat' && !conversation.historyIndexComplete)
      .map((conversation) => conversation.id)
      .filter((conversationId) => conversationId && !tracker.ids.has(conversationId));
    if (!pending.length) return;
    pending.forEach((conversationId) => tracker.ids.add(conversationId));
    const controller = historyIndexControllerRef.current || new AbortController();
    historyIndexControllerRef.current = controller;
    void preloadFullHistories(pending, {
      signal: controller.signal,
      concurrency: customerConsultationPagination.backgroundFullHistoryConcurrency,
      priority: 'P3',
      requestedBy: 'customer-consultation-full-history-index',
    }).then((results = []) => {
      if (controller.signal.aborted) return;
      const incompleteIds = results
        .filter((result) => result && result.complete !== true)
        .map((result) => result.conversationId)
        .filter(Boolean);
      if (!incompleteIds.length) return;
      clearTimeout(historyIndexRetryTimerRef.current);
      historyIndexRetryTimerRef.current = setTimeout(() => {
        const currentTracker = historyIndexAttemptedRef.current;
        if (currentTracker.scopeKey !== accountScopeKey) return;
        incompleteIds.forEach((conversationId) => currentTracker.ids.delete(conversationId));
        setHistoryIndexRetryTick((current) => current + 1);
      }, customerConsultationPagination.backgroundFullHistoryRetryMs);
    });
  }, [accountScopeKey, conversationRows, historyIndexRetryTick, isActive, preloadFullHistories]);
  const handleMarkReadbackConfirmed = React.useCallback(
    (result) => {
      applyReadback(result?.readBack?.targets);
    },
    [applyReadback]
  );
  const handleMarkReadbackIncomplete = React.useCallback(
    async (_result, { conversation } = {}) => {
      const conversationId = String(conversation?.id || '').trim();
      await refreshList({ forceRefresh: true });
      if (conversationId) {
        await refreshConversation(conversationId);
      }
    },
    [refreshConversation, refreshList]
  );
  const handleStartReadbackConfirmed = React.useCallback(
    async (result) => {
      const rows = await handleRefresh();
      const chatId = result?.readBack?.chatId;
      const matching = (Array.isArray(rows) ? rows : []).find((row) => row.chatId === chatId || row.id === chatId);
      if (matching?.id) selectConversation(matching.id);
      return rows;
    },
    [handleRefresh, selectConversation]
  );
  const { startState, openStart, setPostingNumber, requestStart, confirmStart, retryStartReadback, closeStart } =
    useCustomerConversationStart({ activeShopId, onReadbackConfirmed: handleStartReadbackConfirmed });
  const {
    markAllReadState,
    autoMarking,
    autoReadError,
    requestMarkAllRead,
    requestMarkConversationRead,
    markConversationReadAutomatically,
    closeMarkAllRead,
    confirmMarkAllRead,
  } = useCustomerMarkAllRead({
    activeShopId,
    accountScopeKey,
    onReadbackConfirmed: handleMarkReadbackConfirmed,
    onReadbackIncomplete: handleMarkReadbackIncomplete,
  });

  const filteredConversations = React.useMemo(
    () =>
      getFilteredCustomerConversations(conversationRows, selectedFilterId, debouncedSearchText, {
        statusId: selectedStatusId,
        unreadOnly,
      }),
    [conversationRows, debouncedSearchText, selectedFilterId, selectedStatusId, unreadOnly]
  );
  const selectedConversation = getSelectedCustomerConversation(filteredConversations, selectedConversationId);
  const activeConversationId = selectedConversation?.id || '';
  const unreadBreakdown = React.useMemo(
    () => getCustomerConversationUnreadBreakdown(conversationRows),
    [conversationRows]
  );
  const orderContextState = useCustomerOrderContext({
    shopId: activeShopId,
    conversation: selectedConversation,
    enabled: isActive,
  });
  const handleOpenStartConversation = React.useCallback(() => {
    const postingNumber = String(
      getCustomerOrderPostingNumber(orderContextState.order || {}) || selectedConversation?.orderNumber || ''
    ).trim();
    openStart(postingNumber === '—' || postingNumber === '未关联订单' ? '' : postingNumber);
  }, [openStart, orderContextState.order, selectedConversation?.orderNumber]);
  const detailTimelineRows = React.useMemo(
    () =>
      selectedConversation
        ? buildCustomerOrderTimeline({
            conversation: selectedConversation,
            orderRow: orderContextState.order,
            orderRows: orderContextState.orders,
            purchaseRows: orderContextState.purchaseRows,
            purchaseLinks: orderContextState.purchaseLinks,
            logisticsRows: orderContextState.logisticsRows,
            notifications: notificationRows,
          })
        : [],
    [
      notificationRows,
      orderContextState.logisticsRows,
      orderContextState.order,
      orderContextState.orders,
      orderContextState.purchaseLinks,
      orderContextState.purchaseRows,
      selectedConversation,
    ]
  );
  const detailProduct = React.useMemo(
    () => (selectedConversation ? resolveCustomerProductContext(selectedConversation, orderContextState.order) : null),
    [orderContextState.order, selectedConversation]
  );
  const contextTranslationRows = React.useMemo(() => {
    if (!selectedConversation) return [];
    const rows = [];
    if (detailProduct?.name) {
      rows.push({ id: `product:${selectedConversation.id}`, text: detailProduct.name });
    }
    for (const event of detailTimelineRows) {
      if (event.title) rows.push({ id: `timeline:${event.id}:title`, text: event.title });
      if (event.detail) rows.push({ id: `timeline:${event.id}:detail`, text: event.detail });
    }
    return rows;
  }, [detailProduct?.name, detailTimelineRows, selectedConversation]);
  const messageTranslationState = useCustomerMessageTranslations(selectedConversation, contextTranslationRows, {
    enabled: isActive,
  });
  const previewTranslationState = useCustomerConversationPreviewTranslations(filteredConversations, {
    // Detail translation has priority. Running list-preview translation at the
    // same time used to create duplicate batches and make retries less reliable.
    enabled: Boolean(isActive && !selectedConversation),
  });
  const activeConversationHistoryStale = Boolean(
    selectedConversation?.historyStale || selectedConversation?.historyStatus === 'stale'
  );
  const activeConversationHistoryKey = selectedConversation
    ? `${selectedConversation.id}|${selectedConversation.lastMessageId || ''}|${selectedConversation.historyStatus || ''}|${selectedConversation.historyStale ? 'stale' : 'current'}|${selectedConversation.historyLoadedThroughMessageId || ''}`
    : '';

  React.useEffect(() => {
    if (!isActive || !activeConversationId) return;
    void ensureHistory(activeConversationId, {
      forceRefresh: activeConversationHistoryStale,
      requestedBy: activeConversationHistoryStale ? 'customer-consultation-new-message-refresh' : undefined,
    });
  }, [activeConversationHistoryKey, activeConversationHistoryStale, activeConversationId, ensureHistory, isActive]);

  const latestRenderedMessageId = getLatestRenderedMessageId(selectedConversation || {});
  React.useEffect(() => {
    const unread = Number(selectedConversation?.unreadCount ?? selectedConversation?.unread) || 0;
    if (
      !isActive ||
      !selectedConversation ||
      !selectedConversationId ||
      selectedConversation.id !== selectedConversationId ||
      unread <= 0 ||
      !latestRenderedMessageId ||
      !isCustomerConversationMarkReadSupported(selectedConversation)
    ) {
      return undefined;
    }

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      void markConversationReadAutomatically(selectedConversation, {
        readThroughMessageId: latestRenderedMessageId,
      });
    };
    const frameId = globalThis.requestAnimationFrame?.(run);
    const timeoutId = frameId === undefined ? globalThis.setTimeout(run, 0) : null;
    return () => {
      cancelled = true;
      if (frameId !== undefined) globalThis.cancelAnimationFrame?.(frameId);
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
    };
  }, [
    isActive,
    latestRenderedMessageId,
    markConversationReadAutomatically,
    selectedConversation,
    selectedConversationId,
  ]);

  const handleUseQuickReply = React.useCallback(
    (phrase) => {
      if (!selectedConversation || !activeConversationId || !phrase?.text) return;
      updateDraft(activeConversationId, phrase.text);
      void requestSend({ conversation: selectedConversation, text: phrase.text });
    },
    [activeConversationId, updateDraft, requestSend, selectedConversation]
  );

  const handleRequestMarkConversationRead = React.useCallback(
    () =>
      requestMarkConversationRead(
        selectedConversation
          ? {
              ...selectedConversation,
              readThroughMessageId: latestRenderedMessageId || selectedConversation.lastMessageId || '',
            }
          : null
      ),
    [latestRenderedMessageId, requestMarkConversationRead, selectedConversation]
  );

  const unreadCount = getCustomerConversationUnreadCount(conversationRows);
  const globalUnreadSnapshot = React.useMemo(
    () => buildCustomerShopUnreadSnapshot(activeShop || { id: activeShopId }, conversationRows),
    [activeShop, activeShopId, conversationRows]
  );
  const stats = React.useMemo(
    () => [
      {
        label: conversationHasNext ? '会话同步中' : '全部会话',
        value:
          conversationHasNext && conversationTotalCount > conversationRows.length
            ? `${conversationRows.length}/${conversationTotalCount}`
            : conversationRows.length,
      },
      { label: '未读消息', value: unreadCount },
      { label: '当前筛选', value: filteredConversations.length },
      {
        label: '最后刷新',
        value: refreshedAt ? formatCustomerChatDateTime(refreshedAt, { compact: true }) : '尚未刷新',
      },
    ],
    [
      conversationHasNext,
      conversationTotalCount,
      refreshedAt,
      conversationRows.length,
      filteredConversations.length,
      unreadCount,
    ]
  );

  const handleChangeDraft = React.useCallback(
    (value) => updateDraft(activeConversationId, value),
    [activeConversationId, updateDraft]
  );
  const handleRequestSend = React.useCallback(
    (text) => requestSend({ conversation: selectedConversation, text }),
    [requestSend, selectedConversation]
  );
  const handleRequestFile = React.useCallback(
    (file) => requestFileSend({ conversation: selectedConversation, file }),
    [requestFileSend, selectedConversation]
  );
  const handleOpenQuickReplies = React.useCallback(() => setQuickRepliesOpen(true), [setQuickRepliesOpen]);
  const handleThreadRefresh = React.useCallback(
    () => refreshConversation(activeConversationId),
    [activeConversationId, refreshConversation]
  );
  const handleRequestMarkAllRead = React.useCallback(async () => {
    setPreparingMarkRead(true);
    try {
      const rows = await loadAll();
      return await requestMarkAllRead(rows);
    } finally {
      setPreparingMarkRead(false);
    }
  }, [loadAll, requestMarkAllRead]);
  const filteredEmptyReason =
    conversationRows.length && !filteredConversations.length ? '没有符合筛选条件的会话' : conversationEmptyReason;
  const activeDraftText = draftsByConversation[activeConversationId] || '';
  const conversationListProps = React.useMemo(
    () => ({
      filters: customerConsultationFilters,
      statusFilters: customerConsultationStatusFilters,
      conversations: filteredConversations,
      previewTranslations: previewTranslationState.translations,
      selectedFilterId,
      selectedStatusId,
      selectedConversationId: activeConversationId,
      unreadOnly,
      searchText,
      unreadCount,
      actionableUnreadCount: unreadBreakdown.actionable,
      readOnlyUnreadCount: unreadBreakdown.readOnly,
      readOnlyUnreadConversations: unreadBreakdown.readOnlyConversations,
      syncStatus: conversationStatus,
      syncError: conversationError,
      emptyReason: filteredEmptyReason,
      hasNext: conversationHasNext,
      loadingMore: conversationLoadingMore,
      backgroundSyncing: conversationBackgroundSyncing,
      backgroundError: conversationBackgroundError,
      loadedCount: conversationRows.length,
      totalCount: conversationTotalCount,
      onSelectFilter: selectFilter,
      onSelectStatus: selectStatus,
      onToggleUnread: setUnreadOnly,
      onSelectConversation: selectConversation,
      onSearchChange: setSearchText,
      onRefresh: handleRefresh,
      onLoadMore: loadMore,
      onMarkAllRead: handleRequestMarkAllRead,
      onVisibleConversationIdsChange: handleVisibleConversationIdsChange,
      onStartConversation: customerConsultationCapabilities.startConversation.available
        ? handleOpenStartConversation
        : undefined,
      markingRead: preparingMarkRead || autoMarking || ['previewing', 'confirming'].includes(markAllReadState.status),
      markReadSupported: customerConsultationCapabilities.markRead.available,
      markReadUnavailableReason: customerConsultationCapabilities.markRead.reason,
    }),
    [
      activeConversationId,
      conversationError,
      conversationBackgroundError,
      conversationBackgroundSyncing,
      conversationHasNext,
      conversationLoadingMore,
      conversationStatus,
      conversationTotalCount,
      conversationRows.length,
      filteredConversations,
      filteredEmptyReason,
      handleRefresh,
      loadMore,
      handleRequestMarkAllRead,
      handleVisibleConversationIdsChange,
      handleOpenStartConversation,
      markAllReadState.status,
      autoMarking,
      preparingMarkRead,
      previewTranslationState.translations,
      searchText,
      selectConversation,
      selectFilter,
      selectStatus,
      selectedFilterId,
      selectedStatusId,
      setSearchText,
      setUnreadOnly,
      unreadCount,
      unreadBreakdown.actionable,
      unreadBreakdown.readOnly,
      unreadBreakdown.readOnlyConversations,
      unreadOnly,
    ]
  );
  const threadProps = React.useMemo(
    () => ({
      conversation: selectedConversation,
      translations: messageTranslationState.translations,
      translationStatus: messageTranslationState.status,
      translationError: messageTranslationState.error,
      onRetryTranslation: messageTranslationState.retry,
      unreadCount: Number(selectedConversation?.unreadCount ?? selectedConversation?.unread) || 0,
      markReadSupported: isCustomerConversationMarkReadSupported(selectedConversation || {}),
      markReadUnavailableReason: selectedConversation?.markReadUnavailableReason || '当前会话缺少可用的已读标识',
      markingRead: autoMarking || ['previewing', 'confirming'].includes(markAllReadState.status),
      onMarkRead: handleRequestMarkConversationRead,
      refreshing: historyLoadingIds.includes(activeConversationId),
      onRefresh: activeConversationId ? handleThreadRefresh : undefined,
      onLoadOlder: activeConversationId ? () => loadOlderHistory(activeConversationId) : undefined,
    }),
    [
      activeConversationId,
      handleThreadRefresh,
      handleRequestMarkConversationRead,
      historyLoadingIds,
      loadOlderHistory,
      markAllReadState.status,
      autoMarking,
      messageTranslationState.error,
      messageTranslationState.status,
      messageTranslationState.translations,
      messageTranslationState.retry,
      selectedConversation,
    ]
  );
  const composerProps = React.useMemo(
    () => ({
      conversationId: activeConversationId,
      replyEnabled: Boolean(
        selectedConversation?.replyEnabled && customerConsultationCapabilities.sendMessage.available
      ),
      replyUnavailableReason: selectedConversation?.replyEnabled ? '' : '当前会话为只读；后端未提供回复能力',
      draftText: activeDraftText,
      sending: sendState.status === 'previewing' || sendState.status === 'confirming',
      onChangeDraft: handleChangeDraft,
      onOpenQuickReplies: handleOpenQuickReplies,
      onRequestSend: handleRequestSend,
      onRequestFile: customerConsultationCapabilities.sendFile.available ? handleRequestFile : undefined,
    }),
    [
      activeConversationId,
      activeDraftText,
      handleChangeDraft,
      handleOpenQuickReplies,
      handleRequestSend,
      handleRequestFile,
      selectedConversation,
      sendState.status,
    ]
  );
  const detailPanelProps = React.useMemo(
    () => ({
      conversation: selectedConversation,
      orderRow: orderContextState.order,
      orderRows: orderContextState.orders,
      purchaseRows: orderContextState.purchaseRows,
      purchaseLinks: orderContextState.purchaseLinks,
      logisticsRows: orderContextState.logisticsRows,
      orderContextStatus: orderContextState.status,
      notifications: notificationRows,
      product: detailProduct,
      timelineRows: detailTimelineRows,
      translations: messageTranslationState.translations,
    }),
    [
      detailProduct,
      detailTimelineRows,
      messageTranslationState.translations,
      notificationRows,
      orderContextState.logisticsRows,
      orderContextState.order,
      orderContextState.orders,
      orderContextState.purchaseLinks,
      orderContextState.purchaseRows,
      orderContextState.status,
      selectedConversation,
    ]
  );

  return {
    activeConversationId,
    unreadCount,
    globalUnreadSnapshot,
    activeShop,
    accountScopeKey,
    stats,
    shopProfile: shopProfileState.profile,
    shopProfileStatus: shopProfileState.status,
    syncLabel: getCustomerSyncStatusLabel(conversationStatus),
    syncTone: getSyncTone(conversationStatus),
    conversationListProps,
    selectedConversation,
    threadProps,
    composerProps,
    quickReplies,
    handleUseQuickReply,
    detailPanelProps,
    sendState,
    closeSend,
    confirmSend,
    retrySendReadback,
    fileSendState,
    closeFileSend,
    confirmFileSend,
    retryFileReadback,
    startState,
    setPostingNumber,
    requestStart,
    confirmStart,
    retryStartReadback,
    closeStart,
    markAllReadState,
    autoReadError,
    closeMarkAllRead,
    confirmMarkAllRead,
    newMessageAlert,
    closeNewMessageAlert: () => setNewMessageAlert(null),
  };
}

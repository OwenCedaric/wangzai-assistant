import { customerConsultationPagination } from '../constants/customerConsultationRules.js';
import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import {
  getCustomerChatListMeta,
  mergeCustomerChatHistory,
  mergeCustomerConversations,
  normalizeCustomerChatList,
} from '../lib/customerOzonChatFormatter.js';
import {
  readCustomerChatHistory,
  readCustomerChatList,
  readCustomerPushViewMarkers,
  saveCustomerPushViewMarker,
} from '../services/customerConsultationClient.js';
import React from 'react';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function createInitialState() {
  return {
    status: 'idle',
    rows: [],
    error: '',
    emptyReason: '',
    refreshedAt: '',
    hasNext: false,
    nextOffset: 0,
    nextCursor: '',
    loadingMore: false,
    backgroundSyncing: false,
    backgroundError: '',
    totalUnreadCount: 0,
    totalCount: 0,
  };
}

function createLinkedController(parentSignal) {
  const controller = new AbortController();
  if (parentSignal?.aborted) controller.abort();
  else if (parentSignal) {
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
}

function waitForBackgroundStart(signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(true), customerConsultationPagination.backgroundStartDelayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true }
    );
  });
}

function retainLoadedHistory(freshRows, previousRows) {
  const previousById = new Map(previousRows.map((row) => [row.id, row]));
  return freshRows.map((fresh) => {
    const previous = previousById.get(fresh.id);
    const previousTime = Date.parse(previous?.lastMessageAt || previous?.updatedAt || '');
    const freshTime = Date.parse(fresh?.lastMessageAt || fresh?.updatedAt || '');
    const previousLatestRole = previous?.messages?.at?.(-1)?.role || '';
    const previousIsNewerConfirmedOutbound =
      previous?.historyLoaded &&
      previousLatestRole === 'seller' &&
      Number(fresh?.unreadCount ?? fresh?.unread) === 0 &&
      Number.isFinite(previousTime) &&
      (!Number.isFinite(freshTime) || previousTime > freshTime);
    const canKeepHistory =
      previous?.historyLoaded && (previous.lastMessageId === fresh.lastMessageId || previousIsNewerConfirmedOutbound);
    if (canKeepHistory) {
      return {
        ...fresh,
        ...previous,
        unread: fresh.unread,
        unreadCount: fresh.unreadCount,
        readState: fresh.readState,
        markReadSupported: fresh.markReadSupported,
        markReadUnavailableReason: fresh.markReadUnavailableReason,
        rawStatus: fresh.rawStatus,
        chatStatus: fresh.chatStatus,
        lastMessageId: previousIsNewerConfirmedOutbound ? previous.lastMessageId : fresh.lastMessageId,
        firstUnreadMessageId: fresh.firstUnreadMessageId,
        historyStale: false,
      };
    }

    const previousMessages = Array.isArray(previous?.messages) ? previous.messages : [];
    if (!previousMessages.length) {
      const refreshMovedPastLoadingHistory = Boolean(
        previous &&
        previous.lastMessageId !== fresh.lastMessageId &&
        (previous.historyStatus === 'loading' || previous.historyStale)
      );
      return refreshMovedPastLoadingHistory
        ? {
            ...fresh,
            historyLoaded: false,
            historyStatus: 'stale',
            historyStale: true,
            historyError: '',
          }
        : fresh;
    }

    // The list endpoint can observe a newly arrived message before the history
    // endpoint has returned it. Keep the already rendered thread visible, but
    // invalidate its loaded marker so the selected conversation is re-read.
    return {
      ...fresh,
      ...previous,
      unread: fresh.unread,
      unreadCount: fresh.unreadCount,
      readState: fresh.readState,
      markReadSupported: fresh.markReadSupported,
      markReadUnavailableReason: fresh.markReadUnavailableReason,
      rawStatus: fresh.rawStatus,
      chatStatus: fresh.chatStatus,
      lastMessageId: fresh.lastMessageId,
      lastMessageAt: fresh.lastMessageAt,
      lastMessageText: fresh.lastMessageText,
      lastMessage: fresh.lastMessage,
      time: fresh.time,
      updatedAt: fresh.updatedAt,
      firstUnreadMessageId: fresh.firstUnreadMessageId,
      historyLoaded: false,
      historyStatus: 'stale',
      historyStale: true,
      historyError: '',
      messages: previousMessages,
    };
  });
}

function isReadOnlyPushConversation(row = {}) {
  return row?.channel === 'push' && row?.category !== 'buyer';
}

function createViewedPushMarkerMap(payload = {}) {
  const markers = new Map();
  for (const row of Array.isArray(payload?.rows) ? payload.rows : []) {
    const chatId = normalizeText(row?.chatId ?? row?.chat_id);
    const lastMessageId = normalizeText(row?.lastMessageId ?? row?.last_message_id);
    const lastMessageAt = normalizeText(row?.lastMessageAt ?? row?.last_message_at);
    if (!chatId || (!lastMessageId && !lastMessageAt) || markers.has(chatId)) continue;
    markers.set(chatId, { lastMessageId, lastMessageAt });
  }
  return markers;
}

function applyViewedPushMarkers(rows, markers) {
  return rows.map((row) => {
    if (!isReadOnlyPushConversation(row)) return row;
    const chatId = normalizeText(row?.chatId ?? row?.conversationId);
    const marker = chatId ? markers.get(chatId) : null;
    if (!marker) return row;

    const lastMessageId = normalizeText(row?.lastMessageId);
    const lastMessageAt = normalizeText(row?.lastMessageAt);
    const matchesViewedMessage =
      marker.lastMessageId && lastMessageId
        ? marker.lastMessageId === lastMessageId
        : Boolean(marker.lastMessageAt && lastMessageAt && marker.lastMessageAt === lastMessageAt);
    if (!matchesViewedMessage) {
      markers.delete(chatId);
      return row;
    }

    return {
      ...row,
      viewedPushUnreadCount: Math.max(Number(row?.unreadCount ?? row?.unread) || 0, 0),
      unread: 0,
      unreadCount: 0,
      readState: 'read',
      firstUnreadMessageId: '',
    };
  });
}

function markPushConversationViewed(row, markers, markerSource = row) {
  if (!isReadOnlyPushConversation(row)) return row;
  const chatId = normalizeText(row?.chatId ?? row?.conversationId);
  if (!chatId) return row;
  const marker = {
    lastMessageId: normalizeText(markerSource?.lastMessageId ?? row?.lastMessageId),
    lastMessageAt: normalizeText(markerSource?.lastMessageAt ?? row?.lastMessageAt),
  };
  if (marker.lastMessageId || marker.lastMessageAt) markers.set(chatId, marker);
  return {
    ...row,
    viewedPushUnreadCount: Math.max(Number(row?.unreadCount ?? row?.unread) || 0, 0),
    unread: 0,
    unreadCount: 0,
    readState: 'read',
    firstUnreadMessageId: '',
  };
}

function applyVerifiedReadMarkers(rows, markers) {
  return rows.map((row) => {
    const chatId = normalizeText(row?.chatId ?? row?.conversationId);
    const marker = chatId ? markers.get(chatId) : null;
    if (!marker) return row;

    const lastMessageId = normalizeText(row?.lastMessageId);
    const lastMessageAt = normalizeText(row?.lastMessageAt);
    const matchesVerifiedMessage =
      marker.lastMessageId && lastMessageId
        ? marker.lastMessageId === lastMessageId
        : Boolean(marker.lastMessageAt && lastMessageAt && marker.lastMessageAt === lastMessageAt);
    if (!matchesVerifiedMessage) {
      markers.delete(chatId);
      return row;
    }

    return {
      ...row,
      verifiedReadUnreadCount: Math.max(Number(row?.unreadCount ?? row?.unread) || 0, 0),
      unread: 0,
      unreadCount: 0,
      readState: 'read',
      firstUnreadMessageId: '',
    };
  });
}

export function useCustomerOzonConversations(
  activeShopId = '',
  { enabled = true, accountScopeKey = '', shopName = '' } = {}
) {
  const [state, setState] = React.useState(createInitialState);
  const [historyLoadingIds, setHistoryLoadingIds] = React.useState([]);
  const rowsRef = React.useRef([]);
  const paginationRef = React.useRef({
    hasNext: false,
    nextOffset: 0,
    nextCursor: '',
    seenCursors: new Set(),
    pagesLoaded: 0,
  });
  const loadedHistoryIdsRef = React.useRef(new Set());
  const viewedPushMarkersRef = React.useRef(new Map());
  const verifiedReadMarkersRef = React.useRef(new Map());
  const historyRequestsRef = React.useRef(new Map());
  const listControllerRef = React.useRef(null);
  const listRequestIdRef = React.useRef(0);
  const listBusyRef = React.useRef(false);
  const backgroundControllerRef = React.useRef(null);
  const scopeKey = `${normalizeText(activeShopId)}|${normalizeText(accountScopeKey)}`;
  const activeScopeRef = React.useRef(scopeKey);

  const replaceRows = React.useCallback((nextRowsOrUpdater) => {
    const nextRows = typeof nextRowsOrUpdater === 'function' ? nextRowsOrUpdater(rowsRef.current) : nextRowsOrUpdater;
    rowsRef.current = Array.isArray(nextRows) ? nextRows : [];
    setState((current) => ({ ...current, rows: rowsRef.current }));
  }, []);

  const applyReadback = React.useCallback(
    (targets = []) => {
      const verifiedChatIds = new Set(
        (Array.isArray(targets) ? targets : [])
          .filter((target) => target?.verified)
          .map((target) => normalizeText(target?.chatId ?? target?.chat_id))
          .filter(Boolean)
      );
      if (!verifiedChatIds.size) return;
      replaceRows((current) =>
        current.map((row) => {
          const rowChatId = normalizeText(row?.chatId ?? row?.conversationId);
          if (!verifiedChatIds.has(rowChatId)) return row;
          const marker = {
            lastMessageId: normalizeText(row?.lastMessageId),
            lastMessageAt: normalizeText(row?.lastMessageAt),
          };
          if (marker.lastMessageId || marker.lastMessageAt) {
            verifiedReadMarkersRef.current.set(rowChatId, marker);
          }
          return {
            ...row,
            unread: 0,
            unreadCount: 0,
            readState: 'read',
            firstUnreadMessageId: '',
          };
        })
      );
    },
    [replaceRows]
  );

  const abortHistoryRequests = React.useCallback(() => {
    for (const entry of historyRequestsRef.current.values()) entry.controller?.abort();
    historyRequestsRef.current = new Map();
    setHistoryLoadingIds([]);
  }, []);

  const ensureHistory = React.useCallback(
    async (
      conversationId,
      {
        forceRefresh = false,
        reloadCached = false,
        older = false,
        signal,
        priority = 'P1',
        requestedBy,
        backgroundIndex = false,
      } = {}
    ) => {
      const normalizedId = normalizeText(conversationId);
      const conversation = rowsRef.current.find((row) => row.id === normalizedId || row.chatId === normalizedId);
      if (!enabled || !activeShopId || !conversation?.chatId) return null;
      if (older && !conversation.historyHasNext) return conversation;
      const olderCursor = older
        ? normalizeText(
            conversation.historyCursor || conversation.messages?.[0]?.messageId || conversation.messages?.[0]?.id
          )
        : '';
      if (older && !olderCursor) return conversation;
      const requestKey = older ? `${conversation.id}:older:${olderCursor}` : conversation.id;
      const hasCurrentLoadedHistory = Boolean(
        loadedHistoryIdsRef.current.has(requestKey) &&
        conversation.historyLoaded &&
        conversation.historyStatus === 'success' &&
        !conversation.historyStale
      );
      if (!forceRefresh && !reloadCached && hasCurrentLoadedHistory) return conversation;
      if (!hasCurrentLoadedHistory) loadedHistoryIdsRef.current.delete(requestKey);
      if (historyRequestsRef.current.has(requestKey)) {
        return historyRequestsRef.current.get(requestKey).promise;
      }

      const requestScope = activeScopeRef.current;
      const controller = createLinkedController(signal);
      if (!backgroundIndex) {
        setHistoryLoadingIds((current) =>
          current.includes(conversation.id) ? current : [...current, conversation.id]
        );
      }
      replaceRows((current) =>
        current.map((row) =>
          row.id === conversation.id
            ? backgroundIndex
              ? { ...row, historyIndexStatus: 'syncing', historyIndexError: '' }
              : { ...row, historyStatus: 'loading', historyError: '' }
            : row
        )
      );

      const promise = readCustomerChatHistory(
        {
          shopId: activeShopId,
          accountId: accountScopeKey || activeShopId,
          chatId: conversation.chatId,
          limit: customerConsultationPagination.historyPageSize,
          fromMessageId: olderCursor,
          forceRefresh: forceRefresh || older,
          priority,
          requestedBy,
        },
        { signal: controller.signal }
      )
        .then(async (payload) => {
          if (controller.signal.aborted || requestScope !== activeScopeRef.current) return null;
          if (payload?.ok === false) {
            throw Object.assign(new Error(payload?.error?.message || '聊天记录读取失败'), {
              code: payload?.error?.code,
            });
          }
          let enriched = null;
          replaceRows((current) =>
            mergeCustomerConversations(
              current.map((row) => {
                if (row.id !== conversation.id) return row;
                const merged = mergeCustomerChatHistory(row, payload, { appendOlder: older });
                const expectedLatestId = normalizeText(row.lastMessageId);
                const loadedLatestId = normalizeText(
                  merged.messages?.at?.(-1)?.messageId || merged.messages?.at?.(-1)?.id
                );
                const historyStale = Boolean(
                  row.historyStale && expectedLatestId && expectedLatestId !== loadedLatestId
                );
                const resolved = historyStale
                  ? {
                      ...merged,
                      lastMessageId: expectedLatestId,
                      lastMessageAt: row.lastMessageAt,
                      lastMessageText: row.lastMessageText,
                      lastMessage: row.lastMessage,
                      time: row.time,
                      updatedAt: row.updatedAt,
                      historyLoaded: false,
                      historyStatus: 'stale',
                      historyStale: true,
                      historyError: '',
                      historyLoadedThroughMessageId: loadedLatestId,
                    }
                  : {
                      ...merged,
                      historyLoaded: true,
                      historyStatus: 'success',
                      historyStale: false,
                      historyLoadedThroughMessageId: loadedLatestId || expectedLatestId,
                    };
                const indexed = backgroundIndex
                  ? {
                      ...resolved,
                      historyIndexStatus: resolved.historyHasNext ? 'syncing' : 'complete',
                      historyIndexComplete: !resolved.historyHasNext,
                      historyIndexError: '',
                      historyIndexedCount: Array.isArray(resolved.messages) ? resolved.messages.length : 0,
                    }
                  : resolved;
                enriched = markPushConversationViewed(indexed, viewedPushMarkersRef.current, row);
                return enriched;
              })
            )
          );
          if (enriched?.historyStale) loadedHistoryIdsRef.current.delete(requestKey);
          else loadedHistoryIdsRef.current.add(requestKey);
          const markerChatId = normalizeText(enriched?.chatId ?? enriched?.conversationId);
          const marker = markerChatId ? viewedPushMarkersRef.current.get(markerChatId) : null;
          if (marker) {
            // The visible row is updated immediately, but the history request does not
            // finish until SQLite has accepted the marker. This closes the quit/reopen gap.
            try {
              const saved = await saveCustomerPushViewMarker({
                shopId: activeShopId,
                accountId: accountScopeKey || activeShopId,
                chatId: markerChatId,
                lastMessageId: marker.lastMessageId,
                lastMessageAt: marker.lastMessageAt,
              });
              if (saved?.ok === false) {
                await saveCustomerPushViewMarker({
                  shopId: activeShopId,
                  accountId: accountScopeKey || activeShopId,
                  chatId: markerChatId,
                  lastMessageId: marker.lastMessageId,
                  lastMessageAt: marker.lastMessageAt,
                });
              }
            } catch {
              // A second immediate attempt covers a transient local-api/SQLite busy edge.
              try {
                await saveCustomerPushViewMarker({
                  shopId: activeShopId,
                  accountId: accountScopeKey || activeShopId,
                  chatId: markerChatId,
                  lastMessageId: marker.lastMessageId,
                  lastMessageAt: marker.lastMessageAt,
                });
              } catch {
                // Keep the in-memory read state for this session. A future view retries persistence.
              }
            }
          }
          return enriched;
        })
        .catch((error) => {
          if (requestScope !== activeScopeRef.current) return null;
          if (controller.signal.aborted || error?.name === 'AbortError') {
            loadedHistoryIdsRef.current.delete(requestKey);
            replaceRows((current) =>
              current.map((row) => {
                if (row.id !== conversation.id) return row;
                if (backgroundIndex) {
                  return {
                    ...row,
                    historyIndexStatus: row.historyIndexComplete ? 'complete' : 'idle',
                  };
                }
                return {
                  ...row,
                  historyStatus: row.historyStale ? 'stale' : row.historyLoaded ? 'success' : 'idle',
                };
              })
            );
            return null;
          }
          const message = translateCustomerError(error, 'Ozon 聊天记录读取失败，请稍后重试。');
          replaceRows((current) =>
            current.map((row) =>
              row.id === conversation.id
                ? backgroundIndex
                  ? {
                      ...row,
                      historyIndexStatus: 'error',
                      historyIndexComplete: false,
                      historyIndexError: message,
                    }
                  : { ...row, historyStatus: 'error', historyError: message }
                : row
            )
          );
          return null;
        })
        .finally(() => {
          const activeRequest = historyRequestsRef.current.get(requestKey);
          if (activeRequest?.controller !== controller) return;
          historyRequestsRef.current.delete(requestKey);
          if (!backgroundIndex) {
            setHistoryLoadingIds((current) => current.filter((id) => id !== conversation.id));
          }
        });

      historyRequestsRef.current.set(requestKey, { promise, controller, scope: requestScope });
      return promise;
    },
    [accountScopeKey, activeShopId, enabled, replaceRows]
  );

  const loadOlderHistory = React.useCallback(
    (conversationId, options = {}) =>
      ensureHistory(conversationId, {
        ...options,
        older: true,
        forceRefresh: true,
      }),
    [ensureHistory]
  );

  const runListRequest = React.useCallback(
    async ({ append = false, forceRefresh = false, background = false, signal } = {}) => {
      if (!enabled) return rowsRef.current;
      if (!activeShopId) {
        listControllerRef.current?.abort();
        rowsRef.current = [];
        paginationRef.current = {
          hasNext: false,
          nextOffset: 0,
          nextCursor: '',
          seenCursors: new Set(),
          pagesLoaded: 0,
        };
        setState({
          ...createInitialState(),
          status: 'empty',
          emptyReason: '请先选择 Ozon 店铺',
        });
        return [];
      }
      if (append && (!paginationRef.current.hasNext || listBusyRef.current)) {
        return rowsRef.current;
      }

      const requestId = listRequestIdRef.current + 1;
      listRequestIdRef.current = requestId;
      const requestScope = activeScopeRef.current;
      const offset = append ? paginationRef.current.nextOffset : 0;
      const cursor = append ? paginationRef.current.nextCursor : '';
      listControllerRef.current?.abort();
      const controller = createLinkedController(signal);
      listControllerRef.current = controller;
      listBusyRef.current = true;
      setState((current) => ({
        ...current,
        status: append ? current.status : current.rows.length ? 'refreshing' : 'loading',
        loadingMore: append && !background,
        backgroundSyncing: append && background,
        backgroundError: append && background ? '' : current.backgroundError,
        error: '',
        emptyReason: '',
      }));

      try {
        const pageSize = append
          ? customerConsultationPagination.backgroundPageSize
          : customerConsultationPagination.pageSize;
        const payload = await readCustomerChatList(
          {
            shopId: activeShopId,
            accountId: accountScopeKey || activeShopId,
            limit: pageSize,
            cursor,
            forceRefresh,
          },
          { signal: controller.signal }
        );
        if (
          controller.signal.aborted ||
          requestId !== listRequestIdRef.current ||
          requestScope !== activeScopeRef.current
        ) {
          return rowsRef.current;
        }
        if (payload?.ok === false) {
          throw Object.assign(new Error(payload?.error?.message || '会话列表读取失败'), {
            code: payload?.error?.code,
          });
        }

        const normalized = applyVerifiedReadMarkers(
          applyViewedPushMarkers(
            normalizeCustomerChatList(payload, {
              shopId: activeShopId,
              accountScopeKey: accountScopeKey || activeShopId,
              shopName,
            }),
            viewedPushMarkersRef.current
          ),
          verifiedReadMarkersRef.current
        );
        const meta = getCustomerChatListMeta(payload, {
          offset,
          limit: pageSize,
        });
        let nextRows;
        if (append) {
          nextRows = mergeCustomerConversations([...rowsRef.current, ...normalized]);
        } else {
          nextRows = mergeCustomerConversations(retainLoadedHistory(normalized, rowsRef.current));
          const nextIds = new Set(nextRows.map((row) => row.id));
          const invalidHistoryIds = new Set(
            nextRows.filter((row) => row.historyStale || !row.historyLoaded).map((row) => row.id)
          );
          for (const id of loadedHistoryIdsRef.current) {
            if (!nextIds.has(id) || invalidHistoryIds.has(id)) loadedHistoryIdsRef.current.delete(id);
          }
        }

        const previousPagination = paginationRef.current;
        const nextCursor = meta.cursor;
        const repeatedCursor = Boolean(
          append && nextCursor && (nextCursor === cursor || previousPagination.seenCursors.has(nextCursor))
        );
        const addedRowCount = Math.max(nextRows.length - rowsRef.current.length, 0);
        const repeatedPage = append && normalized.length > 0 && addedRowCount === 0;
        const seenCursors = append ? new Set(previousPagination.seenCursors) : new Set();
        if (nextCursor) seenCursors.add(nextCursor);
        const pagesLoaded = append ? previousPagination.pagesLoaded + 1 : 1;
        const reachedPageLimit = pagesLoaded >= customerConsultationPagination.maxBackgroundPages;
        const canContinue = Boolean(
          meta.hasNext && nextCursor && !repeatedCursor && !repeatedPage && !reachedPageLimit
        );

        rowsRef.current = nextRows;
        paginationRef.current = {
          hasNext: canContinue,
          nextOffset: meta.nextOffset,
          nextCursor,
          seenCursors,
          pagesLoaded,
        };
        setState((current) => ({
          ...current,
          status: nextRows.length ? 'success' : 'empty',
          rows: nextRows,
          error: '',
          emptyReason: nextRows.length ? '' : '当前店铺暂无客服会话',
          refreshedAt: new Date().toISOString(),
          hasNext: canContinue,
          nextOffset: meta.nextOffset,
          nextCursor,
          loadingMore: false,
          backgroundSyncing: background ? canContinue : current.backgroundSyncing,
          backgroundError: '',
          totalCount: Math.max(Number(current.totalCount) || 0, Number(meta.totalCount) || 0, nextRows.length),
          totalUnreadCount: Math.max(
            Math.max(
              0,
              (Number(meta.totalUnreadCount) || 0) -
                nextRows.reduce(
                  (total, row) =>
                    total + (Number(row.viewedPushUnreadCount) || 0) + (Number(row.verifiedReadUnreadCount) || 0),
                  0
                )
            ),
            nextRows.reduce((total, row) => total + (Number(row.unreadCount ?? row.unread) || 0), 0)
          ),
        }));
        return nextRows;
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') return rowsRef.current;
        if (requestId !== listRequestIdRef.current || requestScope !== activeScopeRef.current) {
          return rowsRef.current;
        }
        const message = translateCustomerError(error, 'Ozon 会话列表读取失败，请稍后重试。');
        setState((current) => ({
          ...current,
          status: background && current.rows.length ? current.status : current.rows.length ? 'stale' : 'error',
          error: background ? current.error : message,
          backgroundError: background ? message : current.backgroundError,
          emptyReason: current.rows.length ? '' : '客服会话读取失败',
          loadingMore: false,
          backgroundSyncing: false,
        }));
        return rowsRef.current;
      } finally {
        if (requestId === listRequestIdRef.current) {
          listBusyRef.current = false;
          if (listControllerRef.current === controller) listControllerRef.current = null;
        }
      }
    },
    [accountScopeKey, activeShopId, enabled, shopName]
  );

  const refreshList = React.useCallback(
    (options = {}) => runListRequest({ ...options, append: false }),
    [runListRequest]
  );
  const loadMore = React.useCallback(
    (options = {}) => runListRequest({ ...options, append: true, forceRefresh: false }),
    [runListRequest]
  );
  const loadAll = React.useCallback(
    async ({ signal, background = false } = {}) => {
      let rows = rowsRef.current;
      let requestedPages = 0;
      while (
        paginationRef.current.hasNext &&
        !signal?.aborted &&
        requestedPages < customerConsultationPagination.maxBackgroundPages
      ) {
        const previousCursor = paginationRef.current.nextCursor;
        const previousRowCount = rowsRef.current.length;
        rows = await runListRequest({ append: true, forceRefresh: false, background, signal });
        requestedPages += 1;
        if (paginationRef.current.nextCursor === previousCursor || rowsRef.current.length <= previousRowCount) {
          paginationRef.current.hasNext = false;
          setState((current) => ({ ...current, hasNext: false, backgroundSyncing: false }));
          break;
        }
      }
      if (background && !signal?.aborted) {
        setState((current) => ({ ...current, backgroundSyncing: false }));
      }
      return rows;
    },
    [runListRequest]
  );
  const startBackgroundSync = React.useCallback(
    ({ signal: parentSignal } = {}) => {
      backgroundControllerRef.current?.abort();
      const controller = createLinkedController(parentSignal);
      backgroundControllerRef.current = controller;
      void (async () => {
        const shouldStart = await waitForBackgroundStart(controller.signal);
        if (!shouldStart || !paginationRef.current.hasNext) return;
        await loadAll({ signal: controller.signal, background: true });
      })().finally(() => {
        if (backgroundControllerRef.current === controller) backgroundControllerRef.current = null;
      });
    },
    [loadAll]
  );
  const refreshVisibleList = React.useCallback(
    async (options = {}) => {
      backgroundControllerRef.current?.abort();
      const rows = await refreshList(options);
      if (!options.signal?.aborted && paginationRef.current.hasNext) startBackgroundSync(options);
      return rows;
    },
    [refreshList, startBackgroundSync]
  );
  const refreshConversation = React.useCallback(
    (conversationId) => ensureHistory(conversationId, { forceRefresh: true }),
    [ensureHistory]
  );
  const refreshConversationFromCache = React.useCallback(
    (conversationId) =>
      ensureHistory(conversationId, {
        forceRefresh: false,
        reloadCached: true,
        requestedBy: 'customer-consultation-push-cache',
      }),
    [ensureHistory]
  );
  const preloadHistories = React.useCallback(
    async (
      conversationIds = [],
      {
        signal,
        concurrency = customerConsultationPagination.visibleHistoryPrefetchConcurrency,
        priority = 'P1',
        requestedBy,
      } = {}
    ) => {
      const pending = [...new Set(conversationIds.map(normalizeText).filter(Boolean))];
      const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, pending.length || 1));
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (pending.length && !signal?.aborted) {
            const conversationId = pending.shift();
            await ensureHistory(conversationId, { forceRefresh: false, signal, priority, requestedBy });
          }
        })
      );
    },
    [ensureHistory]
  );
  const preloadFullHistories = React.useCallback(
    async (
      conversationIds = [],
      {
        signal,
        concurrency = customerConsultationPagination.backgroundFullHistoryConcurrency,
        priority = 'P3',
        requestedBy = 'customer-consultation-full-history-index',
      } = {}
    ) => {
      const pending = [...new Set(conversationIds.map(normalizeText).filter(Boolean))];
      const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, pending.length || 1));
      const results = [];

      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (pending.length && !signal?.aborted) {
            const conversationId = pending.shift();
            const seenCursors = new Set();
            let conversation = await ensureHistory(conversationId, {
              forceRefresh: false,
              signal,
              priority,
              requestedBy,
              backgroundIndex: true,
            });
            let complete = Boolean(conversation && !conversation.historyHasNext);
            let stalledReason = '';

            while (conversation?.historyHasNext && !signal?.aborted) {
              const cursor = normalizeText(
                conversation.historyCursor || conversation.messages?.[0]?.messageId || conversation.messages?.[0]?.id
              );
              if (!cursor || seenCursors.has(cursor)) {
                stalledReason = cursor ? 'Ozon 返回了重复的历史分页位置。' : 'Ozon 未返回更早消息的分页位置。';
                break;
              }
              seenCursors.add(cursor);
              const previousCount = Array.isArray(conversation.messages) ? conversation.messages.length : 0;
              const olderPage = await ensureHistory(conversationId, {
                older: true,
                forceRefresh: true,
                signal,
                priority,
                requestedBy,
                backgroundIndex: true,
              });
              if (!olderPage) {
                stalledReason = '更早消息读取中断，将在下次进入客服页面时继续。';
                break;
              }
              const nextCursor = normalizeText(
                olderPage.historyCursor || olderPage.messages?.[0]?.messageId || olderPage.messages?.[0]?.id
              );
              const nextCount = Array.isArray(olderPage.messages) ? olderPage.messages.length : 0;
              conversation = olderPage;
              if (!conversation.historyHasNext) {
                complete = true;
                break;
              }
              if (nextCursor === cursor && nextCount <= previousCount) {
                stalledReason = 'Ozon 没有返回新的更早消息，已停止重复读取。';
                break;
              }
            }

            if (conversation && !signal?.aborted) {
              const indexedCount = Array.isArray(conversation.messages) ? conversation.messages.length : 0;
              replaceRows((current) =>
                current.map((row) =>
                  row.id === conversationId || row.chatId === conversationId
                    ? {
                        ...row,
                        historyIndexStatus: complete ? 'complete' : stalledReason ? 'stalled' : row.historyIndexStatus,
                        historyIndexComplete: complete,
                        historyIndexError: complete ? '' : stalledReason || row.historyIndexError || '',
                        historyIndexedCount: indexedCount,
                      }
                    : row
                )
              );
              results.push({ conversationId, complete, indexedCount, error: stalledReason });
            } else if (!signal?.aborted) {
              results.push({
                conversationId,
                complete: false,
                indexedCount: 0,
                error: '历史消息读取中断，将自动重试。',
              });
            }
          }
        })
      );
      return results;
    },
    [ensureHistory, replaceRows]
  );

  React.useEffect(() => {
    activeScopeRef.current = scopeKey;
    listRequestIdRef.current += 1;
    listControllerRef.current?.abort();
    abortHistoryRequests();
    rowsRef.current = [];
    loadedHistoryIdsRef.current = new Set();
    viewedPushMarkersRef.current = new Map();
    verifiedReadMarkersRef.current = new Map();
    paginationRef.current = {
      hasNext: false,
      nextOffset: 0,
      nextCursor: '',
      seenCursors: new Set(),
      pagesLoaded: 0,
    };
    listBusyRef.current = false;
    setState(createInitialState());
    if (!enabled) return undefined;

    const scopeController = new AbortController();
    if (activeShopId) {
      setState((current) => ({ ...current, status: 'loading', error: '', emptyReason: '' }));
    }
    void (async () => {
      if (activeShopId) {
        try {
          const payload = await readCustomerPushViewMarkers(
            { shopId: activeShopId, accountId: accountScopeKey || activeShopId },
            { signal: scopeController.signal }
          );
          if (scopeController.signal.aborted || scopeKey !== activeScopeRef.current) return;
          if (payload?.ok !== false) viewedPushMarkersRef.current = createViewedPushMarkerMap(payload);
        } catch (error) {
          if (scopeController.signal.aborted || error?.name === 'AbortError') return;
          // Marker cache failure must not block the canonical Ozon conversation list.
        }
      }
      await refreshVisibleList({ forceRefresh: false, signal: scopeController.signal });
    })();
    return () => {
      listRequestIdRef.current += 1;
      scopeController.abort();
      backgroundControllerRef.current?.abort();
      backgroundControllerRef.current = null;
      listControllerRef.current?.abort();
      listControllerRef.current = null;
      listBusyRef.current = false;
      abortHistoryRequests();
    };
  }, [abortHistoryRequests, accountScopeKey, activeShopId, enabled, refreshVisibleList, scopeKey]);

  return {
    ...state,
    historyLoadingIds,
    refreshList: refreshVisibleList,
    loadMore,
    loadAll,
    ensureHistory,
    loadOlderHistory,
    refreshConversation,
    refreshConversationFromCache,
    preloadHistories,
    preloadFullHistories,
    applyReadback,
  };
}

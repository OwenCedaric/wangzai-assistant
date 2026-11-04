import React from 'react';
import { waitForCustomerServiceRealtimeEvent } from '../services/customerConsultationClient.js';

const RETRY_DELAYS_MS = [1000, 2000, 5000];

function normalizeText(value) {
  return String(value ?? '').trim();
}

export async function applyCustomerConsultationRealtimeEvent(
  event,
  { refreshList, refreshConversationFromCache, refreshNotifications } = {}
) {
  const refreshedRows = (await refreshList?.({ forceRefresh: false })) || [];
  const chatIds = [...new Set((Array.isArray(event?.chatIds) ? event.chatIds : []).map(normalizeText).filter(Boolean))];
  const visibleChatIds = new Set(
    refreshedRows.flatMap((row) => [normalizeText(row?.id), normalizeText(row?.chatId)]).filter(Boolean)
  );
  await Promise.all(
    chatIds
      .filter((chatId) => visibleChatIds.has(chatId))
      .map((chatId) => refreshConversationFromCache?.(chatId))
  );
  await refreshNotifications?.({ silent: true });
  return refreshedRows;
}

function waitForRetry(timeoutMs, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      resolve(false);
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Waits on the authenticated local-api cache signal. The signal never carries
 * canonical chat content; callers reload the already refreshed local cache.
 */
export function useCustomerConsultationRealtime({ shopId = '', enabled = true, onEvent } = {}) {
  const eventHandlerRef = React.useRef(onEvent);
  eventHandlerRef.current = onEvent;

  React.useEffect(() => {
    const activeShopId = normalizeText(shopId);
    if (!enabled || !activeShopId) return undefined;

    const controller = new AbortController();
    let afterSequence = null;
    let failureCount = 0;

    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const payload = await waitForCustomerServiceRealtimeEvent(
            { shopId: activeShopId, afterSequence, timeoutMs: 25000 },
            { signal: controller.signal }
          );
          if (controller.signal.aborted) return;
          if (payload?.ok === false) throw new Error(payload?.error?.message || '客服消息等待失败');

          const event = payload?.event && typeof payload.event === 'object' ? payload.event : null;
          const nextSequence = Number(event?.sequence ?? payload?.sequence);
          if (!Number.isSafeInteger(nextSequence) || nextSequence < 0) throw new Error('客服消息游标无效');
          if (afterSequence === null || nextSequence > afterSequence) {
            afterSequence = nextSequence;
          }
          failureCount = 0;
          if (event && normalizeText(event.shopId) === activeShopId) {
            await eventHandlerRef.current?.(event);
          }
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError') return;
          const delay = RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)];
          failureCount += 1;
          if (!(await waitForRetry(delay, controller.signal))) return;
        }
      }
    })();

    return () => controller.abort();
  }, [enabled, shopId]);
}

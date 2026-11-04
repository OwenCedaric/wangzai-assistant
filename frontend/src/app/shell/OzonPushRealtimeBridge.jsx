import { waitForOzonPushRealtimeEvent } from '../../api/localApiClient.js';
import { OZON_PUSH_REALTIME_BROWSER_EVENT } from '../../services/ozonPushRealtime.js';
import React from 'react';

export { OZON_PUSH_REALTIME_BROWSER_EVENT } from '../../services/ozonPushRealtime.js';
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000];

function normalizeText(value) {
  return String(value ?? '').trim();
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

function OzonPushShopRealtimeWatcher({ shopId, onEvent }) {
  const eventHandlerRef = React.useRef(onEvent);
  eventHandlerRef.current = onEvent;

  React.useEffect(() => {
    if (!shopId) return undefined;
    const controller = new AbortController();
    let afterSequence = null;
    let failureCount = 0;
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const payload = await waitForOzonPushRealtimeEvent(
            { shopId, afterSequence, timeoutMs: 25_000 },
            { signal: controller.signal }
          );
          if (controller.signal.aborted) return;
          if (payload?.ok === false) throw new Error(payload?.error?.message || 'Ozon 推送实时等待失败');
          const nextSequence = Number(payload?.event?.sequence ?? payload?.sequence);
          if (Number.isSafeInteger(nextSequence) && nextSequence >= 0) afterSequence = nextSequence;
          failureCount = 0;
          const event = payload?.event && typeof payload.event === 'object' ? payload.event : null;
          if (!event || normalizeText(event.shopId) !== shopId) continue;
          globalThis.window?.dispatchEvent?.(new CustomEvent(OZON_PUSH_REALTIME_BROWSER_EVENT, {
            detail: event,
          }));
          await eventHandlerRef.current?.(event);
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError') return;
          const delay = RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)];
          failureCount += 1;
          if (!(await waitForRetry(delay, controller.signal))) return;
        }
      }
    })();
    return () => controller.abort();
  }, [shopId]);

  return null;
}

export function OzonPushRealtimeBridge({ shops = [], onEvent }) {
  const shopIds = [...new Set((Array.isArray(shops) ? shops : [])
    .map((shop) => normalizeText(shop?.id))
    .filter(Boolean))];
  return shopIds.map((shopId) => (
    <OzonPushShopRealtimeWatcher key={shopId} shopId={shopId} onEvent={onEvent} />
  ));
}

export default OzonPushRealtimeBridge;


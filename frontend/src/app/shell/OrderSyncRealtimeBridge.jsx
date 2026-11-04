import { getSyncState } from '../../api/localApiClient.js';
import { OZON_PUSH_REALTIME_BROWSER_EVENT } from '../../services/ozonPushRealtime.js';
import React from 'react';

const WATCHED_DOMAINS = new Set(['orders', 'returns']);
const CANONICAL_SYNC_SCOPES = new Set([
  'orders:orders.fbsList',
  'orders:orders.fbsUnfulfilledList',
  'orders:orders.fboList',
  'returns:returns.list',
  'returns:returns.rfbsList',
  'returns:returns.conditionalCancellationList',
]);

function text(value) {
  return String(value ?? '').trim();
}

function dispatchRefreshEvent(event, onEvent) {
  globalThis.window?.dispatchEvent?.(new CustomEvent(OZON_PUSH_REALTIME_BROWSER_EVENT, { detail: event }));
  return onEvent?.(event);
}

export function isCanonicalOrderSyncState(state = {}, domain = '') {
  const normalizedDomain = text(state.domain || domain);
  const scopeKey = text(state.scopeKey || state.scope_key);
  return WATCHED_DOMAINS.has(normalizedDomain) && CANONICAL_SYNC_SCOPES.has(scopeKey);
}

export function shouldPublishOrderSyncState(previous = null, current = {}) {
  if (!previous) return false;
  const previousStatus = text(previous.status);
  const currentStatus = text(current.status);
  const previousChanged = Number(previous.changedCount) || 0;
  const currentChanged = Number(current.changedCount) || 0;
  if (currentChanged > previousChanged) return true;
  return previousStatus === 'running' && currentStatus === 'partial' && currentChanged > 0;
}

/**
 * Observes durable local-api hot-cache jobs. It carries no business rows; it
 * only wakes mounted order consumers after SQLite progress changes.
 */
export function OrderSyncRealtimeBridge({ shops = [], onEvent }) {
  const shopKey = shops.map((shop) => text(shop?.id)).filter(Boolean).sort().join('|');
  const eventHandlerRef = React.useRef(onEvent);
  const observedStatesRef = React.useRef(new Map());
  eventHandlerRef.current = onEvent;

  React.useEffect(() => {
    const shopIds = new Set(shopKey.split('|').filter(Boolean));
    if (!shopIds.size) return undefined;
    const controller = new AbortController();
    let running = false;
    const inspect = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        const scopes = [...shopIds].flatMap((shopId) =>
          [...WATCHED_DOMAINS].map((domain) => ({ shopId, domain }))
        );
        const payloads = await Promise.all(scopes.map((scope) =>
          getSyncState(scope.domain, { shopId: scope.shopId, limit: 20 }, {
            timeoutMs: 2_500,
            signal: controller.signal,
            observe: false,
          }).catch(() => null)
        ));
        payloads.forEach((payload, index) => {
          const scope = scopes[index];
          (Array.isArray(payload?.states) ? payload.states : [])
            .filter((state) => isCanonicalOrderSyncState(state, scope.domain))
            .forEach((state) => {
            const stateId = text(state.id || `${scope.domain}:${scope.shopId}:${state.scopeKey}`);
            const domain = text(state.domain || scope.domain);
            const shopId = text(state.shopId || scope.shopId);
            const syncStatus = text(state.status);
            const previous = observedStatesRef.current.get(stateId) || null;
            observedStatesRef.current.set(stateId, {
              status: syncStatus,
              changedCount: Number(state.changedCount) || 0,
            });
            if (!shouldPublishOrderSyncState(previous, state)) return;
            void dispatchRefreshEvent({
              sequence: Date.now(),
              shopId,
              stage: 'refreshed',
              domain,
              source: 'continuous-sync-observer',
              requestedBy: 'continuous-sync',
              jobId: stateId,
              status: syncStatus,
              changedCount: Number(state.changedCount) || 0,
              unchangedCount: Number(state.unchangedCount) || 0,
              failedCount: syncStatus === 'failed' ? 1 : 0,
              postingNumbers: [],
              productRefs: [],
              occurredAt: new Date().toISOString(),
            }, eventHandlerRef.current);
          });
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
      } finally {
        running = false;
      }
    };
    void inspect();
    const timer = globalThis.setInterval(inspect, 1_000);
    return () => {
      controller.abort();
      globalThis.clearInterval(timer);
    };
  }, [shopKey]);

  return null;
}

export default OrderSyncRealtimeBridge;


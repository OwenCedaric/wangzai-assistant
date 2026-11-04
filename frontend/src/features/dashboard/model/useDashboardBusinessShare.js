import { getOzonReadableShops } from '../../../entities/order/orderShopScope.jsx';
import { readDashboardBusinessShareSnapshot } from '../services/dashboardBusinessShareService.js';
import React from 'react';
import { isSettingsInteractionPaused } from '../../../shared/lib/settingsInteractionRuntime.js';

const EMPTY_COUNTS = Object.freeze({
  salesOrderCount: 0,
  pendingPurchaseCount: 0,
  afterSalesTodoCount: 0,
  stockWarningCount: 0,
});

function createState(status, scopeKey, extra = {}) {
  return {
    status,
    scopeKey,
    counts: status === 'error' || status === 'loading' ? null : { ...EMPTY_COUNTS },
    error: null,
    ...extra,
  };
}

function createScope(readableShops = []) {
  const shopIds = [...new Set(readableShops.map((shop) => String(shop.id || '').trim()).filter(Boolean))].sort();
  return { shops: readableShops, key: shopIds.join('|') };
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

/** Keeps one aggregate request scoped to the latest readable shops. */
export function useDashboardBusinessShare({ shops = [], refreshToken = 0, enabled = true } = {}) {
  const nextScope = createScope(getOzonReadableShops(shops));
  const scopeRef = React.useRef(nextScope);
  if (scopeRef.current.key !== nextScope.key) scopeRef.current = nextScope;
  const scope = scopeRef.current;
  const requestIdRef = React.useRef(0);
  const settingsOverlayOpenRef = React.useRef(isSettingsInteractionPaused());
  const pendingStateRef = React.useRef(null);
  const resumeTimerRef = React.useRef(null);
  const [state, setState] = React.useState(() => createState(scope.key ? 'loading' : 'empty', scope.key));

  const commitState = React.useCallback((nextState) => {
    if (settingsOverlayOpenRef.current) {
      pendingStateRef.current = nextState;
      return;
    }
    setState(nextState);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const clearResumeTimer = () => {
      if (resumeTimerRef.current !== null) {
        globalThis.clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
    };
    const handleSettingsOpen = () => {
      clearResumeTimer();
      settingsOverlayOpenRef.current = true;
    };
    const handleSettingsClosed = () => {
      clearResumeTimer();
      resumeTimerRef.current = globalThis.setTimeout(() => {
        resumeTimerRef.current = null;
        settingsOverlayOpenRef.current = false;
        if (!pendingStateRef.current) return;
        const pendingState = pendingStateRef.current;
        pendingStateRef.current = null;
        React.startTransition(() => setState(pendingState));
      }, 500);
    };
    window.addEventListener('wangzai-settings-open', handleSettingsOpen);
    window.addEventListener('wangzai-settings-closed', handleSettingsClosed);
    return () => {
      clearResumeTimer();
      window.removeEventListener('wangzai-settings-open', handleSettingsOpen);
      window.removeEventListener('wangzai-settings-closed', handleSettingsClosed);
    };
  }, []);

  React.useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();

    if (!enabled) return () => controller.abort();
    if (!scope.shops.length) {
      commitState(createState('empty', scope.key));
      return () => controller.abort();
    }

    commitState(createState('loading', scope.key));
    readDashboardBusinessShareSnapshot(scope.shops, { signal: controller.signal })
      .then((counts) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        const total = Object.values(counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
        commitState({
          ...createState(total > 0 ? 'data' : 'empty', scope.key),
          counts: { ...EMPTY_COUNTS, ...(counts || {}) },
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || isAbortError(error) || requestIdRef.current !== requestId) return;
        commitState(createState('error', scope.key, { error }));
      });

    return () => controller.abort();
  }, [commitState, enabled, refreshToken, scope]);

  return state.scopeKey === scope.key ? state : createState(scope.key ? 'loading' : 'empty', scope.key);
}

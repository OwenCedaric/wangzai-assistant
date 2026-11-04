import { readCustomerServiceNotifications } from '../services/customerConsultationClient.js';
import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import React from 'react';

export function useCustomerConsultationNotifications(activeShopId = '', { enabled = true } = {}) {
  const [state, setState] = React.useState({
    status: 'idle',
    rows: [],
    error: '',
  });
  const requestIdRef = React.useRef(0);
  const controllerRef = React.useRef(null);

  const loadNotifications = React.useCallback(
    async ({ silent = false, signal } = {}) => {
      if (!enabled) return [];
      if (!activeShopId) {
        setState({ status: 'idle', rows: [], error: '' });
        return [];
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (signal?.aborted) controller.abort();
      else if (signal) {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      if (!silent) {
        setState((current) => ({ ...current, status: 'loading', error: '' }));
      }

      try {
        const payload = await readCustomerServiceNotifications(
          { shopId: activeShopId, limit: 100 },
          { signal: controller.signal }
        );
        if (payload?.ok === false) {
          throw new Error(payload?.error?.message || 'Ozon 信息推送读取失败');
        }
        if (controller.signal.aborted || requestId !== requestIdRef.current) return [];
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        setState({ status: 'success', rows, error: '' });
        return rows;
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') return [];
        if (requestId !== requestIdRef.current) return [];
        const message = translateCustomerError(error, 'Ozon 信息推送读取失败，请稍后重试。');
        setState((current) => ({ ...current, status: 'error', error: message }));
        return [];
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [activeShopId, enabled]
  );

  React.useEffect(() => {
    if (!enabled) return undefined;
    void loadNotifications();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      requestIdRef.current += 1;
    };
  }, [enabled, loadNotifications]);

  return {
    ...state,
    refresh: loadNotifications,
  };
}

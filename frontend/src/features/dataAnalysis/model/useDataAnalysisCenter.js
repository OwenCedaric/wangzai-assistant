import { dataAnalysisDatePresets } from '../constants/dataAnalysisCatalog.js';
import { normalizeDataAnalysisCachePayload } from '../lib/dataAnalysisFormatter.js';
import { readDataAnalysisCache, requestDataAnalysisSync, syncOfficialTrafficData } from '../services/dataAnalysisCacheClient.js';
import { getOzonReadableShops, getOzonShopSelectionId } from '../../../entities/order/orderShopScope.jsx';
import React from 'react';

const OZON_BUSINESS_TIME_ZONE = 'Europe/Moscow';

export function toOzonBusinessDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OZON_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, days) {
  const next = new Date(`${dateKey}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function createDataAnalysisDateRange(presetId = '30d', today = new Date()) {
  const preset = dataAnalysisDatePresets.find((item) => item.id === presetId) || dataAnalysisDatePresets[2];
  const endDate = toOzonBusinessDateKey(today);
  if (!preset.days) return { presetId: 'custom', startDate: endDate, endDate };
  return {
    presetId: preset.id,
    startDate: shiftDateKey(endDate, -(preset.days - 1)),
    endDate,
  };
}

export function getOfficialTrafficSyncShopIds(shops = [], selectedShopId = '') {
  const readableShops = getOzonReadableShops(shops);
  const selectedId = String(selectedShopId || '').trim();
  const selectedShops = selectedId
    ? readableShops.filter((shop) => getOzonShopSelectionId(shop) === selectedId)
    : readableShops;
  return [...new Set(selectedShops.map(getOzonShopSelectionId).filter(Boolean))];
}

function getOfficialTrafficSyncFailure(result = {}, shopId = '') {
  const status = String(result?.job?.status || result?.status || '').trim();
  if (!result?.timedOut && result?.ok !== false && !['failed', 'canceled'].includes(status)) return null;
  const error = new Error(
    result?.job?.lastError
      || result?.error?.message
      || `${shopId || '当前店铺'}的官方流量同步未完成。`
  );
  error.shopId = shopId;
  error.code = result?.timedOut ? 'OFFICIAL_TRAFFIC_SYNC_TIMEOUT' : 'OFFICIAL_TRAFFIC_SYNC_FAILED';
  return error;
}

const initialPayload = normalizeDataAnalysisCachePayload({});

export function useDataAnalysisCenter({ shops = [], isActive = true } = {}) {
  const [activeModuleId, setActiveModuleId] = React.useState('overview');
  const [filters, setFilters] = React.useState(() => ({
    shopId: '',
    ...createDataAnalysisDateRange('30d'),
  }));
  const [state, setState] = React.useState({
    status: 'idle',
    payload: initialPayload,
    error: null,
    loadedAt: null,
  });
  const officialRefreshPromiseRef = React.useRef(null);
  const requestGenerationRef = React.useRef(0);
  const activeReadControllerRef = React.useRef(null);

  React.useEffect(() => {
    const availableShopIds = new Set(shops.map((shop) => String(shop?.id || '').trim()).filter(Boolean));
    setFilters((current) => {
      if (!current.shopId || availableShopIds.has(current.shopId)) return current;
      return { ...current, shopId: '' };
    });
  }, [shops]);

  const configuredShopIds = React.useMemo(() => getOfficialTrafficSyncShopIds(shops, ''), [shops]);
  const configuredShopIdToken = configuredShopIds.join('|');
  const selectedScopeIds = React.useMemo(
    () => (filters.shopId ? [filters.shopId] : configuredShopIds),
    [configuredShopIds, filters.shopId]
  );

  const refresh = React.useCallback(
    async ({ signal, keepStatus = false } = {}) => {
      const generation = ++requestGenerationRef.current;
      activeReadControllerRef.current?.abort();
      const requestController = new AbortController();
      activeReadControllerRef.current = requestController;
      const abortRequest = () => requestController.abort();
      if (signal?.aborted) abortRequest();
      else signal?.addEventListener?.('abort', abortRequest, { once: true });
      setState((current) => ({
        ...current,
        status: keepStatus && current.payload.dashboard ? 'refreshing' : 'loading',
        error: null,
      }));
      try {
        const payload = await readDataAnalysisCache(
          {
            shopId: filters.shopId,
            shopIds: selectedScopeIds.join(','),
            analysisType: 'all',
            sourceType: 'all',
            startDate: filters.startDate,
            endDate: filters.endDate,
            limit: 50,
          },
          { signal: requestController.signal, timeoutMs: 12000 }
        );
        if (generation !== requestGenerationRef.current) return null;
        setState({
          status: 'success',
          payload: normalizeDataAnalysisCachePayload(payload),
          error: null,
          loadedAt: new Date().toISOString(),
        });
        return payload;
      } catch (error) {
        if (generation !== requestGenerationRef.current) return null;
        if (error?.name === 'AbortError') return null;
        setState((current) => ({ ...current, status: 'error', error }));
        return null;
      } finally {
        signal?.removeEventListener?.('abort', abortRequest);
        if (activeReadControllerRef.current === requestController) {
          activeReadControllerRef.current = null;
        }
      }
    },
    [configuredShopIdToken, filters.endDate, filters.shopId, filters.startDate, selectedScopeIds]
  );

  const rebuild = React.useCallback(async () => {
    setState((current) => ({ ...current, status: 'rebuilding', error: null }));
    try {
      await requestDataAnalysisSync(
        {
          shopId: filters.shopId,
          shopIds: selectedScopeIds.join(','),
          analysisType: 'all',
          startDate: filters.startDate,
          endDate: filters.endDate,
          requestedBy: 'frontend:data-analysis-center',
        },
        { timeoutMs: 20000 }
      );
      return await refresh({ keepStatus: true });
    } catch (error) {
      setState((current) => ({ ...current, status: 'error', error }));
      return null;
    }
  }, [filters.endDate, filters.shopId, filters.startDate, refresh, selectedScopeIds]);

  const refreshOfficialData = React.useCallback(() => {
    if (officialRefreshPromiseRef.current) return officialRefreshPromiseRef.current;

    const refreshPromise = (async () => {
      setState((current) => ({ ...current, status: 'refreshing', error: null }));
      try {
        const shopIds = getOfficialTrafficSyncShopIds(shops, filters.shopId);
        if (!shopIds.length) {
          throw new Error(filters.shopId ? '当前店铺未配置完整的 Ozon 读取凭证。' : '没有可同步的 Ozon 店铺。');
        }
        const trafficResults = await Promise.allSettled(
          shopIds.map(async (shopId) => {
            const result = await syncOfficialTrafficData(
              {
                shopId,
                startDate: filters.startDate,
                endDate: filters.endDate,
                idempotencyKey: `data-analysis:traffic:${shopId}:${filters.startDate}:${filters.endDate}`,
                requestedBy: 'frontend:data-analysis-official-refresh',
              },
              { timeoutMs: 90000 }
            );
            const failure = getOfficialTrafficSyncFailure(result, shopId);
            if (failure) throw failure;
            return { shopId, result };
          })
        );
        const failures = trafficResults
          .map((result, index) => (result.status === 'rejected'
            ? { shopId: shopIds[index], error: result.reason }
            : null))
          .filter(Boolean);

        await requestDataAnalysisSync(
          {
            shopId: filters.shopId,
            shopIds: shopIds.join(','),
            analysisType: 'all',
            startDate: filters.startDate,
            endDate: filters.endDate,
            requestedBy: 'frontend:data-analysis-after-official-refresh',
          },
          { timeoutMs: 20000 }
        );
        const payload = await refresh({ keepStatus: true });
        if (failures.length && payload !== null) {
          const error = new Error(
            failures.length === shopIds.length
              ? '所有店铺的官方流量同步均失败，已保留并回读现有缓存。'
              : `${failures.length} 家店铺的官方流量同步失败，其他店铺数据已回读。`
          );
          error.code = failures.length === shopIds.length
            ? 'OFFICIAL_TRAFFIC_SYNC_ALL_FAILED'
            : 'OFFICIAL_TRAFFIC_SYNC_PARTIAL';
          error.failures = failures;
          setState((current) => ({
            ...current,
            status: failures.length === shopIds.length ? 'error' : 'success',
            error,
          }));
        }
        return payload;
      } catch (error) {
        setState((current) => ({ ...current, status: 'error', error }));
        return null;
      }
    })();

    officialRefreshPromiseRef.current = refreshPromise;
    void refreshPromise.finally(() => {
      if (officialRefreshPromiseRef.current === refreshPromise) {
        officialRefreshPromiseRef.current = null;
      }
    });
    return refreshPromise;
  }, [filters.endDate, filters.shopId, filters.startDate, refresh, shops]);

  React.useEffect(() => {
    if (!isActive) return undefined;
    const controller = new AbortController();
    refresh({ signal: controller.signal });
    return () => {
      requestGenerationRef.current += 1;
      controller.abort();
    };
  }, [isActive, refresh]);

  const setPreset = React.useCallback((presetId) => {
    setFilters((current) => ({ ...current, ...createDataAnalysisDateRange(presetId) }));
  }, []);

  const setCustomRange = React.useCallback((patch = {}) => {
    setFilters((current) => ({ ...current, presetId: 'custom', ...patch }));
  }, []);

  return {
    ...state,
    activeModuleId,
    setActiveModuleId,
    filters,
    setShopId: (shopId) => setFilters((current) => ({ ...current, shopId })),
    setPreset,
    setCustomRange,
    refresh,
    refreshOfficialData,
    rebuild,
  };
}

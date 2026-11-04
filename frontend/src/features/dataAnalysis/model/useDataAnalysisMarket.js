import React from 'react';
import {
  DATA_ANALYSIS_MARKET_CACHE_EVENT,
  readDataAnalysisMarketCache,
  refreshDataAnalysisMarketHotCache,
} from '../services/dataAnalysisMarketCacheService.js';

const EMPTY_MARKET_STATE = Object.freeze({
  status: 'idle',
  statusLabel: '等待读取',
  data: null,
  error: null,
  query: '',
  activeAction: '',
});

function liveState(data) {
  return {
    status: data.status,
    statusLabel: data.statusLabel,
    data,
    error: null,
    activeAction: '',
  };
}

export function useDataAnalysisMarket({ enabled = false } = {}) {
  const [state, setState] = React.useState(EMPTY_MARKET_STATE);
  const requestVersionRef = React.useRef(0);
  const [query, setQuery] = React.useState('');

  const refresh = React.useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setState((current) => ({
      ...current,
      status: current.data ? 'refreshing' : 'loading',
      statusLabel: current.data?.isCached
        ? '已显示热缓存，正在刷新最新数据'
        : '正在读取浏览器插件数据',
      error: null,
      activeAction: 'manual',
    }));
    try {
      const data = await refreshDataAnalysisMarketHotCache({
        trigger: 'manual',
        force: true,
        browser: { autoNavigate: true, awaitBackground: true },
      });
      if (requestVersion !== requestVersionRef.current) return data;
      setState(liveState(data));
      return data;
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return null;
      setState((current) => ({
        ...current,
        status: current.data ? 'error-with-cache' : 'error',
        statusLabel: current.data ? '刷新失败，当前为缓存数据' : '插件数据读取失败',
        error,
        activeAction: '',
      }));
      return null;
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setState((current) => current.activeAction === 'manual'
          ? {
            ...current,
            status: current.data ? current.data.status || 'ready' : current.status === 'refreshing' ? 'idle' : current.status,
            statusLabel: current.data?.statusLabel || current.statusLabel,
            activeAction: '',
          }
          : current);
      }
    }
  }, []);

  const search = React.useCallback(async (nextQuery = query) => {
    const searchText = String(nextQuery || '').trim();
    if (!searchText) {
      setState((current) => ({ ...current, status: 'error', statusLabel: '请输入搜索词', error: new Error('请输入搜索词') }));
      return null;
    }
    setQuery(searchText);
    const requestVersion = ++requestVersionRef.current;
    setState((current) => ({
      ...current,
      status: 'searching',
      statusLabel: `正在让 Ozon 搜索“${searchText}”`,
      error: null,
      query: searchText,
      activeAction: 'search',
    }));
    try {
      const data = await refreshDataAnalysisMarketHotCache({
        trigger: 'search',
        force: true,
        browser: { query: searchText, awaitBackground: true, scanRoutes: false },
      });
      if (requestVersion !== requestVersionRef.current) return data;
      setState({ ...liveState(data), query: searchText });
      return data;
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return null;
      setState((current) => ({
        ...current,
        status: current.data ? 'error-with-cache' : 'error',
        statusLabel: current.data ? '搜索失败，已保留完整市场数据' : 'Ozon 搜索失败',
        error,
        query: searchText,
        activeAction: '',
      }));
      return null;
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setState((current) => current.activeAction === 'search'
          ? {
            ...current,
            status: current.data ? current.data.status || 'ready' : current.status === 'searching' ? 'idle' : current.status,
            statusLabel: current.data?.statusLabel || current.statusLabel,
            activeAction: '',
          }
          : current);
      }
    }
  }, [query]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const requestVersion = ++requestVersionRef.current;
    let liveSettled = false;
    let liveError = null;
    setState((current) => ({
      ...current,
      status: current.data ? 'cache-ready' : 'loading',
      statusLabel: current.data ? '已显示现有数据，正在后台检查更新' : '正在读取热缓存',
      error: null,
      activeAction: '',
    }));

    void readDataAnalysisMarketCache({})
      .then((cached) => {
        if (!cached || requestVersion !== requestVersionRef.current || liveSettled && !liveError) return;
        setState({
          status: liveError ? 'error-with-cache' : 'cache-ready',
          statusLabel: liveError ? '刷新失败，当前为缓存数据' : '已显示热缓存，正在刷新最新数据',
          data: cached,
          error: liveError,
          activeAction: '',
        });
      })
      .catch(() => undefined);

    void refreshDataAnalysisMarketHotCache({
      trigger: 'view',
      browser: { autoNavigate: true, awaitBackground: true },
    })
      .then((data) => {
        liveSettled = true;
        if (requestVersion !== requestVersionRef.current) return;
        setState(liveState(data));
      })
      .catch((error) => {
        liveSettled = true;
        liveError = error;
        if (requestVersion !== requestVersionRef.current) return;
        setState((current) => ({
          ...current,
          status: current.data ? 'error-with-cache' : 'error',
          statusLabel: current.data ? '刷新失败，当前为缓存数据' : '插件数据读取失败',
          error,
          activeAction: '',
        }));
      });

    const handleHotCacheUpdate = (event) => {
      const data = event?.detail?.data;
      if (!data?.sections && !data?.datasetViews) return;
      // Route progress is intentionally broadcast by the hot-cache worker, but
      // it is a partial snapshot.  Do not replace the visible table on every
      // route/page; keep the last complete snapshot until refresh completes.
      if (data.refreshInProgress === true) {
        // The app-wide periodic hot-cache poll is deliberately invisible to the
        // foreground page.  It must not disable the search button or make the
        // user feel that the page is stuck in an endless refresh state.
        if (data.refreshTrigger === 'background') return;
        setState((current) => {
          const eventAction = data.refreshTrigger === 'search'
            ? 'search'
            : data.refreshTrigger === 'manual'
              ? 'manual'
              : '';
          // Only the explicit action started by this hook owns the foreground
          // controls. A manual/search run from a stale page instance must not
          // leave the newly mounted page permanently disabled.
          if (eventAction && current.activeAction !== eventAction) return current;
          if (data.refreshTrigger === 'view' && current.data) return current;
          return {
            ...current,
            status: current.data ? 'refreshing' : current.status === 'searching' ? 'searching' : 'loading',
            statusLabel: data.statusLabel || current.statusLabel,
            error: null,
            activeAction: data.refreshTrigger === 'search' ? 'search' : data.refreshTrigger === 'manual' ? 'manual' : current.activeAction,
          };
        });
        return;
      }
      // Explicit refresh/search completions are applied by their own Promise,
      // whose request version identifies the latest user action.  Ignoring
      // their broadcast completion prevents an older overlapping action from
      // replacing a newer one.
      if (data.refreshTrigger === 'manual' || data.refreshTrigger === 'search') return;
      // A complete event is newer than the cache-read Promise started during
      // mount.  Mark the live read settled so that the older cache result
      // cannot put the controls back into `cache-ready`/refreshing state.
      liveSettled = true;
      // A periodic/view completion may update an idle page, but it must never
      // clear or replace a newer foreground manual/search action.
      setState((current) => current.activeAction ? current : liveState(data));
    };

    globalThis.window?.addEventListener?.(DATA_ANALYSIS_MARKET_CACHE_EVENT, handleHotCacheUpdate);
    return () => {
      requestVersionRef.current += 1;
      globalThis.window?.removeEventListener?.(DATA_ANALYSIS_MARKET_CACHE_EVENT, handleHotCacheUpdate);
    };
  }, [enabled]);

  return { ...state, query, setQuery, refresh, search };
}

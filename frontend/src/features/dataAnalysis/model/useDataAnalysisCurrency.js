import { readRubCnyExchangeRateContext } from '../../../services/exchangeRateClient.js';
import {
  collectDataAnalysisMarketRubDates,
  collectDataAnalysisRubDates,
  convertDataAnalysisDashboardToCny,
  convertDataAnalysisMarketToCny,
} from '../lib/dataAnalysisCurrency.js';
import React from 'react';

const INITIAL_STATE = Object.freeze({
  status: 'idle',
  dashboard: null,
  marketData: null,
  error: null,
  rateContext: null,
  dashboardSource: null,
  marketDataSource: null,
});

function getLocalTodayKey() {
  const date = new Date();
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

export function useDataAnalysisCurrency({ dashboard, marketData = null, endDate = '' } = {}) {
  const [state, setState] = React.useState(INITIAL_STATE);
  const safeDashboard = React.useMemo(
    () => (dashboard ? convertDataAnalysisDashboardToCny(dashboard, {}) : null),
    [dashboard]
  );
  const safeMarketData = React.useMemo(
    () => (marketData ? convertDataAnalysisMarketToCny(marketData, {}, endDate) : null),
    [endDate, marketData]
  );

  React.useEffect(() => {
    if (!dashboard) {
      setState(INITIAL_STATE);
      return undefined;
    }
    const dates = [...new Set([
      ...collectDataAnalysisRubDates(dashboard),
      ...collectDataAnalysisMarketRubDates(marketData, endDate),
    ])];
    if (!dates.length) {
      setState({
        status: 'success',
        dashboard: convertDataAnalysisDashboardToCny(dashboard, {}),
        marketData: marketData ? convertDataAnalysisMarketToCny(marketData, {}, endDate) : null,
        error: null,
        rateContext: null,
        dashboardSource: dashboard,
        marketDataSource: marketData,
      });
      return undefined;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, status: 'loading', error: null }));
    readRubCnyExchangeRateContext(dates, {
      todayKey: getLocalTodayKey(),
      timeoutMs: 9000,
      maxLookbackDays: 7,
      dailyConcurrency: 5,
      signal: controller.signal,
    })
      .then((rateContext) => {
        if (controller.signal.aborted) return;
        setState({
          status: rateContext.errors?.length ? 'partial' : 'success',
          dashboard: convertDataAnalysisDashboardToCny(dashboard, rateContext),
          marketData: marketData ? convertDataAnalysisMarketToCny(marketData, rateContext, endDate) : null,
          error: rateContext.errors?.[0]?.error || null,
          rateContext,
          dashboardSource: dashboard,
          marketDataSource: marketData,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        setState({
          status: 'error',
          dashboard: convertDataAnalysisDashboardToCny(dashboard, {}),
          marketData: marketData ? convertDataAnalysisMarketToCny(marketData, {}, endDate) : null,
          error,
          rateContext: null,
          dashboardSource: dashboard,
          marketDataSource: marketData,
        });
      });
    return () => controller.abort();
  }, [dashboard, endDate, marketData]);

  const stateMatchesInput = state.dashboardSource === dashboard && state.marketDataSource === marketData;

  return {
    ...state,
    dashboard: stateMatchesInput ? state.dashboard : safeDashboard,
    marketData: stateMatchesInput ? state.marketData : safeMarketData,
    isConverting: state.status === 'loading',
  };
}

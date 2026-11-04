import { normalizePerformanceAnalysis } from '../lib/dataAnalysisFormatter.js';
import {
  collectPerformanceRubDates,
  convertPerformanceAnalysisToCny,
} from '../lib/dataAnalysisCurrency.js';
import { readDataAnalysisPerformance } from '../services/dataAnalysisPerformanceClient.js';
import { readRubCnyExchangeRateContext } from '../../../services/exchangeRateClient.js';
import React from 'react';

function getLocalTodayKey() {
  const date = new Date();
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

export function useDataAnalysisPerformance({
  enabled = false,
  shopId = '',
  shopName = '',
  dateFrom = '',
  dateTo = '',
} = {}) {
  const [state, setState] = React.useState({ status: 'idle', data: null, error: null });

  const refresh = React.useCallback(
    async ({ signal } = {}) => {
      setState((current) => ({ ...current, status: current.data ? 'refreshing' : 'loading', error: null }));
      try {
        const payload = await readDataAnalysisPerformance(
          { shopId, shopName, dateFrom, dateTo },
          { signal, timeoutMs: 120000 }
        );
        if (payload.ok === false && payload.error) {
          setState({ status: payload.status || 'error', data: null, error: payload.error });
          return null;
        }
        const normalized = normalizePerformanceAnalysis(payload);
        const hasRubMoney = normalized.metrics.some(
          (metric) =>
            metric.unit === 'money' &&
            metric.value !== null &&
            metric.value !== undefined &&
            metric.value !== '' &&
            Number.isFinite(Number(metric.value))
        );
        let data = normalized;
        if (hasRubMoney) {
          const dates = collectPerformanceRubDates(normalized, dateTo);
          const rateContext = await readRubCnyExchangeRateContext(dates, {
            todayKey: getLocalTodayKey(),
            timeoutMs: 9000,
            maxLookbackDays: 7,
            dailyConcurrency: 5,
            signal,
          });
          data = convertPerformanceAnalysisToCny(normalized, rateContext, dateTo);
        }
        setState({ status: 'success', data, error: null });
        return data;
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        setState({ status: 'error', data: null, error });
        return null;
      }
    },
    [dateFrom, dateTo, shopId, shopName]
  );

  React.useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    refresh({ signal: controller.signal });
    return () => controller.abort();
  }, [enabled, refresh]);

  return { ...state, refresh };
}

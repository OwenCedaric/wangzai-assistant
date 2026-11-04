import { requestLocalApi } from '../../../api/localApiClient.js';

export const DATA_ANALYSIS_INSIGHT_REQUEST_TIMEOUT_MS = 300_000;

export function generateDataAnalysisInsight(input = {}, options = {}) {
  return requestLocalApi('/api/data-analysis/insights', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs ?? DATA_ANALYSIS_INSIGHT_REQUEST_TIMEOUT_MS,
    signal: options.signal,
  });
}

import {
  readOzonMarketCaptureData,
  searchOzonMarketCaptureData,
  syncOzonMarketCaptureData,
} from '../../../services/ozonMarketCapture/marketCaptureWorkflow.js';
import { marketCaptureText } from '../lib/dataAnalysisMarketMetrics.js';
import { normalizeDataAnalysisMarketBrowserSnapshot } from '../lib/dataAnalysisMarketSnapshot.js';
import { createDataAnalysisMarketCaptureAccumulator } from '../lib/dataAnalysisMarketAccumulator.js';

function captureWorkflowOptions(options = {}) {
  return {
    ...options,
    createCaptureAccumulator: options.createCaptureAccumulator
      || createDataAnalysisMarketCaptureAccumulator,
    normalizeSnapshot: options.normalizeSnapshot
      || normalizeDataAnalysisMarketBrowserSnapshot,
  };
}

export async function syncDataAnalysisMarketBrowserData(options = {}) {
  return syncOzonMarketCaptureData(captureWorkflowOptions(options));
}

export async function searchDataAnalysisMarketBrowserData(query, options = {}) {
  return searchOzonMarketCaptureData(query, captureWorkflowOptions(options));
}

export async function readDataAnalysisMarketBrowserData(options = {}) {
  if (marketCaptureText(options.query)) {
    return searchDataAnalysisMarketBrowserData(options.query, options);
  }
  if (options.autoNavigate === true) {
    return syncDataAnalysisMarketBrowserData(options);
  }
  return readOzonMarketCaptureData(captureWorkflowOptions(options));
}

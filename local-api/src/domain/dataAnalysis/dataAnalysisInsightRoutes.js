import { createJsonResponse, readJsonRequestBody } from '../../utils/http.js';
import { paidCapabilityContextFromRequest } from '../paidCapabilities/paidCapabilityAccess.js';

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: 'DATA_ANALYSIS_INSIGHT_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function createDataAnalysisInsightRoutes({ service } = {}) {
  return {
    handleRequest({ req, res, requestUrl, corsHeaders }) {
      if (req.method !== 'POST' || requestUrl.pathname !== '/api/data-analysis/insights') return false;
      readJsonRequestBody(req, { maxBytes: 256 * 1024 })
        .then((body) => service.generate(body, paidCapabilityContextFromRequest(req)))
        .then((payload) => createJsonResponse(res, 200, payload, corsHeaders))
        .catch((error) => createJsonResponse(res, 400, errorPayload(error), corsHeaders));
      return true;
    },
  };
}

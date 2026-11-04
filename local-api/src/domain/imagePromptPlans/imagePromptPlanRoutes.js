import { createJsonResponse, readJsonRequestBody } from '../../utils/http.js';
import { paidCapabilityContextFromRequest } from '../paidCapabilities/paidCapabilityAccess.js';

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error?.code || 'IMAGE_PROMPT_PLAN_GENERATION_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function createImagePromptPlanRoutes({ service, resolveRequestContext = async ({ req }) => paidCapabilityContextFromRequest(req) } = {}) {
  return {
    handleRequest({ req, res, requestUrl, corsHeaders }) {
      if (req.method !== 'POST' || requestUrl.pathname !== '/api/image-prompt-plans/generate') return false;
      readJsonRequestBody(req, { maxBytes: 15 * 1024 * 1024 })
        .then(async (body) => service.generatePlan(body, await resolveRequestContext({ req, requestUrl, body })))
        .then((payload) => createJsonResponse(res, 200, payload, corsHeaders))
        .catch((error) => createJsonResponse(res, error?.code === 'PRODUCT_IMAGE_SCOPE_FORBIDDEN' ? 403 : 400, errorPayload(error), corsHeaders));
      return true;
    },
  };
}

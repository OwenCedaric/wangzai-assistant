import { createJsonResponse, readJsonRequestBody } from "../../utils/http.js";
import { paidCapabilityContextFromRequest } from "../paidCapabilities/paidCapabilityAccess.js";

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: String(error?.code || "EXTERNAL_DATA_INSIGHT_FAILED"),
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function createExternalDataInsightRoutes({ service } = {}) {
  return {
    handleRequest({ req, res, requestUrl, corsHeaders }) {
      if (
        req.method !== "POST" ||
        requestUrl.pathname !== "/api/integrations/analyze"
      )
        return false;
      readJsonRequestBody(req, { maxBytes: 512 * 1024 })
        .then((body) =>
          service.generate(body, paidCapabilityContextFromRequest(req)),
        )
        .then((payload) => createJsonResponse(res, 200, payload, corsHeaders))
        .catch((error) =>
          createJsonResponse(res, 400, errorPayload(error), corsHeaders),
        );
      return true;
    },
  };
}

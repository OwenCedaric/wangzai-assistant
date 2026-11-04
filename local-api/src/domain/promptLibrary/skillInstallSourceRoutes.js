import { createJsonResponse, readJsonRequestBody } from "../../utils/http.js";

function errorPayload(error) {
  const code = String(error?.code || "SKILL_INSTALL_RESOLVE_FAILED");
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function errorStatus(error) {
  const code = String(error?.code || "");
  if (code === "SKILL_INSTALL_NOT_FOUND") return 404;
  if (code === "SKILL_INSTALL_SOURCE_UNAVAILABLE") return 502;
  return 400;
}

export function createSkillInstallSourceRoutes({ service } = {}) {
  return {
    handleRequest({ req, res, requestUrl, corsHeaders }) {
      if (
        req.method !== "POST" ||
        requestUrl.pathname !== "/api/prompt-library/skill-source/resolve"
      )
        return false;
      readJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => service.resolve(body))
        .then((payload) => createJsonResponse(res, 200, payload, corsHeaders))
        .catch((error) =>
          createJsonResponse(
            res,
            errorStatus(error),
            errorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    },
  };
}

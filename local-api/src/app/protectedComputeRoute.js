import {
  ProtectedComputeError,
  isProtectedComputeError,
} from "../domain/protectedCompute/protectedComputeError.js";
import { createJsonResponse, readJsonRequestBody } from "../utils/http.js";

const ROUTE_PREFIX = "/api/protected-compute";
const EXECUTE_PATH = `${ROUTE_PREFIX}/execute`;
const ACCESS_TOKEN_HEADER = "x-wangzai-protected-compute-access-token";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PRIVATE_PROFIT_REQUEST_BYTES = 2 * 1024 * 1024 + 4096;

function sendError(res, error, corsHeaders, { malformedBody = false } = {}) {
  const controlled = isProtectedComputeError(error);
  const normalized = controlled
    ? error
    : new ProtectedComputeError(
        malformedBody
          ? "PROTECTED_COMPUTE_REQUEST_INVALID"
          : "PROTECTED_COMPUTE_REQUEST_FAILED",
        malformedBody
          ? "Protected-compute request body is invalid."
          : "Protected-compute request failed.",
        { status: malformedBody ? 400 : 500, retriable: false },
      );
  const status = Number.isInteger(normalized.status)
    && normalized.status >= 400
    && normalized.status <= 599
    ? normalized.status
    : 500;
  createJsonResponse(res, status, {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retriable: normalized.retriable === true,
      ...(status === 429 && Number.isInteger(normalized.details?.retryAfterMs)
        ? { retryAfterMs: Math.max(1, Math.min(60_000, normalized.details.retryAfterMs)) } : {}),
    },
  }, corsHeaders);
}

export function createProtectedComputeRoute({ service } = {}) {
  if (!service?.execute || !service?.getStatus || !service?.listContracts) {
    throw new Error("PROTECTED_COMPUTE_ROUTE_SERVICE_REQUIRED");
  }

  return function handleProtectedComputeRoute({ req, res, requestUrl, corsHeaders }) {
    const { pathname } = requestUrl;
    if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) return false;

    if (req.method === "GET" && pathname === `${ROUTE_PREFIX}/status`) {
      createJsonResponse(res, 200, service.getStatus(), corsHeaders);
      return true;
    }

    if (req.method === "GET" && pathname === `${ROUTE_PREFIX}/contracts`) {
      createJsonResponse(res, 200, service.listContracts(), corsHeaders);
      return true;
    }

    if (req.method === "POST" && pathname === EXECUTE_PATH) {
      let requestBytes = 0;
      const countBytes = chunk => { requestBytes += chunk.length; };
      req.on('data', countBytes);
      readJsonRequestBody(req, { maxBytes: MAX_PRIVATE_PROFIT_REQUEST_BYTES }).then(
        (body) => {
          req.removeListener('data', countBytes);
          if ((body?.capability !== 'profit.ledger-batch' || body?.version !== 1) && requestBytes > MAX_REQUEST_BYTES) {
            sendError(res, new ProtectedComputeError('PROTECTED_COMPUTE_REQUEST_INVALID', 'Protected-compute request body is too large.', { status: 400 }), corsHeaders);
            return;
          }
          Promise.resolve(service.execute(body, {
            accessToken: req.headers[ACCESS_TOKEN_HEADER],
          })).then(
            (payload) => createJsonResponse(res, 200, payload, corsHeaders),
            (error) => sendError(res, error, corsHeaders),
          );
        },
        (error) => { req.removeListener('data', countBytes); sendError(res, error, corsHeaders, { malformedBody: true }); },
      );
      return true;
    }

    createJsonResponse(res, 404, {
      ok: false,
      error: {
        code: "PROTECTED_COMPUTE_ROUTE_NOT_FOUND",
        message: "Protected-compute route does not exist.",
        retriable: false,
      },
    }, corsHeaders);
    return true;
  };
}

export const protectedComputeRouteContract = Object.freeze({
  accessTokenHeader: ACCESS_TOKEN_HEADER,
  executePath: EXECUTE_PATH,
  maxRequestBytes: MAX_REQUEST_BYTES,
  prefix: ROUTE_PREFIX,
});

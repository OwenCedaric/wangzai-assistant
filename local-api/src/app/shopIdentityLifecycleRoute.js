import { createShopSavedPayload } from '../routes/shops.js';
import { createJsonResponse, readJsonRequestBody } from '../utils/http.js';

const LIFECYCLE_ROUTE = /^\/api\/shops\/([^/]+)\/lifecycle$/u;
const BOOTSTRAP_ROUTE = /^\/api\/shops\/([^/]+)\/bootstrap$/u;
const BOOTSTRAP_RUN_ROUTE = /^\/api\/shops\/([^/]+)\/bootstrap\/([^/]+)$/u;
const REBIND_ROUTE = /^\/api\/shops\/([^/]+)\/rebind$/u;

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new Error('SHOP_ROUTE_ID_INVALID');
    error.code = 'SHOP_ROUTE_ID_INVALID';
    throw error;
  }
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  if (/^SHOP_[A-Z0-9_]+$/u.test(code)) return code;
  const message = error instanceof Error ? error.message : String(error || '');
  return /^SHOP_[A-Z0-9_]+$/u.test(message) ? message : 'SHOP_LIFECYCLE_REQUEST_FAILED';
}

function errorStatus(code) {
  if (code.endsWith('_NOT_FOUND') || code === 'SHOP_SCOPE_NOT_FOUND') return 404;
  if (
    code.includes('STALE')
    || code.includes('CONFLICT')
    || code.includes('MISMATCH')
    || code.includes('DISABLED')
    || code.includes('FORBIDDEN')
  ) return 409;
  return 400;
}

function sendError(res, error, corsHeaders) {
  const code = errorCode(error);
  createJsonResponse(res, errorStatus(code), {
    ok: false,
    bindingReady: false,
    error: { code, message: code },
  }, corsHeaders);
}

export function createShopIdentityLifecycleRoute({
  coordinator,
  assertWritable = () => undefined,
  prepareSave = () => null,
  finishSave = () => undefined,
  enqueueOnBinding = true,
} = {}) {
  if (!coordinator) throw new Error('SHOP_IDENTITY_LIFECYCLE_ROUTE_COORDINATOR_REQUIRED');

  return function handleShopIdentityLifecycleRoute({ req, res, requestUrl, corsHeaders }) {
    const { pathname } = requestUrl;

    const lifecycleMatch = pathname.match(LIFECYCLE_ROUTE);
    if (req.method === 'GET' && lifecycleMatch) {
      try {
        const shopId = decodePart(lifecycleMatch[1]);
        Promise.resolve(coordinator.getShopStatus(shopId, { reconcile: true }))
          .then((result) => createJsonResponse(res, 200, result, corsHeaders))
          .catch((error) => sendError(res, error, corsHeaders));
      } catch (error) {
        sendError(res, error, corsHeaders);
      }
      return true;
    }

    const runMatch = pathname.match(BOOTSTRAP_RUN_ROUTE);
    if (req.method === 'GET' && runMatch) {
      try {
        const shopId = decodePart(runMatch[1]);
        const runId = decodePart(runMatch[2]);
        Promise.resolve(coordinator.getRunStatus(shopId, runId, { reconcile: true }))
          .then((result) => createJsonResponse(res, 200, result, corsHeaders))
          .catch((error) => sendError(res, error, corsHeaders));
      } catch (error) {
        sendError(res, error, corsHeaders);
      }
      return true;
    }

    const bootstrapMatch = pathname.match(BOOTSTRAP_ROUTE);
    if (req.method === 'POST' && bootstrapMatch) {
      let shopId;
      try {
        shopId = decodePart(bootstrapMatch[1]);
        assertWritable('ozon_shop', shopId, { requireExisting: true });
      } catch (error) {
        sendError(res, error, corsHeaders);
        return true;
      }
      readJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => coordinator.requestBootstrap(shopId, body, { enqueue: true }))
        .then((result) => createJsonResponse(res, result.bindingReady ? 200 : 202, result, corsHeaders))
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    const rebindMatch = pathname.match(REBIND_ROUTE);
    if (req.method === 'POST' && rebindMatch) {
      let shopId;
      try {
        shopId = decodePart(rebindMatch[1]);
      } catch (error) {
        sendError(res, error, corsHeaders);
        return true;
      }
      readJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          const payload = { ...body, id: shopId };
          const admission = prepareSave('ozon_shop', shopId, payload);
          const result = await coordinator.rebind(payload, {
            enqueue: enqueueOnBinding,
            onBindingSaved: () => finishSave(admission),
          });
          createJsonResponse(res, 200, createShopSavedPayload(result), corsHeaders);
        })
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    return false;
  };
}

export const shopIdentityLifecycleRouteContract = Object.freeze({
  bootstrapRoute: '/api/shops/:shopId/bootstrap',
  bootstrapRunRoute: '/api/shops/:shopId/bootstrap/:runId',
  lifecycleRoute: '/api/shops/:shopId/lifecycle',
  rebindRoute: '/api/shops/:shopId/rebind',
});

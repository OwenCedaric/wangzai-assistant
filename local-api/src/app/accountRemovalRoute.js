import { ACCOUNT_REMOVAL_ERROR_CODES } from '../domain/accountRemoval/accountRemovalErrors.js';
import { createJsonResponse, readJsonRequestBody } from '../utils/http.js';

const LEGACY_DELETE_ROUTES = Object.freeze([
  { ownerType: 'ozon_shop', pattern: /^\/api\/shops\/([^/]+)$/u },
  { ownerType: 'purchase_account', pattern: /^\/api\/purchase\/accounts\/([^/]+)$/u },
  { ownerType: 'model_api_account', pattern: /^\/api\/model-api\/accounts\/([^/]+)$/u },
  { ownerType: 'promotion_account', pattern: /^\/api\/performance\/accounts\/([^/]+)$/u },
  { ownerType: 'cross_border_bus', pattern: /^\/api\/logistics\/cross-border\/accounts\/([^/]+)$/u },
  { ownerType: 'integration_profile', pattern: /^\/api\/integrations\/profiles\/([^/]+)$/u },
]);

function errorCode(error) {
  if (typeof error?.code === 'string' && error.code) return error.code;
  const message = error instanceof Error ? error.message : String(error || '');
  return /^ACCOUNT_REMOVAL_[A-Z0-9_]+$/u.test(message)
    ? message
    : 'ACCOUNT_REMOVAL_REQUEST_FAILED';
}

function errorStatus(code) {
  if (code === ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_NOT_FOUND || code === ACCOUNT_REMOVAL_ERROR_CODES.OWNER_NOT_FOUND) return 404;
  if (
    code.includes('MISMATCH')
    || code.includes('CONFLICT')
    || code.includes('LOCKED')
    || code.includes('TIMEOUT')
    || code.includes('QUIESCED')
    || code === ACCOUNT_REMOVAL_ERROR_CODES.CLIENT_CLEANUP_REQUIRED
  ) return 409;
  return 400;
}

function sendError(res, error, corsHeaders) {
  const code = errorCode(error);
  createJsonResponse(res, errorStatus(code), {
    ok: false,
    completed: false,
    error: { code, message: code },
  }, corsHeaders);
}

function matchOperation(pathname, suffix = '') {
  const pattern = suffix
    ? new RegExp(`^/api/account-removal/operations/([^/]+)/${suffix}$`, 'u')
    : /^\/api\/account-removal\/operations\/([^/]+)$/u;
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    const error = new Error(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID);
    error.code = ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID;
    throw error;
  }
}

export function createAccountRemovalRoute({ orchestrator } = {}) {
  if (!orchestrator) throw new Error('ACCOUNT_REMOVAL_ROUTE_ORCHESTRATOR_REQUIRED');

  return function handleAccountRemovalRoute({ req, res, requestUrl, corsHeaders }) {
    const { pathname } = requestUrl;

    if (req.method === 'POST' && pathname === '/api/account-removal/preview') {
      readJsonRequestBody(req, { maxBytes: 2 * 1024 * 1024 })
        .then((body) => createJsonResponse(res, 200, orchestrator.preview(body), corsHeaders))
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/account-removal/prepare-preview') {
      readJsonRequestBody(req, { maxBytes: 2 * 1024 * 1024 })
        .then(async (body) => createJsonResponse(res, 200, await orchestrator.preparePreview(body), corsHeaders))
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/account-removal/release-preview') {
      readJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => createJsonResponse(res, 200, {
          ok: true,
          ...orchestrator.releaseOwnerFence(body?.owner),
        }, corsHeaders))
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/account-removal/confirm') {
      readJsonRequestBody(req, { maxBytes: 2 * 1024 * 1024 })
        .then(async (body) => {
          const result = await orchestrator.confirm(body);
          createJsonResponse(res, result.completed ? 200 : 202, result, corsHeaders);
        })
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/account-removal/client-verify') {
      readJsonRequestBody(req, { maxBytes: 256 * 1024 })
        .then(async (body) => {
          const result = await orchestrator.verifyClientCleanup(body);
          createJsonResponse(res, result.completed ? 200 : 202, result, corsHeaders);
        })
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/account-removal/client-failure') {
      readJsonRequestBody(req, { maxBytes: 8 * 1024 })
        .then(async (body) => {
          const result = await orchestrator.reportClientFailure(body);
          createJsonResponse(res, result.completed ? 200 : 202, result, corsHeaders);
        })
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/account-removal/recover') {
      readJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          const result = await orchestrator.recover(body?.owner);
          createJsonResponse(res, result.completed ? 200 : 202, result, corsHeaders);
        })
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/account-removal/recover-direct') {
      readJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then(async (body) => {
          const result = await orchestrator.recoverDirect(body?.owner);
          createJsonResponse(res, result.completed ? 200 : 202, result, corsHeaders);
        })
        .catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/account-removal/pending') {
      try {
        const filtered = requestUrl.searchParams.has('ownerType') || requestUrl.searchParams.has('ownerId');
        const owner = filtered ? {
          ownerType: requestUrl.searchParams.get('ownerType'), ownerId: requestUrl.searchParams.get('ownerId'),
        } : undefined;
        createJsonResponse(res, 200, { ok: true, operations: orchestrator.listPending(owner) }, corsHeaders);
      } catch (error) {
        sendError(res, error, corsHeaders);
      }
      return true;
    }

    if (req.method === 'POST') {
      try {
        const resumeOperationId = matchOperation(pathname, 'resume');
        if (resumeOperationId) {
          readJsonRequestBody(req, { maxBytes: 8 * 1024 })
            .then((body = {}) => {
              if (!body || typeof body !== 'object' || Array.isArray(body)
                || Object.keys(body).some(key => key !== 'directDelete')
                || (Object.hasOwn(body, 'directDelete') && typeof body.directDelete !== 'boolean')) {
                throw new Error('ACCOUNT_REMOVAL_RESUME_OPTIONS_INVALID');
              }
              return orchestrator.runOperation(resumeOperationId, { directDelete: body.directDelete === true });
            })
            .then((result) => createJsonResponse(res, result.completed ? 200 : 202, result, corsHeaders))
            .catch((error) => sendError(res, error, corsHeaders));
          return true;
        }
      } catch (error) {
        sendError(res, error, corsHeaders);
        return true;
      }
    }

    if (req.method === 'GET') {
      try {
        const operationId = matchOperation(pathname);
        if (operationId) {
          createJsonResponse(res, 200, orchestrator.getStatus(operationId), corsHeaders);
          return true;
        }
      } catch (error) {
        sendError(res, error, corsHeaders);
        return true;
      }
    }

    if (req.method === 'DELETE') {
      for (const route of LEGACY_DELETE_ROUTES) {
        const match = pathname.match(route.pattern);
        if (!match) continue;
        let ownerId;
        try {
          ownerId = decodeURIComponent(match[1]);
        } catch {
          const error = new Error(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID);
          error.code = ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID;
          sendError(res, error, corsHeaders);
          return true;
        }
        createJsonResponse(res, 409, {
          ok: false,
          completed: false,
          owner: { ownerType: route.ownerType, ownerId },
          error: {
            code: ACCOUNT_REMOVAL_ERROR_CODES.LEGACY_ROUTE_PREVIEW_REQUIRED,
            message: '请先通过统一账号销毁预览、人工确认和回读流程。',
          },
          canonicalRoute: '/api/account-removal/preview',
        }, corsHeaders);
        return true;
      }
    }
    return false;
  };
}

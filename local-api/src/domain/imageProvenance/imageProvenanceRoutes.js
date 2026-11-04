import { createJsonResponse, readJsonRequestBody } from '../../utils/http.js';

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error?.code || 'IMAGE_PROVENANCE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function statusForError(error) {
  if (Number(error?.statusCode) >= 400) return Number(error.statusCode);
  if (error?.code === 'IMAGE_PROVENANCE_SCOPE_FORBIDDEN') return 403;
  return 400;
}

export function createImageProvenanceRoutes({ service, resolveRequestContext = async () => ({}) } = {}) {
  return {
    handleRequest({ req, res, requestUrl, corsHeaders }) {
      if (req.method === 'GET' && requestUrl.pathname === '/api/image-provenance/status') {
        createJsonResponse(res, 200, service.getStatus(), corsHeaders);
        return true;
      }
      const jobMatch = requestUrl.pathname.match(/^\/api\/image-provenance\/jobs\/([^/]+)$/u);
      if (req.method === 'GET' && jobMatch) {
        Promise.resolve(resolveRequestContext({ req, requestUrl, body: null }))
          .then((context) => service.readJob(decodeURIComponent(jobMatch[1]), {
            ...context,
            shopId: requestUrl.searchParams.get('shopId') || context.shopId,
          }))
          .then((payload) => createJsonResponse(
            res,
            payload ? 200 : 404,
            payload || { ok: false, error: { code: 'IMAGE_PROVENANCE_JOB_NOT_FOUND', message: '图片证据任务不存在。' } },
            corsHeaders,
          ))
          .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
        return true;
      }
      if (req.method !== 'POST' || requestUrl.pathname !== '/api/image-provenance/jobs') return false;
      readJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then(async (body) => ({ body, context: await resolveRequestContext({ req, requestUrl, body }) }))
        .then(({ body, context }) => service.schedule(body, context))
        .then((payload) => createJsonResponse(res, 202, payload, corsHeaders))
        .catch((error) => createJsonResponse(res, statusForError(error), errorPayload(error), corsHeaders));
      return true;
    },
  };
}

import { createJsonResponse, readJsonRequestBody } from '../../utils/http.js';

const PREFIX = '/api/follow-seller-defense';

function failurePayload(error) {
  return {
    ok: false,
    error: {
      code: error?.code || 'FOLLOW_SELLER_REQUEST_FAILED',
      message: error instanceof Error ? error.message : String(error),
      ...(error?.details === undefined ? {} : { details: error.details }),
    },
  };
}

function statusCode(error) {
  const explicit = Number(error?.statusCode);
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  return 400;
}

export function createFollowSellerDefenseRoutes({
  service,
  readRequestBody = readJsonRequestBody,
  resolveRequestContext = async () => ({}),
} = {}) {
  if (!service) throw new Error('FOLLOW_SELLER_ROUTES_SERVICE_REQUIRED');

  function handleRequest({ req, res, requestUrl, corsHeaders }) {
    const pathname = requestUrl.pathname;
    if (!pathname.startsWith(PREFIX)) return false;

    if (req.method === 'GET' && pathname === `${PREFIX}/overview`) {
      try {
        createJsonResponse(res, 200, service.overview({
          shopId: requestUrl.searchParams.get('shopId') || '',
          status: requestUrl.searchParams.get('status') || '',
          limit: requestUrl.searchParams.get('limit') || 500,
          offset: requestUrl.searchParams.get('offset') || 0,
        }), corsHeaders);
      } catch (error) {
        createJsonResponse(res, statusCode(error), failurePayload(error), corsHeaders);
      }
      return true;
    }

    if (req.method === 'GET' && pathname === `${PREFIX}/logins`) {
      try {
        createJsonResponse(res, 200, service.loginProfiles(), corsHeaders);
      } catch (error) {
        createJsonResponse(res, statusCode(error), failurePayload(error), corsHeaders);
      }
      return true;
    }

    const commands = new Map([
      [`${PREFIX}/resolve`, (body, context) => service.resolve(body, context)],
      [`${PREFIX}/patrols`, (body, context) => service.startPatrol(body, context)],
      [`${PREFIX}/capture`, (body, context) => service.recordCapture(body, context)],
      [`${PREFIX}/capture/retry`, (body, context) => service.retryCapture(body, context)],
      [`${PREFIX}/prepare`, (body, context) => service.prepare(body, context)],
      [`${PREFIX}/prepare-quick`, (body, context) => service.prepareQuick(body, context)],
      [`${PREFIX}/evidence/finalize`, (body, context) => service.finalizeEvidence(body, context)],
      [`${PREFIX}/confirm`, (body, context) => service.confirm(body, context)],
      [`${PREFIX}/submission-result`, (body, context) => service.recordSubmission(body, context)],
      [`${PREFIX}/verify/prepare`, (body, context) => service.prepareVerification(body, context)],
      [`${PREFIX}/verify`, (body, context) => service.verify(body, context)],
      [`${PREFIX}/logins/select`, (body, context) => service.selectLoginProfile(body, context)],
    ]);
    const execute = req.method === 'POST' ? commands.get(pathname) : null;
    if (!execute) {
      createJsonResponse(res, 404, {
        ok: false,
        error: { code: 'FOLLOW_SELLER_ROUTE_NOT_FOUND', message: '剔除跟卖接口不存在。' },
      }, corsHeaders);
      return true;
    }

    readRequestBody(req, { maxBytes: 4 * 1024 * 1024 })
      .then(async (body) => {
        try {
          const context = await resolveRequestContext({ req, requestUrl, body: body || {} });
          createJsonResponse(res, 200, await execute(body || {}, context), corsHeaders);
        } catch (error) {
          createJsonResponse(res, statusCode(error), failurePayload(error), corsHeaders);
        }
      })
      .catch((error) => createJsonResponse(res, error?.code === 'REQUEST_BODY_TOO_LARGE' ? 413 : 400, failurePayload(error), corsHeaders));
    return true;
  }

  return { handleRequest };
}

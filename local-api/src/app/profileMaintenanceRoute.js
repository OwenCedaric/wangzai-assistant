import {
  ProfileMaintenanceCommandError,
} from '../maintenance/profileMaintenanceCommandService.js';
import { createJsonResponse, readJsonRequestBody } from '../utils/http.js';

const ROUTE_PREFIX = '/api/app/profile-maintenance';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const TICKET_REQUEST_FIELDS = new Set(['domain', 'humanConfirmationToken']);
const TICKET_SOURCE_FIELDS = new Set([
  'adapterContext',
  'candidate',
  'evidence',
  'proof',
  'replacementRows',
  'rows',
  'rowsSha256',
  'sourceProof',
  'trustedSourceProof',
]);

function normalizeTicketRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProfileMaintenanceCommandError(
      'PROFILE_MAINTENANCE_TICKET_REQUEST_INVALID',
      'prepare-ticket 请求必须是对象。',
      { status: 400 },
    );
  }
  const unknownFields = Object.keys(body).filter((field) => !TICKET_REQUEST_FIELDS.has(field));
  const sourceFields = unknownFields.filter((field) => TICKET_SOURCE_FIELDS.has(field));
  if (sourceFields.length) {
    throw new ProfileMaintenanceCommandError(
      'PROFILE_MAINTENANCE_CALLER_SUPPLIED_PROOF_FORBIDDEN',
      `prepare-ticket 不接收调用者候选或证明字段：${sourceFields.join(', ')}。`,
      { status: 400 },
    );
  }
  if (unknownFields.length) {
    throw new ProfileMaintenanceCommandError(
      'PROFILE_MAINTENANCE_TICKET_REQUEST_FIELDS_FORBIDDEN',
      `prepare-ticket 只接收 domain 和 humanConfirmationToken；禁止字段：${unknownFields.join(', ')}。`,
      { status: 400 },
    );
  }
  return {
    domain: body.domain,
    humanConfirmationToken: body.humanConfirmationToken,
  };
}

function sendError(res, error, corsHeaders, { malformedBody = false } = {}) {
  const controlled = error instanceof ProfileMaintenanceCommandError;
  const status = controlled
    ? error.status
    : malformedBody ? 400 : 500;
  createJsonResponse(res, status, {
    ok: false,
    completed: false,
    error: {
      code: controlled
        ? error.code
        : malformedBody
          ? 'PROFILE_MAINTENANCE_REQUEST_INVALID'
          : 'PROFILE_MAINTENANCE_REQUEST_FAILED',
      message: controlled
        ? error.message
        : malformedBody
          ? '维护请求 JSON 无效。'
          : '维护命令执行失败。',
      rollbackVerified: error?.rollbackVerified === true,
    },
  }, corsHeaders);
}

export function createProfileMaintenanceRoute({ service } = {}) {
  if (
    !service?.listContracts
    || !service?.preview
    || !service?.issueTrustedRebuildTicket
    || !service?.confirm
  ) {
    throw new Error('PROFILE_MAINTENANCE_ROUTE_SERVICE_REQUIRED');
  }

  return function handleProfileMaintenanceRoute({ req, res, requestUrl, corsHeaders }) {
    const { pathname } = requestUrl;
    if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) return false;

    if (req.method === 'GET' && pathname === `${ROUTE_PREFIX}/contracts`) {
      try {
        createJsonResponse(res, 200, service.listContracts(), corsHeaders);
      } catch (error) {
        sendError(res, error, corsHeaders);
      }
      return true;
    }

    if (req.method === 'POST' && pathname === `${ROUTE_PREFIX}/preview`) {
      readJsonRequestBody(req, { maxBytes: MAX_REQUEST_BYTES }).then(
        (body) => createJsonResponse(res, 200, service.preview(body), corsHeaders),
        (error) => sendError(res, error, corsHeaders, { malformedBody: true }),
      ).catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'POST' && pathname === `${ROUTE_PREFIX}/prepare-ticket`) {
      readJsonRequestBody(req, { maxBytes: MAX_REQUEST_BYTES }).then(
        (body) => createJsonResponse(
          res,
          200,
          service.issueTrustedRebuildTicket(normalizeTicketRequest(body)),
          corsHeaders,
        ),
        (error) => sendError(res, error, corsHeaders, { malformedBody: true }),
      ).catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    if (req.method === 'POST' && pathname === `${ROUTE_PREFIX}/confirm`) {
      readJsonRequestBody(req, { maxBytes: MAX_REQUEST_BYTES }).then(
        (body) => createJsonResponse(res, 200, service.confirm(body), corsHeaders),
        (error) => sendError(res, error, corsHeaders, { malformedBody: true }),
      ).catch((error) => sendError(res, error, corsHeaders));
      return true;
    }

    createJsonResponse(res, 404, {
      ok: false,
      completed: false,
      error: {
        code: 'PROFILE_MAINTENANCE_ROUTE_NOT_FOUND',
        message: '维护路由不存在。',
        rollbackVerified: false,
      },
    }, corsHeaders);
    return true;
  };
}

export const profileMaintenanceRouteContract = Object.freeze({
  confirmPath: `${ROUTE_PREFIX}/confirm`,
  contractsPath: `${ROUTE_PREFIX}/contracts`,
  maxRequestBytes: MAX_REQUEST_BYTES,
  prepareTicketPath: `${ROUTE_PREFIX}/prepare-ticket`,
  prefix: ROUTE_PREFIX,
  previewPath: `${ROUTE_PREFIX}/preview`,
});

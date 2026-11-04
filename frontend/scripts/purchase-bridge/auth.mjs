import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  BRIDGE_AUTH_TOKEN,
  LICENSE_STATE_PATH,
  MAX_BODY_SIZE,
  PURCHASE_EXTENSION_ORIGINS,
} from './config.mjs';

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(res.wangzaiCorsOrigin ? { 'Access-Control-Allow-Origin': res.wangzaiCorsOrigin } : {}),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Wangzai-Purchase-Token',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function allowedCorsOrigin(value = '') {
  const origin = String(value || '');
  if (PURCHASE_EXTENSION_ORIGINS.has(origin)) return origin;
  if (origin === 'app://wangzai') return origin;
  if (/^http:\/\/(?:127\.0\.0\.1|localhost):(?:5173|5188|5191)$/u.test(origin)) return origin;
  return '';
}

function constantTimeTokenMatches(value = '') {
  if (!BRIDGE_AUTH_TOKEN || !value) return false;
  const expected = createHash('sha256').update(BRIDGE_AUTH_TOKEN).digest();
  const actual = createHash('sha256').update(String(value)).digest();
  return expected.equals(actual);
}

function currentLicenseState() {
  if (!LICENSE_STATE_PATH) return { mode: 'observe', authorized: true, permissions: ['purchase.manage'] };
  try {
    const state = JSON.parse(fs.readFileSync(LICENSE_STATE_PATH, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

export function bridgeRequestIsAuthorized(req) {
  if (!LICENSE_STATE_PATH && !BRIDGE_AUTH_TOKEN) return true;
  const state = currentLicenseState();
  if (!['off', 'observe'].includes(state.mode)) {
    const deadline = Math.min(
      ...[state.offline_until, state.expire].map((value) => Date.parse(value)).filter(Number.isFinite),
    );
    if (
      !state.authorized ||
      !Array.isArray(state.permissions) ||
      !state.permissions.includes('purchase.manage') ||
      !Number.isFinite(deadline) ||
      deadline <= Date.now()
    ) {
      return false;
    }
  }
  if (constantTimeTokenMatches(req.headers['x-wangzai-purchase-token'])) return true;
  return PURCHASE_EXTENSION_ORIGINS.has(String(req.headers.origin || ''));
}

export function authorizationRequired() {
  return Boolean(LICENSE_STATE_PATH || BRIDGE_AUTH_TOKEN);
}

export function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error('请求内容过大。'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('请求内容格式不正确。'));
      }
    });
    req.on('error', reject);
  });
}

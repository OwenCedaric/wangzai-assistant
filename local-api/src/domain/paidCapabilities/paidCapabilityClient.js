import { randomBytes, randomUUID, verify } from 'node:crypto';

import { canonicalJson, constantTimeTextEqual, sha256Canonical } from '../protectedCompute/canonicalJson.js';
import { ProtectedComputeError } from '../protectedCompute/protectedComputeError.js';
import { assertNoProtectedComputeSecrets } from '../protectedCompute/secretGuard.js';
import { PAID_CAPABILITY_IDS, validatePaidCapabilityIdempotencyKey } from './paidCapabilityPolicy.js';

const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;
const CAPABILITIES = new Set(PAID_CAPABILITY_IDS);
const QUOTE_FIELDS = Object.freeze([
  'capability', 'contract', 'estimatedPoints', 'expiresAt', 'inputHash', 'issuedAt',
  'keyId', 'maximumPoints', 'nonce', 'quoteId', 'requestId', 'signature',
  'signatureAlgorithm', 'version',
]);
const RESULT_FIELDS = Object.freeze([
  'capability', 'chargedPoints', 'completedAt', 'contract', 'inputHash', 'jobId',
  'keyId', 'nonce', 'offlinePolicy', 'requestId', 'result', 'signature',
  'signatureAlgorithm', 'status', 'version',
]);

const REMOTE_ERROR_MESSAGES = Object.freeze({
  POINTS_INSUFFICIENT: '积分不足，请先充值积分。',
  POINT_BALANCE_INSUFFICIENT: '积分不足，请先充值积分。',
  PAID_CAPABILITY_AUTH_REQUIRED: '登录授权已失效，请重新登录。',
  PAID_CAPABILITY_FORBIDDEN: '当前账号无权使用该付费能力。',
  PAID_CAPABILITY_INPUT_LIMIT_EXCEEDED: '本次提交内容超过服务限制，请减少单次处理数量后重试。',
  PAID_CAPABILITY_PROVIDER_NOT_CONFIGURED: '内置模型暂不可用，请联系管理员检查模型预设。',
  PAID_CAPABILITY_PROVIDER_REJECTED: '图片模型拒绝了本次请求，请更换参考图后重试。',
  PAID_CAPABILITY_PROVIDER_UNAVAILABLE: '图片模型暂时不可用，请稍后重试。',
  PAID_CAPABILITY_RATE_UNAVAILABLE: '积分计费配置暂不可用，请稍后重试。',
  PAID_CAPABILITY_SOURCE_IMAGE_REJECTED: '生图源图片无法被网关读取，请刷新图片后重试。',
  PAID_CAPABILITY_SOURCE_IMAGE_UNAVAILABLE: '生图源图片暂时无法读取，请稍后重试。',
});

function remoteErrorMessage(code) {
  return REMOTE_ERROR_MESSAGES[code] || '付费能力服务拒绝了本次请求，请稍后重试。';
}

function fail(code, message, status = 502, cause) {
  throw new ProtectedComputeError(code, message, {
    status,
    cause,
    retriable: [502, 503, 504].includes(status),
  });
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PAID_CAPABILITY_RESPONSE_INVALID', `${label} is invalid.`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    fail('PAID_CAPABILITY_RESPONSE_INVALID', `${label} fields are invalid.`);
  }
}

function endpoint(baseUrl, path) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail('PAID_CAPABILITY_BASE_URL_INVALID', 'Paid capability server URL is unsafe.', 503);
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`;
  return url.toString();
}

function accessToken(value) {
  const token = String(value || '').trim();
  if (!token || token.length > 8_192 || /[\r\n]/u.test(token)) {
    fail('PAID_CAPABILITY_AUTH_UNAVAILABLE', 'A license access token is required.', 401);
  }
  return token;
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function availableWalletPoints(payload) {
  const balance = nonnegativeInteger(payload?.balance_points ?? payload?.balancePoints);
  const reserved = nonnegativeInteger(payload?.reserved_points ?? payload?.reservedPoints) ?? 0;
  const available = nonnegativeInteger(payload?.available_points ?? payload?.availablePoints);
  if (balance === null) {
    fail('POINTS_WALLET_INVALID', '积分账户返回的数据无效，暂时不能使用旺崽内置能力。', 502);
  }
  return available ?? Math.max(0, balance - reserved);
}

function iso(now) {
  const value = new Date(now()).toISOString();
  if (!value.endsWith('Z')) fail('PAID_CAPABILITY_CLOCK_INVALID', 'Local clock is invalid.', 503);
  return value;
}

function nonce() {
  return randomBytes(32).toString('base64url');
}

async function responseJson(response) {
  const announced = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
    fail('PAID_CAPABILITY_RESPONSE_TOO_LARGE', 'Paid capability response is too large.');
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    fail('PAID_CAPABILITY_RESPONSE_TOO_LARGE', 'Paid capability response is too large.');
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch (cause) {
    fail('PAID_CAPABILITY_RESPONSE_INVALID', 'Paid capability response is invalid.', 502, cause);
  }
  if (!response.ok) {
    const code = typeof body?.detail?.code === 'string'
      ? body.detail.code
      : 'PAID_CAPABILITY_REMOTE_ERROR';
    fail(code, remoteErrorMessage(code), response.status);
  }
  return body;
}

function verifySignature(envelope, trustStore) {
  const publicKey = trustStore?.getPublicKey?.(envelope.keyId);
  if (!publicKey) fail('PAID_CAPABILITY_SIGNING_KEY_UNTRUSTED', 'Signing key is untrusted.');
  const { signature, ...signed } = envelope;
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(canonicalJson(signed)),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) fail('PAID_CAPABILITY_SIGNATURE_INVALID', 'Response signature is invalid.');
}

function verifyQuote(envelope, expected, trustStore, now) {
  exactFields(envelope, QUOTE_FIELDS, 'Paid capability quote');
  if (
    envelope.contract !== 'paid-capability-quote/v1'
    || envelope.signatureAlgorithm !== 'Ed25519'
    || envelope.capability !== expected.capability
    || envelope.version !== expected.version
    || envelope.requestId !== expected.requestId
    || !constantTimeTextEqual(envelope.nonce, expected.nonce)
    || !/^sha256:[0-9a-f]{64}$/u.test(envelope.inputHash || '')
    || !Number.isSafeInteger(envelope.estimatedPoints)
    || !Number.isSafeInteger(envelope.maximumPoints)
    || envelope.estimatedPoints < 0
    || envelope.maximumPoints < envelope.estimatedPoints
    || envelope.maximumPoints < 1
    || new Date(envelope.expiresAt).getTime() <= new Date(now()).getTime()
  ) {
    fail('PAID_CAPABILITY_QUOTE_INVALID', 'Paid capability quote is invalid.');
  }
  verifySignature(envelope, trustStore);
  return envelope;
}

function verifyResult(envelope, expected, trustStore) {
  exactFields(envelope, RESULT_FIELDS, 'Paid capability result');
  exactFields(envelope.offlinePolicy, ['allowed', 'maxUses', 'scope'], 'Offline policy');
  if (
    envelope.contract !== 'paid-capability-result/v1'
    || envelope.signatureAlgorithm !== 'Ed25519'
    || envelope.capability !== expected.capability
    || envelope.version !== expected.version
    || envelope.requestId !== expected.requestId
    || !constantTimeTextEqual(envelope.nonce, expected.nonce)
    || !constantTimeTextEqual(envelope.inputHash, expected.inputHash)
    || envelope.status !== 'completed'
    || !Number.isSafeInteger(envelope.chargedPoints)
    || envelope.chargedPoints < 0
    || envelope.offlinePolicy.allowed !== false
    || envelope.offlinePolicy.maxUses !== 0
    || envelope.offlinePolicy.scope !== 'none'
  ) {
    fail('PAID_CAPABILITY_RESULT_INVALID', 'Paid capability result is invalid.');
  }
  verifySignature(envelope, trustStore);
  return Object.freeze({
    chargedPoints: envelope.chargedPoints,
    envelope,
    result: envelope.result,
    signatureVerified: true,
    source: 'paid-cloud',
  });
}

function normalizeInput(capability, input) {
  assertNoProtectedComputeSecrets(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('PAID_CAPABILITY_INPUT_INVALID', 'Paid capability input is invalid.', 422);
  }
  const normalized = structuredClone(input);
  if (capability.startsWith('text.')) {
    normalized.systemPrompt = String(input.systemPrompt || '').trim();
    normalized.userPrompt = String(input.userPrompt || '').trim();
    if (capability === 'text.image-plan') {
      normalized.referenceImageUrls = [...(input.referenceImageUrls || [])];
    }
  }
  return normalized;
}

export function createPaidCapabilityClient({
  baseUrl,
  trustStore,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 300_000,
} = {}) {
  const quoteUrl = endpoint(baseUrl, '/api/paid-capabilities/quote');
  const jobsUrl = endpoint(baseUrl, '/api/paid-capabilities/jobs');
  const walletUrl = endpoint(baseUrl, '/api/points/wallet');
  async function post(url, body, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await responseJson(await fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken(token)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      }));
    } catch (cause) {
      if (cause instanceof ProtectedComputeError) throw cause;
      fail(
        cause?.name === 'AbortError'
          ? 'PAID_CAPABILITY_TIMEOUT'
          : 'PAID_CAPABILITY_NETWORK_UNAVAILABLE',
        'Paid capability server is unavailable.',
        cause?.name === 'AbortError' ? 504 : 503,
        cause,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  async function get(url, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await responseJson(await fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken(token)}`,
        },
        redirect: 'error',
        signal: controller.signal,
      }));
    } catch (cause) {
      if (cause instanceof ProtectedComputeError) throw cause;
      fail(
        cause?.name === 'AbortError' ? 'POINTS_CHECK_TIMEOUT' : 'POINTS_CHECK_UNAVAILABLE',
        '无法核验当前账户积分，暂时不能使用旺崽内置能力。',
        cause?.name === 'AbortError' ? 504 : 503,
        cause,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  return Object.freeze({
    async execute({ capability, version = 1, input, idempotencyKey }, { accessToken: token } = {}) {
      if (!CAPABILITIES.has(capability) || version !== 1) {
        fail('PAID_CAPABILITY_UNSUPPORTED', 'Paid capability/version is unsupported.', 422);
      }
      validatePaidCapabilityIdempotencyKey(idempotencyKey);
      const normalizedInput = normalizeInput(capability, input);
      // Text/image contracts intentionally use the same integer-only canonical
      // hash as the signed server. Seerfar hashes are supplied by the signed
      // quote because their read filters can contain decimal numbers.
      if (!capability.startsWith('external.seerfar.')) sha256Canonical(normalizedInput);
      const quoteRequest = {
        capability,
        contract: 'paid-capability-quote-request/v1',
        input: normalizedInput,
        issuedAt: iso(now),
        nonce: nonce(),
        requestId: randomUUID(),
        version,
      };
      const quote = verifyQuote(
        await post(quoteUrl, quoteRequest, token),
        quoteRequest,
        trustStore,
        now,
      );
      const availablePoints = availableWalletPoints(await get(walletUrl, token));
      if (availablePoints < quote.maximumPoints) {
        fail('POINT_BALANCE_INSUFFICIENT', '积分不足，请先充值积分。', 402);
      }
      const jobRequest = {
        contract: 'paid-capability-job-request/v1',
        idempotencyKey,
        input: normalizedInput,
        inputHash: quote.inputHash,
        issuedAt: iso(now),
        nonce: nonce(),
        quoteId: quote.quoteId,
        requestId: randomUUID(),
      };
      return verifyResult(
        await post(jobsUrl, jobRequest, token),
        { ...jobRequest, capability, version },
        trustStore,
      );
    },
  });
}
